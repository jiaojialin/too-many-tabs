// Glue between Chrome events and the pure rules. Every event funnels into
// reconcile(): refresh tracked state, handle background audio, close due tabs,
// then schedule the next sweep for the next deadline (README "Design").

import { pauseMediaInPage, resumeMediaInPage, shouldPause, shouldResume } from './audio.js';
import { recordFromTab } from './db.js';
import { decide, lastVisitedAt, nextDeadline } from './rules.js';
import { SETTINGS_KEY, mergeSettings } from './settings.js';
import { STATE_KEY, emptyState, newEntry, refreshEntry, rematchEntries } from './tabState.js';
import { hostOf, normalizeUrl } from './url.js';

export const SWEEP_ALARM = 'sweep';
export const BACKSTOP_ALARM = 'backstop';
export const BACKSTOP_MINUTES = 10;
export const MIN_ALARM_DELAY = 30 * 1000;
export const MUTE_CHECK_DELAY = 4 * 1000;
const SESSION_KEY = 'sessionStarted';
const ALL_URLS = { origins: ['<all_urls>'] };

function freshOps() {
  return { focusedWindowId: null, pause: new Set(), muteCheck: new Set() };
}

export function createController({ chrome, history, now = () => Date.now(), timers = globalThis, log = console }) {
  const pauseTimers = new Map();
  let deadlineTimer = null;
  let pending = freshOps();
  let running = null;
  let rerun = false;

  // Coalesces bursts of events: at most one reconcile runs at a time, and
  // requests arriving meanwhile trigger exactly one more pass.
  function request(op = {}) {
    if (op.focusedWindowId != null) pending.focusedWindowId = op.focusedWindowId;
    if (op.pause != null) pending.pause.add(op.pause);
    if (op.muteCheck != null) pending.muteCheck.add(op.muteCheck);
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          const ops = pending;
          pending = freshOps();
          try {
            await reconcile(ops);
          } catch (error) {
            log.error('Too Many Tabs: reconcile failed', error);
          }
        } while (rerun);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function reconcile(ops) {
    const [stored, storedState, session, allTabs] = await Promise.all([
      chrome.storage.sync.get(SETTINGS_KEY),
      chrome.storage.local.get(STATE_KEY),
      chrome.storage.session.get(SESSION_KEY),
      chrome.tabs.query({ windowType: 'normal' }),
    ]);
    const settings = mergeSettings(stored[SETTINGS_KEY]);
    const state = { ...emptyState(), ...storedState[STATE_KEY] };
    const tabs = allTabs.filter((tab) => !tab.incognito);
    const t = now();

    if (!session[SESSION_KEY]) {
      // New browser session (or extension reload): tab and window ids may
      // have changed, so re-attach stored state to the current tabs.
      state.entries = rematchEntries(state.entries, tabs, t, settings.siteRules);
      state.visitedTabId = null;
      state.activeWindowId = null;
      await chrome.storage.session.set({ [SESSION_KEY]: true });
    }
    if (ops.focusedWindowId != null) state.activeWindowId = ops.focusedWindowId;
    state.activeWindowId = await resolveActiveWindowId(state.activeWindowId, tabs);

    const visited = tabs.find((tab) => tab.active && tab.windowId === state.activeWindowId);
    const visitedTabId = visited?.id ?? null;
    if (state.visitedTabId !== visitedTabId) {
      const left = state.entries[state.visitedTabId];
      if (left) left.lastVisitedAt = t;
      state.visitedTabId = visitedTabId;
    }

    const entries = {};
    for (const tab of tabs) {
      const old = state.entries[tab.id];
      entries[tab.id] = old ? refreshEntry(old, tab, t, settings.siteRules) : newEntry(tab, t, settings.siteRules);
    }
    if (visited) entries[visited.id].lastVisitedAt = t;
    state.entries = entries;

    const ctx = { now: t, activeWindowId: state.activeWindowId, visitedTabId, settings };
    await handleAudio(tabs, state.entries, ctx, ops);

    for (const { tab, reason } of decide(tabs, state.entries, ctx)) {
      if (await closeTab(tab, reason, state.entries[tab.id], ctx)) delete state.entries[tab.id];
    }
    await chrome.storage.local.set({ [STATE_KEY]: state });

    const remaining = tabs.filter((tab) => state.entries[tab.id]);
    await schedule(nextDeadline(remaining, state.entries, ctx), t);
    await ensureBackstop();
  }

  // The last-focused normal window, even while Chrome itself is unfocused.
  async function resolveActiveWindowId(current, tabs) {
    if (current != null && tabs.some((tab) => tab.windowId === current)) return current;
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      return win && !win.incognito ? win.id : null;
    } catch {
      return null;
    }
  }

  // Writes the history record first; if the tab can't be removed, the record
  // is deleted again so history only lists tabs that were really closed.
  async function closeTab(tab, reason, entry, ctx) {
    const record = recordFromTab(tab, {
      reason,
      closedAt: ctx.now,
      lastVisitedAt: lastVisitedAt(tab, entry, ctx),
      normalizedUrl: entry?.normalizedUrl ?? normalizeUrl(tab.url ?? ''),
      domain: hostOf(tab.url ?? ''),
    });
    let id;
    try {
      id = await history.add(record);
    } catch (error) {
      log.error('Too Many Tabs: could not record closed tab; leaving it open', error);
      return false;
    }
    try {
      await chrome.tabs.remove(tab.id);
      return true;
    } catch (error) {
      log.warn('Too Many Tabs: could not close tab', tab.id, error);
      await history.delete(id).catch(() => {});
      return false;
    }
  }

  async function handleAudio(tabs, entries, ctx, ops) {
    const present = new Set(tabs.map((tab) => tab.id));
    for (const id of pauseTimers.keys()) if (!present.has(id)) cancelPause(id);

    for (const tab of tabs) {
      const entry = entries[tab.id];
      if (shouldResume(tab, entry, ctx)) {
        cancelPause(tab.id);
        await resume(tab, entry);
        continue;
      }
      if (ops.muteCheck.has(tab.id)) await muteIfStillAudible(tab, entry, ctx);
      if (!shouldPause(tab, entry, ctx)) {
        cancelPause(tab.id);
      } else if (ops.pause.has(tab.id)) {
        cancelPause(tab.id);
        await pause(tab, entry);
      } else if (!pauseTimers.has(tab.id)) {
        const delay = ctx.settings.audioPauseDelaySeconds * 1000;
        pauseTimers.set(
          tab.id,
          timers.setTimeout(() => {
            pauseTimers.delete(tab.id);
            return request({ pause: tab.id });
          }, delay),
        );
      }
    }
  }

  function cancelPause(tabId) {
    if (!pauseTimers.has(tabId)) return;
    timers.clearTimeout(pauseTimers.get(tabId));
    pauseTimers.delete(tabId);
  }

  async function hasHostAccess() {
    try {
      return await chrome.permissions.contains(ALL_URLS);
    } catch {
      return false;
    }
  }

  async function runInTab(tabId, func) {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func });
    return results.reduce((sum, r) => sum + (typeof r?.result === 'number' ? r.result : 0), 0);
  }

  async function pause(tab, entry) {
    let paused = 0;
    if (await hasHostAccess()) {
      try {
        paused = await runInTab(tab.id, pauseMediaInPage);
      } catch (error) {
        log.warn('Too Many Tabs: could not pause media; muting instead', error);
      }
    }
    if (paused > 0) {
      entry.pausedByUs = true;
      timers.setTimeout(() => request({ muteCheck: tab.id }), MUTE_CHECK_DELAY);
    } else {
      await mute(tab, entry);
    }
  }

  async function muteIfStillAudible(tab, entry, ctx) {
    if (entry?.pausedByUs && !entry.mutedByUs && tab.audible && !tab.mutedInfo?.muted && tab.id !== ctx.visitedTabId) {
      await mute(tab, entry);
    }
  }

  async function mute(tab, entry) {
    try {
      await chrome.tabs.update(tab.id, { muted: true });
      entry.mutedByUs = true;
    } catch (error) {
      log.warn('Too Many Tabs: could not mute tab', tab.id, error);
    }
  }

  async function resume(tab, entry) {
    if (entry.pausedByUs && (await hasHostAccess())) {
      await runInTab(tab.id, resumeMediaInPage).catch(() => {});
    }
    const muted = tab.mutedInfo;
    if (entry.mutedByUs && muted?.muted && muted.reason === 'extension' && muted.extensionId === chrome.runtime.id) {
      await chrome.tabs.update(tab.id, { muted: false }).catch(() => {});
    }
    entry.pausedByUs = false;
    entry.mutedByUs = false;
  }

  async function schedule(due, t) {
    if (deadlineTimer) {
      timers.clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (due === null) {
      await chrome.alarms.clear(SWEEP_ALARM);
      return;
    }
    // Anything already due was just handled; if it's still here (e.g. the
    // close failed), retry at the next alarm rather than spinning.
    const delay = due > t ? due - t : MIN_ALARM_DELAY;
    await chrome.alarms.create(SWEEP_ALARM, { when: t + Math.max(delay, MIN_ALARM_DELAY) });
    if (delay < MIN_ALARM_DELAY) deadlineTimer = timers.setTimeout(() => request(), delay);
  }

  async function ensureBackstop() {
    if (!(await chrome.alarms.get(BACKSTOP_ALARM))) {
      await chrome.alarms.create(BACKSTOP_ALARM, { periodInMinutes: BACKSTOP_MINUTES });
    }
  }

  async function onFocusChanged(windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    try {
      const win = await chrome.windows.get(windowId);
      if (win.type === 'normal' && !win.incognito) return request({ focusedWindowId: windowId });
    } catch {
      // Window already gone.
    }
    return request();
  }

  const RELEVANT_CHANGES = ['url', 'title', 'audible', 'pinned', 'mutedInfo'];
  function onTabUpdated(tabId, changeInfo) {
    if (changeInfo.status === 'complete' || RELEVANT_CHANGES.some((key) => key in changeInfo)) {
      return request();
    }
    return undefined;
  }

  return { request, onFocusChanged, onTabUpdated };
}
