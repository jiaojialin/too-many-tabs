# Too Many Tabs

A Chrome extension (Manifest V3) that recycles tabs: it automatically closes idle tabs and tabs that are unlikely to be revisited soon, so your tab strip stays manageable and Chrome uses less RAM and CPU.

> Built with Spec Driven Development: this README is the source of truth for behavior.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the `extension/` folder.
3. Optional: in the extension's **Settings**, click **Allow pausing media** so background audio is paused instead of muted.

Requires Chrome 121 or later.

## Using it

- **Popup** (toolbar icon): the most recently closed tabs with **Reopen**, a "Let this site keep playing" toggle for the current site, and buttons for **History** and **Settings**.
- **History page**: browse, filter, reopen, delete and export everything the extension closed (see below).
- **Settings page**: thresholds (30 min / 24 h by default), logged-out site rules, background-audio options and the keep-playing list.
- On first install every open tab starts its timers at the install time, so nothing is closed straight away.

## Definitions

- **Last visited**: the most recent time the tab was the active tab in a focused window. Tracked from `tabs.onActivated` / `windows.onFocusChanged`, falling back to `tab.lastAccessed`.
- **Active window**: the currently focused normal browser window.
- **Normalized URL**: the URL after:
  1. dropping the `#fragment`,
  2. lower-casing the scheme and host and removing a trailing `/` from the path,
  3. removing known tracking parameters (`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`, `si`, `igshid`, ...),
  4. sorting the remaining query parameters.

  All other query parameters are significant, e.g. `youtube.com/watch?v=a` vs `?v=b`, `google.com/search?q=cats` vs `?q=dogs`, and different Amazon items are **different** pages.

## Global exemptions (apply to every rule)

The extension never auto-closes:

- pinned tabs,
- audible tabs (playing sound),
- any tab in the active window,
- any incognito tab (incognito is ignored entirely).

## Rules

### Rule 1: Logged-out tabs

Detect tabs whose site has signed the user out due to inactivity (common on banking/finance sites such as Chase and Fidelity), and close them **30 minutes after they were last visited** (configurable).

Detection signals (no extra host permissions required):

- **URL transition**: the tab navigates (including SPA hash/history changes reported by `tabs.onUpdated`) to a login/logout/timeout URL, e.g. paths or params containing `logon`, `login`, `signin`, `logout`, `logoff`, `timeout`, `session-expired`, `sessionTimeout`. Strongest when the tab moved there on its own while not being viewed.
- **Title change**: the title changes to text such as "Sign In", "Log On", "Session Expired", "Timed Out", "You have been logged off/signed out".
- **Site rules**: a built-in, user-editable list of site-specific patterns (Chase, Fidelity, ...), complementing the generic patterns.

Behavior:

- Checks run every minute (`chrome.alarms`), so a tab closes within ~1 minute after the threshold.
- If logout is detected after the threshold has already passed, the tab closes at the next check.
- Visiting the tab again resets the timer; navigating away from the login/timeout page clears the logged-out flag.

### Rule 2: Duplicate tabs

Tabs whose **normalized URLs** are equal are duplicates. Keep only the **most recently visited** one and close the others.

- A tab in the active window counts as the most recently visited (it is being visited), so it always survives; duplicates in other windows are closed.
- Duplicates that are all inside the active window are not closed (global exemption).
- Pinned/audible duplicates are never closed.

### Rule 3: Stale tabs

Close any tab that has not been visited for **24 hours** (configurable).

- Measured in wall-clock time since last visited, so time while the computer sleeps counts.
- Tabs already discarded (unloaded) by Chrome are included.
- After a browser restart, restored tabs keep their stored last-visited time when it can be matched (by URL and position); otherwise the restore time is used, so tabs are never closed on startup just because their history was lost.

## Background audio pausing

When the user switches to a **different tab in Chrome** while a non-selected tab is playing sound, the extension pauses that tab's playback.

- **Trigger**: a tab is `audible` and is not the active tab in the last-focused Chrome window. Chrome losing focus to another application does **not** trigger pausing.
- **Delay**: pause after a **2 second** grace period (configurable), so quick tab switching doesn't stutter playback. If the tab becomes active again within the delay, nothing happens.
- **Pause**: inject a script (`chrome.scripting.executeScript`, all frames) that calls `.pause()` on every playing `<video>`/`<audio>` element and marks those elements as paused by the extension.
- **Fallback mute**: if the tab is still audible shortly after the pause attempt (Web Audio, custom players, sites that auto-resume, or the script could not be injected), mute the tab with `chrome.tabs.update({ muted: true })`.
- **Resume**: when the tab becomes active again, resume only the media the extension paused, and unmute only if the extension muted it. Media the user paused stays paused.
- **Keep-playing list**: a user-editable list of sites (by host) that are never paused, with a one-click "Let this site keep playing" toggle in the popup.
- **Permissions**: pausing needs host permission for all sites; it is an **optional** permission, requested when the user turns the feature on (or clicks **Allow pausing media**) in Settings. The feature is on by default, and without that permission the extension falls back to muting.
- Incognito tabs are ignored.

Interaction with closing rules: the "audible tabs are never closed" exemption effectively protects tabs on the keep-playing list (they keep playing); tabs paused/muted by this feature are no longer treated as audible (Chrome may still report a muted tab as `audible`, so tabs muted by the extension are explicitly not exempt) and become subject to the closing rules again.

## Closed-tab history (persistent database)

Every tab auto-closed by the extension is recorded in a local **IndexedDB** database (works directly in the MV3 service worker; `unlimitedStorage` permission so size is not a concern). Data never leaves the machine.

Each record stores:

| Field | Description |
|---|---|
| `id` | auto-increment key |
| `url` | full URL at close time |
| `normalizedUrl` | normalized URL (see Definitions) |
| `title` | tab title |
| `domain` | host name |
| `favIconUrl` | favicon URL, if any |
| `reason` | `logged-out` \| `duplicate` \| `stale` |
| `closedAt` | timestamp when closed |
| `lastVisitedAt` | timestamp the tab was last visited |
| `windowId`, `groupId`, `index` | where the tab was |

Indexes: `closedAt`, `domain`, `reason`, `url`.

### History page

A full extension page (opened from the popup's "History" button) for reviewing and browsing everything the extension closed, organized by when it was closed:

- **Timeline view**: closed tabs sorted by close time (newest first, toggle to oldest first), grouped under date headers ("Today", "Yesterday", then e.g. "Mon, Oct 19, 2026"). Each row shows favicon, title, domain, reason badge, and the exact local close time (e.g. `14:32`); hovering shows the full date/time and last-visited time.
- **Date/time filter**: quick ranges (last hour, today, last 7 days, last 30 days, all) plus a custom from/to date-time picker.
- **Other filters**: free-text search (title/URL), domain, and reason; filters combine with the date range.
- **Paging**: loads incrementally (infinite scroll), backed by the `closedAt` index, so large histories stay fast.
- One click reopens a tab (and the popup shows the most recent closures with a quick "reopen").
- Records can be deleted individually or cleared all at once.

### Export

The history page exports all (or the currently filtered) records as:

- **JSON**,
- **CSV**,
- **SQLite** (`.sqlite` file generated on demand with a bundled sql.js, table `closed_tabs` with the columns above).

Note: Chrome deletes extension data when the extension is uninstalled; export to keep a copy.

## Design: how checking works

The extension combines **events** (react immediately to what Chrome reports) with a **periodic sweep** (catch time-based thresholds). No hourly batch jobs.

### Event-driven tracking

| Event | Action |
|---|---|
| `tabs.onActivated`, `windows.onFocusChanged` | update last-visited for the tab being left and the tab being entered; start/cancel audio-pause timers; re-run the duplicate check (the active window changed) |
| `tabs.onUpdated` (url, title) | recompute normalized URL; run logged-out detection on the URL/title transition; run the duplicate check when loading completes |
| `tabs.onUpdated` (audible) | start the 2 s audio-pause timer if the tab isn't selected |
| `tabs.onCreated` / `onRemoved` / `onReplaced` | add / drop / re-key tab state |
| `runtime.onStartup` | re-match restored tabs to stored state by URL + position |

- The active tab of the active window counts as being visited continuously; its last-visited time is updated when you leave it.
- **Active window** = the last-focused normal Chrome window. It stays the active window when Chrome loses focus to another app.

### Deadline-driven sweep

Instead of polling on a fixed interval, the extension schedules the next sweep for the moment something actually becomes due.

- After every sweep, and after any event that changes state (a visit, a logout detected or cleared, a tab created or removed, a settings change), compute `nextDeadline(tabs, state, settings, now)`. This is the earliest time any non-exempt tab reaches a closing threshold:
  - logged-out tab: `lastVisitedAt + 30 min`,
  - any tab: `lastVisitedAt + 24 h`.
- Set a single `chrome.alarms` alarm (`sweep`) for that time, replacing the previous one. Chrome enforces a 30-second minimum delay, so deadlines in the past or less than 30 seconds away are swept immediately instead.
- When there is no deadline (nothing can become closable), no `sweep` alarm is set.
- **Backstop**: a separate repeating alarm (`backstop`) runs a sweep every **10 minutes** in case a scheduled alarm is lost.
- Alarms persist across service-worker restarts and fire after the computer wakes, so overdue tabs are handled promptly.

### Per-tab state

Stored in `chrome.storage.local` so it survives service-worker restarts and browser restarts:

`tabId → { url, normalizedUrl, lastVisitedAt, loggedOutSince, pausedByUs, mutedByUs, windowId, index }`

### Sweep algorithm

```
now = Date.now()
tabs = all tabs in normal (non-incognito) windows
activeWindow = last-focused normal window

exempt(tab) = tab.pinned
           or (tab.audible and not tab.mutedByUs)
           or tab.windowId == activeWindow
           or tab.incognito

for each tab not exempt:
  idle = now - lastVisitedAt(tab)
  if loggedOutSince(tab) and idle >= 30 min  -> close(tab, "logged-out")
  else if idle >= 24 h                        -> close(tab, "stale")

for each group of tabs sharing a normalizedUrl (size > 1):
  winner = the tab in the active window if there is one,
           otherwise the tab with the latest lastVisitedAt
  for each other tab in the group, if not exempt -> close(tab, "duplicate")
```

The duplicate check also runs immediately on navigation and focus events, using the same function. Each sweep ends by rescheduling the `sweep` alarm with `nextDeadline`.

`close(tab, reason)` writes the record to IndexedDB first, then calls `chrome.tabs.remove`. If removal fails, the record is deleted, so the history only contains tabs that were actually closed.

### Testability

All decision logic lives in pure functions with no dependency on Chrome APIs, for example `decide(tabs, state, settings, now) → actions`, `nextDeadline`, `normalizeUrl`, `isLoggedOutTransition` and `pickDuplicateWinner`. They are unit-tested with Vitest. The Chrome-API glue is thin and tested with mocked `chrome.*` APIs.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | read tab URLs and titles (duplicates, logged-out detection, history) |
| `alarms` | deadline-driven and backstop sweeps |
| `storage`, `unlimitedStorage` | settings, per-tab state and the closed-tab database |
| `scripting` + optional `<all_urls>` | pause/resume media in background tabs |

## Development

```
npm install
npm test          # unit tests (node --test)
npm run vendor    # re-copy sql.js into extension/vendor after upgrading it
```

Layout:

- `extension/manifest.json`, `extension/background.js`: MV3 service worker entry point.
- `extension/lib/`: logic. `rules.js` (closing rules, `nextDeadline`), `logout.js`, `url.js`, `audio.js`, `tabState.js`, `settings.js`, `db.js` (IndexedDB), `export.js`, `timeline.js`, and `controller.js` (wires Chrome events to the rules).
- `extension/popup/`, `extension/history/`, `extension/options/`, `extension/ui/`: pages.
- `extension/vendor/`: bundled sql.js (WASM) for SQLite export.
- `test/`: unit tests; `test/helpers/fakeChrome.js` fakes the `chrome.*` APIs.
