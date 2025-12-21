/**
 * Storage Utilities
 * Handles changelog, encrypted API keys, and other storage operations
 */

import { encryptApiKey, decryptApiKey } from './encryption.js';

const MAX_CHANGELOG_ENTRIES = 1000;

/**
 * Store encrypted API key in localStorage
 */
async function storeEncryptedApiKey(keyName, apiKey) {
  const encrypted = await encryptApiKey(apiKey);
  if (encrypted) {
    localStorage.setItem(keyName, encrypted);
    return true;
  }
  return false;
}

/**
 * Get and decrypt API key from localStorage
 */
async function getDecryptedApiKey(keyName) {
  const encrypted = localStorage.getItem(keyName);
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

    const changelogStr = localStorage.getItem('changelogEntries');
    let changelogEntries = changelogStr ? JSON.parse(changelogStr) : [];

    changelogEntries.unshift(entry);

    if (changelogEntries.length > MAX_CHANGELOG_ENTRIES) {
      changelogEntries = changelogEntries.slice(0, MAX_CHANGELOG_ENTRIES);
    }

    localStorage.setItem('changelogEntries', JSON.stringify(changelogEntries));
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
    const changelogStr = localStorage.getItem('changelogEntries');
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
    localStorage.removeItem('changelogEntries');
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
