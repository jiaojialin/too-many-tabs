import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, MINUTE, decide, keptTabIds, isLandingCandidate, isExempt, lastVisitedAt, nextDeadline, pickDuplicateWinner } from '../extension/lib/rules.js';
import { DEFAULT_SETTINGS } from '../extension/lib/settings.js';

const NOW = 1_000_000_000_000;
const ACTIVE_WINDOW = 1;
const OTHER_WINDOW = 2;
const VISITED = 1;
const SETTINGS = DEFAULT_SETTINGS;
const ctx = (overrides = {}) => ({ now: NOW, visitedTabId: null, settings: SETTINGS, ...overrides });
const tab = (id, props = {}) => ({ id, windowId: OTHER_WINDOW, url: `https://site${id}.test/`, ...props });
const visitedAgo = (ms, extra = {}) => ({ lastVisitedAt: NOW - ms, loggedOutSince: null, ...extra });

test('isExempt: pinned, audible, visited and incognito tabs', () => {
  assert.ok(isExempt(tab(1, { pinned: true }), {}, ctx()));
  assert.ok(isExempt(tab(1, { audible: true }), {}, ctx()));
  assert.ok(isExempt(tab(VISITED), {}, ctx({ visitedTabId: VISITED })));
  assert.ok(isExempt(tab(1, { incognito: true }), {}, ctx()));
  assert.ok(!isExempt(tab(1), {}, ctx()));
});

test('isExempt: other tabs in the active window are not protected', () => {
  const c = ctx({ visitedTabId: VISITED });
  assert.ok(!isExempt(tab(2, { windowId: ACTIVE_WINDOW }), {}, c));
  assert.ok(!isExempt(tab(3, { windowId: OTHER_WINDOW, active: true }), {}, c), 'front tab of another window');
});

test('isExempt: a tab muted by the extension is not protected by being audible', () => {
  assert.ok(!isExempt(tab(1, { audible: true }), { mutedByUs: true }, ctx()));
});

test('lastVisitedAt: the visited tab is being visited now; falls back to lastAccessed', () => {
  assert.equal(lastVisitedAt(tab(1), visitedAgo(HOUR), ctx({ visitedTabId: 1 })), NOW);
  assert.equal(lastVisitedAt(tab(1, { lastAccessed: 5 }), undefined, ctx()), 5);
  assert.equal(lastVisitedAt(tab(1), undefined, ctx()), NOW);
});

test('decide closes logged-out tabs 30 minutes after the last visit', () => {
  const tabs = [tab(1), tab(2)];
  const entries = {
    1: visitedAgo(30 * MINUTE, { loggedOutSince: NOW - 10 * MINUTE }),
    2: visitedAgo(29 * MINUTE, { loggedOutSince: NOW - 29 * MINUTE }),
  };
  assert.deepEqual(decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]), [[1, 'logged-out']]);
});

test('decide closes a logged-out tab on a sign-out page at once, unless it is being visited', () => {
  const tabs = [tab(1, { url: 'https://bank.test/logout' }), tab(2, { url: 'https://bank.test/login', title: 'Sign in' }), tab(3, { url: 'https://bank.test/logout' })];
  const entries = { 1: visitedAgo(0, { loggedOutSince: NOW }), 2: visitedAgo(0, { loggedOutSince: NOW }), 3: visitedAgo(0, { loggedOutSince: NOW }) };
  assert.deepEqual(decide(tabs, entries, ctx({ visitedTabId: 3 })).map((c) => [c.tab.id, c.reason]), [[1, 'logged-out']]);
});

test('decide closes tabs not visited for 24 hours', () => {
  const tabs = [tab(1), tab(2)];
  const entries = { 1: visitedAgo(24 * HOUR), 2: visitedAgo(23 * HOUR) };
  assert.deepEqual(decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]), [[1, 'stale']]);
});

test('decide honours configured thresholds', () => {
  const settings = { ...SETTINGS, staleHours: 1, loggedOutMinutes: 5 };
  const entries = { 1: visitedAgo(HOUR), 2: visitedAgo(5 * MINUTE, { loggedOutSince: NOW - MINUTE }) };
  assert.deepEqual(
    decide([tab(1), tab(2)], entries, ctx({ settings })).map((c) => c.reason),
    ['stale', 'logged-out'],
  );
});

test('decide never closes exempt tabs, however old', () => {
  const old = visitedAgo(48 * HOUR, { loggedOutSince: NOW - 48 * HOUR });
  const tabs = [tab(1, { pinned: true }), tab(2, { audible: true }), tab(3, { windowId: ACTIVE_WINDOW }), tab(4, { incognito: true })];
  assert.deepEqual(decide(tabs, { 1: old, 2: old, 3: old, 4: old }, ctx({ visitedTabId: 3 })), []);
});

test('decide closes stale tabs in the active window other than the visited tab', () => {
  const tabs = [tab(1, { windowId: ACTIVE_WINDOW }), tab(2, { windowId: ACTIVE_WINDOW })];
  const old = visitedAgo(25 * HOUR);
  assert.deepEqual(decide(tabs, { 1: old, 2: old }, ctx({ visitedTabId: 1 })).map((c) => [c.tab.id, c.reason]), [[2, 'stale']]);
});

test('duplicates: keep the most recently visited copy', () => {
  const url = 'https://a.test/page';
  const tabs = [tab(1, { url }), tab(2, { url: `${url}?utm_source=x#top` }), tab(3, { url })];
  const entries = { 1: visitedAgo(3 * MINUTE), 2: visitedAgo(MINUTE), 3: visitedAgo(2 * MINUTE) };
  assert.deepEqual(
    decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]),
    [[1, 'duplicate'], [3, 'duplicate']],
  );
});

test('duplicates: the visited copy is never closed, and a fresher copy stays beside it', () => {
  const url = 'https://a.test/page';
  const tabs = [tab(1, { url, windowId: ACTIVE_WINDOW }), tab(2, { url })];
  const entries = { 1: visitedAgo(0, { openedAt: NOW - HOUR, enteredAt: NOW - HOUR }), 2: visitedAgo(MINUTE, { openedAt: NOW - MINUTE }) };
  assert.deepEqual(decide(tabs, entries, ctx({ visitedTabId: 1 })), []);
  entries[1].enteredAt = NOW - 30 * 1000;
  assert.deepEqual(decide(tabs, entries, ctx({ visitedTabId: 1 })).map((c) => c.tab.id), [2], 'switched to after 2 opened');
});

test('duplicates: the copy most recently opened or switched to wins', () => {
  const tabs = [tab(1), tab(2), tab(3)];
  const entries = {
    1: visitedAgo(0, { openedAt: NOW - 3 * HOUR, enteredAt: NOW - MINUTE }),
    2: visitedAgo(0, { openedAt: NOW - 2 * MINUTE }),
    3: visitedAgo(0, { openedAt: NOW - HOUR, enteredAt: null }),
  };
  assert.equal(pickDuplicateWinner(tabs, entries, ctx()).id, 1);
  entries[2].openedAt = NOW;
  assert.equal(pickDuplicateWinner(tabs, entries, ctx()).id, 2);
});

test('pickDuplicateWinner: without opened/entered times, uses the stored last visit, not "visited now"', () => {
  const tabs = [tab(1), tab(2)];
  const entries = { 1: visitedAgo(HOUR), 2: visitedAgo(MINUTE) };
  assert.equal(pickDuplicateWinner(tabs, entries, ctx({ visitedTabId: 1 })).id, 2);
});

test('pickDuplicateWinner: ties go to the visited tab', () => {
  const same = visitedAgo(MINUTE, { openedAt: NOW - MINUTE });
  assert.equal(pickDuplicateWinner([tab(5), tab(9)], { 5: same, 9: same }, ctx({ visitedTabId: 5 })).id, 5);
});

test('duplicates inside the active window close, keeping the most recently visited', () => {
  const url = 'https://a.test/page';
  const tabs = [tab(1, { url, windowId: ACTIVE_WINDOW }), tab(2, { url, windowId: ACTIVE_WINDOW }), tab(3, { windowId: ACTIVE_WINDOW })];
  const entries = { 1: visitedAgo(HOUR), 2: visitedAgo(MINUTE), 3: visitedAgo(0) };
  assert.deepEqual(decide(tabs, entries, ctx({ visitedTabId: 3 })).map((c) => [c.tab.id, c.reason]), [[1, 'duplicate']]);
});

test('duplicates: pinned or audible losers survive', () => {
  const url = 'https://a.test/page';
  const tabs = [tab(1, { url, pinned: true }), tab(2, { url, audible: true }), tab(3, { url })];
  const entries = { 1: visitedAgo(3 * HOUR), 2: visitedAgo(2 * HOUR), 3: visitedAgo(MINUTE) };
  assert.deepEqual(decide(tabs, entries, ctx()), []);
});

test('duplicates: different query parameters are different pages', () => {
  const tabs = [tab(1, { url: 'https://youtube.com/watch?v=a' }), tab(2, { url: 'https://youtube.com/watch?v=b' })];
  assert.deepEqual(decide(tabs, { 1: visitedAgo(HOUR), 2: visitedAgo(MINUTE) }, ctx()), []);
});

test('duplicates: non-web pages are ignored', () => {
  const tabs = [tab(1, { url: 'chrome://settings/' }), tab(2, { url: 'chrome://settings/' })];
  assert.deepEqual(decide(tabs, { 1: visitedAgo(HOUR), 2: visitedAgo(MINUTE) }, ctx()), []);
});

test('a tab closed for staleness does not also take its duplicate with it', () => {
  const url = 'https://a.test/page';
  const tabs = [tab(1, { url }), tab(2, { url })];
  const entries = { 1: visitedAgo(25 * HOUR), 2: visitedAgo(26 * HOUR) };
  const result = decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]);
  assert.deepEqual(result, [[1, 'stale'], [2, 'stale']]);
  const fresher = { 1: visitedAgo(25 * HOUR), 2: visitedAgo(HOUR) };
  assert.deepEqual(decide(tabs, fresher, ctx()).map((c) => [c.tab.id, c.reason]), [[1, 'stale']]);
});

test('pickDuplicateWinner breaks ties by newest tab id', () => {
  const tabs = [tab(5), tab(9), tab(7)];
  const same = visitedAgo(MINUTE);
  assert.equal(pickDuplicateWinner(tabs, { 5: same, 9: same, 7: same }, ctx()).id, 9);
});

test('nextDeadline returns the earliest closing time of non-exempt tabs', () => {
  const tabs = [tab(1), tab(2), tab(3, { pinned: true })];
  const entries = {
    1: visitedAgo(HOUR),
    2: visitedAgo(10 * MINUTE, { loggedOutSince: NOW - 5 * MINUTE }),
    3: visitedAgo(24 * HOUR),
  };
  assert.equal(nextDeadline(tabs, entries, ctx()), NOW + 20 * MINUTE);
});

test('nextDeadline: a logged-out tab on a sign-out page is due now', () => {
  const tabs = [tab(1, { url: 'https://bank.test/logout' })];
  assert.equal(nextDeadline(tabs, { 1: visitedAgo(0, { loggedOutSince: NOW }) }, ctx()), NOW);
});

test('nextDeadline is null when nothing can become closable', () => {
  assert.equal(nextDeadline([tab(1, { windowId: ACTIVE_WINDOW })], { 1: visitedAgo(0) }, ctx({ visitedTabId: 1 })), null);
  assert.equal(nextDeadline([], {}, ctx()), null);
});

test('there is no tab limit: a lone stale tab closes', () => {
  assert.deepEqual(decide([tab(1)], { 1: visitedAgo(48 * HOUR) }, ctx()).map((c) => c.reason), ['stale']);
});

test('Rule 4: unused landing tabs close 10 minutes after the last visit', () => {
  const tabs = [tab(1, { url: 'chrome://newtab/' }), tab(2, { url: 'https://www.google.com/' }), tab(3, { url: 'about:blank' })];
  const entries = { 1: visitedAgo(10 * MINUTE), 2: visitedAgo(11 * MINUTE), 3: visitedAgo(9 * MINUTE) };
  assert.deepEqual(decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]), [[1, 'empty'], [2, 'empty']]);
  assert.equal(nextDeadline([tabs[2]], entries, ctx()), NOW + MINUTE, 'tab 3 is due in a minute');
});

test('Rule 4: landing tabs close, but never the visited tab', () => {
  const tabs = [tab(1, { url: 'chrome://newtab/', windowId: ACTIVE_WINDOW }), tab(2, { url: 'chrome://newtab/', windowId: ACTIVE_WINDOW })];
  const entries = { 1: visitedAgo(HOUR), 2: visitedAgo(HOUR) };
  assert.deepEqual(decide(tabs, entries, ctx({ visitedTabId: 2 })).map((c) => c.tab.id), [1]);
});

test('Rule 4: pinned, audible, incognito and loading landing tabs are kept', () => {
  const url = 'chrome://newtab/';
  const tabs = [tab(1, { url, pinned: true }), tab(2, { url, audible: true }), tab(3, { url, incognito: true }), tab(4, { url, status: 'loading' })];
  const old = visitedAgo(HOUR);
  assert.deepEqual(decide(tabs, { 1: old, 2: old, 3: old, 4: old }, ctx()), []);
  assert.ok(!isLandingCandidate(tab(5, { url: 'https://www.google.com/search?q=x' }), old, ctx()), 'a search was made');
});

test('Rule 4: sign-in pages are candidates; the visited one is kept', () => {
  const url = 'https://bank.test/signin';
  const tabs = [tab(1, { url }), tab(2, { url: 'https://bank2.test/login' }), tab(3, { url: 'https://bank3.test/login', pinned: true })];
  const entries = { 1: visitedAgo(HOUR), 2: visitedAgo(HOUR, { loggedOutSince: NOW - HOUR }), 3: visitedAgo(HOUR) };
  assert.deepEqual(decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]), [[1, 'empty'], [2, 'logged-out']]);
  assert.deepEqual(decide(tabs, entries, ctx({ visitedTabId: 1 })).map((c) => c.tab.id), [2]);
});

test('Rule 5: Google search results close 60 minutes after the last visit', () => {
  const search = (id, props = {}) => tab(id, { url: `https://www.google.com/search?q=q${id}`, ...props });
  const tabs = [search(1), search(2), tab(3)];
  const entries = { 1: visitedAgo(60 * MINUTE), 2: visitedAgo(59 * MINUTE), 3: visitedAgo(2 * HOUR) };
  assert.deepEqual(decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]), [[1, 'search']]);
  assert.equal(nextDeadline([tabs[1]], entries, ctx()), NOW + MINUTE);
  assert.deepEqual(decide([search(4)], { 4: visitedAgo(2 * HOUR) }, ctx({ visitedTabId: 4 })), [], 'the visited tab stays');
  assert.deepEqual(decide([search(5, { status: 'loading' })], { 5: visitedAgo(2 * HOUR) }, ctx()), []);
});

test('Rule 5: honours a custom search idle time', () => {
  const settings = { ...SETTINGS, searchIdleMinutes: 5 };
  const tabs = [tab(1, { url: 'https://www.google.com/search?q=x' })];
  assert.deepEqual(decide(tabs, { 1: visitedAgo(5 * MINUTE) }, ctx({ settings })).map((c) => c.reason), ['search']);
});

test('Rule 6: a lone Gmail or Calendar tab is never closed, however old', () => {
  const tabs = [tab(1, { url: 'https://mail.google.com/mail/u/0/#inbox' }), tab(2, { url: 'https://calendar.google.com/calendar/r' })];
  const old = visitedAgo(72 * HOUR);
  assert.deepEqual(decide(tabs, { 1: old, 2: old }, ctx()), []);
  assert.equal(nextDeadline(tabs, { 1: old, 2: old }, ctx()), null);
});

test('Rule 6: only the most recently visited tab of the site is kept; extras follow the rules', () => {
  const tabs = [
    tab(1, { url: 'https://mail.google.com/mail/u/0/#inbox' }),
    tab(2, { url: 'https://mail.google.com/mail/u/1/#inbox' }),
    tab(3, { url: 'https://mail.google.com/mail/u/0/#inbox/abc' }),
  ];
  const entries = { 1: visitedAgo(2 * HOUR), 2: visitedAgo(25 * HOUR), 3: visitedAgo(HOUR) };
  assert.deepEqual([...keptTabIds(tabs, entries, ctx())], [3]);
  assert.deepEqual(decide(tabs, entries, ctx()).map((c) => [c.tab.id, c.reason]), [[2, 'stale'], [1, 'duplicate']]);
});

test('Rule 6: an empty list keeps nothing; patterns cover subdomains', () => {
  const tabs = [tab(1, { url: 'https://mail.google.com/mail/u/0/' })];
  const settings = { ...SETTINGS, keepOneHosts: [] };
  assert.deepEqual(decide(tabs, { 1: visitedAgo(48 * HOUR) }, ctx({ settings })).map((c) => c.reason), ['stale']);
  const covered = { ...SETTINGS, keepOneHosts: ['google.com'] };
  assert.deepEqual(decide(tabs, { 1: visitedAgo(48 * HOUR) }, ctx({ settings: covered })), []);
});

test('Rule 4: honours a custom landing list and idle time', () => {
  const settings = { ...SETTINGS, landingPages: ['nytimes.com'], landingIdleMinutes: 1 };
  const tabs = [tab(1, { url: 'https://www.nytimes.com/' }), tab(2, { url: 'chrome://newtab/' })];
  const entries = { 1: visitedAgo(MINUTE), 2: visitedAgo(MINUTE) };
  assert.deepEqual(decide(tabs, entries, ctx({ settings })).map((c) => c.tab.id), [1]);
});
