import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  formatSiteRules,
  mergeSettings,
  parseHostList,
  parsePatternList,
  parseSiteRules,
} from '../lib/settings.js';

const ALL_URLS = { origins: ['<all_urls>'] };
const $ = (id) => document.getElementById(id);
const NUMBER_FIELDS = ['searchIdleMinutes', 'loggedOutMinutes', 'landingIdleMinutes', 'staleHours', 'audioPauseDelaySeconds'];

function fill(settings) {
  for (const id of NUMBER_FIELDS) $(id).value = settings[id];
  $('audioPauseEnabled').checked = settings.audioPauseEnabled;
  $('keepPlayingHosts').value = settings.keepPlayingHosts.join('\n');
  $('siteRules').value = formatSiteRules(settings.siteRules);
  $('landingPages').value = settings.landingPages.join('\n');
}

function showStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').className = isError ? 'error' : 'muted';
}

async function renderPermission() {
  const granted = await chrome.permissions.contains(ALL_URLS);
  $('permission-status').textContent = granted
    ? 'Media can be paused on all sites.'
    : 'Without site access, background tabs are muted instead of paused.';
  $('grant').hidden = granted;
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { rules, errors } = parseSiteRules($('siteRules').value);
  if (errors.length) return showStatus(errors.join('; '), true);
  const settings = mergeSettings({
    ...Object.fromEntries(NUMBER_FIELDS.map((id) => [id, Number($(id).value)])),
    audioPauseEnabled: $('audioPauseEnabled').checked,
    keepPlayingHosts: parseHostList($('keepPlayingHosts').value),
    siteRules: rules,
    landingPages: parsePatternList($('landingPages').value),
  });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  fill(settings);
  showStatus('Saved.');
});

$('reset').addEventListener('click', async () => {
  const settings = mergeSettings(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  fill(settings);
  showStatus('Defaults restored.');
});

// Must run from the click itself: permission prompts need a user gesture.
$('grant').addEventListener('click', async () => {
  await chrome.permissions.request(ALL_URLS);
  renderPermission();
});

$('audioPauseEnabled').addEventListener('change', async () => {
  // Request straight from the gesture (no await first); it resolves without
  // a prompt if access was already granted.
  if ($('audioPauseEnabled').checked) {
    await chrome.permissions.request(ALL_URLS);
    renderPermission();
  }
});

const stored = await chrome.storage.sync.get(SETTINGS_KEY);
fill(mergeSettings(stored[SETTINGS_KEY]));
renderPermission();
