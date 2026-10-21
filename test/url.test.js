import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostMatches, isTrackingParam, normalizeUrl, sameSite, siteOf } from '../extension/lib/url.js';

test('normalizeUrl drops fragment, trailing slash and case differences in scheme/host', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Path/#section'), 'https://example.com/Path');
  assert.equal(normalizeUrl('https://example.com/'), normalizeUrl('https://example.com'));
});

test('normalizeUrl removes tracking parameters and sorts the rest', () => {
  assert.equal(
    normalizeUrl('https://a.com/x?utm_source=n&b=2&fbclid=z&a=1&UTM_Medium=m&ref=tw'),
    'https://a.com/x?a=1&b=2',
  );
  assert.equal(normalizeUrl('https://a.com/x?b=2&a=1'), normalizeUrl('https://a.com/x?a=1&b=2'));
});

test('normalizeUrl keeps meaningful parameters distinct', () => {
  assert.notEqual(normalizeUrl('https://www.youtube.com/watch?v=a'), normalizeUrl('https://www.youtube.com/watch?v=b'));
  assert.notEqual(normalizeUrl('https://www.google.com/search?q=cats'), normalizeUrl('https://www.google.com/search?q=dogs'));
  assert.notEqual(normalizeUrl('https://www.amazon.com/dp/B01'), normalizeUrl('https://www.amazon.com/dp/B02'));
  assert.equal(
    normalizeUrl('https://www.youtube.com/watch?v=a&si=share'),
    normalizeUrl('https://www.youtube.com/watch?v=a#t=10'),
  );
});

test('normalizeUrl returns null for unparseable input', () => {
  assert.equal(normalizeUrl('not a url'), null);
});

test('isTrackingParam', () => {
  assert.ok(isTrackingParam('utm_campaign'));
  assert.ok(isTrackingParam('GCLID'));
  assert.ok(!isTrackingParam('q'));
});

test('siteOf and sameSite', () => {
  assert.equal(siteOf('secure.chase.com'), 'chase.com');
  assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.ok(sameSite('https://secure.chase.com/a', 'https://www.chase.com/logon'));
  assert.ok(!sameSite('https://chase.com/', 'https://fidelity.com/'));
  assert.ok(!sameSite('chrome://newtab', 'chrome://settings'));
});

test('hostMatches matches the host and subdomains only', () => {
  assert.ok(hostMatches('music.youtube.com', 'youtube.com'));
  assert.ok(hostMatches('youtube.com', '*.youtube.com'));
  assert.ok(!hostMatches('notyoutube.com', 'youtube.com'));
  assert.ok(!hostMatches('youtube.com', ''));
});
