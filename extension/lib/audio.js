// Background audio pausing helpers.

import { hostMatches, hostOf } from './url.js';

// Injected into every frame of a tab with chrome.scripting.executeScript, so
// it must be self-contained. Returns how many media elements it paused.
export function pauseMediaInPage() {
  let count = 0;
  for (const el of document.querySelectorAll('video, audio')) {
    if (!el.paused && !el.ended) {
      el.pause();
      el.dataset.tooManyTabsPaused = '1';
      count++;
    }
  }
  return count;
}

// Injected; resumes only the elements pauseMediaInPage paused.
export function resumeMediaInPage() {
  let count = 0;
  for (const el of document.querySelectorAll('video, audio')) {
    if (el.dataset.tooManyTabsPaused === '1') {
      delete el.dataset.tooManyTabsPaused;
      el.play().catch(() => {});
      count++;
    }
  }
  return count;
}

export function isKeepPlaying(url, keepPlayingHosts) {
  const host = hostOf(url);
  return host !== '' && keepPlayingHosts.some((pattern) => hostMatches(host, pattern));
}

// Whether a playing tab should be paused (after the grace delay).
export function shouldPause(tab, entry, ctx) {
  return Boolean(
    ctx.settings.audioPauseEnabled &&
      tab.audible &&
      !tab.incognito &&
      tab.id !== ctx.visitedTabId &&
      !tab.mutedInfo?.muted &&
      !entry?.pausedByUs &&
      !entry?.mutedByUs &&
      !isKeepPlaying(tab.url, ctx.settings.keepPlayingHosts),
  );
}

// Whether the extension should undo its pause/mute on a tab: when the user
// comes back to it, or when settings no longer want it paused.
export function shouldResume(tab, entry, ctx) {
  if (!entry?.pausedByUs && !entry?.mutedByUs) return false;
  return (
    tab.id === ctx.visitedTabId ||
    !ctx.settings.audioPauseEnabled ||
    isKeepPlaying(tab.url, ctx.settings.keepPlayingHosts)
  );
}
