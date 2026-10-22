// IndexedDB store of every tab the extension auto-closed.

import { endOfDay, narrowRange, startOfDay } from './timeline.js';

export const DB_NAME = 'too-many-tabs';
export const DB_VERSION = 1;
export const STORE = 'closedTabs';
const INDEXES = ['closedAt', 'domain', 'reason', 'url'];

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(idb) {
  const request = idb.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    for (const name of INDEXES) store.createIndex(name, name);
  };
  return promisify(request);
}

function matchesFilters(record, { text, domain, reason }) {
  if (domain && record.domain !== domain) return false;
  if (reason && record.reason !== reason) return false;
  if (text) {
    const needle = text.toLowerCase();
    const haystack = `${record.title ?? ''}\n${record.url ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

// `idb` and `keyRange` default to the browser globals; tests pass fakes.
export function createHistoryDb(idb = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange) {
  let dbPromise = null;
  const db = () => (dbPromise ??= openDb(idb));

  async function store(mode) {
    return (await db()).transaction(STORE, mode).objectStore(STORE);
  }

  return {
    async add(record) {
      const { id, ...rest } = record;
      return promisify((await store('readwrite')).add(rest));
    },

    async get(id) {
      return promisify((await store('readonly')).get(id));
    },

    async delete(id) {
      await promisify((await store('readwrite')).delete(id));
    },

    async clear() {
      await promisify((await store('readwrite')).clear());
    },

    // Pages through records by close time. `after` is the `next` cursor from
    // the previous page. Pass limit: Infinity to fetch everything.
    async query({ from = null, to = null, text = '', domain = '', reason = '', order = 'desc', limit = 50, after = null } = {}) {
      if (from !== null && to !== null && from > to) return { records: [], next: null };
      const index = (await store('readonly')).index('closedAt');
      const range = keyRange.bound(from ?? -Infinity, to ?? Infinity);
      const desc = order === 'desc';
      const records = [];
      await new Promise((resolve, reject) => {
        const request = index.openCursor(range, desc ? 'prev' : 'next');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || records.length >= limit) return resolve();
          const record = cursor.value;
          const beforeCursor =
            after &&
            (desc
              ? record.closedAt > after.closedAt || (record.closedAt === after.closedAt && record.id >= after.id)
              : record.closedAt < after.closedAt || (record.closedAt === after.closedAt && record.id <= after.id));
          if (!beforeCursor && matchesFilters(record, { text, domain, reason })) records.push(record);
          cursor.continue();
        };
      });
      const last = records[records.length - 1];
      const next = records.length >= limit && last ? { closedAt: last.closedAt, id: last.id } : null;
      return { records, next };
    },

    // The nearest local day with matching records before ('older') or after
    // ('newer') `day`, or the most recent such day ('latest'); null if none.
    // `filters` are query() filters (from, to, text, domain, reason).
    async nearestDay(day, direction, filters = {}) {
      let range = { from: filters.from ?? null, to: filters.to ?? null };
      if (direction === 'older') range = narrowRange(range, -Infinity, day - 1);
      if (direction === 'newer') range = narrowRange(range, endOfDay(day) + 1, Infinity);
      const order = direction === 'newer' ? 'asc' : 'desc';
      const { records } = await this.query({ ...filters, ...range, order, limit: 1 });
      return records.length ? startOfDay(records[0].closedAt) : null;
    },

    // One page of the history: a day's matching records (in `filters.order`)
    // and the neighbouring days that have any. `day` null means the most
    // recent day; a day with no matching records falls back to the next older
    // day, then the next newer one. `day` is null when nothing matches.
    async dayPage(day, filters = {}) {
      const target = day ?? (await this.nearestDay(null, 'latest', filters));
      if (target === null) return { day: null, records: [], newer: null, older: null };
      const { records } = await this.query({ ...filters, ...narrowRange(filters, target, endOfDay(target)), limit: Infinity });
      if (!records.length) {
        const fallback = (await this.nearestDay(target, 'older', filters)) ?? (await this.nearestDay(target, 'newer', filters));
        return fallback === null ? { day: null, records: [], newer: null, older: null } : this.dayPage(fallback, filters);
      }
      const [newer, older] = await Promise.all([
        this.nearestDay(target, 'newer', filters),
        this.nearestDay(target, 'older', filters),
      ]);
      return { day: target, records, newer, older };
    },

    async domains() {
      const index = (await store('readonly')).index('domain');
      const domains = [];
      await new Promise((resolve, reject) => {
        const request = index.openKeyCursor(null, 'nextunique');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          if (cursor.key) domains.push(cursor.key);
          cursor.continue();
        };
      });
      return domains;
    },
  };
}

export function recordFromTab(tab, { reason, closedAt, lastVisitedAt, normalizedUrl, domain }) {
  return {
    url: tab.url ?? '',
    normalizedUrl: normalizedUrl ?? null,
    title: tab.title ?? '',
    domain: domain ?? '',
    favIconUrl: tab.favIconUrl ?? null,
    reason,
    closedAt,
    lastVisitedAt,
    windowId: tab.windowId,
    groupId: tab.groupId ?? -1,
    index: tab.index,
  };
}
