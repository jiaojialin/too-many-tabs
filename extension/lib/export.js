// Export closed-tab history as JSON, CSV or a SQLite database file.

export const COLUMNS = [
  'id', 'url', 'normalizedUrl', 'title', 'domain', 'favIconUrl', 'reason',
  'closedAt', 'lastVisitedAt', 'windowId', 'groupId', 'index',
];

const SQL_TYPES = {
  id: 'INTEGER PRIMARY KEY',
  url: 'TEXT NOT NULL',
  closedAt: 'INTEGER NOT NULL',
  lastVisitedAt: 'INTEGER',
  windowId: 'INTEGER',
  groupId: 'INTEGER',
  index: 'INTEGER',
};

function pick(record) {
  return COLUMNS.map((column) => record[column] ?? null);
}

export function toJson(records) {
  return JSON.stringify(records.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null]))), null, 2);
}

// Quotes fields that need it, and defuses values a spreadsheet would treat
// as formulas.
export function csvField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(records) {
  const lines = [COLUMNS.join(','), ...records.map((r) => pick(r).map(csvField).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

// `SQL` is the initialized sql.js module. Returns the database file bytes.
export function toSqlite(SQL, records) {
  const db = new SQL.Database();
  try {
    const columns = COLUMNS.map((c) => `"${c}" ${SQL_TYPES[c] ?? 'TEXT'}`).join(', ');
    db.run(`CREATE TABLE closed_tabs (${columns})`);
    db.run('CREATE INDEX closed_tabs_closedAt ON closed_tabs ("closedAt")');
    const placeholders = COLUMNS.map(() => '?').join(', ');
    const names = COLUMNS.map((c) => `"${c}"`).join(', ');
    const insert = db.prepare(`INSERT INTO closed_tabs (${names}) VALUES (${placeholders})`);
    db.run('BEGIN');
    for (const record of records) insert.run(pick(record));
    db.run('COMMIT');
    insert.free();
    return db.export();
  } finally {
    db.close();
  }
}

export function exportFilename(extension, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `too-many-tabs-history-${stamp}.${extension}`;
}
