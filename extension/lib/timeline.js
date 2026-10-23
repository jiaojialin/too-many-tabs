// Date and grouping helpers for the history timeline. All dates are local time.

import { siteOf } from './url.js';

const DAY = 24 * 60 * 60 * 1000;

export const REASON_LABELS = {
  'logged-out': 'Logged out',
  duplicate: 'Duplicate',
  stale: 'Stale',
  empty: 'Unused',
  search: 'Search',
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

// Whether a { from, to } filter range cuts off part of the local `day`.
export function isDayClipped(range, day) {
  return (range.from != null && range.from > day) || (range.to != null && range.to < endOfDay(day));
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

// The group a closed tab is listed under: its site (registrable domain, so
// www.google.com and myhealth.stanfordhealthcare.org group by google.com and
// stanfordhealthcare.org), or the scheme for pages without a host
// ("about:", "file:").
export function siteGroup(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname ? siteOf(parsed.hostname) : parsed.protocol;
  } catch {
    return url;
  }
}

// Friendly names for well-known products, checked in order: [host, path
// prefix or null, name]. Hosts are compared without "www.".
const KNOWN_PRODUCTS = [
  ['google.com', '/search', 'Google Search'],
  ['google.com', '/maps', 'Google Maps'],
  ['docs.google.com', '/document', 'Google Docs'],
  ['docs.google.com', '/spreadsheets', 'Google Sheets'],
  ['docs.google.com', '/presentation', 'Google Slides'],
  ['docs.google.com', '/forms', 'Google Forms'],
  ['docs.google.com', null, 'Google Docs'],
  ['mail.google.com', null, 'Gmail'],
  ['calendar.google.com', null, 'Google Calendar'],
  ['drive.google.com', null, 'Google Drive'],
  ['meet.google.com', null, 'Google Meet'],
  ['photos.google.com', null, 'Google Photos'],
  ['maps.google.com', null, 'Google Maps'],
];

// The subgroup a closed tab is listed under within its site group: a known
// product name (e.g. "Gmail", "Google Search"), otherwise its host without
// "www." (e.g. "myhealth.stanfordhealthcare.org").
export function subgroupOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.hostname) return parsed.protocol;
  const host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname;
  for (const [knownHost, prefix, name] of KNOWN_PRODUCTS) {
    if (host !== knownHost) continue;
    if (prefix === null || path === prefix || path.startsWith(`${prefix}/`)) return name;
  }
  return host;
}

const newestFirst = (a, b) => b.closedAt - a.closedAt || (b.id ?? 0) - (a.id ?? 0);
const byName = ([a], [b]) => a.localeCompare(b);

function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record.url ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups].sort(byName);
}

// Groups a day's records by site, and each site by product/host when it has
// more than one (two levels at most): groups and subgroups sorted by name
// (A to Z), records most recently closed first. `subgroups` is null for a
// site whose records all fall in one subgroup.
export function groupBySite(records) {
  return groupBy(records, siteGroup).map(([site, list]) => {
    const subgroups = groupBy(list, subgroupOf).map(([name, items]) => ({ name, records: items.sort(newestFirst) }));
    return { site, records: list.sort(newestFirst), subgroups: subgroups.length > 1 ? subgroups : null };
  });
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
