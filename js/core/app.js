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
import bookmarkManager from './bookmarks.js';
import blocklistService from './blocklist-service.js';
import uiManager from './ui.js';
import scannerService from './scanner.js';
import { exportAsHTML } from '../import-export/html-exporter.js';
import { exportAsJSON } from '../import-export/json-exporter.js';
import { importFromHTML } from '../import-export/html-parser.js';
import { importFromJSON } from '../import-export/json-parser.js';
import touchHandler from '../mobile/touch-handler.js';
import { addChangelogEntry, clearChangelog } from '../utils/storage-utils.js';

class App {
  constructor() {
    this.currentTheme = 'enhanced-blue';
    this.isAuthenticated = false;
    this.isInitialized = false;
    this.currentUser = null;

  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      console.log('Initializing Bookmark Manager Zero Web...');

      // Initialize IndexedDB first (needed for everything)
      await dbManager.init();

      // Load theme early for visual consistency
      await this.loadTheme();

      // Set up global event listeners and touch handler FIRST
      // This ensures UI is responsive while auth/loading happens
      this.setupEventListeners();
      this.setupSyncListeners();
      touchHandler.init();
      console.log('Touch handler initialized');

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
   * Clean up corrupted localStorage and IndexedDB data
   */
  async cleanupLocalStorage() {
    try {
      // Clean localStorage
      const savedSnippetId = localStorage.getItem('bmz_snippet_id');
      if (savedSnippetId) {
        // Check if it's an object instead of a string
        if (savedSnippetId.startsWith('{') || savedSnippetId.startsWith('[')) {
          console.warn('Found corrupted snippet ID in localStorage, clearing...');
          localStorage.removeItem('bmz_snippet_id');
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
  async checkAuth() {
    // Hide both login and main content during auth check
    const loginScreen = document.getElementById('loginScreen');
    const mainContent = document.getElementById('mainContent');

    if (loginScreen) {
      loginScreen.classList.add('hidden');
    }
    if (mainContent) {
      mainContent.classList.add('hidden');
    }

    // Check if user has explicitly chosen a mode (use IndexedDB as source of truth)
    const modeChosenRecord = await dbManager.get('settings', 'bmz_mode_chosen');
    const hasChosenMode = modeChosenRecord && modeChosenRecord.value === true;

    const localModeRecord = await dbManager.get('settings', 'bmz_local_mode');
    const isLocalMode = localModeRecord && localModeRecord.value === true;

    console.log('[Auth] Checking mode on page load:');
    console.log('[Auth] bmz_mode_chosen (IndexedDB):', hasChosenMode);
    console.log('[Auth] bmz_local_mode (IndexedDB):', isLocalMode);

    // If user hasn't chosen a mode, check for local bookmarks first
    if (!hasChosenMode) {
      console.log('[Auth] User has not chosen a mode yet');

      // Check if there are existing local bookmarks
      const bookmarkTree = await dbManager.get('metadata', 'bookmarkTree');
      const hasLocalBookmarks = bookmarkTree && bookmarkTree.value && bookmarkTree.value.roots;

      if (hasLocalBookmarks) {
        // Found local bookmarks - prompt user before loading
        console.log('[Auth] Found local bookmarks, prompting user...');

        const shouldContinue = await this.showContinueWithLocalBookmarksDialog();

        if (shouldContinue) {
          // User chose to continue with local bookmarks
          console.log('[Auth] User chose to continue with local bookmarks');

          // Set local mode flags
          await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          localStorage.setItem('bmz_local_mode', 'true');
          localStorage.setItem('bmz_mode_chosen', 'true');

          this.isAuthenticated = true;
          await this.showMainApp();

          // Show friendly toast notification
          this.showToast('Continuing with local bookmarks. You can connect GitLab anytime for cloud sync.', 'success');
          return;
        } else {
          // User chose to see login options
          console.log('[Auth] User chose to see login options');
          this.showLoginScreen();
          return;
        }
      } else {
        // No bookmarks found, show login screen for first-time setup
        console.log('[Auth] No existing bookmarks found, showing login screen');
        this.showLoginScreen();
        return;
      }
    }

    // User is in local mode or GitLab mode
    console.log('[Auth] Mode chosen, isLocalMode:', isLocalMode);

    if (isLocalMode) {
      console.log('[Auth] Local mode detected');
      // Check if there are bookmarks in local storage
      const bookmarkTree = await dbManager.get('metadata', 'bookmarkTree');
      const hasBookmarks = bookmarkTree && bookmarkTree.value && bookmarkTree.value.roots;
      if (hasBookmarks) {
        console.log('[Auth] Found local bookmarks, loading app...');
        this.isAuthenticated = true;
        await this.showMainApp();
        return;
      } else {
        // No bookmarks found, show login to import
        console.log('[Auth] No local bookmarks found');
        this.showLoginScreen();
        return;
      }
    }

    // Check for GitLab token
    const provider = 'gitlab';
    const token = await authManager.getToken(provider);

    if (token) {
      console.log('[Auth] Found saved token, verifying...');
      // Verify token is valid by fetching user info
      try {
        const response = await fetch('https://gitlab.com/api/v4/user', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (response.ok) {
          this.currentUser = await response.json();
          this.isAuthenticated = true;

          console.log('[Auth] Token valid, user:', this.currentUser.username);

          // Set the provider in oauthPAT so it's available
          oauthPAT.provider = provider;
          oauthPAT.token = token;
          oauthPAT.user = this.currentUser;

          await this.showMainApp();
        } else {
          // Token invalid, clear it
          console.log('[Auth] Token invalid, clearing...');
          await authManager.clearToken(provider);
          this.showLoginScreen();
        }
      } catch (error) {
        console.error('[Auth] Auth check failed:', error);
        this.showLoginScreen();
      }
    } else {
      // No token found, show login
      console.log('[Auth] No saved token found');
      this.showLoginScreen();
    }
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

          const text = await file.text();
          let bookmarks;

          if (file.name.endsWith('.json')) {
            bookmarks = await importFromJSON(text);
          } else if (file.name.endsWith('.html')) {
            bookmarks = await importFromHTML(text);
          } else {
            throw new Error('Unsupported file format. Please use .html or .json files.');
          }

          // Store bookmarks in local storage
          await bookmarkManager.replaceTree(bookmarks);

          // Store a flag indicating local mode (IndexedDB is source of truth, localStorage is cache)
          await authManager.storePreference('syncProvider', 'local');
          await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          localStorage.setItem('bmz_local_mode', 'true');
          localStorage.setItem('bmz_mode_chosen', 'true');

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
          localStorage.setItem('bmz_local_mode', 'true');
          localStorage.setItem('bmz_mode_chosen', 'true');

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
        // Confirm with user before clearing everything
        const confirmed = confirm(
          'Start Fresh will delete all existing bookmarks and create an empty bookmark list.\n\n' +
          'This action cannot be undone. Any bookmarks you have will be permanently deleted.\n\n' +
          'Are you sure you want to continue?'
        );

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
          localStorage.setItem('bmz_local_mode', 'true');
          localStorage.setItem('bmz_mode_chosen', 'true');

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
            // Reset button state
            loginBtnGitlab.disabled = false;
            loginBtnGitlab.textContent = 'Login with GitLab';
            return;
          }

          console.log(`Authenticated with GitLab:`, authResult.user.username);

          // Store token securely
          await authManager.storeToken(authResult.access_token, null, 'gitlab');

          // Store provider preference
          await authManager.storePreference('syncProvider', 'gitlab');

          // Mark that user has chosen GitLab mode (don't set local mode flag)
          await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
          localStorage.setItem('bmz_mode_chosen', 'true');
          localStorage.removeItem('bmz_local_mode'); // Clear local mode flag

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
      oauthPAT.clear();

      // Clear app authentication state
      this.isAuthenticated = false;
      this.currentUser = null;

      // Clear provider preference and set to local
      await authManager.storePreference('syncProvider', 'local');

      // Clear snippet ID from localStorage, IndexedDB, and adapter
      localStorage.removeItem('bmz_snippet_id');
      await dbManager.delete('metadata', 'snippetId');
      snippetAdapter.snippetId = null;

      // Clear sync manager state
      syncManager.snippetId = null;
      syncManager.provider = null;

      // Set local mode flags (IndexedDB is source of truth, localStorage is cache)
      await dbManager.put('settings', { key: 'bmz_local_mode', value: true });
      await dbManager.put('settings', { key: 'bmz_mode_chosen', value: true });
      localStorage.setItem('bmz_local_mode', 'true');
      localStorage.setItem('bmz_mode_chosen', 'true');

      console.log('[Logout] Set local mode flags');

      // Keep settings (like theme, API keys) but clear auth-related data
      // Settings are user preferences, not user data

      console.log('Logout complete, reloading page...');

      // Use setTimeout with longer delay to ensure all IndexedDB operations complete
      // IndexedDB commits are asynchronous even after await returns
      // Force reload to bypass cache and ensure clean state
      setTimeout(() => {
        window.location.href = window.location.href.split('?')[0];
      }, 500);
    } catch (error) {
      console.error('Logout failed:', error);
      // Even if there's an error, try to reload after a delay
      setTimeout(() => {
        window.location.href = window.location.href.split('?')[0];
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
      oauthPAT.clear();

      // Clear all mode flags from both IndexedDB and localStorage
      await dbManager.delete('settings', 'bmz_mode_chosen');
      await dbManager.delete('settings', 'bmz_local_mode');
      await dbManager.delete('settings', 'syncProvider');
      localStorage.removeItem('bmz_mode_chosen');
      localStorage.removeItem('bmz_local_mode');
      localStorage.removeItem('bmz_snippet_id');

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
          localStorage.removeItem(key);
        }
      }

      console.log('[Reset] All data cleared, reloading to login screen...');

      // Reload page to show login screen
      setTimeout(() => {
        window.location.href = window.location.href.split('?')[0];
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
        } else if (userChoice === 'merge') {
          // Create snippet with merged local bookmarks
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
        localStorage.removeItem('bmz_snippet_id');
      }
    }

    // No valid saved ID found
    return false;
  }

  /**
   * Show snippet setup modal (GitLab only)
   */
  async showSnippetSetup() {
    const modal = document.getElementById('snippetSetupModal');
    const noSnippetsSection = document.getElementById('noSnippetsSection');
    const existingSnippetSection = document.getElementById('existingSnippetSection');
    const multipleSnippetsSection = document.getElementById('multipleSnippetsSection');
    const existingSnippetInfo = document.getElementById('existingSnippetInfo');
    const gistList = document.getElementById('snippetList');

    // Only GitLab is supported
    const provider = 'gitlab';
    const adapter = snippetAdapter;
    const itemName = 'Snippet';

    console.log(`Setting up ${itemName} for provider: ${provider}`);

    // Hide all sections first
    noSnippetsSection.style.display = 'none';
    existingSnippetSection.style.display = 'none';
    multipleSnippetsSection.style.display = 'none';

    try {
      // FIRST check if we have a saved snippet ID in localStorage
      const savedId = localStorage.getItem('bmz_snippet_id');

      if (savedId) {
        console.log(`[SnippetSetup] Found saved ${itemName} ID in localStorage:`, savedId);
        // Try to use the saved ID directly
        try {
          await this.useRemoteStorage(savedId, provider);
          modal.style.display = 'none';
          modal.classList.add('hidden');
          return; // Success! Don't show the setup modal
        } catch (err) {
          console.warn(`[SnippetSetup] Saved ${itemName} ID is invalid:`, err);
          // Clear the invalid ID and continue to show setup options
          localStorage.removeItem('bmz_snippet_id');
        }
      }

      // Get all remote snippets
      const items = await adapter.getAllSnippets();

      console.log(`[SnippetSetup] Found ${items.length} total ${itemName}s`);

      // Filter for bookmark-like items
      const bookmarkItems = items.filter(item => {
        // GitLab snippet filtering
        return item.title?.includes('BMZ') ||
               item.title?.includes('Bookmark Manager Zero') ||
               item.file_name === 'bookmarks.json';
      });

      console.log(`[SnippetSetup] Found ${bookmarkItems.length} bookmark ${itemName}s`);

      if (bookmarkItems.length === 0) {
        // No items found - show create option
        noSnippetsSection.style.display = 'block';
        // Update button text
        const createBtn = document.getElementById('createNewSnippetBtn');
        if (createBtn) createBtn.textContent = `Create New ${itemName}`;
      } else if (bookmarkItems.length === 1) {
        // One item found - show use or create new
        existingSnippetSection.style.display = 'block';
        const item = bookmarkItems[0];

        // Format snippet info
        const fileCount = item.files?.length || 1;
        const lastUpdated = new Date(item.updated_at).toLocaleDateString();
        const description = item.title || 'Untitled Snippet';

        existingSnippetInfo.textContent = `${description} • ${fileCount} files • Updated ${lastUpdated}`;

        // Store item for use button
        document.getElementById('useExistingSnippetBtn').onclick = async () => {
          await this.useRemoteStorage(item.id, provider);
        };

        // Update button texts
        const useBtn = document.getElementById('useExistingSnippetBtn');
        const createBtn2 = document.getElementById('createNewSnippetBtn2');
        if (useBtn) useBtn.textContent = `Use This ${itemName}`;
        if (createBtn2) createBtn2.textContent = `Create New ${itemName}`;
      } else {
        // Multiple items - show selection
        multipleSnippetsSection.style.display = 'block';
        const snippetList = document.getElementById('snippetList');
        snippetList.innerHTML = '';

        bookmarkItems.forEach(item => {
          const fileCount = item.files?.length || 1;
          const lastUpdated = new Date(item.updated_at).toLocaleDateString();
          const description = item.title || 'Untitled Snippet';

          const itemDiv = document.createElement('div');
          itemDiv.style.cssText = 'background: var(--md-sys-color-surface-variant); padding: 16px; border-radius: 8px; margin-bottom: 8px; cursor: pointer; border: 2px solid transparent;';
          itemDiv.innerHTML = `
            <div style="font-weight: 500; margin-bottom: 4px;">${description}</div>
            <div style="font-size: 12px; color: var(--md-sys-color-on-surface-variant);">${fileCount} files • Updated ${lastUpdated}</div>
          `;

          itemDiv.onclick = async () => {
            await this.useRemoteStorage(item.id, provider);
          };

          itemDiv.onmouseover = () => {
            itemDiv.style.borderColor = 'var(--md-sys-color-primary)';
          };
          itemDiv.onmouseout = () => {
            itemDiv.style.borderColor = 'transparent';
          };

          snippetList.appendChild(itemDiv);
        });

        // Update create button text
        const createBtn3 = document.getElementById('createNewSnippetBtn3');
        if (createBtn3) createBtn3.textContent = `Create New ${itemName}`;
      }

      // Setup create new buttons
      const createButtons = [
        document.getElementById('createNewSnippetBtn'),
        document.getElementById('createNewSnippetBtn2'),
        document.getElementById('createNewSnippetBtn3')
      ];

      createButtons.forEach(btn => {
        if (btn) {
          btn.onclick = async () => {
            await this.createNewRemoteStorage(provider);
          };
        }
      });

      // Setup logout button in snippet setup modal
      const snippetSetupLogoutBtn = document.getElementById('snippetSetupLogoutBtn');
      if (snippetSetupLogoutBtn) {
        snippetSetupLogoutBtn.onclick = async () => {
          // Close the modal first
          modal.classList.add('hidden');
          modal.style.display = 'none';
          // Logout
          await this.logout();
        };
      }

      // Show modal
      modal.style.display = 'flex';
      modal.classList.remove('hidden');

    } catch (error) {
      console.error(`Failed to load ${itemName}s:`, error);
      this.showSnippetSetupError(`Failed to load ${itemName}s: ` + error.message);
    }
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
        // Show merge confirmation dialog
        const userChoice = await this.showMergeConfirmationDialog(itemId, 'existing');
        if (userChoice === 'keep-local') {
          // User wants to keep local bookmarks, cancel setup
          console.log('[UseRemoteStorage] User chose to keep local bookmarks, canceling setup');
          return; // Exit without using snippet
        } else if (userChoice === 'merge') {
          // Merge local bookmarks into the snippet
          await this.mergeLocalBookmarksIntoSnippet(itemId);
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
  async createNewRemoteStorage(provider = 'gitlab') {
    try {
      // Check if we have local bookmarks that need to be merged
      const hasLocalBookmarks = await this.hasLocalBookmarks();
      console.log(`[Createsnippet] Has local bookmarks: ${hasLocalBookmarks}`);

      let itemId;
      if (hasLocalBookmarks) {
        // Show merge confirmation dialog
        const shouldMerge = await this.showMergeConfirmationDialog(null, 'new');
        if (shouldMerge) {
          // Create snippet with merged local bookmarks
          itemId = await this.createSnippetWithLocalBookmarks();
        } else {
          // Create empty snippet (original behavior)
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
   * Check if user has local bookmarks
   */
  async hasLocalBookmarks() {
    try {
      const localBookmarks = await dbManager.getAll('bookmarks');
      if (localBookmarks && localBookmarks.length > 0) {
        // Count actual bookmarks (not just folders)
        let bookmarkCount = 0;
        const countBookmarks = (nodes) => {
          nodes.forEach(node => {
            if (node.url) {
              bookmarkCount++;
            }
            if (node.children) {
              countBookmarks(node.children);
            }
          });
        };
        countBookmarks(localBookmarks);
        return bookmarkCount > 0;
      }
      return false;
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
        <p>You're about to replace your local bookmarks with the snippet data. Would you like to download a backup of your current bookmarks first?</p>
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
            <div style="font-weight: 500;">Replace with Snippet</div>
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

      // Get local bookmarks
      const localBookmarks = await dbManager.getAll('bookmarks');
      console.log('[createSnippetWithLocalBookmarks] Retrieved local bookmarks:', localBookmarks?.length || 0);

      // Get empty bookmark tree structure
      const emptyTree = syncManager.getEmptyBookmarkTree();

      // Merge local bookmarks into the empty tree
      const mergedTree = this.mergeBookmarksIntoTree(localBookmarks, emptyTree);
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

      // Get local bookmarks
      const localBookmarks = await dbManager.getAll('bookmarks');
      console.log('[mergeLocalBookmarksIntoSnippet] Retrieved local bookmarks:', localBookmarks?.length || 0);

      // Merge local bookmarks into snippet data
      const mergedTree = this.mergeBookmarksIntoTree(localBookmarks, snippetData);
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
   * Merge bookmarks from one tree into another tree
   * Preserves folder structure and merges into existing folders with same names
   */
  mergeBookmarksIntoTree(sourceBookmarks, targetTree) {
    try {
      console.log('[mergeBookmarksIntoTree] Merging bookmarks with folder structure preservation...');

      // Create a deep copy of the target tree
      const mergedTree = JSON.parse(JSON.stringify(targetTree));

      // Ensure target tree has roots
      if (!mergedTree.roots) {
        mergedTree.roots = {
          bookmark_bar: { id: '1', title: 'Bookmarks Toolbar', type: 'folder', children: [] },
          menu: { id: '2', title: 'Bookmarks Menu', type: 'folder', children: [] },
          other: { id: '3', title: 'Other Bookmarks', type: 'folder', children: [] },
          mobile: { id: '4', title: 'Mobile Bookmarks', type: 'folder', children: [] }
        };
      }

      // Helper function to find folder by title in a root folder
      const findFolderByTitle = (children, title) => {
        if (!children) return null;
        return children.find(child => child.type === 'folder' && child.title === title);
      };

      // Helper function to merge source folder into target folder
      const mergeFolder = (sourceFolder, targetParentChildren) => {
        const existingFolder = findFolderByTitle(targetParentChildren, sourceFolder.title);

        if (existingFolder) {
          // Folder exists, merge contents
          console.log(`[mergeBookmarksIntoTree] Merging into existing folder: ${sourceFolder.title}`);
          if (sourceFolder.children) {
            // Recursively merge each child
            sourceFolder.children.forEach(child => {
              if (child.type === 'folder') {
                mergeFolder(child, existingFolder.children);
              } else if (child.url) {
                // Add bookmark if it doesn't already exist (by URL)
                const bookmarkExists = existingFolder.children?.some(existingChild =>
                  existingChild.url === child.url
                );
                if (!bookmarkExists) {
                  if (!existingFolder.children) existingFolder.children = [];
                  existingFolder.children.push({
                    ...child,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // New ID
                    dateAdded: Date.now()
                  });
                  console.log(`[mergeBookmarksIntoTree] Added bookmark: ${child.title}`);
                } else {
                  console.log(`[mergeBookmarksIntoTree] Skipped duplicate bookmark: ${child.title}`);
                }
              }
            });
          }
        } else {
          // Folder doesn't exist, add entire folder structure
          console.log(`[mergeBookmarksIntoTree] Adding new folder: ${sourceFolder.title}`);
          const newFolder = {
            ...sourceFolder,
            id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // New ID
            dateAdded: Date.now()
          };
          targetParentChildren.push(newFolder);
        }
      };

      // Process each root folder from source bookmarks
      if (sourceBookmarks && Array.isArray(sourceBookmarks)) {
        // Group source bookmarks by their root folder type
        const sourceRoots = {
          bookmark_bar: [],
          menu: [],
          other: [],
          mobile: []
        };

        // Categorize source bookmarks into appropriate root folders
        sourceBookmarks.forEach(bookmark => {
          if (bookmark.type === 'folder') {
            // Determine which root this folder should go into
            // Default to 'other' if we can't determine
            let targetRoot = 'other';

            // Simple heuristic: check if folder title suggests toolbar/menu placement
            const title = bookmark.title?.toLowerCase() || '';
            if (title.includes('toolbar') || title.includes('bar')) {
              targetRoot = 'bookmark_bar';
            } else if (title.includes('menu')) {
              targetRoot = 'menu';
            }

            sourceRoots[targetRoot].push(bookmark);
          } else if (bookmark.url) {
            // Individual bookmarks go to 'other' by default
            sourceRoots.other.push(bookmark);
          }
        });

        // Merge each categorized group into the corresponding target root
        Object.keys(sourceRoots).forEach(rootKey => {
          const sourceItems = sourceRoots[rootKey];
          const targetRoot = mergedTree.roots[rootKey];

          if (sourceItems.length > 0 && targetRoot && targetRoot.children) {
            sourceItems.forEach(item => {
              if (item.type === 'folder') {
                mergeFolder(item, targetRoot.children);
              } else if (item.url) {
                // Add individual bookmarks, avoiding duplicates
                const bookmarkExists = targetRoot.children.some(existingChild =>
                  existingChild.url === item.url
                );
                if (!bookmarkExists) {
                  targetRoot.children.push({
                    ...item,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // New ID
                    dateAdded: Date.now()
                  });
                  console.log(`[mergeBookmarksIntoTree] Added individual bookmark to ${rootKey}: ${item.title}`);
                } else {
                  console.log(`[mergeBookmarksIntoTree] Skipped duplicate bookmark in ${rootKey}: ${item.title}`);
                }
              }
            });
          }
        });
      }

      console.log('[mergeBookmarksIntoTree] Merge complete with folder structure preservation');
      return mergedTree;
    } catch (error) {
      console.error('[mergeBookmarksIntoTree] Error:', error);
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

    // Cancel button - close modal
    cancelBtn.onclick = () => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    };

    // Handle Enter key in token input
    tokenInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        confirmBtn.click();
      }
    });

    // Confirm button - authenticate and migrate
    confirmBtn.onclick = async () => {
      const token = tokenInput.value.trim();

      if (!token) {
        if (errorDiv) {
          errorDiv.textContent = 'Please enter your Personal Access Token';
          errorDiv.style.display = 'block';
        }
        return;
      }

      try {
        // Show loading state
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Connecting...';
        if (errorDiv) errorDiv.style.display = 'none';

        // Authenticate with token
        const authResult = await oauthPAT.authenticate(token, async () => {
          // Retry callback - clear error and re-trigger connection
          if (errorDiv) errorDiv.style.display = 'none';
          confirmBtn.click();
        });

        if (authResult === null) {
          // Popup was shown, authentication failed but user can retry
          // Reset button state
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Connect GitLab';
          return;
        }

        console.log(`Authenticated with GitLab:`, authResult.user.username);

        // Store token securely
        await authManager.storeToken(authResult.access_token, null, 'gitlab');

        // Store provider preference
        await authManager.storePreference('syncProvider', 'gitlab');

        // Set the provider in oauthPAT
        oauthPAT.provider = 'gitlab';
        oauthPAT.token = authResult.access_token;
        oauthPAT.user = authResult.user;

        this.currentUser = authResult.user;
        this.isAuthenticated = true;

        // Clear local mode flag - user is now in GitLab mode
        localStorage.removeItem('bmz_local_mode');
        await dbManager.put('settings', { key: 'bmz_local_mode', value: false });

        // Update button visibility to show logout and manual sync buttons
        const logoutBtn = document.getElementById('logoutBtn');
        const manualSyncBtn = document.getElementById('manualSyncBtn');
        const headerConnectGitlabBtn = document.getElementById('headerConnectGitlabBtn');

        if (logoutBtn) logoutBtn.style.display = 'flex';
        if (manualSyncBtn) manualSyncBtn.style.display = '';
        if (headerConnectGitlabBtn) headerConnectGitlabBtn.style.display = 'none';

        // Close modal
        modal.classList.add('hidden');
        modal.style.display = 'none';

        // Show success message
        this.showToast('GitLab connected successfully! Your bookmarks will now sync to the cloud.', 'success');

        // Initialize sync manager and create/use snippet
        await syncManager.init();

        // Check for existing snippet or create new one
        const hasSnippet = await this.checkSnippetSetup();

        if (!hasSnippet) {
          // Show snippet setup to let user create or select snippet
          await this.showSnippetSetup();
        } else {
          // Sync local bookmarks to GitLab
          console.log('[App] Syncing local bookmarks to GitLab...');
          await syncManager.syncToRemote();
          this.showToast('Local bookmarks synced to GitLab successfully!', 'success');
        }

        // Hide Connect GitLab button now that we're in GitLab mode
        const connectGitlabBtn = document.getElementById('connectGitlabBtn');
        if (connectGitlabBtn) {
          connectGitlabBtn.style.display = 'none';
        }

      } catch (error) {
        console.error('GitLab connection failed:', error);
        if (errorDiv) {
          errorDiv.textContent = error.message || 'Authentication failed. Please check your token and try again.';
          errorDiv.style.display = 'block';
        }

        // Reset button
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Connect GitLab';
      }
    };
  }

  /**
   * Load bookmarks from snippet or local storage
   */
  async loadBookmarks() {
    try {
      console.log('[App] Starting bookmark load...');

      // First, try to sync from remote
      const updated = await syncManager.syncFromRemote();
      console.log('[App] Sync from remote completed, updated:', updated);

      // Reload bookmark manager to get latest data
      await bookmarkManager.reload();
      console.log('[App] Bookmark manager reloaded');

      // If bookmarks were updated from remote, trigger automatic scan
      if (updated && scannerService) {
        console.log('[App] Bookmarks loaded from remote, triggering automatic scan...');
        // Use setTimeout to avoid blocking the UI
        setTimeout(() => {
          scannerService.scanAllBookmarks(false).catch(err => {
            console.error('[App] Auto-scan failed:', err);
          });
        }, 500);
      }
    } catch (error) {
      console.error('Failed to load bookmarks:', error);
      // Try to reload with local data anyway
      try {
        await bookmarkManager.reload();
      } catch (reloadError) {
        console.error('Failed to reload bookmarks:', reloadError);
      }
    }
  }

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
          const tree = bookmarkManager.getTree();
          uiManager.renderBookmarks(tree);
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

    // Show sync diff dialog with merge/push/pull options
    this.showSyncDiffDialog = async (diff, remoteData) => {
      const modal = document.createElement('div');
      modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px;';

      const dialog = document.createElement('div');
      dialog.style.cssText = 'background: var(--md-sys-color-surface, #1e1e1e); padding: 24px; border-radius: 12px; max-width: 700px; width: 100%; max-height: 80%; overflow-y: auto; color: var(--md-sys-color-on-surface, #e0e0e0);';

      const hasChanges = diff.added.length + diff.removed.length + diff.moved.length + diff.modified.length > 0;

      let content = '<h2 style="margin: 0 0 16px 0; font-size: 20px;">Snippet Sync Changes</h2>';

      if (!hasChanges) {
        content += '<p style="color: var(--md-sys-color-on-surface-variant, #aaa);">No changes detected. Your local bookmarks match the Snippet.</p>';
      } else {
        // Summary
        content += '<div style="margin-bottom: 20px; padding: 16px; background: var(--md-sys-color-surface-variant, #2a2a2a); border-radius: 8px;">';
        content += '<h3 style="margin: 0 0 12px 0; font-size: 16px;">Summary</h3>';
        if (diff.added.length > 0) content += `<div style="margin-bottom: 4px; color: #4caf50;">✓ ${diff.added.length} item(s) to add</div>`;
        if (diff.removed.length > 0) content += `<div style="margin-bottom: 4px; color: #f44336;">✗ ${diff.removed.length} item(s) to remove</div>`;
        if (diff.moved.length > 0) content += `<div style="margin-bottom: 4px; color: #ff9800;">➜ ${diff.moved.length} item(s) to move</div>`;
        if (diff.modified.length > 0) content += `<div style="color: #2196f3;">✎ ${diff.modified.length} item(s) to modify</div>`;
        content += '</div>';

        // Detailed changes (collapsed for mobile)
        if (diff.added.length > 0) {
          content += '<details style="margin-bottom: 12px;"><summary style="cursor: pointer; font-weight: 600; color: #4caf50; margin-bottom: 8px;">Added Items</summary>';
          diff.added.forEach(item => {
            content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(76, 175, 80, 0.1); border-left: 3px solid #4caf50; border-radius: 4px;">
              <div style="font-weight: 500;">${item.title || 'Untitled'}</div>
              <div style="font-size: 12px; color: #aaa;">${item.path}</div>
              ${item.url ? `<div style="font-size: 11px; color: #888; margin-top: 4px; word-break: break-all;">${item.url}</div>` : ''}
            </div>`;
          });
          content += '</details>';
        }

        if (diff.removed.length > 0) {
          content += '<details style="margin-bottom: 12px;"><summary style="cursor: pointer; font-weight: 600; color: #f44336; margin-bottom: 8px;">Removed Items</summary>';
          diff.removed.forEach(item => {
            content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(244, 67, 54, 0.1); border-left: 3px solid #f44336; border-radius: 4px;">
              <div style="font-weight: 500;">${item.title || 'Untitled'}</div>
              <div style="font-size: 12px; color: #aaa;">${item.path}</div>
              ${item.url ? `<div style="font-size: 11px; color: #888; margin-top: 4px; word-break: break-all;">${item.url}</div>` : ''}
            </div>`;
          });
          content += '</details>';
        }

        if (diff.moved.length > 0) {
          content += '<details style="margin-bottom: 12px;"><summary style="cursor: pointer; font-weight: 600; color: #ff9800; margin-bottom: 8px;">Moved Items</summary>';
          diff.moved.forEach(item => {
            content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(255, 152, 0, 0.1); border-left: 3px solid #ff9800; border-radius: 4px;">
              <div style="font-weight: 500;">${item.title || 'Untitled'}</div>
              <div style="font-size: 12px; color: #aaa;">From: ${item.from}</div>
              <div style="font-size: 12px; color: #aaa;">To: ${item.to}</div>
            </div>`;
          });
          content += '</details>';
        }

        if (diff.modified.length > 0) {
          content += '<details style="margin-bottom: 12px;"><summary style="cursor: pointer; font-weight: 600; color: #2196f3; margin-bottom: 8px;">Modified Items</summary>';
          diff.modified.forEach(item => {
            content += `<div style="padding: 8px; margin-bottom: 4px; background: rgba(33, 150, 243, 0.1); border-left: 3px solid #2196f3; border-radius: 4px;">
              <div style="font-weight: 500;">${item.oldTitle || 'Untitled'} → ${item.newTitle || 'Untitled'}</div>
              <div style="font-size: 12px; color: #aaa;">${item.path}</div>
              ${item.oldUrl !== item.newUrl ? `<div style="font-size: 11px; color: #888; margin-top: 4px; word-break: break-all;">URL: ${item.oldUrl} → ${item.newUrl}</div>` : ''}
            </div>`;
          });
          content += '</details>';
        }
      }

      content += `
        <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 20px;">
          ${hasChanges ? `
            <button id="mergeButton" style="width: 100%; padding: 12px; border-radius: 8px; border: none; background: #4caf50; color: #fff; cursor: pointer; font-size: 14px; font-weight: 600;">
              Merge (Recommended)
            </button>
            <div style="display: flex; gap: 12px;">
              <button id="pushLocalToRemote" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: #90caf9; color: #000; cursor: pointer; font-size: 14px;">
                Push Local to Remote
              </button>
              <button id="applyRemoteChanges" style="flex: 1; padding: 12px; border-radius: 8px; border: none; background: #f44336; color: #fff; cursor: pointer; font-size: 14px;">
                Pull Remote to Local
              </button>
            </div>
          ` : ''}
          <button id="closeDiffDialog" style="width: 100%; padding: 12px; border-radius: 8px; border: none; background: #2a2a2a; color: #aaa; cursor: pointer; font-size: 14px;">
            Cancel
          </button>
        </div>
      `;

      dialog.innerHTML = content;
      modal.appendChild(dialog);
      document.body.appendChild(modal);

      const mergeBtn = dialog.querySelector('#mergeButton');
      if (mergeBtn) {
        mergeBtn.addEventListener('click', async () => {
          modal.remove();
          await this.mergeBidirectional();
        });
      }

      const pushBtn = dialog.querySelector('#pushLocalToRemote');
      if (pushBtn) {
        pushBtn.addEventListener('click', async () => {
          modal.remove();
          await syncManager.syncToRemote();
          this.showToast('Pushed local bookmarks to remote successfully', 'success');
        });
      }

      const applyBtn = dialog.querySelector('#applyRemoteChanges');
      if (applyBtn) {
        applyBtn.addEventListener('click', async () => {
          modal.remove();

          // STEP 1: Take a snapshot of current bookmarks before destructive sync
          const preSyncSnapshot = await syncManager.getLocalBookmarks();

          // STEP 2: Clear all old changelog entries (they will have invalid IDs after sync)
          await clearChangelog();

          // STEP 3: Add a special changelog entry for this sync operation with full snapshot
          await addChangelogEntry('pre-sync-snapshot', 'sync', 'Pull Remote to Local', null, {
            snapshot: preSyncSnapshot,
            timestamp: Date.now(),
            operation: 'Pull Remote to Local'
          });

          await syncManager.saveLocalBookmarks(remoteData);
          await syncManager.setLocalVersion(remoteData.version);
          this.showToast('Pulled remote bookmarks to local successfully', 'success');
          // Reload bookmarks in UI
          await this.loadBookmarks();
        });
      }

      dialog.querySelector('#closeDiffDialog').addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });
    };

    // Bidirectional merge function
    this.mergeBidirectional = async () => {
      try {
        this.showToast('Merging local and remote bookmarks...', 'info');

        const remoteId = syncManager.getRemoteId();
        const adapter = syncManager.getAdapter();
        const remoteData = await adapter.readBookmarks(remoteId);
        const localData = await syncManager.getLocalBookmarks();

        // STEP 1: Take a snapshot of current bookmarks before destructive merge
        const preSyncSnapshot = JSON.parse(JSON.stringify(localData));

        // STEP 2: Clear all old changelog entries (they will have invalid IDs after merge)
        await clearChangelog();

        // STEP 3: Add a special changelog entry for this merge operation with full snapshot
        await addChangelogEntry('pre-sync-snapshot', 'sync', 'Bidirectional Merge', null, {
          snapshot: preSyncSnapshot,
          timestamp: Date.now(),
          operation: 'Bidirectional Merge'
        });

        // Merge in both directions using sync-manager's merge function
        const remoteIntoLocal = syncManager.mergeBookmarksIntoTree(remoteData, localData);
        const fullyMerged = syncManager.mergeBookmarksIntoTree(localData, remoteIntoLocal);

        // Apply merged result to both local and remote
        await syncManager.saveLocalBookmarks(fullyMerged);
        await adapter.updateBookmarks(remoteId, fullyMerged);

        this.showToast('Merge completed successfully! All bookmarks preserved.', 'success');
        // Reload bookmarks in UI
        await this.loadBookmarks();
      } catch (error) {
        console.error('[MergeBidirectional] Error:', error);
        this.showToast(`Merge failed: ${error.message}`, 'error');
      }
    };

    // Manual sync button
    const manualSyncBtn = document.getElementById('manualSyncBtn');
    if (manualSyncBtn) {
      manualSyncBtn.addEventListener('click', async (e) => {
        console.log('[ManualSync] Button clicked');

        // Check if Shift key is held for force push
        const forcePush = e.shiftKey;
        if (forcePush) {
          console.log('[ManualSync] Shift-click detected - forcing push to remote');
          if (!confirm('Force push local bookmarks to remote? This will overwrite the remote with your local data.')) {
            return;
          }

          // Show loading state
          manualSyncBtn.disabled = true;
          const originalContent = manualSyncBtn.innerHTML;
          manualSyncBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/></svg>';

          try {
            await syncManager.syncToRemote();
            this.showToast('Force pushed to remote successfully', 'success');
          } catch (error) {
            console.error('[ManualSync] Failed:', error);
            this.showToast(`Sync failed: ${error.message}`, 'error');
          } finally {
            manualSyncBtn.disabled = false;
            manualSyncBtn.innerHTML = originalContent;
          }
          return;
        }

        // Normal click - show diff dialog
        try {
          this.showToast('Checking for changes...', 'info');

          const remoteId = syncManager.getRemoteId();
          if (!remoteId) {
            this.showToast('No remote storage configured', 'error');
            return;
          }

          const adapter = syncManager.getAdapter();
          const remoteData = await adapter.readBookmarks(remoteId);
          const localData = await syncManager.getLocalBookmarks();

          const diff = syncManager.calculateBookmarkDiff(localData, remoteData);
          const hasChanges = diff.added.length + diff.removed.length + diff.moved.length + diff.modified.length > 0;

          if (!hasChanges) {
            this.showToast('No changes detected. Bookmarks are in sync.', 'success');
            return;
          }

          await this.showSyncDiffDialog(diff, remoteData);
        } catch (error) {
          console.error('[ManualSync] Failed:', error);
          this.showToast(`Sync failed: ${error.message}`, 'error');
        }
      });
    }

    // Logout button
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await this.logout();
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
      uiManager.closeAllMenus();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape key - close modals and menus
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach(modal => {
          modal.classList.add('hidden');
        });
        uiManager.closeAllMenus();
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

    window.addEventListener('sync:syncError', (e) => {
      if (e.detail) {
        this.showToast(e.detail, 'error');
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
      const { diff, remoteData, message } = e.detail;
      await this.showSyncConflictDialog(diff, remoteData, message);
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

        // Re-render UI first
        const tree = bookmarkManager.getTree();
        uiManager.renderBookmarks(tree);

        // Force sync to remote after import (use forcePush=true to ensure sync happens)
        console.log('[Import] Starting forced sync to remote after import...');
        try {
          await syncManager.manualSync(true);
          console.log('[Import] Sync to remote completed successfully');
          this.showToast('Bookmarks imported and synced successfully!', 'success');
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

    // Export HTML
    modal.querySelector('#exportHTMLBtn').addEventListener('click', () => {
      try {
        const tree = bookmarkManager.getTree();
        const filename = exportAsHTML(tree);
        this.showToast(`Exported as ${filename}`, 'success');
        modal.remove();
      } catch (error) {
        console.error('Export failed:', error);
        this.showToast(`Export failed: ${error.message}`, 'error');
      }
    });

    // Export JSON
    modal.querySelector('#exportJSONBtn').addEventListener('click', () => {
      try {
        const tree = bookmarkManager.getTree();
        const filename = exportAsJSON(tree);
        this.showToast(`Exported as ${filename}`, 'success');
        modal.remove();
      } catch (error) {
        console.error('Export failed:', error);
        this.showToast(`Export failed: ${error.message}`, 'error');
      }
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

      // Re-render UI
      const tree = bookmarkManager.getTree();
      uiManager.renderBookmarks(tree);

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
  showToast(message, type = 'info') {
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
    }, 3000);
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

  /**
   * Merge local and remote bookmarks, preserving folder structure
   */
  mergeBookmarkTrees(localTree, remoteTree) {
    const merged = JSON.parse(JSON.stringify(localTree));

    const mergeFolder = (local, remote, path = '') => {
      if (!remote || !remote.children) return;

      for (const remoteChild of remote.children) {
        const localChild = local.children.find(c => c.id === remoteChild.id);

        if (localChild) {
          if (remoteChild.children && localChild.children) {
            mergeFolder(localChild, remoteChild, path + '/' + localChild.title);
          }
        } else {
          local.children.push(JSON.parse(JSON.stringify(remoteChild)));
        }
      }
    };

    for (const rootKey in remoteTree.roots) {
      if (merged.roots[rootKey]) {
        mergeFolder(merged.roots[rootKey], remoteTree.roots[rootKey], rootKey);
      } else {
        merged.roots[rootKey] = JSON.parse(JSON.stringify(remoteTree.roots[rootKey]));
      }
    }

    return merged;
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
        <button id="mergeBookmarks" style="
          background: var(--md-sys-color-primary);
          color: var(--md-sys-color-on-primary);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
          font-weight: 500;
          min-width: auto;
        ">Merge</button>
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
        ">Use Snippet</button>
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

    dialog.querySelector('#mergeBookmarks').addEventListener('click', async () => {
      modal.remove();
      try {
        const localTree = await syncManager.loadLocalBookmarks();
        const mergedTree = this.mergeBookmarkTrees(localTree, remoteData);
        mergedTree.version = remoteData.version;
        
        await syncManager.saveLocalBookmarks(mergedTree);
        await syncManager.setLocalVersion(remoteData.version);
        await bookmarkManager.reload();
        
        if (window.reloadBookmarkUI) {
          await window.reloadBookmarkUI();
        }
        
        this.showToast('Bookmarks merged successfully!', 'success');
        window.location.reload();
      } catch (error) {
        console.error('Merge failed:', error);
        this.showToast('Merge failed: ' + error.message, 'error');
      }
    });

    dialog.querySelector('#replaceLocal').addEventListener('click', async () => {
      modal.remove();
      try {
        const success = await syncManager.applyRemoteSync(remoteData);
        if (success) {
          this.showToast('Bookmarks replaced with snippet contents', 'success');
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
    console.log('[showMainApp] Starting main app initialization...');

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
    console.log('Bookmark manager initialized');

    // Initialize sync manager
    await syncManager.init();
    console.log('Sync manager initialized');

    // Skip snippet setup and remote sync if in local mode
    const logoutBtn = document.getElementById('logoutBtn');
    const localModeRecord = await dbManager.get('settings', 'bmz_local_mode');
    const isLocalMode = localModeRecord && localModeRecord.value === true;
    console.log('[App] Button visibility check - isLocalMode:', isLocalMode, 'logoutBtn exists:', !!logoutBtn);

    if (!isLocalMode) {
      // Show logout button and manual sync button in GitLab mode
      console.log('[App] GitLab mode - showing logout button and manual sync button');
      if (logoutBtn) {
        logoutBtn.style.display = 'flex';
        console.log('[App] Logout button display set to flex');
      } else {
        console.error('[App] Logout button element not found!');
      }

      const manualSyncBtn = document.getElementById('manualSyncBtn');
      if (manualSyncBtn) {
        manualSyncBtn.style.display = '';
        console.log('[App] Manual sync button shown');
      }

      // Check if we have a snippet set up
      const hasSnippet = await this.checkSnippetSetup();

      if (!hasSnippet) {
        // Show snippet setup modal (buttons should already work from initUI)
        await this.showSnippetSetup();
        return;
      }

      // Sync from remote to ensure we have latest data
      // Prevent duplicate sync operations
      if (!this._syncInProgress) {
        this._syncInProgress = true;
        console.log('[App] Syncing bookmarks from remote...');
        try {
          // Check if we already have the latest data from checkSnippetSetup()
          // We can check if local bookmarks are already loaded and match the remote
          const localTree = bookmarkManager.getTree();
          const hasLocalBookmarks = localTree && localTree.roots && Object.keys(localTree.roots).length > 0;

          if (hasLocalBookmarks) {
            console.log('[App] Already have bookmarks loaded, skipping sync');
          } else {
            await syncManager.syncFromRemote();
            await bookmarkManager.reload();
          }
          console.log('[App] Sync from remote complete');
        } catch (error) {
          console.warn('[App] Sync from remote failed, will use cached data:', error);
        } finally {
          this._syncInProgress = false;
        }
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

    console.log('[App] Initializing sidebar...');
    // Initialize sidebar FIRST - loads bookmarks, settings, and prepares UI
    // Prevent duplicate initialization
    if (window.initSidebar && !this._sidebarInitialized) {
      await window.initSidebar();
      this._sidebarInitialized = true;
    }

    // Initialize services with delays to prevent overwhelming the system
    console.log('[App] Initializing blocklist service...');
    await blocklistService.init();
    console.log('Blocklist service initialized');

    // Initialize scanner service immediately
    console.log('[App] Initializing scanner service...');
    if (!this._scannerInitialized) {
      await scannerService.init();
      this._scannerInitialized = true;
      console.log('Scanner service initialized');
    }

    console.log('Main app loaded successfully');
  }

  /**
   * Show error message
   */
  showError(title, error) {
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
