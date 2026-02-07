/**
 * Scanner Service
 * Coordinates with Web Worker for background scanning
 * Manages caching and batch processing
 */

import dbManager from '../storage/indexeddb.js';
import blocklistService from './blocklist-service.js';
import { decryptApiKey } from '../utils/encryption.js';
import { safeLocalStorage } from '../utils/storage-utils.js';

class ScannerService {
  constructor() {
    this.worker = null;
    this.isScanning = false;
    this.scanQueue = [];
    this.scannedCount = 0;
    this.totalCount = 0;
    this.cacheExpiryDays = 7;
    this.workerInitialized = false;
    this.urlsBeingScanned = new Set(); // Track URLs currently being scanned to prevent duplicates
  }

  /**
   * Initialize scanner service
   */
  async init() {
    try {
      // Initialize Web Worker with cache busting
      this.worker = new Worker(`workers/scanner-worker.js?v=${Date.now()}`);

      // Set up message handler
      this.worker.onmessage = (e) => this.handleWorkerMessage(e);

      // Set up error handler
      this.worker.onerror = (error) => {
        console.error('Scanner worker error:', error);
      };

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
   * Restore cached scan results from IndexedDB to all bookmarks (BATCHED)
   */
  async restoreCachedStatuses() {
    try {
      if (!window.bookmarkManager) {
        console.log('[Scanner] BookmarkManager not available, skipping cache restore');
        return;
      }

      const allBookmarks = window.bookmarkManager.getAllBookmarks();
      if (allBookmarks.length === 0) return;

      console.log(`[Scanner] Starting cache restore for ${allBookmarks.length} bookmarks...`);

      // Batch cache lookups to reduce IndexedDB operations
      const batchSize = 50; // Process 50 bookmarks at a time
      let processed = 0;
      let linkRestored = 0;
      let safetyRestored = 0;

      // Process bookmarks in batches to prevent blocking the UI
      for (let i = 0; i < allBookmarks.length; i += batchSize) {
        const batch = allBookmarks.slice(i, i + batchSize);

        // Process batch synchronously for better performance
        for (const bookmark of batch) {
          if (!bookmark.url) continue;

          // Load cached link status
          if (!bookmark.linkStatus) {
            const cachedLink = await this.getCachedResult(bookmark.url, 'link');
            if (cachedLink) {
              bookmark.linkStatus = cachedLink;
              linkRestored++;
            }
          }

          // Load cached safety status
          if (!bookmark.safetyStatus) {
            const cachedSafety = await this.getCachedResult(bookmark.url, 'safety');
            if (cachedSafety) {
              bookmark.safetyStatus = cachedSafety.status;
              bookmark.safetySources = cachedSafety.sources || [];
              safetyRestored++;
            }
          }
        }

        processed += batch.length;

        // Yield control to UI thread every 100 bookmarks
        if (processed % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      const restored = linkRestored + safetyRestored;

      // Only trigger UI re-render if significant number of statuses were restored
      if (restored > 0 && window.renderBookmarks) {
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

      console.log('API keys loaded:', {
        google: !!apiKeys.googleSafeBrowsingApiKey,
        yandex: !!apiKeys.yandexApiKey,
        virustotal: !!apiKeys.virusTotalApiKey
      });

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
    } catch (error) {
      console.error('Failed to initialize worker with data:', error);
    }
  }

  /**
   * Get decrypted API key from storage
   * Uses shared encryption utilities
   */
  async getDecryptedApiKey(keyName) {
    try {
      const encrypted = safeLocalStorage.getItem(keyName);
      if (encrypted) {
        return await decryptApiKey(encrypted);
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

      case 'batchScanComplete':
        this.handleBatchScanComplete(data);
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
    if (window.bookmarkManager) {
      const bookmark = window.bookmarkManager.getBookmark(id);
      if (bookmark) {
        bookmark.linkStatus = status;
      }
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
    if (window.bookmarkManager) {
      const bookmark = window.bookmarkManager.getBookmark(id);
      if (bookmark) {
        bookmark.safetyStatus = status;
        bookmark.safetySources = sources;
      }
    }

    // Update UI
    this.updateProgress();
  }

  /**
    * Handle complete scan result
    */
   async handleScanComplete(data) {
     const { id, url, linkStatus, safetyStatus, safetySources } = data;

     // Remove from tracking set
     this.urlsBeingScanned.delete(url);

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

     // Emit progress event
     window.dispatchEvent(new CustomEvent('scanProgress', {
       detail: { scanned: this.scannedCount, total: this.totalCount }
     }));

     // Update UI efficiently (just the status indicators, no full re-render)
     if (window.updateBookmarkStatusInDOM) {
       window.updateBookmarkStatusInDOM(id, linkStatus, safetyStatus, safetySources, url);
     }

     // Process next in queue
     this.processQueue();
   }

  /**
    * Handle batch scan results from worker
    */
   async handleBatchScanComplete(data) {
     const { results } = data;

     if (!results || results.length === 0) return;

     console.log(`[Scanner] Processing batch of ${results.length} scan results`);

     // Process all results in the batch
     for (const result of results) {
       const { id, url, linkStatus, safetyStatus, safetySources } = result;

       // Remove from tracking set
       this.urlsBeingScanned.delete(url);

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

       // Update UI efficiently (just the status indicator, no full re-render)
       if (window.updateBookmarkStatusInDOM) {
         window.updateBookmarkStatusInDOM(id, linkStatus, safetyStatus, safetySources, url);
       }

       this.scannedCount++;

       // Emit progress event for EACH bookmark (not just once per batch)
       window.dispatchEvent(new CustomEvent('scanProgress', {
         detail: { scanned: this.scannedCount, total: this.totalCount }
       }));
     }

     // Emit batch complete event
     window.dispatchEvent(new CustomEvent('scanBatchComplete', {
       detail: { results }
     }));

     // Process next in queue
     this.processQueue();
   }

  /**
   * Handle scan error
   */
  handleScanError(data) {
    console.error('Scan error for', data.url, ':', data.error);

    // Remove from tracking set
    if (data.url) {
      this.urlsBeingScanned.delete(data.url);
    }

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
    if (!this.worker || !this.workerInitialized || !bookmark.url) return;

    // Skip if this URL is already being scanned
    if (this.urlsBeingScanned.has(bookmark.url)) {
      console.log(`[Scanner] Skipping duplicate scan for ${bookmark.url}`);
      this.scannedCount++;
      this.updateProgress();
      return;
    }

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

        // Update progress counter
        this.scannedCount++;
        this.updateProgress();

        return;
      }
    }

    // Mark URL as being scanned
    this.urlsBeingScanned.add(bookmark.url);

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
   * Reset rate limiting for new scan
   */
  resetRateLimit() {
    if (this.worker) {
      this.worker.postMessage({
        action: 'resetRateLimit',
        data: {}
      });
    }
  }

  /**
    * Scan all bookmarks
    */
   async scanAllBookmarks(bypassCache = false) {
     if (this.isScanning) {
       console.log('Scan already in progress');
       return;
     }
 
     // Check if worker is initialized
     if (!this.worker || !this.workerInitialized) {
       console.log('Scanner worker not initialized, cannot start scan');
       return;
     }
 
     // Reset rate limiting for new scan
     this.resetRateLimit();
 
     this.isScanning = true;
     this.scannedCount = 0;
     this.bypassCache = bypassCache;
 
     // Clear tracking set at start of new scan
     this.urlsBeingScanned.clear();

     // Get all bookmarks
     if (!window.bookmarkManager) {
       console.error('[Scanner] BookmarkManager not available');
       return;
     }
     const allBookmarks = window.bookmarkManager.getAllBookmarks();
     this.totalCount = allBookmarks.length;
 
     console.log(`Starting scan of ${this.totalCount} bookmarks (bypassCache: ${bypassCache})`);

     // Notify UI that scan has started
     window.dispatchEvent(new CustomEvent('scanStarted', {
       detail: { total: this.totalCount }
     }));

     // Add to queue
     this.scanQueue = [...allBookmarks];

     // Start processing queue with batch limit
     this.processQueue();
   }

  /**
    * Process scan queue with batch limit and better progress reporting
    */
   processQueue() {
     // Check if scan was stopped
     if (!this.isScanning) {
       console.log('Scan stopped, aborting queue processing');
       return;
     }

     if (this.scanQueue.length === 0 && this.urlsBeingScanned.size === 0) {
       // Only log completion once
       if (this.isScanning) {
         this.isScanning = false;
         console.log('Scan complete');

         // Notify UI that scan is complete
         window.dispatchEvent(new CustomEvent('scanComplete', {
           detail: { scanned: this.scannedCount, total: this.totalCount }
         }));

         this.updateProgress('Scan complete');
       }
       return;
     }

     // Process up to 10 bookmarks at a time
     const batchSize = 10;
     const batch = this.scanQueue.splice(0, batchSize);

     batch.forEach(bookmark => {
       this.scanBookmark(bookmark, this.bypassCache || false);
     });

     // Progress updates are sent after each bookmark completes (in handleScanComplete)
     // No need to send batch-level progress here

     // Delay next batch by 100ms to avoid overwhelming the network
     setTimeout(() => {
       // Continue processing if scan is still active and there's more work to do
       if (this.isScanning && (this.scanQueue.length > 0 || this.urlsBeingScanned.size > 0)) {
         this.processQueue();
       }
     }, 100);
   }

  /**
   * Update scan progress
   */
  updateProgress(message = null) {
    const progressEl = document.getElementById('scanProgress');
    if (progressEl) {
      // Use setTimeout to defer DOM update, allowing UI to repaint between progress updates
      setTimeout(() => {
        if (message) {
          progressEl.textContent = message;
        } else if (this.isScanning) {
          progressEl.textContent = `Scanning... ${this.scannedCount}/${this.totalCount}`;
        } else {
          progressEl.textContent = 'Ready';
        }
      }, 0);
    }
  }

  /**
    * Scan bookmarks in a folder
    */
   async scanFolder(folder, bypassCache = false) {
     if (!this.worker || !this.workerInitialized || !folder.children) return;
 
     // Reset rate limiting for new scan
     this.resetRateLimit();

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

     // Clear tracking set at start of folder scan
     this.urlsBeingScanned.clear();

     this.scanQueue = [...bookmarksInFolder];
     this.totalCount = bookmarksInFolder.length;
     this.scannedCount = 0;
     this.isScanning = true;
     this.bypassCache = bypassCache;

     // Notify UI that folder scan has started
     window.dispatchEvent(new CustomEvent('scanStarted', {
       detail: { total: this.totalCount, folder: folder.title }
     }));

     this.processQueue();
   }


  /**
    * Stop current scan
    */
   stopScan() {
     if (!this.isScanning) return;

     this.scanQueue = [];
     this.isScanning = false;
     // Clear tracking set when scan is stopped
     this.urlsBeingScanned.clear();

     // Emit scan cancelled event
     window.dispatchEvent(new CustomEvent('scanCancelled', {
       detail: { scanned: this.scannedCount, total: this.totalCount }
     }));

     this.updateProgress('Scan stopped');
   }
}

// Export singleton instance
const scannerService = new ScannerService();
export default scannerService;

// Also export the class for testing
export { ScannerService };
