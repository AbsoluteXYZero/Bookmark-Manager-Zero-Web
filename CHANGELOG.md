## Changelog

### V1.9.0 (Current) - Quick Access & Recently Opened

**New Features:**
- **Quick Access** - Pin the bookmarks you use most to a section at the top of the list. Right-click any bookmark and choose "Add to Quick Access", or drag one onto the section. Pinned entries are mirrors, not copies: the same bookmark, shown in a second place. Delete the bookmark from its real folder and the pin disappears with it. Removing a pin only unpins it and never touches the underlying bookmark, so there is no way to destroy a bookmark from the Quick Access section.
- **Drag to reorder Quick Access** - Arrange your pins in whatever order you like by dragging them within the section. Pins cannot be dragged out into your real folders, so reordering can never move or rearrange the actual bookmarks.
- **Recently Opened** - The last 5 bookmarks you opened from BMZ, so getting back to something takes one click. Opening the same bookmark twice in a row moves it to the top instead of adding a second row. This list stays on this device and is never synced.
- **Shared collapsible row** - Quick Access and Recently Opened share a single row split in two and behave as an accordion, so opening one closes the other and neither eats space when you are not using it. Your choice is remembered between sessions.
- **Display toggles** - Both sections can be shown or hidden independently from the Display Options button in the toolbar, and the setting is remembered. Hiding one gives the other the full width.
- **Quick Access syncs across devices** - Your pins travel with your GitLab snippet and arrive on every device using it, including the browser extensions. They are stored in a separate file inside the snippet, so versions of BMZ that do not yet support Quick Access cannot erase them, and pins made on two devices merge rather than overwrite. Unpinning on one device propagates instead of being resurrected by the other.

**Bug Fixes:**
- **HaGeZi TIF blocklist restored** - This source had stopped loading entirely, reporting HTTP 403. Two unrelated breakages happened at once: the jsDelivr CDN began refusing every file in the list's repository once the repository outgrew its 150 MB limit, and the project separately reorganised its folders so the old path no longer existed. Now loaded from GitHub directly using the current path. All ten blocklist sources were checked and the rest were unaffected.
- **Browser-internal bookmarks no longer show as phantom sync changes** - A bookmark such as `about:debugging` was reported as changed on every single pull, forever, even when nothing had changed. Chrome rewrites browser-internal addresses when it saves them, so the same bookmark ends up written slightly differently in each browser. BMZ was correctly noticing the difference and wrongly presenting the browser's own edit as yours. Sync now recognises these as the same bookmark, and nothing is rewritten or overwritten.
- **Merge dialog no longer appears when bookmarks already match** - Connecting to a snippet last written by a different browser always prompted you to choose a merge strategy, even with identical bookmarks. The check compared an exact fingerprint of the whole collection, and because Firefox names its toolbar folder "Bookmarks Toolbar" where Chrome names it "Bookmarks bar", that fingerprint could never match across browsers. BMZ now falls back to a real comparison and connects quietly when there is genuinely nothing to reconcile.
- **Scan results now update every copy of a bookmark** - With a bookmark visible in both the list and Quick Access, only the first copy on the page received link and safety results. The other stayed on a stale icon until the next redraw.

---

### V1.8.0 - Share to BMZ (Android)

**New Features:**
- **Share a link straight into BMZ (Android app)** - Sharing a page from any mobile browser now offers "Save to BMZ" in the Android share sheet. It opens a small floating window over the browser rather than launching the full app, so a link can be filed without leaving what you were reading. Saving no longer means waiting for a bookmark to travel through a browser account sync to a desktop before BMZ ever sees it.
- **Recently saved-to folders** - The Add Bookmark dialog now defaults to the folder you last saved a bookmark into, with up to five other recent folders offered as one-tap chips underneath. Only folders you actually saved or moved a bookmark into are counted; simply browsing a folder does not affect the list. Applies to the normal Add Bookmark dialog as well as the share window.
- **Duplicate warning without a popup** - The share window shows an inline note under the URL when the page is already bookmarked, with a button to reveal the full folder path of every existing copy. The old blocking confirm dialog still applies everywhere else.

**Sync:**
- **Share saves sync immediately** - When GitLab sync is configured, the share window pulls the latest bookmarks before writing and pushes the new bookmark straight afterwards, so it reaches your other devices without waiting for the next app launch. Pulling first matters: the phone usually holds the stalest copy, and pushing from a stale copy would overwrite changes made elsewhere.
- **Every stage reports its own failure** - If the pull, the save, or the push fails, the window says which stage failed and why (offline, GitLab unreachable, expired token, missing snippet, rate limit) and offers a retry. A failed pull additionally offers to save on this device only. A bookmark that saves but fails to push stays flagged as pending and syncs on the next launch.
- **Stale window protection** - After a share saves a bookmark, the main app window reloads its bookmark tree when reopened, so it cannot save its pre-share copy over the top of what was just added.

**Changes:**
- **No scanning during a share** - Link checking and safety checking are disabled entirely in the share window, including the usual scan of a newly added bookmark. Filing a link stays a quick write with no burst of network requests behind it.

---

### V1.6.0 - Sync Fixes & Cleanup

**New Features:**
- **Scan Intensity Slider** - New slider in Settings controls how many bookmarks are link/safety-checked at once (1-20, default 5). Each check is a live request that triggers a DNS lookup, so scanning a large library all at once could briefly overwhelm a local DNS resolver (AdGuard Home, Pi-hole) and knock out your internet. Lowering this keeps scans gentle on your network. Persists across sessions and applies live to an in-progress scan.
- **Request Jitter Slider** - New slider in Settings adds a small random delay (0-500ms) before each scan request, spreading DNS lookups across time instead of firing them as one burst. Raise it, alongside lowering Scan Intensity, if scans still disrupt your connection.

**Performance:**
- **DNS-Friendly Scanning** - Lowered the default cap on simultaneous scan requests so scanning a large library no longer risks overwhelming a local DNS resolver (AdGuard Home, Pi-hole) and dropping your connection.

**Bug Fixes:**
- **Stop Scan Reliability** - Hardened scan cancellation: the stop button reliably halts the scan, the worker-less fallback scan path now honors Stop, and overlapping scans triggered by expanding several folders no longer stomp each other's progress or flicker the stop button off.
- **Scan Status Returns to "Ready"** - After stopping a scan, the status bar settles back to "Ready" instead of sticking on "Scan stopped" (including the fallback scan path).
- **Settings Slider Handle** - Added proper slider-handle styling for Chromium browsers and the Android WebView so the handle renders centered on the track instead of missing or sitting too low.
- **Folder Count Position (Android app)** - The bookmark count inside a folder icon sat too high in the Android app because it was centered in the icon's square bounding box rather than the folder body (the folder shape's top-left tab pushes the body lower), an offset exaggerated by the WebView's font metrics. The number is now nudged into the folder body in the Android app only; desktop browsers and the extensions were already correct and are unchanged. Also added reliable Android-app detection (the app overrides its user agent, so the standard WebView check did not apply).
- **Manual sync now works when versions match** - "Sync from Cloud to Browser" and "Sync from Browser to Cloud" previously did nothing when the local and remote version numbers were equal but the bookmarks actually differed — the sync silently reported "up to date." Both buttons now force the operation: cloud-to-browser pulls and reconciles, browser-to-cloud pushes, regardless of version.
- **Header buttons no longer overlap the title** - On the Android app, with an enlarged device font the GitLab, sync, logout, and settings buttons could cover the right end of the title and subtitle. The buttons now occupy their own reserved space and the title and subtitle scale down to fit the remaining width on a single line, clear of the buttons at any width and after signing in. (Scaling uses a CSS transform because the WebView ignores small font sizes when the device font is enlarged.)

**Improvements:**
- **Divergence detection on auto-sync** - When versions match but the cloud and local bookmarks differ, auto-sync now surfaces a one-time notice ("Cloud differs from this device — open GitLab sync to reconcile") instead of falsely reporting everything is in sync.

**Changes:**
- **Removed per-sync "Merge" option** - The sync conflict dialog no longer offers a "Merge" button, and the unused bidirectional-merge code was removed. A union merge can't honor deletions — deleted bookmarks get re-added from the other side — so sync decisions are now explicit: Keep Local or Use Snippet. The one-time merge when first connecting a snippet is unchanged.

---

### V1.5 - Performance & URLhaus Fix

**Performance:**
- **Lazy-loaded Services** - Blocklist and Scanner services now initialize on first use, not at startup
- **Faster Startup** - Removed blocking init calls from showMainApp()

**URLhaus Fix:**
- **Direct GitHub Import** - URLhaus Active list now fetched from dedicated GitHub repo (AbsoluteXYZero/urlhaus-list) instead of CORS-proxied URLhaus API

---

### V1.4.1 - Mobile UX Improvements

**New Features:**
- **Pull-to-Refresh** - On mobile, drag down from above the search bar to reload the page. A pull indicator fades in showing progress and prompts to release when the threshold is reached.
- **Local Mode Default** - The first-time setup screen now defaults to Local Mode instead of GitLab Sync.

**Bug Fixes:**
- **Cache Busting** - Added `_headers` config for Cloudflare Pages to prevent browsers from serving stale JS files after updates.

---

### V1.4.0 - Multi-Select Bulk Open

**New Features:**
- **Long-Press to Multi-Select** - Click and hold any bookmark or folder for 750ms to enter multi-select mode. The held item is automatically added to the selection. Drag-and-drop is fully preserved — moving the mouse during the hold cancels the timer and initiates a drag as normal.
- **Open in New Tabs** - New bulk action button. Due to browser popup restrictions on web pages, shows a modal listing all selected bookmarks as individually clickable links. Use the Chrome or Firefox extension to open all at once automatically.
- **Open in New Windows** - New bulk action button. Shows an informational toast directing users to the Chrome or Firefox extension, where this feature is fully supported.

---

### V1.3.1 - Bug Fixes

**Bug Fixes:**
- **Android WebView Edge False Positive** - Fixed the "Browser Not Supported" Edge incompatibility warning incorrectly appearing inside the Android app. Devices with Microsoft Edge set as their system WebView provider caused the user agent to contain `EdgA`, triggering the block. The detection now correctly exempts Android WebViews.

---

### V1.3.0 - Context Menu Redesign

**New Features:**
- **Replace Remote Snippet with Local** - New option in the sync setup dialog when connecting a GitLab snippet. Overwrites the remote snippet with your current local bookmarks, in addition to the existing Keep Local, Merge, and Replace Local with Remote Snippet options.

**Improvements:**
- **Drag-and-Drop Reliability** - Overhauled drop zone logic. Each item now acts as a single unified drop target (top half = insert before, bottom half = insert after) replacing the previous three competing zones per gap. Folder headers additionally support drop-into on the bottom half. Fixed an index offset bug that caused items to land one position too far down when reordering within the same folder.
- **Context Menu Redesign** - Right-click and hamburger menus now open as a slide-in panel from the right edge of the sidebar instead of a fragile absolute-positioned popup. Eliminates clipping, size inconsistencies, and overlap issues. Click outside or press Escape to dismiss.

---

### V1.2.0 - Move To, Keyboard Shortcuts & Drag Improvements

**New Features:**
- **Move to... Context Menu** - Right-click any bookmark or folder and select "Move to..." to relocate it via a modal folder picker
  - Folder dropdown with optional alphabetical sorting
  - Prevents moving folders into themselves or their descendants
  - Protects built-in root folders
  - Full changelog integration with undo/restore support
- **Keyboard Shortcut: Ctrl+Click** - Open bookmarks in a new tab
- **Keyboard Shortcut: Shift+Click** - Open bookmarks in a new window
- **Multi-Select Click Anywhere** - In multi-select mode, clicking anywhere on a bookmark or folder toggles its selection (no longer requires clicking the small checkbox)

**Improvements:**
- **Drag-and-Drop Auto-Scroll** - Dragging a bookmark near the top or bottom edge of the list now auto-scrolls at a speed proportional to cursor proximity
- **Sync Success Visual Feedback** - Manual sync button now shows spinning arrows during sync and green arrows for 5 seconds on success, replacing success toasts. Error toasts are preserved.

**Bug Fixes**
- **Fixed "allBookmarks is not defined"** - Resolved error in bulk recheck and bulk move functions by properly fetching the bookmark tree before use

---

### V1.1.0

**Fixed**
- **Auto-Scan Timing Issue**: Fixed folder expansion auto-scan getting stuck at "Scanning 0/X" when folder is expanded before scanner worker is initialized. Now waits for worker initialization before starting scan.
- **Blocklist Download Status Bar**: Fixed status bar getting stuck on "Downloading blocklists..." if download fails. Now always dispatches completion event via `finally` block.
- **CORS Proxy Reliability**: URLVoid scraping now uses parallel proxy racing with Promise.any() - first successful response wins
- **CORS Proxy Timeout**: Increased timeout from 5s to 15s to allow slower proxies to respond
- **Clear Cache Button**: Fixed settings menu "Clear Cache" button not working - now properly clears IndexedDB cache store
- **Badge Updates**: Fixed status badge updates during folder expansion scans for both list and grid view modes
- **DOM Updates**: Fixed updateBookmarkStatusInDOM to correctly update both `.status-indicators` (list view) and `.bookmark-top-row` (grid view) containers

**Added**
- **Multiple CORS Proxy Fallbacks**: Added 3 parallel CORS proxies for URLVoid scraping:
  - corsproxy.io (primary)
  - api.allorigins.win (fallback)
  - api.codetabs.com (fallback)
- **Colored Detection Output**: URLVoid detection counts now display with color coding in console:
  - Blue (#4dabf7) for 0 detections (safe)
  - Red (#ff6b6b) for 1+ detections (warning/unsafe)

**Changed**
- **Console Logging Cleanup**: Removed extensive debug console.log statements throughout the codebase for cleaner production output. Retained only essential logs:
  - Error messages
  - URLVoid detection results (with colored output)
  - Blocklist matches for unsafe URLs
  - Cache load completion status

**Technical Details**
- URLVoid scraping uses AbortController for proper timeout handling
- Promise.any() ensures fastest proxy response is used while others are cancelled
- IndexedDB cache clearing now uses `dbManager.clear('cache')` directly instead of non-existent scanner service method

---

## V1.0.0 - Initial Release

**Features:**
- GitLab Snippet sync for cross-device bookmark synchronization
- Local mode for offline-only usage
- Link status checking (alive/dead detection)
- Safety checking via:
  - Local blocklist database (~1.35M domains)
  - URLVoid web scraping
  - Google Safe Browsing API (optional)
  - Yandex Safe Browsing API (optional)
  - VirusTotal API (optional)
- Grid and list view modes
- Dark/light theme support
- Folder-based organization
- Search and filter functionality
- Import/export capabilities
- QR code generation for bookmarks
- Keyboard navigation support
- Touch gesture support for mobile
