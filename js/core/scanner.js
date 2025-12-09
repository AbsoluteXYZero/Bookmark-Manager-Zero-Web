/**
 * Scanner Service
 * Coordinates with Web Worker for background scanning
 * TODO: Implement full scanning system
 */

class ScannerService {
  constructor() {
    // TODO: Initialize Web Worker
    this.worker = null;
  }

  async init() {
    console.log('Scanner service initialized (placeholder)');
  }

  async scanBookmarks(bookmarks) {
    // TODO: Implement scanning
    console.log('Scan bookmarks (not yet implemented)');
  }
}

const scannerService = new ScannerService();
export default scannerService;
