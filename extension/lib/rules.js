// Closing rules. Pure functions: no Chrome APIs, so they're easy to test.
//
// `entries` maps tab id -> tracked state ({ lastVisitedAt, loggedOutSince,
// mutedByUs, normalizedUrl, ... }). `ctx` is { now, visitedTabId, settings };
// the visited tab is the selected tab of the active window.

import { isLandingPage } from './landing.js';
import { isSignInPage, isSignedOutPage } from './logout.js';
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
      tab.id === ctx.visitedTabId,
  );
}

// Rule 4 applies to a non-exempt tab that is still on a landing page or a
// sign-in page.
export function isLandingCandidate(tab, entry, ctx) {
  return (
    tab.status !== 'loading' &&
    (isLandingPage(tab.url ?? '', ctx.settings.landingPages) || isSignInPage(tab)) &&
    !isExempt(tab, entry, ctx)
  );
}

function thresholds(settings) {
  return {
    loggedOut: settings.loggedOutMinutes * MINUTE,
    stale: settings.staleHours * HOUR,
    landing: settings.landingIdleMinutes * MINUTE,
  };
}

// The reason a non-exempt tab is due for closing, or null. A logged-out tab
// on a sign-out page closes at once; otherwise it waits `loggedOutMinutes`
// after the last visit (sign-in URLs are caught earlier by Rule 4).
export function dueReason(tab, entry, ctx) {
  const idle = ctx.now - lastVisitedAt(tab, entry, ctx);
  const limit = thresholds(ctx.settings);
  if (entry?.loggedOutSince && tab.status !== 'loading') {
    if (isSignedOutPage(tab) || idle >= limit.loggedOut) return 'logged-out';
  }
  if (idle >= limit.stale) return 'stale';
  return null;
}

// Tabs still loading are left out until they finish (README: "run the
// duplicate check when loading completes").
// When a copy was last opened or switched to. Entries stored before these
// fields existed fall back to the last-visited time.
function freshness(tab, entry, ctx) {
  const latest = Math.max(entry?.openedAt ?? 0, entry?.enteredAt ?? 0);
  return latest || lastVisitedAt(tab, entry, ctx);
}

// Of a group of duplicate tabs, the one to keep: the copy most recently opened
// or switched to, so opening a page again closes the older copies. Ties go to
// the tab being visited, then the newest tab (highest id). The tab being
// visited is exempt anyway, so if a newer copy opens in the background both
// stay until you leave it.
export function pickDuplicateWinner(group, entries, ctx) {
  const score = (tab) => [freshness(tab, entries[tab.id], ctx), tab.id === ctx.visitedTabId ? 1 : 0, tab.id];
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

// Returns [{ tab, reason }] for every tab that should be closed now.
// Time-based rules run first; duplicates are then resolved among the tabs
// that remain, so a copy is never closed as a duplicate of a tab that is
// itself being closed.
export function decide(tabs, entries, ctx) {
  const closures = [];
  const closing = new Set();
  const landingLimit = thresholds(ctx.settings).landing;
  for (const tab of tabs) {
    const entry = entries[tab.id];
    if (isLandingCandidate(tab, entry, ctx)) {
      if (ctx.now - lastVisitedAt(tab, entry, ctx) >= landingLimit) {
        closures.push({ tab, reason: entry?.loggedOutSince ? 'logged-out' : 'empty' });
        closing.add(tab.id);
        continue;
      }
    }
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
export function nextDeadline(tabs, entries, ctx) {
  const limit = thresholds(ctx.settings);
  let next = null;
  const consider = (due) => {
    if (next === null || due < next) next = due;
  };
  for (const tab of tabs) {
    const entry = entries[tab.id];
    if (isLandingCandidate(tab, entry, ctx)) consider(lastVisitedAt(tab, entry, ctx) + limit.landing);
    if (isExempt(tab, entry, ctx)) continue;
    const visited = lastVisitedAt(tab, entry, ctx);
    let due = visited + limit.stale;
    if (entry?.loggedOutSince) {
      const signedOut = tab.status !== 'loading' && isSignedOutPage(tab);
      due = Math.min(due, signedOut ? ctx.now : visited + limit.loggedOut);
    }
    consider(due);
  }
  return next;
}
