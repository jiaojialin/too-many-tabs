// Per-tab tracked state, persisted in chrome.storage.local.

import { isSignedOutPage, nextLogoutState } from './logout.js';
import { normalizeUrl } from './url.js';

export const STATE_KEY = 'tabState';

export function emptyState() {
  return { entries: {}, visitedTabId: null, activeWindowId: null };
}

export function newEntry(tab, now, siteRules = []) {
  return {
    url: tab.url ?? '',
    title: tab.title ?? '',
    normalizedUrl: normalizeUrl(tab.url ?? ''),
    windowId: tab.windowId,
    index: tab.index,
    lastVisitedAt: now,
    // When the tab was opened (or first seen) and last switched to; the
    // freshest copy of a duplicate group survives.
    openedAt: now,
    enteredAt: null,
    loginLike: nextLogoutState(undefined, tab, now, siteRules).loginLike,
    // A tab already sitting on a sign-out page when first seen (e.g. open
    // before the extension was installed) has no transition to detect.
    loggedOutSince: tab.status !== 'loading' && isSignedOutPage(tab) ? now : null,
    // A tab first seen mid-load has no reliable baseline yet (its title may
    // not have arrived), so the first completed page can't count as a logout.
    settled: tab.status !== 'loading',
    audible: Boolean(tab.audible),
    pausedByUs: false,
    mutedByUs: false,
  };
}

// Brings an entry up to date with the tab's current URL/title/position,
// running logged-out detection when the URL or title changed. While a tab is
// loading, URL/title changes are held back until the page settles, so
// intermediate redirects and half-loaded titles don't count as transitions.
export function refreshEntry(entry, tab, now, siteRules = []) {
  const url = tab.url ?? '';
  const title = tab.title ?? '';
  // Entries stored before `openedAt` existed get it backfilled once.
  const next = {
    ...entry,
    openedAt: entry.openedAt ?? entry.lastVisitedAt ?? now,
    enteredAt: entry.enteredAt ?? null,
    windowId: tab.windowId,
    index: tab.index,
  };
  if (tab.status === 'loading') return next;
  if (url !== entry.url || title !== entry.title || entry.settled === false) {
    const prev = entry.settled === false ? undefined : entry;
    Object.assign(next, nextLogoutState(prev, { url, title }, now, siteRules), {
      url,
      title,
      normalizedUrl: normalizeUrl(url),
      settled: true,
    });
    // A new document has none of the media we paused.
    if (url !== entry.url) next.pausedByUs = false;
    // Navigating to another page counts as opening that page now.
    if (next.normalizedUrl !== entry.normalizedUrl) next.openedAt = now;
  }
  return next;
}

// Keeps the paused/muted-by-us flags honest: the user may unmute a tab, and a
// page we paused may start playing again on its own (then it gets paused
// again after the usual delay).
export function syncAudioFlags(entry, tab, extensionId) {
  const next = { ...entry, audible: Boolean(tab.audible) };
  const muted = tab.mutedInfo;
  const mutedByExtension = Boolean(muted?.muted && muted.reason === 'extension' && muted.extensionId === extensionId);
  if (next.mutedByUs && !mutedByExtension) next.mutedByUs = false;
  if (next.pausedByUs && !next.mutedByUs && tab.audible && entry.audible === false) next.pausedByUs = false;
  return next;
}

// After a browser restart tab ids change. Re-attach stored entries to the
// current tabs: same id + URL first, then URL + position, then URL alone.
// Tabs with no match start fresh with `now` as their last-visited time.
export function rematchEntries(storedEntries, tabs, now, siteRules = []) {
  const unused = new Map(Object.entries(storedEntries));
  const result = {};
  const take = (key, tab) => {
    const entry = unused.get(key);
    unused.delete(key);
    // Injected pause markers don't survive a restart or reload.
    result[tab.id] = { ...entry, windowId: tab.windowId, index: tab.index, pausedByUs: false };
  };
  const pending = [];
  for (const tab of tabs) {
    const key = String(tab.id);
    if (unused.get(key)?.url === tab.url) take(key, tab);
    else pending.push(tab);
  }
  const passes = [
    (entry, tab) => entry.url === tab.url && entry.index === tab.index,
    (entry, tab) => entry.url === tab.url,
  ];
  let rest = pending;
  for (const matches of passes) {
    const next = [];
    for (const tab of rest) {
      const found = [...unused].find(([, entry]) => matches(entry, tab));
      if (found) take(found[0], tab);
      else next.push(tab);
    }
    rest = next;
  }
  for (const tab of rest) result[tab.id] = newEntry(tab, now, siteRules);
  return result;
}
