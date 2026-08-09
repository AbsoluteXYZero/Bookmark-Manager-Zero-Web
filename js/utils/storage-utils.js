/**
 * Storage Utilities
 * Handles changelog, encrypted API keys, and other storage operations
 */

import { encryptApiKey, decryptApiKey } from './encryption.js';

const MAX_CHANGELOG_ENTRIES = 1000;

/* [ZeroLabs] 2026-08-09 1:31 PM - added: recent saved-into folder MRU */
const RECENT_FOLDERS_KEY = 'bmz_recentFolders';
const MAX_RECENT_FOLDERS = 6;

/**
 * Read the most-recently-saved-into folder IDs, newest first.
 * Only folders a bookmark was actually saved into are recorded --
 * merely browsing/expanding a folder is deliberately not counted.
 * @returns {string[]}
 */
export function getRecentFolders() {
  try {
    const raw = safeLocalStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(id => typeof id === 'string' && id.length > 0);
  } catch (e) {
    console.warn('[RecentFolders] Failed to parse stored list:', e.message);
    return [];
  }
}

/**
 * Record a folder as most-recently-saved-into.
 * @param {string} folderId
 */
export function recordRecentFolder(folderId) {
  if (!folderId) return;
  try {
    const next = [folderId, ...getRecentFolders().filter(id => id !== folderId)]
      .slice(0, MAX_RECENT_FOLDERS);
    safeLocalStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[RecentFolders] Failed to record folder:', e.message);
  }
}

/**
 * Safe localStorage wrapper for Edge compatibility
 * Handles SecurityError when localStorage is blocked
 */
export const safeLocalStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn(`localStorage.getItem("${key}") failed:`, e.message);
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.warn(`localStorage.setItem("${key}") failed:`, e.message);
      return false;
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.warn(`localStorage.removeItem("${key}") failed:`, e.message);
      return false;
    }
  },
  clear() {
    try {
      localStorage.clear();
      return true;
    } catch (e) {
      console.warn('localStorage.clear() failed:', e.message);
      return false;
    }
  }
};

/**
 * Store encrypted API key in localStorage
 */
async function storeEncryptedApiKey(keyName, apiKey) {
  const encrypted = await encryptApiKey(apiKey);
  if (encrypted) {
    safeLocalStorage.setItem(keyName, encrypted);
    return true;
  }
  return false;
}

/**
 * Get and decrypt API key from localStorage
 */
async function getDecryptedApiKey(keyName) {
  const encrypted = safeLocalStorage.getItem(keyName);
  if (encrypted) {
    return await decryptApiKey(encrypted);
  }
  return null;
}

/**
 * Add an entry to the changelog
 */
async function addChangelogEntry(type, itemType, title, url = null, details = {}) {
  try {
    const entry = {
      id: Date.now(),
      type,
      itemType,
      timestamp: Date.now(),
      title,
      url,
      details
    };

    const changelogStr = safeLocalStorage.getItem('changelogEntries');
    let changelogEntries = changelogStr ? JSON.parse(changelogStr) : [];

    changelogEntries.unshift(entry);

    if (changelogEntries.length > MAX_CHANGELOG_ENTRIES) {
      changelogEntries = changelogEntries.slice(0, MAX_CHANGELOG_ENTRIES);
    }

    safeLocalStorage.setItem('changelogEntries', JSON.stringify(changelogEntries));
    console.log('[Changelog] Added entry:', entry);
  } catch (error) {
    console.error('[Changelog] Failed to add entry:', error);
  }
}

/**
 * Get all changelog entries
 */
async function getChangelogEntries() {
  try {
    const changelogStr = safeLocalStorage.getItem('changelogEntries');
    return changelogStr ? JSON.parse(changelogStr) : [];
  } catch (error) {
    console.error('[Changelog] Failed to get entries:', error);
    return [];
  }
}

/**
 * Clear all changelog entries
 */
async function clearChangelog() {
  try {
    safeLocalStorage.removeItem('changelogEntries');
    console.log('[Changelog] Cleared all entries');
  } catch (error) {
    console.error('[Changelog] Failed to clear entries:', error);
  }
}

export {
  storeEncryptedApiKey,
  getDecryptedApiKey,
  addChangelogEntry,
  getChangelogEntries,
  clearChangelog
};
