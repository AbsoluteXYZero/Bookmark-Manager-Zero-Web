/**
 * Sync Manager
 * Handles bidirectional sync between IndexedDB and remote storage (GitLab Snippet)
 * Implements version-based conflict detection to prevent data loss
 */

import dbManager from './indexeddb.js';
import snippetAdapter from './snippet-adapter.js';
import authManager from '../auth/auth-manager.js';
import { safeLocalStorage } from '../utils/storage-utils.js';

class SyncManager {
  constructor() {
    this.snippetId = null;
    this.provider = 'gitlab'; // Always GitLab
    this.deviceId = authManager.getDeviceId();
    this.syncInterval = null;
    this.isSyncing = false;
    this.hasUnsyncedChanges = false;
    this.lastSyncTime = null;
    this.autoSyncEnabled = true;
    this.minSyncInterval = 60000; // Minimum 60 seconds between syncs to avoid abuse detection
  }

  /**
   * Get the GitLab snippet adapter
   */
  getAdapter() {
    return snippetAdapter;
  }

  /**
   * Get the current remote ID (snippet)
   */
  getRemoteId() {
    return this.snippetId;
  }

  /**
   * Set the current provider (always gitlab)
   */
  async setProvider(provider) {
    this.provider = 'gitlab';
    await dbManager.put('metadata', { key: 'syncProvider', value: 'gitlab' });
    console.log('Sync provider set to: gitlab');
  }

  /**
   * Initialize the sync manager
   */
  async init() {
    // Prevent duplicate initialization
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    console.log('[Init] Sync manager initializing...');
    this.provider = await authManager.getPreference('syncProvider') || 'gitlab';
    console.log('Sync provider set to:', this.provider);

    // Initialize adapter
    this.adapter = snippetAdapter;
    // Note: snippetAdapter doesn't have setProvider method, it's always GitLab

    // Load snippet ID from storage
    const savedId = this.adapter.loadSavedSnippetId();
    if (savedId) {
      this.snippetId = savedId;
      console.log('Loaded Snippet ID from storage:', savedId);
    }

    // Initialize auto-sync
    // Note: Auto-sync is disabled by default - we use event-driven sync only
    // to prevent rate limiting and account flagging
    console.log('[Init] Timer-based auto-sync disabled - using event-driven sync only');
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
      return { offline: true };
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.warn('No remote ID - cannot acquire lock');
      return { error: true };
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

      // Return the remote data so caller doesn't need to fetch again
      return { success: true, remoteData };
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
    console.log('[MarkChanged] Setting hasUnsyncedChanges = true');
    this.hasUnsyncedChanges = true;
    await this.markPendingChanges(true);

    // Trigger sync if online
    if (navigator.onLine) {
      // Debounce sync to avoid too many requests
      if (this.syncDebounceTimer) {
        clearTimeout(this.syncDebounceTimer);
      }
      this.syncDebounceTimer = setTimeout(async () => {
        // Check if we still have a valid remote ID before syncing
        if (!this.getRemoteId()) {
          console.log('[MarkChanged] No remote ID, skipping sync');
          return;
        }

        try {
          await this.syncToRemote();
          this.emitEvent('syncSuccess', 'Changes synced to remote');
        } catch (error) {
          console.error('Sync failed:', error);
          this.emitEvent('syncError', error.message || 'Failed to sync changes');
          // Retry after 5 seconds
          setTimeout(() => {
            if (this.hasUnsyncedChanges && navigator.onLine && this.getRemoteId()) {
              this.syncToRemote().catch(err => {
                console.error('Retry sync failed:', err);
                this.emitEvent('syncError', 'Sync retry failed. Changes will sync when connection improves.');
              });
            }
          }, 5000);
        }
      }, 30000); // Wait 30 seconds after last change to batch multiple edits and avoid abuse detection
    }
  }

  /**
   * Sync local changes to remote (push)
   */
  async syncToRemote() {
    console.log('[SyncToRemote] Called, checking conditions...');

    if (this.isSyncing) {
      console.log('[SyncToRemote] Sync already in progress, skipping...');
      return;
    }

    if (!navigator.onLine) {
      console.log('[SyncToRemote] Offline, cannot sync to remote');
      return;
    }

    const remoteId = this.getRemoteId();
    if (!remoteId) {
      console.log('[SyncToRemote] No remote ID, cannot sync');
      return;
    }

    // Rate limiting: prevent syncing more frequently than minSyncInterval
    const timeSinceLastSync = Date.now() - (this.lastSyncTime || 0);
    if (this.lastSyncTime && timeSinceLastSync < this.minSyncInterval) {
      const waitTime = Math.ceil((this.minSyncInterval - timeSinceLastSync) / 1000);
      console.log(`[SyncToRemote] Rate limit: Last sync was ${Math.ceil(timeSinceLastSync / 1000)}s ago. Please wait ${waitTime}s before syncing again.`);
      this.emitEvent('syncError', `Please wait ${waitTime} seconds before syncing again to avoid rate limits`);
      return;
    }

    console.log(`[SyncToRemote] All conditions passed. Provider: ${this.provider}, Remote ID: ${remoteId}`);
    this.isSyncing = true;

    // Cancel any pending debounced sync since we're doing an explicit sync now
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
      console.log('[SyncToRemote] Cancelled pending debounced sync');
    }

    try {
      console.log(`[SyncToRemote] Starting sync of local changes to ${this.provider}...`);

      // Check rate limits before syncing
      const adapter = this.getAdapter();
      const rateLimitStatus = adapter.getRateLimitStatus();
      if (rateLimitStatus.remaining !== null && rateLimitStatus.remaining < 10) {
        const resetDate = new Date(rateLimitStatus.reset * 1000);
        throw new Error(`API rate limit nearly exhausted (${rateLimitStatus.remaining} remaining). Sync will retry after ${resetDate.toLocaleTimeString()}`);
      }

      // Load local bookmark tree
      const localBookmarks = await this.loadLocalBookmarks();
      const bookmarkCount = this.countBookmarksInTree(localBookmarks);
      console.log(`[SyncToRemote] Loaded local bookmarks: ${bookmarkCount} total bookmarks`);

      // Get remote version (single read, no locking to reduce API calls)
      const remoteData = await adapter.readBookmarks(remoteId);
      const localVersion = await this.getLocalVersion();

      console.log(`[SyncToRemote] Version check - Local: ${localVersion}, Remote: ${remoteData.version}`);

      // Check for conflicts
      if (remoteData.version > localVersion) {
        console.warn('[SyncToRemote] Remote has newer changes! Conflict detected.');
        throw new Error('Sync conflict: Remote has newer changes. Please reload and try again.');
      }

      // Push local changes
      const newVersion = remoteData.version + 1;
      console.log(`[SyncToRemote] Pushing ${bookmarkCount} bookmarks to remote with version ${newVersion}...`);
      await adapter.updateBookmarks(remoteId, localBookmarks, newVersion);

      // Update local metadata
      await this.setLocalVersion(newVersion);
      await this.markPendingChanges(false);
      console.log('[SyncToRemote] Setting hasUnsyncedChanges = false');
      this.hasUnsyncedChanges = false;
      this.lastSyncTime = Date.now();
      await dbManager.put('metadata', { key: 'lastSync', value: this.lastSyncTime });

      console.log(`[SyncToRemote] Sync complete! Version ${newVersion} with ${bookmarkCount} bookmarks pushed to remote`);
    } catch (error) {
      console.error('Sync to remote failed:', error);

      // If the error is a 404 (Snippet not found), stop syncing
      if (error.message && error.message.includes('not found')) {
        console.warn('[SyncToRemote] Remote not found (404), aborting sync and clearing stored ID');
        this.hasUnsyncedChanges = false; // Clear the flag to prevent retry loops

        // Clear the stored snippet ID
        safeLocalStorage.removeItem('bmz_snippet_id');
        await dbManager.delete('metadata', 'snippetId');
        this.snippetId = null;
        snippetAdapter.snippetId = null;

        // Emit event to notify UI that setup is needed
        this.emitEvent('syncError', {
          error: 'Remote storage not found. Please set up sync again.',
          requiresSetup: true
        });
      }

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

    const rootFolderIds = ['toolbar_____', 'menu________', 'unfiled_____', 'mobile______', 'root________', '0', '1', '2', '3'];

    // Normalize folder titles to handle Chrome vs Firefox naming differences
    // IMPORTANT: Must use same normalization as Chrome/Firefox for cross-browser sync
    const normalizeTitle = (title) => {
      // Treat empty string and "Untitled" as equivalent (empty)
      if (!title || title === 'Untitled' || title === 'Untitled Folder') {
        return '';
      }

      const normalized = {
        'Bookmarks Toolbar': 'Bookmarks bar',   // Firefox → Chrome standard
        'Bookmarks bar': 'Bookmarks bar',        // Chrome → Chrome standard
        'Other Bookmarks': 'Other bookmarks',    // Normalize to Chrome's lowercase
        'Other bookmarks': 'Other bookmarks',    // Chrome → Chrome standard
        'Mobile Bookmarks': 'Mobile Bookmarks',
        'Bookmarks Menu': 'Bookmarks Menu'
      };
      return normalized[title] || title;
    };

    // Recursively map all items by content-based key (not ID, since different browsers use different IDs)
    const mapItems = (node, map, parentPath = '') => {
      if (!node) return;

      // Normalize title for consistent paths, then build path
      const normalizedTitle = normalizeTitle(node.title || '');
      const path = parentPath ? `${parentPath}/${normalizedTitle}` : normalizedTitle;

      // Don't include root folders themselves in the comparison, only their contents
      if (!rootFolderIds.includes(node.id)) {
        // Use content-based key instead of ID
        const isBookmark = node.url || node.type === 'bookmark';
        const key = isBookmark
          ? `bookmark:${node.url}:${path}`
          : `folder:${path}`;

        map.set(key, { node, path, parentId: node.parentId, originalId: node.id });
      }

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
    remoteMap.forEach((value, key) => {
      if (!localMap.has(key)) {
        diff.added.push({
          id: value.originalId,
          title: value.node.title || 'Untitled',
          url: value.node.url || null,
          path: value.path,
          type: value.node.url ? 'bookmark' : 'folder'
        });
      }
    });

    // Find removed items (in local, not in remote)
    localMap.forEach((value, key) => {
      if (!remoteMap.has(key)) {
        diff.removed.push({
          id: value.originalId,
          title: value.node.title || 'Untitled',
          url: value.node.url || null,
          path: value.path,
          type: value.node.url ? 'bookmark' : 'folder'
        });
      }
    });

    // Find moved/modified items
    localMap.forEach((localValue, key) => {
      const remoteValue = remoteMap.get(key);
      if (remoteValue) {
        // Check if the path changed (item moved to different folder)
        if (localValue.path !== remoteValue.path) {
          diff.moved.push({
            id: localValue.originalId,
            title: remoteValue.node.title || 'Untitled',
            url: remoteValue.node.url || null,
            oldPath: localValue.path,
            newPath: remoteValue.path,
            type: remoteValue.node.url ? 'bookmark' : 'folder'
          });
        }
        // Check if modified (different title or URL)
        // Normalize titles to ignore differences like empty string vs "Untitled"
        const normalizedLocalTitle = normalizeTitle(localValue.node.title || '');
        const normalizedRemoteTitle = normalizeTitle(remoteValue.node.title || '');
        const titleDiffers = normalizedLocalTitle !== normalizedRemoteTitle;
        const urlDiffers = localValue.node.url !== remoteValue.node.url;
        if (titleDiffers || urlDiffers) {
          diff.modified.push({
            id: localValue.originalId,
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

      // Check rate limits before syncing
      const adapter = this.getAdapter();
      const rateLimitStatus = adapter.getRateLimitStatus();
      if (rateLimitStatus.remaining !== null && rateLimitStatus.remaining < 10) {
        const resetDate = new Date(rateLimitStatus.reset * 1000);
        throw new Error(`API rate limit nearly exhausted (${rateLimitStatus.remaining} remaining). Sync will retry after ${resetDate.toLocaleTimeString()}`);
      }

      const remoteData = await adapter.readBookmarks(remoteId);
      const remoteBookmarkCount = this.countBookmarksInTree(remoteData);
      console.log('[SyncFromRemote] Remote data fetched:', {
        hasRoots: !!remoteData?.roots,
        rootKeys: remoteData?.roots ? Object.keys(remoteData.roots) : [],
        version: remoteData?.version,
        bookmarkCount: remoteBookmarkCount
      });

      const localData = await this.loadLocalBookmarks();
      const localBookmarkCount = this.countBookmarksInTree(localData);
      const localVersion = await this.getLocalVersion();
      console.log('[SyncFromRemote] Local version:', localVersion, 'Local bookmarks:', localBookmarkCount);

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
          modified: diff.modified.length,
          localVersion: localVersion,
          localBookmarkCount: localBookmarkCount
        });

        // If local version is 0 (first sync/reset), skip conflict detection - just pull everything
        const isFirstSync = localVersion === 0;

        if (isFirstSync) {
          console.log('[SyncFromRemote] First sync detected (version 0) - skipping conflict check, auto-pulling all data');
        }

        // Check if there are deletions AND this is not the first sync - require user confirmation
        if (diff.removed.length > 0 && !isFirstSync) {
          console.log('[SyncFromRemote] Deletions detected on subsequent sync - requiring user confirmation');
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

      // If the error is a 404 (Snippet not found), clear the stored ID
      if (error.message && error.message.includes('not found')) {
        console.warn('[SyncFromRemote] Remote not found (404), clearing stored ID');

        safeLocalStorage.removeItem('bmz_snippet_id');
        await dbManager.delete('metadata', 'snippetId');
        this.snippetId = null;
        snippetAdapter.snippetId = null;

        // Emit event to notify UI that setup is needed
        this.emitEvent('syncError', {
          error: 'Remote storage not found. Please set up sync again.',
          requiresSetup: true
        });
      }

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
    console.log('[SyncManager.loadLocalBookmarks] Loading from IndexedDB...');
    const bookmarksRecord = await dbManager.get('metadata', 'bookmarkTree');
    console.log('[SyncManager.loadLocalBookmarks] Retrieved:', bookmarksRecord);
    const result = bookmarksRecord ? bookmarksRecord.value : this.getEmptyBookmarkTree();
    console.log('[SyncManager.loadLocalBookmarks] Returning:', result);
    return result;
  }

  /**
   * Save bookmarks to IndexedDB
   */
  async saveLocalBookmarks(bookmarkTree) {
    console.log('[SyncManager.saveLocalBookmarks] Saving bookmarks to IndexedDB:', bookmarkTree);
    try {
      await dbManager.put('metadata', { key: 'bookmarkTree', value: bookmarkTree });
      console.log('[SyncManager.saveLocalBookmarks] Successfully saved');
    } catch (error) {
      console.error('[SyncManager.saveLocalBookmarks] Failed to save:', error);
      throw error;
    }
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
   * Merge bookmarks from one tree into another tree
   * Preserves folder structure and merges into existing folders with same names
   */
  mergeBookmarksIntoTree(sourceTree, targetTree) {
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

      // Handle both tree structures (with roots) and flat arrays (legacy)
      if (sourceTree && sourceTree.roots) {
        // Source is a tree structure - merge each root
        console.log('[mergeBookmarksIntoTree] Merging tree structure...');

        ['bookmark_bar', 'menu', 'other', 'mobile'].forEach(rootKey => {
          const sourceRoot = sourceTree.roots[rootKey];
          const targetRoot = mergedTree.roots[rootKey];

          if (sourceRoot && sourceRoot.children && targetRoot) {
            if (!targetRoot.children) {
              targetRoot.children = [];
            }

            sourceRoot.children.forEach(child => {
              if (child.type === 'folder') {
                mergeFolder(child, targetRoot.children);
              } else if (child.url) {
                // Add bookmark if it doesn't already exist (by URL)
                const bookmarkExists = targetRoot.children.some(existingChild =>
                  existingChild.url === child.url
                );
                if (!bookmarkExists) {
                  targetRoot.children.push({
                    ...child,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    dateAdded: Date.now()
                  });
                  console.log(`[mergeBookmarksIntoTree] Added bookmark to ${rootKey}: ${child.title}`);
                } else {
                  console.log(`[mergeBookmarksIntoTree] Skipped duplicate bookmark in ${rootKey}: ${child.title}`);
                }
              }
            });
          }
        });
      } else if (sourceTree && Array.isArray(sourceTree)) {
        // Legacy: Source is a flat array - categorize into roots
        console.log('[mergeBookmarksIntoTree] Merging flat array...');

        const sourceRoots = {
          bookmark_bar: [],
          menu: [],
          other: [],
          mobile: []
        };

        sourceTree.forEach(bookmark => {
          if (bookmark.type === 'folder') {
            let targetRoot = 'other';
            const title = bookmark.title?.toLowerCase() || '';
            if (title.includes('toolbar') || title.includes('bar')) {
              targetRoot = 'bookmark_bar';
            } else if (title.includes('menu')) {
              targetRoot = 'menu';
            }
            sourceRoots[targetRoot].push(bookmark);
          } else if (bookmark.url) {
            sourceRoots.other.push(bookmark);
          }
        });

        Object.keys(sourceRoots).forEach(rootKey => {
          const sourceItems = sourceRoots[rootKey];
          const targetRoot = mergedTree.roots[rootKey];

          if (sourceItems.length > 0 && targetRoot && targetRoot.children) {
            sourceItems.forEach(item => {
              if (item.type === 'folder') {
                mergeFolder(item, targetRoot.children);
              } else if (item.url) {
                const bookmarkExists = targetRoot.children.some(existingChild =>
                  existingChild.url === item.url
                );
                if (!bookmarkExists) {
                  targetRoot.children.push({
                    ...item,
                    id: `merged-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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
   * Set Snippet ID (GitLab)
   */
  async setSnippetId(snippetId) {
    this.snippetId = snippetId;
    this.provider = 'gitlab';

    snippetAdapter.setSnippetId(snippetId);
    await dbManager.put('metadata', { key: 'snippetId', value: snippetId });
    await this.setProvider('gitlab');
    console.log('Snippet ID saved:', snippetId);
  }

  /**
   * Count total bookmarks in a tree (for logging)
   */
  countBookmarksInTree(tree) {
    if (!tree || !tree.roots) return 0;

    let count = 0;
    const countInNode = (node) => {
      if (node.type === 'bookmark' || node.url) {
        count++;
      }
      if (node.children) {
        node.children.forEach(child => countInNode(child));
      }
    };

    Object.values(tree.roots).forEach(root => countInNode(root));
    return count;
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
   * Start auto-sync (poll every 5 minutes when online)
   */
  async startAutoSync() {
    if (this.syncInterval) {
      return; // Already running
    }

    // Use 5 minutes (300000ms) to avoid rate limiting and account flagging
    const syncIntervalMs = 300000; // 5 minutes
    console.log('Starting auto-sync (immediate + 5-minute interval)...');

    // Perform initial sync immediately
    if (navigator.onLine && !this.isSyncing) {
      const remoteId = this.getRemoteId();
      if (remoteId) {
        try {
          console.log('[AutoSync] Running initial sync...');
          // First, push any local changes if needed
          if (this.hasUnsyncedChanges) {
            console.log('[AutoSync] Initial - Unsynced changes detected, pushing to remote...');
            await this.syncToRemote();
          }
          // Then, pull remote changes
          await this.syncFromRemote();
        } catch (error) {
          console.error('[AutoSync] Initial sync failed:', error);
          this.emitEvent('syncError', 'Initial auto-sync failed: ' + error.message);
        }
      } else {
        console.log('[AutoSync] Skipping initial sync - no remote storage configured');
      }
    }

    // Then start the interval for subsequent syncs
    this.syncInterval = setInterval(async () => {
      if (navigator.onLine && !this.isSyncing) {
        // Check if we have a remote ID configured before trying to sync
        const remoteId = this.getRemoteId();
        if (!remoteId) {
          console.log('[AutoSync] Skipping scheduled sync - no remote storage configured');
          return;
        }

        try {
          // First, push any local changes if needed
          console.log(`[AutoSync] Scheduled - hasUnsyncedChanges: ${this.hasUnsyncedChanges}`);
          if (this.hasUnsyncedChanges) {
            console.log('[AutoSync] Scheduled - Unsynced changes detected, pushing to remote...');
            await this.syncToRemote();
          }
          // Then, pull remote changes
          await this.syncFromRemote();
        } catch (error) {
          console.error('[AutoSync] Scheduled sync failed:', error);
          this.emitEvent('syncError', 'Auto-sync failed: ' + error.message);
        }
      }
    }, syncIntervalMs);
  }

  /**
   * Manual sync trigger - bidirectional
   * @param {boolean} forcePush - Force push local changes even if hasUnsyncedChanges is false
   */
  async manualSync(forcePush = false) {
    if (this.isSyncing) {
      console.log('[ManualSync] Sync already in progress');
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
      console.log(`[ManualSync] Starting (forcePush: ${forcePush}, hasUnsyncedChanges: ${this.hasUnsyncedChanges})`);

      // Push local changes first
      if (this.hasUnsyncedChanges || forcePush) {
        console.log('[ManualSync] Pushing local changes to remote...');
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
   * Subscribe to sync events (wrapper around window.addEventListener)
   * @param {string} eventName - Event name without 'sync:' prefix
   * @param {function} handler - Event handler function
   */
  on(eventName, handler) {
    const wrappedHandler = (event) => handler(event.detail);
    window.addEventListener(`sync:${eventName}`, wrappedHandler);
    return wrappedHandler; // Return for potential cleanup
  }

  /**
   * Unsubscribe from sync events (wrapper around window.removeEventListener)
   * @param {string} eventName - Event name without 'sync:' prefix
   * @param {function} handler - The wrapped handler returned from on()
   */
  off(eventName, handler) {
    window.removeEventListener(`sync:${eventName}`, handler);
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
