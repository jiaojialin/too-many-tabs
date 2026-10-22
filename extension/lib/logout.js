// Heuristics for spotting tabs whose site signed the user out (Rule 1).

import { hostMatches, sameSite } from './url.js';

// Matched against host + path + query + fragment. The non-letter boundaries
// keep words like "blogging" or "catalog-index" from matching.
const URL_PATTERN =
  /(?:^|[^a-z])(?:log[-_]?(?:on|in|off|out)|sign[-_]?(?:on|in|off|out)|timed?[-_]?out|session[-_]?(?:expired|timeout|ended|end))(?:[^a-z]|$)/i;

const TITLE_PATTERN =
  /\b(?:sign(?:ed)?[\s-]?(?:in|on|out|off)|log(?:ged)?[\s-]?(?:in|on|out|off)|session (?:has )?(?:expired|timed out|ended)|session timeout|timed out)\b/i;

export function isLoginLikeUrl(raw, siteRules = []) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  const target = `${url.hostname}${url.pathname}${url.search}${url.hash}`;
  if (URL_PATTERN.test(target)) return true;
  return siteRules.some(
    (rule) => hostMatches(url.hostname, rule.host) && new RegExp(rule.pattern, 'i').test(raw),
  );
}

export function isLoginLikeTitle(title) {
  return TITLE_PATTERN.test(title ?? '');
}

export function isLoginLike({ url, title }, siteRules = []) {
  return isLoginLikeUrl(url, siteRules) || (/^https?:/i.test(url ?? '') && isLoginLikeTitle(title));
}

// Given the previous tracked state of a tab ({url, loginLike, loggedOutSince})
// and its current {url, title}, returns the next {loginLike, loggedOutSince}.
// A tab counts as logged out when it moves from a normal page to a
// login/timeout page on the same site; leaving the login page clears it.
export function nextLogoutState(prev, current, now, siteRules = []) {
  const loginLike = isLoginLike(current, siteRules);
  if (!loginLike) return { loginLike, loggedOutSince: null };
  if (prev?.loggedOutSince) return { loginLike, loggedOutSince: prev.loggedOutSince };
  if (prev && prev.loginLike === false && sameSite(prev.url, current.url)) {
    return { loginLike, loggedOutSince: now };
  }
  return { loginLike, loggedOutSince: null };
}
