import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newEntry, refreshEntry, rematchEntries } from '../extension/lib/tabState.js';

const tab = (id, url, index = 0, extra = {}) => ({ id, url, index, windowId: 1, title: '', ...extra });

test('newEntry starts with the given time and normalized URL', () => {
  const entry = newEntry(tab(1, 'https://a.test/x/?utm_source=y'), 42);
  assert.equal(entry.lastVisitedAt, 42);
  assert.equal(entry.normalizedUrl, 'https://a.test/x');
  assert.equal(entry.loggedOutSince, null);
});

test('refreshEntry detects a logout transition and tracks position', () => {
  const entry = newEntry(tab(1, 'https://bank.test/accounts', 0, { title: 'Accounts' }), 1);
  const next = refreshEntry(entry, tab(1, 'https://bank.test/login', 3, { title: 'Sign in' }), 50);
  assert.equal(next.loggedOutSince, 50);
  assert.equal(next.index, 3);
  assert.equal(next.lastVisitedAt, 1);
  assert.equal(next.normalizedUrl, 'https://bank.test/login');
});

test('refreshEntry leaves an unchanged tab alone', () => {
  const entry = { ...newEntry(tab(1, 'https://bank.test/login'), 1), loggedOutSince: 7, loginLike: true };
  assert.equal(refreshEntry(entry, tab(1, 'https://bank.test/login'), 99).loggedOutSince, 7);
});

test('rematchEntries keeps entries whose id and URL still match', () => {
  const stored = { 1: { url: 'https://a.test/', index: 0, lastVisitedAt: 5 } };
  assert.equal(rematchEntries(stored, [tab(1, 'https://a.test/')], 100)[1].lastVisitedAt, 5);
});

test('rematchEntries re-attaches by URL and position after ids change', () => {
  const stored = {
    10: { url: 'https://a.test/', index: 0, lastVisitedAt: 1 },
    11: { url: 'https://a.test/', index: 1, lastVisitedAt: 2 },
    12: { url: 'https://b.test/', index: 5, lastVisitedAt: 3 },
  };
  const tabs = [tab(20, 'https://a.test/', 1), tab(21, 'https://a.test/', 0), tab(22, 'https://b.test/', 0), tab(23, 'https://c.test/', 3)];
  const result = rematchEntries(stored, tabs, 100);
  assert.equal(result[20].lastVisitedAt, 2);
  assert.equal(result[21].lastVisitedAt, 1);
  assert.equal(result[22].lastVisitedAt, 3, 'falls back to URL only');
  assert.equal(result[22].index, 0);
  assert.equal(result[23].lastVisitedAt, 100, 'unmatched tabs start at the restore time');
});

test('rematchEntries uses each stored entry at most once', () => {
  const stored = { 10: { url: 'https://a.test/', index: 0, lastVisitedAt: 1 } };
  const result = rematchEntries(stored, [tab(20, 'https://a.test/', 0), tab(21, 'https://a.test/', 1)], 100);
  assert.equal(result[20].lastVisitedAt, 1);
  assert.equal(result[21].lastVisitedAt, 100);
});
