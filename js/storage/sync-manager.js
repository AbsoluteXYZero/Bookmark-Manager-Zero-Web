/**
 * Sync Manager
 * Handles bidirectional sync between IndexedDB and GitHub Gist
 * Implements edit locking to prevent concurrent modifications across devices
 */

import dbManager from './indexeddb.js';
import gistAdapter from './gist-adapter.js';
import authManager from '../auth/auth-manager.js';

class SyncManager {
  constructor() {
    this.gistId = null;
    this.deviceId = authManager.getDeviceId();
    this.syncInterval = null;
    this.isSyncing = false;
    this.hasUnsyncedChanges = false;
    this.lastSyncTime = null;
    this.autoSyncEnabled = true;
  }

  /**
   * Initialize sync manager
   * Loads Gist ID from metadata and starts auto-sync
   */
  async init() {
    try {
      // Load Gist ID from metadata
      const gistIdRecord = await dbManager.get('metadata', 'gistId');
      if (gistIdRecord) {
        this.gistId = gistIdRecord.value;
        gistAdapter.setGistId(this.gistId);
        console.log('Loaded Gist ID from storage:', this.gistId);
      }

      // Load last sync time
      const lastSyncRecord = await dbManager.get('metadata', 'lastSync');
      if (lastSyncRecord) {
        this.lastSyncTime = lastSyncRecord.value;
      }

      // Start auto-sync if online
      if (navigator.onLine && this.autoSyncEnabled) {
        this.startAutoSync();
      }

      // Listen for online/offline events
      window.addEventListener('online', () => this.handleOnline());
      window.addEventListener('offline', () => this.handleOffline());

      console.log('Sync manager initialized');
    } catch (error) {
      console.error('Failed to initialize sync manager:', error);
      throw error;
    }
  }

  /**
   * Acquire edit lock before making changes
   * Prevents concurrent edits across devices
   */
  async acquireLock() {
    if (!navigator.onLine) {
      // Offline: allow edits but mark as pending
      await this.markPendingChanges(true);
      console.log('Offline mode: changes marked as pending');
      return true;
    }

    if (!this.gistId) {
      console.warn('No Gist ID - cannot acquire lock');
      return false;
    }

    try {
      // Read current Gist data
      const gistData = await gistAdapter.readBookmarks(this.gistId);
      const currentLock = gistData.editLock;

      // Check if locked by another device
      if (currentLock && currentLock.deviceId !== this.deviceId) {
        const lockAge = Date.now() - currentLock.timestamp;
        const thirtyMinutes = 30 * 60 * 1000;

        // Auto-release locks older than 30 minutes
        if (lockAge < thirtyMinutes) {
          const remainingMinutes = Math.ceil((thirtyMinutes - lockAge) / 60000);
          throw new Error(
            `Bookmarks are locked by another device. ` +
            `Lock will expire in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}.`
          );
        }
      }

      // Acquire/refresh lock
      gistData.editLock = {
        deviceId: this.deviceId,
        timestamp: Date.now()
      };

      await gistAdapter.updateBookmarks(this.gistId, gistData, gistData.version);
      console.log('Edit lock acquired for device:', this.deviceId);
      return true;
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      throw error;
    }
  }

  /**
   * Release edit lock
   */
  async releaseLock() {
    if (!navigator.onLine || !this.gistId) {
      return;
    }

    try {
      const gistData = await gistAdapter.readBookmarks(this.gistId);

      if (gistData.editLock?.deviceId === this.deviceId) {
        delete gistData.editLock;
        await gistAdapter.updateBookmarks(this.gistId, gistData, gistData.version);
        console.log('Edit lock released');
      }
    } catch (error) {
      console.error('Failed to release lock:', error);
    }
  }

  /**
   * Mark that local changes need to be synced
   */
  async markChanged() {
    this.hasUnsyncedChanges = true;
    await this.markPendingChanges(true);

    // Trigger sync if online
    if (navigator.onLine) {
      // Debounce sync to avoid too many requests
      if (this.syncDebounceTimer) {
        clearTimeout(this.syncDebounceTimer);
      }
      this.syncDebounceTimer = setTimeout(() => {
        this.syncToRemote().catch(console.error);
      }, 1000); // Wait 1 second after last change
    }
  }

  /**
   * Sync local changes to Gist (push)
   */
  async syncToRemote() {
    if (this.isSyncing) {
      console.log('Sync already in progress, skipping...');
      return;
    }

    if (!navigator.onLine) {
      console.log('Offline, cannot sync to remote');
      return;
    }

    if (!this.gistId) {
      console.log('No Gist ID, cannot sync');
      return;
    }

    this.isSyncing = true;

    try {
      console.log('Syncing local changes to Gist...');

      // Acquire lock
      await this.acquireLock();

      // Load local bookmark tree
      const localBookmarks = await this.loadLocalBookmarks();

      // Get remote version
      const remoteData = await gistAdapter.readBookmarks(this.gistId);
      const localVersion = await this.getLocalVersion();

      // Check for conflicts
      if (remoteData.version > localVersion) {
        console.warn('Remote has newer changes! Conflict detected.');
        throw new Error('Sync conflict: Remote has newer changes. Please reload and try again.');
      }

      // Push local changes
      const newVersion = remoteData.version + 1;
      await gistAdapter.updateBookmarks(this.gistId, localBookmarks, newVersion);

      // Update local metadata
      await this.setLocalVersion(newVersion);
      await this.markPendingChanges(false);
      this.hasUnsyncedChanges = false;
      this.lastSyncTime = Date.now();
      await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

      console.log('Sync to remote complete, version:', newVersion);
    } catch (error) {
      console.error('Sync to remote failed:', error);
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync remote changes to local (pull)
   */
  async syncFromRemote() {
    if (this.isSyncing) {
      return;
    }

    if (!navigator.onLine) {
      return;
    }

    if (!this.gistId) {
      return;
    }

    this.isSyncing = true;

    try {
      console.log('Syncing remote changes to local...');

      const remoteData = await gistAdapter.readBookmarks(this.gistId);
      const localVersion = await this.getLocalVersion();

      if (remoteData.version > localVersion) {
        console.log(`Remote version (${remoteData.version}) > Local version (${localVersion}), pulling changes...`);

        // Save remote data to local
        await this.saveLocalBookmarks(remoteData);
        await this.setLocalVersion(remoteData.version);

        this.lastSyncTime = Date.now();
        await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

        console.log('Pulled remote changes, version:', remoteData.version);
        return true; // Indicate that data was updated
      } else {
        console.log('Local is up to date');
        return false;
      }
    } catch (error) {
      console.error('Sync from remote failed:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Load bookmarks from IndexedDB
   */
  async loadLocalBookmarks() {
    const bookmarksRecord = await dbManager.get('metadata', 'bookmarkTree');
    return bookmarksRecord ? bookmarksRecord.value : this.getEmptyBookmarkTree();
  }

  /**
   * Save bookmarks to IndexedDB
   */
  async saveLocalBookmarks(bookmarkTree) {
    await dbManager.put('metadata', { key: 'bookmarkTree', value: bookmarkTree });
  }

  /**
   * Get local version number
   */
  async getLocalVersion() {
    const versionRecord = await dbManager.get('metadata', 'localVersion');
    return versionRecord ? versionRecord.value : 0;
  }

  /**
   * Set local version number
   */
  async setLocalVersion(version) {
    await dbManager.put('metadata', { key: 'localVersion', value: version });
  }

  /**
   * Mark pending changes flag
   */
  async markPendingChanges(hasPending) {
    await dbManager.put('metadata', { key: 'hasPendingChanges', value: hasPending });
  }

  /**
   * Check if there are pending changes
   */
  async hasPendingChanges() {
    const record = await dbManager.get('metadata', 'hasPendingChanges');
    return record ? record.value : false;
  }

  /**
   * Set Gist ID
   */
  async setGistId(gistId) {
    this.gistId = gistId;
    gistAdapter.setGistId(gistId);
    await dbManager.put('metadata', { key: 'gistId', value: gistId });
    console.log('Gist ID saved:', gistId);
  }

  /**
   * Get empty bookmark tree structure
   */
  getEmptyBookmarkTree() {
    return {
      version: 1,
      checksum: '',
      lastModified: Date.now(),
      roots: {
        bookmark_bar: {
          id: '1',
          name: 'Bookmarks Bar',
          type: 'folder',
          children: []
        },
        other: {
          id: '2',
          name: 'Other Bookmarks',
          type: 'folder',
          children: []
        },
        mobile: {
          id: '3',
          name: 'Mobile Bookmarks',
          type: 'folder',
          children: []
        }
      }
    };
  }

  /**
   * Start auto-sync (poll every 60 seconds when online)
   */
  startAutoSync() {
    if (this.syncInterval) {
      return; // Already running
    }

    console.log('Starting auto-sync...');
    this.syncInterval = setInterval(async () => {
      if (navigator.onLine && !this.isSyncing) {
        try {
          await this.syncFromRemote();
        } catch (error) {
          console.error('Auto-sync failed:', error);
        }
      }
    }, 60000); // Every 60 seconds
  }

  /**
   * Stop auto-sync
   */
  stopAutoSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('Auto-sync stopped');
    }
  }

  /**
   * Handle coming back online
   */
  async handleOnline() {
    console.log('Back online, syncing...');

    // Show toast notification
    this.emitEvent('online');

    // Check for pending changes
    const hasPending = await this.hasPendingChanges();

    if (hasPending) {
      try {
        await this.syncToRemote();
        this.emitEvent('syncSuccess', 'Bookmarks synced successfully!');
      } catch (error) {
        console.error('Failed to sync pending changes:', error);
        this.emitEvent('syncError', error.message);
      }
    } else {
      // Just pull remote changes
      const updated = await this.syncFromRemote();
      if (updated) {
        this.emitEvent('syncSuccess', 'Bookmarks updated from remote');
      }
    }

    // Restart auto-sync
    if (this.autoSyncEnabled) {
      this.startAutoSync();
    }
  }

  /**
   * Handle going offline
   */
  handleOffline() {
    console.log('Offline detected');
    this.stopAutoSync();
    this.emitEvent('offline');
  }

  /**
   * Emit custom events for UI updates
   */
  emitEvent(eventName, data = null) {
    const event = new CustomEvent(`sync:${eventName}`, { detail: data });
    window.dispatchEvent(event);
  }

  /**
   * Get sync status for UI
   */
  getSyncStatus() {
    return {
      isOnline: navigator.onLine,
      isSyncing: this.isSyncing,
      hasUnsyncedChanges: this.hasUnsyncedChanges,
      lastSyncTime: this.lastSyncTime,
      gistId: this.gistId,
      deviceId: this.deviceId
    };
  }
}

// Export singleton instance
const syncManager = new SyncManager();
export default syncManager;

// Also export the class for testing
export { SyncManager };
