// Minimal in-memory stand-in for the chrome.* APIs the controller uses.

function storageArea() {
  const data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
  };
}

export function createFakeChrome({ tabs = [], focusedWindowId = 1, hostAccess = false } = {}) {
  const state = {
    tabs: tabs.map((t) => ({ active: false, pinned: false, audible: false, incognito: false, ...t })),
    focusedWindowId,
    hostAccess,
    alarms: new Map(),
    removed: [],
    updates: [],
    scripts: [],
    failRemove: new Set(),
    scriptResult: 1,
  };
  const chrome = {
    _state: state,
    runtime: { id: 'test-extension-id' },
    storage: { sync: storageArea(), local: storageArea(), session: storageArea() },
    windows: {
      WINDOW_ID_NONE: -1,
      // Window 99 stands in for an incognito window.
      async getAll() {
        if (state.failGetAll) throw new Error('windows unavailable');
        return structuredClone(state.windows ?? []);
      },
      async getLastFocused() {
        return { id: state.focusedWindowId, incognito: state.focusedWindowId === 99, type: 'normal' };
      },
    },
    tabs: {
      async query() {
        return state.tabs.map((t) => structuredClone(t));
      },
      async remove(id) {
        if (state.failRemove.has(id)) throw new Error('cannot close');
        state.tabs = state.tabs.filter((t) => t.id !== id);
        state.removed.push(id);
      },
      async update(id, props) {
        state.updates.push([id, props]);
        const tab = state.tabs.find((t) => t.id === id);
        if ('muted' in props) {
          tab.mutedInfo = props.muted
            ? { muted: true, reason: 'extension', extensionId: 'test-extension-id' }
            : { muted: false };
        }
      },
    },
    alarms: {
      async create(name, info) {
        state.alarms.set(name, info);
      },
      async clear(name) {
        state.alarms.delete(name);
      },
      async get(name) {
        return state.alarms.get(name);
      },
    },
    permissions: {
      async contains() {
        return state.hostAccess;
      },
    },
    scripting: {
      async executeScript({ target, func }) {
        state.scripts.push([target.tabId, func.name]);
        return [{ result: state.scriptResult }];
      },
    },
  };
  return chrome;
}

export function createFakeHistory() {
  const records = [];
  let nextId = 1;
  return {
    records,
    failAdd: false,
    async add(record) {
      if (this.failAdd) throw new Error('db down');
      const id = nextId++;
      records.push({ id, ...record });
      return id;
    },
    async delete(id) {
      const i = records.findIndex((r) => r.id === id);
      if (i >= 0) records.splice(i, 1);
    },
  };
}

// Manual timers so tests control when setTimeout callbacks run.
export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) await fn();
    },
  };
}
