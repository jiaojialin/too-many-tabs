// Service worker entry point. Listeners are registered synchronously at the
// top level so Chrome can wake the worker for them.

import { createController } from './lib/controller.js';
import { createHistoryDb } from './lib/db.js';
import { SETTINGS_KEY } from './lib/settings.js';

const controller = createController({ chrome, history: createHistoryDb() });
const refresh = () => controller.request();

chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
chrome.alarms.onAlarm.addListener(refresh);

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onCreated.addListener(refresh);
chrome.tabs.onRemoved.addListener(refresh);
chrome.tabs.onReplaced.addListener(controller.onTabReplaced);
chrome.tabs.onAttached.addListener(refresh);
chrome.tabs.onDetached.addListener(refresh);
chrome.tabs.onUpdated.addListener(controller.onTabUpdated);
chrome.windows.onFocusChanged.addListener(controller.onFocusChanged);
// Entering or leaving full screen changes which tabs are protected.
chrome.windows.onBoundsChanged.addListener(refresh);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && SETTINGS_KEY in changes) refresh();
});
