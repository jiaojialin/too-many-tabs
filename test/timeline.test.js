import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayLabel, formatClock, groupByDay, parseLocalDateTime, rangeForPreset, startOfDay } from '../extension/lib/timeline.js';

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 21, 15, 0);

test('dayLabel: Today, Yesterday, then a full date', () => {
  assert.equal(dayLabel(at(2026, 10, 21, 0, 5), NOW, 'en-US'), 'Today');
  assert.equal(dayLabel(at(2026, 10, 20, 23, 59), NOW, 'en-US'), 'Yesterday');
  assert.equal(dayLabel(at(2026, 10, 19), NOW, 'en-US'), 'Mon, Oct 19, 2026');
});

test('groupByDay keeps order and groups consecutive days', () => {
  const records = [
    { id: 3, closedAt: at(2026, 10, 21, 14) },
    { id: 2, closedAt: at(2026, 10, 21, 9) },
    { id: 1, closedAt: at(2026, 10, 19, 8) },
  ];
  const groups = groupByDay(records, NOW, 'en-US');
  assert.deepEqual(groups.map((g) => [g.label, g.records.map((r) => r.id)]), [
    ['Today', [3, 2]],
    ['Mon, Oct 19, 2026', [1]],
  ]);
});

test('rangeForPreset', () => {
  assert.deepEqual(rangeForPreset('hour', NOW), { from: NOW - 3_600_000, to: null });
  assert.deepEqual(rangeForPreset('today', NOW), { from: startOfDay(NOW), to: null });
  assert.equal(rangeForPreset('7d', NOW).from, NOW - 7 * 86_400_000);
  assert.deepEqual(rangeForPreset('all', NOW), { from: null, to: null });
});

test('formatClock uses 24-hour time', () => {
  assert.equal(formatClock(at(2026, 10, 21, 14, 32), 'en-US'), '14:32');
});

test('parseLocalDateTime', () => {
  assert.equal(parseLocalDateTime('2026-10-21T14:32'), at(2026, 10, 21, 14, 32));
  assert.equal(parseLocalDateTime(''), null);
  assert.equal(parseLocalDateTime('garbage'), null);
});
