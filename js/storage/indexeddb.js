/**
 * IndexedDB wrapper for Bookmark Manager Zero
 * Provides offline storage for bookmarks, cache, settings, and blocklists
 */

const DB_NAME = 'bmz_storage';
const DB_VERSION = 2; // Incremented to fix cache keyPath bug

class IndexedDBManager {
  constructor() {
    this.db = null;
    this.initPromise = null;
  }

  /**
   * Initialize IndexedDB with all required object stores
   */
  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('IndexedDB failed to open:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('IndexedDB opened successfully');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log('IndexedDB upgrade needed, creating object stores...');

        // 1. Bookmarks store - hierarchical bookmark tree
        if (!db.objectStoreNames.contains('bookmarks')) {
          const bookmarksStore = db.createObjectStore('bookmarks', { keyPath: 'id' });
          bookmarksStore.createIndex('parentId', 'parentId', { unique: false });
          bookmarksStore.createIndex('url', 'url', { unique: false });
          bookmarksStore.createIndex('title', 'title', { unique: false });
          console.log('Created bookmarks store');
        }

        // 2. Metadata store - Snippet ID, sync status, edit locks
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
          console.log('Created metadata store');
        }

        // 3. Cache store - Link/safety status (7-day TTL)
        // Note: Using composite key 'cacheKey' (url + type) to allow multiple cache types per URL
        if (!db.objectStoreNames.contains('cache')) {
          const cacheStore = db.createObjectStore('cache', { keyPath: 'cacheKey' });
          cacheStore.createIndex('url', 'url', { unique: false });
          cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
          cacheStore.createIndex('type', 'type', { unique: false });
          console.log('Created cache store');
        } else if (event.oldVersion < 2) {
          // Migrate from version 1 to version 2: recreate cache store with new keyPath
          db.deleteObjectStore('cache');
          const cacheStore = db.createObjectStore('cache', { keyPath: 'cacheKey' });
          cacheStore.createIndex('url', 'url', { unique: false });
          cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
          cacheStore.createIndex('type', 'type', { unique: false });
          console.log('Migrated cache store to use composite key');
        }

        // 4. Settings store - Theme, preferences, encrypted API keys
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
          console.log('Created settings store');
        }

        // 5. Blocklists store - Security blocklists (~1.35M domains)
        if (!db.objectStoreNames.contains('blocklists')) {
          const blocklistsStore = db.createObjectStore('blocklists', { keyPath: 'source' });
          blocklistsStore.createIndex('lastUpdate', 'lastUpdate', { unique: false });
          console.log('Created blocklists store');
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Generic get operation
   */
  async get(storeName, key) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Generic put operation (insert or update)
   */
  async put(storeName, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Generic delete operation
   */
  async delete(storeName, key) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all records from a store
   */
  async getAll(storeName) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all records from a store
   */
  async clear(storeName) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get records by index
   */
  async getAllByIndex(storeName, indexName, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Count records in a store
   */
  async count(storeName) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Batch put operation for efficiency
   */
  async batchPut(storeName, values) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      let completed = 0;
      const total = values.length;

      values.forEach(value => {
        const request = store.put(value);
        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });

      // Handle empty array
      if (total === 0) {
        resolve();
      }
    });
  }

  /**
   * Clean old cache entries (7-day TTL)
   */
  async cleanOldCache() {
    await this.init();
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['cache'], 'readwrite');
      const store = transaction.objectStore('cache');
      const index = store.index('timestamp');
      const range = IDBKeyRange.upperBound(sevenDaysAgo);
      const request = index.openCursor(range);

      let deletedCount = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        } else {
          console.log(`Cleaned ${deletedCount} old cache entries`);
          resolve(deletedCount);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get cache size estimate
   */
  async getCacheSize() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return { usage: 0, quota: 0 };
    }

    try {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage || 0,
        quota: estimate.quota || 0,
        usageFormatted: this.formatBytes(estimate.usage || 0),
        quotaFormatted: this.formatBytes(estimate.quota || 0)
      };
    } catch (error) {
      console.error('Failed to estimate storage:', error);
      return { usage: 0, quota: 0 };
    }
  }

  /**
   * Format bytes to human-readable string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Delete the entire database (for debugging/reset)
   */
  static async deleteDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => {
        console.log('Database deleted successfully');
        resolve();
      };
      request.onerror = () => {
        console.error('Failed to delete database:', request.error);
        reject(request.error);
      };
      request.onblocked = () => {
        console.warn('Database deletion blocked');
      };
    });
  }
}

// Export singleton instance
const dbManager = new IndexedDBManager();
export default dbManager;

// Also export the class for testing
export { IndexedDBManager };
