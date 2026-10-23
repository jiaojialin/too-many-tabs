import assert from 'node:assert/strict';
import { test } from 'node:test';
import initSqlJs from 'sql.js';
import { CLEAR_PHRASE, COLUMNS, csvField, exportFilename, isClearConfirmed, toCsv, toJson, toSqlite } from '../extension/lib/export.js';

const records = [
  { id: 1, url: 'https://a.test/?q=1,2', title: 'Say "hi"', domain: 'a.test', reason: 'stale', closedAt: 100, lastVisitedAt: 50, windowId: 1, groupId: -1, index: 0 },
  { id: 2, url: 'https://b.test/', title: '=HYPERLINK("x")', domain: 'b.test', reason: 'duplicate', closedAt: 200 },
];

test('toJson writes every column', () => {
  const parsed = JSON.parse(toJson(records));
  assert.equal(parsed.length, 2);
  assert.deepEqual(Object.keys(parsed[0]), COLUMNS);
  assert.equal(parsed[1].favIconUrl, null);
});

test('csvField quotes and defuses formulas', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "x"'), '"say ""x"""');
  assert.equal(csvField('=1+1'), "'=1+1");
  assert.equal(csvField(-1), '-1', 'numbers are left alone');
  assert.equal(csvField(null), '');
});

test('toCsv has a header row and one line per record', () => {
  const lines = toCsv(records).trimEnd().split('\r\n');
  assert.equal(lines[0], COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('"https://a.test/?q=1,2"'));
});

test('toSqlite produces a closed_tabs table with the records', async () => {
  const SQL = await initSqlJs();
  const bytes = toSqlite(SQL, records);
  const db = new SQL.Database(bytes);
  const [result] = db.exec('SELECT id, url, reason, closedAt FROM closed_tabs ORDER BY id');
  assert.deepEqual(result.values, [
    [1, 'https://a.test/?q=1,2', 'stale', 100],
    [2, 'https://b.test/', 'duplicate', 200],
  ]);
  db.close();
});

test('exportFilename includes a local timestamp', () => {
  assert.equal(exportFilename('csv', new Date(2026, 9, 21, 14, 3, 9)), 'too-many-tabs-history-20261021-140309.csv');
});

test('backup file name and the clear-all phrase', () => {
  assert.equal(exportFilename('json', new Date(2026, 9, 23, 9, 5, 1), 'history-backup'), 'too-many-tabs-history-backup-20261023-090501.json');
  assert.equal(CLEAR_PHRASE, 'confirm to clear all history');
  assert.ok(isClearConfirmed('confirm to clear all history'));
  assert.ok(isClearConfirmed('  confirm to clear all history '));
  assert.ok(!isClearConfirmed('Confirm to clear all history'));
  assert.ok(!isClearConfirmed('comfirm to clear all history'));
  assert.ok(!isClearConfirmed(''));
});
