/**
 * Bookmark Manager
 * Handles in-memory bookmark tree operations
 * Replaces browser.bookmarks.* API from extensions
 */

import dbManager from '../storage/indexeddb.js';
import syncManager from '../storage/sync-manager.js';

class BookmarkManager {
  constructor() {
    this.tree = null;
    this.initialized = false;
    /* [ZeroLabs] 2026-08-27 - added: real bookmark events (see also: Bookmark-Manager-Zero-Chrome/background.js) */
    // The extensions decide what is safe to sync from what the browser told them
    // the user did: an addition this device watched you make is yours to push, one
    // it never saw came from elsewhere. The website had no such signal, because
    // browser.bookmarks.onCreated and friends were empty stubs in the adapter.
    // This is that signal.
    this._listeners = { created: [], removed: [], changed: [], moved: [], replaced: [] };
  }

  /* [ZeroLabs] 2026-08-27 - added: subscribe to bookmark mutations */
  // Mirrors browser.bookmarks.on*.addListener, which is what the adapter in
  // sidebar-adapted.js now maps onto, so ported extension code works unchanged.
  addListener(kind, fn) {
    if (!this._listeners[kind]) this._listeners[kind] = [];
    this._listeners[kind].push(fn);
  }

  // Also dispatched on window, so a module that cannot import this one without a
  // cycle (sync-manager, which this file imports) can still listen.
  _emit(kind, ...args) {
    (this._listeners[kind] || []).forEach(fn => {
      try {
        fn(...args);
      } catch (error) {
        console.error(`[BookmarkManager] ${kind} listener failed:`, error);
      }
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`bmz:bookmarks:${kind}`, { detail: args }));
    }
  }

  /**
   * Initialize bookmark manager
   * Load tree from storage or create new
   */
  async init() {
    try {
      // Try to load from IndexedDB first
      this.tree = await syncManager.loadLocalBookmarks();

      // If no tree exists, create empty structure
      if (!this.tree || !this.tree.roots) {
        this.tree = syncManager.getEmptyBookmarkTree();
        await syncManager.saveLocalBookmarks(this.tree);
      }

      this.initialized = true;
      console.log('Bookmark manager initialized with', this.countBookmarks(), 'bookmarks');
    } catch (error) {
      console.error('Failed to initialize bookmark manager:', error);
      throw error;
    }
  }

  /**
   * Get the entire bookmark tree
   */
  getTree() {
    return this.tree;
  }

  /**
   * Get a specific folder by ID
   */
  getFolder(folderId) {
    if (!this.tree) return null;

    // Check root folders
    for (const root of Object.values(this.tree.roots)) {
      if (root.id === folderId) return root;

      // Search recursively
      const found = this.findNode(root, folderId);
      if (found) return found;
    }

    return null;
  }

  /**
   * Get a specific bookmark by ID
   */
  getBookmark(bookmarkId) {
    if (!this.tree) return null;

    for (const root of Object.values(this.tree.roots)) {
      const found = this.findNode(root, bookmarkId);
      if (found) return found;
    }

    return null;
  }

  /**
   * Get children of a folder
   * @param {string} folderId - Folder ID (or null/undefined for roots)
   * @returns {Array} Array of children nodes
   */
  getChildren(folderId) {
    if (!this.tree) return [];

    // If no ID provided, return root folders as array
    if (!folderId || folderId === '0' || folderId === 'root____') {
      return Object.values(this.tree.roots);
    }

    // Find the folder and return its children
    const folder = this.getFolder(folderId);
    return folder?.children || [];
  }

  /**
   * Recursively find a node by ID
   */
  findNode(node, targetId) {
    if (node.id === targetId) {
      return node;
    }

    if (node.children) {
      for (const child of node.children) {
        const found = this.findNode(child, targetId);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Find parent folder of a bookmark/folder
   */
  findParent(childId) {
    if (!this.tree) return null;

    for (const root of Object.values(this.tree.roots)) {
      const parent = this.findParentInNode(root, childId);
      if (parent) return parent;
    }

    return null;
  }

  /**
   * Helper to find parent in a subtree
   */
  findParentInNode(node, childId) {
    if (node.children) {
      for (const child of node.children) {
        if (child.id === childId) {
          return node;
        }
        const found = this.findParentInNode(child, childId);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Create a new bookmark or folder
   * @param {Object} details - { parentId, title, url, index, type }
   * @returns {Object} Created bookmark/folder
   */
  async create(details) {
    if (!this.initialized) {
      throw new Error('Bookmark manager not initialized');
    }

    const { parentId, title, url, index, type = url ? 'bookmark' : 'folder' } = details;

    // Validate parent exists
    const parent = this.getFolder(parentId);
    if (!parent) {
      throw new Error(`Parent folder not found: ${parentId}`);
    }

    // Generate unique ID
    const id = this.generateId();

    // Create new node
    const newNode = {
      id,
      title: title || 'Untitled',
      type,
      dateAdded: Date.now()
    };

    if (type === 'bookmark') {
      newNode.url = url;
    } else {
      newNode.children = [];
    }

    // Insert at specified index or end
    if (!parent.children) {
      parent.children = [];
    }

    if (typeof index === 'number' && index >= 0 && index <= parent.children.length) {
      parent.children.splice(index, 0, newNode);
    } else {
      parent.children.push(newNode);
    }

    // Update tree metadata
    this.tree.lastModified = Date.now();

    // Save and sync
    await this.saveChanges();

    console.log(`Created ${type}:`, newNode);

    /* [ZeroLabs] 2026-08-27 - added: tell sync this device made the addition */
    this._emit('created', newNode.id, newNode);

    // If this is a bookmark (not a folder), trigger automatic scan
    /* [ZeroLabs] 2026-08-09 1:31 PM - edited: no auto-scan in share window */
    if (type === 'bookmark' && window.scannerService && !window.__bmzShareMode) {
      console.log('[BookmarkManager] New bookmark created, triggering automatic scan...');
      // Use setTimeout to avoid blocking
      setTimeout(() => {
        window.scannerService.scanBookmark(newNode, false).catch(err => {
          console.error('[BookmarkManager] Auto-scan of new bookmark failed:', err);
        });
      }, 200);
    }

    return newNode;
  }

  /**
   * Update a bookmark or folder
   * @param {string} id - Bookmark/folder ID
   * @param {Object} changes - { title, url }
   */
  async update(id, changes) {
    if (!this.initialized) {
      throw new Error('Bookmark manager not initialized');
    }

    const node = this.getBookmark(id);
    if (!node) {
      throw new Error(`Bookmark/folder not found: ${id}`);
    }

    // Apply changes
    if (changes.title !== undefined) {
      node.title = changes.title;
    }

    if (changes.url !== undefined) {
      if (node.type !== 'bookmark') {
        throw new Error('Cannot set URL on a folder');
      }
      node.url = changes.url;
    }

    node.dateModified = Date.now();

    // Update tree metadata
    this.tree.lastModified = Date.now();

    // Save and sync
    await this.saveChanges();

    console.log('Updated bookmark/folder:', node);

    /* [ZeroLabs] 2026-08-27 - added: a rename made here is meant to travel */
    // Same payload shape as chrome.bookmarks.onChanged: the fields as they now
    // stand, which is all the recorder needs to key the edit by URL.
    this._emit('changed', id, { title: node.title, url: node.url });

    return node;
  }

  /**
   * Move a bookmark or folder
   * @param {string} id - Bookmark/folder ID to move
   * @param {Object} destination - { parentId, index }
   */
  async move(id, destination) {
    if (!this.initialized) {
      throw new Error('Bookmark manager not initialized');
    }

    const { parentId, index } = destination;

    // Get the node to move
    const node = this.getBookmark(id);
    if (!node) {
      throw new Error(`Bookmark/folder not found: ${id}`);
    }

    // Get old parent
    const oldParent = this.findParent(id);
    if (!oldParent) {
      throw new Error('Cannot move root folders');
    }

    // Get new parent
    const newParent = this.getFolder(parentId);
    if (!newParent) {
      throw new Error(`Destination folder not found: ${parentId}`);
    }

    // Prevent moving folder into itself or its descendants
    if (node.type === 'folder') {
      if (this.isDescendant(node, parentId)) {
        throw new Error('Cannot move folder into itself or its descendants');
      }
    }

    // Remove from old parent
    const oldIndex = oldParent.children.indexOf(node);
    if (oldIndex !== -1) {
      oldParent.children.splice(oldIndex, 1);
    }

    // Insert into new parent
    if (!newParent.children) {
      newParent.children = [];
    }

    if (typeof index === 'number' && index >= 0 && index <= newParent.children.length) {
      newParent.children.splice(index, 0, node);
    } else {
      newParent.children.push(node);
    }

    // Update tree metadata
    this.tree.lastModified = Date.now();

    // Save and sync
    await this.saveChanges();

    console.log(`Moved ${node.type} "${node.title}" to ${newParent.title}`);

    /* [ZeroLabs] 2026-08-27 - added: a move made here is meant to travel */
    // chrome.bookmarks.onMoved carries only parent ids, so the recorder looks the
    // URL up. A folder move arrives as one event, and the bookmarks inside it are
    // what the comparison actually sees change path.
    this._emit('moved', id, { parentId, oldParentId: oldParent.id, index });

    return node;
  }

  /**
   * Remove a bookmark or folder
   * @param {string} id - Bookmark/folder ID to remove
   */
  async remove(id) {
    if (!this.initialized) {
      throw new Error('Bookmark manager not initialized');
    }

    // Get the node
    const node = this.getBookmark(id);
    if (!node) {
      throw new Error(`Bookmark/folder not found: ${id}`);
    }

    // Get parent
    const parent = this.findParent(id);
    if (!parent) {
      throw new Error('Cannot delete root folders');
    }

    /* [ZeroLabs] 2026-08-27 - added: snapshot the subtree before it is gone */
    // Deleting a folder is one event covering everything inside it, and once the
    // splice has happened those URLs are unrecoverable. The recorder walks
    // node.children, so the snapshot has to be taken here and taken whole.
    const snapshot = JSON.parse(JSON.stringify(node));

    // Remove from parent's children
    const index = parent.children.indexOf(node);
    if (index !== -1) {
      parent.children.splice(index, 1);
    }

    // Update tree metadata
    this.tree.lastModified = Date.now();

    // Save and sync
    await this.saveChanges();

    console.log(`Removed ${node.type} "${node.title}"`);

    this._emit('removed', id, { node: snapshot, parentId: parent.id });

    return true;
  }

  /**
   * Check if targetId is a descendant of folder
   */
  isDescendant(folder, targetId) {
    if (!folder.children) return false;

    for (const child of folder.children) {
      if (child.id === targetId) return true;
      if (child.type === 'folder' && this.isDescendant(child, targetId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Search bookmarks by title or URL
   * @param {string} query - Search query
   * @returns {Array} Matching bookmarks
   */
  search(query) {
    if (!this.tree) return [];

    // Early exit for empty queries - avoid unnecessary traversal
    if (!query || query.trim() === '') return [];

    const results = [];
    const lowerQuery = query.toLowerCase().trim();

    const searchNode = (node) => {
      if (node.type === 'bookmark') {
        const titleMatch = node.title.toLowerCase().includes(lowerQuery);
        const urlMatch = node.url && node.url.toLowerCase().includes(lowerQuery);

        if (titleMatch || urlMatch) {
          results.push(node);
        }
      }

      if (node.children) {
        node.children.forEach(searchNode);
      }
    };

    Object.values(this.tree.roots).forEach(searchNode);
    return results;
  }

  /**
   * Get all bookmarks (flat list)
   */
  getAllBookmarks() {
    if (!this.tree) return [];

    const bookmarks = [];

    const collectBookmarks = (node) => {
      if (node.type === 'bookmark') {
        bookmarks.push(node);
      }

      if (node.children) {
        node.children.forEach(collectBookmarks);
      }
    };

    Object.values(this.tree.roots).forEach(collectBookmarks);
    return bookmarks;
  }

  /**
   * Count total bookmarks
   */
  countBookmarks() {
    return this.getAllBookmarks().length;
  }

  /**
   * Get all folders (flat list)
   */
  getAllFolders() {
    if (!this.tree) return [];

    const folders = [];

    const collectFolders = (node) => {
      if (node.type === 'folder') {
        folders.push(node);
      }

      if (node.children) {
        node.children.forEach(collectFolders);
      }
    };

    Object.values(this.tree.roots).forEach(collectFolders);
    return folders;
  }

  /**
   * Generate unique bookmark ID
   * Format: bmz_timestamp_random
   */
  generateId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `bmz_${timestamp}_${random}`;
  }

  /**
   * Save changes to storage and trigger sync
   */
  async saveChanges() {
    try {
      // Save to IndexedDB
      await syncManager.saveLocalBookmarks(this.tree);

      // Mark as changed for sync
      await syncManager.markChanged();

      console.log('Bookmark changes saved and marked for sync');
    } catch (error) {
      console.error('Failed to save bookmark changes:', error);
      throw error;
    }
  }

  /**
   * Reload bookmarks from storage
   * Useful after sync or import
   */
  async reload() {
    try {
      console.log('[BookmarkManager.reload] Loading from storage...');
      this.tree = await syncManager.loadLocalBookmarks();
      console.log('[BookmarkManager.reload] Loaded tree:', {
        hasTree: !!this.tree,
        hasRoots: !!this.tree?.roots,
        rootKeys: this.tree?.roots ? Object.keys(this.tree.roots) : [],
        bookmarkCount: this.countBookmarks(),
        folderCount: this.getAllFolders().length
      });
      return this.tree;
    } catch (error) {
      console.error('[BookmarkManager.reload] Failed:', error);
      throw error;
    }
  }

  /**
   * Replace entire bookmark tree
   * Used for imports
   */
  /* [ZeroLabs] 2026-08-27 - edited: say whether the replacement is the user's doing */
  // An import is a pile of additions this device made, so they push. Taking the
  // snippet's copy wholesale is the opposite: nothing in the result is this
  // device's change, and attributing it would push it straight back out.
  async replaceTree(newTree, { attribute = true } = {}) {
    try {
      // Validate tree structure
      if (!newTree.roots) {
        throw new Error('Invalid bookmark tree: missing roots');
      }

      const oldTree = this.tree;
      this.tree = newTree;
      this.tree.lastModified = Date.now();

      // Save and sync
      await this.saveChanges();

      console.log('Bookmark tree replaced successfully');

      this._emit('replaced', { oldTree, newTree: this.tree, attribute });

      return this.tree;
    } catch (error) {
      console.error('Failed to replace bookmark tree:', error);
      throw error;
    }
  }

  /**
   * Export bookmark tree as JSON
   */
  exportToJSON() {
    if (!this.tree) {
      throw new Error('No bookmarks to export');
    }

    return JSON.stringify(this.tree, null, 2);
  }

  /**
   * Clear all bookmarks and reset to empty tree
   */
  async clear() {
    try {
      const oldTree = this.tree;
      this.tree = syncManager.getEmptyBookmarkTree();
      await this.saveChanges();
      console.log('All bookmarks cleared');
      /* [ZeroLabs] 2026-08-27 - added: clearing is never this device's edit */
      // Its one caller empties the tree so the snippet can be pulled in over it.
      // Attributing that would record every bookmark as deleted here, and the
      // next reconcile would offer to delete them from the snippet too.
      this._emit('replaced', { oldTree, newTree: this.tree, attribute: false });
      return this.tree;
    } catch (error) {
      console.error('Failed to clear bookmarks:', error);
      throw error;
    }
  }

  /**
   * Get statistics about bookmark tree
   */
  getStats() {
    const bookmarks = this.getAllBookmarks();
    const folders = this.getAllFolders();

    return {
      totalBookmarks: bookmarks.length,
      totalFolders: folders.length,
      lastModified: this.tree?.lastModified,
      version: this.tree?.version
    };
  }
}

// Export singleton instance
const bookmarkManager = new BookmarkManager();
export default bookmarkManager;

// Also export the class for testing
export { BookmarkManager };
