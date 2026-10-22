import { createHistoryDb } from '../lib/db.js';
import { isKeepPlaying } from '../lib/audio.js';
import { SETTINGS_KEY, mergeSettings, toggleHost } from '../lib/settings.js';
import { dayLabel, formatClock, formatFull } from '../lib/timeline.js';
import { hostOf } from '../lib/url.js';
import { el, favicon, reasonBadge, reopen } from '../ui/render.js';

const RECENT_COUNT = 5;

async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

async function renderKeepPlaying() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(tab?.url ?? '');
  if (!/^https?:/.test(tab?.url ?? '') || !host) return;
  const settings = await loadSettings();
  const checkbox = document.getElementById('keep-playing');
  document.getElementById('site-host').textContent = host;
  checkbox.checked = isKeepPlaying(tab.url, settings.keepPlayingHosts);
  checkbox.addEventListener('change', async () => {
    const latest = await loadSettings();
    const keepPlayingHosts = toggleHost(latest.keepPlayingHosts, host, checkbox.checked);
    await chrome.storage.sync.set({ [SETTINGS_KEY]: { ...latest, keepPlayingHosts } });
  });
  document.getElementById('site').hidden = false;
}

async function renderRecent() {
  const { records } = await createHistoryDb().query({ limit: RECENT_COUNT });
  const list = document.getElementById('recent');
  document.getElementById('empty').hidden = records.length > 0;
  const now = Date.now();
  for (const record of records) {
    const day = dayLabel(record.closedAt, now);
    list.append(
      el(
        'div',
        { class: 'row', title: `${record.url}\nClosed ${formatFull(record.closedAt)}` },
        favicon(record),
        el('span', { class: 'title' }, record.title || record.url),
        reasonBadge(record.reason),
        el('span', { class: 'time' }, day === 'Today' ? formatClock(record.closedAt) : day),
        el('button', { onclick: () => reopen(record.url) }, 'Reopen'),
      ),
    );
  }
}

document.getElementById('open-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
});
document.getElementById('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

renderKeepPlaying();
renderRecent();
