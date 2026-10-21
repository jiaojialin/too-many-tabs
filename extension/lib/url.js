// URL helpers: normalization for duplicate detection and host matching.

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid',
  'mc_cid', 'mc_eid', 'ref', 'ref_src', 'si', 'igshid', '_hsenc', '_hsmi', 'mkt_tok',
]);

export function isTrackingParam(name) {
  const key = name.toLowerCase();
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
}

// Returns the normalized form of a URL (see README "Definitions"), or null if
// the URL can't be parsed. Scheme and host are lower-cased by URL itself.
export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const params = [...url.searchParams].filter(([name]) => !isTrackingParam(name));
  params.sort(([a, av], [b, bv]) => compare(a, b) || compare(av, bv));
  const query = params.length ? `?${new URLSearchParams(params)}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}${query}`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function hostOf(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

// Approximate registrable domain: "secure.chase.com" -> "chase.com",
// "www.bbc.co.uk" -> "bbc.co.uk". Good enough to tell "same site" apart.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

export function siteOf(host) {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export function sameSite(urlA, urlB) {
  const a = hostOf(urlA);
  const b = hostOf(urlB);
  return a !== '' && siteOf(a) === siteOf(b);
}

// True when `host` is `pattern` or a subdomain of it ("*." prefix allowed).
export function hostMatches(host, pattern) {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  return p !== '' && (h === p || h.endsWith(`.${p}`));
}

export function isWebUrl(raw) {
  return /^(https?|file):/i.test(raw ?? '');
}
