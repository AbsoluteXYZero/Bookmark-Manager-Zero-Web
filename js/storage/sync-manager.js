/**
 * Sync Manager
 * Handles bidirectional sync between IndexedDB and remote storage (GitHub Gist or GitLab Snippet)
 * Implements edit locking to prevent concurrent modifications across devices
 */

import dbManager from './indexeddb.js';
import gistAdapter from './gist-adapter.js';
import snippetAdapter from './snippet-adapter.js';
import authManager from '../auth/auth-manager.js';

class SyncManager {
  constructor() {
    this.gistId = null;
    this.snippetId = null;
    this.provider = null; // 'github' or 'gitlab'
    this.deviceId = authManager.getDeviceId();
    this.syncInterval = null;
    this.isSyncing = false;
    this.hasUnsyncedChanges = false;
    this.lastSyncTime = null;
    this.autoSyncEnabled = true;
  }

  /**
   * Get the appropriate adapter based on current provider
   */
  getAdapter() {
    if (this.provider === 'gitlab') {
      return snippetAdapter;
    }
    // Default to GitHub
    return gistAdapter;
  }

  /**
   * Get the current remote ID (gist or snippet)
   */
  getRemoteId() {
    if (this.provider === 'gitlab') {
      return this.snippetId;
    }
    return this.gistId;
  }

  /**
   * Set the current provider
   */
  async setProvider(provider) {
    this.provider = provider;
    await dbManager.put('metadata', { key: 'syncProvider', value: provider });
    console.log('Sync provider set to:', provider);
  }

  /**
   * Initialize sync manager
   * Loads provider, Gist/Snippet ID from metadata and starts auto-sync
   */
  async init() {
    try {
      // Load sync provider
      const providerRecord = await dbManager.get('metadata', 'syncProvider');
      if (providerRecord) {
        this.provider = providerRecord.value;
        console.log('Loaded sync provider from storage:', this.provider);
      }

      // Load Gist ID from metadata
      const gistIdRecord = await dbManager.get('metadata', 'gistId');
      if (gistIdRecord) {
        this.gistId = gistIdRecord.value;
        gistAdapter.setGistId(this.gistId);
        console.log('Loaded Gist ID from storage:', this.gistId);

        // If no provider set but we have a gist ID, assume GitHub
        if (!this.provider) {
          this.provider = 'github';
          await this.setProvider('github');
        }
      }

      // Load Snippet ID from metadata
      const snippetIdRecord = await dbManager.get('metadata', 'snippetId');
      if (snippetIdRecord) {
        this.snippetId = snippetIdRecord.value;
        snippetAdapter.setSnippetId(this.snippetId);
        console.log('Loaded Snippet ID from storage:', this.snippetId);

        // If no provider set but we have a snippet ID, assume GitLab
        if (!this.provider) {
          this.provider = 'gitlab';
          await this.setProvider('gitlab');
        }
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

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.warn('No remote ID - cannot acquire lock');
      return false;
    }

    try {
      // Read current remote data
      const adapter = this.getAdapter();
      const remoteData = await adapter.readBookmarks(remoteId);
      const currentLock = remoteData.editLock;

      // Check if locked by another device
      if (currentLock && currentLock.deviceId !== this.deviceId) {
        throw new Error(
          `Bookmarks are currently being edited on another device. ` +
          `Please wait a moment and try again.`
        );
      }

      // Acquire/refresh lock
      remoteData.editLock = {
        deviceId: this.deviceId,
        timestamp: Date.now()
      };

      await adapter.updateBookmarks(remoteId, remoteData, remoteData.version);
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
    const remoteId = this.getRemoteId();
    if (!navigator.onLine || !remoteId) {
      return;
    }

    try {
      const adapter = this.getAdapter();
      const remoteData = await adapter.readBookmarks(remoteId);

      if (remoteData.editLock?.deviceId === this.deviceId) {
        delete remoteData.editLock;
        await adapter.updateBookmarks(remoteId, remoteData, remoteData.version);
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
      this.syncDebounceTimer = setTimeout(async () => {
        try {
          await this.syncToRemote();
          this.emitEvent('syncSuccess', 'Changes synced to remote');
        } catch (error) {
          console.error('Sync failed:', error);
          this.emitEvent('syncError', error.message || 'Failed to sync changes');
          // Retry after 5 seconds
          setTimeout(() => {
            if (this.hasUnsyncedChanges && navigator.onLine) {
              this.syncToRemote().catch(err => {
                console.error('Retry sync failed:', err);
                this.emitEvent('syncError', 'Sync retry failed. Changes will sync when connection improves.');
              });
            }
          }, 5000);
        }
      }, 1000); // Wait 1 second after last change
    }
  }

  /**
   * Sync local changes to remote (push)
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

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.log('No remote ID, cannot sync');
      return;
    }

    this.isSyncing = true;

    try {
      console.log(`Syncing local changes to ${this.provider}...`);

      // Acquire lock
      await this.acquireLock();

      // Load local bookmark tree
      const localBookmarks = await this.loadLocalBookmarks();

      // Get remote version
      const adapter = this.getAdapter();
      const remoteData = await adapter.readBookmarks(remoteId);
      const localVersion = await this.getLocalVersion();

      // Check for conflicts
      if (remoteData.version > localVersion) {
        console.warn('Remote has newer changes! Conflict detected.');
        throw new Error('Sync conflict: Remote has newer changes. Please reload and try again.');
      }

      // Push local changes
      const newVersion = remoteData.version + 1;
      await adapter.updateBookmarks(remoteId, localBookmarks, newVersion);

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
   * Calculate diff between local and remote bookmark trees
   * Returns: { added: [], removed: [], moved: [], modified: [] }
   */
  calculateBookmarkDiff(localTree, remoteTree) {
    const diff = {
      added: [],
      removed: [],
      moved: [],
      modified: []
    };

    // Create ID maps for quick lookup
    const localMap = new Map();
    const remoteMap = new Map();

    // Recursively map all items by ID
    const mapItems = (node, map, parentPath = '') => {
      if (!node) return;

      const path = parentPath ? `${parentPath}/${node.title || node.id}` : (node.title || node.id);
      map.set(node.id, { node, path, parentId: node.parentId });

      if (node.children) {
        node.children.forEach(child => mapItems(child, map, path));
      }
    };

    // Map local tree
    if (localTree?.roots) {
      Object.values(localTree.roots).forEach(root => mapItems(root, localMap));
    }

    // Map remote tree
    if (remoteTree?.roots) {
      Object.values(remoteTree.roots).forEach(root => mapItems(root, remoteMap));
    }

    // Find added items (in remote, not in local)
    remoteMap.forEach((value, id) => {
      if (!localMap.has(id)) {
        diff.added.push({
          id,
          title: value.node.title || 'Untitled',
          url: value.node.url || null,
          path: value.path,
          type: value.node.url ? 'bookmark' : 'folder'
        });
      }
    });

    // Find removed items (in local, not in remote)
    localMap.forEach((value, id) => {
      if (!remoteMap.has(id)) {
        diff.removed.push({
          id,
          title: value.node.title || 'Untitled',
          url: value.node.url || null,
          path: value.path,
          type: value.node.url ? 'bookmark' : 'folder'
        });
      }
    });

    // Find moved/modified items
    localMap.forEach((localValue, id) => {
      const remoteValue = remoteMap.get(id);
      if (remoteValue) {
        // Check if moved (parent changed)
        if (localValue.parentId !== remoteValue.parentId) {
          diff.moved.push({
            id,
            title: remoteValue.node.title || 'Untitled',
            url: remoteValue.node.url || null,
            oldPath: localValue.path,
            newPath: remoteValue.path,
            type: remoteValue.node.url ? 'bookmark' : 'folder'
          });
        }
        // Check if modified (title or url changed)
        else if (localValue.node.title !== remoteValue.node.title ||
                 localValue.node.url !== remoteValue.node.url) {
          diff.modified.push({
            id,
            oldTitle: localValue.node.title || 'Untitled',
            newTitle: remoteValue.node.title || 'Untitled',
            oldUrl: localValue.node.url || null,
            newUrl: remoteValue.node.url || null,
            path: remoteValue.path,
            type: remoteValue.node.url ? 'bookmark' : 'folder'
          });
        }
      }
    });

    return diff;
  }

  /**
   * Sync remote changes to local (pull)
   */
  async syncFromRemote() {
    if (this.isSyncing) {
      console.log('[SyncFromRemote] Already syncing, skipping...');
      return;
    }

    if (!navigator.onLine) {
      console.log('[SyncFromRemote] Offline, skipping...');
      return;
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.log('[SyncFromRemote] No remote ID, skipping...');
      return;
    }

    this.isSyncing = true;

    try {
      console.log(`[SyncFromRemote] Starting sync for ${this.provider}:`, remoteId);

      const adapter = this.getAdapter();
      const remoteData = await adapter.readBookmarks(remoteId);
      console.log('[SyncFromRemote] Remote data fetched:', {
        hasRoots: !!remoteData?.roots,
        rootKeys: remoteData?.roots ? Object.keys(remoteData.roots) : [],
        version: remoteData?.version
      });

      const localVersion = await this.getLocalVersion();
      console.log('[SyncFromRemote] Local version:', localVersion);

      // Sync if remote is newer OR if local is empty (version 0)
      if (remoteData.version > localVersion || localVersion === 0) {
        console.log(`[SyncFromRemote] Remote version (${remoteData.version}) >= Local version (${localVersion}), pulling changes...`);

        // Get current local data for diff
        const localData = await this.getLocalBookmarks();

        // Calculate diff
        const diff = this.calculateBookmarkDiff(localData, remoteData);
        console.log('[SyncFromRemote] Changes detected:', {
          added: diff.added.length,
          removed: diff.removed.length,
          moved: diff.moved.length,
          modified: diff.modified.length
        });

        // Check if there are deletions - require user confirmation
        if (diff.removed.length > 0) {
          // Emit event with diff data for UI to handle
          this.emitEvent('syncConflict', {
            diff,
            remoteData,
            requiresConfirmation: true,
            message: `Remote has ${diff.removed.length} deletion(s). Review changes before syncing.`
          });

          this.isSyncing = false;
          return false; // Don't auto-sync, wait for user confirmation
        }

        // No deletions - auto-sync with notification
        if (diff.added.length > 0 || diff.moved.length > 0 || diff.modified.length > 0) {
          // Emit event with diff data
          this.emitEvent('syncChanges', {
            diff,
            remoteData,
            requiresConfirmation: false,
            message: `Remote has ${diff.added.length} addition(s), ${diff.moved.length} move(s), ${diff.modified.length} modification(s).`
          });
        }

        // Save remote data to local
        await this.saveLocalBookmarks(remoteData);
        console.log('[SyncFromRemote] Saved remote data to IndexedDB');

        await this.setLocalVersion(remoteData.version);
        console.log('[SyncFromRemote] Updated local version to:', remoteData.version);

        this.lastSyncTime = Date.now();
        await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

        console.log('[SyncFromRemote] Sync complete, version:', remoteData.version);
        return true; // Indicate that data was updated
      } else {
        console.log('[SyncFromRemote] Local is up to date (local:', localVersion, ', remote:', remoteData.version, ')');
        return false;
      }
    } catch (error) {
      console.error('[SyncFromRemote] Sync failed:', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Apply remote sync manually (after user confirmation)
   */
  async applyRemoteSync(remoteData) {
    try {
      // Save remote data to local
      await this.saveLocalBookmarks(remoteData);
      console.log('[ApplyRemoteSync] Saved remote data to IndexedDB');

      await this.setLocalVersion(remoteData.version);
      console.log('[ApplyRemoteSync] Updated local version to:', remoteData.version);

      this.lastSyncTime = Date.now();
      await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

      console.log('[ApplyRemoteSync] Manual sync applied successfully');
      this.emitEvent('syncSuccess', 'Bookmarks updated from remote');

      return true;
    } catch (error) {
      console.error('[ApplyRemoteSync] Failed to apply sync:', error);
      this.emitEvent('syncError', error.message);
      return false;
    }
  }

  /**
   * Get local bookmarks (alias for loadLocalBookmarks for diff calculation)
   */
  async getLocalBookmarks() {
    return await this.loadLocalBookmarks();
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
   * Set Gist ID (GitHub)
   */
  async setGistId(gistId) {
    this.gistId = gistId;
    this.provider = 'github';

    // Clear GitLab snippet data when switching to GitHub
    // (This handles manual provider switches after login)
    if (this.snippetId) {
      this.snippetId = null;
      snippetAdapter.snippetId = null;
      localStorage.removeItem('bmz_snippet_id');
      await dbManager.delete('metadata', 'snippetId');
      console.log('Cleared GitLab snippet data during provider switch');
    }

    gistAdapter.setGistId(gistId);
    await dbManager.put('metadata', { key: 'gistId', value: gistId });
    await this.setProvider('github');
    console.log('Gist ID saved:', gistId);
  }

  /**
   * Set Snippet ID (GitLab)
   */
  async setSnippetId(snippetId) {
    this.snippetId = snippetId;
    this.provider = 'gitlab';

    // Clear GitHub gist data when switching to GitLab
    // (This handles manual provider switches after login)
    if (this.gistId) {
      this.gistId = null;
      gistAdapter.gistId = null;
      localStorage.removeItem('bmz_gist_id');
      await dbManager.delete('metadata', 'gistId');
      console.log('Cleared GitHub gist data during provider switch');
    }

    snippetAdapter.setSnippetId(snippetId);
    await dbManager.put('metadata', { key: 'snippetId', value: snippetId });
    await this.setProvider('gitlab');
    console.log('Snippet ID saved:', snippetId);
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
          title: 'Bookmarks Toolbar',
          name: 'Bookmarks Toolbar',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        },
        menu: {
          id: '2',
          title: 'Bookmarks Menu',
          name: 'Bookmarks Menu',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        },
        other: {
          id: '3',
          title: 'Other Bookmarks',
          name: 'Other Bookmarks',
          type: 'folder',
          dateAdded: Date.now(),
          children: []
        },
        mobile: {
          id: '4',
          title: 'Mobile Bookmarks',
          name: 'Mobile Bookmarks',
          type: 'folder',
          dateAdded: Date.now(),
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
          // First, push any local changes if needed
          if (this.hasUnsyncedChanges) {
            await this.syncToRemote();
          }
          // Then, pull remote changes
          await this.syncFromRemote();
        } catch (error) {
          console.error('Auto-sync failed:', error);
          this.emitEvent('syncError', 'Auto-sync failed: ' + error.message);
        }
      }
    }, 60000); // Every 60 seconds
  }

  /**
   * Manual sync trigger - bidirectional
   */
  async manualSync() {
    if (this.isSyncing) {
      console.log('Sync already in progress');
      return;
    }

    if (!navigator.onLine) {
      this.emitEvent('syncError', 'Cannot sync while offline');
      return;
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      this.emitEvent('syncError', 'No remote storage configured');
      return;
    }

    try {
      // Push local changes first
      if (this.hasUnsyncedChanges) {
        await this.syncToRemote();
      }
      // Then pull remote changes
      const updated = await this.syncFromRemote();

      if (updated || this.hasUnsyncedChanges) {
        this.emitEvent('syncSuccess', 'Manual sync complete');
      } else {
        this.emitEvent('syncSuccess', 'Already up to date');
      }
    } catch (error) {
      console.error('Manual sync failed:', error);
      this.emitEvent('syncError', 'Manual sync failed: ' + error.message);
    }
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
      provider: this.provider,
      gistId: this.gistId,
      snippetId: this.snippetId,
      remoteId: this.getRemoteId(),
      deviceId: this.deviceId
    };
  }
}

// Export singleton instance
const syncManager = new SyncManager();
export default syncManager;

// Also export the class for testing
export { SyncManager };
