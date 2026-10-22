import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayCountText, dayLabel, endOfDay, formatClock, isDayClipped, narrowRange, parseLocalDateTime, rangeForPreset, startOfDay } from '../extension/lib/timeline.js';

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 21, 15, 0);

test('dayLabel: Today, Yesterday, then a full date', () => {
  assert.equal(dayLabel(at(2026, 10, 21, 0, 5), NOW, 'en-US'), 'Today');
  assert.equal(dayLabel(at(2026, 10, 20, 23, 59), NOW, 'en-US'), 'Yesterday');
  assert.equal(dayLabel(at(2026, 10, 19), NOW, 'en-US'), 'Mon, Oct 19, 2026');
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
  assert.equal(parseLocalDateTime('2026-10-21T14:32', { endOfMinute: true }), at(2026, 10, 21, 14, 32) + 59_999);
});

test('endOfDay is the last millisecond of the local day, across DST changes too', () => {
  assert.equal(endOfDay(at(2026, 10, 21, 9)), at(2026, 10, 22, 0) - 1);
  // US DST ends Nov 1, 2026 and starts Mar 8, 2026 (25- and 23-hour days where observed).
  assert.equal(endOfDay(at(2026, 11, 1, 12)), new Date(2026, 10, 2).getTime() - 1);
  assert.equal(endOfDay(at(2026, 3, 8, 12)), new Date(2026, 2, 9).getTime() - 1);
});

test('narrowRange intersects a filter range with a day', () => {
  assert.deepEqual(narrowRange({ from: null, to: null }, 10, 20), { from: 10, to: 20 });
  assert.deepEqual(narrowRange({ from: 15, to: null }, 10, 20), { from: 15, to: 20 });
  assert.deepEqual(narrowRange({ from: 5, to: 12 }, 10, 20), { from: 10, to: 12 });
});

test('dayCountText: so far today, closed on past days', () => {
  assert.equal(dayCountText(12, at(2026, 10, 21, 0), NOW, { locale: 'en-US' }), '12 tabs closed so far today');
  assert.equal(dayCountText(1, at(2026, 10, 20, 0), NOW, { locale: 'en-US' }), '1 tab closed yesterday');
  assert.equal(dayCountText(34, at(2026, 10, 19, 0), NOW, { locale: 'en-US' }), '34 tabs closed on Mon, Oct 19, 2026');
  assert.equal(dayCountText(3, at(2026, 10, 21, 0), NOW, { filtered: true, locale: 'en-US' }), '3 matching tabs closed so far today');
});

test('isDayClipped: a range that cuts off part of the day', () => {
  const day = at(2026, 10, 21, 0);
  assert.equal(isDayClipped({ from: null, to: null }, day), false);
  assert.equal(isDayClipped({ from: day - 1, to: null }, day), false);
  assert.equal(isDayClipped({ from: day + 1, to: null }, day), true);
  assert.equal(isDayClipped({ from: null, to: endOfDay(day) - 1 }, day), true);
});
