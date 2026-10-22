import { createHistoryDb } from '../lib/db.js';
import { exportFilename, toCsv, toJson, toSqlite } from '../lib/export.js';
import { dayCountText, dayLabel, endOfDay, formatClock, formatFull, narrowRange, parseLocalDateTime, rangeForPreset, startOfDay } from '../lib/timeline.js';
import { el, favicon, isLinkable, reasonBadge, reopen } from '../ui/render.js';

const history = createHistoryDb();
const $ = (id) => document.getElementById(id);

// The page shows one day at a time (README "History page").
let order = 'desc';
let generation = 0;
let currentDay = null;
let olderDay = null;
let newerDay = null;

function filters() {
  const preset = $('preset').value;
  const range =
    preset === 'custom'
      ? { from: parseLocalDateTime($('from').value), to: parseLocalDateTime($('to').value, { endOfMinute: true }) }
      : rangeForPreset(preset, Date.now());
  return {
    ...range,
    text: $('text').value.trim(),
    domain: $('domain').value,
    reason: $('reason').value,
    order,
  };
}

function row(record) {
  const visited = record.lastVisitedAt ? `\nLast visited ${formatFull(record.lastVisitedAt)}` : '';
  const node = el(
    'div',
    { class: 'row', title: `Closed ${formatFull(record.closedAt)}${visited}` },
    favicon(record),
    el(
      'span',
      { class: 'title' },
      el(
        'a',
        {
          href: isLinkable(record.url) ? record.url : '#',
          title: record.url,
          onclick: (event) => {
            event.preventDefault();
            reopen(record.url);
          },
        },
        record.title || record.url,
      ),
    ),
    el('span', { class: 'domain' }, record.domain),
    reasonBadge(record.reason),
    el('time', { class: 'time', datetime: new Date(record.closedAt).toISOString() }, formatClock(record.closedAt)),
    el('button', { onclick: () => reopen(record.url) }, 'Reopen'),
    el(
      'button',
      {
        class: 'danger',
        title: 'Delete from history',
        onclick: async () => {
          await history.delete(record.id);
          removeRow(node);
        },
      },
      'Delete',
    ),
  );
  return node;
}

// After a delete, refresh the day (its count, or another day if it is now empty).
function removeRow(node) {
  node.remove();
  renderDomains();
  show(currentDay);
}

function isFiltered(f) {
  return Boolean(f.text || f.domain || f.reason);
}

// The nearest day with matching records before ('older') or after ('newer')
// `day`, or the most recent one ('latest'); null if there is none.
async function findDay(day, direction) {
  const f = filters();
  let range = { from: f.from, to: f.to };
  if (direction === 'older') range = narrowRange(range, -Infinity, day - 1);
  if (direction === 'newer') range = narrowRange(range, endOfDay(day) + 1, Infinity);
  if (range.from !== null && range.to !== null && range.from > range.to) return null;
  const { records } = await history.query({ ...f, ...range, order: direction === 'newer' ? 'asc' : 'desc', limit: 1 });
  return records.length ? startOfDay(records[0].closedAt) : null;
}

// Shows `day` (start of a local day). If it has no matching records any more,
// falls back to the next older day, then the next newer one.
async function show(day) {
  const gen = ++generation;
  const f = filters();
  let records = [];
  if (day !== null) {
    ({ records } = await history.query({ ...f, ...narrowRange(f, day, endOfDay(day)), limit: Infinity }));
  }
  if (day !== null && !records.length) {
    const fallback = (await findDay(day, 'older')) ?? (await findDay(day, 'newer'));
    if (gen === generation) show(fallback);
    return;
  }
  const [newer, older] = day === null ? [null, null] : await Promise.all([findDay(day, 'newer'), findDay(day, 'older')]);
  if (gen !== generation) return;
  currentDay = day;
  newerDay = newer;
  olderDay = older;
  render(records, f);
}

function render(records, f) {
  const now = Date.now();
  $('day-nav').hidden = currentDay === null;
  $('empty').hidden = currentDay !== null;
  $('newer').disabled = newerDay === null;
  $('older').disabled = olderDay === null;
  $('newer').title = newerDay === null ? '' : dayLabel(newerDay, now);
  $('older').title = olderDay === null ? '' : dayLabel(olderDay, now);
  $('day-label').textContent = currentDay === null ? '' : dayLabel(currentDay, now);
  $('day-count').textContent =
    currentDay === null ? '' : dayCountText(records.length, currentDay, now, { filtered: isFiltered(f) });
  $('timeline').replaceChildren(...records.map(row));
}

// Filters changed: jump to the most recent day that matches them.
async function reset() {
  const gen = ++generation;
  const day = await findDay(null, 'latest');
  if (gen === generation) show(day);
}

async function renderDomains() {
  const select = $('domain');
  const selected = select.value;
  const domains = await history.domains();
  select.replaceChildren(el('option', { value: '' }, 'All'), ...domains.map((d) => el('option', { value: d }, d)));
  select.value = domains.includes(selected) ? selected : '';
}

function download(data, type, extension) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = el('a', { href: url, download: exportFilename(extension) });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let sqlPromise = null;
function loadSql() {
  sqlPromise ??= new Promise((resolve, reject) => {
    const script = el('script', { src: '../vendor/sql-wasm.js' });
    script.onload = () => resolve(globalThis.initSqlJs({ locateFile: (file) => `../vendor/${file}` }));
    script.onerror = () => reject(new Error('Could not load sql.js'));
    document.head.append(script);
  });
  return sqlPromise;
}

async function exportRecords(format) {
  const { records } = await history.query({ ...filters(), limit: Infinity });
  if (format === 'json') download(toJson(records), 'application/json', 'json');
  else if (format === 'csv') download(toCsv(records), 'text/csv', 'csv');
  else download(toSqlite(await loadSql(), records), 'application/vnd.sqlite3', 'sqlite');
}

$('preset').addEventListener('change', () => {
  $('custom-range').hidden = $('preset').value !== 'custom';
  reset();
});
for (const id of ['from', 'to', 'domain', 'reason']) $(id).addEventListener('change', reset);
let searchTimer = null;
$('text').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reset, 200);
});
$('order').addEventListener('click', () => {
  order = order === 'desc' ? 'asc' : 'desc';
  $('order').textContent = order === 'desc' ? 'Newest first' : 'Oldest first';
  reset();
});
$('filters').addEventListener('submit', (event) => event.preventDefault());

for (const button of document.querySelectorAll('[data-export]')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await exportRecords(button.dataset.export);
    } catch (error) {
      alert(`Export failed: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
}

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete the entire closed-tab history? This cannot be undone.')) return;
  await history.clear();
  await renderDomains();
  reset();
});

$('newer').addEventListener('click', () => newerDay !== null && show(newerDay));
$('older').addEventListener('click', () => olderDay !== null && show(olderDay));

// Coming back to the page: pick up tabs closed meanwhile (e.g. today's count).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) (currentDay === null || currentDay === startOfDay(Date.now()) ? reset() : show(currentDay));
});

renderDomains();
reset();
