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

    // Expose provider switcher IMMEDIATELY for login screen onclick handlers
    // This must be available before any async initialization happens
    window.bmzSwitchProvider = (provider) => {
      console.log('Provider switch requested:', provider);
      this.switchToProvider(provider);
    };
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

    // Check for saved provider preference
    const provider = await authManager.getPreference('syncProvider', 'github');
    const token = await authManager.getToken(provider);

    if (token) {
      console.log('[Auth] Found saved token, verifying...');
      // Verify token is valid by fetching user info
      try {
        let response;
        if (provider === 'gitlab') {
          response = await fetch('https://gitlab.com/api/v4/user', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
        } else {
          // GitHub - use 'token' not 'Bearer'
          response = await fetch('https://api.github.com/user', {
            headers: {
              'Authorization': `token ${token}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          });
        }

        if (response.ok) {
          this.currentUser = await response.json();
          this.isAuthenticated = true;

          console.log('[Auth] Token valid, user:', this.currentUser.login || this.currentUser.username);

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
    }

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
   * Switch between GitHub and GitLab providers
   */
  switchToProvider(provider) {
    const githubLogo = document.getElementById('githubLogo');
    const gitlabLogo = document.getElementById('gitlabLogo');
    const githubInstructions = document.getElementById('githubInstructions');
    const gitlabInstructions = document.getElementById('gitlabInstructions');

    if (!githubLogo || !gitlabLogo) {
      return;
    }

    console.log('Switching to provider:', provider);

    if (provider === 'github') {
      // Highlight GitHub
      githubLogo.style.background = 'var(--md-sys-color-primary)';
      githubLogo.style.opacity = '1';
      githubLogo.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
      githubLogo.querySelector('svg').style.color = 'var(--md-sys-color-on-primary)';

      // Dim GitLab
      gitlabLogo.style.background = 'var(--md-sys-color-surface-variant)';
      gitlabLogo.style.opacity = '0.6';
      gitlabLogo.style.boxShadow = 'none';
      gitlabLogo.querySelector('svg').style.color = 'var(--md-sys-color-on-surface)';

      // Show GitHub instructions
      githubInstructions.style.display = 'block';
      gitlabInstructions.style.display = 'none';
    } else {
      // Highlight GitLab
      gitlabLogo.style.background = 'var(--md-sys-color-primary)';
      gitlabLogo.style.opacity = '1';
      gitlabLogo.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
      gitlabLogo.querySelector('svg').style.color = 'var(--md-sys-color-on-primary)';

      // Dim GitHub
      githubLogo.style.background = 'var(--md-sys-color-surface-variant)';
      githubLogo.style.opacity = '0.6';
      githubLogo.style.boxShadow = 'none';
      githubLogo.querySelector('svg').style.color = 'var(--md-sys-color-on-surface)';

      // Show GitLab instructions
      githubInstructions.style.display = 'none';
      gitlabInstructions.style.display = 'block';
    }
  }

  /**
   * Set up login button handlers
   */
  setupLoginHandlers() {

    // Set up GitHub login button handler
    const loginBtn = document.getElementById('loginBtn');
    const tokenInput = document.getElementById('tokenInput');
    const loginError = document.getElementById('loginError');

    if (loginBtn && tokenInput) {
      // Handle Enter key in token input
      tokenInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          loginBtn.click();
        }
      });

      loginBtn.onclick = async () => {
        const token = tokenInput.value.trim();

        if (!token) {
          this.showLoginError('Please enter your Personal Access Token');
          return;
        }

        // Show loading state
        loginBtn.disabled = true;
        loginBtn.textContent = 'Authenticating...';
        if (loginError) loginError.style.display = 'none';

        try {
          // Authenticate with token
          const authResult = await oauthPAT.authenticate(token);

          console.log(`Authenticated with ${authResult.provider}:`, authResult.user.login || authResult.user.username);

          // Store token securely with provider information
          await authManager.storeToken(authResult.access_token, null, authResult.provider);

          // Store provider preference
          await authManager.storePreference('syncProvider', authResult.provider);

          // Show success and load main app
          await this.showMainApp();

        } catch (error) {
          console.error('Login failed:', error);
          this.showLoginError(error.message || 'Authentication failed. Please check your token and try again.');

          // Reset button
          loginBtn.disabled = false;
          loginBtn.textContent = 'Login with GitHub';
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
          // Authenticate with token
          const authResult = await oauthPAT.authenticate(token);

          console.log(`Authenticated with ${authResult.provider}:`, authResult.user.login || authResult.user.username);

          // Store token securely with provider information
          await authManager.storeToken(authResult.access_token, null, authResult.provider);

          // Store provider preference
          await authManager.storePreference('syncProvider', authResult.provider);

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
   * Show login error message
   */
  showLoginError(message) {
    const loginError = document.getElementById('loginError');
    if (loginError) {
      loginError.textContent = message;
      loginError.style.display = 'block';
    }
  }

  /**
   * Logout user and return to login screen
   * Clears all local data but does NOT delete remote gists/snippets
   */
  async logout() {
    try {
      console.log('Logging out...');

      // Clear authentication for both providers
      await authManager.clearToken('github');
      await authManager.clearToken('gitlab');
      oauthPAT.clear();

      // Clear app authentication state
      this.isAuthenticated = false;
      this.currentUser = null;

      // Clear provider preference
      await authManager.storePreference('syncProvider', null);

      // Clear gist ID from localStorage and adapter
      localStorage.removeItem('bmz_gist_id');
      gistAdapter.gistId = null;

      // Clear snippet ID from localStorage and adapter
      localStorage.removeItem('bmz_snippet_id');
      snippetAdapter.snippetId = null;

      // Clear sync manager state
      syncManager.gistId = null;
      syncManager.snippetId = null;
      syncManager.provider = null;

      // Clear all local bookmark data from IndexedDB
      await dbManager.clear('bookmarks');
      await dbManager.clear('metadata');

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
   * Clear all sync-related data (gist/snippet IDs and bookmarks)
   * Call this when logging in to ensure fresh state
   */
  async clearAllSyncData() {
    console.log('[App] Clearing all sync data for fresh login...');

    // Clear sync manager state
    syncManager.gistId = null;
    syncManager.snippetId = null;
    syncManager.provider = null;

    // Clear adapter state
    gistAdapter.gistId = null;
    snippetAdapter.snippetId = null;

    // Clear localStorage
    localStorage.removeItem('bmz_gist_id');
    localStorage.removeItem('bmz_snippet_id');

    // Clear IndexedDB metadata (gist/snippet IDs, version, bookmark tree)
    await dbManager.delete('metadata', 'gistId');
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

      if (loginScreen) {
        loginScreen.classList.add('hidden');
      }
      if (mainContent) {
        mainContent.classList.remove('hidden');
      }

      // Clean up any corrupted storage
      await this.cleanupLocalStorage();

      // Initialize bookmark manager
      await bookmarkManager.init();
      console.log('Bookmark manager initialized');

      // Initialize sync manager
      await syncManager.init();
      console.log('Sync manager initialized');

      // Sync timer removed - using event-driven sync only
      // Changes sync automatically when you add/edit/delete bookmarks or folders
      console.log('Event-driven sync ready');

      // Check if we have a gist set up
      const hasGist = await this.checkGistSetup();

      if (!hasGist) {
        // Show gist setup modal (buttons should already work from initUI)
        await this.showGistSetup();
        return;
      }

      // Sync from remote to ensure we have latest data
      console.log('[App] Syncing bookmarks from remote...');
      try {
        await syncManager.syncFromRemote();
        await bookmarkManager.reload();
        console.log('[App] Sync from remote complete');
      } catch (error) {
        console.warn('[App] Sync from remote failed, will use cached data:', error);
      }

      console.log('[App] Initializing sidebar...');
      // Initialize sidebar FIRST - loads bookmarks, settings, and prepares UI
      if (window.initSidebar) {
        await window.initSidebar();
      }

      console.log('[App] Initializing blocklist service...');
      // Initialize blocklist service after bookmarks are loaded
      await blocklistService.init();
      console.log('Blocklist service initialized');

      console.log('[App] Initializing scanner service...');
      // Initialize scanner service - it will restore cached statuses to loaded bookmarks
      await scannerService.init();
      console.log('Scanner service initialized');

      console.log('Main app loaded successfully');
    } catch (error) {
      console.error('Error in showMainApp:', error);
      this.showError('Failed to load main app', error);
    }
  }

  /**
   * Check if we have a gist/snippet set up
   * Checks for saved gist/snippet ID based on current provider
   */
  async checkGistSetup() {
    const provider = await authManager.getPreference('syncProvider', 'github');

    if (provider === 'gitlab') {
      // Check for GitLab snippet
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
    } else {
      // Check for GitHub gist
      const savedGistId = gistAdapter.loadSavedGistId();
      if (savedGistId) {
        console.log('Found saved gist ID:', savedGistId);
        // Verify we can read from it
        try {
          await gistAdapter.readBookmarks(savedGistId);
          gistAdapter.gistId = savedGistId;
          syncManager.setProvider('github');
          syncManager.gistId = savedGistId;
          return true;
        } catch (error) {
          console.warn('Saved gist ID is invalid, clearing:', error);
          localStorage.removeItem('bmz_gist_id');
        }
      }
    }

    // No valid saved ID found
    return false;
  }

  /**
   * Show gist/snippet setup modal (supports both GitHub and GitLab)
   */
  async showGistSetup() {
    const modal = document.getElementById('gistSetupModal');
    const noGistsSection = document.getElementById('noGistsSection');
    const existingGistSection = document.getElementById('existingGistSection');
    const multipleGistsSection = document.getElementById('multipleGistsSection');
    const existingGistInfo = document.getElementById('existingGistInfo');
    const gistList = document.getElementById('gistList');

    // Get the current provider from stored preference or oauth
    const provider = oauthPAT.getProvider() || await authManager.getPreference('syncProvider', 'github');
    const adapter = provider === 'gitlab' ? snippetAdapter : gistAdapter;
    const itemName = provider === 'gitlab' ? 'Snippet' : 'Gist';

    console.log(`Setting up ${itemName} for provider: ${provider}`);

    // Hide all sections first
    noGistsSection.style.display = 'none';
    existingGistSection.style.display = 'none';
    multipleGistsSection.style.display = 'none';

    try {
      // FIRST check if we have a saved gist/snippet ID in localStorage
      const savedId = provider === 'gitlab' ?
        localStorage.getItem('bmz_snippet_id') :
        localStorage.getItem('bmz_gist_id');

      if (savedId) {
        console.log(`[GistSetup] Found saved ${itemName} ID in localStorage:`, savedId);
        // Try to use the saved ID directly
        try {
          await this.useRemoteStorage(savedId, provider);
          modal.style.display = 'none';
          modal.classList.add('hidden');
          return; // Success! Don't show the setup modal
        } catch (err) {
          console.warn(`[GistSetup] Saved ${itemName} ID is invalid:`, err);
          // Clear the invalid ID and continue to show setup options
          if (provider === 'gitlab') {
            localStorage.removeItem('bmz_snippet_id');
          } else {
            localStorage.removeItem('bmz_gist_id');
          }
        }
      }

      // Get all remote items (gists or snippets)
      const items = provider === 'gitlab' ?
        await adapter.getAllSnippets() :
        await adapter.getAllGists();

      console.log(`[GistSetup] Found ${items.length} total ${itemName}s`);

      // Log details of each item for debugging
      items.forEach((item, idx) => {
        if (provider === 'github') {
          console.log(`[GistSetup] Gist ${idx}:`, {
            id: item.id,
            description: item.description,
            files: Object.keys(item.files),
            hasBookmarksJson: !!item.files['bookmarks.json']
          });
        }
      });

      // Filter for bookmark-like items
      const bookmarkItems = items.filter(item => {
        if (provider === 'gitlab') {
          // GitLab snippet filtering
          return item.title?.includes('BMZ') ||
                 item.title?.includes('Bookmark Manager Zero') ||
                 item.file_name === 'bookmarks.json';
        } else {
          // GitHub gist filtering
          const matches = item.files['bookmarks.json'] ||
                 item.description?.includes('BMZ') ||
                 item.description?.includes('Bookmark Manager Zero') ||
                 item.description?.includes('bookmark');

          if (matches) {
            console.log(`[GistSetup] Gist ${item.id} matched as bookmark gist`);
          }

          return matches;
        }
      });

      console.log(`[GistSetup] Found ${bookmarkItems.length} bookmark ${itemName}s`);

      if (bookmarkItems.length === 0) {
        // No items found - show create option
        noGistsSection.style.display = 'block';
        // Update button text
        const createBtn = document.getElementById('createNewGistBtn');
        if (createBtn) createBtn.textContent = `Create New ${itemName}`;
      } else if (bookmarkItems.length === 1) {
        // One item found - show use or create new
        existingGistSection.style.display = 'block';
        const item = bookmarkItems[0];

        // Format based on provider
        let fileCount, lastUpdated, description;
        if (provider === 'gitlab') {
          fileCount = item.files?.length || 1;
          lastUpdated = new Date(item.updated_at).toLocaleDateString();
          description = item.title || 'Untitled Snippet';
        } else {
          fileCount = Object.keys(item.files).length;
          lastUpdated = new Date(item.updated_at).toLocaleDateString();
          description = item.description || 'Untitled Gist';
        }

        existingGistInfo.textContent = `${description} • ${fileCount} files • Updated ${lastUpdated}`;

        // Store item for use button
        document.getElementById('useExistingGistBtn').onclick = async () => {
          await this.useRemoteStorage(item.id, provider);
        };

        // Update button texts
        const useBtn = document.getElementById('useExistingGistBtn');
        const createBtn2 = document.getElementById('createNewGistBtn2');
        if (useBtn) useBtn.textContent = `Use This ${itemName}`;
        if (createBtn2) createBtn2.textContent = `Create New ${itemName}`;
      } else {
        // Multiple items - show selection
        multipleGistsSection.style.display = 'block';
        gistList.innerHTML = '';

        bookmarkItems.forEach(item => {
          let fileCount, lastUpdated, description;
          if (provider === 'gitlab') {
            fileCount = item.files?.length || 1;
            lastUpdated = new Date(item.updated_at).toLocaleDateString();
            description = item.title || 'Untitled Snippet';
          } else {
            fileCount = Object.keys(item.files).length;
            lastUpdated = new Date(item.updated_at).toLocaleDateString();
            description = item.description || 'Untitled Gist';
          }

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
        const createBtn3 = document.getElementById('createNewGistBtn3');
        if (createBtn3) createBtn3.textContent = `Create New ${itemName}`;
      }

      // Setup create new buttons
      const createButtons = [
        document.getElementById('createNewGistBtn'),
        document.getElementById('createNewGistBtn2'),
        document.getElementById('createNewGistBtn3')
      ];

      createButtons.forEach(btn => {
        if (btn) {
          btn.onclick = async () => {
            await this.createNewRemoteStorage(provider);
          };
        }
      });

      // Setup logout button in gist setup modal
      const gistSetupLogoutBtn = document.getElementById('gistSetupLogoutBtn');
      if (gistSetupLogoutBtn) {
        gistSetupLogoutBtn.onclick = async () => {
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
      const modal = document.getElementById('gistSetupModal');
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
      const modal = document.getElementById('gistSetupModal');
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
   * Show gist setup error
   */
  showGistSetupError(message) {
    const errorDiv = document.getElementById('gistSetupError');
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.style.display = 'block';
    }
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

    // Suppress favicon 404 errors in console
    window.addEventListener('error', (e) => {
      // Suppress image loading errors (favicons)
      if (e.target && e.target.tagName === 'IMG' && e.target.classList.contains('bookmark-favicon')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }, true);

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
