// Heuristics for spotting tabs whose site signed the user out (Rule 1).

import { hostMatches, sameSite } from './url.js';

// Matched against host + path + query + fragment. The non-letter boundaries
// keep words like "blogging" or "catalog-index" from matching.
const URL_PATTERN =
  /(?:^|[^a-z])(?:log[-_]?(?:on|in|off|out)|sign[-_]?(?:on|in|off|out)|timed?[-_]?out|session[-_]?(?:expired|timeout|ended|end))(?:[^a-z]|$)/i;

// The subset that means the user is already signed out (as opposed to a
// sign-in page): such a tab has nothing left to do and closes right away.
// Matched against host + path + fragment only, so a search for "session
// timeout" doesn't count; titles must say the logout already happened.
const SIGNED_OUT_URL_PATTERN =
  /(?:^|[^a-z])(?:log[-_]?(?:off|out)|sign[-_]?(?:off|out)|timed?[-_]?out|session[-_]?(?:expired|timeout|ended|end))(?:[^a-z]|$)/i;

const SIGNED_OUT_TITLE_PATTERN =
  /\b(?:(?:signed|logged)[\s-]?(?:out|off)|session (?:has )?(?:expired|timed out|ended))\b/i;

// A page offering to sign in again is a sign-in page, even after a timeout.
const SIGN_IN_URL_PATTERN = /(?:^|[^a-z])(?:log[-_]?(?:on|in)|sign[-_]?(?:on|in))(?:[^a-z]|$)/i;
const SIGN_IN_TITLE_PATTERN = /\b(?:sign[\s-]?(?:in|on)|log[\s-]?(?:in|on))\b/i;

const TITLE_PATTERN =
  /\b(?:sign(?:ed)?[\s-]?(?:in|on|out|off)|log(?:ged)?[\s-]?(?:in|on|out|off)|session (?:has )?(?:expired|timed out|ended)|session timeout|timed out)\b/i;

function webUrl(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function isLoginLikeUrl(raw, siteRules = []) {
  const url = webUrl(raw);
  if (!url) return false;
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
// login/timeout page on the same site, or from a sign-in page to a sign-out
// page on the same site; leaving the login page clears it.
export function nextLogoutState(prev, current, now, siteRules = []) {
  const loginLike = isLoginLike(current, siteRules);
  if (!loginLike) return { loginLike, loggedOutSince: null };
  if (prev?.loggedOutSince) return { loginLike, loggedOutSince: prev.loggedOutSince };
  if (prev && (prev.loginLike === false || isSignedOutPage(current)) && sameSite(prev.url, current.url)) {
    return { loginLike, loggedOutSince: now };
  }
  return { loginLike, loggedOutSince: null };
}

// A sign-out, logoff or session-timeout page (URL or title), not a sign-in page.
export function isSignedOutPage({ url, title }) {
  const parsed = webUrl(url ?? '');
  if (!parsed) return false;
  const signedOut =
    SIGNED_OUT_URL_PATTERN.test(`${parsed.hostname}${parsed.pathname}${parsed.hash}`) ||
    SIGNED_OUT_TITLE_PATTERN.test(title ?? '');
  const signIn =
    SIGN_IN_URL_PATTERN.test(`${parsed.hostname}${parsed.pathname}${parsed.search}${parsed.hash}`) ||
    SIGN_IN_TITLE_PATTERN.test(title ?? '');
  return signedOut && !signIn;
}

// A sign-in page, judged by its address only (host + path + #route): an
// article titled "How to sign in" is not one. Rule 4 treats these like
// landing pages.
export function isSignInPage({ url }) {
  const parsed = webUrl(url ?? '');
  return Boolean(parsed) && SIGN_IN_URL_PATTERN.test(`${parsed.hostname}${parsed.pathname}${parsed.hash}`);
}
