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

test('query with from after to returns nothing instead of throwing', async () => {
  await history.add(record(10));
  assert.deepEqual(await history.query({ from: 20, to: 5 }), { records: [], next: null });
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

const DAY_MS = 86_400_000;
const localDay = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

async function seedDays() {
  await history.add(record(localDay(2026, 10, 21, 9), { title: 'a', reason: 'stale' }));
  await history.add(record(localDay(2026, 10, 21, 15), { title: 'b', reason: 'duplicate' }));
  await history.add(record(localDay(2026, 10, 18, 10), { title: 'c', reason: 'stale' }));
  await history.add(record(localDay(2026, 10, 12, 10), { title: 'd', reason: 'duplicate' }));
}

test('nearestDay: latest, older and newer days with records, skipping empty days', async () => {
  await seedDays();
  const d21 = localDay(2026, 10, 21, 0), d18 = localDay(2026, 10, 18, 0), d12 = localDay(2026, 10, 12, 0);
  assert.equal(await history.nearestDay(null, 'latest'), d21);
  assert.equal(await history.nearestDay(d21, 'older'), d18);
  assert.equal(await history.nearestDay(d18, 'older'), d12);
  assert.equal(await history.nearestDay(d12, 'older'), null);
  assert.equal(await history.nearestDay(d12, 'newer'), d18);
  assert.equal(await history.nearestDay(d21, 'newer'), null);
  assert.equal(await history.nearestDay(d21, 'older', { reason: 'duplicate' }), d12, 'filters apply');
  assert.equal(await history.nearestDay(null, 'latest', { to: d18 + DAY_MS - 1 }), d18, 'date range applies');
});

test('dayPage: a day with its records and neighbours, in the requested order', async () => {
  await seedDays();
  const d21 = localDay(2026, 10, 21, 0), d18 = localDay(2026, 10, 18, 0);
  const latest = await history.dayPage(null);
  assert.equal(latest.day, d21);
  assert.deepEqual(latest.records.map((r) => r.title), ['b', 'a']);
  assert.equal(latest.newer, null);
  assert.equal(latest.older, d18);
  assert.deepEqual((await history.dayPage(d21, { order: 'asc' })).records.map((r) => r.title), ['a', 'b']);
  const middle = await history.dayPage(d18);
  assert.deepEqual([middle.newer, middle.older], [d21, localDay(2026, 10, 12, 0)]);
});

test('dayPage: a partial-day range only loads that part', async () => {
  await seedDays();
  const page = await history.dayPage(null, { from: localDay(2026, 10, 21, 12) });
  assert.deepEqual(page.records.map((r) => r.title), ['b']);
  assert.equal(page.older, null);
});

test('dayPage: an emptied day falls back to the next older day, then newer; empty history gives null', async () => {
  assert.deepEqual(await history.dayPage(null), { day: null, records: [], newer: null, older: null });
  await seedDays();
  const d21 = localDay(2026, 10, 21, 0), d18 = localDay(2026, 10, 18, 0), d12 = localDay(2026, 10, 12, 0);
  assert.equal((await history.dayPage(localDay(2026, 10, 20, 0))).day, d18, 'older first');
  assert.equal((await history.dayPage(d21, { reason: 'stale', text: 'c' })).day, d18);
  assert.equal((await history.dayPage(localDay(2026, 10, 1, 0))).day, d12, 'then newer');
  assert.equal((await history.dayPage(d21, { text: 'zzz' })).day, null);
});
