import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isKeepPlaying, pauseMediaInPage, resumeMediaInPage, shouldPause, shouldResume } from '../extension/lib/audio.js';
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
