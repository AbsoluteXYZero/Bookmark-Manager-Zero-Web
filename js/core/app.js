/**
 * Main Application Logic
 * Initializes all managers and handles app-wide functionality
 * Theme management, settings, modals, and global event handlers
 */

import dbManager from '../storage/indexeddb.js';
import authManager from '../auth/auth-manager.js';
import oauthPAT from '../auth/oauth-pat.js';
import snippetAdapter from '../storage/snippet-adapter.js';
import syncManager from '../storage/sync-manager.js';
/* [ZeroLabs] 2026-08-27 - added: the auto-sync toggle is stored here */
import storageAdapter from '../storage/storage-adapter.js';
import bookmarkManager from './bookmarks.js';
import blocklistService from './blocklist-service.js';
import scannerService from './scanner.js';
import { exportAsHTML } from '../import-export/html-exporter.js';
import { exportAsJSON } from '../import-export/json-exporter.js';
import { importFromHTML } from '../import-export/html-parser.js';
import { importFromJSON } from '../import-export/json-parser.js';
import touchHandler from '../mobile/touch-handler.js';
import { safeLocalStorage, addChangelogEntry, clearChangelog } from '../utils/storage-utils.js';
import supabaseManager from '../auth/supabase-manager.js';

/* [ZeroLabs] 2026-09-24 1:35 AM - added: a notice body that copies up to 5.8 cannot see */
// Every copy of BMZ up to and including 5.8 keeps a notice only when its
// `text` is a string, and nothing older reads notices at all. So an entry
// whose body is in `message` instead is skipped by those copies in silence,
// with nothing to deploy to them. This copy reads `message` first and still
// accepts `text`, so the entries written before this change keep working.
//
// Returns the notice with its body in `text`, which is what the dialog and
// the Event Log read, or null when it has no body at all.
function noticeWithBody(notice) {
  if (!notice) return null;
  if (typeof notice.message === 'string') return { ...notice, text: notice.message };
  if (typeof notice.text === 'string') return notice;
  return null;
}

/* [ZeroLabs] 2026-09-24 1:05 AM - added: does this copy run the version a notice is about */
// Versions are compared number by number, so 5.10 is correctly newer than 5.9,
// which a plain string comparison gets wrong. A missing part counts as 0, so
// "5.9" and "5.9.0" are equal. An entry with no `version` is for everyone, and
// so is every entry when this copy's own version cannot be read, which keeps
// the behaviour from before this check existed.
function noticeFitsVersion(notice, appVersion) {
  if (!notice.version || !appVersion) return true;

  const have = String(appVersion).split('.').map(part => parseInt(part, 10) || 0);
  const need = String(notice.version).split('.').map(part => parseInt(part, 10) || 0);
  const length = Math.max(have.length, need.length);

  for (let index = 0; index < length; index++) {
    const mine = have[index] || 0;
    const wanted = need[index] || 0;
    if (mine > wanted) return true;
    if (mine < wanted) return false;
  }
  return true;
}

/* [ZeroLabs] 2026-09-24 3:00 AM - added: are the two sides already the same */
// When this device and the repository hold exactly the same bookmarks, the
// three-way question has no answer worth asking: merging, keeping the cloud and
// keeping this device all end in the same place. So the connect skips it.
//
// "The same" means every bookmark matches on URL, title and folder, with the
// same number of copies of each. Titles are compared trimmed, as everywhere
// else in sync, because a browser keeps a trailing space an HTML round trip
// drops. Order inside a folder is NOT compared: it syncs separately, and the
// repository's order is taken on the next sync.
function snippetsMatch(localData, remoteData) {
  const countEntries = (data) => {
    const counts = new Map();
    const walk = (node, rootKey, segments) => {
      if (!node) return;
      if (node.url) {
        const key = [rootKey, segments.join('/'), String(node.title || '').trim(), node.url].join('\u0000');
        counts.set(key, (counts.get(key) || 0) + 1);
        return;
      }
      (node.children || []).forEach(child => {
        const nextSegments = child.url
          ? segments
          : segments.concat(String(child.title || child.name || '').trim());
        walk(child, rootKey, nextSegments);
      });
    };
    Object.keys((data && data.roots) || {}).forEach(rootKey => {
      walk(data.roots[rootKey], rootKey, []);
    });
    return counts;
  };

  const local = countEntries(localData);
  const remote = countEntries(remoteData);
  if (local.size !== remote.size) return false;
  for (const [key, count] of local) {
    if (remote.get(key) !== count) return false;
  }
  return true;
}

class App {
  constructor() {
    this.currentTheme = 'enhanced-blue';
    this.isAuthenticated = false;
    this.isInitialized = false;
    this.currentUser = null;
    this._rotationPromptActive = false;
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      console.log('Initializing Bookmark Manager Zero Web...');

      /* [ZeroLabs] 2026-08-09 1:31 PM - added: detect share intent before anything scans */
      this.shareIntent = this.parseShareIntent();
      if (this.shareIntent) {
        window.__bmzShareMode = true;
        document.documentElement.classList.add('share-mode');
        console.log('[Share] Share intent detected, link and safety checking disabled');
      }

      // Initialize IndexedDB first (needed for everything)
      await dbManager.init();

      // Load theme early for visual consistency
      await this.loadTheme();

      // Set up global event listeners and touch handler FIRST
      // This ensures UI is responsive while auth/loading happens
      this.setupEventListeners();
      this.setupSyncListeners();
      touchHandler.init();

      // Check authentication IMMEDIATELY - this will show/hide screens appropriately
      await this.checkAuth();

      // Everything else happens in showMainApp() after auth succeeds

      this.isInitialized = true;
      console.log('App initialized successfully');
    } catch (error) {
      console.error('Failed to initialize app:', error);
      this.showError('Failed to initialize application', error);
    }
  }

  /**
   * Read an Android share intent off the URL fragment.
   * Fragment rather than query string so the shared URL is never sent to the
   * GitLab Pages server or written into its access logs.
   * Format: #share?url=<encoded>&title=<encoded>
   */
  /* [ZeroLabs] 2026-08-09 1:31 PM - added: parse share intent from hash */
  parseShareIntent() {
    try {
      const hash = window.location.hash || '';
      const prefix = '#share?';
      if (!hash.startsWith(prefix)) return null;

      const params = new URLSearchParams(hash.slice(prefix.length));
      const url = params.get('url');
      if (!url) return null;

      return { url, title: params.get('title') || '' };
    } catch (e) {
      console.warn('[Share] Failed to parse share intent:', e.message);
      return null;
    }
  }

  /**
   * Clean up corrupted localStorage and IndexedDB data
   */
  async cleanupLocalStorage() {
    try {
      // Clean localStorage
      const savedSnippetId = safeLocalStorage.getItem('bmz_snippet_id');
      if (savedSnippetId) {
        // Check if it's an object instead of a string
        if (savedSnippetId.startsWith('{') || savedSnippetId.startsWith('[')) {
          console.warn('Found corrupted snippet ID in localStorage, clearing...');
          safeLocalStorage.removeItem('bmz_snippet_id');
        }
      }

      // Clean IndexedDB
      const snippetIdRecord = await dbManager.get('metadata', 'snippetId');
      if (snippetIdRecord && snippetIdRecord.value) {
        const value = snippetIdRecord.value;
        // Check if it's an object instead of a string
        if (typeof value === 'object') {
          console.warn('Found corrupted snippet ID in IndexedDB, clearing...');
          await dbManager.delete('metadata', 'snippetId');
        }
      }
    } catch (error) {
      console.error('Error cleaning storage:', error);
    }
  }

  /**
   * Check if user is authenticated
   */
  // Shared helper: validate a GitLab PAT and transition to the main app
  async _authenticateWithPAT(token) {
    try {
      const response = await fetch('https://gitlab.com/api/v4/user', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) return false;
      const user = await response.json();

      await authManager.storeToken(token, null, 'gitlab');
      await authManager.storePreference('syncProvider', 'gitlab');
      await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
      safeLocalStorage.setItem('bmz_mode_chosen', 'true');
      safeLocalStorage.removeItem('bmz_local_mode');
      /* [ZeroLabs] 2026-09-24 2:10 AM - fixed: leave local mode in IndexedDB too */
      // showMainApp reads local mode from IndexedDB, and IndexedDB is the
      // source of truth here. Only the localStorage copy was cleared, so after
      // a sign-out had set it to true, logging back in with a stored token took
      // the local-mode branch: login icon still showing, sync never started.
      // The connect dialog's own path already wrote false here.
      await dbManager.put('settings', { key: 'bmz_local_mode', value: false });

      oauthPAT.token = token;
      oauthPAT.user = user;
      this.currentUser = user;
      this.isAuthenticated = true;

      await this.showMainApp();
      return true;
    } catch (e) {
      console.error('[Auth] _authenticateWithPAT failed:', e);
      return false;
    }
  }

  async checkAuth() {
    // Special case: Supabase OAuth redirect — URL contains access_token fragment
    if (window.location.hash.includes('access_token')) {
      try {
        const wasCallback = await supabaseManager.handleOAuthCallback();
        if (wasCallback) {
          const patData = await supabaseManager.loadGitLabToken();
          if (patData) {
            const authenticated = await this._authenticateWithPAT(patData.token);
            if (authenticated) return;
          }
          this._supabaseJustSignedIn = true;
        }
      } catch (e) {
        console.error('[Auth] OAuth callback error:', e.message);
        this._oauthError = e.message;
      }
    }

    // Read local state first — IndexedDB only, no network
    const modeChosenRecord = await dbManager.get('settings', 'bmz_mode_chosen');
    const hasChosenMode = modeChosenRecord && modeChosenRecord.value === true;
    const localModeRecord = await dbManager.get('settings', 'bmz_local_mode');
    const isLocalMode = localModeRecord && localModeRecord.value === true;

    // No mode chosen yet
    if (!hasChosenMode) {
      const bookmarkTree = await dbManager.get('metadata', 'bookmarkTree');
      const hasLocalBookmarks = bookmarkTree && bookmarkTree.value && bookmarkTree.value.roots;
      if (hasLocalBookmarks) {
        const shouldContinue = await this.showContinueWithLocalBookmarksDialog();
        if (shouldContinue) {
          await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          safeLocalStorage.setItem('bmz_local_mode', 'true');
          safeLocalStorage.setItem('bmz_mode_chosen', 'true');
          this.isAuthenticated = true;
          await this.showMainApp();
          this.showToast('Continuing with local bookmarks. You can connect GitLab anytime for cloud sync.', 'success');
        } else {
          this.showLoginScreen();
        }
      } else {
        this.showLoginScreen();
      }
      return;
    }

    // Local mode — show immediately, no network needed
    if (isLocalMode) {
      const bookmarkTree = await dbManager.get('metadata', 'bookmarkTree');
      if (bookmarkTree && bookmarkTree.value && bookmarkTree.value.roots) {
        this.isAuthenticated = true;
        await this.showMainApp();
      } else {
        this.showLoginScreen();
      }
      return;
    }

    // GitLab mode — check for locally stored token first (fast, no network)
    const token = await authManager.getToken('gitlab');
    if (token) {
      // Trust the stored token and show the app immediately
      oauthPAT.provider = 'gitlab';
      oauthPAT.token = token;
      this.isAuthenticated = true;
      await this.showMainApp();

      // Verify token in background — if invalid, redirect to login
      fetch('https://gitlab.com/api/v4/user', {
        headers: { 'Authorization': 'Bearer ' + token },
        signal: AbortSignal.timeout(15000)
      }).then(async r => {
        if (r.ok) {
          this.currentUser = await r.json();
          oauthPAT.user = this.currentUser;
        } else {
          await authManager.clearToken('gitlab');
          this.showLoginScreen();
        }
      }).catch(() => { /* network unavailable — stay on cached app */ });
      return;
    }

    // GitLab mode but no local token — show login immediately,
    // then try Supabase in background in case token is stored there
    this.showLoginScreen();
    supabaseManager.loadSession().then(async () => {
      if (!supabaseManager.isSignedIn) return;
      const tokenMode = await supabaseManager.getTokenMode();
      if (tokenMode !== 'supabase') return;
      const patData = await supabaseManager.loadGitLabToken();
      if (patData) await this._authenticateWithPAT(patData.token);
    }).catch(() => {});
  }

  /**
   * Show login screen
   */
  showLoginScreen() {
    const loginScreen = document.getElementById('loginScreen');
    if (loginScreen) {
      loginScreen.classList.remove('hidden');
      // Clear any inline display style that may have been set to prevent flash
      loginScreen.style.display = '';
    }

    // Hide logout and manual sync buttons on login screen
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.style.display = 'none';
    }

    const manualSyncBtn = document.getElementById('manualSyncBtn');
    if (manualSyncBtn) {
      manualSyncBtn.style.display = 'none';
    }

    // Add show-login class to html element to make login screen visible
    document.documentElement.classList.add('show-login');

    /* [ZeroLabs] 2026-08-27 - added: the app has decided, drop the boot loader */
    document.documentElement.classList.add('booted');

    // Only set up handlers once - check if already initialized
    if (this._loginHandlersInitialized) {
      return;
    }
    this._loginHandlersInitialized = true;

    // Provider switcher is already exposed in constructor
    // Just set up login handlers
    setTimeout(() => {
      this.setupLoginHandlers();
    }, 0);
  }


  /**
   * Set up login button handlers
   */
  setupLoginHandlers() {
    // Set up mode toggle buttons
    const localModeBtn = document.getElementById('localModeBtn');
    const gitlabModeBtn = document.getElementById('gitlabModeBtn');
    const localInstructions = document.getElementById('localInstructions');
    const gitlabInstructions = document.getElementById('gitlabInstructions');

    if (localModeBtn && gitlabModeBtn) {
      localModeBtn.onclick = () => {
        // Update button styles
        localModeBtn.style.background = 'var(--md-sys-color-primary)';
        localModeBtn.style.color = 'var(--md-sys-color-on-primary)';
        localModeBtn.style.borderColor = 'var(--md-sys-color-primary)';
        gitlabModeBtn.style.background = 'var(--md-sys-color-surface-variant)';
        gitlabModeBtn.style.color = 'var(--md-sys-color-on-surface-variant)';
        gitlabModeBtn.style.borderColor = 'var(--md-sys-color-outline)';

        // Show/hide instructions
        if (localInstructions) localInstructions.style.display = 'block';
        if (gitlabInstructions) gitlabInstructions.style.display = 'none';
      };

      gitlabModeBtn.onclick = () => {
        // Update button styles
        gitlabModeBtn.style.background = 'var(--md-sys-color-primary)';
        gitlabModeBtn.style.color = 'var(--md-sys-color-on-primary)';
        gitlabModeBtn.style.borderColor = 'var(--md-sys-color-primary)';
        localModeBtn.style.background = 'var(--md-sys-color-surface-variant)';
        localModeBtn.style.color = 'var(--md-sys-color-on-surface-variant)';
        localModeBtn.style.borderColor = 'var(--md-sys-color-outline)';

        // Show/hide instructions
        if (gitlabInstructions) gitlabInstructions.style.display = 'block';
        if (localInstructions) localInstructions.style.display = 'none';
      };
    }

    // Set up local mode file import
    const selectFileBtn = document.getElementById('selectFileBtn');
    const localModeFileInput = document.getElementById('localModeFileInput');
    const localModeError = document.getElementById('localModeError');

    if (selectFileBtn && localModeFileInput) {
      selectFileBtn.onclick = () => {
        localModeFileInput.click();
      };

      localModeFileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
          if (localModeError) localModeError.style.display = 'none';
          selectFileBtn.disabled = true;
          selectFileBtn.textContent = 'Importing...';
          localModeFileInput.disabled = true;

          // const text = await file.text();
          let bookmarks;

          if (file.name.endsWith('.json')) {
            bookmarks = await importFromJSON(file);
          } else if (file.name.endsWith('.html')) {
            bookmarks = await importFromHTML(file);
          } else {
            throw new Error('Unsupported file format. Please use .html or .json files.');
          }

          // Store bookmarks in local storage
          await bookmarkManager.replaceTree(bookmarks);

          // Store a flag indicating local mode (IndexedDB is source of truth, localStorage is cache)
          await authManager.storePreference('syncProvider', 'local');
          await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          safeLocalStorage.setItem('bmz_local_mode', 'true');
          safeLocalStorage.setItem('bmz_mode_chosen', 'true');

          // Show success and load main app
          await this.showMainApp();

        } catch (error) {
          console.error('Import failed:', error);
          if (localModeError) {
            localModeError.textContent = error.message || 'Failed to import bookmarks. Please check the file and try again.';
            localModeError.style.display = 'block';
          }
          selectFileBtn.disabled = false;
          selectFileBtn.textContent = 'Select Bookmarks File';
          localModeFileInput.disabled = false;
          localModeFileInput.value = '';
        }
      };
    }

    // Check for existing local bookmarks
    const continueExistingBtn = document.getElementById('continueExistingBtn');
    (async () => {
      try {
        console.log('[LoginScreen] Checking for existing local bookmarks...');
        const bookmarkTree = await dbManager.get('metadata', 'bookmarkTree');
        console.log('[LoginScreen] Bookmark tree result:', bookmarkTree);
        
        const hasExistingBookmarks = bookmarkTree && bookmarkTree.value && bookmarkTree.value.roots && Object.keys(bookmarkTree.value.roots).length > 0;
        console.log('[LoginScreen] Has existing bookmarks:', hasExistingBookmarks);
        
        if (hasExistingBookmarks && continueExistingBtn) {
          console.log('[LoginScreen] Showing continue button');
          continueExistingBtn.style.display = 'block';
        } else {
          console.log('[LoginScreen] Not showing continue button - button element:', !!continueExistingBtn, 'has bookmarks:', hasExistingBookmarks);
        }
      } catch (error) {
        console.error('[LoginScreen] Failed to check for existing bookmarks:', error);
      }
    })();

    // Set up continue existing bookmarks button
    if (continueExistingBtn) {
      continueExistingBtn.onclick = async () => {
        try {
          if (localModeError) localModeError.style.display = 'none';
          continueExistingBtn.disabled = true;
          continueExistingBtn.textContent = 'Loading...';

          // Set local mode flag (IndexedDB is source of truth, localStorage is cache)
          await authManager.storePreference('syncProvider', 'local');
          await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          safeLocalStorage.setItem('bmz_local_mode', 'true');
          safeLocalStorage.setItem('bmz_mode_chosen', 'true');

          // Load and show main app
          await this.showMainApp();

        } catch (error) {
          console.error('Continue failed:', error);
          if (localModeError) {
            localModeError.textContent = error.message || 'Failed to continue. Please try again.';
            localModeError.style.display = 'block';
          }
          continueExistingBtn.disabled = false;
          continueExistingBtn.textContent = 'Continue with Existing Bookmarks';
        }
      };
    }

    // Set up start fresh button
    const startFreshBtn = document.getElementById('startFreshBtn');
    if (startFreshBtn) {
      startFreshBtn.onclick = async () => {
        // Confirm with user before clearing everything (custom modal avoids Android WebView confirm() issues)
        const confirmed = await new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
          const dialog = document.createElement('div');
          dialog.style.cssText = 'background:var(--md-sys-color-surface,#1e293b);padding:24px;border-radius:12px;max-width:420px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.3);';
          dialog.innerHTML = `
            <h3 style="margin:0 0 12px 0;color:var(--md-sys-color-on-surface,#f1f5f9);font-size:18px;">⚠️ Start Fresh</h3>
            <p style="margin:0 0 20px 0;color:var(--md-sys-color-on-surface-variant,#cbd5e1);line-height:1.6;font-size:14px;">
              This will delete all existing bookmarks and create an empty bookmark list.<br><br>
              <strong style="color:var(--md-sys-color-error,#f87171);">This action cannot be undone.</strong>
            </p>
            <div style="display:flex;gap:12px;justify-content:flex-end;">
              <button id="_sfCancel" style="padding:10px 20px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#334155);color:var(--md-sys-color-on-surface-variant,#cbd5e1);cursor:pointer;font-size:14px;font-weight:500;">Cancel</button>
              <button id="_sfConfirm" style="padding:10px 20px;border-radius:8px;border:none;background:var(--md-sys-color-error,#ef4444);color:#fff;cursor:pointer;font-size:14px;font-weight:500;">Delete All &amp; Start Fresh</button>
            </div>
          `;
          document.body.appendChild(overlay);
          overlay.appendChild(dialog);
          dialog.querySelector('#_sfConfirm').addEventListener('click', () => { overlay.remove(); resolve(true); });
          dialog.querySelector('#_sfCancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
          overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
        });

        if (!confirmed) {
          return;
        }

        try {
          if (localModeError) localModeError.style.display = 'none';
          startFreshBtn.disabled = true;
          startFreshBtn.textContent = 'Setting up...';

          // Create empty bookmark tree structure
          const emptyTree = syncManager.getEmptyBookmarkTree();

          // Use bookmarkManager to properly save the empty tree
          await bookmarkManager.replaceTree(emptyTree);

          // Store a flag indicating local mode (IndexedDB is source of truth, localStorage is cache)
          await authManager.storePreference('syncProvider', 'local');
          await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          safeLocalStorage.setItem('bmz_local_mode', 'true');
          safeLocalStorage.setItem('bmz_mode_chosen', 'true');

          // Hide continue button since we just deleted everything
          if (continueExistingBtn) {
            continueExistingBtn.style.display = 'none';
          }

          // Show success and load main app
          await this.showMainApp();

        } catch (error) {
          console.error('Start fresh failed:', error);
          if (localModeError) {
            localModeError.textContent = error.message || 'Failed to start fresh. Please try again.';
            localModeError.style.display = 'block';
          }
          startFreshBtn.disabled = false;
          startFreshBtn.textContent = 'Start Fresh';
        }
      };
    }

    // Wire up "Sign in with GitLab" OAuth button
    const oauthSignInBtn = document.getElementById('oauthSignInBtn');
    if (oauthSignInBtn) {
      oauthSignInBtn.onclick = () => supabaseManager.signInWithGitLab();
    }

    // If the user just returned from OAuth, show a confirmation banner and pre-select GitLab tab
    if (this._supabaseJustSignedIn) {
      if (gitlabModeBtn) gitlabModeBtn.click();
      const oauthBanner = document.getElementById('oauthSuccessBanner');
      if (oauthBanner) oauthBanner.style.display = 'block';
    }

    // Auto-check saveToSupabaseCheck if already signed in with Supabase
    if (supabaseManager.isSignedIn) {
      const saveToSupabase = document.getElementById('saveToSupabaseCheck');
      if (saveToSupabase) saveToSupabase.checked = true;
    }

    // If there was an OAuth error, show it
    if (this._oauthError) {
      if (gitlabModeBtn) gitlabModeBtn.click();
      if (loginErrorGitlab) {
        loginErrorGitlab.textContent = this._oauthError;
        loginErrorGitlab.style.display = 'block';
      }
    }

    // Set up GitLab login button handler
    const loginBtnGitlab = document.getElementById('loginBtnGitlab');
    const tokenInputGitlab = document.getElementById('tokenInputGitlab');
    const loginErrorGitlab = document.getElementById('loginErrorGitlab');

    if (loginBtnGitlab && tokenInputGitlab) {
      // Handle Enter key in token input
      tokenInputGitlab.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          loginBtnGitlab.click();
        }
      });

      loginBtnGitlab.onclick = async () => {
        const token = tokenInputGitlab.value.trim();

        if (!token) {
          if (loginErrorGitlab) {
            loginErrorGitlab.textContent = 'Please enter your Personal Access Token';
            loginErrorGitlab.style.display = 'block';
          }
          return;
        }

        // Show loading state
        loginBtnGitlab.disabled = true;
        loginBtnGitlab.textContent = 'Authenticating...';
        if (loginErrorGitlab) loginErrorGitlab.style.display = 'none';

        try {
          // Authenticate with token (GitLab only)
          const authResult = await oauthPAT.authenticate(token, async () => {
            // Retry callback - clear error and re-trigger login
            if (loginErrorGitlab) loginErrorGitlab.style.display = 'none';
            loginBtnGitlab.click();
          });

          if (authResult === null) {
            // Popup was shown, authentication failed but user can retry
            loginBtnGitlab.disabled = false;
            loginBtnGitlab.textContent = 'Connect to GitLab';
            return;
          }

          console.log(`Authenticated with GitLab:`, authResult.user.username);

          // Store token securely in local IndexedDB
          await authManager.storeToken(authResult.access_token, null, 'gitlab');

          // If signed in with Supabase and token mode is supabase, also save PAT to Supabase
          if (supabaseManager.isSignedIn) {
            const tokenMode = await supabaseManager.getTokenMode();
            const saveToSupabase = document.getElementById('saveToSupabaseCheck');
            const shouldSaveToSupabase = saveToSupabase ? saveToSupabase.checked : (tokenMode === 'supabase');
            if (shouldSaveToSupabase) {
              try {
                await supabaseManager.saveGitLabToken(authResult.access_token, null);
                await supabaseManager.setTokenMode('supabase');
              } catch (e) {
                console.warn('Failed to save PAT to Supabase:', e.message);
              }
            }
          }

          // Store provider preference
          await authManager.storePreference('syncProvider', 'gitlab');

          // Mark that user has chosen GitLab mode
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          safeLocalStorage.setItem('bmz_mode_chosen', 'true');
          safeLocalStorage.removeItem('bmz_local_mode');

          // Show success and load main app
          await this.showMainApp();

        } catch (error) {
          console.error('Login failed:', error);
          if (loginErrorGitlab) {
            loginErrorGitlab.textContent = error.message || 'Authentication failed. Please check your token and try again.';
            loginErrorGitlab.style.display = 'block';
          }

          // Reset button
          loginBtnGitlab.disabled = false;
          loginBtnGitlab.textContent = 'Login with GitLab';
        }
      };
    }
  }

  /**
   * Logout user and return to login screen
   * Clears all local data but does NOT delete remote snippets
   */
  /* [ZeroLabs] 2026-09-24 2:10 AM - added: a reload that always reloads */
  // Sign-out and reset used location.href = the same address minus its query.
  // Assigning an address that differs from the current one only in its #
  // fragment, or not at all apart from one, does not reload the page: it only
  // jumps within it, and the page carries on with its old state. This drops
  // the query AND the fragment, then reloads outright when that is already
  // the current address.
  reloadClean() {
    const cleanUrl = window.location.origin + window.location.pathname;
    if (window.location.href === cleanUrl) {
      window.location.reload();
    } else {
      window.location.replace(cleanUrl);
    }
  }

  async logout() {
    try {
      console.log('Logging out...');

      // IMPORTANT: Save current bookmarks to local storage BEFORE clearing auth
      // User was synced to GitLab, so bookmarks are in memory but not in local IndexedDB
      console.log('[Logout] Saving current bookmarks to local storage...');
      const currentTree = bookmarkManager.getTree();
      if (currentTree) {
        await dbManager.put('metadata', { key: 'bookmarkTree', value: currentTree });
        console.log('[Logout] Bookmarks saved to IndexedDB');
      } else {
        console.warn('[Logout] No bookmark tree found in memory');
      }

      // Clear authentication
      await authManager.clearToken('gitlab');
      await supabaseManager.clearSession();
      oauthPAT.clear();

      // Clear app authentication state
      this.isAuthenticated = false;
      this.currentUser = null;

      // Clear provider preference and set to local
      await authManager.storePreference('syncProvider', 'local');

      // Clear snippet ID from localStorage, IndexedDB, and adapter
      safeLocalStorage.removeItem('bmz_snippet_id');
      await dbManager.delete('metadata', 'snippetId');
      snippetAdapter.snippetId = null;

      // Clear sync manager state
      syncManager.snippetId = null;
      syncManager.provider = null;

      // Set local mode flags (IndexedDB is source of truth, localStorage is cache)
      await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
      await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
      safeLocalStorage.setItem('bmz_local_mode', 'true');
      safeLocalStorage.setItem('bmz_mode_chosen', 'true');

      console.log('[Logout] Set local mode flags');

      // Keep settings (like theme, API keys) but clear auth-related data
      // Settings are user preferences, not user data

      console.log('Logout complete, reloading page...');

      // Use setTimeout with longer delay to ensure all IndexedDB operations complete
      // IndexedDB commits are asynchronous even after await returns
      // Force reload to bypass cache and ensure clean state
      setTimeout(() => {
        this.reloadClean();
      }, 500);
    } catch (error) {
      console.error('Logout failed:', error);
      // Even if there's an error, try to reload after a delay
      setTimeout(() => {
        this.reloadClean();
      }, 500);
    }
  }

  /**
   * Reset all data and settings - complete wipe
   * Clears bookmarks, cache, settings, mode flags, and returns to login screen
   */
  async resetAllData() {
    try {
      // Show comprehensive confirmation dialog
      const confirmed = confirm(
        '⚠️ RESET ALL DATA & SETTINGS ⚠️\n\n' +
        'This will permanently delete:\n' +
        '• All bookmarks and folders\n' +
        '• All scan results and cache\n' +
        '• All settings (theme, zoom, filters, API keys)\n' +
        '• GitLab connection (if connected)\n' +
        '• All mode preferences\n\n' +
        'You will be returned to the login screen as a new user.\n\n' +
        '❗ THIS ACTION CANNOT BE UNDONE ❗\n\n' +
        'Are you absolutely sure you want to continue?'
      );

      if (!confirmed) {
        return;
      }

      // Second confirmation for extra safety
      const doubleConfirmed = confirm(
        'FINAL CONFIRMATION\n\n' +
        'This is your last chance to cancel.\n\n' +
        'Click OK to permanently delete everything, or Cancel to keep your data.'
      );

      if (!doubleConfirmed) {
        return;
      }

      console.log('[Reset] Starting complete data reset...');

      // Clear all authentication
      await authManager.clearToken('gitlab');
      await supabaseManager.clearSession();
      oauthPAT.clear();

      // Clear all mode flags from both IndexedDB and localStorage
      await dbManager.delete('settings', 'bmz_mode_chosen');
      await dbManager.delete('settings', 'bmz_local_mode');
      await dbManager.delete('settings', 'syncProvider');
      safeLocalStorage.removeItem('bmz_mode_chosen');
      safeLocalStorage.removeItem('bmz_local_mode');
      safeLocalStorage.removeItem('bmz_snippet_id');

      // Clear snippet ID from IndexedDB
      await dbManager.delete('metadata', 'snippetId');

      // Clear all bookmarks
      await dbManager.delete('metadata', 'bookmarkTree');

      // Clear all scan cache
      if (window.scannerService && window.scannerService.clearAllCache) {
        await window.scannerService.clearAllCache();
      }

      // Clear all settings from IndexedDB
      const allSettings = await dbManager.getAll('settings');
      for (const setting of allSettings) {
        await dbManager.delete('settings', setting.key);
      }

      // Clear localStorage (except essential browser data)
      const keysToKeep = ['bmz_install_date']; // Keep install date for analytics
      const allKeys = Object.keys(localStorage);
      for (const key of allKeys) {
        if (key.startsWith('bmz_') && !keysToKeep.includes(key)) {
          safeLocalStorage.removeItem(key);
        }
      }

      console.log('[Reset] All data cleared, reloading to login screen...');

      // Reload page to show login screen
      setTimeout(() => {
        this.reloadClean();
      }, 500);

    } catch (error) {
      console.error('[Reset] Failed to reset data:', error);
      alert('Failed to reset data. Please try clearing your browser data manually or contact support.');
    }
  }

  /**
   * Create new remote storage (snippet)
   */
  async createNewRemoteStorage(provider = 'gitlab') {
    try {
      // Check if we have local bookmarks that need to be merged
      const hasLocalBookmarks = await this.hasLocalBookmarks();
      console.log(`[Createsnippet] Has local bookmarks: ${hasLocalBookmarks}`);

      let itemId;
      if (hasLocalBookmarks) {
        // Show merge confirmation dialog
        const userChoice = await this.showMergeConfirmationDialog(null, 'new');
        if (userChoice === 'keep-local') {
          // User wants to keep local bookmarks, cancel setup
          console.log('[Createsnippet] User chose to keep local bookmarks, canceling setup');
          return; // Exit without creating snippet
        } else if (userChoice === 'merge' || userChoice === 'replace-remote') {
          /* [ZeroLabs] 2026-08-27 - edited: replace-remote left itemId undefined */
          // The snippet does not exist yet, so merging into it and overwriting it
          // are the same act: create it holding this device's bookmarks. Falling
          // through with no branch left itemId undefined and the setup then
          // stored "undefined" as the snippet id.
          itemId = await this.createSnippetWithLocalBookmarks();
        } else if (userChoice === 'replace') {
          // Create empty snippet (replace local)
          console.log(`[Createsnippet] Step 1: Creating empty snippet via adapter...`);
          itemId = await snippetAdapter.createBookmarkSnippet();
        }
      } else {
        // No local bookmarks, create empty snippet
        console.log(`[Createsnippet] Step 1: Creating snippet via adapter...`);
        itemId = await snippetAdapter.createBookmarkSnippet();
      }

      console.log(`[CreateSnippet] Step 1 Complete: Snippet created with ID:`, itemId);

      console.log(`[CreateSnippet] Step 2: Setting snippet ID in adapter...`);
      snippetAdapter.setSnippetId(itemId);

      // Save snippet ID to sync manager
      console.log(`[CreateSnippet] Step 4: Saving snippet ID to sync manager...`);
      await syncManager.setSnippetId(itemId);

      // Hide modal
      console.log(`[CreateSnippet] Step 3: Hiding modal...`);
      const modal = document.getElementById('snippetSetupModal');
      modal.style.display = 'none';
      modal.classList.add('hidden');

      // Set initial version to 1 (matching what we created)
      console.log(`[CreateSnippet] Step 4.5: Setting initial version...`);
      await syncManager.setLocalVersion(1);

      /* [ZeroLabs] 2026-08-27 - added: a new snippet already holds everything */
      // It was created from this device's tree, so there is nothing outstanding
      // for the attribution records to explain.
      await syncManager.clearLocalBookmarkEvents();
      await syncManager.clearHeldState();
      await syncManager.setSnippetNeedsReconcile(false);

      // Sync from remote to get the merged data (if we merged) or empty data
      console.log(`[CreateSnippet] Step 5: Syncing from remote...`);
      await syncManager.syncFromRemote();

      // Reload bookmarks from local storage (now contains the snippet data)
      console.log('[Createsnippet] Step 6: Reloading bookmarks from local...');
      const tree = await bookmarkManager.reload();
      console.log('[Createsnippet] Step 6 Complete: Tree loaded:', {
        hasRoots: !!tree?.roots,
        rootKeys: tree?.roots ? Object.keys(tree.roots) : [],
        bookmark_bar: tree?.roots?.bookmark_bar,
        menu: tree?.roots?.menu,
        other: tree?.roots?.other,
        mobile: tree?.roots?.mobile
      });

      // Initialize sidebar to render the UI
      console.log('[Createsnippet] Step 7: Initializing sidebar...');
      if (window.initSidebar) {
        await window.initSidebar();
        console.log('[Createsnippet] Step 7 Complete: Sidebar initialized');
      } else {
        console.warn('[Createsnippet] window.initSidebar not found!');
      }

      console.log(`[Createsnippet] All steps complete. snippet ID:`, itemId);
    } catch (error) {
      console.error('[Createsnippet] Failed:', error);
      this.showSnippetSetupError('Failed to create snippet: ' + error.message);
    }
  }

  /**
   * Check if we have a snippet set up
   * Checks for saved snippet ID
   */
  async checkSnippetSetup() {
    // Only GitLab snippets are supported
    const savedSnippetId = snippetAdapter.loadSavedSnippetId();
    if (savedSnippetId) {
      console.log('Found saved snippet ID:', savedSnippetId);
      // Verify we can read from it
      try {
        await snippetAdapter.readBookmarks(savedSnippetId);
        snippetAdapter.snippetId = savedSnippetId;
        syncManager.setProvider('gitlab');
        syncManager.snippetId = savedSnippetId;
        return true;
      } catch (error) {
        console.warn('Saved snippet ID is invalid, clearing:', error);
        safeLocalStorage.removeItem('bmz_snippet_id');
      }
    }

    // No valid saved ID found
    return false;
  }

  /**
   * Show snippet setup modal (GitLab only)
   */
  /* [ZeroLabs] 2026-09-07 4:33 PM - edited: four ways in, chosen rather than guessed */
  // The old dialog listed snippets and offered to make another. Snippets turned
  // out to be the wrong store: GitLab never repacks them, so every push keeps a
  // full copy of bookmarks.json, and the store eventually passes its allocation
  // and goes permanently read-only, answering every write with a bare 400.
  //
  // mode is 'setup' for a device with nothing connected, 'switch' for changing
  // repository, 'migrate' for one still on a snippet, and 'stopped' for one whose
  // snippet has begun refusing writes. Migration hides the fourth option: the
  // user is moving their own bookmarks, not joining someone else's repository.
  async showSnippetSetup(mode = 'setup') {
    const modal = document.getElementById('snippetSetupModal');
    const section = document.getElementById('storeSetupSection');
    const heading = modal ? modal.querySelector('h2') : null;
    const intro = document.getElementById('snippetSetupIntro');
    if (!modal || !section) return;

    const migrating = mode === 'migrate' || mode === 'stopped';

    /* [ZeroLabs] 2026-09-08 1:10 AM - added: the chooser's Back button needs this */
    // Every screen below can render the chooser again, so the mode has to outlive
    // this call rather than be handed down through each of them.
    this._storeSetupMode = mode;

    // The snippet sections stay in the markup for installs already on one, but
    // nothing routes to them any more.
    ['noSnippetsSection', 'existingSnippetSection', 'multipleSnippetsSection'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // A saved id that still works needs no dialog at all. Only on first setup:
    // the other three modes are deliberate requests to change something.
    if (mode === 'setup') {
      /* [ZeroLabs] 2026-09-07 4:33 PM - edited: load the BACKEND before using the id */
      // This read the id straight out of localStorage and handed it to
      // useRemoteStorage. If the adapter had not loaded bmz_store_kind yet, the
      // read went to the snippets endpoint with a project path and 404'd.
      snippetAdapter.loadSavedSnippetId();
      const savedId = snippetAdapter.getSnippetId();

      if (savedId) {
        try {
          await this.useRemoteStorage(savedId, 'gitlab');
          modal.style.display = 'none';
          modal.classList.add('hidden');
          return;
        } catch (err) {
          /* [ZeroLabs] 2026-09-07 4:33 PM - edited: a failed read is not a disconnect */
          // This used to delete the stored id, so one offline load, one expired
          // token or one GitLab hiccup silently disconnected the device and
          // dropped the user back into setup with no way to know why. The id is
          // kept and the dialog is shown, so they can reconnect or wait.
          console.warn('[StoreSetup] Could not open the saved store:', err);
        }
      }
    }

    if (heading) heading.textContent = this.storeSetupHeading(mode);
    if (intro) intro.innerHTML = this.storeSetupIntro(mode);

    section.style.display = 'block';
    if (migrating) {
      this.renderStoreMigrationStart(section, mode);
    } else {
      this.renderStoreChooser(section, migrating);
    }

    /* [ZeroLabs] 2026-09-07 4:33 PM - added: restore the logout button's handler */
    // The button is in the markup outside #storeSetupSection, so it survived the
    // rewrite while its handler did not. It was bound inside the old function
    // body and went with it, leaving a button that looked fine and did nothing.
    const logoutBtn = document.getElementById('snippetSetupLogoutBtn');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        modal.classList.add('hidden');
        modal.style.display = 'none';
        await this.logout();
      };
    }

    modal.style.display = 'flex';
    modal.classList.remove('hidden');
  }

  storeSetupHeading(mode) {
    if (mode === 'switch') return 'Change repository';
    if (mode === 'migrate') return 'Move your bookmarks to a repository';
    if (mode === 'stopped') return 'Syncing has stopped';
    return 'Set Up Bookmark Sync';
  }

  storeSetupIntro(mode) {
    /* [ZeroLabs] 2026-09-08 1:10 AM - edited: the options describe themselves */
    // This named an order that no longer exists, and it was explaining what each
    // button already says on its own face.
    if (mode === 'switch') {
      return `Point this device at a different GitLab repository.`;
    }
    if (mode === 'migrate') {
      return `Development of BMZ initially chose GitLab snippets for cloud sync and recent events have confirmed that was the wrong choice.
        <br><br>
        A snippet has a storage limit, and it counts every past version of your bookmarks rather than just the current one. A large collection reaches that limit eventually, and syncing then stops. BMZ would therefore like to migrate your bookmarks to a GitLab repository which does not share that same restriction.
        <br><br>
        Moving takes about a minute. Nothing is lost.`;
    }
    if (mode === 'stopped') {
      return `GitLab is refusing to save to this snippet. Its storage limit counts every past version of your bookmarks, and this one has reached that limit.
        <br><br>
        <strong>Your bookmarks are safe. Nothing has been lost.</strong>
        <br><br>
        This is our fault and we apologize for the inconvenience. BMZ picked the wrong kind of storage for this, however the solution is ready for you. Moving your cloud bookmarks from the snippet to a repository takes about a minute and does not have the same limit.`;
    }
    return 'Your bookmarks are stored in a private GitLab repository, which is what keeps them in step across your devices.';
  }

  storeSetupError(message) {
    const box = document.getElementById('snippetSetupError');
    if (!box) return;
    box.textContent = message;
    box.style.display = 'block';
  }

  clearStoreSetupError() {
    const box = document.getElementById('snippetSetupError');
    if (!box) return;
    box.textContent = '';
    box.style.display = 'none';
  }

  /* [ZeroLabs] 2026-09-24 12:20 AM - added: setup reports what it is doing (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
  // Connecting to a repository showed only "Connecting..." on a disabled button
  // for the whole of it, which reads as frozen. A panel under the dialog's
  // content now names each step. On the website every step is a wait on GitLab
  // or one write to IndexedDB, so it shows a moving stripe with the step name
  // rather than a count. reportStoreProgress does nothing when no panel is up.
  beginStoreProgress() {
    this.clearStoreSetupError();
    const errorBox = document.getElementById('snippetSetupError');
    if (!errorBox) return () => {};

    const panel = document.createElement('div');
    panel.style.cssText = 'margin-top: 16px;';
    panel.innerHTML = `
      <p class="setup-progress-phase" style="margin: 0 0 8px 0; font-size: 13px; color: var(--md-sys-color-on-surface);"></p>
      <div style="height: 8px; border-radius: 999px; background: var(--md-sys-color-surface-variant); overflow: hidden;">
        <div class="setup-progress-bar" style="width: 40%; height: 100%; border-radius: 999px; background: var(--md-sys-color-primary);"></div>
      </div>
    `;
    errorBox.insertAdjacentElement('beforebegin', panel);

    const phaseLine = panel.querySelector('.setup-progress-phase');
    const bar = panel.querySelector('.setup-progress-bar');

    // The Web Animations API needs no stylesheet entry for the stripe
    const stripe = bar.animate(
      [{ transform: 'translateX(-100%)' }, { transform: 'translateX(250%)' }],
      { duration: 1200, iterations: Infinity, easing: 'ease-in-out' }
    );

    const reporter = (phase) => {
      phaseLine.textContent = phase;
    };
    this._storeProgressReporter = reporter;
    reporter('Starting');

    return () => {
      stripe.cancel();
      if (this._storeProgressReporter === reporter) this._storeProgressReporter = null;
      panel.remove();
    };
  }

  reportStoreProgress(phase) {
    if (!this._storeProgressReporter) return;
    try {
      this._storeProgressReporter(phase);
    } catch (error) {
      // A progress display must never break the work it is describing
      console.warn('[StoreSetup] Progress display failed:', error);
    }
  }

  /* [ZeroLabs] 2026-09-24 12:20 AM - added: count the bookmarks in a stored tree */
  countTreeBookmarks(tree) {
    let count = 0;
    const walk = (node) => {
      if (!node) return;
      if (node.url) {
        count++;
        return;
      }
      (node.children || []).forEach(walk);
    };
    Object.values((tree && tree.roots) || {}).forEach(walk);
    return count;
  }

  // Step one of a migration. The snippet is read one last time so anything on it
  // that never reached this device comes along, because the new repository is
  // seeded from here. The export is offered, never required.
  renderStoreMigrationStart(section, mode) {
    this.clearStoreSetupError();
    this.setStoreChooserBack(false);
    section.innerHTML = `
      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <button id="storeMigrateStart" class="bmz-store-primary">Continue</button>
        <button id="storeExportFirst" class="bmz-store-plain">Save a backup file first</button>
      </div>
      <div class="bmz-store-hint">The backup is a bookmarks.html file you can open in any browser. It is optional.</div>
      <div style="margin-top: 16px;"><button id="storeNotNow" class="bmz-store-plain">Not now</button></div>
    `;

    document.getElementById('storeExportFirst')?.addEventListener('click', async () => {
      try {
        if (typeof this.exportBookmarks === 'function') {
          await this.exportBookmarks();
        } else if (window.exportBookmarks) {
          await window.exportBookmarks();
        }
      } catch (error) {
        console.error('[StoreSetup] Export failed:', error);
        this.storeSetupError('Could not save the backup file: ' + (error.message || ''));
      }
    });

    document.getElementById('storeNotNow')?.addEventListener('click', () => {
      const modal = document.getElementById('snippetSetupModal');
      modal.style.display = 'none';
      modal.classList.add('hidden');
    });

    document.getElementById('storeMigrateStart')?.addEventListener('click', async () => {
      const button = document.getElementById('storeMigrateStart');
      button.disabled = true;
      button.textContent = 'Reading your snippet...';
      /* [ZeroLabs] 2026-09-24 12:20 AM - added: show the pull as it happens */
      const endProgress = this.beginStoreProgress();
      this.reportStoreProgress('Reading your cloud bookmarks and merging them here');
      try {
        const pulled = await this.pullEverythingFromCurrentStore();
        endProgress();
        if (pulled.added > 0) console.log(`[StoreSetup] Brought ${pulled.added} item(s) off the old store`);
        /* [ZeroLabs] 2026-09-07 4:33 PM - added: say when the old store still wants a decision */
        // The new repository is seeded from this device, so a deferral here means
        // the old store holds something this device chose not to take. Migrating
        // anyway is allowed, it just leaves that behind, so it is said out loud
        // rather than discovered later by counting bookmarks.
        // After the render, not before: renderStoreChooser clears the error box.
        this.renderStoreChooser(section, true);
        if (pulled.deferred) {
          this.storeSetupError('Your snippet has changes still waiting for your approval. You can continue, but anything you have not approved will not come across.');
        }
      } catch (error) {
        endProgress();
        console.error('[StoreSetup] Could not read the old store:', error);
        this.storeSetupError('Could not read your snippet: ' + (error.message || '') + ' You can continue, but anything only on the snippet would be left behind.');
        button.disabled = false;
        button.textContent = 'Continue anyway';
        button.onclick = () => this.renderStoreChooser(section, true);
      }
    });
  }

  /* [ZeroLabs] 2026-09-08 12:05 AM - edited: migration shows the fourth option too */
  // It used to hide the join option, on the reasoning that someone migrating is
  // moving their own bookmarks rather than joining someone else's repository.
  // That reasoning only held for the FIRST device. Every device after it migrates
  // to a repository that already exists and already holds their bookmarks, and
  // joining is the only correct answer for them, so the one option they needed
  // was the one being hidden. The three that were left would each have done
  // damage: creating makes a second repository and splits the devices, and
  // pointing at the existing one as though it were empty writes this device's
  // tree over what the first device put there.
  //
  // The comment lives HERE, above the function, not beside the option it
  // explains. Everything below is inside a template literal, where a /* */ block
  // is not a comment at all: it is text, and it rendered on screen between the
  // third and fourth buttons.
  renderStoreChooser(section, migrating) {
    this.clearStoreSetupError();

    /* [ZeroLabs] 2026-09-08 1:10 AM - added: read the mode, do not pass it around */
    // Create, How-to and Point-at all come BACK to this screen, and threading a
    // fourth argument through every one of them is how one call site gets missed
    // and the Back button quietly disappears on the return trip.
    const mode = this._storeSetupMode || 'setup';
    const choice = (id, title, detail) => `
      <button id="${id}" class="bmz-store-choice">
        <div class="bmz-store-choice-title">${title}</div>
        <div class="bmz-store-choice-detail">${detail}</div>
      </button>
    `;

    /* [ZeroLabs] 2026-09-08 1:10 AM - edited: most likely answer first */
    // Joining leads the list because it is the right answer for every device
    // except the first one, and by the time anyone reaches this screen the first
    // device has usually already been set up. Creating moved down for the same
    // reason: on a second device it is the choice that splits your bookmarks
    // across two stores.
    section.innerHTML = `
      ${choice('storeOptJoin', 'Connect to a repository that already has my bookmarks',
        'Another device set this up. You then choose: merge both, keep the cloud\'s bookmarks, or keep this device\'s.')}
      ${choice('storeOptEmpty', 'Use an empty repository I already made',
        'You made one yourself and it has nothing in it yet. This device\'s bookmarks go into it.')}
      ${choice('storeOptCreate', 'Create a repository for me',
        'BMZ makes a new private repository on your GitLab account and puts this device\'s bookmarks in it.')}
      ${choice('storeOptHowTo', 'Show me how to make one myself',
        'Step by step, then point BMZ at it.')}
    `;

    /* [ZeroLabs] 2026-09-08 1:35 AM - edited: Back renders above Logout and Start Over */
    // Into the slot in the static markup rather than the end of the option list,
    // so the two ways out of this screen sit together. Only where there is
    // something behind it: migration came from the backup-first screen and
    // Change Repository came from the sync settings dialog. First-run setup has
    // nothing behind it and gets no button.
    this.setStoreChooserBack(migrating || mode === 'switch');

    document.getElementById('storeOptCreate')?.addEventListener('click', () => this.renderStoreCreate(section, migrating));
    document.getElementById('storeOptEmpty')?.addEventListener('click', () => this.renderStorePointAt(section, 'seed', migrating));
    document.getElementById('storeOptHowTo')?.addEventListener('click', () => this.renderStoreHowTo(section, migrating));
    document.getElementById('storeOptJoin')?.addEventListener('click', () => this.renderStorePointAt(section, 'join', migrating));

    document.getElementById('storeChooserBack')?.addEventListener('click', async () => {
      if (migrating) {
        this.renderStoreMigrationStart(section, mode);
        return;
      }
      const modal = document.getElementById('snippetSetupModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
      }
      await this.showGitLabSyncSettingsDialog();
    });
  }

  /* [ZeroLabs] 2026-09-08 2:00 AM - added: pick a repository instead of typing one */
  // Built for the extensions first and never ported here, so Change Repository on
  // the website offered a bare text field while the same screen in Chrome and
  // Firefox offered a list.
  //
  // The picker FILLS the paste field rather than replacing it. That keeps one
  // code path through parseProjectRef and wireStorePointAt, and leaves the field
  // as the way in for a repository the listing cannot show: past the 100 GitLab
  // returns, or on a token whose scope will not list projects at all.
  storeRepoPickerMarkup() {
    return `
      <label class="bmz-store-label" for="storeRepoPicker">Your repositories</label>
      <select id="storeRepoPicker" class="bmz-store-field">
        <option value="">Loading your repositories...</option>
      </select>
      <div class="bmz-store-hint">Or paste an address below.</div>
    `;
  }

  // Loads in the background. The screen is usable the moment it draws, because
  // the paste field never depended on this.
  wireStoreRepoPicker() {
    const picker = document.getElementById('storeRepoPicker');
    const field = document.getElementById('storeRepoRef');
    if (!picker || !field) return;

    picker.addEventListener('change', () => {
      if (picker.value) field.value = picker.value;
    });

    snippetAdapter.listProjects().then(projects => {
      if (!projects || projects.length === 0) {
        picker.innerHTML = '<option value="">No repositories found on your account</option>';
        picker.disabled = true;
        return;
      }

      /* [ZeroLabs] 2026-09-08 2:00 AM - added: build the options, do not interpolate them */
      // A repository path is server data. new Option sets text and value as
      // properties, so a name carrying markup can never become markup here, and
      // the App class has no escapeHtml of its own to reach for.
      picker.replaceChildren();
      picker.appendChild(new Option('Choose a repository...', ''));
      projects.forEach(project => {
        picker.appendChild(new Option(project.title, project.title));
      });
    }).catch(error => {
      // Not an error worth the red box. The paste field still works, so this only
      // has to stop promising a list that is not coming.
      console.warn('[StoreSetup] Could not list your repositories:', error);
      picker.innerHTML = '<option value="">Could not load your repositories</option>';
      picker.disabled = true;
    });
  }

  /* [ZeroLabs] 2026-09-08 1:35 AM - added: the Back slot lives outside the rendered section */
  // #storeSetupSection is rewritten wholesale by every screen, so a button placed
  // beside Logout and Start Over is not cleaned up by that rewrite. Every other
  // screen carries its own inline Back and must therefore empty this, or two
  // Back buttons end up on screen doing different things.
  setStoreChooserBack(show) {
    const slot = document.getElementById('storeChooserBackSlot');
    if (!slot) return;
    slot.innerHTML = show
      ? '<button id="storeChooserBack" class="bmz-store-plain" style="width: 100%; margin-bottom: 12px;">Back</button>'
      : '';
  }

  renderStoreCreate(section, migrating) {
    this.clearStoreSetupError();
    this.setStoreChooserBack(false);
    section.innerHTML = `
      <label class="bmz-store-label" for="storeNewRepoName">Repository name</label>
      <input id="storeNewRepoName" type="text" value="bmz-bookmarks" class="bmz-store-field">
      <div class="bmz-store-hint">It is created as private. Only you can see it.</div>
      <div style="display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap;">
        <button id="storeDoCreate" class="bmz-store-primary">Create and start syncing</button>
        <button id="storeBack" class="bmz-store-plain">Back</button>
      </div>
    `;

    document.getElementById('storeBack')?.addEventListener('click', () => this.renderStoreChooser(section, migrating));

    document.getElementById('storeDoCreate')?.addEventListener('click', async () => {
      const name = document.getElementById('storeNewRepoName').value.trim();
      if (!name) {
        this.storeSetupError('Give the repository a name.');
        return;
      }
      const button = document.getElementById('storeDoCreate');
      button.disabled = true;
      button.textContent = 'Creating...';
      /* [ZeroLabs] 2026-09-24 12:20 AM - added: show the create as it happens */
      const endProgress = this.beginStoreProgress();
      try {
        await this.storeCreateNew(name);
        endProgress();
      } catch (error) {
        endProgress();
        console.error('[StoreSetup] Could not create the repository:', error);
        this.storeSetupError('Could not create it: ' + (error.message || ''));
        button.disabled = false;
        button.textContent = 'Create and start syncing';
      }
    });
  }

  renderStoreHowTo(section, migrating) {
    this.clearStoreSetupError();
    this.setStoreChooserBack(false);
    this._storeMigrating = migrating;
    section.innerHTML = `
      <ol class="bmz-store-steps">
        <li><a href="https://gitlab.com/users/sign_in" target="_blank" rel="noopener noreferrer">Sign in to your GitLab account</a> first.</li>
        <li>Open <a href="https://gitlab.com/projects/new" target="_blank" rel="noopener noreferrer">gitlab.com/projects/new</a> and choose "Create blank project".</li>
        <li>Give it any name you like.</li>
        <li>Set Visibility to <strong>Private</strong>.</li>
        <li>Leave <strong>Initialize repository with a README</strong> ticked. BMZ needs a branch to write to.</li>
        <li>Create it, then pick it from the list below. It will be at the top.</li>
      </ol>
      ${this.storeRepoPickerMarkup()}
      <label class="bmz-store-label" for="storeRepoRef" style="margin-top: 12px;">Repository address</label>
      <input id="storeRepoRef" type="text" placeholder="https://gitlab.com/you/bmz-bookmarks" class="bmz-store-field">
      <div style="display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap;">
        <button id="storeDoPoint" class="bmz-store-primary">Start syncing</button>
        <button id="storeBack" class="bmz-store-plain">Back</button>
      </div>
    `;
    document.getElementById('storeBack')?.addEventListener('click', () => this.renderStoreChooser(section, migrating));
    this.wireStoreRepoPicker();
    this.wireStorePointAt('seed');
  }

  renderStorePointAt(section, kind, migrating) {
    this.clearStoreSetupError();
    this.setStoreChooserBack(false);
    /* [ZeroLabs] 2026-09-24 12:20 AM - added: the three-way screen needs to know where Back goes */
    this._storeMigrating = migrating;
    const joining = kind === 'join';
    section.innerHTML = `
      ${this.storeRepoPickerMarkup()}
      <label class="bmz-store-label" for="storeRepoRef" style="margin-top: 12px;">Repository address</label>
      <input id="storeRepoRef" type="text" placeholder="https://gitlab.com/you/bmz-bookmarks" class="bmz-store-field">
      <div class="bmz-store-hint">
        ${joining
          ? 'Its bookmarks are read first. You then choose to merge both, keep the cloud\'s, or keep this device\'s.'
          : 'This device\'s bookmarks are written into it. If it already holds bookmarks, you are asked what to do with them first.'}
      </div>
      <div style="display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap;">
        <button id="storeDoPoint" class="bmz-store-primary">${joining ? 'Continue' : 'Start syncing'}</button>
        <button id="storeBack" class="bmz-store-plain">Back</button>
      </div>
    `;
    document.getElementById('storeBack')?.addEventListener('click', () => this.renderStoreChooser(section, migrating));
    this.wireStoreRepoPicker();
    this.wireStorePointAt(kind);
  }

  wireStorePointAt(kind) {
    const button = document.getElementById('storeDoPoint');
    if (!button) return;
    const original = button.textContent;

    button.addEventListener('click', async () => {
      const ref = this.parseProjectRef(document.getElementById('storeRepoRef').value);
      if (!ref) {
        this.storeSetupError('Paste the repository address.');
        return;
      }
      button.disabled = true;
      button.textContent = 'Connecting...';
      let endProgress = () => {};
      try {
        /* [ZeroLabs] 2026-09-24 12:20 AM - added: a repository with bookmarks gets a real choice */
        // The join option always merged, and the empty-repository option's only
        // answer to "it already has bookmarks" was a confirm that REPLACED them.
        // So there was no way to say "keep the cloud". Any repository that
        // already holds BMZ bookmarks now opens one screen with all three.
        const probe = await this.storeProbe(ref);

        /* [ZeroLabs] 2026-09-24 3:00 AM - added: nothing to choose when both sides match */
        // Identical bookmarks on both sides make all three answers the same,
        // so connect straight away with the merge, which writes nothing new.
        let joinInstead = false;
        if (probe.hasBookmarks) {
          const localTree = await syncManager.loadLocalBookmarks();
          if (snippetsMatch(localTree, probe.remoteData)) {
            console.log('[StoreSetup] This device and the repository already match, connecting without asking');
            joinInstead = true;
          } else {
            button.disabled = false;
            button.textContent = original;
            this.renderStoreExistingChoice(ref, probe.remoteData);
            return;
          }
        }

        endProgress = this.beginStoreProgress();
        if (kind === 'join' || joinInstead) {
          await this.storeJoinExisting(ref);
        } else {
          await this.storeUseExisting(ref);
        }
        endProgress();
      } catch (error) {
        endProgress();
        /* [ZeroLabs] 2026-09-08 12:40 AM - added: declining is not an error */
        // The non-empty and already-has-bookmarks guards cancel by throwing, so
        // the rollback runs. A red error box on top of that would report the
        // user's own decision back at them as a failure.
        if (error && error.message === 'CANCELLED') {
          button.disabled = false;
          button.textContent = original;
          return;
        }
        console.error('[StoreSetup] Could not connect to the repository:', error);
        this.storeSetupError(error.message || 'Could not connect to that repository.');
        button.disabled = false;
        button.textContent = original;
      }
    });
  }

  /* [ZeroLabs] 2026-09-07 4:33 PM - added: read a project id out of whatever was pasted */
  // Four shapes reach this in practice: the address bar, the HTTPS clone URL, the
  // SSH clone URL, and someone typing "user/repo" by hand. Slashes come off
  // before ".git" and again after, because "user/repo.git/" is a real paste and
  // stripping ".git" first would leave it attached.
  parseProjectRef(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) return '';
    if (/^\d+$/.test(trimmed)) return trimmed;

    let ref = trimmed;
    ref = ref.replace(/^git@[^:]+:/i, '');
    ref = ref.replace(/^ssh:\/\/[^/]+\//i, '');
    ref = ref.replace(/^https?:\/\/[^/]+\//i, '');
    ref = ref.replace(/^\/+/, '').replace(/\/+$/, '');
    ref = ref.replace(/\.git$/i, '');
    ref = ref.replace(/\/+$/, '');

    const dashIndex = ref.indexOf('/-/');
    if (dashIndex > 0) ref = ref.slice(0, dashIndex);
    return ref;
  }

  /* [ZeroLabs] 2026-09-07 4:33 PM - added: take everything off the old store before leaving it */
  // Migration seeds the new repository from THIS device, so anything the old
  // store holds that never reached here would be left behind. push is false on
  // purpose: the store being left has usually stopped accepting writes, and an
  // attempt to push would fail and take the migration with it.
  async pullEverythingFromCurrentStore() {
    if (!snippetAdapter.getSnippetId()) return { added: 0, deferred: false };
    const outcome = await syncManager.reconcileWithSnippet({ push: false });
    const added = (outcome && outcome.addedLocally) || 0;
    if (added > 0) {
      await bookmarkManager.reload();
      if (window.reloadBookmarkUI) await window.reloadBookmarkUI();
    }
    return { added, deferred: !!(outcome && outcome.deferred) };
  }

  /* [ZeroLabs] 2026-09-07 4:33 PM - added: write this device's bookmarks into a repository */
  // updateBookmarks always sends action "update", which is right in the steady
  // state and wrong for a repository that has never held the file. Seeding is the
  // only moment that distinction exists, so it is handled here rather than by
  // making every later push ask GitLab what it already has.
  async storeSeedFromLocal(existingPaths) {
    const localTree = await syncManager.loadLocalBookmarks();
    const payload = {
      ...localTree,
      version: 1,
      checksum: await snippetAdapter.calculateChecksum(localTree),
      lastModified: Date.now()
    };

    const files = [{
      action: existingPaths.includes('bookmarks.json') ? 'update' : 'create',
      file_path: 'bookmarks.json',
      content: JSON.stringify(payload, null, 2)
    }];

    const meta = (typeof window !== 'undefined' && window.bmzQuickAccessMeta)
      ? window.bmzQuickAccessMeta.buildPayloadFor(snippetAdapter.getSnippetId())
      : null;
    if (meta) {
      files.push({
        action: existingPaths.includes('bmz-meta.json') ? 'update' : 'create',
        file_path: 'bmz-meta.json',
        content: meta.content
      });
    }

    const response = await snippetAdapter.projectWriteFiles(files, 'Add bookmarks');
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Could not write to that repository: ${response.status} - ${body}`);
    }
  }

  // Shared tail. The held decisions and the created/deleted records described
  // differences against the OLD store, so carrying them across would ask the user
  // to approve removing bookmarks that were compared against something they no
  // longer sync with.
  /* [ZeroLabs] 2026-09-07 4:33 PM - edited: clearing the records is not always right */
  // After seeding, both sides hold the same tree, so the created and deleted
  // records describe nothing and clearing them is correct.
  //
  // After a JOIN it is the opposite. The records are what say "this device added
  // these", and the reconcile needs them to tell an addition from something
  // another device deleted. Clearing them here wiped the claim made moments
  // earlier and brought back the very prompt it was written to prevent.
  //
  // Same for the reconcile flag: a join that deferred has a decision outstanding,
  // and saying otherwise would hide the card that asks for it.
  async storeFinishSetup(localVersion, { clearRecords = true } = {}) {
    await syncManager.setSnippetId(snippetAdapter.getSnippetId());
    await syncManager.setLocalVersion(localVersion);
    if (clearRecords) {
      await syncManager.clearLocalBookmarkEvents();
      await syncManager.setSnippetNeedsReconcile(false);
    }

    const modal = document.getElementById('snippetSetupModal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.add('hidden');
    }

    await syncManager.init();
    if (window.initSidebar) await window.initSidebar();
    this.showToast('Cloud sync connected.');
  }

  /* [ZeroLabs] 2026-09-07 4:33 PM - added: record this device's bookmarks as its own */
  // Writes every local URL into the created-here list, which is what stops the
  // first reconcile after a connect from offering to delete bookmarks this
  // device holds and the cloud does not.
  async claimLocalBookmarksAsOurs() {
    try {
      const localTree = await syncManager.loadLocalBookmarks();
      const entries = syncManager.collectSnippetEntries(localTree);

      const urls = [];
      entries.forEach(entry => {
        if (entry && entry.url) urls.push(entry.url);
      });

      if (urls.length === 0) return 0;

      await storageAdapter.set({
        snippet_local_created: urls,
        snippet_local_deleted: [],
        snippet_local_edited: []
      });

      console.log(`[StoreSetup] Claimed ${urls.length} local bookmark(s) as this device's own`);
      return urls.length;
    } catch (error) {
      // Not fatal. Without it the reconcile is merely more cautious than it needs
      // to be, which is exactly the behaviour that existed before this.
      console.error('[StoreSetup] Could not record local bookmarks as ours:', error);
      return 0;
    }
  }

  /* [ZeroLabs] 2026-09-24 12:20 AM - added: look inside a repository without adopting it */
  // Points the adapter at the repository only for the duration of the look, and
  // ALWAYS puts the previous store back, success or failure. storeWithRollback
  // restores only on failure, which is right for a connect and wrong for a look.
  //
  // A bookmarks.json that is not BMZ data is refused here, with the same
  // messages the join uses, so every option on the three-way screen starts from
  // bookmarks known to be BMZ's own.
  async storeProbe(ref) {
    const previous = this.captureStore();

    snippetAdapter.setProjectStore(ref, 'main');
    try {
      const existing = await snippetAdapter.projectListFiles();
      if (!existing.includes('bookmarks.json')) return { hasBookmarks: false };

      const content = await snippetAdapter.projectReadFile('bookmarks.json');
      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new Error('That repository has a bookmarks.json, but it is not readable as BMZ data. Pick a different repository.');
      }
      if (!parsed || !parsed.roots || typeof parsed.roots !== 'object') {
        throw new Error('That repository has a bookmarks.json, but it was not written by BMZ. Pick a different repository.');
      }
      return { hasBookmarks: true, remoteData: parsed };
    } finally {
      this.restoreStore(previous);
    }
  }

  /* [ZeroLabs] 2026-09-24 12:40 AM - added: put the previous store back, storage included */
  // setProjectStore writes the repository into localStorage as well as memory.
  // Restoring only the memory left a first-time device, which had no previous
  // store, with the repository still saved. After a reload it would believe it
  // was connected to a repository it had only looked at, or had failed to
  // connect to. With no previous store, the saved keys are removed.
  captureStore() {
    return {
      id: snippetAdapter.getSnippetId(),
      kind: snippetAdapter.storeKind,
      branch: snippetAdapter.branch
    };
  }

  restoreStore(previous) {
    snippetAdapter.snippetId = previous.id;
    snippetAdapter.storeKind = previous.kind;
    snippetAdapter.branch = previous.branch;

    if (previous.kind === 'project') {
      snippetAdapter.setProjectStore(previous.id, previous.branch || 'main');
    } else if (previous.id) {
      snippetAdapter.setSnippetId(previous.id);
    } else {
      safeLocalStorage.removeItem('bmz_snippet_id');
      safeLocalStorage.removeItem('bmz_store_kind');
      safeLocalStorage.removeItem('bmz_store_branch');
    }
  }

  /* [ZeroLabs] 2026-09-24 12:20 AM - added: the three answers for a repository that has bookmarks */
  // Merge first, because it is the only one that loses nothing, and the two
  // replaces spell out their numbers so the cost is visible before choosing.
  // Each replace still asks once more before it acts.
  async renderStoreExistingChoice(ref, remoteData) {
    const section = document.getElementById('storeSetupSection');
    if (!section) return;
    this.clearStoreSetupError();
    this.setStoreChooserBack(false);

    const cloudCount = this.countTreeBookmarks(remoteData);
    const localTree = await syncManager.loadLocalBookmarks();
    const localCount = this.countTreeBookmarks(localTree);
    const plural = (count) => `${count} bookmark${count === 1 ? '' : 's'}`;

    const choice = (id, title, detail) => `
      <button id="${id}" class="bmz-store-choice">
        <div class="bmz-store-choice-title">${title}</div>
        <div class="bmz-store-choice-detail">${detail}</div>
      </button>
    `;

    section.innerHTML = `
      <p style="margin: 0 0 14px 0; font-size: 14px; line-height: 1.5; color: var(--md-sys-color-on-surface);">
        That repository already holds ${plural(cloudCount)}. This device has ${plural(localCount)}.
      </p>
      ${choice('storeOptMergeBoth', 'Merge both (recommended)',
        'Keeps everything. Anything only in the cloud comes to this device, anything only here goes to the cloud, and nothing is removed from either.')}
      ${choice('storeOptCloudWins', 'Replace this device\'s bookmarks with the cloud',
        `This device ends up with exactly the cloud's ${plural(cloudCount)}. Its own ${plural(localCount)} are removed. A snapshot is saved in the Event Log first, so this can be undone.`)}
      ${choice('storeOptDeviceWins', 'Replace the cloud with this device\'s bookmarks',
        `The repository ends up with exactly this device's ${plural(localCount)}. Anything only in the cloud is removed, on every device that uses it.`)}
      <div style="margin-top: 8px;"><button id="storeBack" class="bmz-store-plain">Back</button></div>
    `;

    document.getElementById('storeBack')?.addEventListener('click', () => {
      this.renderStoreChooser(section, this._storeMigrating);
    });

    // One runner for all three, so each gets the progress panel, the same error
    // handling, and the same finish. The methods below finish the setup
    // themselves, which closes the dialog.
    const run = async (work) => {
      const buttons = section.querySelectorAll('button');
      buttons.forEach(button => { button.disabled = true; });
      const endProgress = this.beginStoreProgress();
      try {
        const finished = await work();
        endProgress();
        if (finished === false) {
          // The user said no to a confirmation. Nothing changed; stay here.
          buttons.forEach(button => { button.disabled = false; });
        }
      } catch (error) {
        endProgress();
        console.error('[StoreSetup] Could not connect to the repository:', error);
        this.storeSetupError(error.message || 'Could not connect to that repository.');
        buttons.forEach(button => { button.disabled = false; });
      }
    };

    document.getElementById('storeOptMergeBoth')?.addEventListener('click', () => {
      run(() => this.storeJoinExisting(ref));
    });

    document.getElementById('storeOptCloudWins')?.addEventListener('click', () => {
      run(() => this.storeReplaceLocalFromCloud(ref, remoteData, localCount, cloudCount));
    });

    document.getElementById('storeOptDeviceWins')?.addEventListener('click', () => {
      run(async () => {
        const proceed = confirm(
          `Replace the repository's ${plural(cloudCount)} with this device's ${plural(localCount)}?\n\n` +
          'Anything only in the cloud is removed, on every device that uses this repository.'
        );
        if (!proceed) return false;
        await this.storeUseExisting(ref, { replaceConfirmed: true });
        return true;
      });
    });
  }

  /* [ZeroLabs] 2026-09-24 12:20 AM - added: connect, keeping the cloud's bookmarks */
  // Asks first, then saves this device's whole tree as a pre-sync snapshot in the
  // Event Log, which the Event Log already knows how to restore. Only then is the
  // repository adopted and its tree written over this device's. The website's
  // tree is one IndexedDB record, so the replace is a single write and nothing
  // can observe it half done.
  //
  // Saved with saveLocalBookmarks, not through bookmarkManager, so taking the
  // cloud's tree does not mark this device changed and push it straight back.
  // Both sides then match, so the attribution records are cleared.
  //
  // @returns {Promise<boolean>} false when the user cancelled
  async storeReplaceLocalFromCloud(ref, remoteData, localCount, cloudCount) {
    const proceed = confirm(
      `Replace this device's ${localCount} bookmark${localCount === 1 ? '' : 's'} with the cloud's ${cloudCount}?\n\n` +
      'A snapshot of this device\'s bookmarks is saved in the Event Log first, and its "Restore Pre-Sync Bookmarks" button puts them back.'
    );
    if (!proceed) return false;

    this.reportStoreProgress('Saving a snapshot of this device\'s bookmarks');
    const snapshot = await syncManager.loadLocalBookmarks();
    // Same as the extensions: the older entries point at bookmark ids that are
    // about to stop existing, so their restore buttons would fail.
    await clearChangelog();
    await addChangelogEntry('pre-sync-snapshot', 'sync', 'Replace Local with Cloud', null, {
      snapshot,
      timestamp: Date.now(),
      operation: 'Replace Local with Cloud'
    });

    await this.storeWithRollback(ref, async () => {
      this.reportStoreProgress('Replacing this device\'s bookmarks with the cloud\'s');
      await syncManager.saveLocalBookmarks(remoteData);
    });

    await bookmarkManager.reload();
    if (window.reloadBookmarkUI) await window.reloadBookmarkUI();

    this.reportStoreProgress('Connecting this device to the repository');
    await this.storeFinishSetup(Number(remoteData.version) || 0, { clearRecords: true });
    return true;
  }

  async storeCreateNew(name) {
    this.reportStoreProgress('Creating the repository');
    const created = await snippetAdapter.createProject(name);
    snippetAdapter.setProjectStore(created.id, 'main');
    this.reportStoreProgress('Uploading this device\'s bookmarks to the repository');
    await this.storeSeedFromLocal([]);
    await this.storeFinishSetup(1);
  }

  // Restores the previous store on failure, so a bad address leaves this device
  // pointed where it was rather than at nothing.
  async storeWithRollback(ref, work) {
    /* [ZeroLabs] 2026-09-24 12:40 AM - edited: the rollback clears storage too (see restoreStore) */
    const previous = this.captureStore();

    snippetAdapter.setProjectStore(ref, 'main');
    try {
      return await work();
    } catch (error) {
      this.restoreStore(previous);
      throw error;
    }
  }

  /* [ZeroLabs] 2026-09-24 12:20 AM - edited: the three-way screen has already asked */
  // `replaceConfirmed` comes from "Replace the cloud with this device's
  // bookmarks", which has just shown both counts and had its own answer. The
  // old warning below is kept as a safety net for any other way in.
  async storeUseExisting(ref, { replaceConfirmed = false } = {}) {
    await this.storeWithRollback(ref, async () => {
      this.reportStoreProgress('Reading the repository');
      const entries = await snippetAdapter.projectListEntries();
      const existing = entries.filter(entry => entry.type === 'blob').map(entry => entry.path);

      /* [ZeroLabs] 2026-09-08 12:40 AM - added: two different wrong repositories */
      // This path writes THIS device's bookmarks into whatever you point it at,
      // and it never checked what was already there. Already holds bookmarks is
      // the destructive case. Holds somebody's actual project is not destructive,
      // but BMZ would commit into it on every sync from then on, which nobody
      // asked for. Both are a confirmation rather than a refusal: a person may
      // genuinely want bookmarks living beside other files.
      //
      // Cancelling has to THROW. storeWithRollback only restores the previous
      // store when the callback fails; returning early would leave this device
      // adopted onto a repository the user just declined.
      const alreadyHasBookmarks = existing.includes('bookmarks.json');
      const otherContent = snippetAdapter.contentEntries(entries);

      if (alreadyHasBookmarks && !replaceConfirmed) {
        const proceed = confirm(
          'That repository already contains bookmarks.\n\n' +
          'Continuing REPLACES them with this device\'s bookmarks, on every device using it.\n\n' +
          'If you meant to join it and keep both sides, press Cancel and choose ' +
          '"Connect to a repository that already has my bookmarks" instead.\n\nReplace them?'
        );
        if (!proceed) throw new Error('CANCELLED');
      } else if (!alreadyHasBookmarks && otherContent.length > 0) {
        const sample = otherContent.slice(0, 3).map(entry => entry.path).join(', ');
        const more = otherContent.length > 3 ? `, and ${otherContent.length - 3} more` : '';
        const proceed = confirm(
          'That repository is not empty. It already contains:\n\n' +
          `  ${sample}${more}\n\n` +
          'Nothing there will be deleted, but BMZ would add bookmarks.json to it ' +
          'and commit to it on every sync from now on.\n\n' +
          'Use it for your bookmarks anyway?'
        );
        if (!proceed) throw new Error('CANCELLED');
      }

      this.reportStoreProgress('Uploading this device\'s bookmarks to the repository');
      await this.storeSeedFromLocal(existing);
    });
    await this.storeFinishSetup(1);
  }

  // Read, merge, then push what is only here. Never seeds over what is already
  // in the repository: those bookmarks belong to a device that set this up first.
  async storeJoinExisting(ref) {
    let existing = [];
    await this.storeWithRollback(ref, async () => {
      this.reportStoreProgress('Reading the repository');
      existing = await snippetAdapter.projectListFiles();
      if (!existing.includes('bookmarks.json')) {
        throw new Error('That repository has no bookmarks.json in it yet. Use the empty repository option instead.');
      }

      // A repository can hold an unrelated file of the same name. Adopting one
      // would parse, find no roots, read as an empty cloud side, and ask the user
      // to approve removing every bookmark they own.
      const probe = await snippetAdapter.projectReadFile('bookmarks.json');
      let parsed = null;
      try {
        parsed = JSON.parse(probe);
      } catch (error) {
        throw new Error('That repository has a bookmarks.json, but it is not readable as BMZ data. Pick a different repository.');
      }
      if (!parsed || !parsed.roots || typeof parsed.roots !== 'object') {
        throw new Error('That repository has a bookmarks.json, but it was not written by BMZ. Pick a different repository, or use the empty repository option to start fresh.');
      }
    });

    /* [ZeroLabs] 2026-09-07 4:33 PM - added: on a first connect, everything here is yours */
    // BMZ decides "here but not in the cloud" by asking whether this device
    // watched you add it. An HTML import writes no such record, and neither does
    // anything that happened before a store was ever connected, so those
    // bookmarks arrive unattributed. The reconcile then reads them as something
    // another device deleted and asks permission to remove your own bookmarks.
    //
    // On a FIRST connect there is no shared history and no deletion can have
    // happened, so claiming the local tree is the honest reading. Later syncs
    // keep their real records and the question still gets asked properly.
    await this.claimLocalBookmarksAsOurs();

    await syncManager.setSnippetId(snippetAdapter.getSnippetId());
    await syncManager.setLocalVersion(0);

    this.reportStoreProgress('Merging the cloud\'s bookmarks with this device');
    const outcome = await this.pullEverythingFromCurrentStore();
    if (outcome.added > 0) console.log(`[StoreSetup] Brought ${outcome.added} item(s) down from the repository`);

    /* [ZeroLabs] 2026-09-07 4:33 PM - added: a deferral stops the write back */
    // Writing the local tree back is only safe once local holds BOTH sides. A
    // deferral means the reconcile found something it would have to remove or
    // overwrite and stopped rather than doing it, so local is deliberately not
    // caught up. Pushing then would destroy exactly what the deferral protected,
    // which is the same failure the August comment in bringSidesTogether names.
    //
    // Connected either way. The deferral card is already up, and resolving it
    // syncs normally from that point.
    if (outcome.deferred) {
      console.warn('[StoreSetup] Joined, but the merge needs your approval before anything is written back');
      await this.storeFinishSetup(0, { clearRecords: false });
      return;
    }

    // Local now holds both sides, so writing it back adds this device's extras
    // without removing anything that was already there.
    this.reportStoreProgress('Uploading the merged bookmarks to the repository');
    await this.storeSeedFromLocal(existing);
    await this.storeFinishSetup(0, { clearRecords: false });
  }

  /**
   * Use existing remote storage (snippet)
   */
  async useRemoteStorage(itemId, provider = 'gitlab') {
    try {
      // Check if we have local bookmarks that need to be merged
      const hasLocalBookmarks = await this.hasLocalBookmarks();
      console.log(`[UseRemoteStorage] Has local bookmarks: ${hasLocalBookmarks}`);

      if (hasLocalBookmarks) {
        /* [ZeroLabs] 2026-08-18 12:32 AM - edited: fall back to the diff when checksums differ (see also: Bookmark-Manager-Zero-Firefox/sidebar.js) */
        // Compare checksums — skip the dialog if local and remote are already identical
        let alreadyInSync = false;
        try {
          const remoteData = await snippetAdapter.readBookmarks(itemId);
          const localTree = bookmarkManager.getTree();
          if (localTree) {
            const localChecksum = await snippetAdapter.calculateChecksum(localTree);
            const remoteChecksum = remoteData.checksum || await snippetAdapter.calculateChecksum(remoteData);
            alreadyInSync = localChecksum === remoteChecksum;

            if (!alreadyInSync) {
              // The checksum is byte-exact over the whole tree, titles included,
              // and Firefox writes its toolbar root as "Bookmarks Toolbar" while
              // Chrome writes "Bookmarks bar". It therefore can never match on a
              // snippet last written by a different browser. The diff is the
              // authoritative comparison: it normalizes those root naming
              // differences and the browser's internal-URL rewrites, so an empty
              // diff means genuinely in sync even when the hashes disagree.
              const diff = syncManager.calculateBookmarkDiff(localTree, remoteData);
              alreadyInSync = (diff.added.length + diff.removed.length +
                               diff.moved.length + diff.modified.length) === 0;
            }
          }
        } catch (e) {
          // Comparison failed — fall through to show dialog as normal
        }

        if (alreadyInSync) {
          snippetAdapter.setSnippetId(itemId);
          await syncManager.setSnippetId(itemId);
          const modal = document.getElementById('snippetSetupModal');
          if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
          await syncManager.init();
          if (window.initSidebar) await window.initSidebar();
          this.showToast('Cloud sync connected. Bookmarks are already in sync.');
          return;
        }

        // Show merge confirmation dialog
        const userChoice = await this.showMergeConfirmationDialog(itemId, 'existing');
        if (userChoice === 'keep-local') {
          // User wants to keep local bookmarks, cancel setup
          console.log('[UseRemoteStorage] User chose to keep local bookmarks, canceling setup');
          return; // Exit without using snippet
        } else if (userChoice === 'merge') {
          // Merge local bookmarks into the snippet
          await this.mergeLocalBookmarksIntoSnippet(itemId);
        } else if (userChoice === 'replace-remote') {
          // Replace remote snippet with local bookmarks
          console.log('[UseRemoteStorage] User chose to replace remote snippet with local bookmarks');
          try {
            await this.replaceRemoteWithLocal(itemId);
            this.showToast('Cloud bookmarks replaced with local.');
          } catch (error) {
            console.error('[UseRemoteStorage] Failed to replace remote snippet:', error);
            this.showToast(`Error: ${error.message}`, 'error');
            return;
          }
        } else if (userChoice === 'replace') {
          // Use snippet as-is (replace local) - continue with normal flow
          console.log('[UseRemoteStorage] User chose to replace local with snippet');

          // Show backup dialog before replacing
          const shouldBackup = await this.showBackupBeforeReplaceDialog();

          if (shouldBackup === 'cancel') {
            // User cancelled, exit without using snippet
            console.log('[UseRemoteStorage] User cancelled replace operation');
            return;
          }

          if (shouldBackup === 'backup') {
            // User wants to backup first
            console.log('[UseRemoteStorage] Exporting backup before replace...');
            await window.exportBookmarks();
          }

          // Clear all local bookmarks to avoid diff conflicts
          console.log('[UseRemoteStorage] Clearing local bookmarks for clean replace...');
          await bookmarkManager.clear();
        }
      }

      // Verify the snippet exists before saving the ID
      console.log(`[UseRemoteStorage] Verifying snippet ${itemId} exists...`);
      try {
        await snippetAdapter.readBookmarks(itemId);
        console.log(`[UseRemoteStorage] Snippet verified successfully`);
      } catch (error) {
        console.error(`[UseRemoteStorage] Failed to verify snippet:`, error);
        throw new Error(`Cannot use this snippet: ${error.message}`);
      }

      snippetAdapter.setSnippetId(itemId);
      await syncManager.setSnippetId(itemId);

      // Hide modal
      const modal = document.getElementById('snippetSetupModal');
      modal.style.display = 'none';
      modal.classList.add('hidden');

      // Continue with app initialization
      await syncManager.init();

      // Clear local version to force sync from remote
      console.log(`[Usesnippet] Clearing local version to force sync...`);
      await syncManager.setLocalVersion(0);

      /* [ZeroLabs] 2026-08-27 - added: connecting is a fresh start for attribution */
      // Every branch above leaves the two sides agreeing: merged, replaced one
      // way, replaced the other, or nothing local to begin with. Any record of
      // what this device did before that point describes a different snippet, and
      // reading it against this one would invent removals.
      await syncManager.clearLocalBookmarkEvents();
      await syncManager.clearHeldState();
      await syncManager.setSnippetNeedsReconcile(false);

      // Sync data from remote to local
      console.log(`[Usesnippet] Syncing from remote...`);
      await syncManager.syncFromRemote();

      // Reload bookmarks from local storage
      console.log(`[Usesnippet] Reloading bookmarks from local...`);
      const tree = await bookmarkManager.reload();
      console.log(`[Usesnippet] Bookmarks loaded:`, {
        hasRoots: !!tree?.roots,
        rootKeys: tree?.roots ? Object.keys(tree.roots) : []
      });

      // Initialize sidebar to render the UI
      if (window.initSidebar) {
        await window.initSidebar();
      }

      console.log(`Using snippet:`, itemId);
    } catch (error) {
      console.error(`Failed to use snippet:`, error);
      this.showSnippetSetupError(`Failed to use snippet: ` + error.message);
    }
  }

  /**
   * Create new remote storage (snippet)
   */
  /* [ZeroLabs] 2026-08-27 - removed: the second createNewRemoteStorage (duplicate) */
  // The class defined this method twice. The later definition silently replaced
  // the earlier one, and it was the worse of the two: it treated the merge
  // dialog's return as a boolean, so every option including "Keep Local
  // Bookmarks" created a snippet from the local tree. Nobody noticed because
  // hasLocalBookmarks read an empty object store and the dialog never opened.
  // The surviving definition, above, handles each choice by name.

  /**
   * Check if user has local bookmarks
   */
  /* [ZeroLabs] 2026-08-27 - edited: read the tree, not an empty object store */
  // This read dbManager.getAll('bookmarks'). That store is created in the schema
  // and NOTHING has ever written to it - the tree lives under metadata as
  // 'bookmarkTree' - so this returned false for everyone, always. The merge
  // confirmation dialog it guards was therefore unreachable, and connecting a
  // snippet took the "no local bookmarks" path and pulled straight over whatever
  // was here.
  async hasLocalBookmarks() {
    try {
      const localTree = await syncManager.loadLocalBookmarks();
      return syncManager.countBookmarksInTree(localTree) > 0;
    } catch (error) {
      console.error('[hasLocalBookmarks] Error:', error);
      return false;
    }
  }

  /**
   * Show backup dialog before replacing bookmarks
   */
  async showBackupBeforeReplaceDialog() {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10003;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: var(--md-sys-color-surface, #1e1e1e);
        color: var(--md-sys-color-on-surface, #e0e0e0);
        border-radius: 12px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      `;

      dialog.innerHTML = `
        <h2>💾 Backup Your Bookmarks?</h2>
        <p>You're about to replace your local bookmarks with the cloud data. Would you like to download a backup of your current bookmarks first?</p>
        <p>This creates a safety backup that you can restore later if needed.</p>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <button id="backupAndReplace" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-primary, #4285f4); color: var(--md-sys-color-on-primary, #fff); cursor: pointer; font-size: 14px;">💾 Download Backup & Replace</button>
          <button id="skipBackup" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; font-size: 14px;">Skip Backup & Replace</button>
          <button id="cancelReplace" style="padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface-variant, #aaa); cursor: pointer; font-size: 14px;">Cancel</button>
        </div>
      `;

      modal.appendChild(dialog);
      document.body.appendChild(modal);

      dialog.querySelector('#backupAndReplace').addEventListener('click', () => {
        modal.remove();
        resolve('backup');
      });

      dialog.querySelector('#skipBackup').addEventListener('click', () => {
        modal.remove();
        resolve('skip');
      });

      dialog.querySelector('#cancelReplace').addEventListener('click', () => {
        modal.remove();
        resolve('cancel');
      });
    });
  }

  /**
   * Show merge confirmation dialog
   */
  async showMergeConfirmationDialog(snippetId, type) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10002;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: var(--md-sys-color-surface);
        color: var(--md-sys-color-on-surface);
        border-radius: 12px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      `;

      const actionText = type === 'new' ? 'create a new snippet' : 'use this existing snippet';
      const snippetText = type === 'new' ? 'new snippet' : 'selected snippet';

      dialog.innerHTML = `
        <h2 style="margin: 0 0 16px 0; color: var(--md-sys-color-primary);">
          📋 Local Bookmarks Detected
        </h2>
        <p style="margin-bottom: 16px;">
          You have bookmarks stored locally. How would you like to handle them?
        </p>
        <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px;">
          <button id="keepLocal" style="
            background: var(--md-sys-color-surface-variant);
            color: var(--md-sys-color-on-surface-variant);
            border: none;
            padding: 12px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1em;
            text-align: left;
            border-left: 4px solid var(--md-sys-color-secondary);
          ">
            <div style="font-weight: 500;">Keep Local Bookmarks</div>
            <div style="font-size: 0.9em; opacity: 0.8; margin-top: 4px;">
              Cancel setup and keep your local bookmarks unchanged
            </div>
          </button>

          <button id="doMerge" style="
            background: var(--md-sys-color-primary);
            color: var(--md-sys-color-on-primary);
            border: none;
            padding: 12px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1em;
            text-align: left;
            border-left: 4px solid var(--md-sys-color-primary);
            font-weight: 500;
          ">
            <div style="font-weight: 500;">Merge Bookmarks</div>
            <div style="font-size: 0.9em; opacity: 0.9; margin-top: 4px;">
              Add your local bookmarks to the ${snippetText} and sync the combined result
            </div>
          </button>

          <button id="replaceRemote" style="
            background: var(--md-sys-color-secondary-container, #2a3a2a);
            color: var(--md-sys-color-on-secondary-container, #b8f0b8);
            border: none;
            padding: 12px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1em;
            text-align: left;
            border-left: 4px solid #4caf50;
          ">
            <div style="font-weight: 500;">Replace Cloud with Local</div>
            <div style="font-size: 0.9em; opacity: 0.8; margin-top: 4px;">
              Overwrite the ${snippetText} with your local bookmarks
            </div>
          </button>

          <button id="replaceLocal" style="
            background: var(--md-sys-color-error-container);
            color: var(--md-sys-color-on-error-container);
            border: none;
            padding: 12px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1em;
            text-align: left;
            border-left: 4px solid var(--md-sys-color-error);
          ">
            <div style="font-weight: 500;">Replace Local with Cloud</div>
            <div style="font-size: 0.9em; opacity: 0.8; margin-top: 4px;">
              Use the ${snippetText} only (your local bookmarks will be lost)
            </div>
          </button>
        </div>
      `;

      modal.appendChild(dialog);
      document.body.appendChild(modal);

      // Button handlers
      dialog.querySelector('#keepLocal').addEventListener('click', () => {
        modal.remove();
        resolve('keep-local');
      });

      dialog.querySelector('#doMerge').addEventListener('click', () => {
        modal.remove();
        resolve('merge');
      });

      dialog.querySelector('#replaceRemote').addEventListener('click', () => {
        modal.remove();
        resolve('replace-remote');
      });

      dialog.querySelector('#replaceLocal').addEventListener('click', () => {
        modal.remove();
        resolve('replace');
      });
    });
  }

  /**
   * Create snippet with merged local bookmarks
   */
  async createSnippetWithLocalBookmarks() {
    try {
      console.log('[createSnippetWithLocalBookmarks] Starting merge process...');

      /* [ZeroLabs] 2026-08-27 - edited: read the tree, not an empty object store */
      // Same wrong source as hasLocalBookmarks. It handed mergeBookmarksIntoTree
      // an empty array, which fell into the legacy flat-array branch and merged
      // nothing, so "create a snippet with my bookmarks" created an empty one.
      const localTree = await syncManager.loadLocalBookmarks();
      console.log('[createSnippetWithLocalBookmarks] Local bookmarks:',
        syncManager.countBookmarksInTree(localTree));

      // Get empty bookmark tree structure
      const emptyTree = syncManager.getEmptyBookmarkTree();

      // Merge local bookmarks into the empty tree
      const mergedTree = syncManager.mergeBookmarksIntoTree(localTree, emptyTree);
      console.log('[createSnippetWithLocalBookmarks] Merged tree created');

      // Create snippet with merged data
      console.log('[createSnippetWithLocalBookmarks] Creating snippet with merged data...');
      const itemId = await snippetAdapter.createBookmarkSnippet(mergedTree);
      console.log('[createSnippetWithLocalBookmarks] Snippet created with merged data:', itemId);

      return itemId;
    } catch (error) {
      console.error('[createSnippetWithLocalBookmarks] Error:', error);
      throw error;
    }
  }

  /**
   * Merge local bookmarks into existing snippet
   */
  async mergeLocalBookmarksIntoSnippet(snippetId) {
    try {
      console.log('[mergeLocalBookmarksIntoSnippet] Starting merge process for snippet:', snippetId);

      // Get current snippet data
      const snippetData = await snippetAdapter.readBookmarks(snippetId);
      console.log('[mergeLocalBookmarksIntoSnippet] Retrieved snippet data');

      /* [ZeroLabs] 2026-08-27 - edited: read the tree, not an empty object store */
      // Same wrong source again, and the same silent no-op: choosing Merge on
      // connect pushed the snippet back unchanged and this device's bookmarks
      // were then replaced by it on the pull that follows.
      const localTree = await syncManager.loadLocalBookmarks();
      console.log('[mergeLocalBookmarksIntoSnippet] Local bookmarks:',
        syncManager.countBookmarksInTree(localTree));

      // Merge local bookmarks into snippet data
      const mergedTree = syncManager.mergeBookmarksIntoTree(localTree, snippetData);
      console.log('[mergeLocalBookmarksIntoSnippet] Merged tree created');

      // Update snippet with merged data
      console.log('[mergeLocalBookmarksIntoSnippet] Updating snippet with merged data...');
      await snippetAdapter.updateBookmarks(snippetId, mergedTree, snippetData.version + 1);
      console.log('[mergeLocalBookmarksIntoSnippet] Snippet updated successfully');

    } catch (error) {
      console.error('[mergeLocalBookmarksIntoSnippet] Error:', error);
      throw error;
    }
  }

  /**
   * Replace remote snippet with local bookmarks
   */
  async replaceRemoteWithLocal(snippetId) {
    try {
      console.log('[replaceRemoteWithLocal] Starting replace process for snippet:', snippetId);

      // Get local bookmarks tree
      const localBookmarks = await syncManager.getLocalBookmarks();
      console.log('[replaceRemoteWithLocal] Retrieved local bookmarks');

      // Update snippet with local bookmarks (replace remote content)
      await snippetAdapter.updateBookmarks(snippetId, localBookmarks);
      console.log('[replaceRemoteWithLocal] Snippet updated successfully with local bookmarks');

    } catch (error) {
      console.error('[replaceRemoteWithLocal] Error:', error);
      throw error;
    }
  }

  /**
   * Show snippet setup error
   */
  showSnippetSetupError(message) {
    const errorDiv = document.getElementById('snippetSetupError');
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.style.display = 'block';
    }
  }

  async checkAndRotateIfNeeded() {
    if (this._rotationPromptActive) return;
    try {
      const token = await authManager.getToken('gitlab');
      if (!token) return;

      // Fast-path: skip API call if cached expiry shows > 30 days remaining
      const cachedExpiry = safeLocalStorage.getItem('gitlab_token_expires');
      if (cachedExpiry) {
        const cachedDaysLeft = (new Date(cachedExpiry) - Date.now()) / (1000 * 60 * 60 * 24);
        if (cachedDaysLeft > 30) return;
      }

      const res = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) {
        this.showToast('GitLab token is invalid or expired. Please re-enter it in sync settings.', 'error');
        return;
      }
      if (!res.ok) return;

      const info = await res.json();
      if (!info.expires_at) return;

      safeLocalStorage.setItem('gitlab_token_expires', info.expires_at);

      const daysLeft = (new Date(info.expires_at) - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysLeft > 30) return;

      // Check 24-hour snooze
      const snoozeTime = safeLocalStorage.getItem('bmz_rotation_snooze');
      if (snoozeTime) {
        const snoozeAge = Date.now() - parseInt(snoozeTime, 10);
        if (snoozeAge < 24 * 60 * 60 * 1000) return;
      }

      this._rotationPromptActive = true;
      const choice = await this.showPreRotationPrompt(daysLeft);
      if (choice === 'snooze') {
        safeLocalStorage.setItem('bmz_rotation_snooze', Date.now());
        return;
      }

      const newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + 350);
      const newExpiryStr = newExpiry.toISOString().split('T')[0];

      const rotateRes = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self/rotate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_at: newExpiryStr })
      });
      if (!rotateRes.ok) {
        if (rotateRes.status === 403) {
          this.showToast('Token renewal failed: insufficient scopes. Your token needs the "api" scope. Please create a new token manually.', 'error');
        } else if (rotateRes.status === 429) {
          this.showToast('Token renewal failed: GitLab rate limit hit. It will be retried on the next sync.', 'error');
        } else {
          this.showToast(`Token renewal failed (${rotateRes.status}). Please try again later.`, 'error');
        }
        return;
      }

      const rotated = await rotateRes.json();
      const mode = await supabaseManager.getTokenMode();

      if (mode === 'supabase' && supabaseManager.isSignedIn) {
        try {
          await supabaseManager.saveGitLabToken(rotated.token, rotated.expires_at);
        } catch (e) {
          console.warn('[TokenRotation] Supabase save failed:', e);
        }
      }

      await authManager.storeToken(rotated.token, null, 'gitlab');
      oauthPAT.token = rotated.token;
      safeLocalStorage.removeItem('bmz_rotation_snooze');
      safeLocalStorage.setItem('gitlab_token_expires', rotated.expires_at);

      this.showPostRotationModal(rotated.token, mode);
    } catch (err) {
      this._rotationPromptActive = false;
      console.error('[TokenRotation] Failed:', err);
    }
  }

  showPreRotationPrompt(daysLeft) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';
      modal.innerHTML = `
        <div style="background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:420px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);">
          <h2 style="margin:0 0 12px 0;font-size:18px;">🔑 GitLab Token Expiring Soon</h2>
          <p style="font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);margin:0 0 16px 0;">Your GitLab Personal Access Token expires in <strong style="color:var(--md-sys-color-on-surface,#e0e0e0);">${Math.floor(daysLeft)} day${Math.floor(daysLeft) !== 1 ? 's' : ''}</strong>. BMZ can renew it automatically right now.</p>
          <div style="padding:10px 12px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;font-size:12px;color:var(--md-sys-color-on-surface-variant,#aaa);margin-bottom:16px;">
            ⚠️ Renewing creates a <strong>new token</strong> and immediately invalidates the old one. If you use BMZ on other browsers, the extension, or Android, you will need to enter the new token on each of those clients to maintain sync.
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button id="rotateNowBtn" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:14px;cursor:pointer;font-weight:500;">Renew Token Now</button>
            <button id="snoozeDayBtn" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);font-size:14px;cursor:pointer;">Remind me tomorrow</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      const dismiss = (result) => {
        modal.remove();
        this._rotationPromptActive = false;
        resolve(result);
      };
      modal.querySelector('#rotateNowBtn').addEventListener('click', () => dismiss('rotate'));
      modal.querySelector('#snoozeDayBtn').addEventListener('click', () => dismiss('snooze'));
      modal.addEventListener('click', (e) => { if (e.target === modal) dismiss('snooze'); });
      const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); dismiss('snooze'); } };
      document.addEventListener('keydown', onKey);
    });
  }

  showPostRotationModal(newToken, mode = 'local') {
    const isSupabase = mode === 'supabase';
    const actionBox = isSupabase
      ? `<div style="padding:12px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:12px;margin-bottom:12px;">
           ✅ <strong>Your other BMZ clients will pick up the new token automatically</strong> on their next sync — no action needed on other devices.
         </div>`
      : `<div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.35);border-radius:8px;font-size:12px;margin-bottom:12px;">
           🚨 <strong>Your old token is now invalid.</strong> If you use BMZ on other browsers, the extension, or Android, open each one, go to the GitLab sync settings, and paste this new token. Until you do, sync will be broken on those clients.
         </div>`;
    const hintBox = isSupabase
      ? `<div style="padding:10px 12px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:8px;font-size:12px;color:var(--md-sys-color-on-surface-variant,#aaa);margin-bottom:16px;">
           💡 You can always retrieve your current token from <strong>Settings → Reveal GitLab Token</strong> in BMZ if you ever need it.
         </div>`
      : `<div style="padding:10px 12px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:8px;font-size:12px;color:var(--md-sys-color-on-surface-variant,#aaa);margin-bottom:16px;">
           💡 You can always retrieve your current token from <strong>Settings → Reveal GitLab Token</strong> in BMZ. Want renewals to sync automatically across all devices? Switch to <strong>Supabase storage</strong> in GitLab Sync Settings.
         </div>`;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:480px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);">
        <h2 style="margin:0 0 12px 0;font-size:18px;">✅ Token Renewed Successfully</h2>
        <p style="font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);margin:0 0 8px 0;">Your new GitLab Personal Access Token is shown below. <strong style="color:var(--md-sys-color-error,#ef4444);">Copy it now</strong> — GitLab will never show this token again once you leave this screen.</p>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
          <input type="text" readonly id="rotatedTokenDisplay" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--md-sys-color-outline,#444);background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);font-size:12px;font-family:monospace;box-sizing:border-box;">
          <button id="copyRotatedToken" style="padding:10px 14px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:13px;cursor:pointer;white-space:nowrap;">Copy</button>
        </div>
        ${actionBox}
        ${hintBox}
        <button id="closeRotationModal" style="width:100%;padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:14px;cursor:pointer;font-weight:500;">I've copied my token</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#rotatedTokenDisplay').value = newToken;
    modal.querySelector('#rotatedTokenDisplay').addEventListener('click', (e) => e.target.select());
    modal.querySelector('#copyRotatedToken').addEventListener('click', () => {
      navigator.clipboard.writeText(newToken).then(() => {
        const btn = modal.querySelector('#copyRotatedToken');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    });
    modal.querySelector('#closeRotationModal').addEventListener('click', () => modal.remove());
  }

  async showGitLabDisconnectDialog() {
    const isSupabase = (await supabaseManager.getTokenMode()) === 'supabase';
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:400px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);';
    dialog.className = 'bmz-dialog';
    dialog.innerHTML = `
      <h2 style="margin:0 0 16px 0;font-size:18px;display:flex;align-items:center;gap:8px;">
        <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/></svg>
        GitLab Account
      </h2>
      <p style="margin:0 0 20px 0;font-size:14px;color:var(--md-sys-color-on-surface-variant,#aaa);">
        ${isSupabase
          ? 'Disconnect this device only, or remove your token from all devices?'
          : 'Disconnect and remove your GitLab token from this device?'}
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${isSupabase ? `
        <button id="disconnectLocal" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);cursor:pointer;font-size:14px;">This device only</button>
        <button id="disconnectAll" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-error,#f44336);color:var(--md-sys-color-on-error,#fff);cursor:pointer;font-size:14px;">All devices</button>
        ` : `
        <button id="disconnectLocal" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-error,#f44336);color:var(--md-sys-color-on-error,#fff);cursor:pointer;font-size:14px;">Disconnect</button>
        `}
        <button id="cancelGitLabDisconnect" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);cursor:pointer;font-size:14px;">Cancel</button>
      </div>
    `;
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    const doDisconnect = async (removeFromSupabase) => {
      modal.remove();
      if (removeFromSupabase) await supabaseManager.deleteGitLabToken();
      await this.logout();
      this.showToast(removeFromSupabase ? 'Disconnected from all devices' : 'Disconnected this device');
    };

    dialog.querySelector('#cancelGitLabDisconnect').addEventListener('click', () => modal.remove());
    dialog.querySelector('#disconnectLocal').addEventListener('click', () => doDisconnect(false));
    if (isSupabase) dialog.querySelector('#disconnectAll').addEventListener('click', () => doDisconnect(true));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  async showGitLabSyncSettingsDialog() {
    const currentMode = await supabaseManager.getTokenMode();
    const modeLabel = currentMode === 'supabase' ? '☁️ Supabase' : '💻 Local';
    const switchLabel = currentMode === 'supabase' ? 'Switch to Local' : 'Enable Supabase';
    const snippetId = snippetAdapter.snippetId || syncManager.snippetId;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:480px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);max-height:90vh;overflow-y:auto;';
    dialog.className = 'bmz-dialog';

    /* [ZeroLabs] 2026-09-07 4:33 PM - added: which store controls this device gets (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
    // Three states, not two. A device on a project switches repositories. A
    // device on a snippet keeps the snippet controls, because those still
    // describe what it uses. A device connected to NOTHING gets neither: setup
    // only offers repositories, and offering a new user a route onto snippets
    // would steer them onto the storage everyone is being migrated away from.
    const BTN = 'padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);cursor:pointer;font-size:14px;';
    /* [ZeroLabs] 2026-09-08 2:20 AM - added: the third state needs a way in */
    // A device holding a token but connected to nothing had no store button at
    // all here, leaving this dialog with Disconnect and Cancel and no route to a
    // store. Same gap the extensions had, found there first and missed here.
    const SETUP_BTN = 'padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#90caf9);color:var(--md-sys-color-on-primary,#000);cursor:pointer;font-size:14px;font-weight:500;';

    let storeChoiceButtons = '';
    if (snippetAdapter.isProject()) {
      storeChoiceButtons = `<button id="changeRepository" style="${BTN}">Change Repository</button>`;
    } else if (snippetId) {
      storeChoiceButtons = `
            <button id="createNewSnippet" style="${BTN}">Create New Snippet with Current Bookmarks</button>
            <button id="selectExistingSnippet" style="${BTN}">Select Existing Snippet</button>`;
    } else {
      storeChoiceButtons = `<button id="openStoreSetup" style="${SETUP_BTN}">Set Up Bookmark Sync</button>`;
    }

    // Offered before anything breaks, and only while this device is still on a
    // snippet. A snippet keeps every past version of bookmarks.json, so a large
    // collection eventually passes its allocation and goes permanently read-only.
    let migrateButton = '';
    if (snippetId && !snippetAdapter.isProject()) {
      migrateButton = `
            <hr style="border:none;border-top:1px solid var(--md-sys-color-outline,#444);margin:4px 0;">
            <button id="migrateToRepo" style="${BTN}">Move your bookmarks to a repository</button>`;
    }

    // Both overwrite buttons are destructive and their labels differ by word
    // order alone. The arrow says the direction before the text does.
    const ARROW_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;" aria-hidden="true"><path d="M13,20H11V8L5.5,13.5L4.08,12.08L12,4.16L19.92,12.08L18.5,13.5L13,8V20Z"/></svg>';
    const ARROW_DOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;" aria-hidden="true"><path d="M11,4H13V16L18.5,10.5L19.92,11.92L12,19.84L4.08,11.92L5.5,10.5L11,16V4Z"/></svg>';
    const DANGER = 'padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-error-container,#3b1a1a);color:var(--md-sys-color-on-error-container,#f9dedc);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px;';

    if (snippetId) {
      dialog.innerHTML = `
        <!-- [ZeroLabs] 2026-08-27 - edited: centered heading (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) -->
        <h2 style="margin:0 0 12px 0;font-size:20px;text-align:center;">GitLab Sync Settings</h2>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <!-- [ZeroLabs] 2026-08-27 - edited: one sync button instead of two directions -->
          <!-- The old pair was misleading: cloud-to-device only opened a review
               dialog, while device-to-cloud silently overwrote the snippet with no
               confirmation at all. One button runs the same reconcile everything
               else runs, and anything that would remove or overwrite defers.
               The loader rides the circle's edge, which leaves the tanuki and the
               label alone in the middle instead of fighting them for room. -->
          <div style="display:flex;justify-content:center;padding:8px 0;">
            <button id="manualSyncNow" title="Sync your bookmarks" aria-label="Sync your bookmarks" style="position:relative;width:128px;height:128px;max-width:100%;border-radius:50%;border:none;background:var(--md-sys-color-surface-container,#2a2a2a);box-shadow:var(--md-elevation-1);cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;">
              <span id="manualSyncRing" style="position:absolute;inset:0;border-radius:50%;border:4px solid transparent;box-sizing:border-box;pointer-events:none;"></span>
              <svg width="92" height="92" viewBox="0 0 24 24" style="display:block;">
                <path fill="#000000" d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/>
              </svg>
              <span id="manualSyncStatus" style="position:absolute;left:50%;top:56%;transform:translate(-50%,-50%);font-size:13px;font-weight:700;color:#ffffff;white-space:nowrap;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,0.8);">Sync</span>
            </button>
          </div>
          <!-- [ZeroLabs] 2026-09-08 3:35 AM - moved: out of the collapsed panel -->
          <!-- Which store you are connected to is the first thing you want when
               you open this dialog, and it was hidden behind the Cloud Sync
               Options toggle, which starts collapsed. It sits with the sync
               button now, above the divider, since both describe the current
               connection rather than offering an action. -->
          <div style="text-align:center;font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);line-height:1.7;padding:4px 0;">
            Connected to ${snippetAdapter.isProject() ? 'Repository' : 'Snippet'}:<br><code id="connectedStoreName" style="font-size:12px;word-break:break-all;">${snippetId}</code>
          </div>
          <hr style="border:none;border-top:1px solid var(--md-sys-color-outline,#444);margin:4px 0;">
          <button id="snippetOptionsToggle" aria-expanded="false" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span>Cloud Sync Options</span>
            <svg id="snippetOptionsChevron" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;transition:transform 0.2s ease;transform:rotate(-90deg);"><path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>
          </button>
          <div id="snippetOptionsPanel" style="display:none;flex-direction:column;gap:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--md-sys-color-surface-variant,#2a2a2a);border-radius:8px;">
              <span style="font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);">Token Storage: <strong style="color:var(--md-sys-color-on-surface,#e0e0e0);">${modeLabel}</strong></span>
              <button id="switchTokenMode" style="padding:6px 12px;border-radius:6px;border:none;background:var(--md-sys-color-secondary-container,#3a3a5c);color:var(--md-sys-color-on-secondary-container,#d0bcff);font-size:12px;cursor:pointer;">${switchLabel}</button>
            </div>
            <!-- [ZeroLabs] 2026-08-27 - added: automatic sync toggle -->
            <div style="padding:8px 12px;background:var(--md-sys-color-surface-variant,#2a2a2a);border-radius:8px;">
              <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;">
                <span style="font-size:13px;color:var(--md-sys-color-on-surface,#e0e0e0);">Background auto-sync</span>
                <input type="checkbox" id="autoSyncToggle" style="flex-shrink:0;width:16px;height:16px;cursor:pointer;">
              </label>
              <div style="font-size:12px;color:var(--md-sys-color-on-surface-variant,#aaa);margin-top:6px;">
                Checks for changes every 5 minutes and syncs automatically when nothing would be removed.
                Anything that would delete a bookmark will defer for consent.
              </div>
            </div>
            ${storeChoiceButtons}
            ${migrateButton}
            <!-- [ZeroLabs] 2026-08-27 - added: forcing, always reachable -->
            <!-- The sync button resolves everything it safely can, which means a
                 divergence in renames or moves never surfaces a choice here, and a
                 wholesale recovery has no route. These stay available whatever the
                 current difference happens to look like. -->
            <hr style="border:none;border-top:1px solid var(--md-sys-color-outline,#444);margin:4px 0;">
            <button id="forceOverwriteSnippet" style="${DANGER}">${ARROW_UP}<span>Overwrite Cloud with Local</span></button>
            <button id="forceOverwriteLocal" style="${DANGER}">${ARROW_DOWN}<span>Overwrite Local with Cloud</span></button>
            <button id="disconnectSnippet" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-error-container,#3b1a1a);color:var(--md-sys-color-on-error-container,#f9dedc);cursor:pointer;font-size:14px;">Disconnect & Remove Token</button>
          </div>
          <button id="closeSyncSettings" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);cursor:pointer;font-size:14px;">Close</button>
        </div>
      `;

      /* [ZeroLabs] 2026-08-19 6:01 PM - added: collapsible snippet options section (see also: Bookmark-Manager-Zero-Firefox/sidebar.js) */
      // Collapsed by default: this dialog only renders when a snippet is already
      // connected, so the two sync buttons are all most visits need.
      /* [ZeroLabs] 2026-09-08 3:10 AM - added: fill in the store's real name */
      // Not awaited. The dialog is already usable, and a slow GitLab must not
      // hold it shut over a label. On failure the id simply stays, which is what
      // the dialog showed before this existed.
      if (snippetId) {
        snippetAdapter.describeStore().then(info => {
          const name = snippetAdapter.cleanStoreName(info && info.name);
          if (!name) return;
          const el = dialog.querySelector('#connectedStoreName');
          if (el) el.textContent = name;
        }).catch(error => {
          console.warn('[Store] Could not read the store name:', error);
        });
      }

      const snippetOptionsToggle = dialog.querySelector('#snippetOptionsToggle');
      const snippetOptionsPanel = dialog.querySelector('#snippetOptionsPanel');
      const snippetOptionsChevron = dialog.querySelector('#snippetOptionsChevron');
      if (snippetOptionsToggle && snippetOptionsPanel) {
        snippetOptionsToggle.addEventListener('click', () => {
          const isOpen = snippetOptionsPanel.style.display !== 'none';
          snippetOptionsPanel.style.display = isOpen ? 'none' : 'flex';
          snippetOptionsToggle.setAttribute('aria-expanded', String(!isOpen));
          if (snippetOptionsChevron) {
            snippetOptionsChevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
          }
        });
      }
    } else {
      dialog.innerHTML = `
        <h2 style="margin:0 0 16px 0;font-size:20px;text-align:center;">GitLab Sync Setup</h2>
        <div style="margin-bottom:16px;padding:12px;border:1px solid var(--md-sys-color-outline,#444);border-radius:8px;">
          <p style="margin:0 0 10px 0;font-size:13px;font-weight:500;color:var(--md-sys-color-on-surface,#e0e0e0);">Token Storage</p>
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;margin-bottom:10px;font-size:13px;">
            <input type="radio" name="tokenMode" value="local" ${currentMode !== 'supabase' ? 'checked' : ''} style="margin-top:2px;flex-shrink:0;">
            <span><span style="display:inline-flex;align-items:center;gap:5px;"><strong>Local</strong><span class="bmz-tooltip-wrap" style="position:relative;display:inline-flex;align-items:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--md-sys-color-on-surface-variant,#aaa);color:var(--md-sys-color-surface,#1e1e1e);font-size:10px;font-weight:700;cursor:help;flex-shrink:0;line-height:1;">i</span><span class="bmz-tooltip" style="display:none;position:fixed;background:var(--md-sys-color-inverse-surface,#e0e0e0);color:var(--md-sys-color-inverse-on-surface,#1a1a1a);padding:8px 10px;border-radius:6px;font-size:12px;width:220px;z-index:10010;line-height:1.4;pointer-events:none;white-space:normal;">Token stored on this device only. When it auto-renews, you'll be shown the new token and asked to update your other BMZ clients manually.</span></span></span><br><span style="color:var(--md-sys-color-on-surface-variant,#aaa);font-size:12px;">(this device only)</span></span>
          </label>
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;">
            <input type="radio" name="tokenMode" value="supabase" ${currentMode === 'supabase' ? 'checked' : ''} style="margin-top:2px;flex-shrink:0;">
            <span><span style="display:inline-flex;align-items:center;gap:5px;"><strong>Supabase</strong><span class="bmz-tooltip-wrap" style="position:relative;display:inline-flex;align-items:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--md-sys-color-on-surface-variant,#aaa);color:var(--md-sys-color-surface,#1e1e1e);font-size:10px;font-weight:700;cursor:help;flex-shrink:0;line-height:1;">i</span><span class="bmz-tooltip" style="display:none;position:fixed;background:var(--md-sys-color-inverse-surface,#e0e0e0);color:var(--md-sys-color-inverse-on-surface,#1a1a1a);padding:8px 10px;border-radius:6px;font-size:12px;width:220px;z-index:10010;line-height:1.4;pointer-events:none;white-space:normal;">Your token is encrypted and stored in Supabase. When it renews, all your BMZ clients update silently, with no manual steps. Only your encrypted token is stored; it can only access your GitLab bookmark snippet.</span></span></span><br><span style="color:var(--md-sys-color-on-surface-variant,#aaa);font-size:12px;">(auto-sync across devices)</span></span>
          </label>
          <div id="supabaseQuickLoad" style="display:none;margin-top:12px;padding:10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:8px;font-size:12px;color:var(--md-sys-color-on-surface-variant,#aaa);">
            ☁️ Already set up on another device? <button id="loadFromSupabaseBtn" style="background:none;border:none;color:var(--md-sys-color-primary,#818cf8);cursor:pointer;font-size:12px;text-decoration:underline;padding:0;">Sign in to load automatically →</button>
          </div>
        </div>
        <div id="patSection">
          <p style="margin:0 0 12px 0;color:var(--md-sys-color-on-surface-variant,#aaa);font-size:13px;">
            Click below to create a GitLab Personal Access Token with the "api" scope.
          </p>
          <a href="https://gitlab.com/-/user_settings/personal_access_tokens?name=Bookmark+Manager+Zero&scopes=api" target="_blank" style="display:inline-block;margin-bottom:12px;padding:8px 16px;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);text-decoration:none;border-radius:8px;font-size:13px;">
            Create Token on GitLab →
          </a>
          <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:8px;font-size:14px;">Personal Access Token:</label>
            <input type="password" id="gitlabTokenInput" placeholder="glpat-xxxxxxxxxxxx" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--md-sys-color-outline,#444);background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);font-size:14px;box-sizing:border-box;">
          </div>
        </div>
        <div style="display:flex;gap:12px;">
          <button id="saveTokenBtn" style="flex:1;padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);cursor:pointer;font-size:14px;font-weight:500;">Save & Continue</button>
          <button id="closeSyncSettings" style="flex:1;padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);cursor:pointer;font-size:14px;">Cancel</button>
        </div>
      `;
    }

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    if (snippetId) {
      dialog.querySelector('#closeSyncSettings').addEventListener('click', () => modal.remove());

      /* [ZeroLabs] 2026-08-27 - added: the one sync button, runs the reconcile */
      // Statuses are single words because they sit inside the ring, and that
      // space allows one line. The detail goes to a toast instead. Spinning draws
      // one coloured arc; settling paints the whole ring in the outcome colour.
      const manualSyncNowBtn = dialog.querySelector('#manualSyncNow');
      if (manualSyncNowBtn) {
        const ring = dialog.querySelector('#manualSyncRing');
        const status = dialog.querySelector('#manualSyncStatus');
        let running = false;

        const setSyncState = (colour, spinning) => {
          if (status) status.style.color = colour;
          if (!ring) return;
          if (spinning) {
            ring.style.borderColor = 'transparent';
            ring.style.borderTopColor = colour;
            ring.style.animation = 'spin 1s linear infinite';
          } else {
            ring.style.animation = '';
            ring.style.borderColor = colour;
          }
        };

        const runManualSync = async () => {
          if (running) return;
          running = true;
          setSyncState('#ffffff', true);
          if (status) status.textContent = 'Syncing';

          try {
            const outcome = await syncManager.reconcileWithSnippet();

            if (outcome.deferred) {
              setSyncState('#ff9800', false);
              if (status) status.textContent = 'Decide';
              modal.remove();
              await this.showHeldPushDialog();
              return;
            }

            setSyncState('#4caf50', false);
            if (status) status.textContent = outcome.changed ? 'Synced' : 'In Sync';
            /* [ZeroLabs] 2026-08-27 - edited: silent when nothing changed */
            // The ring already reads "In Sync", so a toast saying the same is
            // just a second notification for a non-event.
            if (outcome.changed) {
              this.showToast(outcome.addedLocally > 0
                ? `Synced. ${outcome.addedLocally} added here, cloud updated.`
                : 'Synced. Cloud updated.', 'success');
            }
          } catch (error) {
            console.error('[ManualSync] Failed:', error);
            setSyncState('#f44336', false);
            if (status) status.textContent = 'Error';
            this.showToast(`Sync failed: ${error.message}`, 'error');
          } finally {
            running = false;
          }
        };

        manualSyncNowBtn.addEventListener('click', runManualSync);
        /* [ZeroLabs] 2026-08-29 - edited: opening the dialog no longer syncs */
        // It used to call runManualSync() here, on the reasoning that opening the
        // dialog was itself a request to sync. That made the dialog impossible to
        // reach for any other purpose: turning OFF background auto-sync, or
        // switching snippets, meant triggering the very sync you were trying to
        // stop. The button is right there and clearly labelled; syncing is now
        // always something the user asks for.
      }

      /* [ZeroLabs] 2026-08-27 - added: the two forced overwrites */
      // Both name what is about to be lost before doing it. The snippet one reads
      // the remote first purely so the count is real rather than a vague warning.
      dialog.querySelector('#forceOverwriteSnippet')?.addEventListener('click', async () => {
        try {
          const remoteData = await snippetAdapter.readBookmarks(snippetId);
          const localTree = await syncManager.loadLocalBookmarks();
          const remoteEntries = syncManager.collectSnippetEntries(remoteData);
          const localEntries = syncManager.collectSnippetEntries(localTree);
          let losing = 0;
          remoteEntries.forEach((entry, key) => { if (!localEntries.has(key)) losing++; });

          const proceed = confirm(losing > 0
            ? `Warning: your cloud bookmarks will be replaced with this device's.\n\n${losing} item(s) currently in the cloud are not on this device and will be lost, on every device using it.\n\nContinue?`
            : 'Your cloud bookmarks will be replaced with this device\'s. Nothing in the cloud is missing here, so nothing will be lost.\n\nContinue?');
          if (!proceed) return;

          modal.remove();
          const count = await syncManager.pushLocalToSnippet();
          this.showToast(`Cloud overwritten with ${count} local bookmark${count === 1 ? '' : 's'}.`, 'success');
        } catch (error) {
          console.error('[ForceOverwrite] Snippet overwrite failed:', error);
          this.showToast(`Error: ${error.message}`, 'error');
        }
      });

      dialog.querySelector('#forceOverwriteLocal')?.addEventListener('click', async () => {
        if (!confirm('Warning: every bookmark on this device will be replaced with the cloud copy.\n\nAnything here that is not in the cloud will be lost.\n\nContinue?')) return;
        try {
          const remoteData = await snippetAdapter.readBookmarks(snippetId);
          modal.remove();
          const success = await syncManager.applyRemoteSync(remoteData);
          if (success) {
            await bookmarkManager.reload();
            if (window.reloadBookmarkUI) await window.reloadBookmarkUI();
            this.showToast('Local bookmarks replaced with the cloud copy.', 'success');
          }
        } catch (error) {
          console.error('[ForceOverwrite] Local overwrite failed:', error);
          this.showToast(`Error: ${error.message}`, 'error');
        }
      });

      /* [ZeroLabs] 2026-08-27 - added: bind the auto-sync toggle */
      // Absent means on, so only an explicit false switches it off.
      const autoSyncToggle = dialog.querySelector('#autoSyncToggle');
      if (autoSyncToggle) {
        syncManager.isAutoSyncEnabled().then(enabled => {
          autoSyncToggle.checked = enabled;
        });
        autoSyncToggle.addEventListener('change', async () => {
          await storageAdapter.set({ bmz_auto_sync_enabled: autoSyncToggle.checked });
          this.showToast(autoSyncToggle.checked
            ? 'Background auto-sync enabled'
            : 'Background auto-sync disabled. Manual sync still works.', 'info');
        });
      }

      /* [ZeroLabs] 2026-09-07 4:33 PM - added: repository controls, and optional-chained the snippet ones */
      // These two are absent for a project device and for one connected to
      // nothing, so the unguarded querySelector below would have thrown.
      /* [ZeroLabs] 2026-09-08 2:20 AM - added: reach setup from the settings dialog */
      dialog.querySelector('#openStoreSetup')?.addEventListener('click', async () => {
        modal.remove();
        await this.showSnippetSetup();
      });

      dialog.querySelector('#changeRepository')?.addEventListener('click', async () => {
        modal.remove();
        await this.showSnippetSetup('switch');
      });

      dialog.querySelector('#migrateToRepo')?.addEventListener('click', async () => {
        modal.remove();
        await this.showSnippetSetup('migrate');
      });

      dialog.querySelector('#createNewSnippet')?.addEventListener('click', async () => {
        modal.remove();
        await this.showSnippetSetup();
      });
      dialog.querySelector('#selectExistingSnippet')?.addEventListener('click', async () => {
        modal.remove();
        await this.showSnippetSetup();
      });
      dialog.querySelector('#disconnectSnippet').addEventListener('click', async () => {
        if (confirm('Are you sure you want to disconnect? This will remove your GitLab token.')) {
          modal.remove();
          /* [ZeroLabs] 2026-09-24 2:10 AM - fixed: this was a second, partial sign-out */
          // It cleared the token and the session and stopped there: no local
          // mode, the repository still saved in localStorage, the reconcile poll
          // still running, and no reload. The header kept its sync icon until
          // the app was restarted. The header's sign-out button goes through
          // logout(), which does all of it and reloads, so this does the same.
          this.showToast('Disconnecting...');
          await this.logout();
        }
      });
      dialog.querySelector('#switchTokenMode').addEventListener('click', async () => {
        modal.remove();
        if (currentMode === 'supabase') {
          await supabaseManager.deleteGitLabToken();
          await supabaseManager.setTokenMode('local');
          this.showToast('Switched to local token storage');
        } else {
          if (!supabaseManager.isSignedIn) await supabaseManager.loadSession();
          if (!supabaseManager.isSignedIn) {
            this.showToast('Sign in with GitLab first', 'error');
            this.showLoginScreen();
            return;
          }
          let expiresAt = null;
          try {
            const token = await authManager.getToken('gitlab');
            const r = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self', { headers: { 'Authorization': `Bearer ${token}` } });
            if (r.ok) { const info = await r.json(); expiresAt = info.expires_at; }
          } catch (e) {}
          try {
            const token = await authManager.getToken('gitlab');
            await supabaseManager.saveGitLabToken(token, expiresAt);
            await supabaseManager.setTokenMode('supabase');
            this.showToast('Switched to Supabase token storage');
          } catch (e) {
            this.showToast('Failed: ' + e.message, 'error');
          }
        }
      });
    } else {
      /* [ZeroLabs] 2026-08-19 6:01 PM - added: tooltip hover for token storage i icons (see also: Bookmark-Manager-Zero-Firefox/sidebar.js) */
      // Fixed positioning so the tooltip stays inside the viewport instead of
      // being clipped by the dialog's overflow.
      dialog.querySelectorAll('.bmz-tooltip-wrap').forEach(wrap => {
        const tip = wrap.querySelector('.bmz-tooltip');
        wrap.addEventListener('mouseenter', () => {
          const rect = wrap.getBoundingClientRect();
          const tipWidth = 220;
          let left = rect.left;
          if (left + tipWidth > window.innerWidth - 8) left = window.innerWidth - tipWidth - 8;
          if (left < 8) left = 8;
          tip.style.top = (rect.bottom + 6) + 'px';
          tip.style.left = left + 'px';
          tip.style.display = 'block';
        });
        wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      });

      dialog.querySelectorAll('input[name="tokenMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const isSupabase = dialog.querySelector('input[name="tokenMode"]:checked')?.value === 'supabase';
          dialog.querySelector('#supabaseQuickLoad').style.display = isSupabase ? '' : 'none';
        });
      });
      if (currentMode === 'supabase') dialog.querySelector('#supabaseQuickLoad').style.display = '';
      dialog.querySelector('#closeSyncSettings').addEventListener('click', () => modal.remove());
      dialog.querySelector('#loadFromSupabaseBtn')?.addEventListener('click', async () => {
        if (!supabaseManager.isSignedIn) await supabaseManager.loadSession();
        if (!supabaseManager.isSignedIn) {
          this.showToast('Signing in with GitLab...', 'info');
          supabaseManager.signInWithGitLab();
          return;
        }
        try {
          const patData = await supabaseManager.loadGitLabToken();
          if (!patData) {
            this.showToast('Signed in! No token stored yet. Enter your PAT below.', 'info');
            return;
          }
          await this._authenticateWithPAT(patData.token);
          modal.remove();
          await this.showSnippetSetup();
        } catch (e) {
          this.showToast('Failed: ' + e.message, 'error');
        }
      });
      dialog.querySelector('#saveTokenBtn').addEventListener('click', async () => {
        const selectedMode = dialog.querySelector('input[name="tokenMode"]:checked')?.value || 'local';
        const token = dialog.querySelector('#gitlabTokenInput').value.trim();
        if (!token) {
          this.showToast('Please enter your GitLab token', 'error');
          return;
        }
        modal.remove();
        await this._authenticateWithPAT(token);
        if (selectedMode === 'supabase') {
          if (!supabaseManager.isSignedIn) await supabaseManager.loadSession();
          if (supabaseManager.isSignedIn) {
            try {
              await supabaseManager.saveGitLabToken(token, null);
              await supabaseManager.setTokenMode('supabase');
            } catch (e) {
              this.showToast('Saved locally (Supabase save failed: ' + e.message + ')', 'warning');
              await supabaseManager.setTokenMode('local');
            }
          } else {
            await supabaseManager.setTokenMode('local');
          }
        }
        await this.showSnippetSetup();
      });
    }

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  async showRevealTokenModal() {
    const token = await authManager.getToken('gitlab');
    if (!token) {
      this.showToast('No GitLab token saved on this device.', 'error');
      return;
    }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:440px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);">
        <h2 style="margin:0 0 12px 0;font-size:18px;">🔑 Your GitLab Token</h2>
        <p style="font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);margin:0 0 12px 0;">This is the Personal Access Token currently saved in BMZ on this device. Keep it private — it grants access to your GitLab bookmark snippet.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px;">
          <input type="password" readonly id="revealTokenInput" style="flex:1 1 100%;min-width:0;padding:10px;border-radius:8px;border:1px solid var(--md-sys-color-outline,#444);background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);font-size:12px;font-family:monospace;box-sizing:border-box;">
          <button id="toggleReveal" style="flex:1 1 auto;flex-shrink:0;padding:10px 12px;border-radius:8px;border:1px solid var(--md-sys-color-outline,#444);background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);font-size:12px;cursor:pointer;">Show</button>
          <button id="copyRevealToken" style="flex:1 1 auto;flex-shrink:0;padding:10px 14px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:13px;cursor:pointer;">Copy</button>
        </div>
        <button id="closeRevealModal" style="width:100%;padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);font-size:14px;cursor:pointer;">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('#revealTokenInput');
    input.value = token;
    modal.querySelector('#toggleReveal').addEventListener('click', (e) => {
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      e.target.textContent = isHidden ? 'Hide' : 'Show';
    });
    modal.querySelector('#copyRevealToken').addEventListener('click', () => {
      navigator.clipboard.writeText(token).then(() => {
        const btn = modal.querySelector('#copyRevealToken');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    });
    modal.querySelector('#closeRevealModal').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  /**
   * Show Connect GitLab modal for local mode users
   */
  showConnectGitlabModal() {
    const modal = document.getElementById('connectGitlabModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.style.display = 'flex';

      // Clear any previous errors
      const errorDiv = document.getElementById('connectGitlabError');
      if (errorDiv) {
        errorDiv.style.display = 'none';
      }

      // Clear input
      const tokenInput = document.getElementById('connectGitlabTokenInput');
      if (tokenInput) {
        tokenInput.value = '';
      }
    }
  }

  /**
   * Setup Connect GitLab modal handlers
   */
  setupConnectGitlabModal() {
    const modal = document.getElementById('connectGitlabModal');
    const cancelBtn = document.getElementById('connectGitlabCancelBtn');
    const confirmBtn = document.getElementById('connectGitlabConfirmBtn');
    const tokenInput = document.getElementById('connectGitlabTokenInput');
    const errorDiv = document.getElementById('connectGitlabError');

    if (!modal || !cancelBtn || !confirmBtn || !tokenInput) return;

    const closeModal = () => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    };

    // Tooltip hover — fixed positioning so they stay within viewport
    modal.querySelectorAll('.bmz-tooltip-wrap').forEach(wrap => {
      const tip = wrap.querySelector('.bmz-tooltip');
      if (!tip) return;
      wrap.addEventListener('mouseenter', () => {
        const rect = wrap.getBoundingClientRect();
        const tipWidth = 220;
        let left = rect.left;
        if (left + tipWidth > window.innerWidth - 8) left = window.innerWidth - tipWidth - 8;
        tip.style.left = left + 'px';
        tip.style.top = (rect.bottom + 6) + 'px';
        tip.style.display = 'block';
      });
      wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });

    // Show/hide Supabase quick-load hint when token mode radio changes
    modal.querySelectorAll('input[name="connectTokenMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isSupabase = modal.querySelector('input[name="connectTokenMode"]:checked')?.value === 'supabase';
        const quickLoad = document.getElementById('connectSupabaseQuickLoad');
        if (quickLoad) quickLoad.style.display = isSupabase ? '' : 'none';
      });
    });

    // "Load from Supabase" quick-load — sign in and pull token, skip PAT entry
    const loadFromSupabaseBtn = document.getElementById('connectLoadFromSupabaseBtn');
    if (loadFromSupabaseBtn) {
      loadFromSupabaseBtn.addEventListener('click', async () => {
        if (!supabaseManager.isSignedIn) await supabaseManager.loadSession();
        if (!supabaseManager.isSignedIn) {
          this.showToast('Signing in with GitLab to load your Supabase token...', 'info');
          supabaseManager.signInWithGitLab();
          return;
        }
        try {
          const patData = await supabaseManager.loadGitLabToken();
          if (!patData) {
            this.showToast('Signed in! No GitLab token stored yet — enter your PAT below to complete setup.', 'info');
            return;
          }
          closeModal();
          const ok = await this._authenticateWithPAT(patData.token);
          if (!ok) this.showToast('Failed to authenticate with stored token.', 'error');
        } catch (e) {
          this.showToast('Failed to load from Supabase: ' + e.message, 'error');
        }
      });
    }

    // Cancel button
    cancelBtn.onclick = closeModal;

    // Enter key in token input
    tokenInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
    });

    // Confirm button — authenticate and optionally save to Supabase
    confirmBtn.onclick = async () => {
      const selectedMode = modal.querySelector('input[name="connectTokenMode"]:checked')?.value || 'local';

      if (selectedMode === 'supabase') {
        // Ensure signed in to Supabase
        if (!supabaseManager.isSignedIn) await supabaseManager.loadSession();
        if (!supabaseManager.isSignedIn) {
          this.showToast('Signing in with GitLab to enable Supabase sync...', 'info');
          supabaseManager.signInWithGitLab();
          return;
        }
        // Check if token already exists in Supabase — no PAT needed if so
        try {
          const patData = await supabaseManager.loadGitLabToken();
          if (patData) {
            closeModal();
            const ok = await this._authenticateWithPAT(patData.token);
            if (!ok) this.showToast('Failed to authenticate with stored token.', 'error');
            return;
          }
        } catch (e) { console.warn('[ConnectModal] Supabase existing token check failed:', e); }
        // No existing token — fall through to PAT entry
        if (!tokenInput.value.trim()) {
          this.showToast('Signed in! This is your first time using Supabase sync — enter your GitLab PAT below to get started.', 'info');
          return;
        }
      }

      const token = tokenInput.value.trim();
      if (!token) {
        if (errorDiv) {
          errorDiv.textContent = 'Please enter your Personal Access Token';
          errorDiv.style.display = 'block';
        }
        return;
      }

      try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Connecting...';
        if (errorDiv) errorDiv.style.display = 'none';

        const authResult = await oauthPAT.authenticate(token, async () => {
          if (errorDiv) errorDiv.style.display = 'none';
          confirmBtn.click();
        });

        if (authResult === null) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Save & Continue';
          return;
        }

        console.log(`Authenticated with GitLab:`, authResult.user.username);

        // Fetch token expiry from GitLab
        let expiresAt = null;
        try {
          const infoRes = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self', {
            headers: { 'Authorization': `Bearer ${authResult.access_token}` }
          });
          if (infoRes.ok) { const info = await infoRes.json(); expiresAt = info.expires_at; }
        } catch (e) { console.warn('[ConnectModal] Could not fetch token expiry:', e); }

        // Store token locally
        await authManager.storeToken(authResult.access_token, null, 'gitlab');
        await authManager.storePreference('syncProvider', 'gitlab');

        // Save to Supabase if supabase mode selected
        if (selectedMode === 'supabase') {
          try {
            await supabaseManager.saveGitLabToken(authResult.access_token, expiresAt);
            await supabaseManager.setTokenMode('supabase');
          } catch (e) {
            console.warn('[ConnectModal] Supabase save failed — using local:', e);
            await supabaseManager.setTokenMode('local');
            this.showToast('Failed to save to Supabase — saved locally instead.', 'error');
          }
        } else {
          await supabaseManager.setTokenMode('local');
        }

        oauthPAT.provider = 'gitlab';
        oauthPAT.token = authResult.access_token;
        oauthPAT.user = authResult.user;
        this.currentUser = authResult.user;
        this.isAuthenticated = true;

        safeLocalStorage.removeItem('bmz_local_mode');
        await dbManager.put('settings', { key: 'bmz_local_mode', value: false });

        const logoutBtn = document.getElementById('logoutBtn');
        const manualSyncBtn = document.getElementById('manualSyncBtn');
        const headerConnectGitlabBtn = document.getElementById('headerConnectGitlabBtn');
        if (logoutBtn) logoutBtn.style.display = 'flex';
        if (manualSyncBtn) manualSyncBtn.style.display = '';
        if (headerConnectGitlabBtn) headerConnectGitlabBtn.style.display = 'none';

        closeModal();
        this.showToast('GitLab connected successfully! Your bookmarks will now sync to the cloud.', 'success');

        await syncManager.init();
        const hasSnippet = await this.checkSnippetSetup();
        if (!hasSnippet) {
          await this.showSnippetSetup();
        } else {
          /* [ZeroLabs] 2026-08-27 - edited: reconcile instead of overwriting the snippet */
          // This blindly wrote this device's tree over a snippet it had never
          // read. Anything already in it went with the push.
          const outcome = await syncManager.reconcileWithSnippet();
          if (outcome.deferred) {
            await this.showHeldPushDialog();
          } else {
            this.showToast('Local bookmarks synced to GitLab successfully!', 'success');
          }
        }

        const connectGitlabBtn = document.getElementById('connectGitlabBtn');
        if (connectGitlabBtn) connectGitlabBtn.style.display = 'none';

      } catch (error) {
        console.error('GitLab connection failed:', error);
        if (errorDiv) {
          errorDiv.textContent = error.message || 'Authentication failed. Please check your token and try again.';
          errorDiv.style.display = 'block';
        }
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Save & Continue';
      }
    };
  }

  /* [ZeroLabs] 2026-08-27 - removed: App.loadBookmarks (dead) */
  // Nothing called it. It pulled with the old version-gated syncFromRemote and
  // re-rendered, which is now what the reconcile plus the sync:localTreeChanged
  // listener do, so leaving it would have been a second, wrong way in.

  /**
   * Load theme from storage
   */
  async loadTheme() {
    try {
      const stored = await dbManager.get('settings', 'theme');
      if (stored) {
        this.currentTheme = stored.value;
      }
      this.applyTheme(this.currentTheme);
    } catch (error) {
      console.error('Failed to load theme:', error);
      this.applyTheme('enhanced-blue');
    }
  }

  /**
   * Apply theme to document
   */
  applyTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    this.currentTheme = themeName;
  }

  /**
   * Save theme to storage
   */
  async saveTheme(themeName) {
    try {
      await dbManager.put('settings', { key: 'theme', value: themeName });
      this.applyTheme(themeName);
    } catch (error) {
      console.error('Failed to save theme:', error);
    }
  }

  /**
   * Set up global event listeners
   */
  setupEventListeners() {
    // Prevent duplicate listener registration
    if (this._eventListenersSetup) {
      return;
    }
    this._eventListenersSetup = true;

    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      // Debounce search to avoid full tree traversal on every keystroke
      let searchDebounceTimer;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          // Update search term globally for sidebar-adapted.js
          if (window.searchTerm !== undefined) {
            window.searchTerm = e.target.value;
          }
          // Use the global renderBookmarks function from sidebar-adapted.js
          if (window.renderBookmarks) {
            window.renderBookmarks();
          }
        }, 300); // Wait 300ms after user stops typing
      });
    }

    // Add bookmark button
    const addBookmarkBtn = document.getElementById('addBookmarkBtn');
    if (addBookmarkBtn) {
      addBookmarkBtn.addEventListener('click', () => {
        this.showAddBookmarkModal();
      });
    }

    // Settings button
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.showSettingsModal();
      });
    }

    /* [ZeroLabs] 2026-06-20 11:01 AM - removed: dead per-sync merge diff dialog + bidirectional merge */

    // Manual sync button - opens GitLab Sync Settings dialog
    const manualSyncBtn = document.getElementById('manualSyncBtn');
    if (manualSyncBtn) {
      manualSyncBtn.addEventListener('click', async (e) => {
        console.log('[GitLabSync] Settings button clicked');
        await this.showGitLabSyncSettingsDialog();
      });
    }

    // Logout button — shows disconnect dialog (Supabase-aware)
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await this.showGitLabDisconnectDialog();
      });
    }

    // GitLab Sync Settings button
    const gitlabSyncSettingsBtn = document.getElementById('gitlabSyncSettingsBtn');
    if (gitlabSyncSettingsBtn) {
      gitlabSyncSettingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const settingsMenu = document.getElementById('settingsMenu');
        if (settingsMenu) settingsMenu.classList.remove('show');
        this.showGitLabSyncSettingsDialog();
      });
    }

    // Reset All Data button
    const resetAllDataBtn = document.getElementById('resetAllDataBtn');
    if (resetAllDataBtn) {
      resetAllDataBtn.addEventListener('click', async () => {
        await this.resetAllData();
      });
    }

    // Connect GitLab button (for local mode users)
    const connectGitlabBtn = document.getElementById('connectGitlabBtn');
    if (connectGitlabBtn) {
      connectGitlabBtn.addEventListener('click', () => {
        this.showConnectGitlabModal();
      });
    }

    // View GitLab Token button
    const revealGitlabTokenBtn = document.getElementById('revealGitlabTokenBtn');
    if (revealGitlabTokenBtn) {
      revealGitlabTokenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const settingsMenu = document.getElementById('settingsMenu');
        if (settingsMenu) settingsMenu.classList.remove('show');
        await this.showRevealTokenModal();
      });
    }

    // Connect GitLab modal handlers
    this.setupConnectGitlabModal();

    // Rescan all button
    const rescanAllBtn = document.getElementById('rescanAllBtn');
    if (rescanAllBtn) {
      rescanAllBtn.addEventListener('click', async () => {
        await scannerService.scanAllBookmarks(true);
      });
    }

    // Import button
    const importBtn = document.getElementById('importBtn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        this.showImportModal();
      });
    }

    // Export button
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        this.showExportModal();
      });
    }

    // Close modals on background click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });


    // Close menus when clicking outside
    document.addEventListener('click', () => {
      if (window.closeAllMenus) {
        window.closeAllMenus();
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape key - close modals and menus
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach(modal => {
          modal.classList.add('hidden');
        });
        if (window.closeAllMenus) {
          window.closeAllMenus();
        }
      }

      // Ctrl/Cmd + K - Focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchInput?.focus();
      }
    });
  }

  /**
   * Set up sync event listeners
   */
  setupSyncListeners() {
    // Prevent duplicate listener registration
    if (this._syncListenersSetup) {
      return;
    }
    this._syncListenersSetup = true;

    // Touch move event (from mobile touch handler)
    window.addEventListener('bookmark:move', async (e) => {
      const { draggedId, targetId, position } = e.detail;
      await this.handleTouchMove(draggedId, targetId, position);
    });

    window.addEventListener('sync:online', () => {
      this.showToast('Back online', 'success');
      this.hideOfflineBanner();
    });

    window.addEventListener('sync:offline', () => {
      this.showToast('Working offline', 'info');
      this.showOfflineBanner();
    });

    window.addEventListener('sync:syncSuccess', (e) => {
      if (e.detail) {
        this.showToast(e.detail, 'success');
      }
    });

    /* [ZeroLabs] 2026-08-27 - added: the reconcile writes the tree directly */
    // It places bookmarks by mutating the stored tree rather than going through
    // bookmarkManager.create, on purpose - firing created events for items that
    // came from the snippet would record them as this device's additions. The
    // cost is that the in-memory tree and the UI are then behind, so they are
    // told here instead.
    window.addEventListener('sync:localTreeChanged', async () => {
      try {
        await bookmarkManager.reload();
        if (window.reloadBookmarkUI) await window.reloadBookmarkUI();
      } catch (error) {
        console.error('Failed to reload bookmarks after sync:', error);
      }
    });

    /* [ZeroLabs] 2026-09-07 4:33 PM - added: a store that has filled up announces itself */
    // Shown once per session. It repeats on every sync otherwise, and a dialog
    // that reopens on its own is what the deferred-sync card was built to replace.
    let storeFullShown = false;
    window.addEventListener('bmz:storeFull', () => {
      if (storeFullShown) return;
      storeFullShown = true;
      console.warn('[Store] GitLab is refusing writes to this snippet; offering the move to a repository');
      this.showSnippetSetup('stopped').catch(error => {
        console.error('[Store] Could not open the migration dialog:', error);
      });
    });

    window.addEventListener('sync:syncError', (e) => {
      if (e.detail) {
        this.showToast(e.detail, 'error');
      }
    });

    /* [ZeroLabs] 2026-06-20 10:47 AM - added: content-divergence nudge listener */
    window.addEventListener('sync:syncNudge', (e) => {
      /* [ZeroLabs] 2026-08-19 7:12 PM - added: share window shows this inline instead */
      // The share window presents the same information with sync actions
      // attached, so a toast on top of it would just be a duplicate.
      if (window.__bmzShareMode) return;
      /* [ZeroLabs] 2026-08-19 7:12 PM - edited: detail is now an object */
      // syncNudge used to carry a bare string; it now carries counts too so the
      // share window can word its own message. The toast wants just the text.
      const nudgeText = typeof e.detail === 'string' ? e.detail : e.detail?.message;
      if (nudgeText) {
        this.showToast(nudgeText, 'info');
      }
    });

    // Handle sync changes (additions/modifications only - auto-apply)
    window.addEventListener('sync:syncChanges', async (e) => {
      const { diff, message } = e.detail;
      this.showSyncChangesNotification(diff, message);

      // Reload bookmark manager and UI to reflect changes
      try {
        await bookmarkManager.reload();
        if (window.reloadBookmarkUI) {
          await window.reloadBookmarkUI();
        }
      } catch (error) {
        console.error('Failed to reload bookmarks after sync:', error);
      }
    });

    // Handle sync conflicts (deletions present - require confirmation)
    window.addEventListener('sync:syncConflict', async (e) => {
      /* [ZeroLabs] 2026-08-19 6:01 PM - added: share window resolves conflicts inline */
      // The Android share window is a small floating window; this full-screen
      // dialog is unusable there and belongs to the main app. sidebar-adapted.js
      // captures the same event and presents the choice inline instead.
      if (window.__bmzShareMode) return;
      const { diff, remoteData, message } = e.detail;
      await this.showSyncConflictDialog(diff, remoteData, message);
    });

    window.addEventListener('tokenExpiring', async (e) => {
      const { daysLeft, token } = e.detail;
      await this.showPreRotationPrompt(daysLeft, token);
    });
  }

  /**
   * Show offline banner
   */
  showOfflineBanner() {
    const banner = document.getElementById('offlineBanner');
    if (banner) {
      banner.classList.remove('hidden');
    }
  }

  /**
   * Hide offline banner
   */
  hideOfflineBanner() {
    const banner = document.getElementById('offlineBanner');
    if (banner) {
      banner.classList.add('hidden');
    }
  }

  /**
   * Show add bookmark modal
   * Modal exists in HTML and is handled by sidebar-adapted.js
   */
  showAddBookmarkModal(parentId = null) {
    console.log('Show add bookmark modal, parent:', parentId);
  }

  /**
   * Show settings menu
   * Settings are accessible via context menu handled by sidebar-adapted.js
   */
  showSettingsModal() {
    console.log('Show settings menu');
  }

  /**
   * Show import modal
   */
  showImportModal() {
    // Create a file input for import
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.json';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        let bookmarkTree;
        const fileName = file.name.toLowerCase();

        if (fileName.endsWith('.html') || fileName.endsWith('.htm')) {
          this.showToast('Importing HTML bookmarks...', 'info');
          bookmarkTree = await importFromHTML(file);
        } else if (fileName.endsWith('.json')) {
          this.showToast('Importing JSON bookmarks...', 'info');
          bookmarkTree = await importFromJSON(file);
        } else {
          this.showToast('Unsupported file format. Please use HTML or JSON.', 'error');
          return;
        }

        // Confirm import with user
        const confirmMsg = `Import ${this.countBookmarks(bookmarkTree)} bookmarks? This will replace your current bookmarks.`;
        if (!confirm(confirmMsg)) {
          this.showToast('Import cancelled', 'info');
          return;
        }

        // Load the imported tree
        await bookmarkManager.replaceTree(bookmarkTree);

        // Re-render UI first using global function
        if (window.renderBookmarks) {
          window.renderBookmarks();
        }

        /* [ZeroLabs] 2026-08-27 - edited: reconcile instead of a blind push */
        // replaceTree attributes every imported URL as this device's addition, so
        // the reconcile pushes them without asking. Anything the snippet has that
        // the import does not is added here rather than being wiped, which is what
        // the old forced push did.
        console.log('[Import] Reconciling with the snippet after import...');
        try {
          const outcome = await syncManager.reconcileWithSnippet();
          if (outcome.deferred) {
            await this.showHeldPushDialog();
          } else {
            console.log('[Import] Sync to remote completed successfully');
            this.showToast('Bookmarks imported and synced successfully!', 'success');
          }
        } catch (syncError) {
          console.error('[Import] Sync to remote failed:', syncError);
          this.showToast(`Import succeeded but sync failed: ${syncError.message}`, 'warning');
        }
      } catch (error) {
        console.error('Import failed:', error);
        this.showToast(`Import failed: ${error.message}`, 'error');
      }
    };

    input.click();
  }

  /**
   * Show export modal
   */
  showExportModal() {
    // Create a simple modal to choose export format
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'flex';

    modal.innerHTML = `
      <div class="modal-content" style="max-width: 400px;">
        <h2>Export Bookmarks</h2>
        <p>Choose export format:</p>
        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button id="exportHTMLBtn" class="btn btn-primary" style="flex: 1;">
            Export as HTML
          </button>
          <button id="exportJSONBtn" class="btn btn-primary" style="flex: 1;">
            Export as JSON
          </button>
        </div>
        <button id="cancelExportBtn" class="btn" style="margin-top: 10px; width: 100%;">
          Cancel
        </button>
      </div>
    `;

    document.body.appendChild(modal);

    /* [ZeroLabs] 2026-09-23 5:20 PM - edited: report what actually happened */
    // Both exporters are async now, and both report whether the file was
    // really written. The old code called them synchronously and announced
    // success either way, which is how a failed export in the Android app
    // still produced "Exported as bookmarks-2026-09-23.html".
    const runExport = async (exporter) => {
      try {
        const tree = bookmarkManager.getTree();
        const { filename, saved, location } = await exporter(tree);

        if (!saved) {
          this.showToast('Export failed. The file was not saved.', 'error');
          return;
        }

        const where = location ? ` to ${location}` : '';
        this.showToast(`Exported as ${filename}${where}`, 'success');
        modal.remove();
      } catch (error) {
        console.error('Export failed:', error);
        this.showToast(`Export failed: ${error.message}`, 'error');
      }
    };

    // Export HTML
    modal.querySelector('#exportHTMLBtn').addEventListener('click', () => {
      runExport(exportAsHTML);
    });

    // Export JSON
    modal.querySelector('#exportJSONBtn').addEventListener('click', () => {
      runExport(exportAsJSON);
    });

    // Cancel
    modal.querySelector('#cancelExportBtn').addEventListener('click', () => {
      modal.remove();
    });

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  /**
   * Handle touch move event from mobile
   */
  async handleTouchMove(draggedId, targetId, position) {
    try {
      console.log(`Moving ${draggedId} ${position} ${targetId}`);

      // Get target bookmark/folder
      const target = bookmarkManager.getBookmark(targetId);
      if (!target) {
        this.showToast('Invalid drop target', 'error');
        return;
      }

      // Determine destination based on position
      let destination = {};

      if (position === 'into' && target.type === 'folder') {
        // Move into folder
        destination.parentId = targetId;
        destination.index = 0; // Add to beginning of folder
      } else {
        // Move before or after
        destination.parentId = target.parentId;

        // Find target's index in parent
        const parent = bookmarkManager.getBookmark(target.parentId);
        if (parent && parent.children) {
          const targetIndex = parent.children.findIndex(child => child.id === targetId);
          destination.index = position === 'before' ? targetIndex : targetIndex + 1;
        }
      }

      // Perform the move
      await bookmarkManager.move(draggedId, destination);

      // Re-render UI using global function
      if (window.renderBookmarks) {
        window.renderBookmarks();
      }

      this.showToast('Bookmark moved', 'success');
    } catch (error) {
      console.error('Failed to move bookmark:', error);
      this.showToast(`Move failed: ${error.message}`, 'error');
    }
  }

  /**
   * Count total bookmarks in tree (for import confirmation)
   */
  countBookmarks(tree) {
    let count = 0;

    const countNode = (node) => {
      if (node.type === 'bookmark' || node.url) {
        count++;
      }
      if (node.children) {
        node.children.forEach(countNode);
      }
    };

    if (tree.roots) {
      Object.values(tree.roots).forEach(root => countNode(root));
    } else {
      countNode(tree);
    }

    return count;
  }

  /**
   * Show dialog asking user if they want to continue with local bookmarks
   * Returns true if user wants to continue, false if they want to see login options
   */
  async showContinueWithLocalBookmarksDialog() {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;';

      const dialog = document.createElement('div');
      dialog.style.cssText = 'background: var(--md-sys-color-surface, #1e293b); padding: 24px; border-radius: 12px; max-width: 500px; box-shadow: 0 10px 40px rgba(0,0,0,0.3);';

      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px 0; color: var(--md-sys-color-on-surface, #f1f5f9); font-size: 20px;">📚 Local Bookmarks Found</h3>
        <p style="margin: 0 0 24px 0; color: var(--md-sys-color-on-surface-variant, #cbd5e1); line-height: 1.6;">
          We found existing bookmarks stored locally on this device. Would you like to continue with these bookmarks, or would you prefer to see login options?
        </p>
        <div style="display: flex; gap: 12px;">
          <button id="showLoginOptions" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-surface-variant, #334155); color: var(--md-sys-color-on-surface-variant, #cbd5e1); cursor: pointer; font-size: 14px; font-weight: 500;">
            See Login Options
          </button>
          <button id="continueLocal" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: var(--md-sys-color-primary, #818cf8); color: var(--md-sys-color-on-primary, #1e1b4b); cursor: pointer; font-size: 14px; font-weight: 500;">
            Continue with Local Bookmarks
          </button>
        </div>
      `;

      document.body.appendChild(modal);
      modal.appendChild(dialog);

      dialog.querySelector('#continueLocal').addEventListener('click', () => {
        modal.remove();
        resolve(true);
      });

      dialog.querySelector('#showLoginOptions').addEventListener('click', () => {
        modal.remove();
        resolve(false);
      });

      // Allow clicking outside to dismiss and show login options
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
          resolve(false);
        }
      });
    });
  }

  /**
   * Show toast notification
   */
  /* [ZeroLabs] 2026-09-13 - edited: optional duration, for notices that need reading */
  // The three-second default suits "Saved" and "Synced". A published notice is a
  // sentence or two and needs longer on screen, so callers can ask for it.
  showToast(message, type = 'info', duration = 3000) {
    // Full toast system available in error-notification-manager.js and sidebar-adapted.js
    console.log(`[Toast ${type}]:`, message);

    // For now, create a simple toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      background: var(--md-sys-color-surface-variant);
      color: var(--md-sys-color-on-surface-variant);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, duration);
  }

  /* [ZeroLabs] 2026-09-13 - added: published notices, shown once as a toast */
  // notices.json on the website is the message source. Publishing is editing the
  // file and pushing; the site sends no-store on .json so the edit is live at
  // once. Each entry has a numeric id that only ever goes up. The client keeps
  // the highest id it has shown and toasts everything above it, so rewording or
  // deleting an old entry never re-notifies anyone. Only a new, higher id fires.
  //
  // A toast auto-dismisses, so the same notice is also written to the Event Log
  // as a notice entry. Without that, one shown while the user was not looking
  // is gone for good.
  //
  // Silent on every failure. A missing or malformed file must never disturb the
  // app; it simply tries again on the next open.
  /* [ZeroLabs] 2026-09-13 - added: a published notice is a dialog, not a toast */
  // A corner toast that vanishes in seconds is the wrong shape for an update
  // message someone is meant to read. This is centred, sized to be read, and
  // stays until the X or Escape is pressed. The backdrop does NOT close it: a
// stray tap, easy on a phone, must not dismiss a message before it was read.
  // It resolves when closed, so several notices arrive one after another.
  /* [ZeroLabs] 2026-09-23 4:40 PM - added: bullets in a notice become a real list */
  // A notice is plain text in a JSON file, and it used to render as one block
  // with white-space: pre-line. That was fine for paragraphs and wrong for a
  // list: the second and later lines of a long bullet wrapped back to the left
  // margin, under the bullet character instead of under the text, which on a
  // phone turned a tidy list into a slab.
  //
  // A line that begins with a bullet character now becomes a real <li>, so the
  // browser does the hanging indent. Everything else stays a paragraph. Still
  // textContent on every node, never innerHTML: the text comes from a file on
  // the web and must never be able to inject markup.
  //
  // The accepted markers are the bullet, the hyphen and the asterisk, so a
  // notice can be written with whichever is convenient. The pattern lives
  // inside the method because a class body cannot hold a bare const.
  renderNoticeText(container, text) {
    const bulletPattern = /^[•\-*]\s+/;
    const lines = String(text).split('\n');
    let list = null;

    const closeList = () => {
      list = null;
    };

    lines.forEach(line => {
      const trimmed = line.trim();

      // A blank line only separates blocks. The margins below do the spacing.
      if (trimmed === '') {
        closeList();
        return;
      }

      if (bulletPattern.test(trimmed)) {
        if (!list) {
          list = document.createElement('ul');
          list.style.cssText = 'margin: 0 0 12px 0; padding-left: 22px;';
          container.appendChild(list);
        }
        const item = document.createElement('li');
        item.textContent = trimmed.replace(bulletPattern, '');
        item.style.cssText = 'margin-bottom: 8px; line-height: 1.5;';
        list.appendChild(item);
        return;
      }

      closeList();
      const paragraph = document.createElement('p');
      paragraph.textContent = trimmed;
      paragraph.style.cssText = 'margin: 0 0 12px 0;';
      container.appendChild(paragraph);
    });

    // The last block does not need the gap under it
    const last = container.lastElementChild;
    if (last) last.style.marginBottom = '0';
  }

  /* [ZeroLabs] 2026-09-23 4:05 PM - edited: one dialog, never a queue of them */
  // It used to open one dialog per unseen notice, one after another. That is
  // fine for somebody who missed one message, and awful for a new install:
  // with seventeen entries in the file, a first run meant seventeen dialogs to
  // close.
  //
  // Now the NEWEST unseen notice is the dialog, and every older notice for this
  // client sits behind one collapsed row that opens in place, whether or not it
  // was seen before, so somebody curious can read back through what changed.
  //
  // `notice.date` is optional and is only a heading. An entry without one still
  // renders, so the entries already published do not have to be rewritten.
  showNoticeDialog(notice, earlier = []) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(3px); z-index: 10003; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;';

      const panel = document.createElement('div');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-labelledby', 'bmzNoticeTitle');
      panel.style.cssText = 'position: relative; background: var(--md-sys-color-surface, #1e1e1e); color: var(--md-sys-color-on-surface, #e0e0e0); border: 1px solid var(--md-sys-color-outline, #444); border-radius: 16px; padding: 28px 28px 20px 28px; width: 100%; max-width: 560px; max-height: 85vh; overflow-y: auto; box-shadow: 0 12px 40px rgba(0,0,0,0.45); box-sizing: border-box;';
  
      const close = document.createElement('button');
      close.setAttribute('aria-label', 'Close');
      close.textContent = '\u00d7';
      close.style.cssText = 'position: absolute; top: 10px; right: 12px; width: 36px; height: 36px; border: none; background: transparent; color: var(--md-sys-color-on-surface-variant, #aaa); font-size: 26px; line-height: 1; cursor: pointer; border-radius: 8px;';
  
      const title = document.createElement('h2');
      title.id = 'bmzNoticeTitle';
      title.textContent = 'A message from BMZ';
      title.style.cssText = 'margin: 0 32px 14px 0; font-size: 18px; font-weight: 600; color: var(--md-sys-color-primary, #90caf9);';
  
      const body = document.createElement('div');
      body.style.cssText = 'font-size: 15px; line-height: 1.6; word-break: break-word;';
      this.renderNoticeText(body, notice.text);

      panel.appendChild(close);
      panel.appendChild(title);

      if (notice.date) {
        const stamp = document.createElement('div');
        stamp.textContent = notice.date;
        stamp.style.cssText = 'margin-bottom: 10px; font-size: 12px; color: var(--md-sys-color-on-surface-variant, #aaa);';
        panel.appendChild(stamp);
      }

      panel.appendChild(body);

      /* [ZeroLabs] 2026-09-23 4:05 PM - added: every older notice, collapsed */
      // This is the whole archive for this client, not only the unseen ones, so
      // somebody curious about what changed before can read back through it. It
      // is drawn whenever anything older exists, and only a file holding a
      // single notice leaves it out.
      if (earlier.length > 0) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.style.cssText = 'display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 18px; padding: 10px 12px; background: var(--md-sys-color-surface-variant, #2a2a2a); color: var(--md-sys-color-on-surface, #e0e0e0); border: 1px solid var(--md-sys-color-outline-variant, #333); border-radius: 10px; font-size: 13px; font-weight: 500; cursor: pointer; text-align: left;';

        const caret = document.createElement('span');
        caret.textContent = '▶';
        caret.style.cssText = 'font-size: 10px; transition: transform 0.15s ease;';

        const label = document.createElement('span');
        const plural = earlier.length === 1 ? 'update' : 'updates';
        label.textContent = `${earlier.length} earlier ${plural}`;

        toggle.appendChild(caret);
        toggle.appendChild(label);

        const history = document.createElement('div');
        history.hidden = true;
        history.style.cssText = 'margin-top: 10px;';

        earlier.forEach((older, index) => {
          const entry = document.createElement('div');
          entry.style.cssText = index === 0
            ? 'padding-top: 4px;'
            : 'margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--md-sys-color-outline-variant, #333);';

          if (older.date) {
            const olderStamp = document.createElement('div');
            olderStamp.textContent = older.date;
            olderStamp.style.cssText = 'margin-bottom: 6px; font-size: 12px; font-weight: 600; color: var(--md-sys-color-on-surface-variant, #aaa);';
            entry.appendChild(olderStamp);
          }

          const olderBody = document.createElement('div');
          olderBody.style.cssText = 'font-size: 14px; line-height: 1.55; word-break: break-word; color: var(--md-sys-color-on-surface-variant, #ccc);';
          this.renderNoticeText(olderBody, older.text);
          entry.appendChild(olderBody);

          history.appendChild(entry);
        });

        toggle.addEventListener('click', () => {
          const opening = history.hidden;
          history.hidden = !opening;
          toggle.setAttribute('aria-expanded', String(opening));
          caret.style.transform = opening ? 'rotate(90deg)' : '';
        });

        panel.appendChild(toggle);
        panel.appendChild(history);
      }

      const foot = document.createElement('div');
      foot.textContent = 'You can read this again at any time in the Event Log.';
      foot.style.cssText = 'margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--md-sys-color-outline-variant, #333); font-size: 12px; color: var(--md-sys-color-on-surface-variant, #aaa);';

      panel.appendChild(foot);
      overlay.appendChild(panel);
  
      const finish = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve();
      };
      const onKey = (event) => {
        if (event.key === 'Escape') finish();
      };
  
      close.addEventListener('click', finish);
      document.addEventListener('keydown', onKey);
  
      document.body.appendChild(overlay);
      close.focus();
    });
  }

  async checkNotices() {
    if (window.__bmzShareMode) return;

    let notices;
    try {
      const response = await fetch('https://bmzweb.absolutezero.fyi/notices.json', { cache: 'no-store' });
      if (!response.ok) return;
      notices = await response.json();
    } catch (error) {
      return;
    }
    if (!Array.isArray(notices)) return;

    const seenId = Number(safeLocalStorage.getItem('bmz_notices_seen_id')) || 0;

    /* [ZeroLabs] 2026-09-24 1:05 AM - edited: one list of what this client may show, used twice */
    // The headline and the collapsed history used to repeat the same filters,
    // and a filter added to one and not the other would let them disagree.
    const forThisClient = notices
      /* [ZeroLabs] 2026-09-24 1:35 AM - edited: read `message`, fall back to `text` */
      .map(noticeWithBody)
      .filter(notice => notice !== null)
      /* [ZeroLabs] 2026-09-13 - added: a draft stays in the file and goes nowhere */
      // JSON has no comments, and a stray // would invalidate the whole file and
      // silence every notice. This is how the template entry, and any notice
      // written ahead of time, sits in the file without being sent.
      .filter(notice => notice.draft !== true)
      /* [ZeroLabs] 2026-09-13 - added: only notices addressed to this client */
      // A website or Android fix is not news to an extension user, and a Web Store
      // update is not news to the website. Each entry names its targets; one with
      // no targets field goes to everyone. The Android app is the website in a WebView and counts as website.
      .filter(notice => {
        if (!Array.isArray(notice.targets)) return true;
        return notice.targets.includes('website');
      })
      /* [ZeroLabs] 2026-09-24 1:05 AM - added: never announce a version this copy does not run */
      // An entry with a `version` waits until this copy runs that version or
      // newer, and is not marked seen while it waits. The website updates the
      // moment it is deployed, but a browser can keep an older copy cached, and
      // the rule is the same in all three clients.
      .filter(notice => noticeFitsVersion(notice, window.bmzAppVersion));

    const unseen = forThisClient
      .filter(notice => Number(notice.id) > seenId)
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (unseen.length === 0) return;

    /* [ZeroLabs] 2026-09-23 4:05 PM - edited: one dialog holding the newest, with the rest behind it */
    // Was a loop opening one dialog per unseen notice. A new install starting
    // at id 0 therefore had to close one dialog per entry in the file, which
    // does not scale: seventeen entries meant seventeen dialogs.
    //
    // The newest unseen notice is now the message, and EVERY older notice for
    // this client sits behind a collapsed row, whether or not it was seen
    // before. That keeps the dialog to one for everybody and still lets
    // somebody curious read back through what changed.
    const newest = unseen[unseen.length - 1];

    const earlier = forThisClient
      .filter(item => Number(item.id) < Number(newest.id))
      .sort((a, b) => Number(b.id) - Number(a.id));

    await this.showNoticeDialog(newest, earlier);

    /* [ZeroLabs] 2026-09-23 4:05 PM - edited: record on close, as before */
    // Everything unseen goes to the Event Log, including the entries the user
    // never expanded, so choosing not to read the history loses nothing. The
    // stored id moves only after the dialog is CLOSED, so a dialog abandoned by
    // closing the page comes back next time and is written once, not twice.
    for (const item of unseen) {
      await addChangelogEntry('notice', 'notice', item.text, null, {});
    }
    safeLocalStorage.setItem('bmz_notices_seen_id', String(newest.id));
  }

  /**
   * Show sync changes notification (for additions/modifications)
   */
  showSyncChangesNotification(diff, message) {
    const totalChanges = diff.added.length + diff.moved.length + diff.modified.length;

    // Create enhanced toast with "View Changes" button
    const toast = document.createElement('div');
    toast.className = 'toast toast-sync';
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 16px 20px;
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      min-width: 300px;
      animation: slideIn 0.3s ease;
    `;

    toast.innerHTML = `
      <div style="margin-bottom: 8px; font-weight: 500;">
        Bookmarks Updated from Snippet
      </div>
      <div style="font-size: 0.9em; margin-bottom: 12px; opacity: 0.9;">
        ${diff.added.length} added, ${diff.moved.length} moved, ${diff.modified.length} modified
      </div>
      <button id="viewSyncChanges" style="
        background: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary);
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9em;
      ">View Changes</button>
    `;

    document.body.appendChild(toast);

    // Add click handler for view changes button
    document.getElementById('viewSyncChanges')?.addEventListener('click', () => {
      this.showSyncDiffModal(diff);
      toast.remove();
    });

    // Auto-remove after 5 seconds
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 5000);
  }

  /* [ZeroLabs] 2026-06-20 11:01 AM - removed: orphaned mergeBookmarkTrees (per-sync merge) */

  /* [ZeroLabs] 2026-08-27 - added: the consent dialog (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
  // A deferral has three possible shapes and they can occur together: bookmarks
  // you deleted here that the snippet still holds, bookmarks the snippet no
  // longer holds that are still here because another device deleted them, and
  // renames or moves made elsewhere that would overwrite what is here. All three
  // change something rather than only adding, which is the whole reason the sync
  // stopped and asked.
  /* [ZeroLabs] 2026-09-08 2:20 AM - edited: never return silently on a click */
  // fromUser is true when a person pressed Review changes. This guard used to
  // return with no dialog and no message, so a card standing on a stale flag gave
  // them a button that appeared broken.
  //
  // The website cannot reach that state as easily as the extensions could, since
  // it has no background worker and every setter of the flag here writes the held
  // lists first. It is still wrong to swallow a click.
  async showHeldPushDialog(fromUser = false) {
    const state = await syncManager.getHeldState();
    if (!state.held) {
      if (fromUser) {
        this.showToast('Nothing is waiting for your approval.');
        await syncManager.setSnippetNeedsReconcile(false);
      }
      return;
    }

    const { fromSnippet, fromDevice, overwrites, addedHere, pendingPush } = state;
    /* [ZeroLabs] 2026-08-27 - added: account for the safe additions as well */
    // Already applied by the time this opens - but bookmarks appearing while a
    // modal asks about something else is unexplained unless the modal says so.
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    /* [ZeroLabs] 2026-08-27 - added: a count you cannot inspect is half an answer */
    // Stated rather than asked about, so collapsed by default - but the bookmarks
    // are nameable and the user should be able to see which ones.
    let noteId = 0;
    const collapsibleNote = (sentence, items, colour) => {
      const id = `syncNote${noteId++}`;
      const rows = items.slice(0, 50).map(item => `
        <div style="padding:4px 8px;font-size:12px;color:#aaa;">
          ${esc(item.title || item.url || 'Untitled')}
          ${item.path ? `<span style="color:#777;"> — ${esc(item.path)}</span>` : ''}
        </div>`).join('');
      const more = items.length > 50
        ? `<div style="padding:4px 8px;font-size:12px;color:#777;">...and ${items.length - 50} more</div>` : '';
      return `
        <div style="margin:0 0 12px 0;">
          <button type="button" id="${id}Toggle" aria-expanded="false" style="display:flex;align-items:center;gap:6px;width:100%;padding:0;background:none;border:none;color:${colour};font-size:14px;text-align:left;cursor:pointer;font-family:inherit;">
            <span>${sentence}</span>
            <svg id="${id}Chevron" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;margin-right:auto;transition:transform 0.2s ease;transform:rotate(-90deg);"><path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>
          </button>
          <div id="${id}List" style="display:none;margin-top:6px;border-left:2px solid ${colour};padding-left:6px;">${rows}${more}</div>
        </div>`;
    };
    if (fromSnippet.length === 0 && fromDevice.length === 0 && overwrites.length === 0) return;

    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:560px;width:90%;max-height:80%;overflow-y:auto;color:var(--md-sys-color-on-surface,#e0e0e0);';
    dialog.className = 'bmz-dialog';

    const renderList = (items) => {
      let out = '';
      items.slice(0, 50).forEach(item => {
        out += `<div style="padding:8px;margin-bottom:4px;background:rgba(244,67,54,0.1);border-left:3px solid #f44336;border-radius:4px;">
          <div style="font-weight:500;">${esc(item.title || 'Untitled')}</div>
          <div style="font-size:11px;color:#888;margin-top:4px;">${esc(item.url || '')}</div>
        </div>`;
      });
      if (items.length > 50) {
        out += `<div style="font-size:12px;color:#aaa;padding:8px;">...and ${items.length - 50} more</div>`;
      }
      return out;
    };

    let body = '';
    if (addedHere.length > 0) {
      body += collapsibleNote(
        `Already added ${plural(addedHere.length, 'bookmark', 'bookmarks')} to this device.`,
        addedHere, '#4caf50');
    }
    // Approve pushes, so this device's own additions travel as part of it
    if (pendingPush.length > 0) {
      body += collapsibleNote(
        `Add ${plural(pendingPush.length, 'bookmark', 'bookmarks')} from this device to the cloud.`,
        pendingPush, 'var(--md-sys-color-on-surface, #e0e0e0)');
    }
    if (fromSnippet.length > 0) {
      body += `<p style="margin:0 0 12px 0;font-size:14px;">
        Remove ${fromSnippet.length} bookmark${fromSnippet.length === 1 ? '' : 's'} from your snippet to match this device.
      </p>
      <div style="margin-bottom:20px;">${renderList(fromSnippet)}</div>`;
    }
    if (fromDevice.length > 0) {
      body += `<p style="margin:0 0 12px 0;font-size:14px;">
        Remove ${fromDevice.length} bookmark${fromDevice.length === 1 ? '' : 's'} from this device to match the cloud.
      </p>
      <div style="margin-bottom:20px;">${renderList(fromDevice)}</div>`;
    }

    // Shown with both versions, because the choice is between two names rather
    // than between keeping and losing something.
    if (overwrites.length > 0) {
      body += `<p style="margin:0 0 12px 0;font-size:14px;">
        Rename or move ${overwrites.length} bookmark${overwrites.length === 1 ? '' : 's'} on this device to match the cloud.
      </p>`;
      let list = '';
      overwrites.slice(0, 50).forEach(item => {
        const renamed = item.title !== item.remoteTitle;
        const relocated = item.localPath !== item.remotePath;
        list += `<div style="padding:8px;margin-bottom:4px;background:rgba(255,152,0,0.1);border-left:3px solid #ff9800;border-radius:4px;">
          <div style="font-weight:500;">${esc(item.title || 'Untitled')}</div>
          ${renamed ? `<div style="font-size:12px;color:#aaa;">Name: ${esc(item.title)} → ${esc(item.remoteTitle)}</div>` : ''}
          ${relocated ? `<div style="font-size:12px;color:#aaa;">Folder: ${esc(item.localPath)} → ${esc(item.remotePath)}</div>` : ''}
          <div style="font-size:11px;color:#888;margin-top:4px;">${esc(item.url || '')}</div>
        </div>`;
      });
      if (overwrites.length > 50) {
        list += `<div style="font-size:12px;color:#aaa;padding:8px;">...and ${overwrites.length - 50} more</div>`;
      }
      body += `<div style="margin-bottom:20px;">${list}</div>`;
    }

    dialog.innerHTML = `
      <h2 style="margin:0 0 12px 0;font-size:18px;color:#ff9800;text-align:center;">Sync changes to review</h2>
      <p style="margin: 0 0 16px 0; font-size: 14px;">
        Syncing would:
      </p>
      ${body}
      <div style="display:flex;flex-direction:column;gap:12px;">
        <button id="heldPushConfirm" style="width:100%;padding:12px;border-radius:8px;border:none;background:#f59e0b;color:#1a1a1a;cursor:pointer;font-size:14px;font-weight:600;">
          Approve
        </button>
        <button id="heldPushLater" style="width:100%;padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);cursor:pointer;font-size:14px;">
          Cancel
        </button>
      </div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    /* [ZeroLabs] 2026-08-27 - added: expand the collapsed notes */
    dialog.querySelectorAll('[id$="Toggle"]').forEach(toggle => {
      const base = toggle.id.replace(/Toggle$/, '');
      const list = dialog.querySelector(`#${base}List`);
      const chevron = dialog.querySelector(`#${base}Chevron`);
      if (!list) return;
      toggle.addEventListener('click', () => {
        const open = list.style.display !== 'none';
        list.style.display = open ? 'none' : 'block';
        toggle.setAttribute('aria-expanded', String(!open));
        if (chevron) chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
      });
    });

    /* [ZeroLabs] 2026-09-22 6:54 PM - added: the apply runs in view, not behind a closed modal */
    // The dialog used to close on click and the work ran with no indicator at
    // all. An approved folder rename can carry thousands of bookmarks. The
    // dialog stays open and becomes the progress surface, which also stops a
    // second click starting the same work twice.
    const startApplyProgress = () => {
      dialog.innerHTML = `
        <h2 style="margin:0 0 16px 0;font-size:18px;color:#ff9800;text-align:center;">Applying sync changes</h2>
        <p id="heldApplyCount" style="margin:0 0 6px 0;font-size:14px;font-weight:600;"></p>
        <p id="heldApplyPhase" style="margin:0 0 16px 0;font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);"></p>
        <div style="height:8px;border-radius:999px;background:var(--md-sys-color-surface-variant,#2a2a2a);overflow:hidden;">
          <div id="heldApplyBar" style="width:0%;height:100%;background:#f59e0b;transition:width 0.15s linear;"></div>
        </div>
      `;
      const countLine = dialog.querySelector('#heldApplyCount');
      const phaseLine = dialog.querySelector('#heldApplyPhase');
      const bar = dialog.querySelector('#heldApplyBar');

      return (done, total, phase) => {
        countLine.textContent = total > 0 ? `${done} of ${total}` : 'Finishing';
        phaseLine.textContent = phase;
        bar.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '100%';
      };
    };

    dialog.querySelector('#heldPushConfirm').addEventListener('click', async () => {
      const setProgress = startApplyProgress();
      const totalOps = fromDevice.length + overwrites.length;
      setProgress(0, totalOps, 'Preparing the approved changes.');

      try {
        // Applying the local side first is what makes the push carry the other
        // device's deletion and the other device's rename.
        if (fromDevice.length > 0 || overwrites.length > 0) {
          await syncManager.applyHeldResolution({
            fromDevice,
            overwrites,
            /* [ZeroLabs] 2026-09-22 6:54 PM - added: the apply drives the bar */
            onProgress: (done, total, phase) => setProgress(done, total, phase)
          });
          await bookmarkManager.reload();
          if (window.reloadBookmarkUI) await window.reloadBookmarkUI();
        }

        setProgress(totalOps, totalOps, 'Saving to your cloud bookmarks.');
        await syncManager.pushLocalToSnippet();
        modal.remove();
        /* [ZeroLabs] 2026-08-27 - edited: one result, not the push's pair */
        this.showToast('Sync approved and applied.', 'success');
      } catch (error) {
        console.error('[HeldPush] Approval failed:', error);
        /* [ZeroLabs] 2026-09-22 6:54 PM - edited: the modal must not outlive a throw */
        modal.remove();
        this.showToast(`Sync failed: ${error.message}`, 'error');
      }
    });
    dialog.querySelector('#heldPushLater').addEventListener('click', () => modal.remove());
  }

  /**
   * Show sync conflict dialog (for deletions - requires confirmation)
   */
  async showSyncConflictDialog(diff, remoteData, message) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10001;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--md-sys-color-surface);
      color: var(--md-sys-color-on-surface);
      border-radius: 12px;
      padding: 24px;
      max-width: 600px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    `;

    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0; color: var(--md-sys-color-error);">
        ⚠️ Sync Conflict Detected
      </h2>
      <p style="margin-bottom: 16px;">
        The remote snippet has <strong>${diff.removed.length} deletion(s)</strong> that will remove bookmarks from your local collection.
      </p>
      <p style="margin-bottom: 16px; opacity: 0.8;">
        Review the changes below before deciding to sync:
      </p>
      <div id="diffContainer" style="
        background: var(--md-sys-color-surface-variant);
        padding: 16px;
        border-radius: 8px;
        max-height: 300px;
        overflow-y: auto;
        margin-bottom: 20px;
      "></div>
      <div style="display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;">
        <button id="cancelSync" style="
          background: var(--md-sys-color-surface-variant);
          color: var(--md-sys-color-on-surface-variant);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
        ">Cancel</button>
        <button id="keepLocal" style="
          background: var(--md-sys-color-secondary-container);
          color: var(--md-sys-color-on-secondary-container);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
          min-width: auto;
        ">Keep Local</button>
        <button id="replaceLocal" style="
          background: var(--md-sys-color-error);
          color: var(--md-sys-color-on-error);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
          font-weight: 500;
          min-width: auto;
        ">Use This Store</button>
        <button id="viewFullDiff" style="
          background: var(--md-sys-color-secondary-container);
          color: var(--md-sys-color-on-secondary-container);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
        ">View Full Changes</button>
      </div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Populate diff summary (show deletions prominently)
    const diffContainer = dialog.querySelector('#diffContainer');
    this.renderDiffSummary(diffContainer, diff, true); // true = show deletions first

    // Button handlers
    dialog.querySelector('#cancelSync').addEventListener('click', () => {
      modal.remove();
    });

    dialog.querySelector('#viewFullDiff').addEventListener('click', () => {
      this.showSyncDiffModal(diff);
    });

    dialog.querySelector('#keepLocal').addEventListener('click', () => {
      modal.remove();
      this.showToast('Local bookmarks kept. Remote changes were not applied.', 'info');
    });

    /* [ZeroLabs] 2026-06-20 11:01 AM - removed: per-sync merge button handler */
    dialog.querySelector('#replaceLocal').addEventListener('click', async () => {
      modal.remove();
      try {
        const success = await syncManager.applyRemoteSync(remoteData);
        if (success) {
          this.showToast('Bookmarks replaced with the cloud copy', 'success');
          window.location.reload();
        }
      } catch (error) {
        console.error('Replace failed:', error);
        this.showToast('Replace failed: ' + error.message, 'error');
      }
    });
  }

  /**
   * Show full sync diff modal
   */
  showSyncDiffModal(diff) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10001;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--md-sys-color-surface);
      color: var(--md-sys-color-on-surface);
      border-radius: 12px;
      padding: 24px;
      max-width: 800px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    `;

    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0;">Sync Changes</h2>
      <div id="fullDiffContainer"></div>
      <div style="margin-top: 20px; text-align: right;">
        <button id="closeDiff" style="
          background: var(--md-sys-color-primary);
          color: var(--md-sys-color-on-primary);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
        ">Close</button>
      </div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Populate full diff
    const diffContainer = dialog.querySelector('#fullDiffContainer');
    this.renderFullDiff(diffContainer, diff);

    // Close button
    dialog.querySelector('#closeDiff').addEventListener('click', () => {
      modal.remove();
    });
  }

  /**
   * Render diff summary (brief overview)
   */
  renderDiffSummary(container, diff, showDeletionsFirst = false) {
    let html = '';

    const sections = showDeletionsFirst
      ? [
          { title: '🗑️ Removed', items: diff.removed, color: 'var(--md-sys-color-error)' },
          { title: '➕ Added', items: diff.added, color: 'var(--md-sys-color-tertiary)' },
          { title: '📦 Moved', items: diff.moved, color: 'var(--md-sys-color-secondary)' },
          { title: '✏️ Modified', items: diff.modified, color: 'var(--md-sys-color-primary)' }
        ]
      : [
          { title: '➕ Added', items: diff.added, color: 'var(--md-sys-color-tertiary)' },
          { title: '🗑️ Removed', items: diff.removed, color: 'var(--md-sys-color-error)' },
          { title: '📦 Moved', items: diff.moved, color: 'var(--md-sys-color-secondary)' },
          { title: '✏️ Modified', items: diff.modified, color: 'var(--md-sys-color-primary)' }
        ];

    sections.forEach(section => {
      if (section.items.length > 0) {
        html += `
          <div style="margin-bottom: 16px;">
            <h4 style="margin: 0 0 8px 0; color: ${section.color};">
              ${section.title} (${section.items.length})
            </h4>
            <ul style="margin: 0; padding-left: 20px; font-size: 0.9em;">
              ${section.items.slice(0, 5).map(item => `
                <li style="margin-bottom: 4px;">
                  ${item.title}${item.url ? ` <span style="opacity: 0.6;">(${item.url})</span>` : ''}
                  ${item.path ? `<br><span style="opacity: 0.6; font-size: 0.85em;">📁 ${item.path}</span>` : ''}
                </li>
              `).join('')}
              ${section.items.length > 5 ? `<li style="opacity: 0.6;">... and ${section.items.length - 5} more</li>` : ''}
            </ul>
          </div>
        `;
      }
    });

    container.innerHTML = html || '<p style="opacity: 0.6;">No changes to display</p>';
  }

  /**
   * Render full diff (detailed view)
   */
  renderFullDiff(container, diff) {
    this.renderDiffSummary(container, diff, false);
    // The summary already shows first 5 of each type, full diff just doesn't limit
  }

  /**
   * Show main application after authentication
   */
  async showMainApp() {
    // Hide login screen
    const loginScreen = document.getElementById('loginScreen');
    if (loginScreen) {
      loginScreen.classList.add('hidden');
    }

    // Show main content
    const mainContent = document.getElementById('mainContent');
    if (mainContent) {
      mainContent.classList.remove('hidden');
    }

    // Remove show-login class from html element
    document.documentElement.classList.remove('show-login');

    // Initialize bookmark manager
    await bookmarkManager.init();

    // Initialize sync manager
    await syncManager.init();

    // Skip snippet setup and remote sync if in local mode
    const logoutBtn = document.getElementById('logoutBtn');
    const localModeRecord = await dbManager.get('settings', 'bmz_local_mode');
    const isLocalMode = localModeRecord && localModeRecord.value === true;

    if (!isLocalMode) {
      // Show logout button and manual sync button in GitLab mode
      if (logoutBtn) {
        logoutBtn.style.display = 'flex';
      } else {
        console.error('[App] Logout button element not found!');
      }

      const manualSyncBtn = document.getElementById('manualSyncBtn');
      if (manualSyncBtn) {
        manualSyncBtn.style.display = '';
      }

      const gitlabSyncSettingsBtn = document.getElementById('gitlabSyncSettingsBtn');
      if (gitlabSyncSettingsBtn) gitlabSyncSettingsBtn.style.display = '';

      /* [ZeroLabs] 2026-09-24 2:10 AM - added: hide the connect icon when connected */
      // The local-mode branch below shows it, and this branch never hid it
      // again. After a page load that did not matter, because it starts hidden.
      // Logging in without a reload does not start fresh, so both the connect
      // icon and the sync icon showed at once.
      const headerConnectGitlabBtn = document.getElementById('headerConnectGitlabBtn');
      if (headerConnectGitlabBtn) headerConnectGitlabBtn.style.display = 'none';

      // Check if we have a snippet set up
      const hasSnippet = await this.checkSnippetSetup();

      if (!hasSnippet) {
        // Show snippet setup modal (buttons should already work from initUI)
        await this.showSnippetSetup();
        /* [ZeroLabs] 2026-08-27 - added: this path ends here, so reveal the page */
        document.documentElement.classList.add('booted');
        return;
      }

      /* [ZeroLabs] 2026-08-27 - edited: reconcile on open instead of skipping (see also: Bookmark-Manager-Zero-Chrome/background.js) */
      // This used to skip syncing entirely whenever local bookmarks already
      // existed, which is almost always, so the site effectively never pulled.
      // The reconcile is safe to run unconditionally: it adds what is missing on
      // either side and defers rather than removing anything.
      /* [ZeroLabs] 2026-08-29 - added: the share window runs its own reconcile */
      // This reconcile and runSharePull call the same reconcileWithSnippet, so
      // the share window did the identical network round trip twice - once here
      // before the modal could appear, once after. On mobile that was most of
      // the three to five seconds between tapping share and seeing the folder
      // tree, and the result of this one is never read: saveSharedBookmark
      // waits on runSharePull's promise and blocks on ITS conflict, not this.
      //
      // Worse, this one can push. runSharePull deliberately passes push: false
      // because stage 3 publishes after the bookmark is saved, so leaving this
      // in wrote to GitLab twice for a single share.
      //
      // Nothing is lost by skipping it. A deletion waiting on either side still
      // stops the save and is shown inline with an Approve button.
      /* [ZeroLabs] 2026-09-02 6:31 PM - edited: reconcile AFTER the page is drawn */
      // This used to be awaited right here, before initSidebar, so the boot
      // loader covered a full GitLab round trip before a single bookmark
      // appeared. Nothing about the list depends on it: the local copy is
      // already on disk and is what the list draws from.
      //
      // It is stored and started once the page is revealed instead. Anything it
      // pulls in redraws through the existing sync:localTreeChanged listener,
      // so a late arrival still lands on screen. Additions apply silently, and
      // anything that would remove or overwrite still stops and waits for you.
      this._startupReconcile = async () => {
        if (this._syncInProgress || window.__bmzShareMode) return;
        this._syncInProgress = true;
        console.log('[App] Reconciling with snippet...');
        try {
          // An unresolved deferral outranks a fresh check: the two describe the
          // same divergence from opposite ends and would stack on open.
          const held = await syncManager.getHeldState();
          if (held.held) {
            await syncManager.setSnippetNeedsReconcile(true);
            console.log('[App] A previous sync is waiting for consent');
          } else if (await syncManager.isAutoSyncEnabled()) {
            const outcome = await syncManager.reconcileWithSnippet();
            await bookmarkManager.reload();
            if (outcome.deferred) {
              console.log('[App] Reconcile deferred for consent');
            }
          }
          console.log('[App] Reconcile complete');
        } catch (error) {
          console.warn('[App] Reconcile failed, will use cached data:', error);
        } finally {
          this._syncInProgress = false;
        }
      };

      /* [ZeroLabs] 2026-08-27 - added: keep checking while the page is open */
      // Not in the Android share window. That is a transient floating window
      // that pulls once, saves, and closes; a five-minute reconcile firing
      // underneath it could pull bookmarks in and move the folder the picker is
      // pointing at, or raise a deferral the window has no room to show. It runs
      // its own pull in runSharePull instead. setSnippetId carries the same guard.
      if (!window.__bmzShareMode) {
        syncManager.startReconcilePoll();
      }
    } else {
      console.log('[App] Local mode - skipping remote sync');

      // Hide logout button and manual sync button in local mode
      if (logoutBtn) {
        logoutBtn.style.display = 'none';
        console.log('[App] Logout button hidden for local mode');
      }

      const manualSyncBtn = document.getElementById('manualSyncBtn');
      if (manualSyncBtn) {
        manualSyncBtn.style.display = 'none';
        console.log('[App] Manual sync button hidden for local mode');
      }

      const gitlabSyncSettingsBtnLocal = document.getElementById('gitlabSyncSettingsBtn');
      if (gitlabSyncSettingsBtnLocal) gitlabSyncSettingsBtnLocal.style.display = 'none';

      // Show Connect GitLab button in header for local mode users
      const headerConnectGitlabBtn = document.getElementById('headerConnectGitlabBtn');
      console.log('[App] headerConnectGitlabBtn exists:', !!headerConnectGitlabBtn);
      if (headerConnectGitlabBtn) {
        headerConnectGitlabBtn.style.display = 'flex';
        console.log('[App] Connect GitLab button display set to flex');
        headerConnectGitlabBtn.addEventListener('click', () => {
          this.showConnectGitlabModal();
        });
      } else {
        console.error('[App] headerConnectGitlabBtn element not found!');
      }
    }

    // Check token rotation after sync (non-blocking — don't delay app startup)
    if (!isLocalMode) {
      this.checkAndRotateIfNeeded();
    }

    // Initialize sidebar FIRST - loads bookmarks, settings, and prepares UI
    // Prevent duplicate initialization
    if (window.initSidebar && !this._sidebarInitialized) {
      await window.initSidebar();
      this._sidebarInitialized = true;
    }

    /* [ZeroLabs] 2026-08-27 - added: reveal only once bookmarks are on screen */
    // Marked here rather than at the top of this method. initSidebar awaits
    // loadBookmarks and then renders, so anything earlier uncovered a main panel
    // whose list was still empty - which draws its "No bookmarks found" state for
    // a moment before the real bookmarks replace it. One flash traded for another.
    document.documentElement.classList.add('booted');

    /* [ZeroLabs] 2026-09-02 6:31 PM - added: start the reconcile once the page is up */
    // Deliberately not awaited. Your bookmarks are on screen by this line, so
    // the sync runs behind them rather than in front of them.
    if (this._startupReconcile) {
      const runStartupReconcile = this._startupReconcile;
      this._startupReconcile = null;
      runStartupReconcile();
    }

    // blocklistService and scannerService are initialized on first use (lazy loading)

    /* [ZeroLabs] 2026-08-27 - added: surface an outstanding deferral once the UI is up */
    // A card at the top of the list rather than a dialog that opens by itself.
    // setSnippetNeedsReconcile is what puts it there, so this only has to assert
    // the state; it waits for the sidebar because the card is rendered by it.
    // The share window is a small floating window with no bookmark list, and it
    // presents the same divergence inline already.
    if (!isLocalMode && !window.__bmzShareMode) {
      try {
        const held = await syncManager.getHeldState();
        if (held.held) await syncManager.setSnippetNeedsReconcile(true);
      } catch (error) {
        console.error('[App] Could not check for a held sync:', error);
      }
    }

    /* [ZeroLabs] 2026-08-09 1:31 PM - added: open prefilled modal for share intent */
    if (this.shareIntent && !this._shareHandled && window.openShareBookmarkModal) {
      this._shareHandled = true;

      // Drop the fragment so a reload does not re-trigger the share
      history.replaceState(null, '', window.location.pathname + window.location.search);

      await window.openShareBookmarkModal(this.shareIntent.url, this.shareIntent.title);
    }

    /* [ZeroLabs] 2026-09-13 - added: look for published notices once the app is up */
    // Not awaited. It fetches, and toasts whenever that lands. Nothing about the
    // page depends on it, and a slow network must not hold the app.
    this.checkNotices().catch(() => {});
  }

  async showPreRotationPrompt(daysLeft, token) {
    const isSupabase = await supabaseManager.getTokenMode() === 'supabase';
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:420px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);">
        <h2 style="margin:0 0 12px 0;font-size:18px;">GitLab Token Expiring Soon</h2>
        <p style="font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);margin:0 0 16px 0;">Your GitLab Personal Access Token expires in <strong style="color:var(--md-sys-color-on-surface,#e0e0e0);">${Math.floor(daysLeft)} day${Math.floor(daysLeft) !== 1 ? 's' : ''}</strong>. BMZ can renew it automatically right now.</p>
        <div style="padding:10px 12px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;font-size:12px;color:var(--md-sys-color-on-surface-variant,#aaa);margin-bottom:16px;">
          ${isSupabase 
            ? 'Renewing creates a new token stored in Supabase. All your devices will pick it up automatically on their next sync.'
            : 'Renewing creates a new token. If you use BMZ on other devices, you will need to enter the new token on each one to maintain sync.'}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button id="rotateNowBtn" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:14px;cursor:pointer;font-weight:500;">Renew Token Now</button>
          <button id="snoozeDayBtn" style="padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface-variant,#aaa);font-size:14px;cursor:pointer;">Remind me tomorrow</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cleanup = () => {
      modal.remove();
      supabaseManager._rotationPromptActive = false;
    };

    modal.querySelector('#rotateNowBtn').addEventListener('click', async () => {
      try {
        const rotated = await supabaseManager.rotateToken(token);
        cleanup();
        if (isSupabase) {
          await supabaseManager.saveGitLabToken(rotated.token, rotated.expires_at);
        }
        await authManager.storeToken(rotated.token, null, 'gitlab');
        this.showPostRotationModal(rotated.token, isSupabase ? 'supabase' : 'local');
      } catch (e) {
        this.showToast(e.message, 'error');
      }
    });

    modal.querySelector('#snoozeDayBtn').addEventListener('click', async () => {
      await supabaseManager.snoozeRotation();
      cleanup();
    });

    modal.addEventListener('click', async (e) => {
      if (e.target === modal) {
        await supabaseManager.snoozeRotation();
        cleanup();
      }
    });
  }

  showPostRotationModal(newToken, mode = 'local') {
    const isSupabase = mode === 'supabase';
    const actionBox = isSupabase
      ? `<div style="padding:12px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:12px;margin-bottom:12px;">
           Your other BMZ devices will pick up the new token automatically on their next sync.
         </div>`
      : `<div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.35);border-radius:8px;font-size:12px;margin-bottom:12px;">
           Your old token is now invalid. If you use BMZ on other devices, update the token on each one.
         </div>`;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--md-sys-color-surface,#1e1e1e);padding:24px;border-radius:12px;max-width:480px;width:90%;color:var(--md-sys-color-on-surface,#e0e0e0);">
        <h2 style="margin:0 0 12px 0;font-size:18px;">Token Renewed Successfully</h2>
        <p style="font-size:13px;color:var(--md-sys-color-on-surface-variant,#aaa);margin:0 0 8px 0;">Your new GitLab token is shown below. <strong style="color:var(--md-sys-color-error,#ef4444);">Copy it now</strong> if needed — GitLab will never show this token again.</p>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
          <input type="text" readonly id="rotatedTokenDisplay" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--md-sys-color-outline,#444);background:var(--md-sys-color-surface-variant,#2a2a2a);color:var(--md-sys-color-on-surface,#e0e0e0);font-size:12px;font-family:monospace;box-sizing:border-box;">
          <button id="copyRotatedToken" style="padding:10px 14px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:13px;cursor:pointer;white-space:nowrap;">Copy</button>
        </div>
        ${actionBox}
        <button id="closeRotationModal" style="width:100%;padding:12px;border-radius:8px;border:none;background:var(--md-sys-color-primary,#818cf8);color:var(--md-sys-color-on-primary,#fff);font-size:14px;cursor:pointer;font-weight:500;">Done</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#rotatedTokenDisplay').value = newToken;
    modal.querySelector('#copyRotatedToken').addEventListener('click', () => {
      navigator.clipboard.writeText(newToken).then(() => {
        const btn = modal.querySelector('#copyRotatedToken');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    });
    modal.querySelector('#rotatedTokenDisplay').addEventListener('click', (e) => e.target.select());
    modal.querySelector('#closeRotationModal').addEventListener('click', () => modal.remove());
  }

  /**
   * Show error message
   */
  showError(title, error) {
    /* [ZeroLabs] 2026-08-27 - added: a failure must not leave the loader up */
    document.documentElement.classList.add('booted');
    const message = error?.message || error || 'Unknown error';
    this.showToast(`${title}: ${message}`, 'error');
    console.error(title, error);
  }
}

// Initialize app when DOM is ready
const app = new App();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    app.init();
  });
} else {
  app.init();
}

// Export for debugging and global access
window.app = app;
window.bookmarkManager = bookmarkManager;
window.syncManager = syncManager;
window.blocklistService = blocklistService;
window.scannerService = scannerService;
export default app;
