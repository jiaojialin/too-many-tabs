// IndexedDB store of every tab the extension auto-closed.

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
