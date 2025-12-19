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
      const savedGistId = localStorage.getItem('bmz_gist_id');
      if (savedGistId) {
        // Check if it's an object instead of a string
        if (savedGistId.startsWith('{') || savedGistId.startsWith('[')) {
          console.warn('Found corrupted gist ID in localStorage, clearing...');
          localStorage.removeItem('bmz_gist_id');
        }
      }

      // Clean IndexedDB
      const gistIdRecord = await dbManager.get('metadata', 'gistId');
      if (gistIdRecord && gistIdRecord.value) {
        const value = gistIdRecord.value;
        // Check if it's an object instead of a string
        if (typeof value === 'object') {
          console.warn('Found corrupted gist ID in IndexedDB, clearing...');
          await dbManager.delete('metadata', 'gistId');
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

    // Check if user is in local mode
    const isLocalMode = localStorage.getItem('bmz_local_mode') === 'true';

    if (isLocalMode) {
      console.log('[Auth] Local mode detected');
      // Check if there are bookmarks in local storage
      const hasBookmarks = await dbManager.getAllBookmarks();
      if (hasBookmarks && hasBookmarks.length > 0) {
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
          await dbManager.saveAllBookmarks(bookmarks);

          // Store a flag indicating local mode
          await authManager.storePreference('syncProvider', 'local');
          localStorage.setItem('bmz_local_mode', 'true');

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
          const authResult = await oauthPAT.authenticate(token);

          console.log(`Authenticated with GitLab:`, authResult.user.username);

          // Store token securely
          await authManager.storeToken(authResult.access_token, null, 'gitlab');

          // Store provider preference
          await authManager.storePreference('syncProvider', 'gitlab');

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

      // Clear authentication
      await authManager.clearToken('gitlab');
      oauthPAT.clear();

      // Clear app authentication state
      this.isAuthenticated = false;
      this.currentUser = null;

      // Clear provider preference
      await authManager.storePreference('syncProvider', null);

      // Clear snippet ID from localStorage and adapter
      localStorage.removeItem('bmz_snippet_id');
      snippetAdapter.snippetId = null;

      // Clear sync manager state
      syncManager.snippetId = null;
      syncManager.provider = null;

      // Clear all local bookmark data from IndexedDB
      await dbManager.clear('bookmarks');
      await dbManager.clear('metadata');

      // Clear local mode flag
      localStorage.removeItem('bmz_local_mode');

      // Keep settings (like theme, API keys) but clear auth-related data
      // Settings are user preferences, not user data

      console.log('Logout complete, reloading page...');

      // Use setTimeout with longer delay to ensure all IndexedDB operations complete
      // IndexedDB commits are asynchronous even after await returns
      setTimeout(() => {
        window.location.reload();
      }, 250);
    } catch (error) {
      console.error('Logout failed:', error);
      // Even if there's an error, try to reload after a delay
      setTimeout(() => {
        window.location.reload();
      }, 250);
    }
  }

  /**
   * Clear all sync-related data (snippet IDs and bookmarks)
   * Call this when logging in to ensure fresh state
   */
  async clearAllSyncData() {
    console.log('[App] Clearing all sync data for fresh login...');

    // Clear sync manager state
    syncManager.snippetId = null;
    syncManager.provider = null;

    // Clear adapter state
    snippetAdapter.snippetId = null;

    // Clear localStorage
    localStorage.removeItem('bmz_snippet_id');

    // Clear IndexedDB metadata (snippet IDs, version, bookmark tree)
    await dbManager.delete('metadata', 'snippetId');
    await dbManager.delete('metadata', 'localVersion');
    await dbManager.delete('metadata', 'bookmarkTree');

    // Clear all bookmarks to force fresh sync
    await dbManager.clear('bookmarks');

    console.log('[App] All sync data cleared');
  }

  /**
   * Show main app after authentication
   */
  async showMainApp() {
    try {
      console.log('[App] showMainApp started');

      // Hide login screen, show main content
      const loginScreen = document.getElementById('loginScreen');
      const mainContent = document.getElementById('mainContent');

      // Remove show-login class from html element
      document.documentElement.classList.remove('show-login');

      if (loginScreen) {
        loginScreen.classList.add('hidden');
      }
      if (mainContent) {
        mainContent.classList.remove('hidden');
      }

      // Clean up any corrupted storage
      await this.cleanupLocalStorage();

      // Check if we're in local mode
      const isLocalMode = localStorage.getItem('bmz_local_mode') === 'true';

      // Show/hide Connect GitLab button based on mode
      const connectGitlabBtn = document.getElementById('connectGitlabBtn');
      if (connectGitlabBtn) {
        connectGitlabBtn.style.display = isLocalMode ? 'flex' : 'none';
      }

      // Initialize bookmark manager
      await bookmarkManager.init();
      console.log('Bookmark manager initialized');

      // Initialize sync manager
      await syncManager.init();
      console.log('Sync manager initialized');

      // Skip gist setup and remote sync if in local mode
      if (!isLocalMode) {
        // Check if we have a gist set up
        const hasGist = await this.checkGistSetup();

        if (!hasGist) {
          // Show gist setup modal (buttons should already work from initUI)
          await this.showGistSetup();
          return;
        }

        // Sync from remote to ensure we have latest data
        // Prevent duplicate sync operations
        if (!this._syncInProgress) {
          this._syncInProgress = true;
          console.log('[App] Syncing bookmarks from remote...');
          try {
            // Check if we already have the latest data from checkGistSetup()
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
    } catch (error) {
      console.error('Error in showMainApp:', error);
      this.showError('Failed to load main app', error);
    }
  }

  /**
   * Check if we have a snippet set up
   * Checks for saved snippet ID
   */
  async checkGistSetup() {
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
  async showGistSetup() {
    const modal = document.getElementById('snippetSetupModal');
    const noGistsSection = document.getElementById('noSnippetsSection');
    const existingGistSection = document.getElementById('existingSnippetSection');
    const multipleGistsSection = document.getElementById('multipleSnippetsSection');
    const existingGistInfo = document.getElementById('existingSnippetInfo');
    const gistList = document.getElementById('snippetList');

    // Only GitLab is supported
    const provider = 'gitlab';
    const adapter = snippetAdapter;
    const itemName = 'Snippet';

    console.log(`Setting up ${itemName} for provider: ${provider}`);

    // Hide all sections first
    noGistsSection.style.display = 'none';
    existingGistSection.style.display = 'none';
    multipleGistsSection.style.display = 'none';

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
        noGistsSection.style.display = 'block';
        // Update button text
        const createBtn = document.getElementById('createNewSnippetBtn');
        if (createBtn) createBtn.textContent = `Create New ${itemName}`;
      } else if (bookmarkItems.length === 1) {
        // One item found - show use or create new
        existingGistSection.style.display = 'block';
        const item = bookmarkItems[0];

        // Format snippet info
        const fileCount = item.files?.length || 1;
        const lastUpdated = new Date(item.updated_at).toLocaleDateString();
        const description = item.title || 'Untitled Snippet';

        existingGistInfo.textContent = `${description} • ${fileCount} files • Updated ${lastUpdated}`;

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
        multipleGistsSection.style.display = 'block';
        gistList.innerHTML = '';

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

          gistList.appendChild(itemDiv);
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
      this.showGistSetupError(`Failed to load ${itemName}s: ` + error.message);
    }
  }

  /**
   * Use existing remote storage (gist or snippet)
   */
  async useRemoteStorage(itemId, provider = 'gitlab') {
    try {
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
      this.showGistSetupError(`Failed to use snippet: ` + error.message);
    }
  }

  /**
   * Create new remote storage (snippet)
   */
  async createNewRemoteStorage(provider = 'gitlab') {
    try {
      console.log(`[Createsnippet] Step 1: Creating snippet via adapter...`);

      const itemId = await snippetAdapter.createBookmarkSnippet();
      console.log(`[CreateSnippet] Step 1 Complete: Snippet created with ID:`, itemId);

      console.log(`[CreateSnippet] Step 2: Setting snippet ID in adapter...`);
      snippetAdapter.setSnippetId(itemId);

      // Save snippet ID to sync manager
      console.log(`[CreateSnippet] Step 4: Saving snippet ID to sync manager...`);
      await syncManager.setSnippetId(itemId);

      // Hide modal
      console.log(`[Createsnippet] Step 3: Hiding modal...`);
      const modal = document.getElementById('snippetSetupModal');
      modal.style.display = 'none';
      modal.classList.add('hidden');

      // Set initial version to 1 (matching what we created)
      console.log(`[Createsnippet] Step 4.5: Setting initial version...`);
      await syncManager.setLocalVersion(1);

      // Initialize local bookmarks with empty structure
      console.log(`[Createsnippet] Step 4.7: Initializing local bookmarks...`);
      const emptyTree = syncManager.getEmptyBookmarkTree();
      await syncManager.saveLocalBookmarks(emptyTree);
      console.log(`[Createsnippet] Step 4.8: Local bookmarks initialized`);

      // Reload bookmarks from local storage
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
      this.showGistSetupError('Failed to create snippet: ' + error.message);
    }
  }

  /**
   * Show snippet setup error
   */
  showGistSetupError(message) {
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
        const authResult = await oauthPAT.authenticate(token);
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

        // Close modal
        modal.classList.add('hidden');
        modal.style.display = 'none';

        // Show success message
        this.showToast('GitLab connected successfully! Your bookmarks will now sync to the cloud.', 'success');

        // Initialize sync manager and create/use gist
        await syncManager.init();

        // Check for existing gist or create new one
        const hasGist = await this.checkGistSetup();

        if (!hasGist) {
          // Show gist setup to let user create or select snippet
          await this.showGistSetup();
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
   * Load bookmarks from Gist or local storage
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
      searchInput.addEventListener('input', (e) => {
        const tree = bookmarkManager.getTree();
        uiManager.renderBookmarks(tree);
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
        }

        // Show loading state
        manualSyncBtn.disabled = true;
        const originalContent = manualSyncBtn.innerHTML;
        manualSyncBtn.innerHTML = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;"><path d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/></svg>';

        try {
          // Force sync to remote if Shift is held
          await syncManager.manualSync(forcePush);
          this.showToast('Sync completed successfully', 'success');
        } catch (error) {
          console.error('[ManualSync] Failed:', error);
          this.showToast(`Sync failed: ${error.message}`, 'error');
        } finally {
          // Restore button state
          manualSyncBtn.disabled = false;
          manualSyncBtn.innerHTML = originalContent;
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
   */
  showAddBookmarkModal(parentId = null) {
    // TODO: Implement add bookmark modal
    console.log('Show add bookmark modal, parent:', parentId);
  }

  /**
   * Show settings modal
   */
  showSettingsModal() {
    // TODO: Implement settings modal
    console.log('Show settings modal');
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
   * Show toast notification
   */
  showToast(message, type = 'info') {
    // TODO: Implement proper toast system
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
        Bookmarks Updated from Gist
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
        The remote Gist has <strong>${diff.removed.length} deletion(s)</strong> that will remove bookmarks from your local collection.
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
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="cancelSync" style="
          background: var(--md-sys-color-surface-variant);
          color: var(--md-sys-color-on-surface-variant);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
        ">Cancel</button>
        <button id="viewFullDiff" style="
          background: var(--md-sys-color-secondary-container);
          color: var(--md-sys-color-on-secondary-container);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
        ">View Full Changes</button>
        <button id="acceptSync" style="
          background: var(--md-sys-color-error);
          color: var(--md-sys-color-on-error);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1em;
          font-weight: 500;
        ">Accept & Sync</button>
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

    dialog.querySelector('#acceptSync').addEventListener('click', async () => {
      modal.remove();
      // Apply the sync
      const success = await syncManager.applyRemoteSync(remoteData);
      if (success) {
        // Reload bookmarks in UI
        window.location.reload();
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
