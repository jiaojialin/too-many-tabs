import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioKeeperId, isKeepPlaying, pauseMediaInPage, resumeMediaInPage, shouldPause, shouldResume } from '../extension/lib/audio.js';
import { DEFAULT_SETTINGS } from '../extension/lib/settings.js';

const ctx = (settings = {}) => ({ visitedTabId: 1, settings: { ...DEFAULT_SETTINGS, ...settings } });
const playing = (id, extra = {}) => ({ id, audible: true, url: 'https://video.test/watch', ...extra });

test('shouldPause: audible tabs other than the visited one', () => {
  assert.ok(shouldPause(playing(2), {}, ctx()));
  assert.ok(!shouldPause(playing(1), {}, ctx()), 'visited tab keeps playing');
  assert.ok(!shouldPause(playing(2, { audible: false }), {}, ctx()));
  assert.ok(!shouldPause(playing(2, { incognito: true }), {}, ctx()));
  assert.ok(!shouldPause(playing(2, { mutedInfo: { muted: true } }), {}, ctx()));
  assert.ok(!shouldPause(playing(2), { pausedByUs: true }, ctx()), 'already handled');
  assert.ok(!shouldPause(playing(2), {}, ctx({ audioPauseEnabled: false })));
  assert.ok(!shouldPause(playing(2), {}, ctx({ keepPlayingHosts: ['video.test'] })));
});

test('shouldResume only for the visited tab the extension paused or muted', () => {
  assert.ok(shouldResume(playing(1), { pausedByUs: true }, ctx()));
  assert.ok(shouldResume(playing(1), { mutedByUs: true }, ctx()));
  assert.ok(!shouldResume(playing(1), {}, ctx()));
  assert.ok(!shouldResume(playing(2), { pausedByUs: true }, ctx()));
});

test('shouldResume also when settings no longer want the tab paused', () => {
  assert.ok(shouldResume(playing(2), { pausedByUs: true }, ctx({ audioPauseEnabled: false })));
  assert.ok(shouldResume(playing(2), { mutedByUs: true }, ctx({ keepPlayingHosts: ['video.test'] })));
  assert.ok(!shouldResume(playing(2), {}, ctx({ audioPauseEnabled: false })));
});

test('isKeepPlaying matches subdomains', () => {
  assert.ok(isKeepPlaying('https://music.youtube.com/', ['youtube.com']));
  assert.ok(!isKeepPlaying('https://www.youtube.com/', ['music.youtube.com']));
});

function fakeMedia(paused) {
  return {
    paused,
    ended: false,
    dataset: {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
}

test('pause/resume page scripts only resume what they paused', () => {
  const playingEl = fakeMedia(false);
  const userPaused = fakeMedia(true);
  globalThis.document = { querySelectorAll: () => [playingEl, userPaused] };
  try {
    assert.equal(pauseMediaInPage(), 1);
    assert.ok(playingEl.paused);
    assert.equal(resumeMediaInPage(), 1);
    assert.ok(!playingEl.paused);
    assert.ok(userPaused.paused, 'media the user paused stays paused');
  } finally {
    delete globalThis.document;
  }
});

test('audioKeeperId: the visited tab if it plays, else the most recently visited playing tab', () => {
  const c = { ...ctx(), now: 1000 };
  const tabs = [playing(1), playing(2), playing(3)];
  const entries = { 2: { lastVisitedAt: 900 }, 3: { lastVisitedAt: 500 } };
  assert.equal(audioKeeperId(tabs, entries, c), 1);
  const quietVisited = [playing(1, { audible: false }), playing(2), playing(3)];
  assert.equal(audioKeeperId(quietVisited, entries, c), 2);
  assert.equal(audioKeeperId([playing(1, { audible: false })], entries, c), null);
});

test('audioKeeperId: user-muted and keep-playing tabs do not compete; tabs we muted do', () => {
  const c = { ...ctx({ keepPlayingHosts: ['radio.test'] }), now: 1000 };
  const entries = { 2: { lastVisitedAt: 900 }, 3: { lastVisitedAt: 800 }, 4: { lastVisitedAt: 100, mutedByUs: true } };
  const tabs = [
    playing(2, { mutedInfo: { muted: true, reason: 'user' } }),
    playing(3, { url: 'https://radio.test/' }),
    playing(4, { mutedInfo: { muted: true, reason: 'extension' } }),
  ];
  assert.equal(audioKeeperId(tabs, entries, c), 4);
});

test('shouldPause: never the keeper, so a lone playing tab keeps playing', () => {
  assert.ok(!shouldPause(playing(2), {}, { ...ctx(), audioKeeperId: 2 }));
  assert.ok(shouldPause(playing(3), {}, { ...ctx(), audioKeeperId: 2 }));
});

test('shouldResume: a tab we muted becomes the keeper; a tab we paused waits for a visit', () => {
  const c = { ...ctx(), audioKeeperId: 2 };
  assert.ok(shouldResume(playing(2), { mutedByUs: true }, c));
  assert.ok(!shouldResume(playing(2, { audible: false }), { pausedByUs: true }, c));
});
