## Changelog

### V1.5 (Current) - Performance & URLhaus Fix

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
