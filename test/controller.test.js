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
  await env.controller.onFocusChanged(2);
  env.advance(MINUTE);
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
  assert.deepEqual(env.chrome._state.removed, [2], 'window 1 stays protected');
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

test('only reacts to relevant tab updates', async () => {
  const env = setup(baseTabs());
  assert.equal(env.controller.onTabUpdated(1, { favIconUrl: 'x' }), undefined);
  assert.ok(env.controller.onTabUpdated(1, { status: 'complete' }) instanceof Promise);
  assert.ok(env.controller.onTabUpdated(1, { audible: true }) instanceof Promise);
});

test('ignores focus moving to an incognito window', async () => {
  const env = setup(baseTabs());
  await env.controller.request();
  await env.controller.onFocusChanged(99);
  assert.equal(env.chrome.storage.local.data[STATE_KEY].activeWindowId, 1);
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
  await env.chrome.storage.sync.set({ [SETTINGS_KEY]: { staleHours: 1 } });
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
  await env.chrome.storage.sync.set({ [SETTINGS_KEY]: { keepPlayingHosts: ['youtube.com'] } });
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
