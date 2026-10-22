import { createHistoryDb } from '../lib/db.js';
import { exportFilename, toCsv, toJson, toSqlite } from '../lib/export.js';
import { dayLabel, formatClock, formatFull, parseLocalDateTime, rangeForPreset, startOfDay } from '../lib/timeline.js';
import { el, favicon, isLinkable, reasonBadge, reopen } from '../ui/render.js';

const PAGE_SIZE = 100;
const history = createHistoryDb();
const $ = (id) => document.getElementById(id);

let order = 'desc';
let cursor = null;
let exhausted = false;
let loading = false;
let generation = 0;
let lastDay = null;
let currentList = null;

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

// Drops a deleted row, its day section if that is now empty, and refreshes
// the empty-state message and domain filter.
function removeRow(node) {
  const section = node.closest('.day');
  node.remove();
  if (section && !section.querySelector('.row')) {
    if (section.lastElementChild === currentList) {
      lastDay = null;
      currentList = null;
    }
    section.remove();
  }
  $('empty').hidden = $('timeline').childElementCount > 0 || !exhausted;
  renderDomains();
  if (!exhausted && isSentinelVisible()) loadMore();
}

function append(records) {
  const now = Date.now();
  for (const record of records) {
    const day = startOfDay(record.closedAt);
    if (day !== lastDay) {
      lastDay = day;
      currentList = el('div');
      $('timeline').append(el('section', { class: 'day' }, el('h2', {}, dayLabel(record.closedAt, now)), currentList));
    }
    currentList.append(row(record));
  }
}

async function loadMore() {
  if (loading || exhausted) return;
  loading = true;
  const gen = generation;
  try {
    const page = await history.query({ ...filters(), limit: PAGE_SIZE, after: cursor });
    if (gen === generation) {
      append(page.records);
      cursor = page.next;
      exhausted = !page.next;
      $('empty').hidden = $('timeline').childElementCount > 0;
    }
  } finally {
    loading = false;
  }
  // Filters changed while this page was loading: start over for the new ones.
  if (gen !== generation) return loadMore();
  if (!exhausted && isSentinelVisible()) loadMore();
}

function isSentinelVisible() {
  return $('sentinel').getBoundingClientRect().top < window.innerHeight + 200;
}

function reset() {
  generation++;
  cursor = null;
  exhausted = false;
  lastDay = null;
  currentList = null;
  $('timeline').replaceChildren();
  loadMore();
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

new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) loadMore();
}, { rootMargin: '200px' }).observe($('sentinel'));

renderDomains();
reset();
