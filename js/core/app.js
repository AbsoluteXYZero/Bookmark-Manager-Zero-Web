/**
 * Main Application Logic
 * Initializes all managers and handles app-wide functionality
 * Theme management, settings, modals, and global event handlers
 */

import dbManager from '../storage/indexeddb.js';
import authManager from '../auth/auth-manager.js';
import oauthPAT from '../auth/oauth-pat.js';
import gistAdapter from '../storage/gist-adapter.js';
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

      // Initialize IndexedDB
      await dbManager.init();

      // Initialize bookmark manager
      await bookmarkManager.init();
      console.log('Bookmark manager initialized');

      // Initialize sync manager
      await syncManager.init();
      console.log('Sync manager initialized');

      // Initialize blocklist service
      await blocklistService.init();
      console.log('Blocklist service initialized');

      // Initialize scanner service
      await scannerService.init();
      console.log('Scanner service initialized');

      // Clean up any corrupted localStorage and IndexedDB data
      await this.cleanupLocalStorage();

      // Load theme
      await this.loadTheme();

      // Check authentication
      await this.checkAuth();

      // Set up global event listeners
      this.setupEventListeners();

      // Set up sync event listeners
      this.setupSyncListeners();

      // Initialize touch handler for mobile devices
      touchHandler.init();
      console.log('Touch handler initialized');

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
    const token = await authManager.getToken();

    if (token) {
      // Verify token is valid by fetching user info
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        if (response.ok) {
          this.currentUser = await response.json();
          this.isAuthenticated = true;
          await this.showMainApp();
        } else {
          // Token invalid, clear it
          await authManager.clearToken();
          this.showLoginScreen();
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        this.showLoginScreen();
      }
    } else {
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

    // Set up login button handler (Personal Access Token)
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

          // Store token securely (just the token string, not the object)
          await authManager.storeToken(authResult.access_token);

          // Show success and load main app
          await this.showMainApp();

        } catch (error) {
          console.error('Login failed:', error);
          this.showLoginError(error.message || 'Authentication failed. Please check your token and try again.');

          // Reset button
          loginBtn.disabled = false;
          loginBtn.textContent = 'Login';
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
   */
  async logout() {
    try {
      // Clear authentication
      await authManager.clearToken();
      oauthPAT.clear();

      // Clear gist ID from localStorage and adapter
      localStorage.removeItem('bmz_gist_id');
      gistAdapter.gistId = null;

      // Clear sync manager state
      if (syncManager.gistId) {
        syncManager.gistId = null;
      }

      // Reload the page to reset everything
      window.location.reload();
    } catch (error) {
      console.error('Logout failed:', error);
      // Even if there's an error, try to reload
      window.location.reload();
    }
  }

  /**
   * Show main app after authentication
   */
  async showMainApp() {
    try {
      // Hide login screen
      const loginScreen = document.getElementById('loginScreen');
      if (loginScreen) {
        loginScreen.classList.add('hidden');
      }

      // Check if we have a gist set up
      const hasGist = await this.checkGistSetup();

      if (!hasGist) {
        // Show gist setup modal (buttons should already work from initUI)
        await this.showGistSetup();
        return;
      }

      // Initialize sync manager
      await syncManager.init();

      // Load or create bookmarks
      await this.loadBookmarks();

      // Initialize sidebar (this loads bookmarks and renders UI)
      if (window.initSidebar) {
        await window.initSidebar();
      }

      console.log('Main app loaded successfully');
    } catch (error) {
      console.error('Error in showMainApp:', error);
      this.showError('Failed to load main app', error);
    }
  }

  /**
   * Check if gist is set up
   * Always returns false to force gist selection modal
   */
  async checkGistSetup() {
    // Clear any saved gist ID so user can choose
    const savedGistId = gistAdapter.loadSavedGistId();
    if (savedGistId) {
      console.log('Found saved gist, but clearing to let user choose:', savedGistId);
      localStorage.removeItem('bmz_gist_id');
      await dbManager.delete('metadata', 'gistId');
      gistAdapter.gistId = null;
    }

    // Always show gist selection modal
    return false;
  }

  /**
   * Show gist setup modal
   */
  async showGistSetup() {
    const modal = document.getElementById('gistSetupModal');
    const noGistsSection = document.getElementById('noGistsSection');
    const existingGistSection = document.getElementById('existingGistSection');
    const multipleGistsSection = document.getElementById('multipleGistsSection');
    const existingGistInfo = document.getElementById('existingGistInfo');
    const gistList = document.getElementById('gistList');

    // Hide all sections first
    noGistsSection.style.display = 'none';
    existingGistSection.style.display = 'none';
    multipleGistsSection.style.display = 'none';

    try {
      // Get all gists
      const gists = await gistAdapter.getAllGists();

      // Filter for bookmark-like gists
      const bookmarkGists = gists.filter(g =>
        g.files['bookmarks.json'] ||
        g.description?.includes('BMZ') ||
        g.description?.includes('Bookmark Manager Zero') ||
        g.description?.includes('bookmark')
      );

      if (bookmarkGists.length === 0) {
        // No gists found - show create option
        noGistsSection.style.display = 'block';
      } else if (bookmarkGists.length === 1) {
        // One gist found - show use or create new
        existingGistSection.style.display = 'block';
        const gist = bookmarkGists[0];
        const fileCount = Object.keys(gist.files).length;
        const lastUpdated = new Date(gist.updated_at).toLocaleDateString();
        existingGistInfo.textContent = `${gist.description || 'Untitled Gist'} • ${fileCount} files • Updated ${lastUpdated}`;

        // Store gist for use button
        document.getElementById('useExistingGistBtn').onclick = async () => {
          await this.useGist(gist.id);
        };
      } else {
        // Multiple gists - show selection
        multipleGistsSection.style.display = 'block';
        gistList.innerHTML = '';

        bookmarkGists.forEach(gist => {
          const fileCount = Object.keys(gist.files).length;
          const lastUpdated = new Date(gist.updated_at).toLocaleDateString();

          const gistItem = document.createElement('div');
          gistItem.style.cssText = 'background: var(--md-sys-color-surface-variant); padding: 16px; border-radius: 8px; margin-bottom: 8px; cursor: pointer; border: 2px solid transparent;';
          gistItem.innerHTML = `
            <div style="font-weight: 500; margin-bottom: 4px;">${gist.description || 'Untitled Gist'}</div>
            <div style="font-size: 12px; color: var(--md-sys-color-on-surface-variant);">${fileCount} files • Updated ${lastUpdated}</div>
          `;

          gistItem.onclick = async () => {
            await this.useGist(gist.id);
          };

          gistItem.onmouseover = () => {
            gistItem.style.borderColor = 'var(--md-sys-color-primary)';
          };
          gistItem.onmouseout = () => {
            gistItem.style.borderColor = 'transparent';
          };

          gistList.appendChild(gistItem);
        });
      }

      // Setup create new gist buttons
      const createButtons = [
        document.getElementById('createNewGistBtn'),
        document.getElementById('createNewGistBtn2'),
        document.getElementById('createNewGistBtn3')
      ];

      createButtons.forEach(btn => {
        if (btn) {
          btn.onclick = async () => {
            await this.createNewGist();
          };
        }
      });

      // Show modal
      modal.style.display = 'flex';
      modal.classList.remove('hidden');

    } catch (error) {
      console.error('Failed to load gists:', error);
      this.showGistSetupError('Failed to load gists: ' + error.message);
    }
  }

  /**
   * Use existing gist
   */
  async useGist(gistId) {
    try {
      gistAdapter.setGistId(gistId);

      // Hide modal
      const modal = document.getElementById('gistSetupModal');
      modal.style.display = 'none';
      modal.classList.add('hidden');

      // Continue with app initialization
      await syncManager.init();

      if (window.initSidebar) {
        await window.initSidebar();
      }

      console.log('Using gist:', gistId);
    } catch (error) {
      console.error('Failed to use gist:', error);
      this.showGistSetupError('Failed to use gist: ' + error.message);
    }
  }

  /**
   * Create new gist
   */
  async createNewGist() {
    try {
      console.log('[CreateGist] Step 1: Creating gist via adapter...');
      const gistId = await gistAdapter.createBookmarkGist();
      console.log('[CreateGist] Step 1 Complete: Gist created with ID:', gistId);

      console.log('[CreateGist] Step 2: Setting gist ID in adapter...');
      gistAdapter.setGistId(gistId);

      // Hide modal
      console.log('[CreateGist] Step 3: Hiding modal...');
      const modal = document.getElementById('gistSetupModal');
      modal.style.display = 'none';
      modal.classList.add('hidden');

      // Save gist ID to sync manager
      console.log('[CreateGist] Step 4: Saving gist ID to sync manager...');
      await syncManager.setGistId(gistId);

      // Clear local version to force sync
      console.log('[CreateGist] Step 4.5: Clearing local version to force sync...');
      await syncManager.setLocalVersion(0);

      // Sync the new gist data from remote to local
      console.log('[CreateGist] Step 5: Syncing from remote...');
      await syncManager.syncFromRemote();

      // Reload bookmarks from local storage
      console.log('[CreateGist] Step 6: Reloading bookmarks from local...');
      const tree = await bookmarkManager.reload();
      console.log('[CreateGist] Step 6 Complete: Tree loaded:', {
        hasRoots: !!tree?.roots,
        rootKeys: tree?.roots ? Object.keys(tree.roots) : [],
        bookmark_bar: tree?.roots?.bookmark_bar,
        menu: tree?.roots?.menu,
        other: tree?.roots?.other,
        mobile: tree?.roots?.mobile
      });

      // Initialize sidebar to render the UI
      console.log('[CreateGist] Step 7: Initializing sidebar...');
      if (window.initSidebar) {
        await window.initSidebar();
        console.log('[CreateGist] Step 7 Complete: Sidebar initialized');
      } else {
        console.warn('[CreateGist] window.initSidebar not found!');
      }

      console.log('[CreateGist] All steps complete. Gist ID:', gistId);
    } catch (error) {
      console.error('[CreateGist] Failed:', error);
      this.showGistSetupError('Failed to create gist: ' + error.message);
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
      // First, try to sync from remote
      const updated = await syncManager.syncFromRemote();

      // Reload bookmark manager to get latest data
      await bookmarkManager.reload();
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
    window.addEventListener('sync:syncChanges', (e) => {
      const { diff, message } = e.detail;
      this.showSyncChangesNotification(diff, message);
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
        await bookmarkManager.loadTree(bookmarkTree);

        // Sync to Gist
        await syncManager.syncToRemote();

        // Re-render UI
        const tree = bookmarkManager.getTree();
        uiManager.renderBookmarks(tree);

        this.showToast('Bookmarks imported successfully!', 'success');
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

  /**
   * Logout user
   */
  async logout() {
    if (confirm('Are you sure you want to logout?')) {
      try {
        await authManager.clearToken();
        this.isAuthenticated = false;
        this.currentUser = null;

        // Reload page to reset state
        window.location.reload();
      } catch (error) {
        console.error('Logout failed:', error);
        this.showError('Logout failed', error);
      }
    }
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
export default app;
