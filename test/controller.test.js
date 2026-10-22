import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKSTOP_ALARM, SWEEP_ALARM, createController } from '../extension/lib/controller.js';
import { HOUR, MINUTE } from '../extension/lib/rules.js';
import { SETTINGS_KEY } from '../extension/lib/settings.js';
import { STATE_KEY } from '../extension/lib/tabState.js';
import { createFakeChrome, createFakeHistory, createFakeTimers } from './helpers/fakeChrome.js';

const silent = { error() {}, warn() {} };

function setup(tabs, options = {}) {
  const chrome = createFakeChrome({ tabs, ...options });
  // Most tests use a handful of tabs, so the tab limit is lifted unless a test sets it.
  chrome.storage.sync.data[SETTINGS_KEY] = { tabLimit: 0 };
  const history = createFakeHistory();
  const timers = createFakeTimers();
  let now = options.now ?? 1_000_000_000_000;
  const controller = createController({ chrome, history, timers, now: () => now, log: silent });
  return {
    chrome,
    history,
    timers,
    controller,
    advance(ms) {
      now += ms;
    },
    focus(windowId) {
      chrome._state.focusedWindowId = windowId;
    },
    get now() {
      return now;
    },
    tab(id) {
      return chrome._state.tabs.find((t) => t.id === id);
    },
  };
}

// Window 1 is focused; tab 1 is the visited tab.
const baseTabs = () => [
  { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/', title: 'Work' },
  { id: 2, windowId: 2, index: 0, active: true, url: 'https://other.test/', title: 'Other' },
];

test('closes a tab once it has not been visited for 24 hours, and records it', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.advance(24 * HOUR - MINUTE);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
  env.advance(MINUTE);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
  assert.equal(env.history.records.length, 1);
  assert.equal(env.history.records[0].reason, 'stale');
  assert.equal(env.history.records[0].url, 'https://other.test/');
  assert.equal(env.history.records[0].domain, 'other.test');
});

test('schedules the sweep alarm for the next deadline and keeps a backstop', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  assert.equal(env.chrome._state.alarms.get(SWEEP_ALARM).when, env.now + 24 * HOUR);
  assert.deepEqual(env.chrome._state.alarms.get(BACKSTOP_ALARM), { periodInMinutes: 10 });
});

test('clears the sweep alarm when nothing can become closable', async () => {
  const env = setup([baseTabs()[0]]);
  await env.controller.request();
  assert.equal(env.chrome._state.alarms.has(SWEEP_ALARM), false);
});

test('a near deadline is handled with a timer as well as the alarm', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.advance(24 * HOUR - 10 * 1000);
  await env.controller.request();
  assert.equal(env.chrome._state.alarms.get(SWEEP_ALARM).when, env.now + 30 * 1000);
  assert.ok([...env.timers.pending.values()].some((t) => t.ms === 10 * 1000));
});

test('closes a logged-out tab 30 minutes after its last visit', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  Object.assign(env.tab(2), { url: 'https://other.test/login', title: 'Sign in' });
  env.advance(5 * MINUTE);
  await env.controller.request();
  env.advance(25 * MINUTE - 1);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
  assert.equal(env.chrome._state.alarms.get(SWEEP_ALARM).when, env.now + 30 * 1000, 'alarms are at least 30 s out');
  assert.ok([...env.timers.pending.values()].some((t) => t.ms === 1), 'a timer covers the gap');
  env.advance(1);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
  assert.equal(env.history.records[0].reason, 'logged-out');
});

test('visiting a tab resets its timer', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.advance(23 * HOUR);
  // Focus window 2 (visit tab 2), then go back to window 1.
  env.focus(2);
  await env.controller.onFocusChanged(2);
  env.advance(MINUTE);
  env.focus(1);
  await env.controller.onFocusChanged(1);
  env.advance(2 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
  const stored = env.chrome.storage.local.data[STATE_KEY];
  assert.equal(stored.entries[2].lastVisitedAt, env.now - 2 * HOUR);
});

test('Chrome losing focus keeps the last-focused window as the active window', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  await env.controller.onFocusChanged(-1);
  env.advance(25 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2], 'the selected tab of window 1 stays protected');
});

test('closes older duplicates and keeps the copy in the active window', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://a.test/page?utm_source=x', title: 'A' },
    { id: 2, windowId: 2, index: 0, active: true, url: 'https://a.test/page#top', title: 'A' },
  ];
  const env = setup(tabs);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
  assert.equal(env.history.records[0].reason, 'duplicate');
});

test('duplicates in the same window close, keeping the tab being visited', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: false, url: 'https://www.gnu.org/licenses/gpl-3.0.html', title: 'GPL' },
    { id: 2, windowId: 1, index: 1, active: true, url: 'https://www.gnu.org/licenses/gpl-3.0.html', title: 'GPL' },
  ];
  const env = setup(tabs);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [1]);
  assert.equal(env.history.records[0].reason, 'duplicate');
});

test('only reacts to relevant tab updates', async () => {
  const env = setup(baseTabs());
  assert.equal(env.controller.onTabUpdated(1, { favIconUrl: 'x' }), undefined);
  assert.ok(env.controller.onTabUpdated(1, { status: 'complete' }) instanceof Promise);
  assert.ok(env.controller.onTabUpdated(1, { audible: true }) instanceof Promise);
});

test('focus moving to an incognito window keeps the previous active window', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.focus(99);
  await env.controller.onFocusChanged(99);
  assert.equal(env.chrome.storage.local.data[STATE_KEY].activeWindowId, 1);
});

test('with an incognito window focused at startup, a normal window is still protected', async () => {
  const env = setup(baseTabs());
  env.focus(99);
  env.advance(0);
  await env.controller.request();
  env.advance(25 * HOUR);
  await env.controller.request();
  assert.equal(env.chrome._state.removed.length, 1, 'the selected tab of one window stays protected');
});

test('the active window is read fresh on every pass, so a focus change never lags', async () => {
  const tabs = [
    { id: 5, windowId: 1, index: 0, active: true, url: 'https://a.test/page', title: 'A' },
    { id: 2, windowId: 2, index: 0, active: true, url: 'https://b.test/', title: 'B' },
  ];
  const env = setup(tabs);
  await env.controller.request();
  // The user focuses window 2 and opens a duplicate of tab 5 there. The new
  // tab has the lower id, so it can only win by being the visited tab.
  env.focus(2);
  env.tab(2).active = false;
  env.chrome._state.tabs.push({ id: 3, windowId: 2, index: 1, active: true, url: 'https://a.test/page', pinned: false, audible: false, incognito: false });
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [5], 'the visited copy in the newly focused window wins');
});

test('onFocusChanged ignores Chrome losing focus', () => {
  const env = setup(baseTabs());
  assert.equal(env.controller.onFocusChanged(-1), undefined);
});

test('onTabReplaced carries the old tab state over to the new id', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.advance(20 * HOUR);
  await env.controller.request();
  env.tab(2).id = 22;
  await env.controller.onTabReplaced(22, 2);
  const entries = env.chrome.storage.local.data[STATE_KEY].entries;
  assert.equal(entries[2], undefined);
  assert.equal(entries[22].lastVisitedAt, env.now - 20 * HOUR);
  env.advance(4 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [22]);
});

test('a login page opened directly is not flagged when its title arrives late', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.chrome._state.tabs.push({ id: 3, windowId: 2, index: 1, active: false, url: 'https://bank.test/auth', title: '', status: 'loading', pinned: false, audible: false, incognito: false });
  await env.controller.request();
  Object.assign(env.tab(3), { title: 'Sign In' });
  await env.controller.request();
  Object.assign(env.tab(3), { status: 'complete' });
  await env.controller.request();
  assert.equal(env.chrome.storage.local.data[STATE_KEY].entries[3].loggedOutSince, null);
});

test('redirects while loading are not logout transitions, and loading tabs are not closed', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  const tab = env.tab(2);
  Object.assign(tab, { url: 'https://other.test/login?prompt=none', status: 'loading' });
  await env.controller.request();
  Object.assign(tab, { url: 'https://other.test/', status: 'complete' });
  await env.controller.request();
  assert.equal(env.chrome.storage.local.data[STATE_KEY].entries[2].loggedOutSince, null);
});

test('a real logout to a sign-out page closes the tab once it has loaded', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  Object.assign(env.tab(2), { url: 'https://other.test/session-expired', status: 'loading' });
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [], 'still loading');
  Object.assign(env.tab(2), { status: 'complete', title: 'Session expired' });
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
  assert.equal(env.history.records[0].reason, 'logged-out');
});

test('a logout from a sign-in page waits 30 minutes after the last visit', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  Object.assign(env.tab(2), { url: 'https://other.test/login', title: 'Sign in' });
  await env.controller.request();
  assert.equal(env.chrome.storage.local.data[STATE_KEY].entries[2].loggedOutSince, env.now);
  env.advance(29 * MINUTE);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
  env.advance(MINUTE);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
});

test('a tab already on a sign-out page when first seen is closed, but not while being visited', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://www.fidelity.com/customer-service/customer-logout', title: 'Fidelity' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://www.fidelity.com/customer-service/customer-logout', title: 'Fidelity' },
    { id: 3, windowId: 1, index: 2, active: false, url: 'https://news.test/', title: 'News' },
  ];
  const env = setup(tabs);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
  env.tab(1).active = false;
  env.tab(3).active = true;
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2, 1]);
});

test('duplicates wait until the new copy has finished loading', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 2, index: 0, active: true, url: 'https://a.test/page' },
  ];
  const env = setup(tabs);
  await env.controller.request();
  env.chrome._state.tabs.push({ id: 3, windowId: 2, index: 1, active: false, url: 'https://a.test/page', status: 'loading', pinned: false, audible: false, incognito: false });
  env.advance(MINUTE);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
  env.tab(3).status = 'complete';
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2], 'the newer copy wins on a tie of visits');
});

test('never closes incognito, pinned or audible tabs', async () => {
  const tabs = [
    ...baseTabs(),
    { id: 3, windowId: 2, index: 1, url: 'https://p.test/', pinned: true },
    { id: 4, windowId: 2, index: 2, url: 'https://m.test/', audible: true },
    { id: 5, windowId: 3, index: 0, url: 'https://i.test/', incognito: true },
  ];
  const env = setup(tabs, { now: 1_000_000_000_000 });
  await env.controller.request();
  env.advance(48 * HOUR);
  env.tab(4).audible = true;
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
});

test('keeps the tab open and logs if the history record cannot be written', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.history.failAdd = true;
  env.advance(25 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
});

test('removes the history record again if the tab cannot be closed', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.chrome._state.failRemove.add(2);
  env.advance(25 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.history.records, []);
  assert.equal(env.chrome._state.alarms.get(SWEEP_ALARM).when, env.now + 30 * 1000, 'retries later');
});

test('re-attaches state after a browser restart', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  env.advance(20 * HOUR);
  await env.controller.request();
  // Simulate restart: new ids, session storage cleared.
  env.chrome._state.tabs = [
    { id: 11, windowId: 5, index: 0, active: true, url: 'https://work.test/', title: 'Work', pinned: false, audible: false, incognito: false },
    { id: 12, windowId: 6, index: 0, active: true, url: 'https://other.test/', title: 'Other', pinned: false, audible: false, incognito: false },
  ];
  env.chrome._state.focusedWindowId = 5;
  delete env.chrome.storage.session.data.sessionStarted;
  env.advance(4 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [12], 'tab 12 kept its stored last-visited time');
});

test('settings thresholds are applied', async () => {
  const env = setup(baseTabs());
  await env.chrome.storage.sync.set({ [SETTINGS_KEY]: { tabLimit: 0, staleHours: 1 } });
  await env.controller.request();
  env.advance(HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
});

test('pauses a background tab after the delay and resumes it on return', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://video.test/', audible: true },
  ];
  const env = setup(tabs, { hostAccess: true });
  await env.controller.request();
  assert.deepEqual(env.chrome._state.scripts, [], 'waits for the grace delay');
  assert.equal([...env.timers.pending.values()][0].ms, 2000);
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.scripts, [[2, 'pauseMediaInPage']]);
  // The page went quiet, so the mute check does nothing.
  env.tab(2).audible = false;
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.updates, []);
  // User switches to tab 2.
  env.tab(1).active = false;
  env.tab(2).active = true;
  await env.controller.request();
  assert.deepEqual(env.chrome._state.scripts.at(-1), [2, 'resumeMediaInPage']);
});

test('switching back within the delay cancels the pause', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://video.test/', audible: true },
  ];
  const env = setup(tabs, { hostAccess: true });
  await env.controller.request();
  env.tab(1).active = false;
  env.tab(2).active = true;
  await env.controller.request();
  assert.equal(env.timers.pending.size, 0);
  assert.deepEqual(env.chrome._state.scripts, []);
});

test('mutes instead of pausing without host access, and unmutes on return', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://game.test/', audible: true },
  ];
  const env = setup(tabs);
  await env.controller.request();
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.updates, [[2, { muted: true }]]);
  env.tab(1).active = false;
  env.tab(2).active = true;
  await env.controller.request();
  assert.deepEqual(env.chrome._state.updates.at(-1), [2, { muted: false }]);
});

test('mutes when the page is still audible after pausing', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://synth.test/', audible: true },
  ];
  const env = setup(tabs, { hostAccess: true });
  await env.controller.request();
  await env.timers.runAll();
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.updates, [[2, { muted: true }]]);
});

test('a tab muted by the extension is no longer exempt from closing', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 2, index: 0, active: true, url: 'https://game.test/', audible: true },
  ];
  const env = setup(tabs);
  await env.controller.request();
  await env.timers.runAll();
  env.advance(25 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [2]);
});

test('keep-playing sites are never paused', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://music.youtube.com/', audible: true },
  ];
  const env = setup(tabs, { hostAccess: true });
  await env.chrome.storage.sync.set({ [SETTINGS_KEY]: { tabLimit: 0, keepPlayingHosts: ['youtube.com'] } });
  await env.controller.request();
  assert.equal(env.timers.pending.size, 0);
});

test('concurrent requests are coalesced into serial passes', async () => {
  const env = setup(baseTabs());
  let calls = 0;
  const query = env.chrome.tabs.query;
  env.chrome.tabs.query = async (...args) => {
    calls++;
    return query(...args);
  };
  await Promise.all([env.controller.request(), env.controller.request(), env.controller.request()]);
  assert.equal(calls, 2);
});

const audioTabs = (url = 'https://game.test/') => [
  { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
  { id: 2, windowId: 2, index: 0, active: true, url, audible: true },
];

test('a tab the user unmuted is protected again while it plays', async () => {
  const env = setup(audioTabs());
  await env.controller.request();
  await env.timers.runAll();
  assert.equal(env.tab(2).mutedInfo.muted, true);
  env.tab(2).mutedInfo = { muted: false, reason: 'user' };
  env.advance(25 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [], 'audible and no longer muted by us');
  assert.equal(env.chrome.storage.local.data[STATE_KEY].entries[2].mutedByUs, false);
});

test('playback that restarts in a paused background tab is paused again', async () => {
  const env = setup(audioTabs('https://video.test/'), { hostAccess: true });
  await env.controller.request();
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.scripts, [[2, 'pauseMediaInPage']]);
  env.tab(2).audible = false;
  await env.timers.runAll();
  env.tab(2).audible = true;
  await env.controller.request();
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.scripts.map((s) => s[1]), ['pauseMediaInPage', 'pauseMediaInPage']);
});

test('adding a paused tab to the keep-playing list resumes it in the background', async () => {
  const env = setup(audioTabs('https://video.test/'), { hostAccess: true });
  await env.controller.request();
  await env.timers.runAll();
  await env.chrome.storage.sync.set({ [SETTINGS_KEY]: { tabLimit: 0, keepPlayingHosts: ['video.test'] } });
  await env.controller.request();
  assert.deepEqual(env.chrome._state.scripts.at(-1), [2, 'resumeMediaInPage']);
  assert.equal(env.timers.pending.size, 0, 'the pending mute check was cancelled');
});

test('turning audio pausing off unmutes tabs the extension muted', async () => {
  const env = setup(audioTabs());
  await env.controller.request();
  await env.timers.runAll();
  await env.chrome.storage.sync.set({ [SETTINGS_KEY]: { tabLimit: 0, audioPauseEnabled: false } });
  await env.controller.request();
  assert.deepEqual(env.chrome._state.updates.at(-1), [2, { muted: false }]);
});

test('returning to a paused tab cancels its pending mute check', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://video.test/', audible: true },
  ];
  const env = setup(tabs, { hostAccess: true });
  await env.controller.request();
  await env.timers.runAll(); // paused; mute check scheduled
  env.tab(1).active = false;
  env.tab(2).active = true;
  await env.controller.request(); // resumed
  assert.equal([...env.timers.pending.values()].filter((t) => t.ms === 4000).length, 0);
});

const filler = (count, windowId = 1) =>
  Array.from({ length: count }, (_, i) => ({ id: 100 + i, windowId, index: i + 1, url: `https://filler${i}.test/` }));

test('tab limit: with 12 tabs nothing closes and no sweep alarm is set; a 13th tab turns it on', async () => {
  const env = setup([...baseTabs(), ...filler(10)]);
  delete env.chrome.storage.sync.data[SETTINGS_KEY]; // default limit of 12
  await env.controller.request();
  env.advance(48 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, []);
  assert.equal(env.chrome._state.alarms.has(SWEEP_ALARM), false);
  env.chrome._state.tabs.push({ id: 200, windowId: 1, index: 20, url: 'https://new.test/', active: false, pinned: false, audible: false, incognito: false });
  await env.controller.request();
  assert.deepEqual(
    env.chrome._state.removed.sort((a, b) => a - b),
    [2, ...filler(10).map((t) => t.id)],
    'every long-unvisited tab closes, in any window; the visited tab and the new tab stay',
  );
});

test('tab limit does not count incognito tabs and does not affect audio pausing', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: true, url: 'https://work.test/' },
    { id: 2, windowId: 1, index: 1, active: false, url: 'https://video.test/', audible: true },
    ...Array.from({ length: 11 }, (_, i) => ({ id: 300 + i, windowId: 9, index: i, url: `https://i${i}.test/`, incognito: true })),
  ];
  const env = setup(tabs);
  delete env.chrome.storage.sync.data[SETTINGS_KEY];
  await env.controller.request();
  env.advance(48 * HOUR);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [], 'only 2 non-incognito tabs');
  await env.timers.runAll();
  assert.deepEqual(env.chrome._state.updates, [[2, { muted: true }]], 'audio is still paused/muted');
});

test('Rule 4: an unused new tab left behind in the active window is closed after 10 minutes', async () => {
  const tabs = [
    { id: 1, windowId: 1, index: 0, active: false, url: 'chrome://newtab/', title: 'New Tab' },
    { id: 2, windowId: 1, index: 1, active: true, url: 'https://work.test/' },
  ];
  const env = setup(tabs);
  await env.controller.request();
  assert.equal(env.chrome._state.alarms.get(SWEEP_ALARM).when, env.now + 10 * MINUTE);
  env.advance(10 * MINUTE);
  await env.controller.request();
  assert.deepEqual(env.chrome._state.removed, [1]);
  assert.equal(env.history.records[0].reason, 'empty');
});
