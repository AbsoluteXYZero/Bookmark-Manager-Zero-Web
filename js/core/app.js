/**
 * Main Application Logic
 * Initializes all managers and handles app-wide functionality
 * Theme management, settings, modals, and global event handlers
 */

import dbManager from '../storage/indexeddb.js';
import authManager from '../auth/auth-manager.js';
import oauthDevice from '../auth/oauth-device.js';
import gistAdapter from '../storage/gist-adapter.js';
import syncManager from '../storage/sync-manager.js';
import bookmarkManager from './bookmarks.js';
import uiManager from './ui.js';

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

      // Load theme
      await this.loadTheme();

      // Check authentication
      await this.checkAuth();

      // Set up global event listeners
      this.setupEventListeners();

      // Set up sync event listeners
      this.setupSyncListeners();

      this.isInitialized = true;
      console.log('App initialized successfully');
    } catch (error) {
      console.error('Failed to initialize app:', error);
      this.showError('Failed to initialize application', error);
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
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');

    // Set up login button handler (device flow only)
    const loginBtn = document.getElementById('deviceLoginBtn');
    if (loginBtn) {
      loginBtn.onclick = async () => {
        await this.startDeviceFlow();
      };
    }
  }

  /**
   * Start device code flow
   */
  async startDeviceFlow() {
    try {
      // Request device code
      const codeInfo = await oauthDevice.initiateDeviceFlow();

      // Show device code modal
      const modal = document.getElementById('deviceCodeModal');
      const verificationUrl = document.getElementById('verificationUrl');
      const deviceCodeDisplay = document.getElementById('deviceCodeDisplay');
      const copyCodeBtn = document.getElementById('copyCodeBtn');
      const openGitHubBtn = document.getElementById('openGitHubBtn');

      verificationUrl.textContent = codeInfo.verificationUri;
      deviceCodeDisplay.textContent = codeInfo.userCode;

      copyCodeBtn.onclick = async () => {
        await navigator.clipboard.writeText(codeInfo.userCode);
        copyCodeBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyCodeBtn.textContent = 'Copy Code';
        }, 2000);
      };

      openGitHubBtn.onclick = () => {
        window.open(codeInfo.verificationUri, '_blank');
      };

      modal.classList.remove('hidden');

      // Start polling
      try {
        await oauthDevice.pollForToken();

        // Success! Hide modal and show main app
        modal.classList.add('hidden');
        await this.showMainApp();
      } catch (error) {
        console.error('Device flow failed:', error);
        modal.classList.add('hidden');
        this.showError('Authentication failed', error);
      }
    } catch (error) {
      console.error('Failed to start device flow:', error);
      this.showError('Failed to start authentication', error);
    }
  }

  /**
   * Show main app after authentication
   */
  async showMainApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');

    // Update user info in header
    if (this.currentUser) {
      const userInfo = document.getElementById('userInfo');
      if (userInfo) {
        userInfo.textContent = `@${this.currentUser.login}`;
      }
    }

    // Initialize sync manager
    await syncManager.init();

    // Load or create bookmarks
    await this.loadBookmarks();

    // Initialize UI manager
    await uiManager.init();

    // Render bookmarks
    const tree = bookmarkManager.getTree();
    uiManager.renderBookmarks(tree);

    console.log('Main app loaded successfully');
  }

  /**
   * Load bookmarks from Gist or local storage
   */
  async loadBookmarks() {
    try {
      // First, try to sync from remote
      const updated = await syncManager.syncFromRemote();

      // Initialize bookmark manager
      await bookmarkManager.init();

      // If no bookmarks exist, show first-time setup
      const stats = bookmarkManager.getStats();
      if (stats.totalBookmarks === 0) {
        await this.showFirstTimeSetup();
      }
    } catch (error) {
      console.error('Failed to load bookmarks:', error);
      // Try to initialize with local data anyway
      await bookmarkManager.init();
    }
  }

  /**
   * Show first-time setup options
   */
  async showFirstTimeSetup() {
    // Check if user already has a Gist
    const gistId = await gistAdapter.findBookmarkGist();

    if (gistId) {
      // Found existing Gist, load it
      await syncManager.setGistId(gistId);
      await syncManager.syncFromRemote();
      await bookmarkManager.reload();
    } else {
      // No Gist found, show options
      // For now, just create an empty Gist
      const emptyTree = syncManager.getEmptyBookmarkTree();
      const newGistId = await gistAdapter.createBookmarkGist(emptyTree);
      await syncManager.setGistId(newGistId);
      console.log('Created new bookmark Gist:', newGistId);
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

// Export for debugging
window.app = app;
export default app;
