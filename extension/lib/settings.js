// User settings (stored in chrome.storage.sync under "settings").

import { hostMatches } from './url.js';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SITE_RULES = [
  { host: 'chase.com', pattern: 'logon|logoff|logout|signin|timeout' },
  { host: 'fidelity.com', pattern: 'login|logout|logoff|timeout' },
];

// Audio pauses use an in-memory timer; MV3 may suspend an idle service
// worker after ~30 s, so longer delays aren't reliable.
export const MAX_AUDIO_PAUSE_DELAY_SECONDS = 25;

export const DEFAULT_SETTINGS = Object.freeze({
  // Auto-closing only runs while more than this many tabs are open.
  tabLimit: 12,
  loggedOutMinutes: 30,
  staleHours: 24,
  audioPauseEnabled: true,
  audioPauseDelaySeconds: 2,
  keepPlayingHosts: [],
  siteRules: DEFAULT_SITE_RULES,
});

function wholeNumber(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Fills in defaults and drops invalid values from whatever was stored.
export function mergeSettings(stored = {}) {
  const s = stored ?? {};
  return {
    tabLimit: wholeNumber(s.tabLimit, DEFAULT_SETTINGS.tabLimit),
    loggedOutMinutes: positiveNumber(s.loggedOutMinutes, DEFAULT_SETTINGS.loggedOutMinutes),
    staleHours: positiveNumber(s.staleHours, DEFAULT_SETTINGS.staleHours),
    audioPauseEnabled:
      typeof s.audioPauseEnabled === 'boolean' ? s.audioPauseEnabled : DEFAULT_SETTINGS.audioPauseEnabled,
    audioPauseDelaySeconds: Math.min(
      positiveNumber(s.audioPauseDelaySeconds, DEFAULT_SETTINGS.audioPauseDelaySeconds),
      MAX_AUDIO_PAUSE_DELAY_SECONDS,
    ),
    keepPlayingHosts: Array.isArray(s.keepPlayingHosts)
      ? s.keepPlayingHosts.filter((h) => typeof h === 'string' && h)
      : [],
    siteRules: Array.isArray(s.siteRules)
      ? s.siteRules.filter((r) => r && typeof r.host === 'string' && isValidPattern(r.pattern))
      : DEFAULT_SITE_RULES,
  };
}

export function isValidPattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return false;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

// "https://Music.YouTube.com/watch" -> "music.youtube.com". Returns '' if empty.
export function cleanHost(input) {
  let value = input.trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0];
  return value.replace(/:\d+$/, '');
}

// One host per line; blank lines ignored; duplicates removed.
export function parseHostList(text) {
  const hosts = text.split(/\r?\n/).map(cleanHost).filter(Boolean);
  return [...new Set(hosts)];
}

// One rule per line: "<host> <regex>". Returns parsed rules and line errors.
export function parseSiteRules(text) {
  const rules = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [rawHost, ...rest] = trimmed.split(/\s+/);
    const host = cleanHost(rawHost);
    const pattern = rest.join(' ');
    if (!host || !isValidPattern(pattern)) {
      errors.push(`Line ${i + 1}: expected "<host> <regex>"`);
      return;
    }
    rules.push({ host, pattern });
  });
  return { rules, errors };
}

export function formatSiteRules(rules) {
  return rules.map((r) => `${r.host} ${r.pattern}`).join('\n');
}

// Turning a host off also removes broader patterns that cover it (e.g.
// "youtube.com" when switching off music.youtube.com).
export function toggleHost(hosts, host, enabled) {
  const without = hosts.filter((h) => (enabled ? h !== host : !hostMatches(host, h)));
  return enabled ? [...without, host] : without;
}
