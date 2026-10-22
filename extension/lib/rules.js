// Closing rules. Pure functions: no Chrome APIs, so they're easy to test.
//
// `entries` maps tab id -> tracked state ({ lastVisitedAt, loggedOutSince,
// mutedByUs, normalizedUrl, ... }). `ctx` is { now, activeWindowId,
// visitedTabId, settings }.

import { isWebUrl, normalizeUrl } from './url.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

export function lastVisitedAt(tab, entry, ctx) {
  if (tab.id === ctx.visitedTabId) return ctx.now;
  return entry?.lastVisitedAt ?? tab.lastAccessed ?? ctx.now;
}

export function isExempt(tab, entry, ctx) {
  return Boolean(
    tab.incognito ||
      tab.pinned ||
      (tab.audible && !entry?.mutedByUs) ||
      tab.windowId === ctx.activeWindowId,
  );
}

function thresholds(settings) {
  return {
    loggedOut: settings.loggedOutMinutes * MINUTE,
    stale: settings.staleHours * HOUR,
  };
}

// The time-based reason a non-exempt tab is due for closing, or null.
export function dueReason(tab, entry, ctx) {
  const idle = ctx.now - lastVisitedAt(tab, entry, ctx);
  const limit = thresholds(ctx.settings);
  if (entry?.loggedOutSince && tab.status !== 'loading' && idle >= limit.loggedOut) return 'logged-out';
  if (idle >= limit.stale) return 'stale';
  return null;
}

// Tabs still loading are left out until they finish (README: "run the
// duplicate check when loading completes").
// Of a group of duplicate tabs, the one to keep: a tab in the active window
// counts as most recently visited; ties go to the newest tab (highest id).
export function pickDuplicateWinner(group, entries, ctx) {
  const score = (tab) => [
    tab.windowId === ctx.activeWindowId ? 1 : 0,
    lastVisitedAt(tab, entries[tab.id], ctx),
    tab.id,
  ];
  return group.reduce((best, tab) => {
    const a = score(tab);
    const b = score(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? tab : best;
    }
    return best;
  });
}

export function groupDuplicates(tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    if (tab.incognito || tab.status === 'loading' || !isWebUrl(tab.url)) continue;
    const key = normalizeUrl(tab.url);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Auto-closing only applies while more than `tabLimit` tabs are open
// (README Rule 0). `tabs` are the profile's non-incognito tabs.
export function overTabLimit(tabs, settings) {
  return tabs.length > settings.tabLimit;
}

// Returns [{ tab, reason }] for every tab that should be closed now.
// Time-based rules run first; duplicates are then resolved among the tabs
// that remain, so a copy is never closed as a duplicate of a tab that is
// itself being closed.
export function decide(tabs, entries, ctx) {
  if (!overTabLimit(tabs, ctx.settings)) return [];
  const closures = [];
  const closing = new Set();
  for (const tab of tabs) {
    const entry = entries[tab.id];
    if (isExempt(tab, entry, ctx)) continue;
    const reason = dueReason(tab, entry, ctx);
    if (reason) {
      closures.push({ tab, reason });
      closing.add(tab.id);
    }
  }
  const remaining = tabs.filter((t) => !closing.has(t.id));
  for (const group of groupDuplicates(remaining)) {
    const winner = pickDuplicateWinner(group, entries, ctx);
    for (const tab of group) {
      if (tab !== winner && !isExempt(tab, entries[tab.id], ctx)) {
        closures.push({ tab, reason: 'duplicate' });
      }
    }
  }
  return closures;
}

// Earliest time any non-exempt tab reaches a closing threshold, or null.
// Null at or under the tab limit: opening another tab triggers a new pass.
export function nextDeadline(tabs, entries, ctx) {
  if (!overTabLimit(tabs, ctx.settings)) return null;
  const limit = thresholds(ctx.settings);
  let next = null;
  for (const tab of tabs) {
    const entry = entries[tab.id];
    if (isExempt(tab, entry, ctx)) continue;
    const visited = lastVisitedAt(tab, entry, ctx);
    let due = visited + limit.stale;
    if (entry?.loggedOutSince) due = Math.min(due, visited + limit.loggedOut);
    if (next === null || due < next) next = due;
  }
  return next;
}
