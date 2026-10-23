import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  cleanHost,
  formatSiteRules,
  mergeSettings,
  parseHostList,
  parseSiteRules,
  toggleHost,
} from '../extension/lib/settings.js';

test('mergeSettings fills defaults and rejects invalid values', () => {
  assert.deepEqual(mergeSettings(undefined), { ...DEFAULT_SETTINGS });
  const merged = mergeSettings({ loggedOutMinutes: -1, staleHours: 12, audioPauseEnabled: 'yes', siteRules: [{ host: 'x.test', pattern: '(' }] });
  assert.equal(merged.loggedOutMinutes, 30);
  assert.equal(merged.staleHours, 12);
  assert.equal(merged.audioPauseEnabled, true);
  assert.deepEqual(merged.siteRules, []);
});

test('cleanHost and parseHostList', () => {
  assert.equal(cleanHost(' https://Music.YouTube.com:443/watch?v=1 '), 'music.youtube.com');
  assert.deepEqual(parseHostList('open.spotify.com\n\nhttps://open.spotify.com/x\nradio.test'), ['open.spotify.com', 'radio.test']);
});

test('parseSiteRules parses lines and reports bad ones', () => {
  const { rules, errors } = parseSiteRules('# comment\nchase.com logon|timeout\nbad.test (\nnohost');
  assert.deepEqual(rules, [{ host: 'chase.com', pattern: 'logon|timeout' }]);
  assert.equal(errors.length, 2);
  assert.equal(formatSiteRules(rules), 'chase.com logon|timeout');
});

test('toggleHost adds and removes without duplicates', () => {
  assert.deepEqual(toggleHost(['a.test'], 'a.test', true), ['a.test']);
  assert.deepEqual(toggleHost(['a.test', 'b.test'], 'a.test', false), ['b.test']);
  assert.deepEqual(toggleHost(['youtube.com', 'b.test'], 'music.youtube.com', false), ['b.test'], 'removes covering patterns');
});

test('mergeSettings drops the removed tab limit', () => {
  assert.equal('tabLimit' in mergeSettings({ tabLimit: 12 }), false);
});

test('mergeSettings caps the audio pause delay', () => {
  assert.equal(mergeSettings({ audioPauseDelaySeconds: 120 }).audioPauseDelaySeconds, 25);
});

test('mergeSettings: search results idle time defaults to 60 minutes', () => {
  assert.equal(mergeSettings({}).searchIdleMinutes, 60);
  assert.equal(mergeSettings({ searchIdleMinutes: 15 }).searchIdleMinutes, 15);
  assert.equal(mergeSettings({ searchIdleMinutes: 0 }).searchIdleMinutes, 60);
});
