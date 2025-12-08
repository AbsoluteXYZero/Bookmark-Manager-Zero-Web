/**
 * Storage Adapter
 * Provides a unified interface for storage operations
 * Replaces browser.storage.local.* calls from extensions
 */

import dbManager from './indexeddb.js';

class StorageAdapter {
  /**
   * Get a value from storage
   * Mimics browser.storage.local.get() API
   */
  async get(keys) {
    // Support single key or array of keys
    const keyArray = Array.isArray(keys) ? keys : [keys];
    const result = {};

    for (const key of keyArray) {
      const record = await dbManager.get('settings', key);
      if (record) {
        result[key] = record.value;
      }
    }

    return result;
  }

  /**
   * Set values in storage
   * Mimics browser.storage.local.set() API
   */
  async set(items) {
    const promises = [];

    for (const [key, value] of Object.entries(items)) {
      promises.push(dbManager.put('settings', { key, value }));
    }

    await Promise.all(promises);
  }

  /**
   * Remove values from storage
   * Mimics browser.storage.local.remove() API
   */
  async remove(keys) {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    const promises = keyArray.map(key => dbManager.delete('settings', key));
    await Promise.all(promises);
  }

  /**
   * Clear all storage
   * Mimics browser.storage.local.clear() API
   */
  async clear() {
    await dbManager.clear('settings');
  }

  /**
   * Get storage size estimate
   */
  async getBytesInUse() {
    const size = await dbManager.getCacheSize();
    return size.usage;
  }
}

// Export singleton instance
const storage = new StorageAdapter();
export default storage;

// Also export the class for testing
export { StorageAdapter };
