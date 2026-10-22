import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoginLike, isLoginLikeTitle, isLoginLikeUrl, nextLogoutState } from '../extension/lib/logout.js';
import { DEFAULT_SITE_RULES } from '../extension/lib/settings.js';

test('isLoginLikeUrl recognizes login, logout and timeout URLs', () => {
  for (const url of [
    'https://secure.chase.com/web/auth/#/logon/logon/chaseOnline',
    'https://digital.fidelity.com/prgw/digital/login/full-page',
    'https://bank.example.com/account?reason=sessionTimeout',
    'https://bank.example.com/session-expired',
    'https://bank.example.com/sign_in',
    'https://login.example.com/',
    'https://bank.example.com/logoff.do',
  ]) {
    assert.ok(isLoginLikeUrl(url), url);
  }
});

test('isLoginLikeUrl ignores lookalike words and non-web URLs', () => {
  for (const url of [
    'https://example.com/blogging',
    'https://example.com/catalog-index',
    'https://example.com/account/summary',
    'chrome://login',
  ]) {
    assert.ok(!isLoginLikeUrl(url), url);
  }
});

test('site rules add patterns for matching hosts only', () => {
  const rules = [{ host: 'bank.test', pattern: 'goodbye' }];
  assert.ok(isLoginLikeUrl('https://www.bank.test/goodbye', rules));
  assert.ok(!isLoginLikeUrl('https://other.test/goodbye', rules));
  assert.ok(DEFAULT_SITE_RULES.some((r) => r.host === 'chase.com'));
});

test('isLoginLikeTitle', () => {
  for (const title of ['Sign In', 'Log On to Chase', 'Session Expired', 'Your session has timed out', 'You have been logged off', 'Signed out']) {
    assert.ok(isLoginLikeTitle(title), title);
  }
  assert.ok(!isLoginLikeTitle('Account Summary'));
  assert.ok(!isLoginLikeTitle(undefined));
});

test('isLoginLike uses the title only for web pages', () => {
  assert.ok(isLoginLike({ url: 'https://bank.test/home', title: 'Session Expired' }));
  assert.ok(!isLoginLike({ url: 'chrome://settings', title: 'Sign in' }));
});

test('nextLogoutState flags a same-site move from a normal page to a login page', () => {
  const prev = { url: 'https://secure.chase.com/web/auth/dashboard', loginLike: false, loggedOutSince: null };
  const state = nextLogoutState(prev, { url: 'https://secure.chase.com/web/auth/#/logon/logon', title: 'Chase' }, 1000);
  assert.deepEqual(state, { loginLike: true, loggedOutSince: 1000 });
});

test('nextLogoutState flags a title-only change on the same page', () => {
  const prev = { url: 'https://bank.test/accounts', loginLike: false, loggedOutSince: null };
  const state = nextLogoutState(prev, { url: 'https://bank.test/accounts', title: 'Session expired' }, 5);
  assert.equal(state.loggedOutSince, 5);
});

test('nextLogoutState keeps the original time while still on the login page', () => {
  const prev = { url: 'https://bank.test/login', loginLike: true, loggedOutSince: 10 };
  assert.equal(nextLogoutState(prev, { url: 'https://bank.test/login?x=1', title: 'Sign in' }, 99).loggedOutSince, 10);
});

test('nextLogoutState does not flag a login page opened directly or on another site', () => {
  assert.equal(nextLogoutState(undefined, { url: 'https://bank.test/login', title: '' }, 1).loggedOutSince, null);
  const prev = { url: 'https://news.test/article', loginLike: false, loggedOutSince: null };
  assert.equal(nextLogoutState(prev, { url: 'https://accounts.google.com/signin', title: '' }, 1).loggedOutSince, null);
});

test('nextLogoutState clears the flag after leaving the login page', () => {
  const prev = { url: 'https://bank.test/login', loginLike: true, loggedOutSince: 10 };
  assert.deepEqual(nextLogoutState(prev, { url: 'https://bank.test/accounts', title: 'Accounts' }, 20), {
    loginLike: false,
    loggedOutSince: null,
  });
});
