// Bookmark Manager Zero - Web Adapted Script
// Adapted from sidebar.js to work with GitLab Snippet storage

// Import our web modules
import dbManager from './storage/indexeddb.js';
import authManager from './auth/auth-manager.js';
import syncManager from './storage/sync-manager.js';
import bookmarkManager from './core/bookmarks.js';
import blocklistService from './core/blocklist-service.js';
/* [ZeroLabs] 2026-08-18 12:32 AM - added: direct adapter import for quick access meta */
import snippetAdapter from './storage/snippet-adapter.js';
import storageAdapter from './storage/storage-adapter.js';
import scannerService from './core/scanner.js';
import { parseHTMLBookmarks } from './import-export/html-parser.js';
import { parseJSONBookmarks } from './import-export/json-parser.js';
import { encryptApiKey, decryptApiKey } from './utils/encryption.js';
import {
  initErrorToast,
  showErrorToast,
  hideErrorToast,
  logError,
  setupGlobalErrorHandlers
} from './utils/error-notification-manager.js';
/* [ZeroLabs] 2026-08-09 1:31 PM - edited: import recent folder MRU helpers */
import {
  safeLocalStorage,
  storeEncryptedApiKey,
  getDecryptedApiKey,
  addChangelogEntry,
  getChangelogEntries,
  clearChangelog,
  getRecentFolders,
  recordRecentFolder
} from './utils/storage-utils.js';
import {
  loadTheme,
  applyTheme,
  applyCustomAccentColor,
  setupFolderChildrenObserver,
  updateTintControlsVisibility,
  applyTintSettings,
  loadTintSettings,
  setTheme,
  loadView,
  applyView,
  setView,
  loadZoom,
  applyZoom,
  setZoom,
  updateZoomDisplay,
  loadFontSize,
  applyFontSize,
  setFontSize,
  updateFontSizeDisplay,
  loadGuiScale,
  applyGuiScale,
  loadStartFolder,
  populateStartFolderDropdown,
  expandToStartFolder
} from './utils/theme-settings-manager.js';

// ============================================================================
// BROWSER API COMPATIBILITY LAYER
// ============================================================================
// Create a browser object that maps extension APIs to our web equivalents
const browser = {
  runtime: {
    /* [ZeroLabs] 2026-08-27 11:52 AM - edited: bump version to 2.1 */
    getManifest: () => ({ version: '2.1' }),
    getURL: (path) => path,
    sendMessage: async (message) => {
      // Web version doesn't have background scripts
      // Return appropriate responses for different message types
      console.log('[Browser API] runtime.sendMessage called with:', message);

      switch (message.action) {
        case 'getBackgroundScanStatus':
          return { isScanning: false, progress: 0, total: 0 };

        case 'startBackgroundScan':
          return { success: false, message: 'Background scanning not available in web version' };

        case 'stopBackgroundScan':
          return { success: true };

        case 'ensureBlocklistReady':
          // Use the actual blocklist service
          return await blocklistService.ensureBlocklistReady();

        // NOTE: Removed dead code - 'checkLinkStatus' and 'checkURLSafety' handlers
        // These were never called and used broken no-cors fetch mode
        // All scanning now happens via scanner service and Web Worker

        default:
          console.warn('[Browser API] Unhandled sendMessage action:', message.action);
          return {};
      }
    },
    onMessage: { addListener: () => {} }
  },
  bookmarks: {
    get: (id) => Promise.resolve([bookmarkManager.getBookmark(id)]),
    getTree: () => Promise.resolve([bookmarkManager.getTree()]),
    getChildren: (id) => Promise.resolve(bookmarkManager.getChildren(id)),
    create: (details) => bookmarkManager.create(details),
    update: (id, changes) => bookmarkManager.update(id, changes),
    move: (id, destination) => bookmarkManager.move(id, destination),
    remove: (id) => bookmarkManager.remove(id),
    search: (query) => {
      // Handle both string and object formats
      const searchString = typeof query === 'string' ? query : (query.query || query.url || '');
      return Promise.resolve(bookmarkManager.search(searchString));
    },
    /* [ZeroLabs] 2026-08-27 - edited: real events instead of stubs (see also: Bookmark-Manager-Zero-Chrome/background.js) */
    // These were no-ops, which is why the website could never tell an addition
    // it made from one another device deleted, and so could never sync anything
    // safely on its own. bookmarkManager now emits on every mutation with the
    // same payload shapes chrome.bookmarks uses, so anything ported from the
    // extensions works here unchanged.
    onCreated: { addListener: (fn) => bookmarkManager.addListener('created', fn) },
    onRemoved: { addListener: (fn) => bookmarkManager.addListener('removed', fn) },
    onChanged: { addListener: (fn) => bookmarkManager.addListener('changed', fn) },
    onMoved: { addListener: (fn) => bookmarkManager.addListener('moved', fn) }
  },
  storage: {
    local: storageAdapter
  },
  tabs: {
    create: (details) => {
      window.open(details.url, details.active === false ? '_blank' : '_blank');
      return Promise.resolve();
    },
    query: () => Promise.resolve([{ id: 1 }]),
    update: () => Promise.resolve(),
    sendMessage: () => Promise.resolve()
  },
  windows: {
    getCurrent: () => Promise.resolve({ id: 1 })
  },
  extension: {
    getURL: (path) => path
  }
};

// ============================================================================
// VERSION
// ============================================================================
const APP_VERSION = browser.runtime.getManifest().version;

/* [ZeroLabs] 2026-06-20 6:31 PM - added: re-fit header text to the space left by the (login-state-dependent) buttons */
/* [ZeroLabs] 2026-06-20 - scale rendered pixels (transform) to fit text beside the buttons;
   transform bypasses the Android WebView minimum-font-size clamp that ignores small font-sizes. */
function fitHeaderText() {
  const MARGIN = 8;                                   // px of clearance to keep from the buttons
  ['.logo-title', '.logo-subtitle'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.transformOrigin = 'left center';
    el.style.transform = '';                          // reset before measuring natural width
    const box = el.clientWidth - MARGIN;              // target width (leave clearance from buttons)
    const range = document.createRange();
    range.selectNodeContents(el);
    const w = range.getBoundingClientRect().width;    // rendered text width (font-clamp baked in)
    if (w > box && box > 0) {
      el.style.transform = 'scale(' + Math.max(0.3, box / w) + ')';
    }
  });
}
window.fitHeaderText = fitHeaderText;

function initHeaderFit() {
  requestAnimationFrame(fitHeaderText);
  // Observe the BUTTON cluster: its width changes when GitLab login swaps the buttons
  // (login -> sync + logout). .header-top stays full-width so observing it wouldn't fire.
  const cluster = document.querySelector('.header-settings');
  if (cluster && window.ResizeObserver && !cluster.dataset.fitObserved) {
    cluster.dataset.fitObserved = '1';
    new ResizeObserver(() => requestAnimationFrame(fitHeaderText)).observe(cluster);
  }
  // Re-fit when the title/subtitle text changes (e.g. the version string is injected after load)
  ['.logo-title', '.logo-subtitle'].forEach((sel) => {
    const t = document.querySelector(sel);
    if (t && window.MutationObserver && !t.dataset.fitTextObserved) {
      t.dataset.fitTextObserved = '1';
      new MutationObserver(() => requestAnimationFrame(fitHeaderText)).observe(t, { childList: true, characterData: true, subtree: true });
    }
  });
  if (!window._headerFitResize) {
    window._headerFitResize = true;
    window.addEventListener('resize', () => requestAnimationFrame(fitHeaderText));
  }
}
window.initHeaderFit = initHeaderFit;

// Run once the DOM is ready; the ResizeObserver above then re-fits automatically
// whenever the button cluster changes width (e.g. GitLab login swaps login -> sync+logout).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeaderFit);
} else {
  initHeaderFit();
}
window.addEventListener('load', () => requestAnimationFrame(fitHeaderText));

// ============================================================================
// FIRST-TIME SETUP CARD
// ============================================================================
let hasSeenSetupCard = true; // Default to true, will be loaded from storage

// Load setup card flag from storage
async function loadSetupCardFlag() {
  try {
    const result = await safeStorage.get('hasSeenSetupCard');
    hasSeenSetupCard = result.hasSeenSetupCard || false;
  } catch (error) {
    console.error('Error loading setup card flag:', error);
    hasSeenSetupCard = false;
  }
}

// Mark setup card as seen
async function dismissSetupCard() {
  hasSeenSetupCard = true;
  try {
    await safeStorage.set({ hasSeenSetupCard: true });
    renderBookmarks(); // Re-render to remove the card
  } catch (error) {
    console.error('Error saving setup card flag:', error);
  }
}

// ============================================================================
// SUPABASE SYNC ANNOUNCEMENT CARD
// ============================================================================
/* [ZeroLabs] 2026-08-27 - edited: repurposed from the Supabase announcement */
// One reusable "what's new" card rather than a new one per release. The storage
// key carries the DATE, so writing the next announcement means changing the key
// with it and the card reappears for everyone - including people who dismissed
// the last one. A date also avoids a version number, which differs between the
// extensions and the website anyway.
const LATEST_CARD_KEY = 'bmz_latest_card_20260827';
let hasSeenLatestCard = true;

async function loadLatestCardFlag() {
  try {
    const result = await safeStorage.get(LATEST_CARD_KEY);
    hasSeenLatestCard = result[LATEST_CARD_KEY] || false;
  } catch (error) {
    hasSeenLatestCard = false;
  }
}

async function dismissLatestCard() {
  hasSeenLatestCard = true;
  try {
    await safeStorage.set({ [LATEST_CARD_KEY]: true });
    renderBookmarks();
  } catch (error) {
    console.error('Error saving latest card flag:', error);
  }
}

// ============================================================================
// GLOBAL ERROR BOUNDARY
// ============================================================================

// Initialize error toast and set up global error handlers
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initErrorToast();
    setupGlobalErrorHandlers();
  });
} else {
  initErrorToast();
  setupGlobalErrorHandlers();
}

// ============================================================================
// PRIVATE BROWSING MODE DETECTION & HANDLING
// ============================================================================

// Detect if we're in private/incognito mode
// Website version: always false (no private browsing detection available)
const isPrivateMode = false;

// Session-only storage for private mode (cleared when window closes)
const privateSessionStorage = new Map();

// Privacy-respecting storage wrapper
const safeStorage = {
  async get(keys) {
    if (isPrivateMode) {
      // In private mode, use session storage only
      if (typeof keys === 'string') {
        return { [keys]: privateSessionStorage.get(keys) };
      } else if (Array.isArray(keys)) {
        const result = {};
        keys.forEach(key => {
          result[key] = privateSessionStorage.get(key);
        });
        return result;
      }
      return {};
    }
    // Normal mode: use localStorage for website version
    if (typeof keys === 'string') {
      return { [keys]: safeLocalStorage.getItem(keys) };
    } else if (Array.isArray(keys)) {
      const result = {};
      keys.forEach(key => {
        result[key] = safeLocalStorage.getItem(key);
      });
      return result;
    } else if (typeof keys === 'object') {
      const result = {};
      Object.keys(keys).forEach(key => {
        result[key] = safeLocalStorage.getItem(key) || keys[key];
      });
      return result;
    }
    return {};
  },

  async set(items) {
    if (isPrivateMode) {
      // In private mode, store in session storage only (memory)
      Object.entries(items).forEach(([key, value]) => {
        privateSessionStorage.set(key, value);
      });
      console.log('[Private Mode] Data stored in session memory only (will not persist)');
      return;
    }
    // Normal mode: use localStorage for website version
    Object.entries(items).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        safeLocalStorage.setItem(key, value);
      }
    });
  },

  async remove(keys) {
    if (isPrivateMode) {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      keysArray.forEach(key => privateSessionStorage.delete(key));
      return;
    }
    // Normal mode: use localStorage for website version
    const keysArray = Array.isArray(keys) ? keys : [keys];
    keysArray.forEach(key => safeLocalStorage.removeItem(key));
  }
};

// Show private mode indicator in UI
function showPrivateModeIndicator() {
  if (!isPrivateMode) return;

  const header = document.querySelector('.header');
  if (!header) return;

  const indicator = document.createElement('div');
  indicator.className = 'private-mode-indicator';
  indicator.innerHTML = `
    <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" style="vertical-align: middle; margin-right: 4px;">
      <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
    </svg>
    <span style="font-size: 11px; font-weight: 500;">Private Mode</span>
  `;
  indicator.style.cssText = `
    display: flex;
    align-items: center;
    padding: 4px 12px;
    background: var(--md-sys-color-secondary-container, rgba(208, 188, 255, 0.2));
    color: var(--md-sys-color-on-secondary-container, #d0bcff);
    border-radius: 12px;
    font-size: 11px;
    margin-left: 8px;
  `;
  indicator.title = 'Private browsing mode: No data will be saved to disk';

  // Insert after logo
  const logo = header.querySelector('.logo');
  if (logo && logo.parentElement) {
    logo.parentElement.insertBefore(indicator, logo.nextSibling);
  }
}

// ============================================================================
// ENCRYPTION AND STORAGE UTILITIES
// ============================================================================
// These are now imported from utils/storage-utils.js:
// - storeEncryptedApiKey()
// - getDecryptedApiKey()
// - addChangelogEntry()
// - getChangelogEntries()
// - clearChangelog()

// Get folder path for a bookmark/folder
async function getFolderPath(itemId) {
  try {
    if (!itemId) return 'Root';

    const path = [];
    let currentId = itemId;

    while (currentId) {
      const item = bookmarkManager.getBookmark(currentId);
      if (!item) break;

      // Add the current item's title to the path
      if (item.title) {
        path.unshift(item.title);
      }

      // Find the parent and continue up the tree
      const parent = bookmarkManager.findParent(currentId);
      if (!parent) break;

      currentId = parent.id;
    }

    return path.length > 0 ? path.join(' > ') : 'Root';
  } catch (error) {
    return 'Unknown';
  }
}

// Focus trap utility for modal accessibility
let previouslyFocusedElement = null;
let focusTrapListener = null;

function trapFocus(modal) {
  // Store the element that had focus before modal opened
  previouslyFocusedElement = document.activeElement;

  // Get all focusable elements in modal
  const getFocusableElements = () => {
    return Array.from(modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
    ));
  };

  // Focus first element
  const focusableElements = getFocusableElements();
  if (focusableElements.length > 0) {
    focusableElements[0].focus();
  }

  // Remove previous listener if exists
  if (focusTrapListener) {
    document.removeEventListener('keydown', focusTrapListener);
  }

  // Add focus trap listener
  focusTrapListener = (e) => {
    if (e.key !== 'Tab') return;

    const focusableElements = getFocusableElements();
    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      // Shift + Tab: moving backwards
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      }
    } else {
      // Tab: moving forwards
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  };

  document.addEventListener('keydown', focusTrapListener);
}

function releaseFocusTrap() {
  // Remove focus trap listener
  if (focusTrapListener) {
    document.removeEventListener('keydown', focusTrapListener);
    focusTrapListener = null;
  }

  // Restore focus to previously focused element
  if (previouslyFocusedElement && previouslyFocusedElement.focus) {
    previouslyFocusedElement.focus();
    previouslyFocusedElement = null;
  }
}

// State
let bookmarkTree = [];
let searchTerm = '';
let activeFilters = [];
let expandedFolders = new Set();
let folderScanTimestamps = {}; // Track when each folder was last scanned
const FOLDER_SCAN_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
let theme = 'enhanced-blue';
let viewMode = 'list';
/* [ZeroLabs] 2026-08-18 12:32 AM - edited: added quickAccess/recent display flags (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
let displayOptions = {
  title: true,
  url: true,
  liveStatus: true,
  safetyStatus: true,
  preview: true,
  favicon: true,
  quickAccess: true,
  recent: true
};

/* [ZeroLabs] 2026-08-18 12:32 AM - added: quick access and recently opened state (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
// ============================================================================
// QUICK ACCESS & RECENTLY OPENED
// ============================================================================
// A pin is a URL, never a bookmark id. Ids are not stable across a pull from the
// snippet, which recreates the tree. URLs survive, and resolving them against
// the live tree at render time is what makes "delete the bookmark, the pin
// disappears" work with no extra bookkeeping.

const QUICK_ACCESS_KEY = 'bmz_quick_access';
const RECENT_OPENS_KEY = 'bmz_recent_opens';
const SECTION_STATE_KEY = 'bmz_section_state';
const RECENT_OPENS_LIMIT = 5;
const TOMBSTONE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days

let quickAccessPins = [];        // [{ url, title, pinnedAt }] - display order
let quickAccessTombstones = [];  // [{ url, removedAt }] - so unpins survive a merge
let quickAccessSnippetTag = null; // Which snippet these pins belong to (null = local only)
let quickAccessMetaLoaded = false; // True once bmz-meta.json has been read for the current snippet
let recentOpens = [];            // [{ url, openedAt }] - device local, never synced
// The two sections share one row and behave as an accordion: at most one open.
let activeSection = 'quickAccess'; // 'quickAccess' | 'recent' | null (both closed)

/* [ZeroLabs] 2026-08-27 - added: the deferred-sync notice card */
// A sync that stops and waits needs to say so without hijacking the page. The
// amber sync arrows are the standing signal but are easy to miss, and a modal
// that opens on its own lands on top of whatever you were doing. This card sits
// at the top of the list instead: visible, dismissable, and one click from the
// dialog that resolves it. It also works in the Android WebView, which a real
// browser notification does not.
let syncNoticeVisible = false;
let syncNoticeDismissed = false;
let syncNoticeCounts = { fromSnippet: 0, fromDevice: 0, overwrites: 0 };

// Normalize a URL for identity comparison. Scheme and host are case-insensitive,
// a lone trailing slash is noise, everything else is significant.
function normalizeUrlKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const base = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}${u.hash}`;
    return base.replace(/\/$/, '');
  } catch (error) {
    return String(url).trim();
  }
}

// Map every bookmark in the live tree by normalized URL. First match wins, so a
// URL bookmarked in two folders resolves to one Quick Access row.
function buildUrlIndex() {
  const index = new Map();
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.url) {
        const key = normalizeUrlKey(node.url);
        if (key && !index.has(key)) index.set(key, node);
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(bookmarkTree);
  return index;
}

// localStorage only ever holds strings, so these are JSON round-tripped rather
// than handed to safeStorage the way the extensions do it.
function readJsonSetting(key, fallback) {
  try {
    const raw = safeLocalStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (error) {
    console.error(`Error reading ${key}:`, error);
    return fallback;
  }
}

function writeJsonSetting(key, value) {
  try {
    safeLocalStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Error writing ${key}:`, error);
  }
}

function loadQuickAccess() {
  const stored = readJsonSetting(QUICK_ACCESS_KEY, null);
  if (stored && typeof stored === 'object') {
    quickAccessPins = Array.isArray(stored.pins) ? stored.pins : [];
    quickAccessTombstones = Array.isArray(stored.tombstones) ? stored.tombstones : [];
    quickAccessSnippetTag = stored.snippetId || null;
  } else {
    quickAccessPins = [];
    quickAccessTombstones = [];
    quickAccessSnippetTag = null;
  }
}

function saveQuickAccess() {
  writeJsonSetting(QUICK_ACCESS_KEY, {
    snippetId: quickAccessSnippetTag,
    pins: quickAccessPins,
    tombstones: quickAccessTombstones
  });
}

/* [ZeroLabs] 2026-08-27 - added: pins reach the snippet on their own (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
// saveQuickAccess only ever wrote to local storage. Pins reached GitLab solely
// as a passenger on a bookmarks.json push, so pinning something and changing
// nothing else never synced at all - the exact failure the extensions already
// fixed by giving pins their own write.
//
// bmz-meta.json is written ALONE. It is a separate file inside the snippet
// precisely so a client that predates Quick Access cannot blank it: GitLab only
// rewrites the files named in the request.
const QUICK_ACCESS_PUSH_DELAY_MS = 5000;
let quickAccessPushTimer = null;

function scheduleQuickAccessPush() {
  // Debounced, because reordering pins by dragging fires this on every drop
  clearTimeout(quickAccessPushTimer);
  quickAccessPushTimer = setTimeout(() => {
    pushQuickAccessMeta().catch(error => {
      console.error('[QuickAccess] Pin push failed:', error);
    });
  }, QUICK_ACCESS_PUSH_DELAY_MS);
}

async function pushQuickAccessMeta() {
  const snippetId = syncManager.getRemoteId();
  if (!snippetId || !navigator.onLine) return;

  // Never write pins for a snippet whose meta has not been read, or a snippet
  // switch followed by a fast push would overwrite the new snippet's pins with
  // the previous one's cache. buildPayloadFor enforces the same rule.
  if (!quickAccessMetaLoaded || quickAccessSnippetTag !== String(snippetId)) {
    await window.bmzQuickAccessMeta.loadForSnippet(snippetId);
  }

  const payload = window.bmzQuickAccessMeta.buildPayloadFor(snippetId);
  if (!payload) {
    console.warn('[QuickAccess] Meta not loaded for this snippet; pin push skipped');
    return;
  }

  await snippetAdapter.updateQuickAccessMeta(snippetId, payload);
  console.log('[QuickAccess] Pins pushed');
}

function loadRecentOpens() {
  const stored = readJsonSetting(RECENT_OPENS_KEY, []);
  recentOpens = Array.isArray(stored) ? stored : [];
}

function saveRecentOpens() {
  writeJsonSetting(RECENT_OPENS_KEY, recentOpens);
}

function loadSectionState() {
  const stored = readJsonSetting(SECTION_STATE_KEY, null);
  if (stored && typeof stored === 'object' && 'active' in stored) {
    const valid = ['quickAccess', 'recent', null];
    activeSection = valid.includes(stored.active) ? stored.active : 'quickAccess';
  }
}

function saveSectionState() {
  writeJsonSetting(SECTION_STATE_KEY, { active: activeSection });
}

function isPinned(url) {
  const key = normalizeUrlKey(url);
  if (!key) return false;
  return quickAccessPins.some(pin => normalizeUrlKey(pin.url) === key);
}

function pinBookmark(bookmark) {
  if (!bookmark || !bookmark.url) return;
  const key = normalizeUrlKey(bookmark.url);
  if (!key || isPinned(bookmark.url)) return;

  quickAccessPins.push({
    url: bookmark.url,
    title: bookmark.title || bookmark.url,
    pinnedAt: Date.now()
  });
  // Re-pinning clears any tombstone, otherwise a merge would delete it again.
  quickAccessTombstones = quickAccessTombstones.filter(t => normalizeUrlKey(t.url) !== key);

  saveQuickAccess();
  scheduleQuickAccessPush();
  markQuickAccessChanged();
  renderBookmarks();
}

// Unpin only. This never touches the underlying bookmark.
function unpinUrl(url) {
  const key = normalizeUrlKey(url);
  if (!key) return;
  const before = quickAccessPins.length;
  quickAccessPins = quickAccessPins.filter(pin => normalizeUrlKey(pin.url) !== key);
  if (quickAccessPins.length === before) return;

  quickAccessTombstones = quickAccessTombstones.filter(t => normalizeUrlKey(t.url) !== key);
  quickAccessTombstones.push({ url, removedAt: Date.now() });

  saveQuickAccess();
  scheduleQuickAccessPush();
  markQuickAccessChanged();
  renderBookmarks();
}

function reorderQuickAccess(fromKey, toKey, dropBefore) {
  const fromIndex = quickAccessPins.findIndex(p => normalizeUrlKey(p.url) === fromKey);
  const toIndex = quickAccessPins.findIndex(p => normalizeUrlKey(p.url) === toKey);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

  const [moved] = quickAccessPins.splice(fromIndex, 1);
  // Removing the source first shifts every later index down by one.
  let insertAt = quickAccessPins.findIndex(p => normalizeUrlKey(p.url) === toKey);
  if (!dropBefore) insertAt += 1;
  quickAccessPins.splice(insertAt, 0, moved);

  saveQuickAccess();
  scheduleQuickAccessPush();
  markQuickAccessChanged();
  renderBookmarks();
}

function recordRecentOpen(url) {
  if (!url) return;
  const key = normalizeUrlKey(url);
  if (!key) return;

  // Opening the same bookmark twice in a row must not produce two rows.
  recentOpens = recentOpens.filter(entry => normalizeUrlKey(entry.url) !== key);
  recentOpens.unshift({ url, openedAt: Date.now() });
  if (recentOpens.length > RECENT_OPENS_LIMIT) {
    recentOpens = recentOpens.slice(0, RECENT_OPENS_LIMIT);
  }

  saveRecentOpens();
  if (displayOptions.recent) renderBookmarks();
}

// Merge a remote pin list into the local one. Tombstones are what make an unpin
// stick: without them the other device's copy of the pin simply reappears on the
// next pull. A tombstone wins only if it is newer than the pin it shadows.
function mergeQuickAccess(remotePins, remoteTombstones) {
  const tombstones = new Map();
  const addTombstone = (entry) => {
    if (!entry || !entry.url) return;
    const key = normalizeUrlKey(entry.url);
    const existing = tombstones.get(key);
    if (!existing || (entry.removedAt || 0) > (existing.removedAt || 0)) {
      tombstones.set(key, { url: entry.url, removedAt: entry.removedAt || 0 });
    }
  };
  quickAccessTombstones.forEach(addTombstone);
  (remoteTombstones || []).forEach(addTombstone);

  const pins = new Map();
  const addPin = (pin) => {
    if (!pin || !pin.url) return;
    const key = normalizeUrlKey(pin.url);
    const existing = pins.get(key);
    // Earliest pin time wins so the entry keeps its original position intent.
    if (!existing || (pin.pinnedAt || 0) < (existing.pinnedAt || 0)) {
      pins.set(key, { url: pin.url, title: pin.title || pin.url, pinnedAt: pin.pinnedAt || Date.now() });
    }
  };
  // Local order first so this device's arrangement survives the merge.
  quickAccessPins.forEach(addPin);
  (remotePins || []).forEach(addPin);

  const merged = [];
  for (const [key, pin] of pins) {
    const tomb = tombstones.get(key);
    if (tomb && (tomb.removedAt || 0) > (pin.pinnedAt || 0)) continue; // Unpinned later than pinned
    merged.push(pin);
    tombstones.delete(key); // Pin outlived the tombstone, drop the tombstone
  }

  const cutoff = Date.now() - TOMBSTONE_MAX_AGE;
  quickAccessPins = merged;
  quickAccessTombstones = Array.from(tombstones.values()).filter(t => (t.removedAt || 0) > cutoff);
}

// Deliberately does NOT prune. A pin whose bookmark is missing is simply not
// rendered, which is what makes it vanish when you delete the bookmark. Deleting
// the stored entry here would destroy pins during a sync: a pull resolves pins
// against the OLD tree, before the incoming bookmarks have been written, so
// every pin looks dead for that window.
function resolveQuickAccess() {
  const index = buildUrlIndex();
  const resolved = [];

  for (const pin of quickAccessPins) {
    const node = index.get(normalizeUrlKey(pin.url));
    if (node) resolved.push(node);
  }

  return resolved;
}

// Same rule as the pins: skip what cannot be resolved, never delete it.
function resolveRecentOpens() {
  const index = buildUrlIndex();
  const resolved = [];

  for (const entry of recentOpens) {
    const node = index.get(normalizeUrlKey(entry.url));
    if (node) resolved.push(node);
  }

  return resolved;
}

// Pinning marks the snippet dirty exactly like a bookmark edit does, so pins
// ride the existing 30s debounce instead of firing their own request. A no-op
// for local-only users, since markChanged bails without a remote id.
function markQuickAccessChanged() {
  try {
    if (syncManager && typeof syncManager.markChanged === 'function' && syncManager.getRemoteId?.()) {
      syncManager.markChanged();
    }
  } catch (error) {
    console.error('[QuickAccess] Failed to mark snippet changed:', error);
  }
}

/* [ZeroLabs] 2026-08-18 12:32 AM - added: quick access sync bridge */
// snippet-adapter.js is a separate module with no import of this file, so the
// two meet on window. The adapter asks for a payload at push time and reports
// back once the write lands.
let quickAccessMetaExists = false;

window.bmzQuickAccessMeta = {
  // Returns null when pins must NOT be written for this snippet: either the
  // meta has never been read for it, or the cache still belongs to a different
  // snippet. Returning null makes the adapter omit the file entirely rather
  // than overwrite pins it has not seen.
  buildPayloadFor(snippetId) {
    if (!snippetId) return null;
    if (!quickAccessMetaLoaded || quickAccessSnippetTag !== String(snippetId)) return null;
    return {
      exists: quickAccessMetaExists,
      content: JSON.stringify({
        metaVersion: 1,
        lastModified: Date.now(),
        quickAccess: quickAccessPins,
        quickAccessRemoved: quickAccessTombstones
      }, null, 2)
    };
  },

  markWritten() {
    quickAccessMetaExists = true;
  },

  // Pull the pins for a snippet and fold them into the local list. Until this
  // has run for the current snippet, pushes will not include the meta file.
  async loadForSnippet(snippetId) {
    if (!snippetId) return;
    if (!snippetAdapter || typeof snippetAdapter.readQuickAccessMeta !== 'function') return;

    const remote = await snippetAdapter.readQuickAccessMeta(snippetId);
    if (!remote) return; // Network or auth failure; keep local as-is and retry later

    if (quickAccessSnippetTag && quickAccessSnippetTag !== String(snippetId)) {
      // Switched snippets. The cached pins belong to the previous snippet and
      // must not leak into this one, so they are discarded rather than merged.
      quickAccessPins = [];
      quickAccessTombstones = [];
    }

    mergeQuickAccess(remote.pins, remote.tombstones);
    quickAccessSnippetTag = String(snippetId);
    quickAccessMetaLoaded = true;
    quickAccessMetaExists = Boolean(remote.exists);
    saveQuickAccess();
    // Deliberately NOT scheduling a push: this is the PULL path, and pushing
    // here would send straight back what was just read on every sync.
    renderBookmarks();
  }
};
let currentEditItem = null;
let zoomLevel = 80;
let fontSize = 100; // Font size for bookmark/folder text (70-150%)
let guiScale = 100; // GUI scale for header, toolbar, and filter elements
let customBackgroundImage = null; // Custom background image data
let backgroundPosition = { x: 50, y: 50 }; // Background image position (%)
let backgroundScale = 100; // Background image scale (%)
let checkedBookmarks = new Set(); // Track which bookmarks have been checked to prevent infinite loops
let scanCancelled = false; // Flag to cancel ongoing scans
let linkCheckingEnabled = true; // Toggle for link checking
let safetyCheckingEnabled = true; // Toggle for safety checking
let whitelistedUrls = new Set(); // URLs whitelisted by user
let safetyHistory = {}; // Track safety status changes over time {url: [{timestamp, status, sources}]}
let selectedBookmarkIndex = -1; // Currently selected bookmark for keyboard navigation
let visibleBookmarks = []; // Flat list of visible bookmarks for keyboard navigation
let multiSelectMode = false; // Toggle for multi-select mode
let selectedItems = new Set(); // IDs of selected bookmarks/folders
let startFolderId = null; // Default folder to open when sidebar loads (null = root)

// Track open menus to preserve state across re-renders
let openMenuBookmarkId = null;

// Track which bookmarks have loaded previews (persists across re-renders)
let loadedPreviews = new Set();

// Undo system state
let undoData = null;
let undoTimer = null;
let undoCountdown = null;

// DOM Elements
const bookmarkList = document.getElementById('bookmarkList');
const searchInput = document.getElementById('searchInput');
const filterToggle = document.getElementById('filterToggle');
const filterBar = document.getElementById('filterBar');
const displayToggle = document.getElementById('displayToggle');
const displayBar = document.getElementById('displayBar');
const qrCodeBtn = document.getElementById('qrCodeBtn');
let themeBtn = document.getElementById('themeBtn');
let headerCollapseBtn = document.getElementById('headerCollapseBtn');
let collapsibleHeader = document.getElementById('collapsibleHeader');
let themeMenu = document.getElementById('themeMenu');
let viewBtn = document.getElementById('viewBtn');
let viewMenu = document.getElementById('viewMenu');
let zoomBtn = document.getElementById('zoomBtn');
let zoomMenu = document.getElementById('zoomMenu');
let zoomSlider = document.getElementById('zoomSlider');
let zoomValue = document.getElementById('zoomValue');
let fontSizeSlider = document.getElementById('fontSizeSlider');
let fontSizeValue = document.getElementById('fontSizeValue');
let settingsBtn = document.getElementById('settingsBtn');
let settingsMenu = document.getElementById('settingsMenu');
const openInTabBtn = document.getElementById('openInTabBtn');
const exportBookmarksBtn = document.getElementById('exportBookmarksBtn');
const importBookmarksBtn = document.getElementById('importBookmarksBtn');
const closeExtensionBtn = document.getElementById('closeExtensionBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const autoClearCacheSelect = document.getElementById('autoClearCache');
const setApiKeyBtn = document.getElementById('setApiKeyBtn');
const accentColorPicker = document.getElementById('accentColorPicker');
const resetAccentColorBtn = document.getElementById('resetAccentColor');
const backgroundImagePicker = document.getElementById('backgroundImagePicker');
const chooseBackgroundImageBtn = document.getElementById('chooseBackgroundImage');
const removeBackgroundImageBtn = document.getElementById('removeBackgroundImage');
const backgroundOpacitySlider = document.getElementById('backgroundOpacity');
const backgroundBlurSlider = document.getElementById('backgroundBlur');
const backgroundSizeSelect = document.getElementById('backgroundSize');
const repositionBackgroundBtn = document.getElementById('repositionBackground');
const backgroundScaleSlider = document.getElementById('backgroundScale');
const dragModeOverlay = document.getElementById('dragModeOverlay');
const closeDragModeBtn = document.getElementById('closeDragModeBtn');
const opacityValue = document.getElementById('opacityValue');
const blurValue = document.getElementById('blurValue');
const scaleValue = document.getElementById('scaleValue');
const containerOpacitySlider = document.getElementById('containerOpacity');
const containerOpacityValue = document.getElementById('containerOpacityValue');
const textColorPicker = document.getElementById('textColorPicker');
const resetTextColorBtn = document.getElementById('resetTextColor');
const guiScaleSelect = document.getElementById('guiScaleSelect');
const startFolderSelect = document.getElementById('startFolderSelect');

// Undo toast DOM elements
const undoToast = document.getElementById('undoToast');
const undoMessage = document.getElementById('undoMessage');
const undoButton = document.getElementById('undoButton');
const undoCountdownEl = document.getElementById('undoCountdown');
const undoDismiss = document.getElementById('undoDismiss');

// Scan status bar DOM elements
const rescanAllBtn = document.getElementById('rescanAllBtn');
const scanStatusBar = document.getElementById('scanStatusBar');
const scanProgress = document.getElementById('scanProgress');
const totalCount = document.getElementById('totalCount');

// Load folder scan timestamps from storage
async function loadFolderScanTimestamps() {
  try {
    const timestampsStr = safeLocalStorage.getItem('folderScanTimestamps');
    if (timestampsStr) {
      folderScanTimestamps = JSON.parse(timestampsStr);
    }
  } catch (error) {
    console.error('[Folder Scan Cache] Error loading timestamps:', error);
  }
}

// Save folder scan timestamp for a folder
async function saveFolderScanTimestamp(folderId) {
  try {
    folderScanTimestamps[folderId] = Date.now();
    safeLocalStorage.setItem('folderScanTimestamps', JSON.stringify(folderScanTimestamps));
    console.log(`[Folder Scan Cache] Saved timestamp for folder ${folderId}`);
  } catch (error) {
    console.error('[Folder Scan Cache] Error saving timestamp:', error);
  }
}

// Check if folder needs scanning (never scanned OR >7 days old)
function shouldScanFolder(folderId) {
  const lastScan = folderScanTimestamps[folderId];
  if (!lastScan) return true; // Never scanned

  const now = Date.now();
  const elapsed = now - lastScan;
  return elapsed > FOLDER_SCAN_CACHE_DURATION; // >7 days
}

// Sync UI with ongoing scan status
async function syncBackgroundScanStatus() {
  try {
    // In website version, check scanner service directly
    if (scannerService && scannerService.isScanning) {
      console.log(`[Scanner] Syncing UI - ${scannerService.scannedCount}/${scannerService.totalCount}`);

      // Update progress text
      if (scanProgress) {
        scanProgress.textContent = `Scanning: ${scannerService.scannedCount}/${scannerService.totalCount}`;
      }

      // Show stop button, hide rescan button
      const stopBtn = document.getElementById('stopScanBtn');
      const rescanBtn = document.getElementById('rescanAllBtn');
      if (stopBtn) stopBtn.style.display = 'flex';
      if (rescanBtn) rescanBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('Error syncing scan status:', error);
  }
}

// Setup listener for blocklist download progress messages
function setupBlocklistProgressListener() {
  // Listen for CustomEvents dispatched by blocklist service
  window.addEventListener('blocklist:progress', (event) => {
    const message = event.detail;
    // Update status bar with download progress
    if (scanProgress && message.status === 'starting') {
      scanProgress.textContent = 'Downloading blocklists...';
      if (scanStatusBar) scanStatusBar.classList.add('scanning');
    } else if (scanProgress && message.status === 'downloading') {
      scanProgress.textContent = `Downloading blocklists... (${message.current}/${message.total})`;
      if (scanStatusBar) scanStatusBar.classList.add('scanning');
    }
    console.log(`[Blocklist Progress] ${message.current}/${message.total}${message.sourceName ? ` - ${message.sourceName}` : ''}`);
  });

  window.addEventListener('blocklist:complete', (event) => {
    const message = event.detail;
    /* [ZeroLabs] 2026-08-28 - added: a running scan owns the status bar */
    // This had no guard at all, so a blocklist download finishing mid-scan
    // overwrote the scan's progress text and stripped .scanning off the bar.
    // The extensions guard this; the website never did.
    const scanning = !!(window.scannerService && window.scannerService.isScanning);
    if (scanning) return;

    if (scanProgress) {
      scanProgress.textContent = `Blocklists loaded: ${message.domains.toLocaleString()} domains`;
      setTimeout(() => {
        if (scanProgress && scanProgress.textContent.startsWith('Blocklists loaded:') &&
            !(window.scannerService && window.scannerService.isScanning)) {
          scanProgress.textContent = 'Ready';
        }
      }, 3000); // Show completion message for 3 seconds
    }
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    console.log(`[Blocklist Complete] ${message.domains.toLocaleString()} unique domains from ${message.totalEntries.toLocaleString()} entries (${message.sources} sources)`);
  });
}

// Initialize
async function init() {
  // Force update logo title to bypass cache
  const logoTitle = document.querySelector('.logo-title');
  const logoSubtitle = document.querySelector('.logo-subtitle');
  /* [ZeroLabs] 2026-06-20 1:58 PM - edited: version scales with title (em) */
  if (logoTitle) logoTitle.innerHTML = `Bookmark Manager Zero • <span style="color: var(--md-sys-color-primary); font-weight: 500; font-size: 0.85em;">v${APP_VERSION}</span>`;
  if (logoSubtitle) logoSubtitle.textContent = 'A modern safety & privacy first bookmark manager';

  // Force update filter button icon
  const filterToggle = document.getElementById('filterToggle');
  if (filterToggle) {
    filterToggle.innerHTML = `
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
        <path d="M4.25,5.61C6.27,8.2,10,13,10,13v6c0,0.55,0.45,1,1,1h2c0.55,0,1-0.45,1-1v-6c0,0,3.72-4.8,5.74-7.39 C20.25,4.95,19.78,4,18.95,4H5.04C4.21,4,3.74,4.95,4.25,5.61z"/>
      </svg>
    `;
    filterToggle.title = 'Filters';
  }

  // Show private mode indicator if in incognito/private browsing
  showPrivateModeIndicator();

  loadTheme();
  loadView();
  loadZoom();
  loadFontSize();
  loadGuiScale();
  loadBackgroundImage();
  loadContainerOpacity();
  // loadCustomTextColor(); // Moved to after event listener setup (line ~5388)
  loadCheckingSettings();
  loadScanConcurrency();
  await loadSetupCardFlag();
  await loadLatestCardFlag();
  /* [ZeroLabs] 2026-08-18 12:32 AM - added: load quick access and recent state */
  // loadDisplayOptions also calls these, but it runs later in initUI and the
  // first render happens before then.
  loadQuickAccess();
  loadRecentOpens();
  loadSectionState();
  // Not awaited: pins render from the local cache immediately and refresh when
  // this lands, so a slow GitLab never delays the sidebar.
  try {
    const remoteId = syncManager?.getRemoteId?.();
    if (remoteId) {
      window.bmzQuickAccessMeta.loadForSnippet(remoteId).catch(err => {
        console.error('[QuickAccess] Startup pin load failed:', err);
      });
    }
  } catch (error) {
    console.error('[QuickAccess] Startup pin load skipped:', error);
  }
  await loadWhitelist();
  await loadSafetyHistory();
  await loadFolderScanTimestamps();
  await loadAutoClearSetting();
  await loadStartFolder();

  console.log('[init] Loading bookmarks...');
  await loadBookmarks();

  cleanupSafetyHistory(); // Clean up stale entries on sidebar load
  await expandToStartFolder();

  setupEventListeners();
  setupBlocklistProgressListener();

  renderBookmarks();

  // Check if background scan is in progress and sync UI
  await syncBackgroundScanStatus();

  // NOTE: autoCheckBookmarkStatuses() removed from here
  // Scanner and blocklist now load on-demand when user triggers a scan
}

// Load and apply auto-clear cache setting
async function loadAutoClearSetting() {
  try {
    const result = await safeStorage.get('autoClearCacheDays');
    const autoClearDays = result.autoClearCacheDays || '7';

    // Set the select value
    if (autoClearCacheSelect) {
      autoClearCacheSelect.value = autoClearDays;
    }

    // Check if we need to run auto-clear
    if (autoClearDays !== 'never') {
      const lastClearResult = await safeStorage.get('lastCacheClear');
      const lastClear = lastClearResult.lastCacheClear || 0;
      const timeSinceLastClear = Date.now() - lastClear;
      const clearInterval = 24 * 60 * 60 * 1000; // Check once per day

      // Run auto-clear if it's been more than a day since last check
      if (timeSinceLastClear > clearInterval) {
        await clearOldCacheEntries(autoClearDays);
      }
    }
  } catch (error) {
    console.error('Error loading auto-clear setting:', error);
  }
}

// Load theme preference
// Theme and settings functions are now imported from utils/theme-settings-manager.js
// - loadTheme()
// - applyTheme()
// - applyCustomAccentColor()
// - setupFolderChildrenObserver()
// - updateTintControlsVisibility()
// - applyTintSettings()
// - loadTintSettings()
// - setTheme()
// - loadView()
// - applyView()
// - setView()
// - loadZoom()
// - applyZoom()
// - setZoom()
// - updateZoomDisplay()
// - loadFontSize()
// - applyFontSize()
// - setFontSize()
// - updateFontSizeDisplay()
// - loadGuiScale()
// - applyGuiScale()
// - loadStartFolder()
// - populateStartFolderDropdown()
// - expandToStartFolder()

// Store current custom accent color globally
let currentCustomAccentColor = null;

// ============================================================================
// EXPOSE GLOBALS TO WINDOW FOR MODULE ACCESS
// ============================================================================
// Extracted modules need access to these variables through the window object
window.safeStorage = safeStorage;
window.bookmarkTree = bookmarkTree;
window.expandedFolders = expandedFolders;
window.theme = theme;
window.viewMode = viewMode;
window.zoomLevel = zoomLevel;
window.fontSize = fontSize;
window.guiScale = guiScale;
window.startFolderId = startFolderId;
window.currentCustomAccentColor = currentCustomAccentColor;

// Set up folder children observer when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupFolderChildrenObserver);
} else {
  setupFolderChildrenObserver();
}

// Load and apply custom background image
// Apply background image with all settings
function applyBackgroundImage(imageData, opacity, blur, size, positionX, positionY, scale) {
  if (imageData) {
    // Create or update background overlay
    let bgOverlay = document.getElementById('background-overlay');
    if (!bgOverlay) {
      bgOverlay = document.createElement('div');
      bgOverlay.id = 'background-overlay';
      bgOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 0;
        pointer-events: none;
        background-repeat: no-repeat;
      `;
      document.body.insertBefore(bgOverlay, document.body.firstChild);

      // Make sure container has higher z-index
      const content = document.querySelector('.content');
      if (content && !content.style.position) {
        content.style.position = 'relative';
        content.style.zIndex = '1';
      }

      // Make sure status bar has higher z-index
      const statusBar = document.getElementById('scanStatusBar');
      if (statusBar) {
        statusBar.style.position = 'relative';
        statusBar.style.zIndex = '2';
      }
    }

    bgOverlay.style.backgroundImage = `url(${imageData})`;
    bgOverlay.style.opacity = opacity / 100;
    bgOverlay.style.filter = `blur(${blur}px)`;
    bgOverlay.style.backgroundSize = size || 'cover';
    bgOverlay.style.backgroundPosition = `${positionX || 50}% ${positionY || 50}%`;

    // Apply scale by using transform
    if (scale && scale != 100) {
      const scalePercent = scale / 100;
      bgOverlay.style.transform = `scale(${scalePercent})`;
      bgOverlay.style.transformOrigin = 'center center';
    } else {
      bgOverlay.style.transform = 'none';
      bgOverlay.style.transformOrigin = 'center center';
    }
  } else {
    // Remove background overlay
    const bgOverlay = document.getElementById('background-overlay');
    if (bgOverlay) {
      bgOverlay.remove();
    }
  }
}

function loadSavedBackgroundImage() {
  const savedImage = safeLocalStorage.getItem('backgroundImage');
  const savedOpacity = safeLocalStorage.getItem('backgroundOpacity');
  const savedBlur = safeLocalStorage.getItem('backgroundBlur');
  const savedSize = safeLocalStorage.getItem('backgroundSize');
  const savedPositionX = safeLocalStorage.getItem('backgroundPositionX');
  const savedPositionY = safeLocalStorage.getItem('backgroundPositionY');
  const savedScale = safeLocalStorage.getItem('backgroundScale');

  if (savedOpacity) {
    backgroundOpacitySlider.value = savedOpacity;
    opacityValue.textContent = `${savedOpacity}%`;
  }
  if (savedBlur) {
    backgroundBlurSlider.value = savedBlur;
    blurValue.textContent = `${savedBlur}px`;
  }
  if (savedSize) {
    backgroundSizeSelect.value = savedSize;
  }
  if (savedScale) {
    backgroundScaleSlider.value = savedScale;
    scaleValue.textContent = `${savedScale}%`;
  }

  if (savedImage) {
    applyBackgroundImage(
      savedImage,
      savedOpacity || 100,
      savedBlur || 0,
      savedSize || 'contain',
      savedPositionX || 50,
      savedPositionY || 50,
      savedScale || 200
    );
  }
}

function loadBackgroundImage() {
  loadSavedBackgroundImage();
}

// Apply container opacity to bookmark items
function applyContainerOpacity(opacity) {
  const opacityValue = opacity / 100;
  document.documentElement.style.setProperty('--bookmark-container-opacity', opacityValue);
}

// Load saved container opacity
function loadContainerOpacity() {
  if (!containerOpacitySlider) return;
  const savedOpacity = safeLocalStorage.getItem('containerOpacity');
  if (savedOpacity) {
    containerOpacitySlider.value = savedOpacity;
    containerOpacityValue.textContent = `${savedOpacity}%`;
    applyContainerOpacity(savedOpacity);
  } else {
    applyContainerOpacity(100);
  }
}

// Apply dark text mode
// Dark text mode functions removed - no longer needed

// Apply custom text color
function applyCustomTextColor(color) {
  // Remove existing custom text color style if it exists
  let styleTag = document.getElementById('custom-text-color-style');
  if (styleTag) {
    styleTag.remove();
  }

  // Inject a style tag with the custom text color
  // Use high specificity selectors to override dark-text-mode styles
  styleTag = document.createElement('style');
  styleTag.id = 'custom-text-color-style';
  styleTag.textContent = `
    body .bookmark-title,
    body .folder-title,
    body.dark-text-mode .bookmark-title,
    body.dark-text-mode .folder-title,
    body.blue-dark.dark-text-mode .bookmark-title,
    body.blue-dark.dark-text-mode .folder-title,
    body.dark.dark-text-mode .bookmark-title,
    body.dark.dark-text-mode .folder-title,
    body.light.dark-text-mode .bookmark-title,
    body.light.dark-text-mode .folder-title {
      color: ${color} !important;
    }

    body .bookmark-url,
    body.dark-text-mode .bookmark-url {
      color: ${color} !important;
      opacity: 0.7;
    }
  `;
  document.head.appendChild(styleTag);
}

// Load saved custom text color
function loadCustomTextColor() {
  if (!textColorPicker) return;
  const savedColor = safeLocalStorage.getItem('customTextColor');
  if (savedColor) {
    textColorPicker.value = savedColor;
    applyCustomTextColor(savedColor);
  } else {
    textColorPicker.value = '#e8e8e8'; // Light gray default - works with Firefox color picker
  }
}

// Reset custom text color
function resetCustomTextColor() {
  // Remove the custom style
  const styleTag = document.getElementById('custom-text-color-style');
  if (styleTag) {
    styleTag.remove();
  }
  safeLocalStorage.removeItem('customTextColor');
}

// Remove URL from whitelist
async function removeFromWhitelist(url) {
  whitelistedUrls.delete(url);
  await saveWhitelist();

  // Recheck affected bookmarks
  const affectedBookmarks = bookmarkTree.filter(item =>
    !item.children && item.url && new URL(item.url).hostname === new URL(url).hostname
  );

  if (affectedBookmarks.length > 0) {
    console.log(`Rechecking ${affectedBookmarks.length} bookmarks after removing ${url} from whitelist`);
    for (const bookmark of affectedBookmarks) {
      // Clear cached safety status
      const cached = await safeStorage.get(bookmark.url);
      if (cached[bookmark.url]) {
        delete cached[bookmark.url].safety;
        await safeStorage.set({ [bookmark.url]: cached[bookmark.url] });
      }
      // Recheck
      if (safetyCheckingEnabled) {
        await checkUrlSafety(bookmark);
      }
    }
    renderBookmarks();
  }
}

// Load checking settings from localStorage
function loadCheckingSettings() {
  const savedLinkChecking = safeLocalStorage.getItem('linkCheckingEnabled');
  const savedSafetyChecking = safeLocalStorage.getItem('safetyCheckingEnabled');

  // Default to true if not set
  linkCheckingEnabled = savedLinkChecking !== null ? savedLinkChecking === 'true' : true;
  safetyCheckingEnabled = savedSafetyChecking !== null ? savedSafetyChecking === 'true' : true;

  // Update checkbox states
  const linkCheckbox = document.getElementById('enableLinkChecking');
  const safetyCheckbox = document.getElementById('enableSafetyChecking');
  if (linkCheckbox) linkCheckbox.checked = linkCheckingEnabled;
  if (safetyCheckbox) safetyCheckbox.checked = safetyCheckingEnabled;
}

/* [ZeroLabs] 2026-06-20 10:50 AM - added: load + sync scan concurrency + jitter sliders */
function loadScanConcurrency() {
  let concurrency = 5; // Default cap (matches scanner-worker.js limiter)
  let jitter = 0;      // Default: no jitter
  const savedC = parseInt(safeLocalStorage.getItem('scanConcurrency'), 10);
  const savedJ = parseInt(safeLocalStorage.getItem('scanJitter'), 10);
  if (!isNaN(savedC)) concurrency = savedC;
  if (!isNaN(savedJ)) jitter = savedJ;

  const cSlider = document.getElementById('scanConcurrencySlider');
  const cLabel = document.getElementById('scanConcurrencyValue');
  if (cSlider) cSlider.value = concurrency;
  if (cLabel) cLabel.textContent = concurrency;

  const jSlider = document.getElementById('scanJitterSlider');
  const jLabel = document.getElementById('scanJitterValue');
  if (jSlider) jSlider.value = jitter;
  if (jLabel) jLabel.textContent = jitter + 'ms';

  // Push to the worker limiter (also re-applied on worker initComplete)
  if (window.scannerService) {
    window.scannerService.setConcurrency(concurrency);
    window.scannerService.setJitter(jitter);
  }
}

// Load display options from localStorage
function loadDisplayOptions() {
  // Load saved values or use defaults (all true)
  const savedTitle = safeLocalStorage.getItem('displayTitle');
  const savedUrl = safeLocalStorage.getItem('displayUrl');
  const savedFavicon = safeLocalStorage.getItem('displayFavicon');
  const savedLiveStatus = safeLocalStorage.getItem('displayLiveStatus');
  const savedSafetyStatus = safeLocalStorage.getItem('displaySafetyStatus');
  const savedPreview = safeLocalStorage.getItem('displayPreview');
  const savedPreviewPopup = safeLocalStorage.getItem('displayPreviewPopup');
  /* [ZeroLabs] 2026-08-18 12:32 AM - added: section visibility options */
  const savedQuickAccess = safeLocalStorage.getItem('displayQuickAccess');
  const savedRecent = safeLocalStorage.getItem('displayRecent');

  // Update displayOptions object (default to true if not set)
  displayOptions.title = savedTitle !== null ? savedTitle === 'true' : true;
  displayOptions.url = savedUrl !== null ? savedUrl === 'true' : true;
  displayOptions.favicon = savedFavicon !== null ? savedFavicon === 'true' : true;
  displayOptions.liveStatus = savedLiveStatus !== null ? savedLiveStatus === 'true' : true;
  displayOptions.safetyStatus = savedSafetyStatus !== null ? savedSafetyStatus === 'true' : true;
  displayOptions.preview = savedPreview !== null ? savedPreview === 'true' : true;
  displayOptions.quickAccess = savedQuickAccess !== null ? savedQuickAccess === 'true' : true;
  displayOptions.recent = savedRecent !== null ? savedRecent === 'true' : true;

  // Update previewPopupEnabled variable (default to true if not set)
  previewPopupEnabled = savedPreviewPopup !== null ? savedPreviewPopup === 'true' : true;

  // Update checkbox states
  const titleCheckbox = document.getElementById('displayTitle');
  const urlCheckbox = document.getElementById('displayUrl');
  const faviconCheckbox = document.getElementById('displayFavicon');
  const liveStatusCheckbox = document.getElementById('displayLiveStatus');
  const safetyStatusCheckbox = document.getElementById('displaySafetyStatus');
  const previewCheckbox = document.getElementById('displayPreview');
  const previewPopupCheckbox = document.getElementById('displayPreviewPopup');

  if (titleCheckbox) titleCheckbox.checked = displayOptions.title;
  if (urlCheckbox) urlCheckbox.checked = displayOptions.url;
  if (faviconCheckbox) faviconCheckbox.checked = displayOptions.favicon;
  if (liveStatusCheckbox) liveStatusCheckbox.checked = displayOptions.liveStatus;
  if (safetyStatusCheckbox) safetyStatusCheckbox.checked = displayOptions.safetyStatus;
  if (previewCheckbox) previewCheckbox.checked = displayOptions.preview;
  if (previewPopupCheckbox) previewPopupCheckbox.checked = previewPopupEnabled;

  /* [ZeroLabs] 2026-08-18 12:32 AM - added: restore section toggles and state */
  const quickAccessCheckbox = document.getElementById('displayQuickAccess');
  const recentCheckbox = document.getElementById('displayRecent');
  if (quickAccessCheckbox) quickAccessCheckbox.checked = displayOptions.quickAccess;
  if (recentCheckbox) recentCheckbox.checked = displayOptions.recent;

  // Pins, recents and the open-section choice load alongside the display flags
  // so the first render already has them.
  loadQuickAccess();
  loadRecentOpens();
  loadSectionState();
}

// Load active filters from localStorage
function loadActiveFilters() {
  const savedFilters = safeLocalStorage.getItem('activeFilters');
  if (savedFilters) {
    try {
      activeFilters = JSON.parse(savedFilters);
      // Update filter chip states
      document.querySelectorAll('.filter-chip').forEach(chip => {
        const filter = chip.dataset.filter;
        if (activeFilters.includes(filter)) {
          chip.classList.add('active');
        }
      });
    } catch (error) {
      console.error('Error loading active filters:', error);
      activeFilters = [];
    }
  }
}

// Apply zoom
// Zoom and font size functions are imported from utils/theme-settings-manager.js

// Helper function to validate cache entries
function isValidCache(cached) {
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  return cached && (Date.now() - cached.timestamp < CACHE_TTL);
}

// Restore cached bookmark statuses from persistent storage
async function restoreCachedBookmarkStatuses() {
  try {
    // Load both caches from storage
    const result = await safeStorage.get(['linkStatusCache', 'safetyStatusCache']);
    const linkCache = result.linkStatusCache || {};
    const safetyCache = result.safetyStatusCache || {};

    let restored = 0;

    // Recursively traverse bookmark tree
    function restoreStatuses(nodes) {
      nodes.forEach(node => {
        if (node.url) {
          // Check if URL is whitelisted (takes priority over cache)
          try {
            const hostname = new URL(node.url).hostname;
            if (whitelistedUrls.has(hostname)) {
              node.safetyStatus = 'safe';
              node.safetySources = ['Whitelisted by user'];
              node.linkStatus = node.linkStatus || 'unknown'; // Keep existing link status if present
              restored++;
            }
          } catch (e) {
            // Invalid URL, skip whitelist check
          }

          // Check link status cache (only if not already set by whitelist)
          if (!node.linkStatus) {
            const linkCached = linkCache[node.url];
            if (linkCached && isValidCache(linkCached)) {
              node.linkStatus = linkCached.result;
              restored++;
            }
          }

          // Check safety status cache (only if not whitelisted)
          if (!node.safetyStatus) {
            const safetyCached = safetyCache[node.url];
            if (safetyCached && isValidCache(safetyCached)) {
              node.safetyStatus = safetyCached.result?.status || safetyCached.result;
              node.safetySources = safetyCached.result?.sources || [];
              restored++;
            }
          }
        }

        if (node.children) {
          restoreStatuses(node.children);
        }
      });
    }

    restoreStatuses(bookmarkTree);
    console.log(`[Cache Restore] Restored ${restored} cached status indicators`);
  } catch (error) {
    console.error('[Cache Restore] Error restoring cached statuses:', error);
  }
}

// Load bookmarks from Firefox API
async function loadBookmarks() {
  try {
    // Save current status data before reloading
    const statusMap = new Map();
    const saveStatuses = (nodes) => {
      if (!nodes) return;
      nodes.forEach(node => {
        if (node.id && (node.linkStatus || node.safetyStatus)) {
          statusMap.set(node.id, {
            linkStatus: node.linkStatus,
            safetyStatus: node.safetyStatus,
            safetySources: node.safetySources
          });
        }
        if (node.children) {
          saveStatuses(node.children);
        }
      });
    };
    if (bookmarkTree) {
      saveStatuses(bookmarkTree);
    }

    // Load from bookmarkManager instead of browser.bookmarks API
    const tree = bookmarkManager.getTree();

    // Convert roots object to array for sidebar rendering
    if (tree && tree.roots) {
      bookmarkTree = Object.values(tree.roots);
    } else {
      bookmarkTree = [];
      console.warn('[loadBookmarks] No roots found in tree');
    }

    // Restore status data to reloaded bookmarks
    const restoreStatuses = (nodes) => {
      if (!nodes) return [];
      return nodes.map(node => {
        const savedStatus = statusMap.get(node.id);
        if (savedStatus) {
          node = { ...node, ...savedStatus };
        }
        if (node.children) {
          node.children = restoreStatuses(node.children);
        }
        return node;
      });
    };
    bookmarkTree = restoreStatuses(bookmarkTree);

    // Restore cached statuses for ALL bookmarks (fixes the search icon issue)
    await restoreCachedBookmarkStatuses();

    // Clear checked bookmarks when loading fresh data
    checkedBookmarks.clear();
    // Update start folder dropdown with current folders
    populateStartFolderDropdown(getAllFolders);

    // Sync bookmarkTree to window for extracted modules
    window.bookmarkTree = bookmarkTree;
  } catch (error) {
    console.error('[loadBookmarks] Error:', error);
    showError('Failed to load bookmarks');
    // Ensure window property is updated even in error cases
    window.bookmarkTree = bookmarkTree;
  }
}

// Cached bookmark statuses are restored when bookmarks are loaded
// See restoreCachedStatusesToBookmarkTree() above

// Scan ALL bookmarks regardless of folder expansion (used by rescan button)
async function rescanAllBookmarks() {
  // Skip if both checking types are disabled
  if (!linkCheckingEnabled && !safetyCheckingEnabled) {
    console.log('Link and safety checking are both disabled, skipping...');
    return;
  }

  // Initialize scanner on first scan
  if (window.scannerService) await window.scannerService.init();

  const bookmarksToCheck = [];

  // Traverse tree to find ALL bookmarks regardless of folder state or check status
  function traverseAll(nodes) {
    nodes.forEach(node => {
      // Skip separators
      if (node.type === 'separator') return;

      // Check all bookmarks regardless of folder expansion or previous check status
      if (node.url && !checkedBookmarks.has(node.id)) {
        bookmarksToCheck.push(node);
      }
      // Always traverse children
      if (node.type === 'folder' && node.children) {
        traverseAll(node.children);
      }
    });
  }

  traverseAll(bookmarkTree);

  if (bookmarksToCheck.length === 0) {
    if (scanProgress) scanProgress.textContent = 'Ready';
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    return;
  }

  console.log(`Rescanning ALL ${bookmarksToCheck.length} bookmarks in batches...`);

  // Mark these bookmarks as being checked
  bookmarksToCheck.forEach(item => checkedBookmarks.add(item.id));

  // Show stop button, hide rescan button
  const stopBtn = document.getElementById('stopScanBtn');
  if (stopBtn) stopBtn.style.display = 'flex';
  if (rescanAllBtn) rescanAllBtn.style.display = 'none';

  // Process bookmarks in batches
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 300;

  // Update status bar
  const totalToScan = bookmarksToCheck.length;
  let scannedCount = 0;
  scanCancelled = false; // Reset the cancel flag
  if (scanStatusBar) scanStatusBar.classList.add('scanning');
  if (scanProgress) scanProgress.textContent = `Scanning: 0/${totalToScan}`;

  for (let i = 0; i < bookmarksToCheck.length; i += BATCH_SIZE) {
    // Check if scan was cancelled
    if (scanCancelled) {
      console.log('Scan cancelled by user');
      break;
    }

    const batch = bookmarksToCheck.slice(i, i + BATCH_SIZE);

    // Check each bookmark in the batch - use scanner service (Web Worker) instead of main thread
    const batchPromises = batch.map(async (node) => {
        // Use scanner service to scan via Web Worker (avoids CORS issues and offloads work)
        if (window.scannerService && window.scannerService.worker && window.scannerService.workerInitialized) {
          await window.scannerService.scanBookmark(node, true); // Bypass cache for rescan

          // Update progress immediately after each bookmark completes
          scannedCount++;
          if (scanProgress) scanProgress.textContent = `Scanning: ${scannedCount}/${totalToScan}`;

          return { id: node.id };
        } else {
          // Worker not available or not initialized - log warning and skip scanning
          console.warn('[Rescan All] Scanner worker not available or not initialized, skipping bookmark:', node.url);
          const results = {};

          // Set status to unknown since we can't properly check without worker
          if (linkCheckingEnabled) {
            results.linkStatus = 'unknown';
          }
          if (safetyCheckingEnabled) {
            results.safetyStatus = 'unknown';
            results.safetySources = ['Scanner unavailable'];
          }

          // Update the node in the tree
          updateBookmarkInTree(node.id, results);

          // Update progress even when worker unavailable
          scannedCount++;
          if (scanProgress) scanProgress.textContent = `Scanning: ${scannedCount}/${totalToScan}`;

          return results;
        }
    });

    // Wait for all checks in the batch to complete
    await Promise.all(batchPromises);

    if (i + BATCH_SIZE < bookmarksToCheck.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  renderBookmarks();
  if (scanProgress) scanProgress.textContent = scanCancelled ? 'Scan stopped' : 'Scan complete';
  if (scanStatusBar) scanStatusBar.classList.remove('scanning');

  // Hide stop button, show rescan button
  if (stopBtn) stopBtn.style.display = 'none';
  if (rescanAllBtn) rescanAllBtn.style.display = 'flex';

  // Clear checkedBookmarks to free memory after scan completes
  checkedBookmarks.clear();

  // Reset status to "Ready" after 2 seconds
  setTimeout(() => {
    if (scanProgress) scanProgress.textContent = 'Ready';
  }, 2000);

  console.log(`Finished rescanning ${bookmarksToCheck.length} bookmarks`);
}

// Automatically check bookmark statuses for unchecked bookmarks
// Uses rate limiting to prevent browser overload
async function autoCheckBookmarkStatuses() {
  /* [ZeroLabs] 2026-08-09 1:31 PM - added: no scanning in share window */
  if (window.__bmzShareMode) {
    console.log('[Share] Share mode active, skipping link/safety scan');
    return;
  }

  // Skip if both checking types are disabled
  if (!linkCheckingEnabled && !safetyCheckingEnabled) {
    console.log('Link and safety checking are both disabled, skipping...');
    return;
  }

  // Initialize scanner on first scan
  if (window.scannerService) await window.scannerService.init();

  const bookmarksToCheck = [];

  // Traverse tree to find unchecked bookmarks (only in root or expanded folders)
  function traverse(nodes, parentExpanded = true) {
    nodes.forEach(node => {
      // Skip separators
      if (node.type === 'separator') return;

      // Only check bookmarks if parent is expanded (or at root level)
      if (parentExpanded && node.url && (!node.linkStatus || node.linkStatus === 'unknown') && !checkedBookmarks.has(node.id)) {
        bookmarksToCheck.push(node);
      }
      // For folders, only traverse children if folder is expanded
      if (node.type === 'folder' && node.children) {
        const isFolderExpanded = expandedFolders.has(node.id);
        traverse(node.children, isFolderExpanded);
      }
    });
  }

  traverse(bookmarkTree, true);

  if (bookmarksToCheck.length === 0) {
    // Update status bar to show ready state
    if (scanProgress) scanProgress.textContent = 'Ready';
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    return;
  }

  console.log(`Auto-checking ${bookmarksToCheck.length} bookmarks in batches...`);

  // Mark these bookmarks as being checked to prevent re-checking
  bookmarksToCheck.forEach(item => checkedBookmarks.add(item.id));

  // Use scanner service queue system for consistent progress updates (same as manual scans)
  if (window.scannerService && window.scannerService.worker) {
    // Wait for worker to be initialized before starting scan
    if (!window.scannerService.workerInitialized) {
      console.log('[Auto-Check] Waiting for scanner worker to initialize...');
      if (scanProgress) scanProgress.textContent = 'Initializing scanner...';
      const ready = await window.scannerService.waitForWorkerReady(10000);
      if (!ready) {
        console.warn('[Auto-Check] Scanner worker failed to initialize, using fallback');
        // Remove from checked set so they can be tried again later
        bookmarksToCheck.forEach(item => checkedBookmarks.delete(item.id));
        if (scanProgress) scanProgress.textContent = 'Ready';
        if (scanStatusBar) scanStatusBar.classList.remove('scanning');
        return;
      }
      console.log('[Auto-Check] Scanner worker initialized, starting scan');
    }
    /* [ZeroLabs] 2026-06-20 12:21 AM - added: don't stomp an in-progress scan queue */
    // A scan may already be running (e.g. from a previous folder expansion).
    // Appending to its queue preserves its progress instead of resetting the
    // count to 0 and stealing the Stop button's state out from under it.
    if (window.scannerService.isScanning) {
      window.scannerService.scanQueue.push(...bookmarksToCheck);
      window.scannerService.totalCount += bookmarksToCheck.length;
      if (scanProgress) scanProgress.textContent = `Scanning: ${window.scannerService.scannedCount}/${window.scannerService.totalCount}`;
      // Kick the queue in case it had already drained between batches
      window.scannerService.processQueue();
      return;
    }

    // Set up scan state similar to manual scans
    window.scannerService.scanQueue = [...bookmarksToCheck];
    window.scannerService.totalCount = bookmarksToCheck.length;
    window.scannerService.scannedCount = 0;
    window.scannerService.isScanning = true;
    window.scannerService.bypassCache = false; // Don't bypass cache for auto-scan

    // Update status bar to show scanning state
    if (scanStatusBar) scanStatusBar.classList.add('scanning');
    if (scanProgress) scanProgress.textContent = `Scanning: 0/${bookmarksToCheck.length}`;

    // Show stop button, hide rescan button (same as manual scans)
    const stopBtn = document.getElementById('stopScanBtn');
    const rescanBtn = document.getElementById('rescanAllBtn');
    if (stopBtn) stopBtn.style.display = 'flex';
    if (rescanBtn) rescanBtn.style.display = 'none';

    // Start queue processing (this will handle progress updates automatically)
    window.scannerService.processQueue();

    return; // Exit early, queue processing will handle the rest
  }

  // Fallback to batch processing if scanner service is not available
  console.warn('[Auto-Check] Scanner service not available, using fallback batch processing');
  
  // Process bookmarks in batches to prevent browser/network overload
  const BATCH_SIZE = 10; // Check 10 bookmarks at a time
  const BATCH_DELAY = 300; // 300ms delay between batches (balance speed vs network load)
  
  // Update status bar to show scanning state
  const totalToScan = bookmarksToCheck.length;
  let scannedCount = 0;
  if (scanStatusBar) scanStatusBar.classList.add('scanning');
  if (scanProgress) scanProgress.textContent = `Scanning: 0/${totalToScan}`;
  
  // Show stop button, hide rescan button (same as manual scans)
  const stopBtn = document.getElementById('stopScanBtn');
  const rescanBtn = document.getElementById('rescanAllBtn');
  if (stopBtn) stopBtn.style.display = 'flex';
  if (rescanBtn) rescanBtn.style.display = 'none';

  /* [ZeroLabs] 2026-06-20 12:21 AM - added: reset cancel flag so Stop works on fallback */
  scanCancelled = false;

  for (let i = 0; i < bookmarksToCheck.length; i += BATCH_SIZE) {
    // Check if scan was cancelled
    if (scanCancelled) {
      console.log('Scan cancelled, stopping...');
      break;
    }
  
    const batch = bookmarksToCheck.slice(i, i + BATCH_SIZE);
  
    // Set batch to checking status (update data only, don't render yet)
    batch.forEach(item => {
      const updates = {};
      if (linkCheckingEnabled) updates.linkStatus = 'checking';
      if (safetyCheckingEnabled) updates.safetyStatus = 'checking';
      updateBookmarkInTree(item.id, updates);
    });
  
    // Check this batch - use scanner service (Web Worker) instead of main thread
    const checkPromises = batch.map(async (item) => {
      try {
        // Use scanner service to scan via Web Worker (avoids CORS issues and offloads work)
        if (window.scannerService && window.scannerService.worker) {
          await window.scannerService.scanBookmark(item, false); // Don't bypass cache for auto-scan
  
          // Update progress immediately after each bookmark completes
          scannedCount++;
          if (scanProgress) scanProgress.textContent = `Scanning: ${scannedCount}/${totalToScan}`;
  
          // scanBookmark will update the bookmark object and DOM, so just return the ID
          return { id: item.id };
        } else {
          // Worker not available - log warning and skip scanning
          console.warn('[Auto-Check] Scanner worker not available, skipping bookmark:', item.url);
          const result = { id: item.id };
  
          // Set status to unknown since we can't properly check without worker
          if (linkCheckingEnabled) {
            result.linkStatus = 'unknown';
          }
          if (safetyCheckingEnabled) {
            result.safetyStatus = 'unknown';
            result.safetySources = ['Scanner unavailable'];
          }
  
          // Update progress even when worker unavailable
          scannedCount++;
          if (scanProgress) scanProgress.textContent = `Scanning: ${scannedCount}/${totalToScan}`;
  
          return result;
        }
      } catch (error) {
        console.error(`Error checking bookmark ${item.id} (${item.url}):`, error);
        const errorResult = { id: item.id };
        if (linkCheckingEnabled) errorResult.linkStatus = 'dead';
        if (safetyCheckingEnabled) {
          errorResult.safetyStatus = 'unknown';
          errorResult.safetySources = [];
        }
  
        // Update progress even on error
        scannedCount++;
        if (scanProgress) scanProgress.textContent = `Scanning: ${scannedCount}/${totalToScan}`;
  
        return errorResult;
      }
    });
  
    const results = await Promise.all(checkPromises);
  
    // Update results for this batch (update data and DOM immediately)
    results.forEach(result => {
      // Find the original bookmark to get the URL
      const bookmark = batch.find(b => b.id === result.id);
      const url = bookmark ? bookmark.url : '';
  
      // Update the data structure
      updateBookmarkInTree(result.id, {
        linkStatus: result.linkStatus,
        safetyStatus: result.safetyStatus,
        safetySources: result.safetySources
      });
  
      // Update the DOM immediately for this bookmark
      updateBookmarkStatusInDOM(result.id, result.linkStatus, result.safetyStatus, result.safetySources, url);
    });
  
    console.log(`Checked batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(bookmarksToCheck.length / BATCH_SIZE)} (${results.length} bookmarks)`);
  
    // Wait before processing next batch (except for the last batch)
    if (i + BATCH_SIZE < bookmarksToCheck.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  // Render once at the end of all batches
  renderBookmarks();

  /* [ZeroLabs] 2026-06-20 12:21 AM - edited: respect cancel + restore rescan button */
  // Update status bar to show complete
  if (scanProgress) scanProgress.textContent = scanCancelled ? 'Scan stopped' : 'Scan complete';
  if (scanStatusBar) scanStatusBar.classList.remove('scanning');

  // Hide stop button, show rescan button (same as manual scans)
  if (stopBtn) stopBtn.style.display = 'none';
  if (rescanBtn) rescanBtn.style.display = 'flex';

  // Clear checkedBookmarks to free memory after scan completes
  checkedBookmarks.clear();

  /* [ZeroLabs] 2026-06-20 10:35 AM - added: settle fallback status back to Ready */
  setTimeout(() => {
    if (scanProgress) scanProgress.textContent = 'Ready';
  }, 2000);

  console.log(`Finished checking link status for ${bookmarksToCheck.length} bookmarks (safety checks disabled - use Test VT button)`);
}

// Update total bookmark count in status bar
function updateTotalBookmarkCount() {
  if (!totalCount) return;

  let count = 0;
  function countBookmarksRecursive(nodes) {
    nodes.forEach(node => {
      if (node.type === 'bookmark' && node.url && node.type !== 'separator') {
        count++;
      } else if (node.type === 'folder' && node.children) {
        countBookmarksRecursive(node.children);
      }
    });
  }

  countBookmarksRecursive(bookmarkTree);
  totalCount.textContent = `${count} bookmark${count !== 1 ? 's' : ''}`;
}



/**
 * Open a URL using the most appropriate method based on the URL scheme.
 * For privileged schemes (about:, moz-extension:, etc.), use anchor click.
 * For regular HTTP(S) URLs, use browser tab APIs for better control.
 */
async function openBookmarkUrl(url, openInNewTab = false) {
  try {
    const urlObj = new URL(url);
    const scheme = urlObj.protocol.replace(':', '').toLowerCase();

    // List of privileged schemes that Firefox blocks from extensions
    const blockedSchemes = ['about'];

    if (blockedSchemes.includes(scheme)) {
      // Firefox security blocks extensions from opening about: URLs
      // Copy to clipboard and notify user
      try {
        await navigator.clipboard.writeText(url);
        alert(`Firefox security prevents extensions from opening ${scheme}: URLs.\n\nThe URL has been copied to your clipboard:\n${url}\n\nPlease paste it into the address bar manually.`);
      } catch (clipboardError) {
        alert(`Firefox security prevents extensions from opening ${scheme}: URLs.\n\nPlease copy and paste this URL manually:\n${url}`);
      }
      return;
    }

    /* [ZeroLabs] 2026-08-18 12:32 AM - added: track recent opens */
    // Recorded past the blocked-scheme return, so a URL that was refused never
    // counts as opened.
    recordRecentOpen(url);

    // List of other privileged schemes that may work with window.open
    const privilegedSchemes = ['moz-extension', 'chrome', 'view-source', 'jar', 'resource'];

    if (privilegedSchemes.includes(scheme)) {
      // Try window.open for other privileged URLs
      window.open(url, '_blank');
    } else {
      // Use window.open for all URLs in website version
      if (openInNewTab) {
        window.open(url, '_blank');
      } else {
        // In website version, always open in new tab since we can't navigate current tab
        window.open(url, '_blank');
      }
    }
  } catch (error) {
    console.error('Failed to open URL:', url, error);
    // Fallback: try window.open anyway
    try {
      window.open(url, '_blank');
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      alert(`Unable to open URL: ${url}\n\nPlease copy and paste it into the address bar manually.`);
    }
  }
}

// Render bookmarks
function renderBookmarks() {
  const filtered = filterAndSearchBookmarks(bookmarkTree);
  const isSearching = searchTerm.length > 0;

  // Ensure cached statuses are loaded for search results
  if (isSearching) {
    restoreCachedBookmarkStatuses();
  }

  if (filtered.length === 0 && hasSeenSetupCard) {
    bookmarkList.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-on-surface-variant);">
        <div style="font-size: 48px; margin-bottom: 12px; opacity: 0.5;">🔍</div>
        <div style="font-size: 14px; margin-bottom: 16px;">No bookmarks found</div>
        <button onclick="location.reload()" style="padding: 8px 16px; background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); border: none; border-radius: 8px; cursor: pointer; font-size: 14px;">Return to Bookmark Manager Setup</button>
      </div>
    `;

    return;
  }

  // Show setup card when no bookmarks AND user hasn't dismissed it
  if (filtered.length === 0 && !hasSeenSetupCard) {
    bookmarkList.innerHTML = '';

    const setupCard = document.createElement('div');
    setupCard.className = 'setup-card';
    setupCard.innerHTML = `
      <div class="setup-card-header">🎆 Welcome to Bookmark Manager Zero! 🎆</div>
      <div class="setup-card-subheader">Your bookmarks are already here!</div>
      <button class="setup-card-scan-btn" id="setupScanBtn">🔍 Scan All Bookmarks Now</button>
      <div class="setup-card-info">
        Bookmarks auto-scan when you expand folders (every 7 days). Progress appears in the status bar below.
        You'll be alerted if safe bookmarks turn malicious.
      </div>
      <div class="setup-card-disclaimer">
        <strong>Note:</strong> Scanning relies on community-submitted threat lists and automated link validation.
        This may produce false positive/negative results. Use Bookmark Manager Zero as a helpful safety tool,
        not a security guarantee.
      </div>
      <button class="setup-card-dismiss-btn" id="setupDismissBtn">Got it, don't show this again</button>
    `;
    bookmarkList.appendChild(setupCard);

    // Add event listeners
    setTimeout(() => {
      const scanBtn = document.getElementById('setupScanBtn');
      const dismissBtn = document.getElementById('setupDismissBtn');

      if (scanBtn) {
        scanBtn.addEventListener('click', async () => {
          await dismissSetupCard();
          await rescanAllBookmarks();
        });
      }

      if (dismissBtn) {
        dismissBtn.addEventListener('click', dismissSetupCard);
      }
    }, 0);

    return;
  }

  bookmarkList.innerHTML = '';

  // Show first-time setup card if user hasn't seen it
  if (!hasSeenSetupCard) {
    const setupCard = document.createElement('div');
    setupCard.className = 'setup-card';
    setupCard.innerHTML = `
      <div class="setup-card-header">🎆 Welcome to Bookmark Manager Zero! 🎆</div>
      <div class="setup-card-subheader">Your bookmarks are already here!</div>
      <button class="setup-card-scan-btn" id="setupScanBtn">🔍 Scan All Bookmarks Now</button>
      <div class="setup-card-info">
        Bookmarks auto-scan when you expand folders (every 7 days). Progress appears in the status bar below.
        You'll be alerted if safe bookmarks turn malicious.
      </div>
      <div class="setup-card-disclaimer">
        <strong>Note:</strong> Scanning relies on community-submitted threat lists and automated link validation.
        This may produce false positive/negative results. Use Bookmark Manager Zero as a helpful safety tool,
        not a security guarantee.
      </div>
      <button class="setup-card-dismiss-btn" id="setupDismissBtn">Got it, don't show this again</button>
    `;
    bookmarkList.appendChild(setupCard);

    // Add event listeners
    setTimeout(() => {
      const scanBtn = document.getElementById('setupScanBtn');
      const dismissBtn = document.getElementById('setupDismissBtn');

      if (scanBtn) {
        scanBtn.addEventListener('click', async () => {
          await dismissSetupCard();
          // Trigger full scan directly
          await rescanAllBookmarks();
        });
      }

      if (dismissBtn) {
        dismissBtn.addEventListener('click', dismissSetupCard);
      }
    }, 0);
  }

  /* [ZeroLabs] 2026-08-27 - edited: one reusable what's-new card */
  // "while BMZ is open" rather than the extensions' "even with BMZ closed":
  // a web page has no background worker, so this is the honest version.
  if (!hasSeenLatestCard) {
    const announcementCard = document.createElement('div');
    announcementCard.className = 'announcement-card';
    announcementCard.innerHTML = `
      <div class="announcement-card-title">What's New as of Aug 27, 2026</div>
      <div class="announcement-card-body">
        Sync now runs robustly in the background while BMZ is open.
        <br><br>
        Every sync is now a proper merge. BMZ compares your local bookmarks against your
        Snippet, quietly adds whatever is missing from either, and stops the moment something
        would be removed, renamed or otherwise overwritten to ask your permission before any
        action takes place. A card appears at the top of your bookmark list and the sync button
        turns amber. Nothing is lost or changed while it waits.
        <br><br>
        Sync settings have been rebuilt and streamlined around a single button that shows you
        what it's doing, and a switch to turn automatic syncing off (on is the default).
        <br><br>
        Deletion is now undoable everywhere — including bulk deletions and whole folders.
        Restoring a folder from the changelog brings its contents back too.
        <br><br>
        BMZ now warns you before saving a bookmark that isn't a valid link.
      </div>
      <div class="announcement-card-actions">
        <button class="announcement-card-dismiss-btn" id="latestCardDismissBtn">Got it</button>
      </div>
    `;
    bookmarkList.appendChild(announcementCard);
    setTimeout(() => {
      document.getElementById('latestCardDismissBtn')?.addEventListener('click', dismissLatestCard);
    }, 0);
  }

  // Force list view for search results to ensure status icons are visible
  const originalViewMode = window.viewMode;
  if (isSearching) {
    // Temporarily apply list view for search results
    bookmarkList.classList.remove('grid-view', 'grid-2', 'grid-3', 'grid-4', 'grid-5', 'grid-6');
  }

  /* [ZeroLabs] 2026-08-27 - added: deferred sync notice, above everything else */
  // Placed ahead of Quick Access so it is the first thing in the list, since it
  // is the only thing here that is waiting on a decision.
  renderSyncNoticeCard(bookmarkList);

  /* [ZeroLabs] 2026-08-18 12:32 AM - added: quick access and recent sections */
  // Hidden while searching or filtering: the tree is already showing matches
  // from everywhere, so mirrored rows would just duplicate the results.
  const isNarrowing = searchTerm.length > 0 || activeFilters.length > 0;
  if (!isNarrowing) {
    renderSections(bookmarkList);
  }

  renderNodes(filtered, bookmarkList);

  // Restore original view mode after rendering if we temporarily changed it
  // Don't restore grid view for search results to keep status icons visible
  if (!isSearching && originalViewMode !== 'list') {
    // Re-apply the original view mode
    if (originalViewMode && originalViewMode !== 'list') {
      bookmarkList.classList.add('grid-view', originalViewMode);
    }
  }

  // Add a drop zone at the end of the root to allow dropping items there
  const dropZone = document.createElement('div');
  dropZone.className = 'root-drop-zone';
  dropZone.dataset.id = 'root-end';
  dropZone.style.minHeight = '10px';
  dropZone.style.marginTop = '4px';

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropZone.classList.add('drop-active');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drop-active');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drop-active');

    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDropToRoot(draggedId);
  });

  bookmarkList.appendChild(dropZone);

  // Update total bookmark count in status bar
  updateTotalBookmarkCount();

  // Sync bookmarkTree to window for extracted modules
  window.bookmarkTree = bookmarkTree;

  // Ensure theme is applied to newly rendered elements
  applyTheme(theme);
}

// Create a drop zone element that fills the gap between items
/* [ZeroLabs] 2026-08-18 12:32 AM - added: quick access / recent section rendering (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
// ============================================================================
// SECTION RENDERING (QUICK ACCESS + RECENTLY OPENED)
// ============================================================================

// Which list a drag started from. dataTransfer payloads are unreadable during
// dragover, so the drop targets need this to decide whether to accept.
let dragContext = null; // null | 'tree' | 'tree-folder' | 'quick-access'

// Which list the open context menu belongs to, so a menu opened from Quick
// Access can offer Remove from Quick Access instead of Delete.
let contextMenuOrigin = 'tree'; // 'tree' | 'quick-access' | 'recent'

// Both sections sit on one row, each taking half the width, and behave as an
// accordion: opening one closes the other. Clicking the open one closes both.
function buildSectionHeader(config, count, isActive) {
  const header = document.createElement('div');
  header.className = 'bmz-section-header';
  if (isActive) header.classList.add('active');
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', String(isActive));

  header.innerHTML = `
    <svg class="bmz-section-icon" width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="${config.iconPath}"/>
    </svg>
    <span class="bmz-section-title">${escapeHtml(config.title)}</span>
    <svg class="bmz-section-chevron" width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
    </svg>
    <span class="bmz-section-count">${count}</span>
  `;

  const toggle = () => {
    activeSection = (activeSection === config.stateKey) ? null : config.stateKey;
    saveSectionState();
    renderBookmarks();
  };

  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return header;
}

// Quick Access rows. Draggable for reorder within the section only; the tree's
// drop handlers reject this drag context outright, so a pin can never be dropped
// into a real folder.
function createQuickAccessRow(bookmark) {
  const row = createBookmarkElement(bookmark, { mirror: 'quick-access' });
  const pinKey = normalizeUrlKey(bookmark.url);

  row.draggable = true;
  row.dataset.pinKey = pinKey;

  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    dragContext = 'quick-access';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', pinKey);
    e.dataTransfer.setData('itemType', 'quick-access');
    row.style.opacity = '0.5';
  });

  row.addEventListener('dragend', () => {
    dragContext = null;
    row.style.opacity = '1';
    document.querySelectorAll('.qa-drop-before, .qa-drop-after').forEach(el => {
      el.classList.remove('qa-drop-before', 'qa-drop-after');
    });
  });

  row.addEventListener('dragover', (e) => {
    if (dragContext !== 'quick-access') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    document.querySelectorAll('.qa-drop-before, .qa-drop-after').forEach(el => {
      el.classList.remove('qa-drop-before', 'qa-drop-after');
    });
    row.classList.add(e.clientY < rect.top + rect.height * 0.5 ? 'qa-drop-before' : 'qa-drop-after');
  });

  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove('qa-drop-before', 'qa-drop-after');
    }
  });

  row.addEventListener('drop', (e) => {
    if (dragContext !== 'quick-access') return;
    e.preventDefault();
    e.stopPropagation();
    const dropBefore = row.classList.contains('qa-drop-before');
    row.classList.remove('qa-drop-before', 'qa-drop-after');
    const fromKey = e.dataTransfer.getData('text/plain');
    dragContext = null;
    if (fromKey && fromKey !== pinKey) {
      reorderQuickAccess(fromKey, pinKey, dropBefore);
    }
  });

  return row;
}

function buildQuickAccessBody(resolved) {
  const body = document.createElement('div');
  body.className = 'bmz-section-body';

  if (resolved.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bmz-section-empty';
    empty.textContent = 'Right-click any bookmark and choose Add to Quick Access, or drag one here.';
    body.appendChild(empty);
  } else {
    resolved.forEach(bookmark => body.appendChild(createQuickAccessRow(bookmark)));
  }

  // Dropping a bookmark from the tree onto the body pins it. This mirrors, it
  // never moves the original, so nothing in the real folder structure changes.
  body.addEventListener('dragover', (e) => {
    if (dragContext !== 'tree') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    body.classList.add('bmz-section-drop-target');
  });

  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) {
      body.classList.remove('bmz-section-drop-target');
    }
  });

  body.addEventListener('drop', (e) => {
    if (dragContext !== 'tree') return;
    e.preventDefault();
    e.stopPropagation();
    body.classList.remove('bmz-section-drop-target');
    const draggedId = e.dataTransfer.getData('text/plain');
    dragContext = null;
    const item = findBookmarkById(bookmarkTree, draggedId);
    if (item && item.url) {
      pinBookmark(item);
    }
  });

  return body;
}

function buildRecentBody(resolved) {
  const body = document.createElement('div');
  body.className = 'bmz-section-body';

  if (resolved.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bmz-section-empty';
    empty.textContent = 'Bookmarks you open will appear here.';
    body.appendChild(empty);
  } else {
    // Read-only mirror: no drag, no reorder. Order is recency.
    resolved.forEach(bookmark => {
      const row = createBookmarkElement(bookmark, { mirror: 'recent' });
      row.draggable = false;
      body.appendChild(row);
    });
  }

  return body;
}

/* [ZeroLabs] 2026-08-27 - added: the deferred-sync notice card */
// Rendered from a flag rather than by reading storage, because renderBookmarks
// is synchronous and runs constantly. syncManager announces the change instead,
// and only when it actually changes.
/* [ZeroLabs] 2026-08-27 - added: name the numbers on the card */
// The card used to say only "found differences", which told you nothing about
// whether this was worth opening now or after dinner. Added as its own line
// rather than folded into the sentence above, so the agreed wording is untouched.
function syncNoticeSummary(counts) {
  const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
  const parts = [];
  if (counts.fromSnippet > 0) parts.push(n(counts.fromSnippet, 'bookmark', 'bookmarks') + ' to remove from your Snippet');
  if (counts.fromDevice > 0) parts.push(n(counts.fromDevice, 'bookmark', 'bookmarks') + ' to remove from this device');
  if (counts.overwrites > 0) parts.push(n(counts.overwrites, 'bookmark', 'bookmarks') + ' to rename or move');
  return parts.join('  ·  ');
}

function renderSyncNoticeCard(container) {
  if (!syncNoticeVisible || syncNoticeDismissed) return;

  const card = document.createElement('div');
  card.className = 'announcement-card sync-notice-card';
  // The leading image is the header sync button in its waiting state: the black
  // tanuki with amber arrows, in the same circle. The card and the button in the
  // toolbar are then visibly the same signal rather than two separate warnings.
  // Classes, not ids: #syncArrows already belongs to the toolbar button.
  card.innerHTML = `
    <div class="sync-notice-row">
      <div class="sync-notice-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#000000" d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
          <g class="sync-notice-arrows" transform="translate(12, 16) scale(0.56) translate(-12, -12)">
            <path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/>
          </g>
        </svg>
      </div>
      <div class="sync-notice-text">
        <div class="announcement-card-title">Sync was paused to protect your data</div>
        <div class="announcement-card-body">
          BMZ found differences between your Snippet and your local bookmarks that need
          your approval. Please review the changes to resume syncing.
        </div>
        <div class="sync-notice-summary">${syncNoticeSummary(syncNoticeCounts)}</div>
      </div>
    </div>
    <div class="announcement-card-actions">
      <button class="announcement-setup-btn" id="syncNoticeReview">Review changes</button>
      <button class="announcement-dismiss-btn" id="syncNoticeDismiss">Not now</button>
    </div>
  `;
  container.appendChild(card);

  // Deferred like the other cards here: the element is in the DOM but the rest
  // of the render is still running.
  setTimeout(() => {
    document.getElementById('syncNoticeReview')?.addEventListener('click', () => {
      window.app?.showHeldPushDialog();
    });
    // Dismissal lasts until the situation changes. The amber sync arrows stay on
    // whatever happens here, so the signal is never fully silenced.
    document.getElementById('syncNoticeDismiss')?.addEventListener('click', () => {
      syncNoticeDismissed = true;
      renderBookmarks();
    });
  }, 0);
}

/* [ZeroLabs] 2026-08-27 - added: follow the deferral state */
// Fires only on a genuine change, so a poll that re-reaches the same deferral
// every five minutes does not undo a dismissal.
window.addEventListener('sync:needsReconcile', async (e) => {
  const needs = !!(e.detail && e.detail.needs);
  if (needs === syncNoticeVisible) return;
  syncNoticeVisible = needs;
  if (needs) {
    // A new deferral is worth showing again even if the last one was dismissed
    syncNoticeDismissed = false;
    /* [ZeroLabs] 2026-08-27 - added: read the counts for the summary line */
    try {
      const held = await syncManager.getHeldState();
      syncNoticeCounts = {
        fromSnippet: held.fromSnippet.length,
        fromDevice: held.fromDevice.length,
        overwrites: held.overwrites.length
      };
    } catch (error) {
      // The card still stands on its own without the numbers
      syncNoticeCounts = { fromSnippet: 0, fromDevice: 0, overwrites: 0 };
    }
  }
  renderBookmarks();
});

// One row split in two, with the open section's contents below it. If a display
// option hides one section, the other takes the full row rather than half.
function renderSections(container) {
  const showQuickAccess = displayOptions.quickAccess;
  const showRecent = displayOptions.recent;
  if (!showQuickAccess && !showRecent) return;

  // A hidden section cannot be the active one.
  let active = activeSection;
  if (active === 'quickAccess' && !showQuickAccess) active = showRecent ? 'recent' : null;
  if (active === 'recent' && !showRecent) active = showQuickAccess ? 'quickAccess' : null;

  const wrapper = document.createElement('div');
  wrapper.className = 'bmz-sections';

  const tabs = document.createElement('div');
  tabs.className = 'bmz-section-tabs';
  if (showQuickAccess && showRecent) tabs.classList.add('split');

  const quickResolved = showQuickAccess ? resolveQuickAccess() : [];
  const recentResolved = showRecent ? resolveRecentOpens() : [];

  if (showQuickAccess) {
    tabs.appendChild(buildSectionHeader({
      title: 'Quick Access',
      stateKey: 'quickAccess',
      iconPath: 'M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z'
    }, quickResolved.length, active === 'quickAccess'));
  }

  if (showRecent) {
    tabs.appendChild(buildSectionHeader({
      title: 'Recent',
      stateKey: 'recent',
      iconPath: 'M13,3A9,9 0 0,0 4,12H1L4.89,15.89L4.96,16.03L9,12H6A7,7 0 0,1 13,5A7,7 0 0,1 20,12A7,7 0 0,1 13,19C11.07,19 9.32,18.21 8.06,16.94L6.64,18.36C8.27,20 10.51,21 13,21A9,9 0 0,0 22,12A9,9 0 0,0 13,3M12,8V13L16.28,15.54L17,14.33L13.5,12.25V8H12Z'
    }, recentResolved.length, active === 'recent'));
  }

  wrapper.appendChild(tabs);

  if (active === 'quickAccess') {
    wrapper.appendChild(buildQuickAccessBody(quickResolved));
  } else if (active === 'recent') {
    wrapper.appendChild(buildRecentBody(recentResolved));
  }

  container.appendChild(wrapper);
}

function createDropZone(parentId, targetIndex) {
  const dropZone = document.createElement('div');
  dropZone.className = 'inter-item-drop-zone';
  dropZone.dataset.parentId = parentId;
  dropZone.dataset.targetIndex = targetIndex;

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    dropZone.classList.add('drop-zone-active');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drop-zone-active');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drop-zone-active');
    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDropToPosition(draggedId, parentId, targetIndex);
  });

  return dropZone;
}

// Recursively render bookmark nodes with drop zones between them
function renderNodes(nodes, container, parentId = 'root________') {
  const isRootLevel = (parentId === 'root________');

  nodes.forEach((node, index) => {
    if (node.type === 'folder') {
      container.appendChild(createFolderElement(node));
    } else if (node.url) {
      container.appendChild(createBookmarkElement(node));
    }
  });
}

/**
 * Check if a URL is a browser privileged/internal URL
 * @param {string} url The URL to check
 * @returns {object|null} Object with type and label if privileged, null otherwise
 */
function isPrivilegedUrl(url) {
  try {
    const urlObj = new URL(url);
    const scheme = urlObj.protocol.replace(':', '').toLowerCase();

    // Browser internal pages
    if (scheme === 'about') {
      return { type: 'browser-internal', label: 'Browser internal page' };
    }
    if (scheme === 'chrome') {
      return { type: 'browser-internal', label: 'Browser internal page' };
    }

    // Extension pages
    if (scheme === 'moz-extension') {
      return { type: 'extension', label: 'Extension page' };
    }
    if (scheme === 'chrome-extension') {
      return { type: 'extension', label: 'Extension page' };
    }

    // Developer/debugging schemes
    if (scheme === 'view-source') {
      return { type: 'developer', label: 'View source page' };
    }
    if (scheme === 'jar') {
      return { type: 'developer', label: 'JAR resource' };
    }
    if (scheme === 'resource') {
      return { type: 'developer', label: 'Browser resource' };
    }

    return null;
  } catch (e) {
    return null;
  }
}

// Get status icon HTML based on link status
function getStatusDotHtml(linkStatus, url) {
  // Check if privileged URL
  const privilegedInfo = isPrivilegedUrl(url);
  if (privilegedInfo && linkStatus === 'live') {
    const privilegedTooltip = `Link Status: ${privilegedInfo.label}\n\nThis is a ${privilegedInfo.label.toLowerCase()}`;
    const escapedTooltip = privilegedTooltip.replace(/"/g, '&quot;');
    return `
      <span class="status-icon status-live clickable-status" title="${escapedTooltip}" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `;
  }

  const tooltips = {
    'live': 'Link Status: Live\n\n✓ Link is live and accessible\n✓ Returns successful HTTP response',
    'dead': 'Link Status: Dead\n\n✗ Link is dead or unreachable\n✗ Error, timeout, or connection failed',
    'parked': 'Link Status: Parked\n\n⚠ Domain is parked\n⚠ Redirects to domain parking service',
    'checking': 'Link Status: Checking\n\nChecking link status...',
    'unknown': 'Link Status: Unknown\n\nStatus has not been checked yet'
  };

  const tooltip = tooltips[linkStatus] || tooltips['unknown'];
  const escapedTooltip = tooltip.replace(/"/g, '&quot;');

  const statusIcons = {
    'live': `
      <span class="status-icon status-live clickable-status" title="Link is live and accessible
Returns successful HTTP response" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `,
    'dead': `
      <span class="status-icon status-dead clickable-status" title="Link is dead or unreachable
Error, timeout, or connection failed" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `,
    'parked': `
      <span class="status-icon status-parked clickable-status" title="Domain is parked
Redirects to domain parking service" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" viewBox="0 0 24 24">
          <g fill="currentColor">
            <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
          </g>
          <g fill="#eab308">
            <circle cx="18" cy="6" r="5"/>
            <text x="18" y="9.5" text-anchor="middle" font-size="10" font-weight="bold" fill="white">!</text>
          </g>
        </svg>
      </span>
    `,
    'checking': `
      <span class="status-icon status-checking clickable-status" title="Checking link status..." data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `,
    'unknown': `
      <span class="status-icon status-unknown clickable-status" title="Status unknown" data-status-message="${escapedTooltip}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/>
        </svg>
      </span>
    `
  };

  return statusIcons[linkStatus] || statusIcons['unknown'];
}

// Get shield indicator HTML based on safety status
function getShieldHtml(safetyStatus, url, safetySources = []) {
  const encodedUrl = encodeURIComponent(url);

  // Check if privileged URL
  const privilegedInfo = isPrivilegedUrl(url);
  if (privilegedInfo && safetyStatus === 'safe') {
    // Check if sources indicate this is privileged
    const isPrivilegedSource = safetySources && safetySources.length > 0 &&
                                safetySources[0].includes('not scanned');
    if (isPrivilegedSource) {
      const privilegedMessage = `Security Check: ${privilegedInfo.label}\n\n✓ ${privilegedInfo.label}\n✓ Not scanned (trusted browser page)`;
      const escapedMessage = privilegedMessage.replace(/"/g, '&quot;');
      return `
        <span class="shield-indicator shield-safe clickable-status" title="${escapedMessage}" data-url="${encodedUrl}" data-status-message="${escapedMessage}">
          <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1Z"/>
          </svg>
        </span>
      `;
    }
  }

  // Build sources text for unsafe tooltip
  const sourcesText = safetySources && safetySources.length > 0
    ? `\n⛔ Detected by: ${safetySources.join(', ')}`
    : '';

  // Build warning text from actual sources
  const warningText = safetySources && safetySources.length > 0
    ? safetySources.map(source => `⚠ ${source}`).join('\n')
    : '⚠ Suspicious pattern detected';

  // Build full messages for click popup
  const messages = {
    'safe': 'Security Check: Safe\n\n✓ Not found in malware databases\n✓ Passed URLhaus + BlockList checks',
    'warning': `Security Check: Warning\n\n${warningText}`,
    'unsafe': `Security Check: UNSAFE\n\n⛔ Malicious domain detected!${sourcesText}\n⛔ DO NOT VISIT - Exercise extreme caution!`,
    'checking': 'Security Check: Analyzing\n\nChecking URL security patterns...',
    'unknown': 'Security Check: Unknown\n\nUnable to determine safety status\nNot in whitelist or blacklist'
  };

  const message = messages[safetyStatus] || messages['unknown'];
  const escapedMessage = message.replace(/"/g, '&quot;');

  const shieldSvgs = {
    'safe': `
      <span class="shield-indicator shield-safe clickable-status" title="Security Check: Safe
✓ Not found in malware databases
✓ Passed URLhaus + BlockList checks" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.18L16.59,7.59L18,9L10,17Z"/>
        </svg>
      </span>
    `,
    'warning': `
      <span class="shield-indicator shield-warning clickable-status" title="Security Check: Warning
${warningText}" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M13,7H11V13H13V7M13,17H11V15H13V17Z"/>
        </svg>
      </span>
    `,
    'unsafe': `
      <span class="shield-indicator shield-unsafe clickable-status" title="Security Check: UNSAFE
⛔ Malicious domain detected!${sourcesText}
⛔ DO NOT VISIT - Exercise extreme caution!" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7C13.1,7 14,7.9 14,9V10.5L15.5,10.5C16.3,10.5 17,11.2 17,12V16C17,16.8 16.3,17.5 15.5,17.5H8.5C7.7,17.5 7,16.8 7,16V12C7,11.2 7.7,10.5 8.5,10.5H10V9C10,7.9 10.9,7 12,7M12,8.2C11.2,8.2 10.8,8.7 10.8,9V10.5H13.2V9C13.2,8.7 12.8,8.2 12,8.2Z"/>
        </svg>
      </span>
    `,
    'checking': `
      <span class="shield-indicator shield-scanning clickable-status" title="Security Check: Analyzing
Checking URL security patterns..." data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1Z"/>
        </svg>
      </span>
    `,
    'unknown': `
      <span class="shield-indicator shield-unknown clickable-status" title="Security Check: Unknown
Unable to determine safety status
Not in whitelist or blacklist" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12.5,7V12.5H11V7H12.5M12.5,14V15.5H11V14H12.5Z"/>
        </svg>
      </span>
    `,
    'whitelisted': `
      <span class="shield-indicator shield-whitelisted clickable-status" title="Security Check: Whitelisted

✓ Manually trusted by user
✓ Bypasses security checks" data-status-message="${escapedMessage}">
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" style="filter: drop-shadow(0 0 2px rgba(0,0,0,0.5));">
          <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.18L16.59,7.59L18,9L10,17Z" fill="#ffffff"/>
        </svg>
      </span>
    `
  };

  // Check if whitelisted
  const isWhitelisted = safetySources && safetySources.includes('Whitelisted by user');
  if (isWhitelisted) {
    return shieldSvgs['whitelisted'];
  }

  return shieldSvgs[safetyStatus] || shieldSvgs['unknown'];
}

// Create folder element
function createFolderElement(folder) {
  const folderDiv = document.createElement('div');
  folderDiv.className = 'folder-item';
  folderDiv.dataset.id = folder.id;
  // Don't make the entire folderDiv draggable - only the header will be draggable

  const isExpanded = expandedFolders.has(folder.id) || (searchTerm && folder.children && folder.children.length > 0);
  const childCount = countBookmarks(folder);

  const folderTitle = folder.title || folder.name || 'Unnamed Folder';

  folderDiv.innerHTML = `
    <div class="folder-header" draggable="true" role="button" aria-expanded="${isExpanded}" aria-label="${escapeHtml(folderTitle)} folder with ${childCount} items">
      ${multiSelectMode ? `<input type="checkbox" class="item-checkbox" data-id="${folder.id}" ${selectedItems.has(folder.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(folderTitle)} folder">` : ''}
      <div class="folder-toggle ${isExpanded ? 'expanded' : ''}" aria-hidden="true"></div>
      <div class="folder-icon-container" aria-hidden="true">
        <svg class="folder-icon-outline" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 7C3 5.89543 3.89543 5 5 5H9L11 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
        </svg>
        <div class="folder-count" data-digits="${childCount.toString().length}">${childCount}</div>
      </div>
      <div class="folder-title">${escapeHtml(folderTitle)}</div>
      <button class="bookmark-menu-btn folder-menu-btn" aria-label="More actions for ${escapeHtml(folderTitle)} folder" aria-haspopup="true" aria-expanded="false">⋮</button>
    </div>
    <div class="folder-children ${isExpanded ? 'show' : ''}" style="border-left: 2px solid #818cf8 !important;"></div>
  `;

  // Add click handler for folder toggle
  const header = folderDiv.querySelector('.folder-header');
  const menuBtn = header.querySelector('.folder-menu-btn');

  header.addEventListener('click', (e) => {
    // Don't toggle if clicking menu button or checkbox
    if (e.target.closest('.folder-menu-btn') ||
        e.target.closest('.item-checkbox')) {
      return;
    }
    // In multi-select mode, toggle the checkbox
    if (multiSelectMode) {
      const checkbox = folderDiv.querySelector('.item-checkbox');
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    toggleFolder(folder.id, folderDiv);
  });

  // Add menu button handler
  const handleFolderMenuToggle = (e) => {
    e.preventDefault(); // Prevent default behavior and synthetic click events
    e.stopPropagation(); // Stop event from bubbling up
    e.stopImmediatePropagation(); // Stop other handlers on same element
    toggleFolderMenu(folder);
    return false;
  };
  menuBtn.addEventListener('click', handleFolderMenuToggle, true); // Use capture phase
  menuBtn.addEventListener('touchend', handleFolderMenuToggle, true); // Use capture phase
  menuBtn.addEventListener('touchstart', (e) => {
    e.stopPropagation(); // Also stop touchstart from bubbling
  }, true);

  // Add right-click context menu support for folder
  folderDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFolderMenu(folder);
  });

  // Drag and drop handlers for folders (attach to header, not entire folderDiv)
  header.addEventListener('dragstart', (e) => {
    e.stopPropagation(); // Prevent event from bubbling to parent folders
    /* [ZeroLabs] 2026-08-18 12:32 AM - added: mark drag context as tree folder */
    // Distinct from 'tree' so the Quick Access section refuses folders; only
    // bookmarks can be pinned.
    dragContext = 'tree-folder';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', folder.id);
    e.dataTransfer.setData('itemType', 'folder');
    folderDiv.style.opacity = '0.5';
  });

  header.addEventListener('dragend', () => {
    /* [ZeroLabs] 2026-08-18 12:32 AM - added: clear drag context */
    dragContext = null;
    folderDiv.style.opacity = '1';
    removeAllDropIndicators();
    document.querySelectorAll('.bmz-section-drop-target').forEach(el => {
      el.classList.remove('bmz-section-drop-target');
    });
  });

  // Attach dragover/drop to header only, not entire folderDiv
  // This prevents intercepting drag events for bookmarks/subfolders within this folder
  header.addEventListener('dragover', (e) => {
    /* [ZeroLabs] 2026-08-18 12:32 AM - added: reject quick access drags */
    if (dragContext === 'quick-access') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = header.getBoundingClientRect();
    removeAllDropIndicators();
    if (e.clientY < rect.top + rect.height * 0.5) {
      folderDiv.classList.add('drop-before');
    } else {
      folderDiv.classList.add('drop-into');
    }
  });

  header.addEventListener('dragleave', (e) => {
    if (!header.contains(e.relatedTarget)) {
      folderDiv.classList.remove('drop-before', 'drop-into');
    }
  });

  header.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dropBefore = folderDiv.classList.contains('drop-before');
    removeAllDropIndicators();
    const draggedId = e.dataTransfer.getData('text/plain');
    await handleDrop(draggedId, folder.id, folderDiv, { dropBefore, dropAfter: false, dropInto: !dropBefore });
  });

  // Render children if expanded
  if (isExpanded && folder.children) {
    const childContainer = folderDiv.querySelector('.folder-children');
    renderNodes(folder.children, childContainer, folder.id);
  }

  return folderDiv;
}

// Create bookmark element
/* [ZeroLabs] 2026-08-18 12:32 AM - edited: mirror option for section rows (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
// options.mirror ('quick-access' | 'recent') marks a row as a second copy of a
// bookmark already rendered in the tree. Mirrors keep data-id so scan results
// still reach them, but skip the tree drag handlers entirely.
function createBookmarkElement(bookmark, options = {}) {
  const isMirror = Boolean(options.mirror);
  const bookmarkDiv = document.createElement('div');
  bookmarkDiv.className = 'bookmark-item';
  if (!displayOptions.preview) {
    bookmarkDiv.classList.add('no-preview');
  }
  bookmarkDiv.dataset.id = bookmark.id;
  if (isMirror) {
    bookmarkDiv.classList.add('bookmark-item-mirror');
    bookmarkDiv.dataset.mirror = options.mirror;
  }
  bookmarkDiv.draggable = !isMirror;

  // Get link status (default to unknown)
  const linkStatus = bookmark.linkStatus || 'unknown';
  const safetyStatus = bookmark.safetyStatus || 'unknown';
  const safetySources = bookmark.safetySources || [];

  // Build status indicators HTML based on display options
  let statusIndicatorsHtml = '';
  if (displayOptions.safetyStatus) {
    statusIndicatorsHtml += getShieldHtml(safetyStatus, bookmark.url, safetySources);
  }
  if (displayOptions.liveStatus) {
    statusIndicatorsHtml += getStatusDotHtml(linkStatus, bookmark.url);
  }

  // Also build separate shield and chainlink for grid view
  let shieldHtml = '';
  if (displayOptions.safetyStatus) {
    shieldHtml = getShieldHtml(safetyStatus, bookmark.url, safetySources);
  }

  let linkStatusHtml = '';
  if (displayOptions.liveStatus) {
    linkStatusHtml = getStatusDotHtml(linkStatus, bookmark.url);
  }

  // Build favicon HTML based on display options
  let faviconHtml = '';
  if (displayOptions.favicon && bookmark.url) {
    const faviconUrl = getFaviconUrl(bookmark.url);
    if (faviconUrl) {
      // Use onerror to silently hide broken favicons without console errors
      // We'll check favicon existence asynchronously after rendering
      faviconHtml = `<img class="bookmark-favicon" src="${faviconUrl}" data-url="${escapeHtml(bookmark.url)}" alt="" onerror="this.style.display='none';this.onerror=null;" loading="lazy" fetchpriority="low" />`;
    }
  }

  // Build bookmark info HTML based on display options
  let bookmarkInfoHtml = '';
  if (displayOptions.title) {
    bookmarkInfoHtml += `<div class="bookmark-title" title="${escapeHtml(bookmark.url)}">${escapeHtml(bookmark.title || bookmark.url)}</div>`;
  }
  let displayUrl = bookmark.url;
  try {
    displayUrl = new URL(bookmark.url).hostname;
  } catch (e) {
    // Fall back to full URL if invalid
    displayUrl = bookmark.url;
  }
  if (displayOptions.url) {
    bookmarkInfoHtml += `<div class="bookmark-url" title="${escapeHtml(bookmark.url)}">${escapeHtml(displayUrl)}</div>`;
  }

  const bookmarkTitle = bookmark.title || bookmark.url;

  bookmarkDiv.innerHTML = `
    ${multiSelectMode && !isMirror ? `<input type="checkbox" class="item-checkbox" data-id="${bookmark.id}" ${selectedItems.has(bookmark.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(bookmarkTitle)}">` : ''}
    <div class="status-indicators">
      ${statusIndicatorsHtml}
    </div>
    ${faviconHtml}
    <div class="bookmark-top-row">
      ${shieldHtml}
      ${faviconHtml}
      ${linkStatusHtml}
    </div>
    <div class="bookmark-info">
      ${bookmarkInfoHtml}
    </div>
    <button class="bookmark-menu-btn" aria-label="More actions for ${escapeHtml(bookmarkTitle)}" aria-haspopup="true" aria-expanded="false">⋮</button>
    <div class="bookmark-preview-container">
      <div class="preview-loading">Loading...</div>
      <img class="preview-image" alt="Preview" data-url="${escapeHtml(bookmark.url)}" />
    </div>
  `;


  // Add favicon error handler to hide broken images
  const favicon = bookmarkDiv.querySelector('.bookmark-favicon');
  if (favicon) {
    favicon.addEventListener('error', function() {
      this.style.display = 'none';
    });
  }

  // Add click handler for bookmark (open in current tab)
  bookmarkDiv.addEventListener('click', (e) => {
    console.log('[Bookmark Click] Target:', e.target.className, 'Closest menu:', e.target.closest('.bookmark-menu-btn'));

    // Check if menu button was clicked (flag set by menu button handler)
    if (bookmarkDiv.dataset.menuClicked) {
      console.log('[Bookmark Click] Ignored - menu button was clicked');
      return;
    }

    // Don't open if clicking on menu, preview, status indicators, or checkbox
    if (e.target.closest('.bookmark-menu-btn') ||
        e.target.closest('.bookmark-preview-container') ||
        e.target.closest('.status-indicators') ||
        e.target.closest('.item-checkbox')) {
      console.log('[Bookmark Click] Ignored - clicked on interactive element');
      return;
    }
    // In multi-select mode, toggle the checkbox
    if (multiSelectMode) {
      const checkbox = bookmarkDiv.querySelector('.item-checkbox');
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    /* [ZeroLabs] 2026-08-18 12:32 AM - added: track recent opens on every click path */
    // These three call window.open directly rather than going through
    // openBookmarkUrl, so each needs its own call.
    // Shift+click: open in new window
    if (e.shiftKey) {
      recordRecentOpen(bookmark.url);
      window.open(bookmark.url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Ctrl+click (Cmd+click on Mac): open in new tab
    if (e.ctrlKey || e.metaKey) {
      recordRecentOpen(bookmark.url);
      window.open(bookmark.url, '_blank');
      return;
    }
    // Default: open in new tab
    console.log('[Bookmark Click] Opening URL:', bookmark.url);
    const newWindow = window.open(bookmark.url, '_blank');
    if (!newWindow) {
      console.error('[Bookmark Click] Failed to open window - popup may be blocked');
      alert('Popup blocked! Please allow popups for this site to open bookmarks.');
    } else {
      console.log('[Bookmark Click] Window opened successfully');
      // Only counts as opened if the popup blocker did not stop it
      recordRecentOpen(bookmark.url);
    }
  });

  // Add menu toggle handler
  const menuBtn = bookmarkDiv.querySelector('.bookmark-menu-btn');
  if (!menuBtn) {
    console.error('[createBookmarkElement] Menu button not found for bookmark:', bookmark.title);
  } else {
    const handleMenuToggle = (e) => {
      console.log('[Menu Button] Clicked! Target:', e.target.className);
      e.preventDefault(); // Prevent default behavior and synthetic click events
      e.stopPropagation(); // Stop event from bubbling up
      e.stopImmediatePropagation(); // Stop other handlers on same element
      // Set a flag to prevent the bookmark click handler from running
      bookmarkDiv.dataset.menuClicked = 'true';
      /* [ZeroLabs] 2026-08-18 12:32 AM - added: record which section opened the menu */
      contextMenuOrigin = options.mirror || 'tree';
      toggleBookmarkMenu(bookmark);
      // Clear the flag after menu toggle completes
      setTimeout(() => delete bookmarkDiv.dataset.menuClicked, 10);
      return false;
    };
    menuBtn.addEventListener('click', handleMenuToggle, true); // Use capture phase
    menuBtn.addEventListener('touchend', handleMenuToggle, true); // Use capture phase
    menuBtn.addEventListener('touchstart', (e) => {
      console.log('[Menu Button] Touch start');
      e.stopPropagation(); // Also stop touchstart from bubbling
    }, true);
  }

  // Add right-click context menu support
  bookmarkDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    /* [ZeroLabs] 2026-08-18 12:32 AM - added: record which section opened the menu */
    contextMenuOrigin = options.mirror || 'tree';
    toggleBookmarkMenu(bookmark);
  });

  /* [ZeroLabs] 2026-08-18 12:32 AM - edited: skip tree drag wiring on mirror rows */
  // Mirrors get their own handlers from the section that built them, so the
  // move-a-real-bookmark handlers below must never be attached to one.
  if (!isMirror) {
    // Drag and drop handlers
    bookmarkDiv.addEventListener('dragstart', (e) => {
      e.stopPropagation(); // Prevent event from bubbling to parent folders
      dragContext = 'tree';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', bookmark.id);
      e.dataTransfer.setData('itemType', 'bookmark');
      bookmarkDiv.style.opacity = '0.5';
    });

    bookmarkDiv.addEventListener('dragend', () => {
      dragContext = null;
      bookmarkDiv.style.opacity = '1';
      removeAllDropIndicators();
      document.querySelectorAll('.bmz-section-drop-target').forEach(el => {
        el.classList.remove('bmz-section-drop-target');
      });
    });

    bookmarkDiv.addEventListener('dragover', (e) => {
      if (dragContext === 'quick-access') return; // Pins never enter the tree
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const rect = bookmarkDiv.getBoundingClientRect();
      removeAllDropIndicators();
      if (e.clientY < rect.top + rect.height * 0.5) {
        bookmarkDiv.classList.add('drop-before');
      } else {
        bookmarkDiv.classList.add('drop-after');
      }
    });

    bookmarkDiv.addEventListener('dragleave', (e) => {
      if (!bookmarkDiv.contains(e.relatedTarget)) {
        bookmarkDiv.classList.remove('drop-before', 'drop-after');
      }
    });

    bookmarkDiv.addEventListener('drop', async (e) => {
      if (dragContext === 'quick-access') return;
      e.preventDefault();
      e.stopPropagation();
      const dropBefore = bookmarkDiv.classList.contains('drop-before');
      removeAllDropIndicators();
      const draggedId = e.dataTransfer.getData('text/plain');
      await handleDrop(draggedId, bookmark.id, bookmarkDiv, { dropBefore, dropAfter: !dropBefore, dropInto: false });
    });
  }

  // Preview hover handler - load image on first hover (only if preview is enabled)
  if (displayOptions.preview) {
    const previewContainer = bookmarkDiv.querySelector('.bookmark-preview-container');
    const previewImage = bookmarkDiv.querySelector('.preview-image');
    const previewLoading = bookmarkDiv.querySelector('.preview-loading');

    // Check if preview was already loaded using global state
    // Always use URL as the key for consistency
    const previewKey = bookmark.url;
    const previewAlreadyLoaded = loadedPreviews.has(previewKey);

    // If preview was already loaded, set the image src immediately
    if (previewAlreadyLoaded && bookmark.url) {
      const previewUrl = getPreviewUrl(bookmark.url);
      if (previewUrl) {
        previewImage.src = previewUrl;
        previewImage.classList.add('loaded');
        previewLoading.style.display = 'none';
      }
    }

    // Prevent all interactions with preview (clicks, drags, context menu)
    previewContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    previewContainer.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    previewContainer.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    previewImage.addEventListener('dragstart', (e) => {
      e.preventDefault();
    });

    // Preview popup on hover
    previewImage.addEventListener('mouseenter', (e) => {
      showPreviewPopup(previewImage, e);
    });

    previewImage.addEventListener('mouseleave', () => {
      hidePreviewPopup();
    });

    bookmarkDiv.addEventListener('mouseenter', () => {
      if (!loadedPreviews.has(previewKey) && bookmark.url) {
        const previewUrl = getPreviewUrl(bookmark.url);

        if (previewUrl) {
          previewLoading.style.display = 'flex';
          previewLoading.textContent = 'Loading...';

          previewImage.onload = () => {
            previewLoading.style.display = 'none';
            previewImage.classList.add('loaded');
            loadedPreviews.add(previewKey); // Mark as loaded in global state
          };

          previewImage.onerror = () => {
            previewLoading.textContent = 'No preview';
            loadedPreviews.add(previewKey); // Mark as loaded even on error
          };

          previewImage.src = previewUrl;
        } else {
          previewLoading.textContent = 'No preview';
          loadedPreviews.add(previewKey); // Mark as loaded
        }
      }
    });
  }

  return bookmarkDiv;
}

// Get preview URL for a bookmark
function getPreviewUrl(url) {
  // Using WordPress mshots service (same as React webapp)
  try {
    const encodedUrl = encodeURIComponent(url);
    return `https://s.wordpress.com/mshots/v1/${encodedUrl}?w=320&h=180`;
  } catch (error) {
    console.error('Error generating preview URL:', error);
    return '';
  }
}

// Preview popup handling
let previewPopup = null;
let previewPopupEnabled = true; // Will be loaded from settings

// Create preview popup element
function createPreviewPopup() {
  if (!previewPopup) {
    previewPopup = document.createElement('div');
    previewPopup.className = 'preview-popup';
    previewPopup.innerHTML = '<img alt="Preview" />';
    document.body.appendChild(previewPopup);
  }
  return previewPopup;
}

// Show preview popup
function showPreviewPopup(previewImage, mouseEvent) {
  if (!previewPopupEnabled || !previewImage.classList.contains('loaded')) {
    return;
  }

  const popup = createPreviewPopup();
  const popupImg = popup.querySelector('img');

  // Get the bookmark URL from the preview image's data attribute
  const bookmarkUrl = previewImage.dataset.url;

  // Load high-quality preview (800x600 instead of 320x180)
  try {
    const encodedUrl = encodeURIComponent(bookmarkUrl);
    popupImg.src = `https://s.wordpress.com/mshots/v1/${encodedUrl}?w=800&h=600`;
  } catch (error) {
    console.error('Error loading high-quality preview:', error);
    popupImg.src = previewImage.src; // Fallback to low-res
  }

  // Position the popup with smart positioning
  const sidebar = document.body;
  const sidebarRect = sidebar.getBoundingClientRect();
  const header = document.querySelector('.header');
  const statusBar = document.querySelector('.scan-status-bar');

  // Get the bookmark element that contains the preview image
  const bookmarkElement = previewImage.closest('.bookmark-item, .folder-item');
  const bookmarkRect = bookmarkElement ? bookmarkElement.getBoundingClientRect() : null;

  // Calculate available space
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const statusBarTop = statusBar ? statusBar.getBoundingClientRect().top : sidebarRect.bottom;

  // Set max width to 90% of sidebar minus margins
  const maxWidth = sidebarRect.width * 0.9;
  popup.style.maxWidth = `${maxWidth}px`;

  // Show popup to calculate dimensions
  popup.classList.add('show');

  // Wait for image to load dimensions
  if (popupImg.complete) {
    positionPopup();
  } else {
    popupImg.onload = positionPopup;
  }

  function positionPopup() {
    const popupRect = popup.getBoundingClientRect();

    // Center horizontally in sidebar
    const left = sidebarRect.left + (sidebarRect.width - popupRect.width) / 2;

    // Position vertically - above or below bookmark to avoid covering it
    let top;
    if (bookmarkRect) {
      // Calculate space above and below the bookmark
      const spaceAbove = bookmarkRect.top - headerBottom - 20;
      const spaceBelow = statusBarTop - bookmarkRect.bottom - 20;

      // Try to position below first, then above if not enough space
      if (spaceBelow >= popupRect.height) {
        // Position below bookmark
        top = bookmarkRect.bottom + 10;
      } else if (spaceAbove >= popupRect.height) {
        // Position above bookmark
        top = bookmarkRect.top - popupRect.height - 10;
      } else {
        // Not enough space either way, use the side with more space
        if (spaceBelow > spaceAbove) {
          top = bookmarkRect.bottom + 10;
          // Might extend past status bar, but that's okay
        } else {
          top = Math.max(headerBottom + 20, bookmarkRect.top - popupRect.height - 10);
        }
      }
    } else {
      // Fallback: center on mouse position
      top = mouseEvent.clientY - popupRect.height / 2;
      const minTop = headerBottom + 20;
      const maxTop = statusBarTop - popupRect.height - 20;
      top = Math.max(minTop, Math.min(top, maxTop));
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }
}

// Hide preview popup
function hidePreviewPopup() {
  if (previewPopup) {
    previewPopup.classList.remove('show');
  }
}

// QR Code popup handling (local generation, privacy-focused)
let qrCodePopup = null;

// Create QR code popup element
function createQRCodePopup() {
  if (!qrCodePopup) {
    qrCodePopup = document.createElement('div');
    qrCodePopup.className = 'qr-popup';
    qrCodePopup.innerHTML = `
      <div class="qr-popup-content">
        <button class="qr-close-btn" aria-label="Close">&times;</button>
        <div class="qr-container"></div>
        <input type="text" class="qr-url-input" placeholder="Enter URL..." />
      </div>
    `;
    document.body.appendChild(qrCodePopup);

    // Add click handler for close button
    const closeBtn = qrCodePopup.querySelector('.qr-close-btn');
    closeBtn.addEventListener('click', hideQRCodePopup);

    // Close on backdrop click
    qrCodePopup.addEventListener('click', (e) => {
      if (e.target === qrCodePopup) {
        hideQRCodePopup();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && qrCodePopup && qrCodePopup.classList.contains('show')) {
        hideQRCodePopup();
      }
    });
  }
  return qrCodePopup;
}

// Show QR code popup with locally generated QR code
function showQRCodePopup(url) {
  const popup = createQRCodePopup();
  const qrContainer = popup.querySelector('.qr-container');
  const qrUrlInput = popup.querySelector('.qr-url-input');

  // Set the initial URL in the input
  qrUrlInput.value = url;

  // Function to generate/regenerate QR code
  function generateQR(text) {
    // Clear previous QR code
    qrContainer.innerHTML = '';

    // Generate QR code locally using qrcode-lib.js
    // The library throws "Unable to load image" errors during SVG capability detection
    // These are cosmetic and don't affect functionality - suppress them
    const suppressQRImageError = (e) => {
      if (e && (e.message === 'Unable to load image' ||
                (typeof e === 'string' && e.includes('Unable to load image')))) {
        e.preventDefault?.();
        e.stopPropagation?.();
        return true;
      }
      return false;
    };

    // Catch uncaught exceptions from QR library
    const errorHandler = (event) => {
      if (suppressQRImageError(event.error) || suppressQRImageError(event.reason)) {
        event.preventDefault();
      }
    };

    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', errorHandler);

    try {
      new QRCode(qrContainer, {
        text: text,
        width: 280,
        height: 280,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (error) {
      // Only show error if QR code actually failed to render
      if (!suppressQRImageError(error)) {
        console.error('Error generating QR code:', error);
        if (!qrContainer.querySelector('svg') && !qrContainer.querySelector('canvas')) {
          qrContainer.innerHTML = '<div style="padding: 20px;">Error generating QR code</div>';
        }
      }
    } finally {
      // Clean up error handlers after QR library finishes
      setTimeout(() => {
        window.removeEventListener('error', errorHandler);
        window.removeEventListener('unhandledrejection', errorHandler);
      }, 200);
    }
  }

  // Generate initial QR code
  generateQR(url);

  // Regenerate QR code on input change
  qrUrlInput.addEventListener('input', (e) => {
    const newUrl = e.target.value;
    if (newUrl.trim()) {
      generateQR(newUrl);
    }
  });

  // Show popup
  popup.classList.add('show');
}

// Hide QR code popup
function hideQRCodePopup() {
  if (qrCodePopup) {
    qrCodePopup.classList.remove('show');
  }
}

// Drag and drop helper functions
// Auto-scroll during drag when cursor is near top/bottom edges
// Note: capture phase is required because child drag handlers call stopPropagation()
let dragScrollInterval = null;
let isDragging = false;

document.addEventListener('dragstart', () => { isDragging = true; }, true);
document.addEventListener('dragend', () => { isDragging = false; stopDragScroll(); }, true);
document.addEventListener('drop', () => { isDragging = false; stopDragScroll(); }, true);

bookmarkList.addEventListener('dragover', (e) => {
  if (!isDragging) return;
  const rect = bookmarkList.getBoundingClientRect();
  const scrollZone = 60;
  const maxSpeed = 20;
  const y = e.clientY - rect.top;
  const bottomY = rect.bottom - e.clientY;

  if (y < scrollZone) {
    const speed = Math.ceil(maxSpeed * (1 - y / scrollZone));
    startDragScroll(-speed);
  } else if (bottomY < scrollZone) {
    const speed = Math.ceil(maxSpeed * (1 - bottomY / scrollZone));
    startDragScroll(speed);
  } else {
    stopDragScroll();
  }
}, true);

bookmarkList.addEventListener('dragleave', (e) => {
  if (!bookmarkList.contains(e.relatedTarget)) {
    stopDragScroll();
  }
}, true);

function startDragScroll(speed) {
  if (dragScrollInterval) cancelAnimationFrame(dragScrollInterval);
  const scroll = () => {
    bookmarkList.scrollTop += speed;
    dragScrollInterval = requestAnimationFrame(scroll);
  };
  dragScrollInterval = requestAnimationFrame(scroll);
}

function stopDragScroll() {
  if (dragScrollInterval) {
    cancelAnimationFrame(dragScrollInterval);
    dragScrollInterval = null;
  }
}


function handleDragOver(e, targetElement) {
  // No-op: drop-before/after removed in favour of inter-item drop zones.
  // Folder drop-into is handled directly in the folder header dragover listener.
}

function removeDropIndicator(element) {
  element.classList.remove('drop-before', 'drop-after', 'drop-into');
}

function removeAllDropIndicators() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(el => {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

async function handleDropToRoot(draggedId) {
  /* [ZeroLabs] 2026-08-18 12:32 AM - added: reject quick access drags */
  if (dragContext === 'quick-access') return;
  // Drop at the end of root (after all root items)
  const draggedItem = findBookmarkById(bookmarkTree, draggedId);
  if (!draggedItem) {
    console.error('Could not find dragged item');
    return;
  }


  try {
    // Get old parent folder path before moving
    const oldParent = findParentById(bookmarkTree, draggedId);
    const fromFolder = oldParent ? await getFolderPath(oldParent.id) : 'Root';

    // Move to root at the last position
    await bookmarkManager.move(draggedId, {
      parentId: undefined,
      index: bookmarkTree.length
    });

    // Add to changelog
    const itemType = draggedItem.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, draggedItem.title, draggedItem.url, { fromFolder, toFolder: 'Root' });

    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving to root:', error);
    alert('Failed to move item');
  }
}

async function handleDropToPosition(draggedId, targetParentId, targetIndex) {
  /* [ZeroLabs] 2026-08-18 12:32 AM - added: reject quick access drags */
  if (dragContext === 'quick-access') return;
  const draggedItem = findBookmarkById(bookmarkTree, draggedId);
  if (!draggedItem) {
    console.error('Could not find dragged item');
    return;
  }


  try {
    // Get old parent folder path before moving
    const oldParent = findParentById(bookmarkTree, draggedId);
    const fromFolder = oldParent ? await getFolderPath(oldParent.id) : 'Root';

    await bookmarkManager.move(draggedId, {
      parentId: targetParentId === 'root________' ? undefined : targetParentId,
      index: targetIndex
    });

    // Get new parent folder path after moving
    const toFolder = await getFolderPath(targetParentId === 'root________' ? undefined : targetParentId);

    // Add to changelog
    const itemType = draggedItem.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, draggedItem.title, draggedItem.url, { fromFolder, toFolder });

    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving to position:', error);
    alert('Failed to move item');
  }
}

async function handleDrop(draggedId, targetId, targetElement, dropState) {
  /* [ZeroLabs] 2026-08-18 12:32 AM - added: reject quick access drags */
  if (dragContext === 'quick-access') return;
  if (draggedId === targetId) return; // Can't drop on itself

  try {
    // Get the position to drop (before, after, or into target)
    const dropBefore = dropState.dropBefore;
    const dropInto = dropState.dropInto;

    // Find the dragged and target items in the tree
    const draggedItem = findBookmarkById(bookmarkTree, draggedId);
    const targetItem = findBookmarkById(bookmarkTree, targetId);

    if (!draggedItem || !targetItem) {
      console.error('Could not find dragged or target item');
      return;
    }

    // Determine the parent and index based on drop type
    let targetParentId;
    let targetIndex;

    if (dropInto && targetItem.type === 'folder') {
      // Dropping INTO a folder - item becomes child at index 0
      targetParentId = targetItem.id;
      targetIndex = 0;
    } else {
      // Dropping BEFORE or AFTER - item goes next to target in target's parent
      const targetParent = findParentById(bookmarkTree, targetId);
      targetParentId = targetParent ? targetParent.id : undefined;

      // Get target's index in its parent
      if (targetParent) {
        targetIndex = targetParent.children.findIndex(child => child.id === targetId);
      } else {
        targetIndex = bookmarkTree.findIndex(item => item.id === targetId);
      }

      // Calculate new index based on drop position
      targetIndex = dropBefore ? targetIndex : targetIndex + 1;

      // Adjust for same-parent moves: bookmarkManager.move removes the dragged item first,
      // which shifts down all items after it. If dragged item is in the same parent and
      // comes before the target, subtract 1 to account for that shift.
      const draggedParent = findParentById(bookmarkTree, draggedId);
      const draggedParentId = draggedParent ? draggedParent.id : undefined;
      if (draggedParentId === targetParentId) {
        const draggedIndex = draggedParent
          ? draggedParent.children.findIndex(c => c.id === draggedId)
          : bookmarkTree.findIndex(i => i.id === draggedId);
        if (draggedIndex < targetIndex) {
          targetIndex -= 1;
        }
      }
    }

    // Check if dropping a folder into itself or its descendants (prevent invalid moves)
    if (draggedItem.type === 'folder' && targetParentId) {
      let currentParent = findBookmarkById(bookmarkTree, targetParentId);
      while (currentParent) {
        if (currentParent.id === draggedId) {
          console.log('Cannot drop folder into itself or its descendants');
          return;
        }
        currentParent = findParentById(bookmarkTree, currentParent.id);
      }
    }

    const newIndex = targetIndex;


    // Move the bookmark using Firefox API
    // Get old parent folder path before moving
    const oldParent = findParentById(bookmarkTree, draggedId);
    const fromFolder = oldParent ? await getFolderPath(oldParent.id) : 'Root';

    await bookmarkManager.move(draggedId, {
      parentId: targetParentId,
      index: newIndex
    });

    // Get new parent folder path after moving
    const toFolder = await getFolderPath(targetParentId);

    // Add to changelog
    const itemType = draggedItem.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, draggedItem.title, draggedItem.url, { fromFolder, toFolder });

    // Reload and re-render
    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving bookmark:', error);
    alert('Failed to move item');
  }
}
// Helper function to find parent of bookmark by ID
function findParentById(nodes, childId, parent = null) {
  for (const node of nodes) {
    if (node.id === childId) return parent;
    if (node.children) {
      const found = findParentById(node.children, childId, node);
      if (found) return found;
    }
  }
  return null;
}

// Toggle folder expanded state
function toggleFolder(folderId, folderElement) {
  const isExpanded = expandedFolders.has(folderId);

  if (isExpanded) {
    expandedFolders.delete(folderId);
  } else {
    expandedFolders.add(folderId);
    // When expanding a folder, check its bookmarks only if cache expired (>7 days) or never scanned

    // Get folder node for logging
    const folderNode = window.bookmarkManager?.getFolder(folderId);
    const folderTitle = folderNode?.title || folderId;

    if (shouldScanFolder(folderId)) {
      console.log(`[Folder Scan Cache] "${folderTitle}" needs scanning (cache expired or never scanned)`);
      setTimeout(async () => {
        await autoCheckBookmarkStatuses();
        // Save timestamp after successful scan completes
        saveFolderScanTimestamp(folderId);
      }, 100);
    } else {
      const lastScan = folderScanTimestamps[folderId];
      const daysAgo = Math.floor((Date.now() - lastScan) / (24 * 60 * 60 * 1000));
      console.log(`[Folder Scan Cache] "${folderTitle}" already scanned ${daysAgo} day(s) ago, loading cached statuses...`);

      // Even though we skip scanning, we still need to load cached statuses from IndexedDB
      // for the bookmarks that are now visible in this expanded folder
      if (window.scannerService) {
        // Don't use setTimeout - we need this to complete before rendering
        try {
          const promise = loadCachedStatusesForFolder(folderId);

          // Add timeout to prevent UI hang if cache loading fails
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Cache load timeout')), 5000);
          });

          Promise.race([promise, timeoutPromise])
            .then((result) => {
              console.log('[Folder Toggle] Cache load complete, rendering...');
              console.log('[Folder Toggle] Cache result:', result);

              // If nothing was loaded from cache, trigger a scan
              if (result && result.total === 0) {
                console.log('[Folder Toggle] Cache was empty, triggering auto-scan...');
                setTimeout(() => {
                  autoCheckBookmarkStatuses();
                }, 100);
              }

              renderBookmarks(); // Re-render to show the loaded statuses
            })
            .catch(err => {
              console.error('[Folder Toggle] Cache load failed:', err);
              renderBookmarks(); // Render anyway even if cache load fails
            });
        } catch (err) {
          console.error('[Folder Toggle] Error calling loadCachedStatusesForFolder:', err);
          renderBookmarks();
        }
        return; // Exit early, render will happen after cache load
      }
    }
  }

  // Re-render to reflect changes (only if we didn't load cached statuses above)
  renderBookmarks();
}

// Load cached statuses for all bookmarks in a folder
async function loadCachedStatusesForFolder(folderId) {
  if (!window.scannerService) {
    console.warn('[Cache Load] No scanner service available');
    return;
  }

  console.log(`[Cache Load] Scanner service available, finding folder in bookmarkTree`);
  console.log(`[Cache Load] bookmarkTree length:`, bookmarkTree.length);

  // Find the folder in bookmarkTree (not bookmarkManager.tree!)
  const folder = findBookmarkById(bookmarkTree, folderId);
  if (!folder) {
    console.warn(`[Cache Load] Folder ${folderId} not found in bookmarkTree`);
    return;
  }

  console.log(`[Cache Load] Found folder: "${folder.title}"`);

  const bookmarks = [];

  // Recursively collect all bookmarks in this folder
  function collectBookmarks(node) {
    if (node.url) {
      bookmarks.push(node);
    }
    if (node.children) {
      node.children.forEach(collectBookmarks);
    }
  }

  collectBookmarks(folder);

  console.log(`[Cache Load] Collected ${bookmarks.length} bookmarks in "${folder.title}"`);
  let linkLoaded = 0;
  let safetyLoaded = 0;

  for (const bookmark of bookmarks) {
    // Load cached link status
    if (!bookmark.linkStatus) {
      const cachedLink = await window.scannerService.getCachedResult(bookmark.url, 'link');
      if (cachedLink) {
        bookmark.linkStatus = cachedLink;
        linkLoaded++;
      }
    }

    // Load cached safety status
    if (!bookmark.safetyStatus) {
      const cachedSafety = await window.scannerService.getCachedResult(bookmark.url, 'safety');
      if (cachedSafety) {
        bookmark.safetyStatus = cachedSafety.status;
        bookmark.safetySources = cachedSafety.sources || [];
        safetyLoaded++;
      }
    }
  }

  console.log(`[Cache Load] COMPLETE - Loaded ${linkLoaded} link + ${safetyLoaded} safety statuses for "${folder.title}"`);

  // Return count of loaded statuses
  return { linkLoaded, safetyLoaded, total: linkLoaded + safetyLoaded };
}

// Toggle bookmark menu - opens context menu modal
function toggleBookmarkMenu(bookmark) {
  openContextMenuModal(bookmark, false);
}

// Toggle folder menu - opens context menu modal
function toggleFolderMenu(folder) {
  openContextMenuModal(folder, true);
}

// Open context menu as a modal panel sliding in from the right
function openContextMenuModal(item, isFolder) {
  const modal = document.getElementById('contextMenuModal');
  const title = document.getElementById('contextMenuModalTitle');
  const body = document.getElementById('contextMenuModalBody');

  // Set title
  const displayTitle = item.title || (isFolder ? 'Untitled Folder' : 'Untitled Bookmark');
  title.textContent = displayTitle;

  // Build action buttons
  let buttonsHtml = '';

  if (isFolder) {
    buttonsHtml = `
      <button class="action-btn" data-action="rescan-folder">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/></svg></span>
        <span>Rescan Bookmarks in Folder</span>
      </button>
      <button class="action-btn" data-action="add-bookmark">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg></span>
        <span>Add Bookmark Here</span>
      </button>
      <button class="action-btn" data-action="add-subfolder">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M13,19V13H19V11H13V5H11V11H5V13H11V19H13M20,18H22V20H2V18H4V10A2,2 0 0,1 6,8H10V6A2,2 0 0,1 12,4H16A2,2 0 0,1 18,6V8H20A2,2 0 0,1 22,10V18M18,10H6V18H18V10M16,6H12V8H16V6Z"/></svg></span>
        <span>Add Subfolder Here</span>
      </button>
      <button class="action-btn" data-action="rename">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg></span>
        <span>Rename</span>
      </button>
      <button class="action-btn" data-action="move-to">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M14,18L12.6,16.6L15.2,14H4V12H15.2L12.6,9.4L14,8L19,13L14,18Z"/></svg></span>
        <span>Move to...</span>
      </button>
      <button class="action-btn danger" data-action="delete">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg></span>
        <span>Delete</span>
      </button>
    `;
  } else {
    buttonsHtml = `
      <button class="action-btn" data-action="open">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/></svg></span>
        <span>Open</span>
      </button>
      <button class="action-btn" data-action="open-new-tab">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z"/></svg></span>
        <span>Open in New Tab</span>
      </button>
      <button class="action-btn" data-action="open-new-window">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19,19H5V5H19M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M13.96,12.29L11.21,15.83L9.25,13.47L6.5,17H17.5L13.96,12.29Z"/></svg></span>
        <span>Open in New Window</span>
      </button>
      <button class="action-btn" data-action="reader-view">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M21,4H3A2,2 0 0,0 1,6V19A2,2 0 0,0 3,21H21A2,2 0 0,0 23,19V6A2,2 0 0,0 21,4M3,19V6H11V19H3M21,19H13V6H21V19M14,9.5H20V11H14V9.5M14,12H20V13.5H14V12M14,14.5H20V16H14V14.5Z"/></svg></span>
        <span>Open with Textise</span>
      </button>
      <button class="action-btn" data-action="save-pdf">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20M10.1,11.4C10.08,11.44 9.81,13.16 8,16.09C8,16.09 4.5,17.91 5.33,19.27C6,20.35 7.65,19.23 9.07,16.59C9.07,16.59 10.89,15.95 13.31,15.77C13.31,15.77 17.17,17.5 17.7,15.66C18.22,13.8 14.64,14.22 14,14.41C14,14.41 12,13.06 11.5,11.2C11.5,11.2 12.64,7.25 10.89,7.3C9.14,7.35 9.8,10.43 10.1,11.4M10.91,12.44C10.94,12.45 11.38,13.65 12.8,14.9C12.8,14.9 10.47,15.36 9.41,15.8C9.41,15.8 10.41,14.07 10.91,12.44M14.84,15.16C15.42,15 17,14.91 16.88,15.45C16.78,15.97 14.88,15.23 14.84,15.16M10.58,10.34C10.58,10.34 9.7,8.24 10.38,8.23C11.07,8.22 10.88,10.05 10.58,10.34Z"/></svg></span>
        <span>Save Page as PDF</span>
      </button>
      <button class="action-btn" data-action="recheck">
        <span class="icon"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></span>
        <span>Recheck Security Status</span>
      </button>
      <button class="action-btn" data-action="whitelist">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M10,17L6,13L7.41,11.59L10,14.17L16.59,7.58L18,9L10,17Z"/></svg></span>
        <span>Whitelist (Trust Site)</span>
      </button>
      <button class="action-btn" data-action="virustotal">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A3,3 0 0,1 15,8A3,3 0 0,1 12,11A3,3 0 0,1 9,8A3,3 0 0,1 12,5M17.13,17C15.92,18.85 14.11,20.24 12,20.92C9.89,20.24 8.08,18.85 6.87,17C6.53,16.5 6.24,16 6,15.47C6,13.82 8.71,12.47 12,12.47C15.29,12.47 18,13.79 18,15.47C17.76,16 17.47,16.5 17.13,17Z"/></svg></span>
        <span>Check on VirusTotal</span>
      </button>
      <button class="action-btn" data-action="qr-code">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M3,11H11V3H3M5,5H9V9H5M13,3V11H21V3M19,9H15V5H19M3,21H11V13H3M5,15H9V19H5M19,19V21H21V19M13,13H15V15H13M15,15H17V17H15M17,17H19V19H17M19,13V15H21V13M13,21H15V19H13M15,19H17V21H15Z"/></svg></span>
        <span>Generate QR Code</span>
      </button>
      <button class="action-btn" data-action="wayback-save">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg></span>
        <span>Save to Wayback Machine</span>
      </button>
      <button class="action-btn" data-action="wayback-browse">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M16.59,7.58L10,14.17L7.41,11.59L6,13L10,17L18,9L16.59,7.58Z"/></svg></span>
        <span>Browse Wayback Snapshots</span>
      </button>
      <button class="action-btn" data-action="copy-url">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/></svg></span>
        <span>Copy URL</span>
      </button>
      <button class="action-btn" data-action="edit">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg></span>
        <span>Edit</span>
      </button>
      <button class="action-btn" data-action="move-to">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M14,18L12.6,16.6L15.2,14H4V12H15.2L12.6,9.4L14,8L19,13L14,18Z"/></svg></span>
        <span>Move to...</span>
      </button>
      <button class="action-btn danger" data-action="delete">
        <span class="icon"><svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg></span>
        <span>Delete</span>
      </button>
    `;

    /* [ZeroLabs] 2026-08-19 5:23 PM - edited: pin and unpin share one slot above Delete (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
    // Both states occupy the SAME position, directly above Delete, so the item
    // never moves when you pin or unpin: only its label and colour change.
    // Only the removal state is red, since adding loses nothing. In the Quick
    // Access menu Delete has been stripped, so it simply lands last there.
    const pinIcon = '<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z"/></svg>';
    const pinned = isPinned(item.url);

    if (contextMenuOrigin === 'quick-access') {
      // Opened from the Quick Access section. Delete and Move to belong to the
      // real bookmark, and neither should be reachable from a mirror, so the
      // whole menu collapses to unpin plus the harmless actions.
      buttonsHtml = buttonsHtml
        .replace(/\s*<button class="action-btn danger" data-action="delete">[\s\S]*?<\/button>/, '')
        .replace(/\s*<button class="action-btn" data-action="move-to">[\s\S]*?<\/button>/, '');
    }

    const pinButton = `
      <button class="action-btn${pinned ? ' danger' : ''}" data-action="${pinned ? 'unpin-quick-access' : 'pin-quick-access'}">
        <span class="icon">${pinIcon}</span>
        <span>${pinned ? 'Remove from Quick Access' : 'Add to Quick Access'}</span>
      </button>
    `;

    // Function replacer, not a $1 string, so the SVG path can never be read as
    // a substitution pattern.
    const deleteButton = /<button class="action-btn danger" data-action="delete">[\s\S]*?<\/button>/;
    if (deleteButton.test(buttonsHtml)) {
      buttonsHtml = buttonsHtml.replace(deleteButton, (match) => pinButton + match);
    } else {
      buttonsHtml += pinButton;
    }
  }

  body.innerHTML = buttonsHtml;

  // Add click handlers to all action buttons
  body.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      closeContextMenuModal();
      if (isFolder) {
        await handleFolderAction(action, item);
      } else {
        await handleBookmarkAction(action, item);
      }
    });
  });

  // Show modal
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close context menu modal
function closeContextMenuModal() {
  const modal = document.getElementById('contextMenuModal');
  if (!modal || modal.classList.contains('hidden')) return;
  const content = modal.querySelector('.context-menu-modal-content');
  if (content) {
    content.classList.add('closing');
    content.addEventListener('animationend', () => {
      content.classList.remove('closing');
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      releaseFocusTrap();
    }, { once: true });
  } else {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    releaseFocusTrap();
  }
}

// Position toolbar dropdown menu with proper overflow handling
function positionToolbarMenu(menu, button) {
  const buttonRect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const margin = 16; // Safety margin from edges

  // Move menu to body so position: fixed works relative to viewport
  // (position: relative parents can break position: fixed)
  if (menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }

  // Set max-width to fit within margins and enforce it strictly
  const maxWidth = viewportWidth - (margin * 2);
  menu.style.maxWidth = `${maxWidth}px`;
  menu.style.width = 'auto';
  menu.style.overflowX = 'hidden';
  menu.style.position = 'fixed';
  menu.style.top = `${buttonRect.bottom + 4}px`;

  // Use requestAnimationFrame to ensure menu is rendered before measuring
  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width;

    // Calculate distances from edges
    const distanceFromLeft = buttonRect.left;
    const distanceFromRight = viewportWidth - buttonRect.right;

    let leftPos;

    // If button is closer to right edge, align menu to the right edge of viewport
    if (distanceFromRight < distanceFromLeft) {
      // Right-aligned: position menu against the right edge of viewport
      leftPos = viewportWidth - margin - menuWidth;

      // Ensure menu doesn't overflow left edge
      if (leftPos < margin) {
        leftPos = margin;
      }
    } else {
      // Left-aligned: menu's left edge aligns with button's left edge
      leftPos = buttonRect.left;

      // Ensure menu doesn't overflow right edge
      if (leftPos + menuWidth > viewportWidth - margin) {
        leftPos = viewportWidth - margin - menuWidth;
      }

      // Ensure menu doesn't overflow left edge
      if (leftPos < margin) {
        leftPos = margin;
      }
    }

    menu.style.left = `${leftPos}px`;
    menu.style.right = 'auto';

    // Re-check position after content loads (menu might expand)
    // Use longer delay to account for async operations like cache size calculation
    setTimeout(() => {
      const verifyRect = menu.getBoundingClientRect();
      const actualWidth = verifyRect.width;

      // If menu expanded beyond viewport, reposition it
      if (verifyRect.right > viewportWidth - margin) {
        const newLeftPos = Math.max(margin, viewportWidth - margin - actualWidth);
        menu.style.left = `${newLeftPos}px`;
      }
    }, 250);
  });
}


// Handle folder actions
async function handleFolderAction(action, folder) {
  switch (action) {
    case 'rescan-folder':
      await rescanFolder(folder.id, folder.title);
      break;

    case 'add-bookmark':
      // Open add bookmark modal with this folder pre-selected
      await openAddBookmarkModal();
      // Pre-select this folder
      const folderSelect = document.getElementById('newBookmarkFolder');
      if (folderSelect) {
        folderSelect.value = folder.id;
      }
      break;

    case 'add-subfolder':
      // Open add folder modal with this folder pre-selected as parent
      openAddFolderModal();
      // Pre-select this folder as parent
      const parentSelect = document.getElementById('newFolderParent');
      if (parentSelect) {
        parentSelect.value = folder.id;
      }
      break;

    case 'rename':
      openEditModal(folder, true);
      break;

    case 'move-to':
      openMoveToModal(folder, true);
      break;

    case 'delete':
      // SAFETY: Enhanced confirmation showing number of items to be deleted
      const itemCount = await countFolderItems(folder.id);
      const warningMessage = itemCount > 0
        ? `⚠ Delete folder "${folder.title}" and ALL ${itemCount} item(s) inside?\n\nYou can undo this from the toast or the changelog.`
        : `Delete empty folder "${folder.title}"?`;

      if (confirm(warningMessage)) {
        await deleteFolder(folder.id);
      }
      break;
  }
}

// Rescan all bookmarks in a folder and its subfolders
async function rescanFolder(folderId, folderTitle) {
  try {
    console.log(`[Folder Rescan] Starting rescan for folder: ${folderTitle} (${folderId})`);

    // Find the folder node in the bookmark tree
    const folder = findFolderById(folderId, bookmarkTree);
    if (!folder) {
      alert(`Folder "${folderTitle}" not found.`);
      return;
    }

    // Count bookmarks in folder recursively
    const countBookmarks = (node) => {
      let count = 0;
      if (node.url) {
        count = 1;
      } else if (node.children) {
        node.children.forEach(child => {
          count += countBookmarks(child);
        });
      }
      return count;
    };

    const bookmarkCount = countBookmarks(folder);

    if (bookmarkCount === 0) {
      alert(`Folder "${folderTitle}" has no bookmarks to scan.`);
      return;
    }

    console.log(`[Folder Rescan] Found ${bookmarkCount} bookmark(s) in folder "${folderTitle}"`);

    // Update status bar to show scanning
    if (scanStatusBar) scanStatusBar.classList.add('scanning');
    if (scanProgress) scanProgress.textContent = `Preparing scan...`;

    // Ensure blocklist database is ready
    try {
      if (scanProgress) scanProgress.textContent = `Loading security database...`;
      console.log('[Folder Rescan] Ensuring blocklist database is ready...');

      const response = await blocklistService.ensureBlocklistReady();
      console.log(`[Folder Rescan] Blocklist ready with ${response.domainCount} domains`);
    } catch (error) {
      console.warn('[Folder Rescan] Could not ensure blocklist is ready:', error);
    }

    // Use scanner service to scan the folder
    await scannerService.scanFolder(folder, true);

    // Save the updated folder scan timestamp
    saveFolderScanTimestamp(folderId);

    // Refresh the display with updated status icons
    renderBookmarks();

    // Update status bar to show completion
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    if (scanProgress) scanProgress.textContent = `Scan complete`;

    console.log(`[Folder Rescan] Complete for folder "${folderTitle}"`);

  } catch (error) {
    console.error('[Folder Rescan] Error:', error);
    alert(`Failed to rescan folder: ${error.message}`);
    if (scanStatusBar) scanStatusBar.classList.remove('scanning');
    if (scanProgress) scanProgress.textContent = 'Ready';
  }
}

// SAFETY: Count total items in a folder (recursive)
async function countFolderItems(folderId) {

  try {
    const folder = findFolderById(folderId, bookmarkTree);
    if (!folder || !folder.children) return 0;

    let count = 0;
    const countRecursive = (items) => {
      for (const item of items) {
        count++;
        if (item.children) {
          countRecursive(item.children);
        }
      }
    };
    countRecursive(folder.children);
    return count;
  } catch (error) {
    console.error('Error counting folder items:', error);
    return 0;
  }
}

// Helper to find folder by ID in mock data
function findFolderById(id, items) {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findFolderById(id, item.children);
      if (found) return found;
    }
  }
  return null;
}

// Delete folder
async function deleteFolder(id) {

  // SAFETY: Prevent deletion of Firefox's built-in bookmark folders
  const protectedFolderIds = ['menu________', 'toolbar_____', 'unfiled_____', 'mobile______'];
  if (protectedFolderIds.includes(id)) {
    alert('⚠ Cannot delete built-in Firefox bookmark folders (Bookmarks Menu, Bookmarks Toolbar, Other Bookmarks, Mobile Bookmarks).\n\nThis is a safety feature to protect your bookmark structure.');
    return;
  }

  try {
    // Get folder details before deleting for undo functionality
    const folder = findFolderById(id, bookmarkTree);
    if (!folder) {
      throw new Error('Folder not found');
    }

    // Find parent folder to get parentId (needed for restoration)
    const parent = findParentById(bookmarkTree, id);
    const parentId = parent ? parent.id : undefined;

    // Deep copy folder and add parentId for restoration
    const fullData = JSON.parse(JSON.stringify(folder));
    fullData.parentId = parentId;

    // Add to changelog before deleting (store complete folder data for restoration)
    await addChangelogEntry('delete', 'folder', folder.title || 'Untitled', null, {
      fullData: fullData
    });

    // Delete the folder
    await bookmarkManager.remove(id);

    // Add parentId to folder data for undo toast
    folder.parentId = parentId;

    // Show undo toast
    showUndoToast({
      type: 'folder',
      data: folder,
      message: `Folder "${folder.title || 'Untitled'}" deleted`
    });

    await loadBookmarks();
    renderBookmarks();

    /* [ZeroLabs] 2026-08-27 - added: ask about this deletion now */
    window.syncAfterLocalDeletion?.();
  } catch (error) {
    console.error('Error deleting folder:', error);
    alert('Failed to delete folder');
  }
}

// Undo System Functions

// Show undo toast with countdown
function showUndoToast(options) {
  // Clear any existing undo data and timers
  hideUndoToast();

  // Store the undo data
  undoData = options;

  // Update message
  undoMessage.textContent = options.message;

  // Show the toast
  undoToast.classList.remove('hidden');

  // Start countdown
  let countdown = 5;
  undoCountdownEl.textContent = countdown;

  undoCountdown = setInterval(() => {
    countdown--;
    undoCountdownEl.textContent = countdown;

    if (countdown <= 0) {
      hideUndoToast();
    }
  }, 1000);

  // Auto-hide after 5 seconds
  undoTimer = setTimeout(() => {
    hideUndoToast();
  }, 5000);
}

// Hide undo toast and clear timers
function hideUndoToast() {
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }

  if (undoCountdown) {
    clearInterval(undoCountdown);
    undoCountdown = null;
  }

  undoToast.classList.add('hidden');
  undoData = null;
}

// Undo the last deletion
/* [ZeroLabs] 2026-08-27 - added: restore one deleted item (shared by single and bulk undo) */
async function restoreDeletedItem(type, data) {
  /* [ZeroLabs] 2026-08-27 - added: the recorded index may no longer exist */
  // Deleting items at index 3, 5 and 7 leaves the folder with two children, so
  // restoring index 7 is out of range. Clamping puts it as close to where it was
  // as the folder now allows.
  //
  // A missing parent means an ancestor folder was deleted in the same batch and
  // has already been restored WITH this item inside it - creating it again would
  // duplicate it, so it is skipped.
  const parent = bookmarkManager.getFolder(data.parentId);
  if (!parent) {
    console.warn('[Undo] Parent no longer exists, already restored with it:', data.title);
    return;
  }
  const siblings = parent.children || [];
  const index = Math.min(
    typeof data.index === 'number' ? data.index : siblings.length,
    siblings.length
  );

  if (type === 'bookmark') {
    await bookmarkManager.create({
      title: data.title,
      url: data.url,
      parentId: data.parentId,
      index
    });
  } else if (type === 'folder') {
    await restoreFolderRecursive(data, data.parentId, index);
  }
}

async function performUndo() {
  if (!undoData) return;

  const { type, data, isPreview } = undoData;

  try {
    if (isPreview) {
      // Preview mode: restore to mock data
      if (type === 'bookmark') {
        // Restore bookmark to its parent array
        if (data.parentArray) {
          data.parentArray.splice(data.parentIndex, 0, {
            id: data.id,
            title: data.title,
            url: data.url
          });
        }
      } else if (type === 'folder') {
        // Restore folder with all children
        if (data.parentArray) {
          const folderToRestore = JSON.parse(JSON.stringify(data));
          delete folderToRestore.parentArray;
          delete folderToRestore.parentIndex;
          data.parentArray.splice(data.parentIndex, 0, folderToRestore);
        }
      }

      renderBookmarks();
      hideUndoToast();
      console.log(`Undo successful (preview): ${type} restored`);
    } else {
      // Real extension mode
      /* [ZeroLabs] 2026-08-27 - edited: one item or many, same restore */
      if (type === 'bulk') {
        /* [ZeroLabs] 2026-08-27 - added: ascending index, or the order comes back scrambled */
        const ordered = [...(data || [])].sort(
          (a, b) => (a.data.index || 0) - (b.data.index || 0));
        for (const entry of ordered) {
          await restoreDeletedItem(entry.type, entry.data);
        }
      } else {
        await restoreDeletedItem(type, data);
      }

      // Reload and hide toast
      await loadBookmarks();
      renderBookmarks();
      hideUndoToast();

      console.log(`Undo successful: ${type} restored`);
    }
  } catch (error) {
    console.error('Error during undo:', error);
    alert('Failed to undo deletion');
    hideUndoToast();
  }
}

// Recursively restore a folder and all its contents
async function restoreFolderRecursive(folderData, parentId, index) {
  // Create the folder
  const newFolder = await bookmarkManager.create({
    title: folderData.title,
    parentId: parentId,
    index: index,
    type: 'folder'
  });

  // Restore children if any
  if (folderData.children && folderData.children.length > 0) {
    for (let i = 0; i < folderData.children.length; i++) {
      const child = folderData.children[i];
      if (child.url) {
        // It's a bookmark
        await bookmarkManager.create({
          title: child.title,
          url: child.url,
          parentId: newFolder.id,
          index: i
        });
      } else {
        // It's a folder
        await restoreFolderRecursive(child, newFolder.id, i);
      }
    }
  }
}

// Adjust dropdown position to prevent overflow
function adjustDropdownPosition(dropdown) {
  if (!dropdown) return;

  // Reset any previous adjustments
  dropdown.style.left = '';
  dropdown.style.right = '';
  dropdown.style.transform = '';
  dropdown.style.top = '';
  dropdown.style.bottom = '';
  dropdown.style.marginTop = '';
  dropdown.style.marginBottom = '';

  // Wait for next frame to ensure menu is visible and has dimensions
  requestAnimationFrame(() => {
    const rect = dropdown.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Check horizontal overflow
    if (rect.right > viewportWidth) {
      // Menu extends beyond right edge
      const overflow = rect.right - viewportWidth;
      dropdown.style.right = '0';
      dropdown.style.transform = `translateX(-${overflow + 8}px)`;
    } else if (rect.left < 0) {
      // Menu extends beyond left edge
      dropdown.style.left = '0';
      dropdown.style.right = 'auto';
    }

    // Check vertical overflow
    if (rect.bottom > viewportHeight) {
      // Menu extends beyond bottom edge - show above button instead
      dropdown.style.top = 'auto';
      dropdown.style.bottom = '100%';
      dropdown.style.marginBottom = '4px';
      dropdown.style.marginTop = '0';
    }
  });
}

// Position dropdown menu with fixed positioning and overflow detection
function positionFixedDropdown(dropdown, button) {
  if (!dropdown || !button) return;

  const buttonRect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Set max width to prevent horizontal overflow
  dropdown.style.maxWidth = `${viewportWidth - 16}px`;

  // Position below button by default
  dropdown.style.position = 'fixed';
  dropdown.style.top = `${buttonRect.bottom + 4}px`;
  dropdown.style.right = `${viewportWidth - buttonRect.right}px`;
  dropdown.style.zIndex = '99999';

  // Wait for next frame to check if menu fits
  requestAnimationFrame(() => {
    const dropdownRect = dropdown.getBoundingClientRect();

    // Check if menu overflows bottom
    if (dropdownRect.bottom > viewportHeight - 8) {
      // Position above button instead
      dropdown.style.top = 'auto';
      dropdown.style.bottom = `${viewportHeight - buttonRect.top + 4}px`;
    }

    // Check horizontal overflow
    if (dropdownRect.left < 8) {
      // Constrain width if needed
      dropdown.style.maxWidth = `${buttonRect.right - 8}px`;
    }
  });
}

// Close all open menus
function closeAllMenus() {
  openMenuBookmarkId = null; // Clear tracked menu state
  closeContextMenuModal();

  // Close and reset toolbar menus
  [settingsMenu, themeMenu, viewMenu, zoomMenu].forEach(menu => {
    if (menu) {
      menu.classList.remove('show');
      // Delay resetting positioning styles until after the close transition completes
      setTimeout(() => {
        if (!menu.classList.contains('show')) {
          menu.style.position = '';
          menu.style.top = '';
          menu.style.bottom = '';
          menu.style.right = '';
          menu.style.maxWidth = '';
          menu.style.zIndex = '';
        }
      }, 200); // Match CSS transition duration
    }
  });
}

// NOTE: checkLinkStatus and checkSafetyStatus functions removed - dead code
// All scanning now happens via scanner service and Web Worker (scanner-worker.js)
// Browser API compatibility layer above (lines 43-50) was never actually called
window.updateBookmarkInTree = updateBookmarkInTree;
window.updateBookmarkStatusInDOM = updateBookmarkStatusInDOM;
window.renderBookmarks = renderBookmarks;

// Reload bookmark UI after sync operations - reloads from storage and re-renders
window.reloadBookmarkUI = async function() {
  await loadBookmarks();
  renderBookmarks();
};

// Recheck bookmark status (link + safety)
async function recheckBookmarkStatus(bookmarkId) {
  const bookmark = findBookmarkById(bookmarkTree, bookmarkId);
  if (!bookmark || !bookmark.url) {
    return;
  }

  // Skip if both checking types are disabled
  if (!linkCheckingEnabled && !safetyCheckingEnabled) {
    alert('Both link checking and safety checking are disabled.\n\nEnable at least one in Settings to recheck bookmark status.');
    return;
  }


  const checkingUpdates = {};
  if (linkCheckingEnabled) checkingUpdates.linkStatus = 'checking';
  if (safetyCheckingEnabled) checkingUpdates.safetyStatus = 'checking';
  updateBookmarkInTree(bookmarkId, checkingUpdates);
  renderBookmarks();

  // Use scanner service to perform the scan via Web Worker
  // The scanner service will handle blocklist readiness, API keys, etc.
  await scannerService.scanBookmark(bookmark, true); // Bypass cache for rescan

  console.log('[Recheck] Complete:', bookmark.title);
}

// Find bookmark by ID in tree
function findBookmarkById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'folder' && node.children) {
      const found = findBookmarkById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Update bookmark in tree
function updateBookmarkInTree(bookmarkId, updates) {
  const updateNode = (nodes) => {
    return nodes.map(node => {
      if (node.id === bookmarkId) {
        return { ...node, ...updates };
      }
      if (node.type === 'folder' && node.children) {
        return { ...node, children: updateNode(node.children) };
      }
      return node;
    });
  };
  bookmarkTree = updateNode(bookmarkTree);
}

// Update status indicators in DOM for a specific bookmark (without full re-render)
/* [ZeroLabs] 2026-08-18 12:32 AM - edited: update every copy of a bookmark (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
// A pinned or recently opened bookmark is in the DOM more than once under the
// same data-id. querySelector would only ever reach the first copy, leaving the
// others stuck on a stale scan result, so every match gets updated.
function updateBookmarkStatusInDOM(bookmarkId, linkStatus, safetyStatus, safetySources, url) {
  const matches = document.querySelectorAll(`.bookmark-item[data-id="${bookmarkId}"]`);
  if (!matches.length) return;
  matches.forEach(bookmarkElement => {
    applyStatusToElement(bookmarkElement, linkStatus, safetyStatus, safetySources, url);
  });
}

function applyStatusToElement(bookmarkElement, linkStatus, safetyStatus, safetySources, url) {
  // Update status indicators container (for list view)
  const statusIndicators = bookmarkElement.querySelector('.status-indicators');
  if (statusIndicators && (displayOptions.safetyStatus || displayOptions.liveStatus)) {
    let statusIndicatorsHtml = '';
    if (displayOptions.safetyStatus && safetyStatus) {
      statusIndicatorsHtml += getShieldHtml(safetyStatus, url, safetySources);
    }
    if (displayOptions.liveStatus && linkStatus) {
      statusIndicatorsHtml += getStatusDotHtml(linkStatus, url);
    }
    statusIndicators.innerHTML = statusIndicatorsHtml;
  }

  // Update top row indicators (for grid view)
  const topRow = bookmarkElement.querySelector('.bookmark-top-row');
  if (topRow) {
    // Update shield in top row
    if (displayOptions.safetyStatus && safetyStatus) {
      const shieldHtml = getShieldHtml(safetyStatus, url, safetySources);
      const shieldContainer = topRow.querySelector('.shield-indicator');
      if (shieldContainer) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = shieldHtml;
        const newShield = tempDiv.firstChild;
        if (newShield) {
          shieldContainer.replaceWith(newShield);
        }
      }
    }

    // Update link status in top row
    if (displayOptions.liveStatus && linkStatus) {
      const linkStatusHtml = getStatusDotHtml(linkStatus, url);
      const linkStatusContainer = topRow.querySelector('.status-icon');
      if (linkStatusContainer) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = linkStatusHtml;
        const newLinkStatus = tempDiv.firstChild;
        if (newLinkStatus) {
          linkStatusContainer.replaceWith(newLinkStatus);
        }
      }
    }
  }

  // FORCE IMMEDIATE DOM REFLOW to ensure visual update
  bookmarkElement.offsetHeight;
}

// Whitelist a bookmark (trust it regardless of safety checks)
async function whitelistBookmark(bookmark) {
  if (!bookmark || !bookmark.url) return;

  const hostname = new URL(bookmark.url).hostname;

  if (whitelistedUrls.has(hostname)) {
    const remove = confirm(`"${hostname}" is already whitelisted.\n\nDo you want to remove it from the whitelist?`);
    if (remove) {
      whitelistedUrls.delete(hostname);
      await saveWhitelist();
      alert(`Removed "${hostname}" from whitelist.\n\nIt will be scanned normally on next check.`);
      // Recheck the bookmark
      await recheckBookmarkStatus(bookmark.id);
    }
  } else {
    const confirm_add = confirm(`Add "${hostname}" to whitelist?\n\nWhitelisted sites are marked as safe regardless of security scan results.\n\nOnly whitelist sites you trust completely.`);
    if (confirm_add) {
      whitelistedUrls.add(hostname);
      await saveWhitelist();
      // Update safety status to safe
      updateBookmarkInTree(bookmark.id, {
        safetyStatus: 'safe',
        safetySources: ['Whitelisted by user']
      });
      renderBookmarks();
      alert(`"${hostname}" added to whitelist.\n\nAll bookmarks from this site will be marked as safe.`);
    }
  }
}

// Save whitelist to storage
async function saveWhitelist() {
  try {
    await safeStorage.set({
      whitelistedUrls: Array.from(whitelistedUrls)
    });
  } catch (error) {
    console.error('Failed to save whitelist:', error);
  }
}

// Load whitelist from storage
async function loadWhitelist() {
  try {
    const result = await safeStorage.get('whitelistedUrls');
    if (result.whitelistedUrls && Array.isArray(result.whitelistedUrls)) {
      whitelistedUrls = new Set(result.whitelistedUrls);
      console.log(`Loaded ${whitelistedUrls.size} whitelisted URLs`);
    }
  } catch (error) {
    console.error('Failed to load whitelist:', error);
  }
}

// Save safety history to storage
async function saveSafetyHistory() {
  try {
    await safeStorage.set({ safetyHistory: JSON.stringify(safetyHistory) });
  } catch (error) {
    console.error('Failed to save safety history:', error);
  }
}

// Load safety history from storage
async function loadSafetyHistory() {
  try {
    const result = await safeStorage.get('safetyHistory');
    if (result.safetyHistory) {
      try {
        safetyHistory = JSON.parse(result.safetyHistory);
        console.log(`Loaded safety history for ${Object.keys(safetyHistory).length} URLs`);
      } catch (parseError) {
        // Old corrupted data - clear it and start fresh
        console.log('[Safety History] Migrating to new storage format...');
        safetyHistory = {};
        await saveSafetyHistory(); // Save empty object in correct format to overwrite bad data
      }
    }
  } catch (error) {
    console.error('Failed to load safety history:', error);
  }
}

// Clean up safetyHistory to remove entries for URLs no longer in bookmarks
function cleanupSafetyHistory() {
  if (!bookmarkTree || bookmarkTree.length === 0) return;

  // Ensure safetyHistory is a valid plain object (not null, not array)
  if (!safetyHistory || Array.isArray(safetyHistory) || typeof safetyHistory !== 'object') {
    console.warn('[Memory Cleanup] safetyHistory is not a valid object, resetting to {}');
    safetyHistory = {};
    saveSafetyHistory();
    return;
  }

  // Collect all current bookmark URLs
  const currentUrls = new Set();
  const collectUrls = (nodes) => {
    nodes.forEach(node => {
      if (node.url) {
        currentUrls.add(node.url);
      }
      if (node.children) {
        collectUrls(node.children);
      }
    });
  };
  collectUrls(bookmarkTree);

  // Create a new object with only URLs that still exist
  const newSafetyHistory = {};
  let removedCount = 0;

  for (const url in safetyHistory) {
    if (safetyHistory.hasOwnProperty(url)) {
      if (currentUrls.has(url)) {
        newSafetyHistory[url] = safetyHistory[url];
      } else {
        removedCount++;
      }
    }
  }

  if (removedCount > 0) {
    safetyHistory = newSafetyHistory;
    console.log(`[Memory Cleanup] Removed ${removedCount} stale entries from safetyHistory`);
    saveSafetyHistory(); // Persist the cleanup
  }
}

// Track safety status change and alert if degraded
function trackSafetyChange(url, newStatus, sources) {
  if (!url) return;

  const timestamp = Date.now();

  // Initialize history for this URL if needed
  if (!safetyHistory[url]) {
    safetyHistory[url] = [];
  }

  const history = safetyHistory[url];
  const lastStatus = history.length > 0 ? history[history.length - 1].status : null;

  // Only track if status has actually changed
  if (lastStatus === newStatus) {
    return; // No change, skip adding duplicate entry
  }

  // Add new entry only when status changes
  history.push({ timestamp, status: newStatus, sources });

  // Keep only last 10 entries per URL
  if (history.length > 10) {
    history.shift();
  }

  // Alert if status degraded from safe to unsafe/suspicious
  if (lastStatus === 'safe' && (newStatus === 'unsafe' || newStatus === 'suspicious')) {
    const hostname = new URL(url).hostname;
    console.warn(`⚠️ Security alert: ${hostname} changed from safe to ${newStatus}`);

    // Show alert to user
    setTimeout(() => {
      const message = `⚠️ SECURITY ALERT\n\n"${hostname}" was previously marked as SAFE but is now flagged as ${newStatus.toUpperCase()}!\n\nSources: ${sources.join(', ')}\n\nPlease verify this site before visiting.`;
      alert(message);
    }, 100);
  }

  // Save history only when status changes
  saveSafetyHistory();
}

// Handle bookmark actions
async function handleBookmarkAction(action, bookmark) {
  switch (action) {
    /* [ZeroLabs] 2026-08-18 12:32 AM - added: quick access pin actions */
    case 'pin-quick-access':
      pinBookmark(bookmark);
      break;

    /* [ZeroLabs] 2026-08-19 5:23 PM - edited: confirm before unpinning */
    case 'unpin-quick-access': {
      // Unpin only. The bookmark itself is never touched from here, and the
      // message says so, because the red styling would otherwise imply deletion.
      const pinLabel = bookmark.title || bookmark.url;
      if (!confirm(`Remove "${pinLabel}" from Quick Access?\n\nThis only unpins it. The bookmark itself will not be deleted.`)) {
        break;
      }
      unpinUrl(bookmark.url);
      break;
    }

    case 'open':
      // Open in new tab (website version always opens in new tab)
      /* [ZeroLabs] 2026-08-18 12:32 AM - added: track recent opens */
      recordRecentOpen(bookmark.url);
      window.open(bookmark.url, '_blank');
      break;

    case 'open-new-tab':
      openBookmarkUrl(bookmark.url, true);
      break;

    case 'open-new-window':
      // Open in new window
      /* [ZeroLabs] 2026-08-18 12:32 AM - added: track recent opens */
      recordRecentOpen(bookmark.url);
      window.open(bookmark.url, '_blank', 'noopener,noreferrer');
      break;

    case 'reader-view':
      // Open in text-only view using Textise
      const textiseUrl = `https://www.textise.net/showText.aspx?strURL=${encodeURIComponent(bookmark.url)}`;
      window.open(textiseUrl, '_blank');
      break;

    case 'save-pdf':
      // Save page as PDF - open page and show instructions
      window.open(bookmark.url, '_blank');
      setTimeout(() => {
        alert('Page opened in a new tab. To save as PDF:\n\n1. Wait for the page to load\n2. Press Ctrl+P (or Cmd+P on Mac)\n3. Select "Save as PDF" as the destination\n4. Click "Save"');
      }, 500);
      break;

    case 'edit':
      editBookmark(bookmark);
      break;

    case 'recheck':
      await recheckBookmarkStatus(bookmark.id);
      break;

    case 'whitelist':
      await whitelistBookmark(bookmark);
      break;

    case 'virustotal':
      // Extract domain from URL and open VirusTotal search
      try {
        const domain = new URL(bookmark.url).hostname;
        const vtUrl = `https://www.virustotal.com/gui/search/${domain}`;
        window.open(vtUrl, '_blank');
      } catch (error) {
        console.error('Error opening VirusTotal:', error);
        alert('Failed to open VirusTotal. Invalid URL.');
      }
      break;

    case 'qr-code':
      // Generate and show QR code for bookmark URL (local, privacy-focused)
      showQRCodePopup(bookmark.url);
      break;

    case 'wayback-save':
      // Save to Wayback Machine - open the save page with URL pre-filled
      {
        // Wayback's save page doesn't accept URL in path, so we copy URL first
        // and open their save page where user can paste and submit
        try {
          await navigator.clipboard.writeText(bookmark.url);
          const waybackSaveUrl = 'https://web.archive.org/save';
          window.open(waybackSaveUrl, '_blank');
          // Brief notification that URL was copied
          setTimeout(() => {
            alert(`URL copied to clipboard!\n\n"${bookmark.url}"\n\nPaste it into the Wayback Machine save page that just opened.`);
          }, 100);
        } catch (error) {
          console.error('Error copying URL:', error);
          // Fallback: just open the save page
          const waybackSaveUrl = 'https://web.archive.org/save';
          window.open(waybackSaveUrl, '_blank');
        }
      }
      break;

    case 'wayback-browse':
      // Browse Wayback Machine snapshots
      {
        const waybackBrowseUrl = `https://web.archive.org/web/*/${bookmark.url}`;
        window.open(waybackBrowseUrl, '_blank');
      }
      break;

    case 'copy-url':
      // Copy URL to clipboard
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(bookmark.url);
          // Show brief success feedback
          console.log('URL copied to clipboard:', bookmark.url);
          // Optional: Could show a toast notification here
        } else {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = bookmark.url;
          textArea.style.position = 'fixed';
          textArea.style.left = '-999999px';
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
          console.log('URL copied to clipboard (fallback):', bookmark.url);
        }
      } catch (error) {
        console.error('Error copying URL:', error);
        alert('Failed to copy URL to clipboard.');
      }
      break;

    case 'edit':
      openEditModal(bookmark, false);
      break;

    case 'move-to':
      openMoveToModal(bookmark, false);
      break;

    case 'delete':
      if (confirm(`Delete "${bookmark.title}"?`)) {
        await deleteBookmark(bookmark.id, bookmark);
      }
      break;
  }
}

// Open edit modal
function openEditModal(item, isFolder = false) {
  currentEditItem = item;

  const modal = document.getElementById('editModal');
  const modalTitle = document.getElementById('editModalTitle');
  const editTitle = document.getElementById('editTitle');
  const editUrl = document.getElementById('editUrl');
  const editUrlGroup = document.getElementById('editUrlGroup');

  // Set modal title
  modalTitle.textContent = isFolder ? 'Rename Folder' : 'Edit Bookmark';

  // Populate fields
  editTitle.value = item.title || '';

  if (isFolder) {
    // Hide URL field for folders
    editUrlGroup.style.display = 'none';
  } else {
    // Show URL field for bookmarks
    editUrlGroup.style.display = 'block';
    editUrl.value = item.url || '';
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close edit modal
function closeEditModal() {
  const modal = document.getElementById('editModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
  currentEditItem = null;
}

// Save edit modal
async function saveEditModal() {
  if (!currentEditItem) return;

  const editTitle = document.getElementById('editTitle');
  const editUrl = document.getElementById('editUrl');

  const isFolder = !currentEditItem.url;
  const updates = { title: editTitle.value };

  if (!isFolder) {
    let url = editUrl.value.trim();
    /* [ZeroLabs] 2026-08-27 - edited: same warning the add dialog gives */
    // Editing could break a working bookmark exactly the way adding could - a
    // pasted address with a stray space saved and synced with no warning, then
    // rejected by every stricter client. No swap offered here: the bookmark
    // already has a title, so a mixed-up pair is not the likely cause.
    if (url) {
      const check = classifyBookmarkUrl(url);
      if (check.problem) {
        const choice = await showUrlWarningDialog({
          typed: check.typed,
          problem: check.problem,
          canSwap: false
        });
        if (choice !== 'save') return;
      }
      url = check.url;
    }
    updates.url = url;
  }


  try {
    // Log changes
    const oldTitle = currentEditItem.title;
    const oldUrl = currentEditItem.url;
    const itemType = isFolder ? 'folder' : 'bookmark';

    await bookmarkManager.update(currentEditItem.id, updates);

    // Add to changelog
    const changeDetails = {};
    if (oldTitle !== updates.title) {
      changeDetails.oldTitle = oldTitle;
      changeDetails.newTitle = updates.title;
    }
    if (!isFolder && oldUrl !== updates.url) {
      changeDetails.oldUrl = oldUrl;
      changeDetails.newUrl = updates.url;
    }

    if (Object.keys(changeDetails).length > 0) {
      await addChangelogEntry('update', itemType, updates.title, updates.url, changeDetails);
    }

    await loadBookmarks();
    renderBookmarks();
    closeEditModal();
  } catch (error) {
    console.error('Error updating:', error);
    alert('Failed to update ' + (isFolder ? 'folder' : 'bookmark'));
  }
}

// Edit bookmark (legacy wrapper)
async function editBookmark(bookmark) {
  openEditModal(bookmark, false);
}

// Delete bookmark
async function deleteBookmark(id, bookmarkData = null) {

  try {
    // Get bookmark details before deleting for undo functionality
    // Use provided bookmarkData if available, otherwise search the tree
    let bookmark = bookmarkData;
    if (!bookmark) {
      bookmark = findBookmarkById(id, bookmarkTree);
      if (!bookmark) {
        throw new Error('Bookmark not found in tree');
      }
    }

    // Find parent folder to get parentId (needed for restoration)
    const parent = findParentById(bookmarkTree, id);
    const parentId = parent ? parent.id : undefined;

    // Deep copy bookmark and add parentId for restoration
    const fullData = JSON.parse(JSON.stringify(bookmark));
    fullData.parentId = parentId;

    // Add to changelog before deleting (store complete bookmark data for restoration)
    await addChangelogEntry('delete', 'bookmark', bookmark.title || 'Untitled', bookmark.url, {
      fullData: fullData
    });

    // Delete the bookmark
    await bookmarkManager.remove(id);

    // Add parentId to bookmark data for undo toast
    bookmark.parentId = parentId;

    // Show undo toast
    showUndoToast({
      type: 'bookmark',
      data: bookmark,
      message: `Bookmark "${bookmark.title || 'Untitled'}" deleted`
    });

    await loadBookmarks();
    renderBookmarks();

    /* [ZeroLabs] 2026-08-27 - added: ask about this deletion now */
    window.syncAfterLocalDeletion?.();
  } catch (error) {
    console.error('Error deleting bookmark:', error);
    alert('Failed to delete bookmark');
  }
}

// Build folder list for dropdowns
function buildFolderList(nodes, indent = 0) {
  const folders = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      folders.push({
        id: node.id,
        title: '  '.repeat(indent) + (node.title || node.name || 'Unnamed Folder'),
        indent
      });
      if (node.children) {
        folders.push(...buildFolderList(node.children, indent + 1));
      }
    }
  }
  return folders;
}

// Populate folder dropdown
function populateFolderDropdown(selectElement, sortAlphabetically = false) {
  let folders = buildFolderList(bookmarkTree);

  // Sort alphabetically if requested
  if (sortAlphabetically) {
    folders.sort((a, b) => {
      // Remove indentation for comparison
      const titleA = a.title.trim().toLowerCase();
      const titleB = b.title.trim().toLowerCase();
      return titleA.localeCompare(titleB);
    });
  }

  selectElement.innerHTML = '<option value="">Root</option>';
  folders.forEach(folder => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.title;
    selectElement.appendChild(option);
  });
}

/* [ZeroLabs] 2026-08-09 1:31 PM - added: recent saved-into folder helpers */
// Recent folder IDs that still exist as options in the dropdown
function getValidRecentFolders(selectElement) {
  return getRecentFolders().filter(id =>
    selectElement.querySelector(`option[value="${CSS.escape(id)}"]`)
  );
}

// Pick the default target folder: most recent saved-into, then legacy last-used,
// then Bookmarks Menu, then the first real folder
function applyDefaultBookmarkFolder(selectElement) {
  const recent = getValidRecentFolders(selectElement);
  if (recent.length > 0) {
    selectElement.value = recent[0];
    return;
  }

  const lastUsedFolder = safeLocalStorage.getItem('lastBookmarkFolder');
  if (lastUsedFolder && selectElement.querySelector(`option[value="${CSS.escape(lastUsedFolder)}"]`)) {
    selectElement.value = lastUsedFolder;
    return;
  }

  // Find Bookmarks Menu folder (usually has 'menu' in the ID)
  const menuOption = Array.from(selectElement.options).find(opt =>
    opt.value.includes('menu') || opt.textContent.toLowerCase().includes('bookmarks menu')
  );
  if (menuOption) {
    selectElement.value = menuOption.value;
  } else if (selectElement.options.length > 1) {
    // Fallback to first non-root option
    selectElement.selectedIndex = 1;
  }
}

// Render the other recently saved-into folders as quick-pick chips
function renderRecentFolderChips(selectElement) {
  const row = document.getElementById('recentFoldersRow');
  if (!row) return;

  // Skip the first entry - it is already the dropdown default
  const others = getValidRecentFolders(selectElement).slice(1, 6);

  if (others.length === 0) {
    row.classList.add('hidden');
    row.innerHTML = '<span class="recent-folders-label">Recently saved to</span>';
    return;
  }

  row.classList.remove('hidden');
  row.innerHTML = '<span class="recent-folders-label">Recently saved to</span>';

  others.forEach(id => {
    const folder = bookmarkManager.getFolder(id);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-folder-chip';
    chip.dataset.folderId = id;
    chip.textContent = folder?.title || 'Unnamed Folder';
    chip.title = chip.textContent;
    if (selectElement.value === id) chip.classList.add('active');
    /* [ZeroLabs] 2026-08-09 1:43 PM - edited: route through the shared selection setter */
    chip.addEventListener('click', () => setSelectedFolder(selectElement, id));
    row.appendChild(chip);
  });

  // Attach the sync-highlight listener once, not on every re-render
  if (!selectElement.dataset.chipSyncBound) {
    selectElement.dataset.chipSyncBound = 'true';
    selectElement.addEventListener('change', () => {
      row.querySelectorAll('.recent-folder-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.folderId === selectElement.value);
      });
    });
  }
}

// Open add bookmark modal
async function openAddBookmarkModal() {
  const modal = document.getElementById('addBookmarkModal');
  const titleInput = document.getElementById('newBookmarkTitle');
  const urlInput = document.getElementById('newBookmarkUrl');
  const folderSelect = document.getElementById('newBookmarkFolder');

  // Try to get the current active tab to pre-populate fields
  // Website version: cannot access current tab info, leave fields empty

  // Load sort preference and populate dropdown
  const sortCheckbox = document.getElementById('sortBookmarkFoldersAlpha');
  const sortPref = safeLocalStorage.getItem('sortFoldersAlphabetically') === 'true';
  sortCheckbox.checked = sortPref;
  populateFolderDropdown(folderSelect, sortPref);

  // Set default folder - prefer most recently saved into, then Bookmarks Menu, then first available
  /* [ZeroLabs] 2026-08-09 1:31 PM - edited: default to most recent saved-into folder */
  applyDefaultBookmarkFolder(folderSelect);
  renderRecentFolderChips(folderSelect);
  /* [ZeroLabs] 2026-08-09 1:43 PM - added: sync the tree picker to the selection */
  initFolderPicker(folderSelect);

  // Add event listener for sort checkbox
  sortCheckbox.addEventListener('change', (e) => {
    const sortAlpha = e.target.checked;
    safeLocalStorage.setItem('sortFoldersAlphabetically', sortAlpha);
    const previous = folderSelect.value;
    populateFolderDropdown(folderSelect, sortAlpha);
    if (previous && folderSelect.querySelector(`option[value="${previous}"]`)) {
      folderSelect.value = previous;
    }
    renderRecentFolderChips(folderSelect);
    renderFolderTreePicker(folderSelect);
  });

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
  // Select all text in title for easy editing
  titleInput.select();
}

// Close add bookmark modal
function closeAddBookmarkModal() {
  const modal = document.getElementById('addBookmarkModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
  /* [ZeroLabs] 2026-08-09 1:31 PM - added: reset share status on close */
  clearShareStatus();
  clearShareDuplicateNotice();

  // In a share window the modal is the whole point, so dismissing it by any
  // route (Cancel, the X, or a completed save) dismisses the window itself
  if (window.__bmzShareMode && !shareFlow.closing) {
    shareFlow.closing = true;
    if (window.BMZAndroid && typeof window.BMZAndroid.closeShareWindow === 'function') {
      // Tell the host whether anything was actually written, so the main
      // window only reloads its in-memory tree when it has gone stale
      window.BMZAndroid.closeShareWindow(shareFlow.saved);
    }
  }
}

/* [ZeroLabs] 2026-08-09 1:31 PM - added: share-to-BMZ flow (pull, save, push) */

// Tracks the in-flight background pull started when the share window opens
const shareFlow = {
  pullPromise: null,
  pullError: null,
  saved: false,
  closing: false,
  /* [ZeroLabs] 2026-08-19 6:01 PM - added: captured deletion conflict */
  conflictDiff: null,
  conflictRemote: null,
  /* [ZeroLabs] 2026-08-19 7:12 PM - added: captured divergence nudge and totals */
  nudgeMessage: null,
  nudgeDiff: null,
  localCount: null,
  remoteCount: null,
  watchdog: null
};

/* [ZeroLabs] 2026-08-19 6:01 PM - added: capture sync conflicts inside the share window */
// syncFromRemote emits this and then returns false. In share mode the generic
// full-app conflict dialog is suppressed (see app.js) and the diff is handled
// inline instead, so the decision can be made without leaving the share window.
window.addEventListener('sync:syncConflict', (e) => {
  if (!window.__bmzShareMode) return;
  shareFlow.conflictDiff = e.detail?.diff || null;
  shareFlow.conflictRemote = e.detail?.remoteData || null;
  /* [ZeroLabs] 2026-08-19 7:12 PM - added: capture the totals */
  shareFlow.localCount = e.detail?.localCount ?? null;
  shareFlow.remoteCount = e.detail?.remoteCount ?? null;
});

/* [ZeroLabs] 2026-08-19 7:12 PM - added: capture the divergence nudge too */
// Emitted when versions match but content differs. Carries a message string
// only, no diff, so the share window can warn but cannot list bookmarks.
window.addEventListener('sync:syncNudge', (e) => {
  if (!window.__bmzShareMode) return;
  /* [ZeroLabs] 2026-08-19 7:12 PM - edited: take the diff and totals, drop the text */
  // The stock message ends with "Open GitLab sync to reconcile", which is wrong
  // here: the share window has both sync buttons right underneath it. The
  // wording is rebuilt locally from the structured fields instead.
  if (e.detail && typeof e.detail === 'object') {
    shareFlow.nudgeDiff = e.detail.diff || null;
    shareFlow.localCount = e.detail.localCount ?? null;
    shareFlow.remoteCount = e.detail.remoteCount ?? null;
    shareFlow.nudgeMessage = 'differs';
  } else {
    shareFlow.nudgeMessage = typeof e.detail === 'string' ? e.detail : null;
  }
});

/* [ZeroLabs] 2026-08-09 1:43 PM - added: expandable folder tree picker */

// Which parent folders are currently expanded in the picker panel
const folderPicker = { expanded: new Set() };

// Ancestor folder IDs of a folder, nearest parent first
function getFolderAncestorPath(folderId) {
  const path = [];
  let current = folderId;
  let guard = 0;

  while (current && guard++ < 200) {
    const parent = findParentById(bookmarkTree, current);
    if (!parent) break;
    path.push(parent.id);
    current = parent.id;
  }

  return path;
}

// Show the full path of the selected folder on the picker button
async function updateFolderPickerLabel(select) {
  const valueEl = document.getElementById('newBookmarkFolderValue');
  if (!valueEl) return;

  if (!select.value) {
    valueEl.textContent = 'Select a folder';
    return;
  }

  valueEl.textContent = await getFolderPath(select.value);
}

// Single place that changes the target folder, so the hidden select, the
// button label, the chips and the tree rows can never disagree
function setSelectedFolder(select, folderId) {
  select.value = folderId;
  updateFolderPickerLabel(select);

  const chipRow = document.getElementById('recentFoldersRow');
  if (chipRow) {
    chipRow.querySelectorAll('.recent-folder-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.folderId === folderId);
    });
  }

  const panel = document.getElementById('newBookmarkFolderPanel');
  if (panel) {
    panel.querySelectorAll('.folder-picker-row').forEach(row => {
      row.classList.toggle('selected', row.dataset.folderId === folderId);
    });
  }

  closeFolderPickerPanel();
}

// Build the indented, expandable folder tree
function renderFolderTreePicker(select) {
  const panel = document.getElementById('newBookmarkFolderPanel');
  if (!panel) return;

  const sortAlpha = safeLocalStorage.getItem('sortFoldersAlphabetically') === 'true';
  panel.innerHTML = '';

  const addRows = (nodes, depth) => {
    if (!Array.isArray(nodes)) return;

    let folders = nodes.filter(node => node.type === 'folder');
    if (sortAlpha) {
      folders = folders.slice().sort((a, b) =>
        (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
      );
    }

    for (const folder of folders) {
      const childFolders = (folder.children || []).filter(child => child.type === 'folder');
      const isExpanded = folderPicker.expanded.has(folder.id);

      const row = document.createElement('div');
      row.className = 'folder-picker-row' + (select.value === folder.id ? ' selected' : '');
      row.dataset.folderId = folder.id;
      row.style.paddingLeft = (10 + depth * 16) + 'px';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(select.value === folder.id));

      // Expanding a parent is a separate hit target from selecting it,
      // the same way the folder list behaves in the main app
      const twisty = document.createElement('button');
      twisty.type = 'button';
      twisty.className = 'folder-picker-twisty'
        + (childFolders.length ? (isExpanded ? ' expanded' : '') : ' leaf');
      twisty.textContent = String.fromCharCode(0x25B6);

      if (childFolders.length) {
        twisty.setAttribute('aria-label', isExpanded ? 'Collapse folder' : 'Expand folder');
        twisty.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isExpanded) {
            folderPicker.expanded.delete(folder.id);
          } else {
            folderPicker.expanded.add(folder.id);
          }
          renderFolderTreePicker(select);
        });
      } else {
        twisty.tabIndex = -1;
      }
      row.appendChild(twisty);

      const name = document.createElement('span');
      name.className = 'folder-picker-name';
      name.textContent = folder.title || 'Unnamed Folder';
      row.appendChild(name);

      row.addEventListener('click', () => setSelectedFolder(select, folder.id));
      panel.appendChild(row);

      if (isExpanded && childFolders.length) {
        addRows(folder.children, depth + 1);
      }
    }
  };

  addRows(bookmarkTree, 0);
}

function openFolderPickerPanel(select) {
  const panel = document.getElementById('newBookmarkFolderPanel');
  const toggle = document.getElementById('newBookmarkFolderToggle');
  if (!panel || !toggle) return;

  // Reveal the current selection rather than making the user hunt for it
  getFolderAncestorPath(select.value).forEach(id => folderPicker.expanded.add(id));
  renderFolderTreePicker(select);

  panel.classList.remove('hidden');
  toggle.setAttribute('aria-expanded', 'true');

  const selectedRow = panel.querySelector('.folder-picker-row.selected');
  if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
}

function closeFolderPickerPanel() {
  const panel = document.getElementById('newBookmarkFolderPanel');
  const toggle = document.getElementById('newBookmarkFolderToggle');
  if (panel) panel.classList.add('hidden');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// Bind the picker once and sync it to the current selection
function initFolderPicker(select) {
  const toggle = document.getElementById('newBookmarkFolderToggle');
  if (!toggle) return;

  if (!toggle.dataset.bound) {
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', () => {
      const panel = document.getElementById('newBookmarkFolderPanel');
      if (panel && panel.classList.contains('hidden')) {
        openFolderPickerPanel(select);
      } else {
        closeFolderPickerPanel();
      }
    });
  }

  closeFolderPickerPanel();
  updateFolderPickerLabel(select);
}

// Normalize a URL so trivial differences do not hide a real duplicate.
// Protocol, a leading www., and a trailing slash are ignored; query and
// fragment are kept because they can address different pages.
function normalizeUrlForCompare(url) {
  if (!url) return '';
  let value = url.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/^www\./, '');
  value = value.replace(/\/+$/, '');
  return value;
}

// Every existing bookmark pointing at the same page
function findDuplicateBookmarks(url) {
  const target = normalizeUrlForCompare(url);
  if (!target) return [];

  const matches = [];
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === 'bookmark' && node.url && normalizeUrlForCompare(node.url) === target) {
        matches.push(node);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(bookmarkTree);

  return matches;
}

// Show or hide the inline "already bookmarked" subtitle under the URL field
async function updateShareDuplicateNotice(url) {
  const notice = document.getElementById('shareDuplicateNotice');
  const textEl = notice?.querySelector('.share-duplicate-text');
  const toggle = document.getElementById('shareDuplicateToggle');
  const pathList = document.getElementById('shareDuplicatePaths');
  if (!notice || !textEl || !toggle || !pathList) return;

  const matches = findDuplicateBookmarks(url);

  if (matches.length === 0) {
    notice.classList.add('hidden');
    pathList.classList.add('hidden');
    pathList.innerHTML = '';
    toggle.textContent = 'Show location';
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }

  textEl.textContent = matches.length === 1
    ? 'This site is already in your bookmarks.'
    : `This site is already in your bookmarks (${matches.length} copies).`;

  // Resolve the full folder path for each copy
  const paths = [];
  for (const match of matches) {
    const parent = findParentById(bookmarkTree, match.id);
    const path = parent ? await getFolderPath(parent.id) : 'Root';
    paths.push({ path, title: match.title });
  }

  pathList.innerHTML = '';
  paths.forEach(entry => {
    const li = document.createElement('li');
    li.textContent = `${entry.path} / ${entry.title}`;
    pathList.appendChild(li);
  });

  toggle.textContent = matches.length === 1 ? 'Show location' : 'Show locations';
  toggle.setAttribute('aria-expanded', 'false');
  pathList.classList.add('hidden');
  notice.classList.remove('hidden');
}

function clearShareDuplicateNotice() {
  const notice = document.getElementById('shareDuplicateNotice');
  const pathList = document.getElementById('shareDuplicatePaths');
  if (notice) notice.classList.add('hidden');
  if (pathList) {
    pathList.classList.add('hidden');
    pathList.innerHTML = '';
  }
}

// Render a status line inside the add-bookmark modal, with optional action buttons
/* [ZeroLabs] 2026-08-19 6:01 PM - edited: optional details list */
// details is a plain array of strings, rendered as a scrollable list. Used to
// name the bookmarks a sync would delete, so the choice is made against the
// actual titles rather than just a count.
function setShareStatus(kind, stage, reason, actions = [], details = []) {
  const el = document.getElementById('addBookmarkStatus');
  if (!el) return;

  el.className = `share-status ${kind}`;
  el.querySelector('.share-status-stage').textContent = stage || '';

  const reasonEl = el.querySelector('.share-status-reason');
  reasonEl.textContent = reason || '';
  reasonEl.style.display = reason ? '' : 'none';

  const detailsEl = el.querySelector('.share-status-details');
  if (detailsEl) {
    detailsEl.innerHTML = '';
    details.forEach(text => {
      const li = document.createElement('li');
      li.textContent = text; // textContent, never innerHTML: these are bookmark titles
      detailsEl.appendChild(li);
    });
    detailsEl.style.display = details.length ? 'block' : 'none';
  }

  const actionsEl = el.querySelector('.share-status-actions');
  actionsEl.innerHTML = '';
  actions.forEach(action => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = action.primary ? 'btn btn-primary' : 'btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    actionsEl.appendChild(btn);
  });
  actionsEl.style.display = actions.length ? '' : 'none';
}

function clearShareStatus() {
  const el = document.getElementById('addBookmarkStatus');
  if (!el) return;
  el.className = 'share-status hidden';
  el.querySelector('.share-status-stage').textContent = '';
  el.querySelector('.share-status-reason').textContent = '';
  el.querySelector('.share-status-actions').innerHTML = '';
  /* [ZeroLabs] 2026-08-19 6:01 PM - added: clear the details list too */
  const detailsEl = el.querySelector('.share-status-details');
  if (detailsEl) {
    detailsEl.innerHTML = '';
    detailsEl.style.display = 'none';
  }
}

function setShareSaveEnabled(enabled) {
  const saveBtn = document.getElementById('addBookmarkModalSave');
  if (saveBtn) saveBtn.disabled = !enabled;
}

// Turn a thrown value into something worth showing the user
function describeSyncError(error) {
  const message = (error && error.message) ? error.message : String(error || 'Unknown error');
  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return 'Could not reach GitLab. Check your connection.';
  }
  if (/rate limit/i.test(message)) {
    return message;
  }
  if (/not found/i.test(message)) {
    return 'The GitLab snippet no longer exists. Open BMZ and set up sync again.';
  }
  if (/401|403|unauthorized|forbidden/i.test(message)) {
    return 'GitLab rejected the request. Your token may have expired.';
  }
  return message;
}

// True when a remote is configured and we are expected to sync
function isRemoteConfigured() {
  return !!syncManager.getRemoteId();
}

// Stage 1: pull the latest tree so we never push a stale one back over it
async function runSharePull() {
  if (!isRemoteConfigured()) return { skipped: true, reason: 'local-only' };

  if (!navigator.onLine) {
    throw new Error('This device is offline.');
  }

  /* [ZeroLabs] 2026-08-27 - edited: reconcile instead of the version-gated pull (see also: Bookmark-Manager-Zero-Chrome/background.js) */
  // The old syncFromRemote returned false in three different situations that
  // meant very different things, and the share flow had to read captured events
  // to tell them apart. The reconcile answers directly: it adds what is missing
  // on either side and returns deferred only when something would be removed or
  // overwritten, which is exactly the case this window has to put to the user.
  // push: false - stage 3 pushes once the bookmark has been saved, so publishing
  // here as well would write to GitLab twice for one share.
  const outcome = await syncManager.reconcileWithSnippet({ push: false });

  if (outcome.deferred) {
    // Handed over as-is: the share window presents the same three categories the
    // consent dialog does, so there is nothing to reshape.
    shareFlow.conflictDiff = outcome;
    try {
      const localTree = await syncManager.loadLocalBookmarks();
      const remoteTree = await snippetAdapter.readBookmarks(syncManager.getRemoteId());
      shareFlow.localCount = syncManager.countBookmarksInTree(localTree);
      shareFlow.remoteCount = syncManager.countBookmarksInTree(remoteTree);
    } catch (e) {
      // Totals are decoration; the deferral still has to be shown without them
    }
    return { conflict: true, diff: outcome };
  }

  await bookmarkManager.reload();
  await loadBookmarks();

  // Refresh the folder picker against the freshly pulled tree
  const folderSelect = document.getElementById('newBookmarkFolder');
  if (folderSelect) {
    const previous = folderSelect.value;
    const sortPref = safeLocalStorage.getItem('sortFoldersAlphabetically') === 'true';
    populateFolderDropdown(folderSelect, sortPref);
    if (previous && folderSelect.querySelector(`option[value="${CSS.escape(previous)}"]`)) {
      folderSelect.value = previous;
    } else {
      applyDefaultBookmarkFolder(folderSelect);
    }
    renderRecentFolderChips(folderSelect);
    /* [ZeroLabs] 2026-08-09 1:43 PM - added: refresh picker against pulled tree */
    updateFolderPickerLabel(folderSelect);
    renderFolderTreePicker(folderSelect);
  }

  // The pulled tree may contain copies this device had not seen yet
  const urlInput = document.getElementById('newBookmarkUrl');
  if (urlInput) await updateShareDuplicateNotice(urlInput.value);

  return { skipped: false };
}

/* [ZeroLabs] 2026-08-27 - removed: shareTotalsSentence (dead) */
// It appended "Cloud has 340 bookmarks, this device has 342" to the old share
// conflict wording. The window now states the same operations the consent dialog
// states, and that dialog does not show totals either - the point of this rewrite
// was that both surfaces say the same thing.

/* [ZeroLabs] 2026-08-27 - removed: showShareDiverged (dead) */
// It rendered the 'versions match but content differs' state, which came from
// syncFromRemote's syncNudge event. The share window runs the reconcile now, and
// that reports a real deferral with its categories instead - there is no longer a
// vaguer middle state for this to describe.

/* [ZeroLabs] 2026-08-27 - edited: the share window follows the same policy as the app */
// This used to offer "Sync from Cloud to Device" and "Sync from Device to Cloud",
// the two blunt directional overwrites the main app dropped: each one destroys
// whatever the losing side holds alone, which is exactly what the deferral model
// exists to avoid. The share window now says what the main dialog says, in the
// same words, and offers the same Approve - apply these specific changes, then
// carry on and save.
//
// It is a small floating window, so this renders into the inline status panel
// rather than a modal, and the list is capped hard.
function showShareConflict(deferral) {
  const fromSnippet = (deferral && deferral.removesFromSnippet) || [];
  const fromDevice = (deferral && deferral.removesFromDevice) || [];
  const overwrites = (deferral && deferral.overwritesOnDevice) || [];

  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* [ZeroLabs] 2026-08-27 - added: account for the safe additions here too */
  // The full app's dialog reports these behind a chevron. This window has no room
  // for a collapsible, so they go in the sentence - but they still have to be
  // reported, because bookmarks quietly arriving while the panel asks about
  // something else is even less explicable on a phone.
  const addedHere = (deferral && deferral.addedHere) || [];
  const pendingPush = (deferral && deferral.pendingPush) || [];

  // Same three operation lines the consent dialog uses, same order, same wording -
  // but each one carries ITS OWN items. A single pooled list underneath left you
  // unable to tell which bookmark belonged to which operation the moment either
  // group held more than one.
  const MAX_PER_GROUP = 5;
  const describe = (item, showRename) => {
    const title = item.title || item.url || 'Untitled';
    const path = item.path ? `  (${item.path})` : '';
    const renamed = showRename && item.remoteTitle && item.remoteTitle !== item.title
      ? `  \u2192 ${item.remoteTitle}` : '';
    return `    ${title}${path}${renamed}`;
  };
  const block = (sentence, items, showRename) => {
    const shown = items.slice(0, MAX_PER_GROUP).map(i => describe(i, showRename));
    if (items.length > MAX_PER_GROUP) {
      shown.push(`    and ${items.length - MAX_PER_GROUP} more`);
    }
    return [`\u2022 ${sentence}`].concat(shown).join('\n');
  };

  const blocks = [];
  if (pendingPush.length) {
    blocks.push(block(
      `Add ${count(pendingPush.length, 'bookmark', 'bookmarks')} from this device to your Snippet.`,
      pendingPush, false));
  }
  if (fromSnippet.length) {
    blocks.push(block(
      `Remove ${count(fromSnippet.length, 'bookmark', 'bookmarks')} from your Snippet to match this device.`,
      fromSnippet, false));
  }
  if (fromDevice.length) {
    blocks.push(block(
      `Remove ${count(fromDevice.length, 'bookmark', 'bookmarks')} from this device to match the Snippet.`,
      fromDevice, false));
  }
  if (overwrites.length) {
    blocks.push(block(
      `Rename or move ${count(overwrites.length, 'bookmark', 'bookmarks')} on this device to match the Snippet.`,
      overwrites, true));
  }

  const already = addedHere.length
    ? `Already added ${count(addedHere.length, 'bookmark', 'bookmarks')} to this device.\n\n`
    : '';

  setShareStatus(
    'error',
    'Sync changes to review',
    already + 'Syncing would:\n' + blocks.join('\n\n'),
    [
      { label: 'Approve', primary: true, onClick: () => approveShareSync(deferral) },
      {
        label: 'Save on this device only',
        onClick: () => {
          const titleInput = document.getElementById('newBookmarkTitle');
          const urlInput = document.getElementById('newBookmarkUrl');
          const folderSelect = document.getElementById('newBookmarkFolder');
          saveSharedBookmarkLocalOnly(
            titleInput ? titleInput.value : '',
            urlInput ? urlInput.value : '',
            folderSelect ? folderSelect.value : null
          );
        }
      }
    ]
    // No details list: each operation now carries its own items inline, so a
    // second pooled list underneath would repeat them without their grouping.
  );

  setShareSaveEnabled(false);
}

// Apply what was approved, then hand control back to the form rather than saving
// automatically: applying can move or delete the folder that was selected, and
// can change whether this URL is already a duplicate.
/* [ZeroLabs] 2026-08-27 - edited: one Approve instead of two directional overwrites */
async function approveShareSync(deferral) {
  setShareStatus('info', 'Applying changes...', '');
  setShareSaveEnabled(false);

  try {
    // Exactly what the main app's Approve does: apply the local side, then push,
    // which is what carries a deletion made here out to the Snippet.
    await syncManager.applyHeldResolution({
      fromDevice: (deferral && deferral.removesFromDevice) || [],
      overwrites: (deferral && deferral.overwritesOnDevice) || []
    });
    await bookmarkManager.reload();
    await loadBookmarks();
    await syncManager.pushLocalToSnippet();

    shareFlow.conflictDiff = null;
    shareFlow.pullError = null;
    shareFlow.pullPromise = Promise.resolve({ skipped: false });

    // The tree may have changed under the form, so rebuild the picker and the
    // duplicate notice before letting the save proceed.
    const folderSelect = document.getElementById('newBookmarkFolder');
    if (folderSelect) {
      const previous = folderSelect.value;
      const sortPref = safeLocalStorage.getItem('sortFoldersAlphabetically') === 'true';
      populateFolderDropdown(folderSelect, sortPref);
      if (previous && folderSelect.querySelector(`option[value="${CSS.escape(previous)}"]`)) {
        folderSelect.value = previous;
      } else {
        applyDefaultBookmarkFolder(folderSelect);
      }
      renderRecentFolderChips(folderSelect);
      updateFolderPickerLabel(folderSelect);
      renderFolderTreePicker(folderSelect);
    }

    const urlInput = document.getElementById('newBookmarkUrl');
    if (urlInput) await updateShareDuplicateNotice(urlInput.value);

    setShareStatus('success', 'Changes applied', 'Check the folder below, then save.');
    setShareSaveEnabled(true);
  } catch (error) {
    console.error('[Share] Could not apply the approved changes:', error);
    setShareStatus(
      'error',
      'Could not finish that sync',
      describeSyncError(error),
      [
        { label: 'Try again', primary: true, onClick: () => approveShareSync(deferral) },
        { label: 'Back', onClick: () => showShareConflict(deferral) }
      ]
    );
    setShareSaveEnabled(false);
  }
}

// Kick off the pull in the background while the user reviews the form
function startSharePull() {
  shareFlow.pullError = null;
  /* [ZeroLabs] 2026-08-19 6:01 PM - added: reset captured conflict on each attempt */
  shareFlow.conflictDiff = null;
  shareFlow.conflictRemote = null;
  shareFlow.nudgeMessage = null;
  shareFlow.nudgeDiff = null;
  shareFlow.localCount = null;
  shareFlow.remoteCount = null;

  if (!isRemoteConfigured()) {
    shareFlow.pullPromise = Promise.resolve({ skipped: true });
    clearShareStatus();
    return;
  }

  setShareStatus('info', 'Checking cloud for latest bookmarks...', '');

  shareFlow.pullPromise = runSharePull()
    .then(result => {
      /* [ZeroLabs] 2026-08-19 6:01 PM - added: surface a conflict instead of clearing */
      if (result && result.conflict) {
        showShareConflict(result.diff);
        return result;
      }
      clearShareStatus();
      return result;
    })
    .catch(error => {
      console.error('[Share] Pull failed:', error);
      shareFlow.pullError = error;
      setShareStatus(
        'error',
        'Could not fetch your latest bookmarks',
        describeSyncError(error),
        [
          { label: 'Retry', primary: true, onClick: () => startSharePull() }
        ]
      );
      return { failed: true };
    });
}

// Open the add-bookmark modal prefilled from an Android share intent
async function openShareBookmarkModal(url, title) {
  window.__bmzShareMode = true;
  /* [ZeroLabs] 2026-08-28 - added: set the class here too, not only the flag */
  // app.js adds share-mode when it parses the intent, but this function only set
  // the JS flag. Anything that reaches the share modal without going through that
  // parse got the flag without the class, and the class is what the stylesheet
  // keys off - so the tree picker stayed hidden and the native select showed
  // through, which Android renders as a full-screen list rather than a dropdown.
  document.documentElement.classList.add('share-mode');

  await openAddBookmarkModal();

  const titleInput = document.getElementById('newBookmarkTitle');
  const urlInput = document.getElementById('newBookmarkUrl');
  const modalTitle = document.getElementById('addBookmarkModalTitle');
  const saveBtn = document.getElementById('addBookmarkModalSave');

  /* [ZeroLabs] 2026-08-09 1:43 PM - edited: short title so it clears the X on any screen */
  if (modalTitle) modalTitle.textContent = 'Save to BMZ';
  if (saveBtn) saveBtn.textContent = 'Save Bookmark';
  if (urlInput) urlInput.value = url || '';
  if (titleInput) {
    titleInput.value = title || '';
    titleInput.select();
  }

  // Inline duplicate notice, refreshed as the URL is edited
  const toggle = document.getElementById('shareDuplicateToggle');
  const pathList = document.getElementById('shareDuplicatePaths');
  if (toggle && pathList && !toggle.dataset.bound) {
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', () => {
      const showing = !pathList.classList.toggle('hidden');
      const count = pathList.children.length;
      const noun = count === 1 ? 'location' : 'locations';
      toggle.textContent = showing ? `Hide ${noun}` : `Show ${noun}`;
      toggle.setAttribute('aria-expanded', String(showing));
    });
  }

  if (urlInput && !urlInput.dataset.dupBound) {
    urlInput.dataset.dupBound = 'true';
    let dupTimer = null;
    urlInput.addEventListener('input', () => {
      clearTimeout(dupTimer);
      dupTimer = setTimeout(() => updateShareDuplicateNotice(urlInput.value), 250);
    });
  }

  await updateShareDuplicateNotice(url);

  startSharePull();
}

// Stage 3: push the new bookmark up. Force is safe here because we just pulled.
async function runSharePush() {
  if (!isRemoteConfigured()) return { skipped: true };

  if (!navigator.onLine) {
    throw new Error('This device is offline.');
  }

  /* [ZeroLabs] 2026-08-27 - edited: pushLocalToSnippet, which throws on failure */
  // syncToRemote could return early without throwing, which is why the pending
  // flag had to be re-checked afterwards. This one either writes or raises, and
  // a straight push is still correct here because stage 1 just reconciled.
  await syncManager.pushLocalToSnippet();

  return { skipped: false };
}

// Push with retry UI. The bookmark is already saved locally by this point.
async function pushSharedBookmark(folderPath) {
  if (!isRemoteConfigured()) {
    finishShare(`Saved to ${folderPath}`);
    return;
  }

  setShareStatus('info', 'Syncing to GitLab...', '');
  setShareSaveEnabled(false);

  /* [ZeroLabs] 2026-08-19 6:01 PM - added: watchdog so a slow push explains itself */
  // The bookmark is already saved locally at this point. The request is NOT
  // cancelled here, it keeps running and can still succeed; this only stops the
  // window from sitting on "Syncing to GitLab..." with no explanation. The hard
  // abort lives in snippet-adapter's fetch timeout.
  clearTimeout(shareFlow.watchdog);
  shareFlow.watchdog = setTimeout(() => {
    setShareStatus(
      'info',
      'Still syncing to GitLab',
      'This is taking longer than usual. Your bookmark is already saved on this device, so you can close this and it will sync next time BMZ opens.',
      [
        { label: 'Keep waiting', primary: true, onClick: () => {} },
        { label: 'Close', onClick: () => finishShare(null) }
      ]
    );
  }, 10000);

  try {
    await runSharePush();
    clearTimeout(shareFlow.watchdog);
    finishShare(`Saved to ${folderPath} and synced`);
  } catch (error) {
    clearTimeout(shareFlow.watchdog);
    console.error('[Share] Push failed:', error);
    await syncManager.markPendingChanges(true);
    setShareStatus(
      'error',
      'Saved on this device, but the sync to GitLab failed',
      `${describeSyncError(error)} It will sync the next time BMZ opens.`,
      [
        { label: 'Retry sync', primary: true, onClick: () => pushSharedBookmark(folderPath) },
        { label: 'Close', onClick: () => finishShare(null) }
      ]
    );
    setShareSaveEnabled(true);
  }
}

// Report success and hand control back to the Android host if present
function finishShare(successMessage) {
  if (successMessage) {
    setShareStatus('success', successMessage, '');
  }

  // closeAddBookmarkModal is the single exit point and dismisses the host window
  setTimeout(closeAddBookmarkModal, successMessage ? 900 : 0);
}

// Stage 2 wrapper: wait on the pull, write the bookmark, then push
async function saveSharedBookmark(title, url, parentId) {
  setShareSaveEnabled(false);

  try {
    // Wait for the background pull before touching the tree
    const pullResult = await (shareFlow.pullPromise || Promise.resolve({ skipped: true }));

    /* [ZeroLabs] 2026-08-19 6:01 PM - added: block the save while a conflict is unresolved */
    // Without this the save would run on a stale tree and then force-push it,
    // undoing the deletions that exist on the cloud.
    if (pullResult && pullResult.conflict) {
      showShareConflict(pullResult.diff);
      return;
    }

    if (pullResult && pullResult.failed) {
      setShareStatus(
        'error',
        'Not synced with the cloud yet',
        `${describeSyncError(shareFlow.pullError)} Saving now risks overwriting changes made on your other devices.`,
        [
          {
            label: 'Retry sync',
            primary: true,
            onClick: async () => {
              startSharePull();
              setShareSaveEnabled(true);
            }
          },
          {
            label: 'Save on this device only',
            onClick: () => saveSharedBookmarkLocalOnly(title, url, parentId)
          }
        ]
      );
      setShareSaveEnabled(true);
      return;
    }

    setShareStatus('info', 'Saving bookmark...', '');

    const folderPath = await createSharedBookmark(title, url, parentId);
    await pushSharedBookmark(folderPath);
  } catch (error) {
    console.error('[Share] Save failed:', error);
    setShareStatus(
      'error',
      'Could not save the bookmark',
      describeSyncError(error),
      [
        { label: 'Retry', primary: true, onClick: () => saveSharedBookmark(title, url, parentId) }
      ]
    );
    setShareSaveEnabled(true);
  }
}

// Explicit user choice: skip the cloud, write locally, leave it pending
async function saveSharedBookmarkLocalOnly(title, url, parentId) {
  setShareSaveEnabled(false);
  setShareStatus('info', 'Saving on this device...', '');

  try {
    const folderPath = await createSharedBookmark(title, url, parentId);
    await syncManager.markPendingChanges(true);
    finishShare(`Saved to ${folderPath} on this device. It will sync later.`);
  } catch (error) {
    console.error('[Share] Local-only save failed:', error);
    setShareStatus(
      'error',
      'Could not save the bookmark',
      describeSyncError(error),
      [
        { label: 'Retry', primary: true, onClick: () => saveSharedBookmarkLocalOnly(title, url, parentId) }
      ]
    );
    setShareSaveEnabled(true);
  }
}

// Shared write step used by both the synced and local-only share paths
async function createSharedBookmark(title, url, parentId) {
  const newBookmark = await bookmarkManager.create({
    title: title || url,
    url,
    parentId
  });

  shareFlow.saved = true;

  const folderPath = parentId ? await getFolderPath(parentId) : 'Root';
  await addChangelogEntry('create', 'bookmark', newBookmark.title, newBookmark.url, { folderPath });

  recordRecentFolder(parentId);
  safeLocalStorage.setItem('lastBookmarkFolder', parentId);

  await loadBookmarks();
  renderBookmarks();

  return folderPath;
}

/* [ZeroLabs] 2026-08-27 - added: a deletion asks now, not whenever you next open BMZ (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
// Deleting defers for consent, and that consent used to wait for the 30s
// debounce and then sit as an amber card - so the deletion simply did not reach
// the snippet until BMZ was next opened, possibly days later. This runs the same
// reconcile in the foreground, so the modal appears while you are still looking
// at what you deleted and the change can go straight out.
//
// Delayed past the 5s undo window: the modal must not land on top of the undo
// toast, and undoing makes the whole question moot. The timer is shared, so
// deleting several in a row asks once rather than once per bookmark.
let localDeleteSyncTimer = null;
function syncAfterLocalDeletion() {
  clearTimeout(localDeleteSyncTimer);
  localDeleteSyncTimer = setTimeout(async () => {
    if (!syncManager.getRemoteId() || !navigator.onLine) return;
    try {
      const outcome = await syncManager.reconcileWithSnippet();
      if (outcome && outcome.deferred) {
        await window.app?.showHeldPushDialog();
      }
    } catch (error) {
      console.error('[Sync] Post-delete sync failed:', error);
    }
  }, 6000);
}
window.syncAfterLocalDeletion = syncAfterLocalDeletion;

/* [ZeroLabs] 2026-08-27 - added: warn on a doubtful address, never block it */
// A bookmark saved with a malformed address does not just fail here - it syncs,
// and then every stricter client rejects it. Firefox refuses to create it at all
// and raises the unplaceable-items dialog on every sync until it is deleted.
//
// But this only ever WARNS. Nonsense is the user's to save if they want it.
function classifyBookmarkUrl(typed) {
  const raw = (typed || '').trim();
  let url = raw;
  let weAddedScheme = false;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
  // "localhost:3000" and "myserver:8080" match the scheme pattern but are really
  // host:port. Without this they were stored as scheme "localhost:" and broke.
  const isHostPort = /^[a-zA-Z][a-zA-Z0-9+.-]*:\d/.test(url);
  if (!hasScheme || isHostPort) {
    url = 'https://' + url;
    weAddedScheme = true;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    // Nothing can store this - the dot check below cannot even run, since there
    // is no parsed host to inspect.
    return { url, typed: raw, problem: 'invalid' };
  }

  // Only suspicious when WE supplied the scheme. A scheme the user typed
  // themselves - about:, chrome://, file:// - was meant, and those legitimately
  // have no dot. An absent host is schemeless by design, not dotless.
  const host = parsed.hostname;
  if (weAddedScheme && host && !host.includes('.') && host !== 'localhost' && !host.startsWith('[')) {
    return { url, typed: raw, problem: 'nodot' };
  }

  return { url, typed: raw, problem: null };
}

// Resolves to 'save', 'swap' or 'edit'.
function showUrlWarningDialog({ typed, problem, canSwap }) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10003;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.className = 'bmz-dialog';
    dialog.style.cssText = 'background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:440px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);';

    const esc = (t) => String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // A space almost always means the two fields were swapped, so that one asks
    // outright. A dotless host is usually a typo, where swapping would rarely
    // be the right answer, so it only suggests editing.
    const reason = problem === 'invalid'
      ? `"${esc(typed)}" isn't a valid link. Did you mix up the address and the title?`
      : `"${esc(typed)}" has no domain ending like .com. If that wasn't intended, change it before saving.`;

    const btn = (id, label, primary) => `
      <button id="${id}" style="width:100%;padding:12px;border-radius:8px;border:none;cursor:pointer;font-size:14px;${primary
        ? 'background:#f59e0b;color:#1a1a1a;font-weight:600;'
        : 'background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);'}">${label}</button>`;

    dialog.innerHTML = `
      <h2 style="margin:0 0 12px 0;font-size:18px;color:#f59e0b;text-align:center;">That doesn't look like a web address</h2>
      <p style="margin:0 0 20px 0;font-size:14px;">${reason}</p>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${canSwap ? btn('urlWarnSwap', 'Swap them for me', true) : ''}
        ${btn('urlWarnSave', 'Save it anyway', !canSwap)}
        ${btn('urlWarnEdit', 'Go back and edit', false)}
      </div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    const done = (choice) => { modal.remove(); resolve(choice); };
    dialog.querySelector('#urlWarnSwap')?.addEventListener('click', () => done('swap'));
    dialog.querySelector('#urlWarnSave').addEventListener('click', () => done('save'));
    dialog.querySelector('#urlWarnEdit').addEventListener('click', () => done('edit'));
    modal.addEventListener('click', (e) => { if (e.target === modal) done('edit'); });
  });
}

// Save new bookmark
async function saveNewBookmark() {
  const title = document.getElementById('newBookmarkTitle').value;
  let url = document.getElementById('newBookmarkUrl').value.trim();
  const parentId = document.getElementById('newBookmarkFolder').value || undefined;

  if (!url) {
    alert('Please enter a URL');
    return;
  }

  /* [ZeroLabs] 2026-08-27 - edited: warn and offer a fix, instead of refusing */
  // This used to alert and return, which blocked the save outright. Nonsense is
  // the user's to keep if they want it; what matters is that they are told, and
  // offered the swap that is usually the actual fix.
  const check = classifyBookmarkUrl(url);
  if (check.problem) {
    const titleEl = document.getElementById('newBookmarkTitle');
    const choice = await showUrlWarningDialog({
      typed: check.typed,
      problem: check.problem,
      // Swapping into an empty title would hand back a blank address, which is
      // worse than what they started with.
      canSwap: !!(titleEl && titleEl.value.trim())
    });
    if (choice === 'edit') return;
    if (choice === 'swap') {
      const oldTitle = titleEl.value;
      titleEl.value = check.typed;
      document.getElementById('newBookmarkUrl').value = oldTitle;
      // Re-run, so a swap that is still wrong asks again rather than saving quietly
      return saveNewBookmark();
    }
  }
  url = check.url;

  // Check if trying to create bookmark at root level
  if (!parentId) {
    alert('Firefox does not allow creating bookmarks at the root level. Please select a parent folder (Bookmarks Menu, Bookmarks Toolbar, Other Bookmarks, or any existing folder/subfolder) to create your bookmark in.');
    return;
  }


  try {
    /* [ZeroLabs] 2026-08-09 1:31 PM - added: share flow owns pull/save/push */
    // Share mode shows duplicates inline under the URL field instead of
    // blocking on a confirm dialog, so it skips the prompt below
    if (window.__bmzShareMode) {
      await saveSharedBookmark(title, url, parentId);
      return;
    }

    // SAFETY: Check for duplicate bookmarks to prevent accidental duplication
    const existingBookmarks = bookmarkManager.search(url);
    if (existingBookmarks.length > 0) {
      const duplicateInfo = existingBookmarks.map(b => `  • "${b.title}" in folder ${b.parentId}`).join('\n');
      const confirmed = confirm(
        `⚠ Warning: This URL already exists in your bookmarks:\n\n${duplicateInfo}\n\nDo you want to create a duplicate bookmark anyway?`
      );
      if (!confirmed) {
        closeAddBookmarkModal();
        return;
      }
    }

    const newBookmark = await bookmarkManager.create({
      title: title || url,
      url,
      parentId
    });

    // Add to changelog
    const folderPath = parentId ? await getFolderPath(parentId) : 'Root';
    await addChangelogEntry('create', 'bookmark', newBookmark.title, newBookmark.url, { folderPath });

    // Remember the selected folder for next time
    /* [ZeroLabs] 2026-08-09 1:31 PM - edited: also feed the recent folder MRU */
    if (parentId) {
      safeLocalStorage.setItem('lastBookmarkFolder', parentId);
      recordRecentFolder(parentId);
    }

    await loadBookmarks();
    renderBookmarks();
    closeAddBookmarkModal();
  } catch (error) {
    console.error('Error creating bookmark:', error);
    alert('Failed to create bookmark');
  }
}

// Open add folder modal
function openAddFolderModal() {
  const modal = document.getElementById('addFolderModal');
  const nameInput = document.getElementById('newFolderName');
  const parentSelect = document.getElementById('newFolderParent');

  nameInput.value = '';

  // Load sort preference and populate dropdown
  const sortCheckbox = document.getElementById('sortFolderParentsAlpha');
  const sortPref = safeLocalStorage.getItem('sortFoldersAlphabetically') === 'true';
  sortCheckbox.checked = sortPref;
  populateFolderDropdown(parentSelect, sortPref);

  // Set default folder - prefer last used, then Bookmarks Menu, then first available
  const lastUsedParent = safeLocalStorage.getItem('lastFolderParent');
  if (lastUsedParent && parentSelect.querySelector(`option[value="${lastUsedParent}"]`)) {
    parentSelect.value = lastUsedParent;
  } else {
    // Find Bookmarks Menu folder (usually has 'menu' in the ID)
    const menuOption = Array.from(parentSelect.options).find(opt =>
      opt.value.includes('menu') || opt.textContent.toLowerCase().includes('bookmarks menu')
    );
    if (menuOption) {
      parentSelect.value = menuOption.value;
    } else if (parentSelect.options.length > 1) {
      // Fallback to first non-root option
      parentSelect.selectedIndex = 1;
    }
  }

  // Add event listener for sort checkbox
  sortCheckbox.addEventListener('change', (e) => {
    const sortAlpha = e.target.checked;
    safeLocalStorage.setItem('sortFoldersAlphabetically', sortAlpha);
    populateFolderDropdown(parentSelect, sortAlpha);
  });

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close add folder modal
function closeAddFolderModal() {
  const modal = document.getElementById('addFolderModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Save new folder
async function saveNewFolder() {
  const title = document.getElementById('newFolderName').value;
  const parentId = document.getElementById('newFolderParent').value || undefined;

  if (!title) {
    alert('Please enter a folder name');
    return;
  }

  // Check if trying to create folder at root level
  if (!parentId) {
    alert('Firefox does not allow creating folders at the root level. Please select a parent folder (Bookmarks Menu, Bookmarks Toolbar, Other Bookmarks, or any existing folder/subfolder) to create your folder in.');
    return;
  }


  try {
    const newFolder = await bookmarkManager.create({
      title,
      type: 'folder',
      parentId
    });

    // Add to changelog
    const folderPath = parentId ? await getFolderPath(parentId) : 'Root';
    await addChangelogEntry('create', 'folder', newFolder.title, null, { folderPath });

    // Remember the selected parent folder for next time
    if (parentId) {
      safeLocalStorage.setItem('lastFolderParent', parentId);
    }

    await loadBookmarks();
    renderBookmarks();
    closeAddFolderModal();
  } catch (error) {
    console.error('Error creating folder:', error);
    alert('Failed to create folder');
  }
}

// Track item being moved for the Move To modal
let moveToItem = null;
let moveToIsFolder = false;

// Collect all descendant IDs from in-memory tree node
function collectDescendantIds(node, ids = new Set()) {
  ids.add(node.id);
  if (node.children) {
    for (const child of node.children) {
      collectDescendantIds(child, ids);
    }
  }
  return ids;
}

// Open move-to modal
async function openMoveToModal(item, isFolder) {
  // Prevent moving root-level folders
  const rootFolderIds = ['bookmarks_menu', 'bookmarks_toolbar', 'bookmarks_unfiled', 'root________'];
  if (isFolder && rootFolderIds.includes(item.id)) {
    alert('Cannot move built-in root bookmark folders.');
    return;
  }

  moveToItem = item;
  moveToIsFolder = isFolder;

  const modal = document.getElementById('moveToModal');
  const itemNameDisplay = document.getElementById('moveToItemName');
  const folderSelect = document.getElementById('moveToFolder');
  const sortCheckbox = document.getElementById('sortMoveToFoldersAlpha');

  // Show item name
  const itemLabel = isFolder ? `\uD83D\uDCC1 ${item.title || 'Unnamed Folder'}` : (item.title || 'Unnamed Bookmark');
  itemNameDisplay.textContent = itemLabel;

  // Load sort preference and populate dropdown
  const sortPref = localStorage.getItem('sortFoldersAlphabetically') === 'true';
  sortCheckbox.checked = sortPref;
  populateFolderDropdown(folderSelect, sortPref);

  // Remove the "Root" option — website doesn't support root-level placement
  const rootOption = folderSelect.querySelector('option[value=""]');
  if (rootOption) rootOption.remove();

  // If moving a folder, remove itself and all its descendants from the dropdown
  if (isFolder) {
    const treeNode = findBookmarkById(bookmarkTree, item.id);
    if (treeNode) {
      const descendantIds = collectDescendantIds(treeNode);
      Array.from(folderSelect.options).forEach(option => {
        if (descendantIds.has(option.value)) {
          option.remove();
        }
      });
    }
  }

  // Pre-select the item's current parent folder
  const parent = findParentById(bookmarkTree, item.id);
  if (parent && folderSelect.querySelector(`option[value="${parent.id}"]`)) {
    folderSelect.value = parent.id;
  } else if (folderSelect.options.length > 0) {
    folderSelect.selectedIndex = 0;
  }

  // Sort checkbox handler
  const sortHandler = (e) => {
    const sortAlpha = e.target.checked;
    localStorage.setItem('sortFoldersAlphabetically', sortAlpha);
    populateFolderDropdown(folderSelect, sortAlpha);
    const rootOpt = folderSelect.querySelector('option[value=""]');
    if (rootOpt) rootOpt.remove();

    if (isFolder) {
      const treeNode = findBookmarkById(bookmarkTree, item.id);
      if (treeNode) {
        const descendantIds = collectDescendantIds(treeNode);
        Array.from(folderSelect.options).forEach(option => {
          if (descendantIds.has(option.value)) {
            option.remove();
          }
        });
      }
    }

    const parentNode = findParentById(bookmarkTree, item.id);
    if (parentNode && folderSelect.querySelector(`option[value="${parentNode.id}"]`)) {
      folderSelect.value = parentNode.id;
    }
  };

  sortCheckbox.removeEventListener('change', sortCheckbox._moveToHandler);
  sortCheckbox._moveToHandler = sortHandler;
  sortCheckbox.addEventListener('change', sortHandler);

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close move-to modal
function closeMoveToModal() {
  const modal = document.getElementById('moveToModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
  moveToItem = null;
  moveToIsFolder = false;
}

// Execute the move
async function saveMoveToModal() {
  if (!moveToItem) return;

  const folderSelect = document.getElementById('moveToFolder');
  const destinationId = folderSelect.value;

  if (!destinationId) {
    alert('Please select a destination folder.');
    return;
  }

  // Check if destination is the same as current parent
  const currentParent = findParentById(bookmarkTree, moveToItem.id);
  if (currentParent && destinationId === currentParent.id) {
    alert('The item is already in this folder.');
    return;
  }

  try {
    const fromFolder = currentParent ? await getFolderPath(currentParent.id) : 'Root';

    await bookmarkManager.move(moveToItem.id, { parentId: destinationId });

    const toFolder = await getFolderPath(destinationId);
    const itemType = moveToItem.url ? 'bookmark' : 'folder';
    await addChangelogEntry('move', itemType, moveToItem.title, moveToItem.url || null, {
      fromFolder,
      toFolder
    });

    /* [ZeroLabs] 2026-08-09 1:31 PM - added: moving a bookmark counts as saving into a folder */
    if (itemType === 'bookmark') {
      recordRecentFolder(destinationId);
    }

    closeMoveToModal();
    await loadBookmarks();
    renderBookmarks();
  } catch (error) {
    console.error('Error moving item:', error);
    alert('Failed to move item: ' + error.message);
  }
}

// Legacy function wrappers for compatibility
async function createNewBookmark() {
  openAddBookmarkModal();
}

async function createNewFolder() {
  openAddFolderModal();
}

// Filter and search bookmarks
function filterAndSearchBookmarks(nodes) {
  return nodes.reduce((acc, node) => {
    // Skip separators (Firefox toolbar separators have type: 'separator')
    if (node.type === 'separator') {
      return acc;
    }

    if (node.type === 'folder') {
      const filteredChildren = filterAndSearchBookmarks(node.children || []);
      if (filteredChildren.length > 0 || (!searchTerm && activeFilters.length === 0)) {
        acc.push({
          ...node,
          children: filteredChildren
        });
      }
    } else if (node.url) {
      if (matchesSearch(node) && matchesFilter(node)) {
        acc.push(node);
      }
    }
    return acc;
  }, []);
}

// Check if bookmark matches search
function matchesSearch(bookmark) {
  if (!searchTerm) return true;

  const term = searchTerm.toLowerCase();
  return (
    (bookmark.title && bookmark.title.toLowerCase().includes(term)) ||
    (bookmark.url && bookmark.url.toLowerCase().includes(term))
  );
}

// Check if bookmark matches filter
function matchesFilter(bookmark) {
  if (activeFilters.length === 0) return true;

  const linkStatus = bookmark.linkStatus || 'unknown';
  const safetyStatus = bookmark.safetyStatus || 'unknown';

  // Separate filters by category
  const linkFilters = activeFilters.filter(f => ['live', 'parked', 'dead'].includes(f));
  const safetyFilters = activeFilters.filter(f => ['safe', 'suspicious', 'unsafe', 'whitelisted'].includes(f));

  // Check link status (OR within category)
  let matchesLink = true;
  if (linkFilters.length > 0) {
    matchesLink = linkFilters.some(filter => {
      switch (filter) {
        case 'live': return linkStatus === 'live';
        case 'parked': return linkStatus === 'parked';
        case 'dead': return linkStatus === 'dead';
        default: return false;
      }
    });
  }

  // Check safety status (OR within category)
  let matchesSafety = true;
  if (safetyFilters.length > 0) {
    matchesSafety = safetyFilters.some(filter => {
      switch (filter) {
        case 'safe': return safetyStatus === 'safe';
        case 'suspicious': return safetyStatus === 'warning';
        case 'unsafe': return safetyStatus === 'unsafe';
        case 'whitelisted': return bookmark.safetySources && bookmark.safetySources.includes('Whitelisted by user');
        default: return false;
      }
    });
  }

  // AND between categories
  return matchesLink && matchesSafety;
}

// Count bookmarks in folder
function countBookmarks(folder) {
  if (!folder.children) return 0;

  return folder.children.reduce((count, child) => {
    if (child.type === 'folder') {
      return count + countBookmarks(child);
    } else if (child.url && child.type !== 'separator') {
      return count + 1;
    }
    return count;
  }, 0);
}

// Get all folders recursively for start folder dropdown
function getAllFolders(nodes, depth = 0, folders = []) {
  nodes.forEach(node => {
    if (node.children) {
      const indent = '  '.repeat(depth);
      folders.push({
        id: node.id,
        title: indent + (node.title || 'Unnamed Folder'),
        depth: depth
      });
      getAllFolders(node.children, depth + 1, folders);
    }
  });
  return folders;
}

// Find a folder by ID in the bookmark tree
function findFolderByIdInTree(nodes, folderId) {
  for (const node of nodes) {
    if (node.id === folderId && node.children) {
      return node;
    }
    if (node.children) {
      const found = findFolderByIdInTree(node.children, folderId);
      if (found) return found;
    }
  }
  return null;
}

// Get favicon URL
function getFaviconUrl(url) {
  try {
    // Basic URL validation first
    if (!url || typeof url !== 'string') {
      return '';
    }

    // Trim whitespace and check for basic structure
    const trimmedUrl = url.trim();
    if (!trimmedUrl || !trimmedUrl.includes('.')) {
      return '';
    }

    const urlObj = new URL(trimmedUrl);

    // Validate hostname - must be non-empty and not localhost/private
    const hostname = urlObj.hostname;
    if (!hostname || hostname.length === 0) {
      return '';
    }

    // Skip localhost and private IP ranges
    if (hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.') ||
        hostname.includes('local')) {
      return '';
    }

    // Skip very short hostnames (likely invalid)
    if (hostname.length < 4) {
      return '';
    }

    // Skip hostnames that are just IP addresses (too generic, often no favicon)
    const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    if (ipRegex.test(hostname)) {
      return '';
    }

    // Skip HTTP URLs (many don't have favicons and create unnecessary 404s)
    if (urlObj.protocol === 'http:') {
      return '';
    }

    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return '';
  }
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show error message
function showError(message) {
  bookmarkList.innerHTML = `
    <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-error);">
      <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
      <div style="font-size: 14px;">${escapeHtml(message)}</div>
    </div>
  `;
}

// Open extension in new tab
async function openInNewTab() {

  try {
    // In website version, just reload the current page
    window.location.reload();
  } catch (error) {
    console.error('Error opening in new tab:', error);
    alert('Failed to open in new tab');
  }
}

// Convert bookmark tree to HTML format
function bookmarksToHTML(bookmarkNodes, indent = 0) {
  let html = '';
  const indentStr = '    '.repeat(indent);

  for (const node of bookmarkNodes) {
    if (node.url) {
      // It's a bookmark
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : '';
      html += `${indentStr}<DT><A HREF="${node.url}"${addDate ? ` ADD_DATE="${addDate}"` : ''}>${node.title || node.url}</A>\n`;
    } else if (node.children) {
      // It's a folder
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : '';
      html += `${indentStr}<DT><H3${addDate ? ` ADD_DATE="${addDate}"` : ''}>${node.title || 'Untitled Folder'}</H3>\n`;
      html += `${indentStr}<DL><p>\n`;
      html += bookmarksToHTML(node.children, indent + 1);
      html += `${indentStr}</DL><p>\n`;
    }
  }

  return html;
}

// Generate complete HTML bookmark file
function generateBookmarkHTML(bookmarkTree) {
  const timestamp = new Date().toISOString();
  const date = new Date();

  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  // Process the bookmark tree
  // Firefox bookmark tree has a root node, we want to export its children
  if (bookmarkTree && bookmarkTree.length > 0) {
    const root = bookmarkTree[0];
    if (root.children) {
      html += bookmarksToHTML(root.children, 1);
    }
  }

  html += `</DL><p>\n`;

  return html;
}

// SAFETY: Export bookmarks as JSON or HTML backup
async function exportBookmarks() {
  try {
    // Ask user for format preference
    const format = confirm(
      'Choose export format:\n\n' +
      'OK = HTML (compatible with all browsers)\n' +
      'Cancel = JSON (Firefox native format)\n\n' +
      'HTML format can be imported into any browser.\n' +
      'JSON format preserves all Firefox bookmark metadata.'
    ) ? 'html' : 'json';

    let data;

    // Export bookmark tree from bookmarkManager
    data = bookmarkManager.getTree();

    // Generate filename with timestamp
    const date = new Date().toISOString().split('T')[0];
    let filename, blob, url;

    if (format === 'html') {
      // Create HTML file
      const html = generateBookmarkHTML(data);
      blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      url = URL.createObjectURL(blob);
      filename = `bookmarks-${date}.html`;
    } else {
      // Create JSON file
      const json = JSON.stringify(data, null, 2);
      blob = new Blob([json], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      filename = `bookmarks-backup-${date}.json`;
    }

    // Create download link and trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (format === 'html') {
      alert(
        `✓ Bookmarks exported as HTML!\n\n` +
        `File: ${filename}\n\n` +
        `This file can be imported into:\n` +
        `• Firefox: Bookmarks → Manage Bookmarks → Import and Backup → Import Bookmarks from HTML\n` +
        `• Chrome/Edge: Bookmarks → Import bookmarks and settings\n` +
        `• Any browser that supports Netscape bookmark format`
      );
    } else {
      alert(
        `✓ Bookmarks exported as JSON!\n\n` +
        `File: ${filename}\n\n` +
        `This backup can be imported back into Firefox via:\n` +
        `Bookmarks → Manage Bookmarks → Import and Backup → Restore → Choose File`
      );
    }
  } catch (error) {
    console.error('Error exporting bookmarks:', error);
    alert('Failed to export bookmarks. Please try again.');
  }
}

// IMPORT BOOKMARKS: Import bookmarks from HTML or JSON files
async function importBookmarks() {
  try {
    const fileInput = document.getElementById('importFileInput');
    if (!fileInput) {
      alert('Import feature not available');
      return;
    }

    // Trigger file selection
    fileInput.click();

    // Handle file selection
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        // Show loading indicator
        const loadingMsg = alert('Importing bookmarks...\n\nThis may take a moment for large bookmark files.');

        // Read file content
        const content = await file.text();
        let parsedTree;

        // Parse based on file extension
        if (file.name.endsWith('.html')) {
          parsedTree = parseHTMLBookmarks(content);
        } else if (file.name.endsWith('.json')) {
          parsedTree = parseJSONBookmarks(content);
        } else {
          alert('Unsupported file format. Please select an HTML or JSON bookmark file.');
          fileInput.value = ''; // Reset input
          return;
        }

        // Confirm import with user
        const confirmed = confirm(
          'Import bookmarks from file?\n\n' +
          `File: ${file.name}\n\n` +
          'This will MERGE the imported bookmarks with your existing bookmarks.\n\n' +
          'Current bookmarks will NOT be deleted.\n' +
          'Imported bookmarks will be added to the corresponding folders.\n\n' +
          'Continue?'
        );

        if (!confirmed) {
          fileInput.value = ''; // Reset input
          return;
        }

        // Merge imported bookmarks with existing tree
        const currentTree = bookmarkManager.getTree();

        // Merge each root folder
        if (parsedTree.roots) {
          for (const rootKey in parsedTree.roots) {
            if (currentTree.roots[rootKey] && parsedTree.roots[rootKey].children) {
              // Append imported children to existing root folder
              currentTree.roots[rootKey].children.push(...parsedTree.roots[rootKey].children);
            }
          }
        }

        // Update checksum and timestamp
        currentTree.lastModified = Date.now();
        currentTree.checksum = ''; // Will be recalculated when saved

        // Save merged tree and mark for sync
        await syncManager.saveLocalBookmarks(currentTree);
        await syncManager.markChanged(); // Trigger sync

        // Reload bookmark manager
        await bookmarkManager.reload();

        // Re-render UI
        renderBookmarks();

        // Show success message
        alert(
          '✓ Bookmarks imported successfully!\n\n' +
          `File: ${file.name}\n\n` +
          'The imported bookmarks have been merged with your existing bookmarks.\n' +
          'Syncing to remote storage...'
        );

        // Reset file input for next use
        fileInput.value = '';

      } catch (error) {
        console.error('Error importing bookmarks:', error);
        alert(
          'Failed to import bookmarks.\n\n' +
          `Error: ${error.message}\n\n` +
          'Please check that the file is a valid bookmark export from Chrome or Firefox.'
        );
        fileInput.value = ''; // Reset input
      }
    };

  } catch (error) {
    console.error('Error in import function:', error);
    alert('Failed to start import. Please try again.');
  }
}

// DUPLICATE DETECTION: Find and manage duplicate bookmarks
async function findDuplicates() {
  try {
    let allBookmarks = [];

    // Get all bookmarks from bookmarkManager
    const tree = bookmarkManager.getTree();
    allBookmarks = getAllBookmarksFlat(Object.values(tree.roots));

    // Group bookmarks by URL
    const urlMap = new Map();
    for (const bookmark of allBookmarks) {
      if (bookmark.url) { // Only process bookmarks (not folders)
        if (!urlMap.has(bookmark.url)) {
          urlMap.set(bookmark.url, []);
        }
        urlMap.get(bookmark.url).push(bookmark);
      }
    }

    // Find duplicates (URLs with more than one bookmark)
    const duplicates = [];
    for (const [url, bookmarks] of urlMap.entries()) {
      if (bookmarks.length > 1) {
        duplicates.push({ url, bookmarks });
      }
    }

    if (duplicates.length === 0) {
      alert('✓ No duplicate bookmarks found!\n\nAll your bookmarks have unique URLs.');
      return;
    }

    // Show duplicates modal
    showDuplicatesModal(duplicates);

  } catch (error) {
    console.error('Error finding duplicates:', error);
    alert('Failed to scan for duplicates. Please try again.');
  }
}

// Helper: Get all bookmarks from tree (recursive, flattened)
function getAllBookmarksFlat(tree, parentPath = '') {
  let bookmarks = [];

  const processNode = (node, path) => {
    // Skip separators
    if (node.type === 'separator') return;

    if (node.url) {
      // It's a bookmark
      bookmarks.push({
        ...node,
        parentPath: path
      });
    }
    if (node.children) {
      // It's a folder - process children
      const newPath = path ? `${path} > ${node.title || 'Untitled'}` : node.title || 'Root';
      for (const child of node.children) {
        processNode(child, newPath);
      }
    }
  };

  if (Array.isArray(tree)) {
    for (const node of tree) {
      processNode(node, parentPath);
    }
  } else {
    processNode(tree, parentPath);
  }

  return bookmarks;
}

// Global storage for current duplicates data
let currentDuplicates = [];

// Show duplicates modal
function showDuplicatesModal(duplicates) {
  const modal = document.getElementById('duplicatesModal');
  const content = document.getElementById('duplicatesContent');

  // Store duplicates for later use in deletion check
  currentDuplicates = duplicates;

  // Build HTML for duplicates
  let html = `
    <div style="margin-bottom: 8px;">
      <p style="font-size: 11px;"><strong>Found ${duplicates.length} URL(s) with duplicates (${duplicates.reduce((sum, d) => sum + d.bookmarks.length, 0)} total bookmarks)</strong></p>
      <p style="color: #666; font-size: 9px;">Select the bookmarks you want to delete:</p>
    </div>
  `;

  for (const duplicate of duplicates) {
    html += `
      <div style="margin-bottom: 10px; padding: 8px; background: rgba(59, 130, 246, 0.05); border-radius: 4px; border: 1px solid rgba(59, 130, 246, 0.2);">
        <div style="margin-bottom: 6px; font-size: 9px;">
          <strong style="color: #1e40af;">URL:</strong>
          <a href="${duplicate.url}" target="_blank" style="color: #2563eb; text-decoration: none; word-break: break-all; font-size: 9px;">${duplicate.url}</a>
        </div>
        <div style="margin-left: 8px;">
    `;

    for (const bookmark of duplicate.bookmarks) {
      html += `
        <div style="margin-bottom: 4px; display: flex; align-items: center; gap: 4px;">
          <input type="checkbox"
                 id="dup-${bookmark.id}"
                 data-bookmark-id="${bookmark.id}"
                 data-url="${duplicate.url}"
                 class="duplicate-checkbox"
                 style="cursor: pointer; width: 10px; height: 10px;">
          <label for="dup-${bookmark.id}" style="cursor: pointer; flex: 1; font-size: 9px;">
            <span style="font-weight: 500;">${bookmark.title || 'Untitled'}</span>
            <span style="color: #666; font-size: 8px;"> - in ${bookmark.parentPath || 'Root'}</span>
          </label>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  content.innerHTML = html;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close duplicates modal
function closeDuplicatesModal() {
  const modal = document.getElementById('duplicatesModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Delete selected duplicates
async function deleteSelectedDuplicates() {
  const checkboxes = document.querySelectorAll('.duplicate-checkbox:checked');

  if (checkboxes.length === 0) {
    alert('Please select at least one bookmark to delete.');
    return;
  }

  const confirmed = confirm(`⚠ Delete ${checkboxes.length} selected bookmark(s)?\n\nYou can undo this from the toast or the changelog.`);
  if (!confirmed) return;

  // Check if user is deleting ALL copies of any URL
  const selectedIds = new Set(Array.from(checkboxes).map(cb => cb.dataset.bookmarkId));
  const urlsWithAllCopiesSelected = [];

  for (const duplicate of currentDuplicates) {
    const allIdsForThisUrl = duplicate.bookmarks.map(b => b.id);
    const allSelected = allIdsForThisUrl.every(id => selectedIds.has(id));

    if (allSelected) {
      urlsWithAllCopiesSelected.push(duplicate.url);
    }
  }

  // Second warning if deleting all copies of any URL
  if (urlsWithAllCopiesSelected.length > 0) {
    const urlList = urlsWithAllCopiesSelected.map(url => `  • ${url}`).join('\n');
    const finalWarning = confirm(
      `⚠️ WARNING! YOU ARE ABOUT TO DELETE ALL COPIES OF THE FOLLOWING BOOKMARK(S):\n\n${urlList}\n\nTHERE WILL BE NO REMAINING COPIES OF THESE BOOKMARKS!\n\nARE YOU ABSOLUTELY SURE YOU WANT TO CONTINUE?`
    );

    if (!finalWarning) return;
  }


  try {
    let successCount = 0;
    let failCount = 0;
    const deleted = [];

    for (const checkbox of checkboxes) {
      const bookmarkId = checkbox.dataset.bookmarkId;
      try {
        /* [ZeroLabs] 2026-08-27 - added: record before removing, with its parent */
        const node = bookmarkManager.getBookmark(bookmarkId);
        const dupParent = node ? findParentById(bookmarkTree, bookmarkId) : null;
        const fullData = node ? JSON.parse(JSON.stringify(node)) : null;
        if (fullData) {
          fullData.parentId = dupParent ? dupParent.id : undefined;
          fullData.index = dupParent && dupParent.children
            ? dupParent.children.findIndex(c => c.id === bookmarkId)
            : undefined;
        }
        await bookmarkManager.remove(bookmarkId);
        if (fullData) {
          await addChangelogEntry('delete', 'bookmark', fullData.title || 'Untitled', fullData.url || null, { fullData });
          deleted.push({ type: 'bookmark', data: fullData });
        }
        successCount++;
      } catch (error) {
        console.error(`Failed to delete bookmark ${bookmarkId}:`, error);
        failCount++;
      }
    }

    // Reload bookmarks
    await loadBookmarks();
    renderBookmarks();

    // Close modal and show result
    closeDuplicatesModal();

    /* [ZeroLabs] 2026-08-27 - added: ask about these deletions now */
    window.syncAfterLocalDeletion?.();

    if (failCount === 0) {
      /* [ZeroLabs] 2026-08-27 - edited: an undo toast instead of a blocking alert */
      showUndoToast({
        type: 'bulk',
        data: deleted,
        message: `${successCount} duplicate${successCount === 1 ? '' : 's'} deleted`
      });
    } else {
      alert(`⚠ Deleted ${successCount} bookmark(s).\n${failCount} failed to delete.`);
    }

  } catch (error) {
    console.error('Error deleting duplicates:', error);
    alert('An error occurred while deleting bookmarks.');
  }
}

// View error logs
async function viewErrorLogs() {
  try {
    const result = await safeStorage.get('errorLogs');
    const errorLogs = result.errorLogs || [];

    if (errorLogs.length === 0) {
      alert('No error logs found. The extension is working smoothly!');
      return;
    }

    // Format error logs for display
    let logText = `ERROR LOGS (${errorLogs.length} total)\n`;
    logText += '='.repeat(60) + '\n\n';

    errorLogs.forEach((log, index) => {
      const date = new Date(log.timestamp);
      logText += `#${index + 1} - ${date.toLocaleString()}\n`;
      logText += `Context: ${log.context}\n`;
      logText += `Message: ${log.message}\n`;
      if (log.stack) {
        logText += `Stack: ${log.stack.split('\n')[0]}\n`;
      }
      logText += '-'.repeat(60) + '\n\n';
    });

    // Show in a prompt to allow copying
    const action = confirm(
      `Found ${errorLogs.length} error log(s).\n\n` +
      `Click OK to view in console, or Cancel to clear logs.`
    );

    if (action) {
      console.log(logText);
      alert('Error logs have been printed to the browser console. Press F12 to view.');
    } else {
      // Clear logs
      const confirmClear = confirm('Are you sure you want to clear all error logs?');
      if (confirmClear) {
        await safeStorage.remove('errorLogs');
        alert('Error logs cleared successfully.');
      }
    }
  } catch (error) {
    console.error('Error viewing logs:', error);
    alert('Failed to load error logs.');
  }
}

// Open changelog modal
async function openChangelogModal() {
  const modal = document.getElementById('changelogModal');
  const changelogList = document.getElementById('changelogList');
  const changelogCount = document.getElementById('changelogCount');

  // Load changelog entries
  const entries = await getChangelogEntries();

  // Update count
  changelogCount.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;

  // Render entries
  if (entries.length === 0) {
    changelogList.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-on-surface-variant);">
        <svg width="48" height="48" fill="currentColor" viewBox="0 0 24 24" style="opacity: 0.3; margin-bottom: 12px;">
          <path d="M13.5,8H12V13L16.28,15.54L17,14.33L13.5,12.25V8M13,3A9,9 0 0,0 4,12H1L4.96,16.03L9,12H6A7,7 0 0,1 13,5A7,7 0 0,1 20,12A7,7 0 0,1 13,19C11.07,19 9.32,18.21 8.06,16.94L6.64,18.36C8.27,20 10.5,21 13,21A9,9 0 0,0 22,12A9,9 0 0,0 13,3Z"/>
        </svg>
        <p style="font-size: 14px;">No changes recorded yet.</p>
        <p style="font-size: 12px; opacity: 0.7; margin-top: 8px;">Your bookmark changes will appear here.</p>
      </div>
    `;
  } else {
    let html = '<div style="display: flex; flex-direction: column; gap: 12px;">';

    entries.forEach(entry => {
      const date = new Date(entry.timestamp);
      const timeAgo = getTimeAgo(entry.timestamp);
      let iconColor;
      if (entry.type === 'create') iconColor = '#10b981';
      else if (entry.type === 'delete') iconColor = '#ef4444';
      else if (entry.type === 'move') iconColor = '#3b82f6';
      else if (entry.type === 'undo') iconColor = '#8b5cf6';
      else if (entry.type === 'pre-sync-snapshot') iconColor = '#f59e0b';
      else iconColor = '#f59e0b';

      // SVG icons for operation types
      let icon;
      if (entry.type === 'create') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>`;
      } else if (entry.type === 'delete') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z"/></svg>`;
      } else if (entry.type === 'move') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M14,18L12.6,16.6L15.2,14H4V12H15.2L12.6,9.4L14,8L19,13L14,18M20,6H10A2,2 0 0,0 8,8V11H10V8H20V20H10V17H8V20A2,2 0 0,0 10,22H20A2,2 0 0,0 22,20V8A2,2 0 0,0 20,6Z"/></svg>`;
      } else if (entry.type === 'undo') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M12.5,8C9.85,8 7.45,9 5.6,10.6L2,7V16H11L7.38,12.38C8.77,11.22 10.54,10.5 12.5,10.5C16.04,10.5 19.05,12.81 19.56,16H22.01C21.43,12.16 17.97,9 13.9,9H12.5V8M12.5,16C10.54,16 8.77,15.28 7.38,14.12L11,10.5H2V19.5L5.6,15.9C7.45,17.5 9.85,18.5 12.5,18.5C17.1,18.5 20.95,15.4 21.9,11.2H19.38C18.77,14.16 15.76,16.34 12.5,16Z"/></svg>`;
      } else if (entry.type === 'pre-sync-snapshot') {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/></svg>`;
      } else {
        icon = `<svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" style="color: ${iconColor};"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/></svg>`;
      }

      // SVG icons for item types (skip for sync snapshots)
      let itemIcon = '';
      if (entry.type !== 'pre-sync-snapshot') {
        if (entry.itemType === 'folder') {
          itemIcon = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="color: var(--md-sys-color-primary);"><path d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/></svg>`;
        } else {
          itemIcon = `<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="color: var(--md-sys-color-secondary);"><path d="M17,3H7A2,2 0 0,0 5,5V21L12,18L19,21V5C19,3.89 18.1,3 17,3Z"/></svg>`;
        }
      }

      let detailsHtml = '';
      if (entry.details) {
        if (entry.type === 'pre-sync-snapshot') {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">⚠️ Replaced all local bookmarks with remote data</div>`;
        } else if (entry.type === 'undo') {
          if (entry.details.undoType === 'move') {
            detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Restored to: ${entry.details.restoredToFolder}</div>`;
          } else if (entry.details.undoType === 'update') {
            detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Reverted title from: "${entry.details.previousTitle}"</div>`;
          } else {
            detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Undid ${entry.details.undoType} operation</div>`;
          }
        } else if (entry.details.oldTitle && entry.details.newTitle) {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Renamed from: ${entry.details.oldTitle}</div>`;
        } else if (entry.details.fromFolder && entry.details.toFolder) {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Moved from: ${entry.details.fromFolder} → ${entry.details.toFolder}</div>`;
        } else if (entry.details.folderPath) {
          detailsHtml = `<div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 4px;">Location: ${entry.details.folderPath}</div>`;
        }
      }

      const urlHtml = entry.url ? `<div class="changelog-url" data-url="${entry.url}" style="font-size: 11px; color: var(--md-sys-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; text-decoration: underline;" title="Click to copy: ${entry.url}">${entry.url}</div>` : '';

      let restoreButtonHtml = '';
      if (entry.type === 'pre-sync-snapshot') {
        restoreButtonHtml = `
          <button class="changelog-restore-btn" data-entry-id="${entry.id}" title="Restore pre-sync bookmarks" style="margin-left: auto; padding: 6px 12px; border: 1px solid ${iconColor}; border-radius: 6px; background: ${iconColor}; color: #000; cursor: pointer; font-size: 12px; font-weight: 600;">
            Restore Pre-Sync Bookmarks
          </button>
        `;
      } else if ((entry.type === 'delete' || entry.type === 'move' || entry.type === 'update') && entry.type !== 'undo') {
        const restoreTitle = entry.type === 'delete' ? 'Restore this item' :
                            entry.type === 'move' ? 'Move back to original location' :
                            'Revert changes';
        restoreButtonHtml = `
          <button class="changelog-restore-btn" data-entry-id="${entry.id}" title="${restoreTitle}" style="margin-left: auto; padding: 4px 8px; border: 1px solid var(--md-sys-color-outline); border-radius: 4px; background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); cursor: pointer; font-size: 11px; opacity: 0.7; transition: opacity 0.2s;">
            Restore
          </button>
        `;
      }

      html += `
        <div style="padding: 12px; background: var(--md-sys-color-surface-variant); border-radius: 8px; border-left: 3px solid ${iconColor};">
          <div style="display: flex; align-items: start; gap: 8px;">
            <div style="font-size: 20px; flex-shrink: 0;">${icon}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                <span style="font-size: 14px;">${itemIcon}</span>
                <span style="font-size: 13px; font-weight: 600; color: var(--md-sys-color-on-surface);">${entry.title || 'Untitled'}</span>
                ${restoreButtonHtml}
              </div>
              ${urlHtml}
              ${detailsHtml}
              <div style="font-size: 11px; color: var(--md-sys-color-on-surface-variant); margin-top: 6px; opacity: 0.7;">${timeAgo}</div>
            </div>
          </div>
        </div>
      `;
    });

    html += '</div>';
    changelogList.innerHTML = html;

    // Add click handlers to URLs for copying to clipboard
    const urlElements = changelogList.querySelectorAll('.changelog-url');
    urlElements.forEach(urlEl => {
      urlEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = urlEl.getAttribute('data-url');
        try {
          await navigator.clipboard.writeText(url);
          // Show visual feedback
          const originalText = urlEl.textContent;
          const originalColor = urlEl.style.color;
          urlEl.textContent = '✓ Copied!';
          urlEl.style.color = '#10b981';
          setTimeout(() => {
            urlEl.textContent = originalText;
            urlEl.style.color = originalColor;
          }, 1500);
        } catch (error) {
          console.error('Failed to copy URL:', error);
          alert('Failed to copy URL to clipboard');
        }
      });
    });

    // Add click handlers to restore buttons
    const restoreButtons = changelogList.querySelectorAll('.changelog-restore-btn');
    restoreButtons.forEach(restoreBtn => {
      restoreBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entryId = restoreBtn.getAttribute('data-entry-id');
        await restoreChangelogEntry(entryId);
      });
    });
  }

  // Show modal
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  trapFocus(modal);
}

// Close modal (generic)
function closeModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Close changelog modal
function closeChangelogModal() {
  const modal = document.getElementById('changelogModal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  releaseFocusTrap();
}

// Restore a changelog entry (undo the operation)
async function restoreChangelogEntry(entryId) {
  try {
    const entries = await getChangelogEntries();
    const entry = entries.find(e => e.id == entryId);

    if (!entry) {
      alert('Changelog entry not found.');
      return;
    }

    // Handle pre-sync-snapshot restoration
    if (entry.type === 'pre-sync-snapshot') {
      if (!entry.details || !entry.details.snapshot) {
        alert('Snapshot data not found. Cannot restore pre-sync bookmarks.');
        return;
      }

      const confirmed = confirm(
        `⚠️ RESTORE PRE-SYNC BOOKMARKS\n\n` +
        `This will replace ALL your current bookmarks with the bookmarks you had BEFORE the sync operation.\n\n` +
        `Operation: ${entry.details.operation || 'Sync'}\n` +
        `Date: ${new Date(entry.timestamp).toLocaleString()}\n\n` +
        `Are you sure you want to proceed?`
      );

      if (!confirmed) return;

      try {
        app.showToast('Restoring pre-sync bookmarks...', 'info');

        const snapshot = entry.details.snapshot;

        // Restore from snapshot (Website uses IndexedDB, no browser IDs involved)
        await dbManager.put('metadata', { key: 'bookmarkTree', value: snapshot });

        // Clear changelog since we've restored to a previous state
        await clearChangelog();

        app.showToast('✓ Pre-sync bookmarks restored successfully!', 'success');

        // Refresh UI
        await loadBookmarks();
        await renderBookmarks();

        // Close changelog modal
        closeChangelogModal();

        return;
      } catch (error) {
        console.error('[Restore Snapshot] Error:', error);
        app.showToast(`Failed to restore snapshot: ${error.message}`, 'error');
        return;
      }
    }

    // Only allow restoring certain operation types
    if (!['delete', 'move', 'update'].includes(entry.type)) {
      alert('This operation type cannot be restored.');
      return;
    }

    const confirmed = confirm(`Restore this ${entry.type} operation: "${entry.title}"?\n\nThis will attempt to undo the change.`);
    if (!confirmed) return;

    if (entry.type === 'delete') {
      // Check if we have the full data stored
      if (!entry.details || !entry.details.fullData) {
        alert('Delete operations cannot be automatically restored from the changelog.\n\nThis deletion was logged before full data storage was implemented.\n\nUse the undo feature immediately after deletion for full restoration.');
        return;
      }

      // Restore the deleted item
      const fullData = entry.details.fullData;

      try {
        /* [ZeroLabs] 2026-08-27 - edited: use the shared restore, and survive a missing parent */
        // Two problems here. The folder branch created an EMPTY folder and told
        // the user its contents were lost - but fullData holds the whole subtree,
        // and restoreDeletedItem rebuilds it, which is what the undo toast has
        // always done. And a missing parentId - an entry logged before the bulk
        // paths captured one, or a parent folder since deleted - threw "Parent
        // folder not found: undefined" instead of putting the item somewhere.
        // Two different reasons to relocate, and they deserve different wording:
        // an entry logged before the bulk paths recorded a parent knows nothing
        // about where it was, which is not the same as its folder being gone.
        let targetParentId = fullData.parentId;
        let relocated = null;
        if (!targetParentId) {
          relocated = 'unknown';
        } else if (!bookmarkManager.getFolder(targetParentId)) {
          relocated = 'missing';
        }
        if (relocated) {
          const roots = (bookmarkManager.getTree() || {}).roots || {};
          const fallback = roots.other || roots.bookmark_bar || Object.values(roots)[0];
          targetParentId = fallback ? fallback.id : undefined;
          if (!fallback) relocated = null;
        }

        if (!targetParentId) {
          alert('Could not restore: there is nowhere to put it.');
          return;
        }

        const where = relocated
          ? (relocated === 'unknown'
              ? `

BMZ did not record where this was, so it was restored to "${bookmarkManager.getFolder(targetParentId).title}".`
              : `

Its original folder no longer exists, so it was restored to "${bookmarkManager.getFolder(targetParentId).title}".`)
          : '';

        await restoreDeletedItem(
          entry.itemType === 'folder' ? 'folder' : 'bookmark',
          { ...fullData, parentId: targetParentId }
        );

        alert(entry.itemType === 'folder'
          ? `Folder "${fullData.title}" and its contents have been restored.${where}`
          : `Bookmark "${fullData.title}" has been restored successfully!${where}`);

        // Refresh UI
        await loadBookmarks();
        await renderBookmarks();

        // Add a changelog entry for the restoration
        await addChangelogEntry('restore', entry.itemType, fullData.title, fullData.url, {
          originalOperation: 'delete',
          restoredFrom: entry.id
        });

        // Close and reopen changelog modal to refresh
        closeChangelogModal();
        setTimeout(() => openChangelogModal(), 100);

        return;
      } catch (error) {
        console.error('[Changelog Restore] Failed to restore deleted item:', error);
        alert(`Failed to restore item: ${error.message}`);
        return;
      }
    }

    if (entry.type === 'move') {
      if (entry.details && entry.details.fromFolder) {
        // Search for the item recursively in the tree
        function findItemByTitleAndUrl(nodes, title, url) {
          for (const node of nodes) {
            if (node.title === title && (!url || node.url === url)) {
              return node;
            }
            if (node.children) {
              const found = findItemByTitleAndUrl(node.children, title, url);
              if (found) return found;
            }
          }
          return null;
        }

        const matchingItem = findItemByTitleAndUrl(bookmarkTree, entry.title, entry.url);

        if (matchingItem) {
          let targetParentId = null;
          const folderPath = entry.details.fromFolder;

          if (folderPath === 'Root') {
            targetParentId = undefined;
          } else if (folderPath) {
            const pathParts = folderPath.split(' > ');

            function findFolderByPath(nodes, parts, index) {
              if (index >= parts.length) return null;

              for (const node of nodes) {
                if (node.title === parts[index] && !node.url) {
                  if (index === parts.length - 1) {
                    return node.id;
                  }
                  if (node.children) {
                    const found = findFolderByPath(node.children, parts, index + 1);
                    if (found) return found;
                  }
                }
              }
              return null;
            }

            targetParentId = findFolderByPath(bookmarkTree, pathParts, 0);
          }

          if (folderPath !== 'Root' && !targetParentId) {
            alert(`Original folder "${folderPath}" not found. The folder may have been deleted.`);
            return;
          }

          try {
            // Use bookmarkManager.move() instead of manually setting parentId
            await bookmarkManager.move(matchingItem.id, { parentId: targetParentId });

            alert(`Moved "${entry.title}" back to ${entry.details.fromFolder || 'Root'}`);

            const itemType = matchingItem.url ? 'bookmark' : 'folder';
            await addChangelogEntry('undo', itemType, entry.title, matchingItem.url || null, {
              undoType: 'move',
              originalOperation: entry,
              restoredToFolder: entry.details.fromFolder
            });

            await loadBookmarks();
            renderBookmarks();
            await openChangelogModal();
          } catch (error) {
            alert('Failed to move item back: ' + error.message);
          }
        } else {
          alert('Could not find the moved item. It may have been deleted or renamed.');
        }
      } else {
        alert('Not enough information to restore this move operation.');
      }
    }

    if (entry.type === 'update') {
      if (entry.details && entry.details.oldTitle) {
        // Search for the item recursively in the tree
        function findItemByTitleAndUrl(nodes, title, url) {
          for (const node of nodes) {
            if (node.title === title && (!url || node.url === url)) {
              return node;
            }
            if (node.children) {
              const found = findItemByTitleAndUrl(node.children, title, url);
              if (found) return found;
            }
          }
          return null;
        }

        const matchingItem = findItemByTitleAndUrl(bookmarkTree, entry.title, entry.url);

        if (matchingItem) {
          try {
            // Use bookmarkManager.update() instead of directly modifying the item
            await bookmarkManager.update(matchingItem.id, { title: entry.details.oldTitle });

            alert(`Restored title from "${entry.title}" back to "${entry.details.oldTitle}"`);

            const itemType = matchingItem.url ? 'bookmark' : 'folder';
            await addChangelogEntry('undo', itemType, entry.details.oldTitle, matchingItem.url || null, {
              undoType: 'update',
              originalOperation: entry,
              restoredTitle: entry.details.oldTitle,
              previousTitle: entry.title
            });

            await loadBookmarks();
            renderBookmarks();
            await openChangelogModal();
          } catch (error) {
            alert('Failed to restore title: ' + error.message);
          }
        } else {
          alert('Could not find the updated item. It may have been deleted.');
        }
      } else {
        alert('Not enough information to restore this update operation.');
      }
    }
  } catch (error) {
    console.error('Failed to restore changelog entry:', error);
    alert('Failed to restore the operation: ' + error.message);
  }
}

// Helper to get relative time
function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'Just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

// Close extension
async function closeExtension() {

  try {
    // In website version, just try to close the window
    window.close();
  } catch (error) {
    console.error('Error closing window:', error);
    // If that doesn't work, show a message
    alert('Please close this tab manually.');
  }
}

// Clear cache for link status and safety checks
// Calculate cache size in KB
async function calculateCacheSize() {

  try {
    const result = await safeStorage.get(['linkStatusCache', 'safetyStatusCache', 'whitelistedUrls', 'safetyHistory']);

    // Calculate size by stringifying the data
    let totalSize = 0;
    if (result.linkStatusCache) {
      totalSize += JSON.stringify(result.linkStatusCache).length;
    }
    if (result.safetyStatusCache) {
      totalSize += JSON.stringify(result.safetyStatusCache).length;
    }
    if (result.whitelistedUrls) {
      totalSize += JSON.stringify(result.whitelistedUrls).length;
    }
    if (result.safetyHistory) {
      totalSize += JSON.stringify(result.safetyHistory).length;
    }

    // Convert bytes to KB
    return (totalSize / 1024).toFixed(2);
  } catch (error) {
    console.error('Error calculating cache size:', error);
    return 0;
  }
}

// Update cache size display
async function updateCacheSizeDisplay() {
  const cacheSizeElement = document.getElementById('cacheSize');
  if (!cacheSizeElement) return;

  const sizeKB = await calculateCacheSize();

  if (sizeKB === 0) {
    cacheSizeElement.textContent = 'Empty';
  } else if (sizeKB < 1) {
    cacheSizeElement.textContent = '< 1 KB';
  } else if (sizeKB >= 1024) {
    const sizeMB = (sizeKB / 1024).toFixed(2);
    cacheSizeElement.textContent = `${sizeMB} MB`;
  } else {
    cacheSizeElement.textContent = `${sizeKB} KB`;
  }
}

// Clear old cache entries based on auto-clear setting
async function clearOldCacheEntries(maxAgeDays) {
  if (maxAgeDays === 'never') {
    return;
  }

  try {
    const maxAgeMs = parseInt(maxAgeDays) * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - maxAgeMs;

    const result = await safeStorage.get(['linkStatusCache', 'safetyStatusCache', 'safetyHistory', 'lastCacheClear']);

    let updated = false;

    // Clear old link status cache entries
    if (result.linkStatusCache) {
      const linkCache = result.linkStatusCache;
      Object.keys(linkCache).forEach(url => {
        if (linkCache[url].timestamp && linkCache[url].timestamp < cutoffTime) {
          delete linkCache[url];
          updated = true;
        }
      });
      if (updated) {
        await safeStorage.set({ linkStatusCache: linkCache });
      }
    }

    // Clear old safety status cache entries
    if (result.safetyStatusCache) {
      const safetyCache = result.safetyStatusCache;
      Object.keys(safetyCache).forEach(url => {
        if (safetyCache[url].timestamp && safetyCache[url].timestamp < cutoffTime) {
          delete safetyCache[url];
          updated = true;
        }
      });
      if (updated) {
        await safeStorage.set({ safetyStatusCache: safetyCache });
      }
    }

    // Clear old safety history entries
    if (result.safetyHistory) {
      const history = result.safetyHistory;
      Object.keys(history).forEach(url => {
        if (Array.isArray(history[url])) {
          history[url] = history[url].filter(entry => entry.timestamp && entry.timestamp >= cutoffTime);
          if (history[url].length === 0) {
            delete history[url];
          }
          updated = true;
        }
      });
      if (updated) {
        await safeStorage.set({ safetyHistory: history });
      }
    }

    // Update last clear timestamp
    await safeStorage.set({ lastCacheClear: Date.now() });

    if (updated) {
      console.log(`Cleared cache entries older than ${maxAgeDays} days`);
      await updateCacheSizeDisplay();
    }
  } catch (error) {
    console.error('Error clearing old cache entries:', error);
  }
}

async function clearCache() {

  try {
    // Remove both cache keys from storage
    await safeStorage.remove(['linkStatusCache', 'safetyStatusCache']);

    // ALSO RESET: Clear in-memory bookmark statuses and re-render
    function resetStatuses(nodes) {
      nodes.forEach(node => {
        if (node.url) {
          node.linkStatus = 'unknown';
          node.safetyStatus = 'unknown';
          node.safetySources = [];
        }
        if (node.children) {
          resetStatuses(node.children);
        }
      });
    }
    resetStatuses(bookmarkTree);

    // Clear IndexedDB cache too
    await dbManager.clear('cache');

    // Re-render bookmarks to show "unknown" status
    renderBookmarks();

    console.log('Cache cleared successfully');
    alert('Cache cleared! Status indicators reset to unknown.');

    // Update cache size display
    await updateCacheSizeDisplay();
  } catch (error) {
    console.error('Error clearing cache:', error);
    alert('Failed to clear cache. Please try again.');
  }
}

// Update selected items count
function updateSelectedCount() {
  const selectedCount = document.getElementById('selectedCount');
  if (selectedCount) {
    selectedCount.textContent = selectedItems.size;
  }
}

// Bulk recheck selected items
async function bulkRecheckItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select items to recheck.');
    return;
  }

  if (!confirm(`Are you sure you want to recheck ${selectedItems.size} selected item(s)?`)) {
    return;
  }

  const itemsToRecheck = Array.from(selectedItems);

  // Get current bookmark tree
  const tree = bookmarkManager.getTree();
  const allBookmarks = tree && tree.roots ? Object.values(tree.roots) : [];

  // Find all bookmarks in selected items (including bookmarks in selected folders)
  const bookmarksToRecheck = [];

  for (const itemId of itemsToRecheck) {
    const item = findBookmarkById(allBookmarks, itemId);
    if (item) {
      if (item.type === 'bookmark') {
        bookmarksToRecheck.push(item);
      } else if (item.type === 'folder') {
        // Get all bookmarks in folder recursively
        const folderBookmarks = getAllBookmarksInFolder(item);
        bookmarksToRecheck.push(...folderBookmarks);
      }
    }
  }

  // Remove from checked set to force recheck
  bookmarksToRecheck.forEach(b => checkedBookmarks.delete(b.id));

  // Recheck
  await autoCheckBookmarkStatuses();

  alert(`Rechecked ${bookmarksToRecheck.length} bookmark(s).`);
}

// Bulk move selected items
async function bulkMoveItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select items to move.');
    return;
  }

  // Get current bookmark tree
  const tree = bookmarkManager.getTree();
  const allBookmarks = tree && tree.roots ? Object.values(tree.roots) : [];

  // Get all folders for selection
  const folders = getAllFoldersForMove(allBookmarks);

  // Create folder selection prompt
  let folderList = 'Select destination folder by number:\n\n';
  folders.forEach((folder, index) => {
    const indent = '  '.repeat(folder.depth || 0);
    folderList += `${index + 1}. ${indent}${folder.title || 'Unnamed Folder'}\n`;
  });

  const selection = prompt(folderList + '\nEnter folder number:');
  if (!selection) return;

  const folderIndex = parseInt(selection) - 1;
  if (isNaN(folderIndex) || folderIndex < 0 || folderIndex >= folders.length) {
    alert('Invalid folder selection.');
    return;
  }

  const destinationFolder = folders[folderIndex];

  if (!confirm(`Move ${selectedItems.size} item(s) to "${destinationFolder.title}"?`)) {
    return;
  }

  try {
    // Move each selected item
    for (const itemId of selectedItems) {
      // Get item details before moving
      const item = findBookmarkById(itemId, bookmarkTree);
      if (!item) continue;

      const oldParent = findParentById(bookmarkTree, itemId);
      const fromFolder = oldParent ? await getFolderPath(oldParent.id) : 'Root';

      await bookmarkManager.move(itemId, { parentId: destinationFolder.id });

      // Add to changelog
      const itemType = item.url ? 'bookmark' : 'folder';
      const toFolder = await getFolderPath(destinationFolder.id);
      await addChangelogEntry('move', itemType, item.title, item.url, { fromFolder, toFolder });
    }

    selectedItems.clear();
    await loadBookmarks();
    renderBookmarks();
    updateSelectedCount();

    alert(`Successfully moved items to "${destinationFolder.title}".`);
  } catch (error) {
    console.error('Error moving items:', error);
    alert('Failed to move some items. Please try again.');
  }
}

// Bulk delete selected items
async function bulkDeleteItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select items to delete.');
    return;
  }

  if (!confirm(`⚠️ This will delete ${selectedItems.size} selected item(s) and all their contents.\n\nYou can undo this from the toast or the changelog. Are you sure?`)) {
    return;
  }

  try {
    /* [ZeroLabs] 2026-08-27 - added: record before removing, like every other delete */
    // Bulk delete wrote nothing to the changelog and showed no undo toast, so the
    // single most destructive action in BMZ was the only one with no way back.
    /* [ZeroLabs] 2026-08-27 - added: drop selections contained by another selection */
    // A folder and a bookmark inside it can both be ticked. Removing the folder
    // takes the child with it, so removing the child afterwards fails - and
    // capturing both would have duplicated the child on undo.
    const covered = new Set();
    for (const id of selectedItems) {
      const n = bookmarkManager.getBookmark(id);
      const walk = (node) => (node && node.children || []).forEach(c => { covered.add(c.id); walk(c); });
      walk(n);
    }
    const topLevelIds = Array.from(selectedItems).filter(id => !covered.has(id));

    const deleted = [];
    for (const itemId of topLevelIds) {
      const node = bookmarkManager.getBookmark(itemId);
      if (!node) continue;
      /* [ZeroLabs] 2026-08-27 - added: the website's tree nodes carry no parentId */
      // It is a nested structure, so the parent is implicit and has to be looked
      // up before the node is removed. chrome.bookmarks.getSubTree hands parentId
      // and index over for free, which is why the extensions did not need this.
      const parent = findParentById(bookmarkTree, itemId);
      const fullData = JSON.parse(JSON.stringify(node));
      fullData.parentId = parent ? parent.id : undefined;
      fullData.index = parent && parent.children
        ? parent.children.findIndex(c => c.id === itemId)
        : undefined;

      await bookmarkManager.remove(itemId);
      const itemType = fullData.url ? 'bookmark' : 'folder';
      await addChangelogEntry('delete', itemType, fullData.title || 'Untitled', fullData.url || null, { fullData });
      deleted.push({ type: itemType, data: fullData });
    }

    selectedItems.clear();
    await loadBookmarks();
    renderBookmarks();
    updateSelectedCount();

    showUndoToast({
      type: 'bulk',
      data: deleted,
      message: `${deleted.length} item${deleted.length === 1 ? '' : 's'} deleted`
    });

    /* [ZeroLabs] 2026-08-27 - added: ask about these deletions now */
    window.syncAfterLocalDeletion?.();
  } catch (error) {
    console.error('Error deleting items:', error);
    alert('Failed to delete some items. Please try again.');
  }
}

// Bulk open selected items in new tabs
function bulkOpenItems() {
  if (selectedItems.size === 0) {
    alert('No items selected. Please select bookmarks to open.');
    return;
  }
  const tree = bookmarkManager.getTree();
  const allBookmarks = tree && tree.roots ? Object.values(tree.roots) : [];
  const itemsToOpen = [];
  for (const itemId of selectedItems) {
    const item = findBookmarkById(allBookmarks, itemId);
    if (!item) continue;
    if (item.type === 'bookmark' && /^https?:\/\//i.test(item.url)) {
      itemsToOpen.push({ title: item.title || item.url, url: item.url });
    } else if (item.type === 'folder') {
      getAllBookmarksInFolder(item).forEach(b => {
        if (/^https?:\/\//i.test(b.url)) itemsToOpen.push({ title: b.title || b.url, url: b.url });
      });
    }
  }
  if (itemsToOpen.length === 0) {
    alert('No openable bookmarks found in the selection (only http/https URLs can be opened).');
    return;
  }
  showBulkOpenModal(itemsToOpen);
}

function showBulkOpenModal(items) {
  const existing = document.getElementById('bulkOpenModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'bulkOpenModal';
  modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;`;

  const card = document.createElement('div');
  card.style.cssText = `background:var(--md-sys-color-surface);border-radius:12px;padding:20px;max-width:480px;width:90%;max-height:70vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.3);`;

  const header = document.createElement('div');
  header.style.cssText = `font-weight:600;font-size:15px;color:var(--md-sys-color-on-surface);`;
  header.textContent = `Open ${items.length} bookmark${items.length !== 1 ? 's' : ''} in new tabs`;

  const note = document.createElement('div');
  note.style.cssText = `font-size:12px;color:var(--md-sys-color-on-surface-variant);line-height:1.4;`;
  note.textContent = 'Browsers restrict automatic multi-tab opening on web pages. Click each bookmark below to open it, or use the Chrome or Firefox extension to open all at once. Sucks... I know';

  const list = document.createElement('div');
  list.style.cssText = `display:flex;flex-direction:column;gap:4px;`;

  items.forEach(({ title, url }) => {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = url;
    link.style.cssText = `color:var(--md-sys-color-primary);text-decoration:none;font-size:13px;padding:6px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;transition:background 0.15s;`;
    link.textContent = title;
    link.addEventListener('mouseover', () => link.style.background = 'var(--md-sys-color-primary-container)');
    link.addEventListener('mouseout', () => link.style.background = '');
    list.appendChild(link);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = `align-self:flex-end;margin-top:4px;`;
  closeBtn.addEventListener('click', () => modal.remove());

  card.appendChild(header);
  card.appendChild(note);
  card.appendChild(list);
  card.appendChild(closeBtn);
  modal.appendChild(card);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// Bulk open selected items each in a new window
async function bulkOpenInWindows() {
  if (app && app.showToast) {
    app.showToast('Opening bookmarks in separate windows is only available in the Chrome and Firefox desktop extensions.', 'info');
  }
}

// Get all bookmarks in a folder recursively
function getAllBookmarksInFolder(folder) {
  const bookmarks = [];

  function traverse(node) {
    // Skip separators
    if (node.type === 'separator') return;

    if (node.type === 'bookmark') {
      bookmarks.push(node);
    } else if (node.type === 'folder' && node.children) {
      node.children.forEach(child => traverse(child));
    }
  }

  if (folder.children) {
    folder.children.forEach(child => traverse(child));
  }

  return bookmarks;
}

// Get all folders from bookmark tree (for move/organize operations)
function getAllFoldersForMove(nodes, depth = 0) {
  const folders = [];

  nodes.forEach(node => {
    if (node.type === 'folder') {
      folders.push({ ...node, depth });
      if (node.children) {
        folders.push(...getAllFoldersForMove(node.children, depth + 1));
      }
    }
  });

  return folders;
}

// Track if event listeners have been set up
let eventListenersSetUp = false;

// Setup event listeners
function setupEventListeners() {
  if (eventListenersSetUp) {
    return;
  }

  // Re-query critical elements in case they weren't available when script first loaded
  themeBtn = document.getElementById('themeBtn');
  settingsBtn = document.getElementById('settingsBtn');
  viewBtn = document.getElementById('viewBtn');
  zoomBtn = document.getElementById('zoomBtn');
  themeMenu = document.getElementById('themeMenu');
  settingsMenu = document.getElementById('settingsMenu');
  viewMenu = document.getElementById('viewMenu');
  zoomMenu = document.getElementById('zoomMenu');

  try {
    // Search
    if (searchInput) {
      /* [ZeroLabs] 2026-08-19 7:12 PM - added: clear search button (see also: Bookmark-Manager-Zero-Firefox/sidebar.js) */
      // Shown only while there is something to clear, so it never sits in an
      // empty box. Restores focus so typing can continue straight after.
      const searchClear = document.getElementById('searchClear');
      const updateSearchClear = () => {
        if (searchClear) searchClear.classList.toggle('hidden', !searchInput.value);
      };

      searchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value;
        updateSearchClear();
        renderBookmarks();
      });

      if (searchClear) {
        searchClear.addEventListener('click', () => {
          searchInput.value = '';
          searchTerm = '';
          updateSearchClear();
          renderBookmarks();
          searchInput.focus();
        });
      }

      updateSearchClear();
    } else {
      console.warn('[Setup] searchInput element not found');
    }

    // Filter toggle
    if (filterToggle) {
      filterToggle.addEventListener('click', () => {
        filterBar.classList.toggle('hidden');
      });
    }
  } catch (error) {
    console.error('[Setup] Error in early event listeners:', error);
  }

  // Rest of the event listeners with safety
  try {
    // Display toggle
    if (displayToggle) {
      displayToggle.addEventListener('click', () => {
        displayBar.classList.toggle('hidden');
      });
    }

  // Display option toggles
  const displayTitle = document.getElementById('displayTitle');
  const displayUrl = document.getElementById('displayUrl');

  displayTitle.addEventListener('change', (e) => {
    // Ensure at least Title or URL is checked
    if (!e.target.checked && !displayUrl.checked) {
      e.target.checked = true;
      return;
    }
    displayOptions.title = e.target.checked;
    safeLocalStorage.setItem('displayTitle', e.target.checked);
    renderBookmarks();
  });

  displayUrl.addEventListener('change', (e) => {
    // Ensure at least Title or URL is checked
    if (!e.target.checked && !displayTitle.checked) {
      e.target.checked = true;
      return;
    }
    displayOptions.url = e.target.checked;
    safeLocalStorage.setItem('displayUrl', e.target.checked);
    renderBookmarks();
  });

  const displayFavicon = document.getElementById('displayFavicon');
  displayFavicon.addEventListener('change', (e) => {
    displayOptions.favicon = e.target.checked;
    safeLocalStorage.setItem('displayFavicon', e.target.checked);
    renderBookmarks();
  });

  const displayLiveStatus = document.getElementById('displayLiveStatus');
  const displaySafetyStatus = document.getElementById('displaySafetyStatus');
  const displayPreview = document.getElementById('displayPreview');

  displayLiveStatus.addEventListener('change', (e) => {
    displayOptions.liveStatus = e.target.checked;
    safeLocalStorage.setItem('displayLiveStatus', e.target.checked);
    renderBookmarks();
  });

  displaySafetyStatus.addEventListener('change', (e) => {
    displayOptions.safetyStatus = e.target.checked;
    safeLocalStorage.setItem('displaySafetyStatus', e.target.checked);
    renderBookmarks();
  });

  displayPreview.addEventListener('change', (e) => {
    displayOptions.preview = e.target.checked;
    safeLocalStorage.setItem('displayPreview', e.target.checked);
    renderBookmarks();
  });

  const displayPreviewPopup = document.getElementById('displayPreviewPopup');
  displayPreviewPopup.addEventListener('change', (e) => {
    previewPopupEnabled = e.target.checked;
    safeLocalStorage.setItem('displayPreviewPopup', e.target.checked);
    if (!previewPopupEnabled) {
      hidePreviewPopup();
    }
  });

  /* [ZeroLabs] 2026-08-18 12:32 AM - added: section visibility toggles */
  // Persisted the same way as the other display options on this build: a plain
  // string flag in localStorage, read back in loadDisplayOptions.
  const displayQuickAccess = document.getElementById('displayQuickAccess');
  const displayRecent = document.getElementById('displayRecent');

  if (displayQuickAccess) {
    displayQuickAccess.addEventListener('change', (e) => {
      displayOptions.quickAccess = e.target.checked;
      safeLocalStorage.setItem('displayQuickAccess', e.target.checked);
      renderBookmarks();
    });
  }

  if (displayRecent) {
    displayRecent.addEventListener('change', (e) => {
      displayOptions.recent = e.target.checked;
      safeLocalStorage.setItem('displayRecent', e.target.checked);
      renderBookmarks();
    });
  }

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const filter = chip.dataset.filter;

      const index = activeFilters.indexOf(filter);
      if (index > -1) {
        // Remove filter if already active
        activeFilters.splice(index, 1);
        chip.classList.remove('active');
      } else {
        // Add filter
        activeFilters.push(filter);
        chip.classList.add('active');
      }

      // Save to localStorage
      safeLocalStorage.setItem('activeFilters', JSON.stringify(activeFilters));
      renderBookmarks();
    });
  });

  // QR Code button - generate QR for current page URL
  if (qrCodeBtn) {
    qrCodeBtn.addEventListener('click', async () => {
      // In website version, can't get current tab URL, so show with empty URL
      try {
        showQRCodePopup('');
      } catch (error) {
        console.error('Error showing QR code popup:', error);
      }
    });
  }

  // Theme menu
  if (themeBtn) {
    themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = themeMenu.classList.contains('show');
      closeAllMenus();
      if (!wasOpen) {
        menuJustOpened = true;
        themeMenu.classList.add('show');
        positionToolbarMenu(themeMenu, themeBtn);
      }
    });
  } else {
    console.warn('[Setup] themeBtn not found, cannot attach listener');
  }

  // Theme selection
  // Theme dropdown
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      setTheme(themeSelect.value);
    });
  }

  // Tint control event listeners
  const tintHueInput = document.getElementById('tintHue');
  const tintSaturationInput = document.getElementById('tintSaturation');
  const hueValueSpan = document.getElementById('hueValue');
  const saturationValueSpan = document.getElementById('saturationValue');

  if (tintHueInput && tintSaturationInput) {
    tintHueInput.addEventListener('input', (e) => {
      const hue = e.target.value;
      if (hueValueSpan) hueValueSpan.textContent = `${hue}°`;
      applyTintSettings(parseInt(hue), parseInt(tintSaturationInput.value));
    });

    tintSaturationInput.addEventListener('input', (e) => {
      const saturation = e.target.value;
      if (saturationValueSpan) saturationValueSpan.textContent = `${saturation}%`;
      applyTintSettings(parseInt(tintHueInput.value), parseInt(saturation));
    });
  }

  // View menu
  if (viewBtn && viewMenu) {
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = viewMenu.classList.contains('show');
      closeAllMenus();
      if (!wasOpen) {
        menuJustOpened = true;
        viewMenu.classList.add('show');
        positionToolbarMenu(viewMenu, viewBtn);
      }
    });

    // View selection
    viewMenu.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const selectedView = btn.dataset.view;
        setView(selectedView);
        closeAllMenus();
      });
    });
  } else {
    console.warn('[Setup] viewBtn or viewMenu not found, cannot attach listener');
  }

  // Zoom menu
  if (zoomBtn && zoomMenu && zoomSlider && fontSizeSlider) {
    zoomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = zoomMenu.classList.contains('show');
      closeAllMenus();
      if (!wasOpen) {
        menuJustOpened = true;
        zoomMenu.classList.add('show');
        positionToolbarMenu(zoomMenu, zoomBtn);
      }
    });

    // Zoom slider
    zoomSlider.addEventListener('input', (e) => {
      const newZoom = parseInt(e.target.value);
      setZoom(newZoom);
    });

    // Font size slider
    fontSizeSlider.addEventListener('input', (e) => {
      const newSize = parseInt(e.target.value);
      setFontSize(newSize);
    });
  } else {
    console.warn('[Setup] zoomBtn, zoomMenu, or sliders not found, cannot attach listeners');
  }

  // Settings menu
  if (settingsBtn && settingsMenu) {
    settingsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const wasOpen = settingsMenu.classList.contains('show');
      closeAllMenus();
      if (!wasOpen) {
        menuJustOpened = true;
        settingsMenu.classList.add('show');
        positionToolbarMenu(settingsMenu, settingsBtn);

        // Update cache size display when menu opens
        await updateCacheSizeDisplay();
      }
    });
  } else {
    console.warn('[Setup] settingsBtn or settingsMenu not found, cannot attach listener');
  }

  // Open in new tab
  if (openInTabBtn) {
    openInTabBtn.addEventListener('click', () => {
      openInNewTab();
      closeAllMenus();
    });
  }

  // Export bookmarks (backup)
  if (exportBookmarksBtn) {
    exportBookmarksBtn.addEventListener('click', () => {
      exportBookmarks();
      closeAllMenus();
    });
  }

  // Import bookmarks
  if (importBookmarksBtn) {
    importBookmarksBtn.addEventListener('click', () => {
      importBookmarks();
      closeAllMenus();
    });
  }

  // Clear cache
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      await clearCache();
      closeAllMenus();
    });
  }

  // Auto-clear cache setting
  if (autoClearCacheSelect) {
    autoClearCacheSelect.addEventListener('change', async (e) => {
      const autoClearDays = e.target.value;
      await safeStorage.set({ autoClearCacheDays: autoClearDays });
      console.log(`Auto-clear cache set to: ${autoClearDays === 'never' ? 'Never' : autoClearDays + ' days'}`);

      // Run auto-clear immediately if enabled
      if (autoClearDays !== 'never') {
        await clearOldCacheEntries(autoClearDays);
      }
    });
  }

  // Start folder setting
  if (startFolderSelect) {
    startFolderSelect.addEventListener('change', async (e) => {
      startFolderId = e.target.value || null;
      window.startFolderId = startFolderId;
      await safeStorage.set({ startFolderId: startFolderId });
      console.log(`Start folder set to: ${startFolderId || 'Root'}`);

      // Clear expanded folders and expand to new start folder
      expandedFolders.clear();
      await expandToStartFolder();
      renderBookmarks();
    });
  }

  // Container opacity slider
  if (containerOpacitySlider) {
    containerOpacitySlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const opacity = e.target.value;
      containerOpacityValue.textContent = `${opacity}%`;
      safeLocalStorage.setItem('containerOpacity', opacity);
      applyContainerOpacity(opacity);
    });

    // Prevent menu from closing when clicking the slider
    containerOpacitySlider.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // Dark text toggle removed - no longer needed

  // Custom text color picker
  if (textColorPicker) {
    textColorPicker.addEventListener('input', (e) => {
      const color = e.target.value;
      applyCustomTextColor(color);
      safeLocalStorage.setItem('customTextColor', color);
    });
  }

  // Reset text color button
  if (resetTextColorBtn) {
    resetTextColorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetCustomTextColor();
      textColorPicker.value = '#e8e8e8'; // Light gray default
    });
  }

  // Initialize text color on page load (matches accent color pattern - load after event listeners)
  loadCustomTextColor();

  // Link checking toggle
  const enableLinkCheckingToggle = document.getElementById('enableLinkChecking');
  if (enableLinkCheckingToggle) {
    enableLinkCheckingToggle.addEventListener('change', (e) => {
      linkCheckingEnabled = e.target.checked;
      safeLocalStorage.setItem('linkCheckingEnabled', linkCheckingEnabled);
      console.log(`Link checking ${linkCheckingEnabled ? 'enabled' : 'disabled'}`);
    });
  }

  // Safety checking toggle
  const enableSafetyCheckingToggle = document.getElementById('enableSafetyChecking');
  if (enableSafetyCheckingToggle) {
    enableSafetyCheckingToggle.addEventListener('change', (e) => {
      safetyCheckingEnabled = e.target.checked;
      safeLocalStorage.setItem('safetyCheckingEnabled', safetyCheckingEnabled);
      console.log(`Safety checking ${safetyCheckingEnabled ? 'enabled' : 'disabled'}`);
    });
  }

  /* [ZeroLabs] 2026-06-20 10:50 AM - added: scan concurrency + jitter sliders (DNS load) */
  const scanConcurrencySlider = document.getElementById('scanConcurrencySlider');
  const scanConcurrencyValueLabel = document.getElementById('scanConcurrencyValue');
  if (scanConcurrencySlider) {
    scanConcurrencySlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      if (scanConcurrencyValueLabel) scanConcurrencyValueLabel.textContent = value;
      safeLocalStorage.setItem('scanConcurrency', value);
      if (window.scannerService) window.scannerService.setConcurrency(value);
    });
  }

  const scanJitterSlider = document.getElementById('scanJitterSlider');
  const scanJitterValueLabel = document.getElementById('scanJitterValue');
  if (scanJitterSlider) {
    scanJitterSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      if (scanJitterValueLabel) scanJitterValueLabel.textContent = value + 'ms';
      safeLocalStorage.setItem('scanJitter', value);
      if (window.scannerService) window.scannerService.setJitter(value);
    });
  }

  // Accent color picker
  if (accentColorPicker && resetAccentColorBtn) {
    accentColorPicker.addEventListener('input', (e) => {
      const color = e.target.value;
      applyAccentColor(color);
      safeLocalStorage.setItem('customAccentColor', color);
    });

    // Reset accent color
    resetAccentColorBtn.addEventListener('click', () => {
      const defaultColor = getDefaultAccentColor();
      accentColorPicker.value = defaultColor;
      applyAccentColor(defaultColor);
      safeLocalStorage.removeItem('customAccentColor');
    });
  }

  // Load saved accent color on startup
  function loadSavedAccentColor() {
    const savedColor = safeLocalStorage.getItem('customAccentColor');
    if (savedColor) {
      accentColorPicker.value = savedColor;
      applyAccentColor(savedColor);
    } else {
      const defaultColor = getDefaultAccentColor();
      accentColorPicker.value = defaultColor;
    }
  }

  // Get default accent color based on current theme
  function getDefaultAccentColor() {
    const isDarkMode = document.body.classList.contains('blue-dark') || document.body.classList.contains('dark');
    if (document.body.classList.contains('dark')) {
      return '#bb86fc'; // Pure dark theme purple
    } else if (isDarkMode) {
      return '#818cf8'; // Blue dark theme
    } else {
      return '#6366f1'; // Light theme default
    }
  }

  // Apply accent color by calling the global function
  function applyAccentColor(color) {
    applyCustomAccentColor(color);
  }

  // Initialize accent color on page load
  loadSavedAccentColor();

  // Background image controls
  let isDragging = false;

  // Choose background image
  if (chooseBackgroundImageBtn && backgroundImagePicker) {
    chooseBackgroundImageBtn.addEventListener('click', () => {
      backgroundImagePicker.click();
    });

    backgroundImagePicker.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && backgroundOpacitySlider && backgroundBlurSlider && backgroundSizeSelect && backgroundScaleSlider) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const imageData = event.target.result;
          safeLocalStorage.setItem('backgroundImage', imageData);
          applyBackgroundImage(
            imageData,
            backgroundOpacitySlider.value,
            backgroundBlurSlider.value,
            backgroundSizeSelect.value,
            safeLocalStorage.getItem('backgroundPositionX') || 50,
            safeLocalStorage.getItem('backgroundPositionY') || 50,
            backgroundScaleSlider.value
          );
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Remove background image
  if (removeBackgroundImageBtn && backgroundOpacitySlider && backgroundBlurSlider && backgroundSizeSelect && backgroundScaleSlider && opacityValue && blurValue && scaleValue) {
    removeBackgroundImageBtn.addEventListener('click', () => {
      safeLocalStorage.removeItem('backgroundImage');
      safeLocalStorage.removeItem('backgroundOpacity');
      safeLocalStorage.removeItem('backgroundBlur');
      safeLocalStorage.removeItem('backgroundSize');
      safeLocalStorage.removeItem('backgroundPositionX');
      safeLocalStorage.removeItem('backgroundPositionY');
      safeLocalStorage.removeItem('backgroundScale');
      applyBackgroundImage(null);
      backgroundOpacitySlider.value = 100;
      opacityValue.textContent = '100%';
      backgroundBlurSlider.value = 0;
      blurValue.textContent = '0px';
      backgroundSizeSelect.value = 'contain';
      backgroundScaleSlider.value = 200;
      scaleValue.textContent = '200%';
    });

    // Opacity slider
    backgroundOpacitySlider.addEventListener('input', (e) => {
      const opacity = e.target.value;
      opacityValue.textContent = `${opacity}%`;
      const savedImage = safeLocalStorage.getItem('backgroundImage');
      if (savedImage) {
        safeLocalStorage.setItem('backgroundOpacity', opacity);
        applyBackgroundImage(
          savedImage,
          opacity,
          backgroundBlurSlider.value,
          backgroundSizeSelect.value,
          safeLocalStorage.getItem('backgroundPositionX') || 50,
          safeLocalStorage.getItem('backgroundPositionY') || 50,
          backgroundScaleSlider.value
        );
      }
    });

    // Blur slider
    backgroundBlurSlider.addEventListener('input', (e) => {
      const blur = e.target.value;
      blurValue.textContent = `${blur}px`;
      const savedImage = safeLocalStorage.getItem('backgroundImage');
      if (savedImage) {
        safeLocalStorage.setItem('backgroundBlur', blur);
        applyBackgroundImage(
          savedImage,
          backgroundOpacitySlider.value,
          blur,
          backgroundSizeSelect.value,
          safeLocalStorage.getItem('backgroundPositionX') || 50,
          safeLocalStorage.getItem('backgroundPositionY') || 50,
          backgroundScaleSlider.value
        );
      }
    });

    // Size select
    backgroundSizeSelect.addEventListener('change', (e) => {
      const size = e.target.value;
      const savedImage = safeLocalStorage.getItem('backgroundImage');
      if (savedImage) {
        safeLocalStorage.setItem('backgroundSize', size);
        applyBackgroundImage(
          savedImage,
          backgroundOpacitySlider.value,
          backgroundBlurSlider.value,
          size,
          safeLocalStorage.getItem('backgroundPositionX') || 50,
          safeLocalStorage.getItem('backgroundPositionY') || 50,
          backgroundScaleSlider.value
        );
      }
    });

    // Scale slider
    backgroundScaleSlider.addEventListener('input', (e) => {
      const scale = e.target.value;
      scaleValue.textContent = `${scale}%`;
      const savedImage = safeLocalStorage.getItem('backgroundImage');
      if (savedImage) {
        safeLocalStorage.setItem('backgroundScale', scale);
        applyBackgroundImage(
          savedImage,
          backgroundOpacitySlider.value,
          backgroundBlurSlider.value,
          backgroundSizeSelect.value,
          safeLocalStorage.getItem('backgroundPositionX') || 50,
          safeLocalStorage.getItem('backgroundPositionY') || 50,
          scale
        );
      }
    });
  }

  // Reposition background (drag mode)
  if (repositionBackgroundBtn && dragModeOverlay && closeDragModeBtn && backgroundOpacitySlider && backgroundBlurSlider && backgroundSizeSelect && backgroundScaleSlider) {
    repositionBackgroundBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const savedImage = safeLocalStorage.getItem('backgroundImage');
      if (!savedImage) {
        return;
      }

      const bgOverlay = document.getElementById('background-overlay');
      if (!bgOverlay) return;

    // Reload current position from localStorage when entering drag mode
    let currentPosX = parseFloat(safeLocalStorage.getItem('backgroundPositionX')) || 50;
    let currentPosY = parseFloat(safeLocalStorage.getItem('backgroundPositionY')) || 50;
    let dragStartX = 0;
    let dragStartY = 0;

    // Show the drag mode overlay and close all menus
    dragModeOverlay.style.display = 'flex';
    closeAllMenus();

    // Enable dragging - raise z-index above content (50) but below header (100)
    bgOverlay.style.cursor = 'move';
    bgOverlay.style.pointerEvents = 'auto';
    bgOverlay.style.zIndex = '50';

    // Keep banner at same z-index as header
    dragModeOverlay.style.zIndex = '100';

    const handleMouseDown = (event) => {
      // Don't start dragging if clicking on the exit button
      if (event.target === closeDragModeBtn || closeDragModeBtn.contains(event.target)) {
        return;
      }

      isDragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleMouseMove = (event) => {
      if (!isDragging) return;

      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;

      // Convert pixel movement to percentage based on window size
      const percentX = (deltaX / window.innerWidth) * 100;
      const percentY = (deltaY / window.innerHeight) * 100;

      // Update positions with stricter limits (-50% to 150%)
      currentPosX = Math.max(-50, Math.min(150, currentPosX + percentX));
      currentPosY = Math.max(-50, Math.min(150, currentPosY + percentY));

      dragStartX = event.clientX;
      dragStartY = event.clientY;

      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        backgroundBlurSlider.value,
        backgroundSizeSelect.value,
        currentPosX,
        currentPosY,
        backgroundScaleSlider.value
      );
    };

    const handleMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        safeLocalStorage.setItem('backgroundPositionX', currentPosX);
        safeLocalStorage.setItem('backgroundPositionY', currentPosY);
      }
    };

    const handleWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();

      // Get current scale from slider
      let currentScale = parseFloat(backgroundScaleSlider.value);

      // Adjust scale based on scroll direction
      const scaleChange = event.deltaY > 0 ? -5 : 5;
      currentScale = Math.max(10, Math.min(1000, currentScale + scaleChange));

      // Update slider and display
      backgroundScaleSlider.value = currentScale;
      scaleValue.textContent = `${currentScale}%`;

      // Save to localStorage
      safeLocalStorage.setItem('backgroundScale', currentScale);

      // Apply the new scale
      applyBackgroundImage(
        savedImage,
        backgroundOpacitySlider.value,
        backgroundBlurSlider.value,
        backgroundSizeSelect.value,
        currentPosX,
        currentPosY,
        currentScale
      );
    };

    const stopDragging = () => {
      // Hide overlay
      dragModeOverlay.style.display = 'none';

      // Reset background overlay
      bgOverlay.style.cursor = '';
      bgOverlay.style.pointerEvents = 'none';
      bgOverlay.style.zIndex = '0';

      // Remove event listeners
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('wheel', handleWheel);
      closeDragModeBtn.removeEventListener('click', stopDragging);

      // Save final position
      safeLocalStorage.setItem('backgroundPositionX', currentPosX);
      safeLocalStorage.setItem('backgroundPositionY', currentPosY);
    };

    // Listen on document instead of bgOverlay to bypass any blocking elements
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('wheel', handleWheel, { passive: false });

      // Set up banner close handler
      closeDragModeBtn.addEventListener('click', stopDragging);
    });
  }

  // GUI Scale select
  if (guiScaleSelect) {
    guiScaleSelect.addEventListener('change', (e) => {
      guiScale = parseInt(e.target.value);
      window.guiScale = guiScale;
      safeLocalStorage.setItem('guiScale', guiScale.toString());
      applyGuiScale();
    });
  }

  // Rescan all bookmarks button
  if (rescanAllBtn) {
    rescanAllBtn.addEventListener('click', async () => {
      if (!linkCheckingEnabled && !safetyCheckingEnabled) {
        alert('Both link checking and safety checking are disabled.\n\nEnable at least one in Settings to rescan bookmarks.');
        return;
      }

      try {
        // Check if scanner service is ready
        if (!window.scannerService || !window.scannerService.worker || !window.scannerService.workerInitialized) {
          alert('Scanner service is not ready yet. Please wait a moment and try again.');
          return;
        }

        // Stop any ongoing scan first
        if (scannerService && scannerService.isScanning) {
          scannerService.stopScan();
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Clear the checkedBookmarks set to allow re-checking
        checkedBookmarks.clear();

        // Reset all bookmark statuses to unknown
        function resetStatuses(nodes) {
          nodes.forEach(node => {
            if (node.url) {
              node.linkStatus = 'unknown';
              node.safetyStatus = 'unknown';
            }
            if (node.children) {
              resetStatuses(node.children);
            }
          });
        }
        resetStatuses(bookmarkTree);
        renderBookmarks();

        // Start scan using scanner service
        await scannerService.scanAllBookmarks(true);
      } catch (error) {
        console.error('Error rescanning bookmarks:', error);
        alert('Failed to rescan bookmarks. Please try again.');
      }
    });

    // Stop scan button
    const stopScanBtn = document.getElementById('stopScanBtn');
    if (stopScanBtn) {
      stopScanBtn.addEventListener('click', async () => {
        /* [ZeroLabs] 2026-06-20 12:21 AM - edited: also cancel front-end fallback loop */
        // Set the flag too: the worker-less fallback batch loop only checks
        // scanCancelled, so stopScan() alone would not halt it.
        scanCancelled = true;
        if (scannerService) {
          scannerService.stopScan();
          console.log('User requested scan cancellation');
        }
      });
    }

    // Listen for scanner events to update UI
    window.addEventListener('scanStarted', (e) => {
      const { total } = e.detail;

      // Show stop button, hide rescan button
      if (stopScanBtn) stopScanBtn.style.display = 'flex';
      if (rescanAllBtn) rescanAllBtn.style.display = 'none';

      // Update status bar
      if (scanProgress) scanProgress.textContent = `Scanning: 0/${total}`;
      if (scanStatusBar) scanStatusBar.classList.add('scanning');
    });

    window.addEventListener('scanProgress', (e) => {
      const { scanned, total } = e.detail;

      // Update status bar with current progress
      if (scanProgress) scanProgress.textContent = `Scanning: ${scanned}/${total}`;
    });

    window.addEventListener('scanComplete', (e) => {
      const { scanned, total } = e.detail;
      console.log(`[Scan Complete] ${scanned}/${total} bookmarks scanned`);

      // Hide stop button, show rescan button
      if (stopScanBtn) stopScanBtn.style.display = 'none';
      if (rescanAllBtn) rescanAllBtn.style.display = 'flex';

      // Update status bar
      if (scanProgress) scanProgress.textContent = 'Scan complete';
      if (scanStatusBar) scanStatusBar.classList.remove('scanning');

      // Reset to "Ready" after a brief delay
      setTimeout(() => {
        if (scanProgress) scanProgress.textContent = 'Ready';
      }, 2000);
    });

    window.addEventListener('scanCancelled', (e) => {
      const { scanned, total } = e.detail;
      console.log(`[Scan Cancelled] ${scanned}/${total} bookmarks scanned before cancellation`);

      // Hide stop button, show rescan button
      if (stopScanBtn) stopScanBtn.style.display = 'none';
      if (rescanAllBtn) rescanAllBtn.style.display = 'flex';

      // Update status bar
      if (scanProgress) scanProgress.textContent = 'Scan stopped';
      if (scanStatusBar) scanStatusBar.classList.remove('scanning');

      // Reset to "Ready" after a brief delay
      setTimeout(() => {
        if (scanProgress) scanProgress.textContent = 'Ready';
      }, 2000);
    });
  }

  // Set Google API Key
  setApiKeyBtn.addEventListener('click', async () => {
    const currentKey = await getDecryptedApiKey('googleSafeBrowsingApiKey');
    const hasKey = currentKey && currentKey.length > 0;

    const promptMessage = hasKey
      ? 'Google Safe Browsing API Key is currently set.\n\nEnter a new key to update, or leave blank to remove:'
      : 'Enter your Google Safe Browsing API Key:\n\n(Get a free key at: https://developers.google.com/safe-browsing/v4/get-started)\nFree tier: 10,000 requests/day\n\nLeave blank to disable Google Safe Browsing redundancy check.';

    const apiKey = prompt(promptMessage, '');

    if (apiKey !== null) { // User clicked OK (not Cancel)
      if (apiKey.trim() === '') {
        // Remove API key
        await safeStorage.remove('googleSafeBrowsingApiKey');
        alert('Google Safe Browsing API key removed.\n\nOnly URLhaus will be used for safety checking.');
      } else {
        // Save encrypted API key
        await storeEncryptedApiKey('googleSafeBrowsingApiKey', apiKey.trim());
        alert('Google Safe Browsing API key saved securely!\n\nSafety checking will now use:\n1. URLhaus (primary)\n2. Google Safe Browsing (redundancy)');
      }
      updateApiKeyButtonLabels();
    }
    closeAllMenus();
  });

  // Set VirusTotal API Key
  document.getElementById('setVirusTotalApiKeyBtn').addEventListener('click', async () => {
    const currentKey = await getDecryptedApiKey('virusTotalApiKey');
    const hasKey = currentKey && currentKey.length > 0;

    const promptMessage = hasKey
      ? 'VirusTotal API Key is currently set.\n\nEnter a new key to update, or leave blank to remove:'
      : 'Enter your VirusTotal API Key:\n\n(Get a free key at: https://www.virustotal.com/gui/my-apikey)\nFree tier: 500 requests/day, 4 requests/minute\n\nLeave blank to disable VirusTotal checking.';

    const apiKey = prompt(promptMessage, '');

    if (apiKey !== null) { // User clicked OK (not Cancel)
      if (apiKey.trim() === '') {
        // Remove API key
        await safeStorage.remove('virusTotalApiKey');
        alert('VirusTotal API key removed.\n\nVirusTotal checking is now disabled.');
      } else {
        // Save encrypted API key
        await storeEncryptedApiKey('virusTotalApiKey', apiKey.trim());
        alert('VirusTotal API key saved securely!\n\nSafety checking will now include VirusTotal scans.');
      }
      updateApiKeyButtonLabels();
    }
    closeAllMenus();
  });

  // Set Yandex API Key
  document.getElementById('setYandexApiKeyBtn').addEventListener('click', async () => {
    const currentKey = await getDecryptedApiKey('yandexApiKey');
    const hasKey = currentKey && currentKey.length > 0;

    const promptMessage = hasKey
      ? 'Yandex Safe Browsing API Key is currently set.\n\nEnter a new key to update, or leave blank to remove:'
      : 'Enter your Yandex Safe Browsing API Key:\n\n(Register at: https://yandex.com/dev/)\nFree tier: 100,000 requests/day\n\nLeave blank to disable Yandex Safe Browsing.';

    const apiKey = prompt(promptMessage, '');

    if (apiKey !== null) { // User clicked OK (not Cancel)
      if (apiKey.trim() === '') {
        // Remove API key
        await safeStorage.remove('yandexApiKey');
        alert('Yandex Safe Browsing API key removed.\n\nYandex checking is now disabled.');
      } else {
        // Save encrypted API key
        await storeEncryptedApiKey('yandexApiKey', apiKey.trim());
        alert('Yandex Safe Browsing API key saved securely!\n\nSafety checking will now include Yandex Safe Browsing.');
      }
      updateApiKeyButtonLabels();
    }
    closeAllMenus();
  });

  // Function to update API key button labels
  async function updateApiKeyButtonLabels() {
    const googleKey = await getDecryptedApiKey('googleSafeBrowsingApiKey');
    const vtKey = await getDecryptedApiKey('virusTotalApiKey');
    const yandexKey = await getDecryptedApiKey('yandexApiKey');

    const googleBtn = document.querySelector('#setApiKeyBtn span:last-child');
    const vtBtn = document.querySelector('#setVirusTotalApiKeyBtn span:last-child');
    const yandexBtn = document.querySelector('#setYandexApiKeyBtn span:last-child');

    if (googleBtn) {
      googleBtn.textContent = (googleKey && googleKey.length > 0)
        ? 'Change/Remove Google API Key'
        : 'Set Google API Key';
    }
    if (vtBtn) {
      vtBtn.textContent = (vtKey && vtKey.length > 0)
        ? 'Change/Remove VirusTotal API Key'
        : 'Set VirusTotal API Key';
    }
    if (yandexBtn) {
      yandexBtn.textContent = (yandexKey && yandexKey.length > 0)
        ? 'Change/Remove Yandex API Key'
        : 'Set Yandex API Key';
    }
  }

  // Update button labels on load
  updateApiKeyButtonLabels();

  // Help & Documentation
  const helpDocsBtn = document.getElementById('helpDocsBtn');
  helpDocsBtn.addEventListener('click', () => {
    const readmeUrl = 'https://bmz.absolutezero.fyi/';
    window.open(readmeUrl, '_blank');
    closeAllMenus();
  });

  // Buy Me a Coffee
  const buyMeCoffeeBtn = document.getElementById('buyMeCoffeeBtn');
  buyMeCoffeeBtn.addEventListener('click', () => {
    const coffeeUrl = 'https://buymeacoffee.com/absolutexyzero';
    window.open(coffeeUrl, '_blank');
    closeAllMenus();
  });

  // View Changelog
  const viewChangelogBtn = document.getElementById('viewChangelogBtn');
  const changelogModal = document.getElementById('changelogModal');
  const changelogModalClose = document.getElementById('changelogModalClose');
  const changelogModalOk = document.getElementById('changelogModalOk');
  const clearChangelogBtn = document.getElementById('clearChangelogBtn');
  const changelogList = document.getElementById('changelogList');
  const changelogCount = document.getElementById('changelogCount');

  if (viewChangelogBtn && changelogModal) {
    viewChangelogBtn.addEventListener('click', async () => {
      await openChangelogModal();
      closeAllMenus();
    });
  }

  if (changelogModalClose && changelogModal) {
    changelogModalClose.addEventListener('click', () => {
      closeModal(changelogModal);
    });
  }

  if (changelogModalOk && changelogModal) {
    changelogModalOk.addEventListener('click', () => {
      closeModal(changelogModal);
    });
  }

  if (clearChangelogBtn) {
    clearChangelogBtn.addEventListener('click', async () => {
      if (confirm('Are you sure you want to clear all changelog history? This action cannot be undone.')) {
        await clearChangelog();
        await openChangelogModal(); // Refresh the display
      }
    });
  }

  // Close extension
  if (closeExtensionBtn) {
    closeExtensionBtn.addEventListener('click', () => {
      closeExtension();
      closeAllMenus();
    });
  }

  // New bookmark
  document.getElementById('newBookmarkBtn').addEventListener('click', createNewBookmark);

  // New folder
  document.getElementById('newFolderBtn').addEventListener('click', createNewFolder);

  // Find duplicates
  document.getElementById('findDuplicatesBtn').addEventListener('click', findDuplicates);

  // Header collapse/expand
  if (headerCollapseBtn && collapsibleHeader) {
    headerCollapseBtn.addEventListener('click', () => {
      const isCollapsed = collapsibleHeader.classList.toggle('collapsed');
      headerCollapseBtn.classList.toggle('collapsed');
      headerCollapseBtn.title = isCollapsed ? 'Expand header' : 'Collapse header';

      // Save state to localStorage
      safeLocalStorage.setItem('headerCollapsed', isCollapsed);
    });

    // Restore header collapse state
    const headerCollapsed = safeLocalStorage.getItem('headerCollapsed') === 'true';
    if (headerCollapsed) {
      collapsibleHeader.classList.add('collapsed');
      headerCollapseBtn.classList.add('collapsed');
      headerCollapseBtn.title = 'Expand header';
    }
  }

  // Track when menus are opened to prevent immediate closing
  let menuJustOpened = false;

  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    // Don't close if menu was just opened
    if (menuJustOpened) {
      menuJustOpened = false;
      return;
    }

    if (!e.target.closest('#contextMenuModal .modal-content') &&
        !e.target.closest('.bookmark-menu-btn') &&
        !e.target.closest('.bookmark-preview-container') &&
        !e.target.closest('.settings-menu') &&
        !e.target.closest('#settingsBtn') &&
        !e.target.closest('.theme-btn-wrapper') &&
        !e.target.closest('.view-btn-wrapper') &&
        !e.target.closest('.zoom-btn-wrapper')) {
      closeAllMenus();
    }

    // Handle clicks on status icons (shield and chain)
    const statusIcon = e.target.closest('.clickable-status');
    if (statusIcon) {
      e.stopPropagation();
      const message = statusIcon.dataset.statusMessage;
      if (message) {
        alert(message);
      }
    }
  });

  // Edit modal event listeners
  const editModal = document.getElementById('editModal');
  const editModalClose = document.getElementById('editModalClose');
  const editModalCancel = document.getElementById('editModalCancel');
  const editModalSave = document.getElementById('editModalSave');
  const editModalOverlay = editModal.querySelector('.modal-overlay');

  editModalClose.addEventListener('click', closeEditModal);
  editModalCancel.addEventListener('click', closeEditModal);
  editModalSave.addEventListener('click', saveEditModal);
  editModalOverlay.addEventListener('click', closeEditModal);

  // Allow Enter key to save in modal
  editModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditModal();
    } else if (e.key === 'Escape') {
      closeEditModal();
    }
  });

  // Add Bookmark modal event listeners
  const addBookmarkModal = document.getElementById('addBookmarkModal');
  const addBookmarkModalClose = document.getElementById('addBookmarkModalClose');
  const addBookmarkModalCancel = document.getElementById('addBookmarkModalCancel');
  const addBookmarkModalSave = document.getElementById('addBookmarkModalSave');
  const addBookmarkModalOverlay = addBookmarkModal.querySelector('.modal-overlay');

  addBookmarkModalClose.addEventListener('click', closeAddBookmarkModal);
  addBookmarkModalCancel.addEventListener('click', closeAddBookmarkModal);
  addBookmarkModalSave.addEventListener('click', saveNewBookmark);
  addBookmarkModalOverlay.addEventListener('click', closeAddBookmarkModal);

  addBookmarkModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveNewBookmark();
    } else if (e.key === 'Escape') {
      closeAddBookmarkModal();
    }
  });

  // Add Folder modal event listeners
  const addFolderModal = document.getElementById('addFolderModal');
  const addFolderModalClose = document.getElementById('addFolderModalClose');
  const addFolderModalCancel = document.getElementById('addFolderModalCancel');
  const addFolderModalSave = document.getElementById('addFolderModalSave');
  const addFolderModalOverlay = addFolderModal.querySelector('.modal-overlay');

  addFolderModalClose.addEventListener('click', closeAddFolderModal);
  addFolderModalCancel.addEventListener('click', closeAddFolderModal);
  addFolderModalSave.addEventListener('click', saveNewFolder);
  addFolderModalOverlay.addEventListener('click', closeAddFolderModal);

  addFolderModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveNewFolder();
    } else if (e.key === 'Escape') {
      closeAddFolderModal();
    }
  });

  // Move To modal event listeners
  const moveToModal = document.getElementById('moveToModal');
  const moveToModalClose = document.getElementById('moveToModalClose');
  const moveToModalCancel = document.getElementById('moveToModalCancel');
  const moveToModalSave = document.getElementById('moveToModalSave');
  const moveToModalOverlay = moveToModal.querySelector('.modal-overlay');

  moveToModalClose.addEventListener('click', closeMoveToModal);
  moveToModalCancel.addEventListener('click', closeMoveToModal);
  moveToModalSave.addEventListener('click', saveMoveToModal);
  moveToModalOverlay.addEventListener('click', closeMoveToModal);

  moveToModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveMoveToModal();
    } else if (e.key === 'Escape') {
      closeMoveToModal();
    }
  });

  // Duplicates modal event listeners
  const duplicatesModal = document.getElementById('duplicatesModal');
  const duplicatesModalClose = document.getElementById('duplicatesModalClose');
  const duplicatesModalCancel = document.getElementById('duplicatesModalCancel');
  const duplicatesModalDelete = document.getElementById('duplicatesModalDelete');
  const duplicatesModalOverlay = duplicatesModal.querySelector('.modal-overlay');

  duplicatesModalClose.addEventListener('click', closeDuplicatesModal);
  duplicatesModalCancel.addEventListener('click', closeDuplicatesModal);
  duplicatesModalDelete.addEventListener('click', deleteSelectedDuplicates);
  duplicatesModalOverlay.addEventListener('click', closeDuplicatesModal);

  duplicatesModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDuplicatesModal();
    }
  });

  // BIDIRECTIONAL SYNC: Listen for bookmark changes (only in extension mode)
  // This ensures the extension automatically updates when bookmarks change in Firefox

  // Multi-select toggle button
  const multiSelectToggle = document.getElementById('multiSelectToggle');
  multiSelectToggle.addEventListener('click', () => {
    multiSelectMode = !multiSelectMode;

    // Toggle button appearance and ARIA state
    if (multiSelectMode) {
      multiSelectToggle.style.background = 'var(--md-sys-color-primary)';
      multiSelectToggle.style.color = 'var(--md-sys-color-on-primary)';
      multiSelectToggle.setAttribute('aria-pressed', 'true');
    } else {
      multiSelectToggle.style.background = '';
      multiSelectToggle.style.color = '';
      multiSelectToggle.setAttribute('aria-pressed', 'false');
      selectedItems.clear();
    }

    // Show/hide bulk actions bar
    const bulkActionsBar = document.getElementById('bulkActionsBar');
    bulkActionsBar.classList.toggle('hidden', !multiSelectMode);

    // Re-render to show/hide checkboxes
    renderBookmarks();
  });

  // Long-press to enter multi-select mode
  let longPressTimer = null;
  let longPressStartX = 0;
  let longPressStartY = 0;
  const LONG_PRESS_MS = 750;
  const LONG_PRESS_DRIFT_PX = 8;

  function enterMultiSelectFromLongPress(itemEl) {
    if (!multiSelectMode) {
      multiSelectMode = true;
      multiSelectToggle.style.background = 'var(--md-sys-color-primary)';
      multiSelectToggle.style.color = 'var(--md-sys-color-on-primary)';
      multiSelectToggle.setAttribute('aria-pressed', 'true');
      document.getElementById('bulkActionsBar').classList.remove('hidden');
      renderBookmarks();
    }
    const container = itemEl.closest('.bookmark-item, .folder-item');
    if (container && container.dataset.id) {
      selectedItems.add(container.dataset.id);
      const checkbox = container.querySelector('.item-checkbox');
      if (checkbox) checkbox.checked = true;
      updateSelectedCount();
    }
  }

  bookmarkList.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.bookmark-menu-btn, .item-checkbox, input, button, a')) return;
    const item = e.target.closest('.bookmark-item, .folder-header');
    if (!item) return;
    longPressStartX = e.clientX;
    longPressStartY = e.clientY;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      enterMultiSelectFromLongPress(item);
    }, LONG_PRESS_MS);
  });

  document.addEventListener('mousemove', (e) => {
    if (!longPressTimer) return;
    const dx = e.clientX - longPressStartX;
    const dy = e.clientY - longPressStartY;
    if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_DRIFT_PX) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  document.addEventListener('mouseup', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  bookmarkList.addEventListener('dragstart', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, true);

  // Bulk actions event delegation
  bookmarkList.addEventListener('change', (e) => {
    if (e.target.classList.contains('item-checkbox')) {
      const itemId = e.target.dataset.id;
      if (e.target.checked) {
        selectedItems.add(itemId);
      } else {
        selectedItems.delete(itemId);
      }
      updateSelectedCount();
    }
  });

  // Bulk action buttons
  document.getElementById('bulkSelectAll').addEventListener('click', () => {
    // Select all visible items
    const checkboxes = bookmarkList.querySelectorAll('.item-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = true;
      selectedItems.add(cb.dataset.id);
    });
    updateSelectedCount();
  });

  document.getElementById('bulkDeselectAll').addEventListener('click', () => {
    // Deselect all
    const checkboxes = bookmarkList.querySelectorAll('.item-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = false;
    });
    selectedItems.clear();
    updateSelectedCount();
  });

  document.getElementById('bulkOpenTabs').addEventListener('click', () => {
    bulkOpenItems();
  });

  document.getElementById('bulkOpenWindows').addEventListener('click', () => {
    bulkOpenInWindows();
  });

  document.getElementById('bulkRecheck').addEventListener('click', async () => {
    await bulkRecheckItems();
  });

  document.getElementById('bulkMove').addEventListener('click', async () => {
    await bulkMoveItems();
  });

  document.getElementById('bulkDelete').addEventListener('click', async () => {
    await bulkDeleteItems();
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    // Skip if user is typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    // Skip if a modal is open
    if (!document.getElementById('editModal').classList.contains('hidden') ||
        !document.getElementById('addBookmarkModal').classList.contains('hidden') ||
        !document.getElementById('addFolderModal').classList.contains('hidden') ||
        !document.getElementById('duplicatesModal').classList.contains('hidden')) {
      return;
    }

    // Build list of visible items (both folders and bookmarks)
    const folderElements = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
    const bookmarkElements = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));

    // Combine and sort by DOM position
    const allElements = [...folderElements, ...bookmarkElements].sort((a, b) => {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    if (allElements.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedBookmarkIndex = Math.min(selectedBookmarkIndex + 1, allElements.length - 1);
        highlightSelectedItem(allElements);
        break;

      case 'ArrowUp':
        e.preventDefault();
        selectedBookmarkIndex = Math.max(selectedBookmarkIndex - 1, 0);
        highlightSelectedItem(allElements);
        break;

      case 'ArrowRight':
        e.preventDefault();
        if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
          const selectedElement = allElements[selectedBookmarkIndex];
          if (selectedElement.classList.contains('folder-header')) {
            // Check if folder is already expanded
            const toggle = selectedElement.querySelector('.folder-toggle');
            if (!toggle.classList.contains('expanded')) {
              // Expand folder if collapsed
              selectedElement.click();
              // After expanding, rebuild the list and maintain selection
              setTimeout(() => {
                const updatedFolders = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
                const updatedBookmarks = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));
                const updatedElements = [...updatedFolders, ...updatedBookmarks].sort((a, b) => {
                  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                });
                highlightSelectedItem(updatedElements);
              }, 50);
            } else {
              // Folder already expanded, move down to next item
              selectedBookmarkIndex = Math.min(selectedBookmarkIndex + 1, allElements.length - 1);
              highlightSelectedItem(allElements);
            }
          } else {
            // For bookmarks, check if preview is already shown
            if (selectedElement.classList.contains('force-preview')) {
              // Preview already shown, move down to next item
              selectedBookmarkIndex = Math.min(selectedBookmarkIndex + 1, allElements.length - 1);
              highlightSelectedItem(allElements);
            } else {
              // Show preview for bookmark
              const previewContainer = selectedElement.querySelector('.bookmark-preview-container');
              if (previewContainer) {
                selectedElement.classList.add('force-preview');
                const previewImg = previewContainer.querySelector('.preview-image');
                const url = previewImg.dataset.url;
                if (url && !loadedPreviews.has(url)) {
                  // Trigger preview load
                  previewImg.src = `https://s0.wp.com/mshots/v1/${encodeURIComponent(url)}?w=400&h=300`;
                  previewImg.onload = () => {
                    previewImg.classList.add('loaded');
                    loadedPreviews.add(url);
                  };
                  loadedPreviews.add(url);
                } else if (url) {
                  previewImg.classList.add('loaded');
                }
              }
            }
          }
        }
        break;

      case 'ArrowLeft':
        e.preventDefault();
        if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
          const selectedElement = allElements[selectedBookmarkIndex];
          if (selectedElement.classList.contains('folder-header')) {
            // Check if folder is expanded
            const toggle = selectedElement.querySelector('.folder-toggle');
            if (toggle.classList.contains('expanded')) {
              // Collapse folder if expanded
              selectedElement.click();
              // After collapsing, rebuild the list and maintain selection
              setTimeout(() => {
                const updatedFolders = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
                const updatedBookmarks = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));
                const updatedElements = [...updatedFolders, ...updatedBookmarks].sort((a, b) => {
                  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                });
                highlightSelectedItem(updatedElements);
              }, 50);
            } else {
              // Folder already collapsed, move up to previous item
              selectedBookmarkIndex = Math.max(selectedBookmarkIndex - 1, 0);
              highlightSelectedItem(allElements);
            }
          } else {
            // For bookmarks, check if preview is shown
            if (selectedElement.classList.contains('force-preview')) {
              // Hide preview for bookmark
              selectedElement.classList.remove('force-preview');
            } else {
              // Preview already hidden, move up to previous item
              selectedBookmarkIndex = Math.max(selectedBookmarkIndex - 1, 0);
              highlightSelectedItem(allElements);
            }
          }
        }
        break;

      case 'Enter':
        e.preventDefault();
        if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
          const selectedElement = allElements[selectedBookmarkIndex];
          // Check if it's a folder header or bookmark
          if (selectedElement.classList.contains('folder-header')) {
            // Toggle folder
            selectedElement.click();
            // After toggling, rebuild the list and maintain selection
            setTimeout(() => {
              const updatedFolders = Array.from(bookmarkList.querySelectorAll('.folder-item .folder-header'));
              const updatedBookmarks = Array.from(bookmarkList.querySelectorAll('.bookmark-item'));
              const updatedElements = [...updatedFolders, ...updatedBookmarks].sort((a, b) => {
                return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
              });
              highlightSelectedItem(updatedElements);
            }, 50);
          } else {
            // Open bookmark
            selectedElement.click();
          }
        }
        break;

      case 'Escape':
        // Clear selection
        selectedBookmarkIndex = -1;
        allElements.forEach(el => el.style.outline = '');
        break;
    }
  });

  // Undo toast event listeners
  undoButton.addEventListener('click', () => {
    performUndo();
  });

  undoDismiss.addEventListener('click', () => {
    hideUndoToast();
  });

  // Context Menu Modal event listeners
  const contextMenuModal = document.getElementById('contextMenuModal');
  if (contextMenuModal) {
    const contextMenuModalClose = document.getElementById('contextMenuModalClose');
    const contextMenuModalOverlay = contextMenuModal.querySelector('.modal-overlay');

    if (contextMenuModalClose) {
      contextMenuModalClose.addEventListener('click', closeContextMenuModal);
    }
    if (contextMenuModalOverlay) {
      contextMenuModalOverlay.addEventListener('click', closeContextMenuModal);
    }

    contextMenuModal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeContextMenuModal();
      }
    });
  }

  } catch (error) {
    console.error('[Setup] Error in remaining event listeners:', error);
  }

  eventListenersSetUp = true;
}

// Highlight the selected item (folder or bookmark) for keyboard navigation
function highlightSelectedItem(allElements) {
  // Remove highlight from all items
  allElements.forEach(el => el.style.outline = '');

  // Add highlight to selected item
  if (selectedBookmarkIndex >= 0 && selectedBookmarkIndex < allElements.length) {
    const selected = allElements[selectedBookmarkIndex];
    selected.style.outline = '2px solid var(--md-sys-color-primary)';
    selected.style.outlineOffset = '2px';
    selected.style.borderRadius = '8px';
    // Scroll into view
    selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Split initialization into UI setup (immediate) and bookmark loading (after auth)
async function initUI() {
  // Force update logo title
  const logoTitle = document.querySelector('.logo-title');
  const logoSubtitle = document.querySelector('.logo-subtitle');
  /* [ZeroLabs] 2026-06-20 1:58 PM - edited: version scales with title (em) */
  if (logoTitle) logoTitle.innerHTML = `Bookmark Manager Zero • <span style="color: var(--md-sys-color-primary); font-weight: 500; font-size: 0.85em;">v${APP_VERSION}</span>`;
  if (logoSubtitle) logoSubtitle.textContent = 'A modern safety & privacy first bookmark manager';

  // Setup all UI elements and event listeners
  loadTheme();
  loadView();
  loadZoom();
  loadFontSize();
  loadGuiScale();
  loadBackgroundImage();
  loadContainerOpacity();
  loadCheckingSettings();
  loadDisplayOptions();
  loadActiveFilters();
  await loadAutoClearSetting();
  setupEventListeners();
  setupBlocklistProgressListener();
}

// Initialize UI immediately when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}

// Export full init function for app.js to call after authentication
window.initSidebar = init;

/* [ZeroLabs] 2026-08-09 1:31 PM - added: entry point for Android share intents */
window.openShareBookmarkModal = openShareBookmarkModal;
