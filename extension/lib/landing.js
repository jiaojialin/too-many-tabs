// Empty and landing-page tabs (Rule 4).

import { hostMatches } from './url.js';

export const DEFAULT_LANDING_PAGES = [
  'chrome://newtab',
  'chrome://new-tab-page',
  'about:blank',
  'google.*',
  'google.*/webhp',
  'bing.com',
  'duckduckgo.com',
  'search.yahoo.com',
  'baidu.com',
];

// Any of these means a search was made, so the page is no longer a landing page.
const SEARCH_PARAMS = ['q', 'p', 'wd', 'query', 'text'];

// "google.com", "google.co.uk", "google.com.au", ...
const GOOGLE_HOST = /^google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/;

function stripSlash(path) {
  return path.replace(/\/+$/, '');
}

// Plain hosts match exactly (a leading "www." is ignored by the caller);
// "*.example.com" also matches subdomains.
function matchesHost(host, pattern) {
  if (pattern === 'google.*') return GOOGLE_HOST.test(host);
  if (pattern.startsWith('*.')) return hostMatches(host, pattern);
  return host === pattern;
}

export function matchesLandingPattern(url, pattern) {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.includes('://') || p.startsWith('about:')) {
    // Full URL pattern, e.g. "chrome://newtab" or "about:blank".
    const separator = url.protocol === 'about:' ? '' : '//';
    const page = `${url.protocol}${separator}${url.host}${url.pathname}`.toLowerCase();
    return stripSlash(page) === stripSlash(p);
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  const slash = p.indexOf('/');
  const hostPattern = (slash === -1 ? p : p.slice(0, slash)).replace(/^www\./, '');
  const path = slash === -1 ? '' : stripSlash(p.slice(slash));
  const host = url.hostname.replace(/^www\./, '');
  return matchesHost(host, hostPattern) && stripSlash(url.pathname) === path;
}

// True when the tab is still on an empty or landing page (no search made).
export function isLandingPage(raw, patterns) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (SEARCH_PARAMS.some((name) => url.searchParams.has(name))) return false;
  if (/(?:^#|&)q=/.test(url.hash)) return false;
  return patterns.some((pattern) => matchesLandingPattern(url, pattern));
}
