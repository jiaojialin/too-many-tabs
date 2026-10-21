// Per-tab tracked state, persisted in chrome.storage.local.

import { nextLogoutState } from './logout.js';
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
    loginLike: nextLogoutState(undefined, tab, now, siteRules).loginLike,
    loggedOutSince: null,
    pausedByUs: false,
    mutedByUs: false,
  };
}

// Brings an entry up to date with the tab's current URL/title/position,
// running logged-out detection when the URL or title changed.
export function refreshEntry(entry, tab, now, siteRules = []) {
  const url = tab.url ?? '';
  const title = tab.title ?? '';
  const next = { ...entry, windowId: tab.windowId, index: tab.index };
  if (url !== entry.url || title !== entry.title) {
    Object.assign(next, nextLogoutState(entry, { url, title }, now, siteRules), {
      url,
      title,
      normalizedUrl: normalizeUrl(url),
    });
  }
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
    result[tab.id] = { ...entry, windowId: tab.windowId, index: tab.index };
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
