import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createHistoryDb, recordFromTab } from '../extension/lib/db.js';

let history;
beforeEach(() => {
  history = createHistoryDb(new IDBFactory());
});

const record = (closedAt, extra = {}) => ({
  url: `https://site.test/${closedAt}`,
  title: `Page ${closedAt}`,
  domain: 'site.test',
  reason: 'stale',
  closedAt,
  ...extra,
});

test('add/get/delete/clear', async () => {
  const id = await history.add(record(1));
  assert.equal((await history.get(id)).title, 'Page 1');
  await history.delete(id);
  assert.equal(await history.get(id), undefined);
  await history.add(record(2));
  await history.clear();
  assert.deepEqual((await history.query()).records, []);
});

test('query returns newest first by default and oldest first on request', async () => {
  for (const t of [3, 1, 2]) await history.add(record(t));
  assert.deepEqual((await history.query()).records.map((r) => r.closedAt), [3, 2, 1]);
  assert.deepEqual((await history.query({ order: 'asc' })).records.map((r) => r.closedAt), [1, 2, 3]);
});

test('query filters by date range, text, domain and reason', async () => {
  await history.add(record(10, { domain: 'chase.com', reason: 'logged-out', title: 'Chase' }));
  await history.add(record(20, { domain: 'news.test', reason: 'duplicate', title: 'Headline' }));
  await history.add(record(30, { domain: 'news.test', reason: 'stale', title: 'Other' }));
  const ids = async (opts) => (await history.query(opts)).records.map((r) => r.closedAt);
  assert.deepEqual(await ids({ from: 15, to: 30 }), [30, 20]);
  assert.deepEqual(await ids({ text: 'headLINE' }), [20]);
  assert.deepEqual(await ids({ text: 'site.test/10' }), [10], 'searches URLs too');
  assert.deepEqual(await ids({ domain: 'news.test' }), [30, 20]);
  assert.deepEqual(await ids({ reason: 'logged-out' }), [10]);
});

test('query pages with a cursor, including records closed at the same time', async () => {
  for (const t of [5, 5, 5, 4, 3]) await history.add(record(t));
  for (const order of ['desc', 'asc']) {
    const seen = [];
    let after = null;
    do {
      const page = await history.query({ order, limit: 2, after });
      seen.push(...page.records.map((r) => r.id));
      after = page.next;
    } while (after);
    assert.equal(new Set(seen).size, 5, order);
    assert.equal(seen.length, 5, order);
  }
});

test('query with limit Infinity returns everything', async () => {
  for (let t = 0; t < 120; t++) await history.add(record(t));
  const page = await history.query({ limit: Infinity });
  assert.equal(page.records.length, 120);
  assert.equal(page.next, null);
});

test('domains lists distinct domains', async () => {
  await history.add(record(1, { domain: 'b.test' }));
  await history.add(record(2, { domain: 'a.test' }));
  await history.add(record(3, { domain: 'b.test' }));
  assert.deepEqual(await history.domains(), ['a.test', 'b.test']);
});

test('recordFromTab captures the spec fields', () => {
  const tab = { id: 9, url: 'https://a.test/x', title: 'X', favIconUrl: 'https://a.test/f.ico', windowId: 2, groupId: 4, index: 7 };
  assert.deepEqual(recordFromTab(tab, { reason: 'duplicate', closedAt: 100, lastVisitedAt: 50, normalizedUrl: 'https://a.test/x', domain: 'a.test' }), {
    url: 'https://a.test/x',
    normalizedUrl: 'https://a.test/x',
    title: 'X',
    domain: 'a.test',
    favIconUrl: 'https://a.test/f.ico',
    reason: 'duplicate',
    closedAt: 100,
    lastVisitedAt: 50,
    windowId: 2,
    groupId: 4,
    index: 7,
  });
});
