/**
 * Blocklist Service
 *
 * [ZeroLabs] 2026-08-28 - rewritten: a controller, not a parser
 *
 * This used to download ~97 MB across ten sources, split it into a 2.6M-element
 * array, run a 3.1M-iteration loop building a Set and two Maps, then Array.from()
 * all three and structured-clone them into the scanner worker - every bit of it
 * on the thread that draws the UI. Enabling safety checking froze the tab for
 * seconds, and the same freeze hit again on the first scan of any later session
 * when loadCachedBlocklist() rebuilt the Set from IndexedDB.
 *
 * None of that work needed to be here: nothing on the main thread ever read the
 * blocklist. workers/scanner-worker.js was the only consumer, so it now fetches,
 * parses and caches for itself. This file is what remains - the safety-checking
 * gate, a request/response wrapper around the worker, and re-emission of the
 * worker's progress as the window events the status bar already listens for.
 *
 * The parsed data now exists once instead of twice, which also halves peak memory.
 */

class BlocklistService {
  constructor() {
    // Kept here because scanner.js forwards it to the worker on init. Small,
    // and it belongs with the rest of the blocklist configuration.
    this.TRUSTED_DOMAINS = [
      'archive.org', 'github.io', 'githubusercontent.com', 'github.com',
      'gitlab.com', 'gitlab.io', 'docs.google.com', 'sites.google.com', 'drive.google.com'
    ];

    this.worker = null;
    this.domainCount = 0;

    // Outstanding loadBlocklists calls, keyed by request id
    this._pending = new Map();
    this._nextRequestId = 1;
  }

  /* Injected by scannerService when it creates the worker. */
  attachWorker(worker) {
    this.worker = worker;
  }

  /* Routed here by scanner.js's message dispatcher. */
  handleWorkerMessage(action, data) {
    if (action === 'blocklistProgress') {
      window.dispatchEvent(new CustomEvent('blocklist:progress', { detail: data }));
      return;
    }

    if (action === 'blocklistComplete') {
      this.domainCount = data.domains || 0;
      window.dispatchEvent(new CustomEvent('blocklist:complete', { detail: data }));
      return;
    }

    if (action === 'blocklistReady') {
      this.domainCount = data.domainCount || 0;
      const pending = this._pending.get(data.requestId);
      if (pending) {
        this._pending.delete(data.requestId);
        clearTimeout(pending.timer);
        pending.resolve({ ready: true, domainCount: this.domainCount });
      }
    }
  }

  /* [ZeroLabs] 2026-08-28 - the blocklists are safety checking's data */
  // Stays on the MAIN THREAD deliberately: workers have no localStorage, so this
  // check cannot move into the worker with the rest of the pipeline. Absent means
  // on, matching loadCheckingSettings, so a read that comes back empty never
  // silently disables the feature.
  isSafetyCheckingEnabled() {
    try {
      return localStorage.getItem('safetyCheckingEnabled') !== 'false';
    } catch (error) {
      return true; // Storage blocked: behave as though the feature is on
    }
  }

  /**
   * Ask the worker to make the blocklist usable, and wait until it is.
   * Resolves to counts only - the data itself never leaves the worker.
   */
  async ensureBlocklistReady({ force = false, timeoutMs = 180000 } = {}) {
    // Nothing to make ready when the feature is off. Answered rather than
    // skipped silently, because callers await this and then read domainCount,
    // and the complete event keeps the status bar from holding a stale message.
    if (!this.isSafetyCheckingEnabled()) {
      console.log('[Blocklist] Safety checking is off. Skipping the download.');
      window.dispatchEvent(new CustomEvent('blocklist:complete', {
        detail: { domains: this.domainCount, totalEntries: this.domainCount, sources: 0 }
      }));
      return { ready: true, domainCount: this.domainCount, skipped: true };
    }

    /* [ZeroLabs] 2026-08-28 - added: bring the worker up if nobody has yet */
    // Not every caller goes through the scanner first. rescanFolder calls this
    // directly, so on a fresh page load where no scan had run yet there was no
    // worker attached and the rescan silently did nothing - "Blocklist ready with
    // 0 domains", then it reported itself complete without scanning anything.
    //
    // Reached through window rather than an import because scanner.js already
    // imports this module and the reverse would be circular. scannerService.init()
    // is idempotent, so calling it here costs nothing when it is already up.
    if (!this.worker && typeof window !== 'undefined' && window.scannerService) {
      await window.scannerService.init();
    }

    if (!this.worker) {
      console.warn('[Blocklist] No worker attached; cannot load blocklists.');
      return { ready: false, domainCount: this.domainCount };
    }

    const requestId = this._nextRequestId++;

    return new Promise((resolve) => {
      // A dead or wedged worker must not hang every caller forever. The window is
      // generous because a cold load genuinely fetches ~97 MB over ten sources.
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        console.warn('[Blocklist] Worker did not answer in time.');
        window.dispatchEvent(new CustomEvent('blocklist:complete', {
          detail: { domains: this.domainCount, totalEntries: 0, sources: 0, success: false }
        }));
        resolve({ ready: false, domainCount: this.domainCount, timedOut: true });
      }, timeoutMs);

      this._pending.set(requestId, { resolve, timer });
      this.worker.postMessage({ action: 'loadBlocklists', data: { requestId, force } });
    });
  }
}

const blocklistService = new BlocklistService();
export default blocklistService;
