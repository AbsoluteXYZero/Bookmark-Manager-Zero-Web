/**
 * Scanner Service
 * Coordinates with Web Worker for background scanning
 * Manages caching and batch processing
 */

import dbManager from '../storage/indexeddb.js';
import bookmarkManager from './bookmarks.js';
import uiManager from './ui.js';
import blocklistService from './blocklist-service.js';

class ScannerService {
  constructor() {
    this.worker = null;
    this.isScanning = false;
    this.scanQueue = [];
    this.scannedCount = 0;
    this.totalCount = 0;
    this.cacheExpiryDays = 7;
    this.workerInitialized = false;
  }

  /**
   * Initialize scanner service
   */
  async init() {
    try {
      // Initialize Web Worker
      this.worker = new Worker('workers/scanner-worker.js');

      // Set up message handler
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);

      // Set up error handler
      this.worker.onerror = (error) => {
        console.error('Scanner worker error:', error);
      };

      console.log('Scanner service initialized');

      // Initialize worker with API keys and blocklist
      await this.initializeWorker();

      // Restore cached statuses for all bookmarks (bookmarks should be loaded before scanner init)
      await this.restoreCachedStatuses();
    } catch (error) {
      console.error('Failed to initialize scanner worker:', error);
      // Gracefully degrade - scanning just won't work
    }
  }

  /**
   * Restore cached scan results from IndexedDB to all bookmarks
   */
  async restoreCachedStatuses() {
    try {
      if (!window.bookmarkManager) {
        console.log('[Scanner] BookmarkManager not available, skipping cache restore');
        return;
      }

      const allBookmarks = window.bookmarkManager.getAllBookmarks();
      let restored = 0;
      let linkRestored = 0;
      let safetyRestored = 0;

      console.log(`[Scanner] Starting cache restore for ${allBookmarks.length} bookmarks...`);

      for (const bookmark of allBookmarks) {
        if (!bookmark.url) continue;

        // Load cached link status
        if (!bookmark.linkStatus) {
          const cachedLink = await this.getCachedResult(bookmark.url, 'link');
          if (cachedLink) {
            bookmark.linkStatus = cachedLink;
            linkRestored++;
            console.log(`[Scanner] Restored link status "${cachedLink}" for ${bookmark.title || bookmark.url}`);
          }
        }

        // Load cached safety status
        if (!bookmark.safetyStatus) {
          const cachedSafety = await this.getCachedResult(bookmark.url, 'safety');
          if (cachedSafety) {
            bookmark.safetyStatus = cachedSafety.status;
            bookmark.safetySources = cachedSafety.sources || [];
            safetyRestored++;
            console.log(`[Scanner] Restored safety status "${cachedSafety.status}" for ${bookmark.title || bookmark.url}`);
          }
        }
      }

      restored = linkRestored + safetyRestored;
      console.log(`[Scanner] Cache restore complete: ${linkRestored} link statuses, ${safetyRestored} safety statuses (${restored} total) for ${allBookmarks.length} bookmarks`);

      // Trigger UI re-render if any statuses were restored
      if (restored > 0 && window.renderBookmarks) {
        console.log('[Scanner] Triggering UI re-render to show cached statuses');
        window.renderBookmarks();
      }
    } catch (error) {
      console.error('[Scanner] Failed to restore cached statuses:', error);
    }
  }

  /**
   * Initialize worker with API keys and blocklist data
   */
  async initializeWorker() {
    if (!this.worker) return;

    try {
      // Get API keys from localStorage (they're stored encrypted)
      const apiKeys = {
        googleSafeBrowsingApiKey: await this.getDecryptedApiKey('googleSafeBrowsingApiKey'),
        yandexApiKey: await this.getDecryptedApiKey('yandexApiKey'),
        virusTotalApiKey: await this.getDecryptedApiKey('virusTotalApiKey')
      };

      // Ensure blocklist is loaded
      await blocklistService.ensureBlocklistReady();

      // Get blocklist data
      const blocklistArray = Array.from(blocklistService.maliciousUrlsSet);
      const domainSourceMapArray = Array.from(blocklistService.domainSourceMap.entries());
      const domainOnlyMapArray = Array.from(blocklistService.domainOnlyMap.entries());
      const trustedDomains = blocklistService.TRUSTED_DOMAINS;

      // Send initialization data to worker
      this.worker.postMessage({
        action: 'init',
        data: {
          apiKeys,
          blocklist: blocklistArray,
          domainSourceMap: domainSourceMapArray,
          domainOnlyMap: domainOnlyMapArray,
          trustedDomains
        }
      });

      console.log('Worker initialization data sent');
    } catch (error) {
      console.error('Failed to initialize worker with data:', error);
    }
  }

  /**
   * Get derived encryption key
   */
  async getDerivedKey() {
    const password = window.location.origin;
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('bookmark-manager-salt'),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Decrypt API key
   */
  async decryptApiKey(encrypted) {
    if (!encrypted) return null;
    try {
      const key = await this.getDerivedKey();
      const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        data
      );
      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('Decryption failed:', error);
      return null;
    }
  }

  /**
   * Get decrypted API key from storage
   */
  async getDecryptedApiKey(keyName) {
    try {
      const encrypted = localStorage.getItem(keyName);
      if (encrypted) {
        return await this.decryptApiKey(encrypted);
      }
      return null;
    } catch (error) {
      console.error(`Failed to get API key ${keyName}:`, error);
      return null;
    }
  }

  /**
   * Handle messages from Web Worker
   */
  handleWorkerMessage(e) {
    const { action, data } = e.data;

    switch (action) {
      case 'initComplete':
        this.workerInitialized = true;
        console.log('Worker initialization complete');
        break;

      case 'linkResult':
        this.handleLinkResult(data);
        break;

      case 'safetyResult':
        this.handleSafetyResult(data);
        break;

      case 'scanComplete':
        this.handleScanComplete(data);
        break;

      case 'linkError':
      case 'safetyError':
      case 'scanError':
        this.handleScanError(data);
        break;

      default:
        console.warn('Unknown worker action:', action);
    }
  }

  /**
   * Handle link status result
   */
  async handleLinkResult(data) {
    const { id, url, status } = data;

    // Cache result
    await this.cacheResult(url, status, 'link');

    // Update bookmark in memory
    const bookmark = bookmarkManager.getBookmark(id);
    if (bookmark) {
      bookmark.linkStatus = status;
    }

    // Update UI
    this.updateProgress();
  }

  /**
   * Handle safety status result
   */
  async handleSafetyResult(data) {
    const { id, url, status, sources } = data;

    // Cache result
    await this.cacheResult(url, { status, sources }, 'safety');

    // Update bookmark in memory
    const bookmark = bookmarkManager.getBookmark(id);
    if (bookmark) {
      bookmark.safetyStatus = status;
      bookmark.safetySources = sources;
    }

    // Update UI
    this.updateProgress();
  }

  /**
   * Handle complete scan result
   */
  async handleScanComplete(data) {
    const { id, url, linkStatus, safetyStatus, safetySources } = data;

    // Cache both results
    await this.cacheResult(url, linkStatus, 'link');
    await this.cacheResult(url, { status: safetyStatus, sources: safetySources }, 'safety');

    // Update bookmark in tree using global function
    if (window.updateBookmarkInTree) {
      window.updateBookmarkInTree(id, {
        linkStatus,
        safetyStatus,
        safetySources
      });
    }

    this.scannedCount++;
    this.updateProgress();

    // Update UI efficiently (just the status indicators, no full re-render)
    if (window.updateBookmarkStatusInDOM) {
      window.updateBookmarkStatusInDOM(id, linkStatus, safetyStatus, safetySources, url);
    }

    // Process next in queue
    this.processQueue();
  }

  /**
   * Handle scan error
   */
  handleScanError(data) {
    console.error('Scan error for', data.url, ':', data.error);
    this.scannedCount++;
    this.updateProgress();
    this.processQueue();
  }

  /**
   * Cache scan result
   */
  async cacheResult(url, result, type) {
    try {
      const now = Date.now();
      const expiresAt = now + (this.cacheExpiryDays * 24 * 60 * 60 * 1000);

      await dbManager.put('cache', {
        cacheKey: `${url}::${type}`, // Composite key: url + type
        url: url,
        type: type,
        result: result,
        timestamp: now,
        expiresAt: expiresAt
      });
    } catch (error) {
      console.error('Failed to cache result:', error);
    }
  }

  /**
   * Get cached result
   */
  async getCachedResult(url, type) {
    try {
      const cacheKey = `${url}::${type}`; // Composite key: url + type
      const record = await dbManager.get('cache', cacheKey);
      if (record) {
        // Check if expired
        if (Date.now() < record.expiresAt) {
          return record.result;
        } else {
          // Expired, delete it
          await dbManager.delete('cache', cacheKey);
        }
      }
      return null;
    } catch (error) {
      console.error('Failed to get cached result:', error);
      return null;
    }
  }

  /**
   * Scan a single bookmark
   */
  async scanBookmark(bookmark, bypassCache = false) {
    if (!this.worker || !bookmark.url) return;

    // Check cache first
    if (!bypassCache) {
      const cachedLink = await this.getCachedResult(bookmark.url, 'link');
      const cachedSafety = await this.getCachedResult(bookmark.url, 'safety');

      if (cachedLink && cachedSafety) {
        console.log(`[Scanner] Using cached results for ${bookmark.url}`);
        bookmark.linkStatus = cachedLink;
        bookmark.safetyStatus = cachedSafety.status;
        bookmark.safetySources = cachedSafety.sources;

        // Update bookmark in tree using global function
        if (window.updateBookmarkInTree) {
          window.updateBookmarkInTree(bookmark.id, {
            linkStatus: cachedLink,
            safetyStatus: cachedSafety.status,
            safetySources: cachedSafety.sources
          });
        }

        // Update UI to show cached status
        if (window.updateBookmarkStatusInDOM) {
          window.updateBookmarkStatusInDOM(bookmark.id, cachedLink, cachedSafety.status, cachedSafety.sources, bookmark.url);
        }

        return;
      }
    }

    // Send to worker
    this.worker.postMessage({
      action: 'scanBookmark',
      data: {
        id: bookmark.id,
        url: bookmark.url
      }
    });
  }

  /**
   * Scan all bookmarks
   */
  async scanAllBookmarks(bypassCache = false) {
    if (this.isScanning) {
      console.log('Scan already in progress');
      return;
    }

    this.isScanning = true;
    this.scannedCount = 0;
    this.bypassCache = bypassCache;

    // Get all bookmarks
    const allBookmarks = bookmarkManager.getAllBookmarks();
    this.totalCount = allBookmarks.length;

    console.log(`Starting scan of ${this.totalCount} bookmarks (bypassCache: ${bypassCache})`);

    // Add to queue
    this.scanQueue = [...allBookmarks];

    // Start processing queue with batch limit
    this.processQueue();
  }

  /**
   * Process scan queue with batch limit
   */
  processQueue() {
    if (this.scanQueue.length === 0) {
      this.isScanning = false;
      console.log('Scan complete');
      this.updateProgress('Scan complete');
      return;
    }

    // Process up to 10 bookmarks at a time
    const batchSize = 10;
    const batch = this.scanQueue.splice(0, batchSize);

    batch.forEach(bookmark => {
      this.scanBookmark(bookmark, this.bypassCache || false);
    });

    // Delay next batch by 300ms to avoid overwhelming the network
    setTimeout(() => {
      if (this.scanQueue.length > 0) {
        this.processQueue();
      }
    }, 300);
  }

  /**
   * Update scan progress
   */
  updateProgress(message = null) {
    const progressEl = document.getElementById('scanProgress');
    if (progressEl) {
      if (message) {
        progressEl.textContent = message;
      } else if (this.isScanning) {
        progressEl.textContent = `Scanning... ${this.scannedCount}/${this.totalCount}`;
      } else {
        progressEl.textContent = 'Ready';
      }
    }
  }

  /**
   * Scan bookmarks in a folder
   */
  async scanFolder(folder, bypassCache = false) {
    if (!folder.children) return;

    const bookmarksInFolder = [];

    const collectBookmarks = (node) => {
      if (node.type === 'bookmark' && node.url) {
        bookmarksInFolder.push(node);
      } else if (node.children) {
        node.children.forEach(collectBookmarks);
      }
    };

    collectBookmarks(folder);

    console.log(`Scanning ${bookmarksInFolder.length} bookmarks in folder "${folder.title}"`);

    this.scanQueue = [...bookmarksInFolder];
    this.totalCount = bookmarksInFolder.length;
    this.scannedCount = 0;
    this.isScanning = true;

    this.processQueue();
  }

  /**
   * Stop current scan
   */
  stopScan() {
    this.scanQueue = [];
    this.isScanning = false;
    this.updateProgress('Scan stopped');
  }
}

// Export singleton instance
const scannerService = new ScannerService();
export default scannerService;

// Also export the class for testing
export { ScannerService };
