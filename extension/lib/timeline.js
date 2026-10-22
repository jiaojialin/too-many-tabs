// Date helpers for the history timeline. All dates are local time.

const DAY = 24 * 60 * 60 * 1000;

export const REASON_LABELS = {
  'logged-out': 'Logged out',
  duplicate: 'Duplicate',
  stale: 'Stale',
  empty: 'Unused',
};

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Last millisecond of the local day containing `ts`. Adding 36 hours always
// lands in the next day, even across a daylight-saving change.
export function endOfDay(ts) {
  return startOfDay(startOfDay(ts) + 36 * 60 * 60 * 1000) - 1;
}

// Intersects a { from, to } filter range (either end may be null) with
// [from, to].
export function narrowRange(range, from, to) {
  return {
    from: range.from === null || range.from === undefined ? from : Math.max(range.from, from),
    to: range.to === null || range.to === undefined ? to : Math.min(range.to, to),
  };
}

// The line under a day's heading: "12 tabs closed so far today" for today,
// "34 tabs closed yesterday" / "... on Mon, Oct 19, 2026" for past days.
// `filtered` says the count only includes records matching the filters.
export function dayCountText(count, day, now, { filtered = false, locale } = {}) {
  const tabs = `${count} ${filtered ? 'matching ' : ''}${count === 1 ? 'tab' : 'tabs'}`;
  const label = dayLabel(day, now, locale);
  if (label === 'Today') return `${tabs} closed so far today`;
  if (label === 'Yesterday') return `${tabs} closed yesterday`;
  return `${tabs} closed on ${label}`;
}

export function dayLabel(ts, now, locale) {
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day === today) return 'Today';
  if (day === startOfDay(today - 1)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Groups records (already sorted) into [{ key, label, records }] by local day,
// keeping their order.
export function groupByDay(records, now, locale) {
  const groups = [];
  for (const record of records) {
    const key = startOfDay(record.closedAt);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(record.closedAt, now, locale), records: [] };
      groups.push(group);
    }
    group.records.push(record);
  }
  return groups;
}

export const PRESETS = ['hour', 'today', '7d', '30d', 'all'];

export function rangeForPreset(preset, now) {
  switch (preset) {
    case 'hour':
      return { from: now - 60 * 60 * 1000, to: null };
    case 'today':
      return { from: startOfDay(now), to: null };
    case '7d':
      return { from: now - 7 * DAY, to: null };
    case '30d':
      return { from: now - 30 * DAY, to: null };
    default:
      return { from: null, to: null };
  }
}

export function formatClock(ts, locale) {
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatFull(ts, locale) {
  return new Date(ts).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'medium' });
}

// Value of an <input type="datetime-local"> -> epoch ms, or null if empty.
// The input has minute precision, so an upper bound covers the whole minute
// (a "To 14:32" filter includes tabs closed at 14:32:45).
export function parseLocalDateTime(value, { endOfMinute = false } = {}) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return null;
  return endOfMinute ? ts + 59_999 : ts;
}
