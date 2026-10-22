// Background audio pausing helpers.

import { lastVisitedAt } from './rules.js';
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

// The one tab allowed to keep making sound: the visited tab if it is
// audible, otherwise the most recently visited audible tab. So a lone
// playing tab (e.g. a call you switched away from) is never paused. Tabs the
// extension muted still count (they are audible under the mute); tabs the
// user muted and keep-playing tabs don't compete. Returns null if none.
export function audioKeeperId(tabs, entries, ctx) {
  const competing = tabs.filter(
    (tab) =>
      tab.audible &&
      !tab.incognito &&
      !(tab.mutedInfo?.muted && !entries[tab.id]?.mutedByUs) &&
      !isKeepPlaying(tab.url, ctx.settings.keepPlayingHosts),
  );
  if (competing.some((tab) => tab.id === ctx.visitedTabId)) return ctx.visitedTabId;
  let keeper = null;
  for (const tab of competing) {
    const visited = lastVisitedAt(tab, entries[tab.id], ctx);
    if (!keeper || visited > keeper.visited || (visited === keeper.visited && tab.id > keeper.tab.id)) {
      keeper = { tab, visited };
    }
  }
  return keeper?.tab.id ?? null;
}

// Whether a playing tab should be paused (after the grace delay). `ctx`
// carries `audioKeeperId` from audioKeeperId().
export function shouldPause(tab, entry, ctx) {
  return Boolean(
    ctx.settings.audioPauseEnabled &&
      tab.audible &&
      !tab.incognito &&
      tab.id !== ctx.visitedTabId &&
      tab.id !== ctx.audioKeeperId &&
      !tab.mutedInfo?.muted &&
      !entry?.pausedByUs &&
      !entry?.mutedByUs &&
      !isKeepPlaying(tab.url, ctx.settings.keepPlayingHosts),
  );
}

// Whether the extension should undo its pause/mute on a tab: when the user
// comes back to it, when settings no longer want it paused, or when a tab we
// muted becomes the only one making sound (it is still playing under the
// mute). Media we paused stays paused until the user comes back.
export function shouldResume(tab, entry, ctx) {
  if (!entry?.pausedByUs && !entry?.mutedByUs) return false;
  return (
    tab.id === ctx.visitedTabId ||
    (entry.mutedByUs && tab.id === ctx.audioKeeperId) ||
    !ctx.settings.audioPauseEnabled ||
    isKeepPlaying(tab.url, ctx.settings.keepPlayingHosts)
  );
}
