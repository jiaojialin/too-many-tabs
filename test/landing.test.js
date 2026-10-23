import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LANDING_PAGES, isGoogleSearchResults, isLandingPage } from '../extension/lib/landing.js';
import { parsePatternList } from '../extension/lib/settings.js';

const landing = (url, patterns = DEFAULT_LANDING_PAGES) => isLandingPage(url, patterns);

test('empty pages and search engine home pages are landing pages', () => {
  for (const url of [
    'chrome://newtab/',
    'chrome://new-tab-page/',
    'about:blank',
    'https://www.google.com/',
    'https://google.com',
    'https://www.google.co.uk/?hl=en',
    'https://www.google.com.au/',
    'https://www.google.com/webhp',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
    'https://search.yahoo.com/',
    'https://www.baidu.com/',
  ]) {
    assert.ok(landing(url), url);
  }
});

test('searches and other pages are not landing pages', () => {
  for (const url of [
    'https://www.google.com/search?q=cats',
    'https://www.google.com/#q=cats',
    'https://duckduckgo.com/?q=cats',
    'https://www.bing.com/search?q=cats',
    'https://www.baidu.com/s?wd=cats',
    'https://search.yahoo.com/search?p=cats',
    'https://mail.google.com/',
    'https://www.google.com/maps',
    'https://www.nytimes.com/',
    'https://copilot.bing.com/',
    'chrome://settings/',
    'not a url',
  ]) {
    assert.ok(!landing(url), url);
  }
});

test('custom patterns: host, host/path, *.host and full URLs', () => {
  assert.ok(landing('https://www.nytimes.com/', ['nytimes.com']));
  assert.ok(!landing('https://www.nytimes.com/section/world', ['nytimes.com']));
  assert.ok(landing('https://example.com/start/', ['example.com/start']));
  assert.ok(landing('https://intranet.corp.test/', ['*.corp.test']));
  assert.ok(!landing('https://intranet.corp.test/', ['corp.test']));
  assert.ok(landing('chrome://newtab', ['CHROME://NEWTAB/']));
});

test('parsePatternList trims, lower-cases, dedupes and skips comments', () => {
  assert.deepEqual(parsePatternList('# start pages\nNYTimes.com\n\n nytimes.com \nabout:blank'), ['nytimes.com', 'about:blank']);
});

test('isGoogleSearchResults: google.com/search with a query', () => {
  for (const url of [
    'https://www.google.com/search?q=cats',
    'https://www.google.com/search?q=cats&sca_esv=1&source=hp',
    'https://www.google.com/search?sca_esv=1&q=cats',
    'https://google.com/search?q=cats',
  ]) {
    assert.ok(isGoogleSearchResults(url), url);
  }
  for (const url of [
    'https://www.google.com/',
    'https://www.google.com/search?q=',
    'https://www.google.com/maps/search/cats',
    'https://www.google.com/searchx?q=cats',
    'https://docs.google.com/search?q=cats',
    'http://www.google.com/search?q=cats',
    'https://www.bing.com/search?q=cats',
    'not a url',
  ]) {
    assert.ok(!isGoogleSearchResults(url), url);
  }
});
