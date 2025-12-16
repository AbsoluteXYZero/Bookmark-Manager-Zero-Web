/**
 * Blocklist Service
 * Web-compatible version of the background script's blocklist functionality
 * Downloads and maintains malware/phishing blocklists from public sources
 */

import dbManager from '../storage/indexeddb.js';

class BlocklistService {
  constructor() {
    this.maliciousUrlsSet = new Set();
    this.domainSourceMap = new Map();
    this.domainOnlyMap = new Map();
    this.blocklistLastUpdate = 0;
    this.blocklistLoading = false;
    this.BLOCKLIST_UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

    // Blocklist sources - free, CORS-enabled endpoints
    this.BLOCKLIST_SOURCES = [
      {
        name: 'URLhaus (Active)',
        url: 'https://corsproxy.io/?' + encodeURIComponent('https://urlhaus.abuse.ch/downloads/text/'),
        format: 'urlhaus_text'
      },
      {
        name: 'URLhaus (Historical)',
        url: 'https://curbengh.github.io/malware-filter/urlhaus-filter.txt',
        format: 'domains'
      },
      {
        name: 'BlockList Project (Malware)',
        url: 'https://blocklistproject.github.io/Lists/malware.txt',
        format: 'hosts'
      },
      {
        name: 'BlockList Project (Phishing)',
        url: 'https://blocklistproject.github.io/Lists/phishing.txt',
        format: 'hosts'
      },
      {
        name: 'BlockList Project (Scam)',
        url: 'https://blocklistproject.github.io/Lists/scam.txt',
        format: 'hosts'
      },
      {
        name: 'HaGeZi TIF',
        url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/tif.txt',
        format: 'domains'
      },
      {
        name: 'Phishing-Filter',
        url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt',
        format: 'hosts'
      },
      {
        name: 'OISD Big',
        url: 'https://raw.githubusercontent.com/sjhgvr/oisd/refs/heads/main/domainswild2_big.txt',
        format: 'domains'
      }
    ];

    // Trusted domains that bypass blocklist checks
    this.TRUSTED_DOMAINS = [
      'archive.org', 'github.io', 'githubusercontent.com', 'github.com',
      'gitlab.com', 'gitlab.io', 'docs.google.com', 'sites.google.com', 'drive.google.com'
    ];
  }

  async init() {
    try {
      // Load last update time from storage
      const metadata = await dbManager.get('metadata', 'blocklistLastUpdate');
      if (metadata) {
        this.blocklistLastUpdate = metadata.value;
      }

      // Load cached blocklist data from IndexedDB
      await this.loadCachedBlocklist();

      console.log('[Blocklist] Service initialized with', this.maliciousUrlsSet.size, 'cached domains');
    } catch (error) {
      console.error('[Blocklist] Failed to initialize:', error);
    }
  }

  /**
   * Load cached blocklist from IndexedDB
   */
  async loadCachedBlocklist() {
    try {
      // Check if we have cached blocklist data
      const cachedData = await dbManager.get('blocklists', 'compiled');
      if (!cachedData) {
        console.log('[Blocklist] No cached data found');
        return false;
      }

      // Check if cache is still fresh (within 24 hours)
      const now = Date.now();
      if (now - this.blocklistLastUpdate > this.BLOCKLIST_UPDATE_INTERVAL) {
        console.log('[Blocklist] Cached data is stale, will update');
        return false;
      }

      // Load from cache
      console.log('[Blocklist] Loading from cache...');
      this.maliciousUrlsSet = new Set(cachedData.domains || []);
      this.domainSourceMap = new Map(cachedData.domainSourceMap || []);
      this.domainOnlyMap = new Map(cachedData.domainOnlyMap || []);

      console.log(`[Blocklist] Loaded ${this.maliciousUrlsSet.size} domains from cache`);
      return true;
    } catch (error) {
      console.error('[Blocklist] Failed to load cached blocklist:', error);
      return false;
    }
  }

  /**
   * Save compiled blocklist to IndexedDB for faster loading
   */
  async saveCachedBlocklist() {
    try {
      console.log('[Blocklist] Saving to cache...');
      await dbManager.put('blocklists', {
        source: 'compiled',
        domains: Array.from(this.maliciousUrlsSet),
        domainSourceMap: Array.from(this.domainSourceMap.entries()),
        domainOnlyMap: Array.from(this.domainOnlyMap.entries()),
        lastUpdate: this.blocklistLastUpdate
      });
      console.log('[Blocklist] Cache saved successfully');
    } catch (error) {
      console.error('[Blocklist] Failed to save cache:', error);
    }
  }

  parseBlocklistLine(line, format) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      return null;
    }

    let domain = null;

    if (format === 'hosts') {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        domain = parts[1];
      }
    } else if (format === 'urlhaus_text') {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
          const urlObj = new URL(trimmed);
          domain = urlObj.hostname.toLowerCase();
        } catch {
          return null;
        }
      } else {
        return null;
      }
    } else {
      domain = trimmed;
    }

    if (!domain) return null;

    const normalized = domain.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/^\*\./, '');

    if (normalized === 'localhost' || normalized.startsWith('127.') || normalized.startsWith('0.0.0.0')) {
      return null;
    }

    return normalized;
  }

  async downloadBlocklistSource(source) {
    try {
      console.log(`[Blocklist] Downloading ${source.name}...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch(source.url, {
        method: 'GET',
        signal: controller.signal,
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit'
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[Blocklist] ${source.name} failed: HTTP ${response.status}`);
        return { domains: [], count: 0 };
      }

      const text = await response.text();
      console.log(`[Blocklist] ${source.name}: ${text.length} bytes downloaded`);

      const lines = text.split('\n');
      const domains = [];

      for (const line of lines) {
        const normalized = this.parseBlocklistLine(line, source.format);
        if (normalized) {
          domains.push(normalized);
        }
      }

      console.log(`[Blocklist] ${source.name}: ${domains.length} domains loaded`);
      return { domains, count: domains.length };

    } catch (error) {
      console.error(`[Blocklist] ${source.name} error:`, error.message);
      return { domains: [], count: 0 };
    }
  }

  async updateBlocklistDatabase() {
    if (this.blocklistLoading) {
      console.log(`[Blocklist] Already loading, skipping duplicate request`);
      return true;
    }

    this.blocklistLoading = true;

    try {
      console.log(`[Blocklist] Starting update from ${this.BLOCKLIST_SOURCES.length} sources...`);

      // Emit progress event
      window.dispatchEvent(new CustomEvent('blocklist:progress', {
        detail: { current: 0, total: this.BLOCKLIST_SOURCES.length, status: 'starting' }
      }));

      this.maliciousUrlsSet.clear();
      this.domainSourceMap.clear();
      this.domainOnlyMap.clear();

      const results = [];
      for (let i = 0; i < this.BLOCKLIST_SOURCES.length; i++) {
        const source = this.BLOCKLIST_SOURCES[i];

        window.dispatchEvent(new CustomEvent('blocklist:progress', {
          detail: { current: i + 1, total: this.BLOCKLIST_SOURCES.length, sourceName: source.name, status: 'downloading' }
        }));

        const result = await this.downloadBlocklistSource(source);
        results.push(result);
      }

      let totalCount = 0;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const sourceName = this.BLOCKLIST_SOURCES[i].name;

        for (const domain of result.domains) {
          this.maliciousUrlsSet.add(domain);

          if (this.domainSourceMap.has(domain)) {
            const sources = this.domainSourceMap.get(domain);
            if (!sources.includes(sourceName)) {
              sources.push(sourceName);
            }
          } else {
            this.domainSourceMap.set(domain, [sourceName]);
          }

          const domainPart = domain.split('/')[0];
          if (domainPart !== domain) {
            if (this.domainOnlyMap.has(domainPart)) {
              const sources = this.domainOnlyMap.get(domainPart);
              if (!sources.includes(sourceName)) {
                sources.push(sourceName);
              }
            } else {
              this.domainOnlyMap.set(domainPart, [sourceName]);
            }
          }
        }
        totalCount += result.count;
      }

      this.blocklistLastUpdate = Date.now();

      console.log(`[Blocklist] ✓ Database updated: ${this.maliciousUrlsSet.size} unique domains from ${totalCount} total entries`);

      // Save to IndexedDB cache for next page load
      await this.saveCachedBlocklist();
      await dbManager.put('metadata', { key: 'blocklistLastUpdate', value: this.blocklistLastUpdate });

      window.dispatchEvent(new CustomEvent('blocklist:complete', {
        detail: { domains: this.maliciousUrlsSet.size, totalEntries: totalCount, sources: this.BLOCKLIST_SOURCES.length }
      }));

      this.blocklistLoading = false;
      return true;
    } catch (error) {
      console.error(`[Blocklist] Error updating database:`, error);
      this.blocklistLoading = false;
      return false;
    }
  }

  async ensureBlocklistReady() {
    const now = Date.now();
    const cacheAge = now - this.blocklistLastUpdate;
    const isStale = cacheAge > this.BLOCKLIST_UPDATE_INTERVAL;
    const isEmpty = this.maliciousUrlsSet.size === 0;

    console.log('[Blocklist] ensureBlocklistReady check:', {
      cacheAge: Math.floor(cacheAge / 1000 / 60), // minutes
      isStale,
      isEmpty,
      currentSize: this.maliciousUrlsSet.size
    });

    if (isStale || isEmpty) {
      console.log('[Blocklist] Need update - isStale:', isStale, 'isEmpty:', isEmpty);
      await this.updateBlocklistDatabase();
    } else {
      console.log('[Blocklist] Using cached data');
    }

    if (this.blocklistLoading) {
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!this.blocklistLoading) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);
      });
    }

    return { ready: true, domainCount: this.maliciousUrlsSet.size };
  }

  isTrustedDomain(hostname) {
    if (!hostname) return false;
    const lowerHost = hostname.toLowerCase();

    for (const trustedDomain of this.TRUSTED_DOMAINS) {
      if (lowerHost === trustedDomain || lowerHost.endsWith('.' + trustedDomain)) {
        return true;
      }
    }
    return false;
  }

  checkAgainstBlocklist(url) {
    const normalizedUrl = url.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    const domain = normalizedUrl.split('/')[0];
    const hostname = domain.split(':')[0];

    if (this.isTrustedDomain(hostname)) {
      return { blocked: false, sources: [] };
    }

    if (this.maliciousUrlsSet.has(normalizedUrl)) {
      const sources = this.domainSourceMap.get(normalizedUrl) || [];
      return { blocked: true, sources };
    }

    if (this.maliciousUrlsSet.has(domain)) {
      const sources = this.domainSourceMap.get(domain) || [];
      return { blocked: true, sources };
    }

    if (this.domainOnlyMap.has(domain)) {
      const sources = this.domainOnlyMap.get(domain);
      return { blocked: true, sources };
    }

    return { blocked: false, sources: [] };
  }
}

const blocklistService = new BlocklistService();
export default blocklistService;
