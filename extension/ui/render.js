// Small DOM helpers shared by the popup and history pages.

import { REASON_LABELS } from '../lib/timeline.js';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// Only show favicons we can load safely from an extension page.
export function favicon(record) {
  const src = /^(https:|data:image\/)/.test(record.favIconUrl ?? '') ? record.favIconUrl : null;
  return src ? el('img', { class: 'favicon', src, alt: '' }) : el('span', { class: 'favicon' });
}

export function reasonBadge(reason) {
  return el('span', { class: `badge ${reason}` }, REASON_LABELS[reason] ?? reason);
}

// Only these schemes are rendered as clickable links.
export function isLinkable(url) {
  return /^(https?|file|ftp):/i.test(url ?? '');
}

// Reopens a closed tab. Some URLs (e.g. certain chrome:// pages) can't be
// opened by an extension; report that instead of failing silently.
export async function reopen(url) {
  try {
    await chrome.tabs.create({ url });
  } catch (error) {
    alert(`Could not reopen ${url}: ${error.message}`);
  }
}
