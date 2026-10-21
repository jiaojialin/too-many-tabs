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

export function reopen(url) {
  return chrome.tabs.create({ url });
}
