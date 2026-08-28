/**
 * Scanner Web Worker
 * Runs bookmark scanning in background without blocking UI
 * Handles link status and safety checking
 */

// Concurrency limiter to prevent overwhelming network with DNS lookups
class ConcurrencyLimiter {
  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
    /* [ZeroLabs] 2026-06-20 10:50 AM - added: jitter to spread DNS lookups over time */
    this.jitterMs = 0; // Random 0..jitterMs delay before each request
  }

  async run(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      // Stagger request starts so a batch of DNS lookups isn't fired as one wall
      if (this.jitterMs > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * this.jitterMs));
      }
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /* [ZeroLabs] 2026-06-20 10:50 AM - added: live-adjustable cap + jitter for sliders */
  setMax(n) {
    const next = Math.max(1, Math.min(20, Number(n) || this.maxConcurrent));
    const increased = next > this.maxConcurrent;
    this.maxConcurrent = next;
    if (increased) {
      let slots = this.maxConcurrent - this.running;
      while (slots-- > 0) {
        const resolve = this.queue.shift();
        if (!resolve) break;
        resolve();
      }
    }
  }

  setJitter(ms) {
    this.jitterMs = Math.max(0, Math.min(1000, Number(ms) || 0));
  }
}

// Global concurrency limiter for all network requests
/* [ZeroLabs] 2026-06-20 10:35 AM - edited: lower cap to spare home DNS resolver */
// Each link check is a DNS lookup + connection to the bookmark's host. A cap of
// 5 (link+safety = ~10 requests in flight) keeps a burst of distinct-host
// lookups from briefly stalling a local resolver (e.g. AdGuard Home).
const MAX_CONCURRENT_NETWORK = 5;
const networkLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_NETWORK);

// Parking domain list
const PARKING_DOMAINS = [
  'sedoparking.com',
  'parklogic.com',
  'sedo.com',
  'bodis.com',
  'hugedomains.com',
  'afternic.com',
  'undeveloped.com',
  'parkingcrew.net',
  'godaddy.com/forsale',
  'dan.com/buy-domain',
  'registrar-servers.com',
  'domaincontrol.com',
  'above.com',
  'domainmarket.com',
  'efty.com',
  'squadhelp.com',
  'brandpa.com',
  'atom.com',
  'flippa.com/domain',
  'uniregistry.com/market',
  'parkweb.com',
  'fabulous.com'
];

// Exempt hosting platforms (not parking)
const PARKING_EXEMPT_DOMAINS = [
  'github.io',
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
  'cloudflare.pages',
  'gitlab.io',
  'surge.sh',
  'replit.co'
];

/**
 * Check if URL is from exempt hosting platform
 */
function isParkingExempt(hostname) {
  return PARKING_EXEMPT_DOMAINS.some(domain => hostname.endsWith(domain));
}

/**
 * Check if URL is privileged (browser internal, extension)
 */
function isPrivilegedUrl(url) {
  try {
    const urlObj = new URL(url);
    const scheme = urlObj.protocol.replace(':', '').toLowerCase();

    const privilegedSchemes = [
      'about', 'chrome', 'moz-extension',
      'chrome-extension', 'view-source', 'jar', 'resource'
    ];

    return privilegedSchemes.includes(scheme);
  } catch (e) {
    return false;
  }
}

/**
 * Check link status (live/dead/parked)
 */
/* [ZeroLabs] 2026-08-28 - rewritten: DNS + a checker val, not opaque fetches */
// The old implementation tried `mode:'cors'` and fell back to `mode:'no-cors'`.
// That fallback ALWAYS "succeeds" and always returns an opaque response - status
// forced to 0, ok false, headers unreadable - so every status check was gated on
// `usedCors` and simply skipped. Any site without CORS headers (nearly all of
// them) fell through to `return 'live'`. On the website "live" meant "a server
// answered", not "the page exists", so genuinely dead bookmarks showed green
// while the extensions correctly showed them red.
//
// A page cannot read a cross-origin response; that is the same-origin policy and
// no amount of retrying changes it. The extensions get real status codes because
// host permissions exempt them. So the work is done elsewhere:
//
//   Tier 1  DNS-over-HTTPS (Cloudflare, ACAO:*). NXDOMAIN means the domain is
//           gone, so every path under it is dead. Free, unlimited, ~50ms, and
//           cached per HOSTNAME - one lookup settles every bookmark on that host.
//
//   Tier 2  A val.town val does the fetch server-side and returns just the status
//           code with permissive CORS, which the page IS allowed to read.
//
// CRITICAL: a val error is NOT death. The val runs from a datacenter IP, so sites
// with bot protection refuse it - www.ford.com resolves fine and is a real 404,
// but the val gets nothing. Marking that dead would be a false POSITIVE, telling
// the user to delete a working bookmark.
//
// Two different failures, deliberately reported differently:
//   'blocked' (yellow)  THEIR refusal - the site turned our checker away. Will
//                       not change on its own, so the scan queue must not retry
//                       it; line 1888 only re-queues 'unknown', so it never will.
//   'unknown' (grey)    OUR failure - DNS unreachable, the val down, a bad batch.
//                       Transient, and correctly retried on the next scan.

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const LINK_VAL_URL = 'https://testpilot--bf5f3b50a32d11f18be01607ee4eb77e.web.val.run';
// Sent from the client, so it deters scanners rather than being a real secret.
// The val's own SSRF guard and result cache are what actually protect it.
const LINK_VAL_TOKEN = 'UN_RMNOFQ9Jytbj7QT_kfyJFd07GCUu8';

const VAL_BATCH_SIZE = 50;     // val's documented per-request cap
const VAL_BATCH_WAIT_MS = 120; // collect concurrent checks before flushing

// hostname -> true (resolves) | false (NXDOMAIN) | null (lookup failed)
const dnsCache = new Map();

/**
 * Does this hostname exist at all? Returns null when DNS itself could not be
 * reached, which must not be confused with NXDOMAIN.
 */
async function hostResolves(hostname) {
  if (dnsCache.has(hostname)) return dnsCache.get(hostname);

  let verdict = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { Accept: 'application/dns-json' }, signal: controller.signal },
    );
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      // 3 = NXDOMAIN. 0 = NOERROR, but a name can exist with no A record
      // (MX-only, AAAA-only), so treat "not NXDOMAIN" as resolving.
      verdict = data.Status !== 3;
    }
  } catch (e) {
    verdict = null; // DNS unreachable - say nothing rather than guess
  }

  dnsCache.set(hostname, verdict);
  return verdict;
}

// Collects concurrent per-URL checks into one batched request. The val allows
// 1000 requests/minute SHARED across every BMZ user, so one request per bookmark
// would burn 2909 of them per full scan; batching 50 makes that 59.
const valBatch = { pending: [], timer: null };

function flushValBatch() {
  if (valBatch.timer) {
    clearTimeout(valBatch.timer);
    valBatch.timer = null;
  }
  if (valBatch.pending.length === 0) return;

  const batch = valBatch.pending.splice(0, VAL_BATCH_SIZE);

  (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);

      const res = await fetch(`${LINK_VAL_URL}/?key=${encodeURIComponent(LINK_VAL_TOKEN)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: batch.map(b => b.url) }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`val HTTP ${res.status}`);

      const body = await res.json();
      const results = Array.isArray(body.results) ? body.results : [];
      batch.forEach((item, i) => item.resolve(results[i] || { status: null, error: 'no-result' }));
    } catch (err) {
      console.warn('[LinkCheck] Batch failed:', err.message);
      // Resolve rather than reject: a failed batch means "we learned nothing",
      // which maps to 'blocked', not to a dead link.
      batch.forEach(item => item.resolve({ status: null, error: 'val-unreachable' }));
    }

    // More may have queued while this was in flight
    if (valBatch.pending.length > 0) flushValBatch();
  })();
}

function checkViaVal(url) {
  return new Promise((resolve) => {
    valBatch.pending.push({ url, resolve });
    if (valBatch.pending.length >= VAL_BATCH_SIZE) {
      flushValBatch();
    } else if (!valBatch.timer) {
      valBatch.timer = setTimeout(flushValBatch, VAL_BATCH_WAIT_MS);
    }
  });
}

async function checkLinkStatus(url) {
  // Privileged URLs are always live
  if (isPrivilegedUrl(url)) {
    return 'live';
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return 'dead'; // Invalid URL
  }

  // Known parking service in the hostname itself
  if (!isParkingExempt(hostname) && PARKING_DOMAINS.some(d => hostname.includes(d))) {
    return 'parked';
  }

  // Tier 1: does the domain exist? NXDOMAIN settles every path under it, so
  // there is no point asking about the path.
  const resolves = await hostResolves(hostname);
  if (resolves === false) {
    return 'dead';
  }
  if (resolves === null) {
    // DNS itself was unreachable - our problem, not the bookmark's. Retryable.
    return 'unknown';
  }

  // Tier 2: the actual HTTP status, fetched server-side
  const result = await checkViaVal(url);

  if (typeof result.status === 'number') {
    // Redirected onto a parking service
    if (result.finalUrl) {
      try {
        const finalHost = new URL(result.finalUrl).hostname.toLowerCase();
        if (finalHost !== hostname &&
            !isParkingExempt(finalHost) &&
            PARKING_DOMAINS.some(d => finalHost.includes(d))) {
          return 'parked';
        }
      } catch (e) { /* unparseable final URL, fall through to the status */ }
    }

    // Content is gone
    if (result.status === 404 || result.status === 410 || result.status === 451) {
      return 'dead';
    }

    // Everything else that answered is live, including 401/403/429 - those mean
    // the server is up and refusing us, which is not a broken bookmark.
    return 'live';
  }

  // No status code came back. The domain resolves, so the host exists - which
  // means either it refused our checker, or our own checking failed.
  //
  // 'val-unreachable' and 'no-result' are OUR side falling over, so they stay
  // grey and get retried. Everything else means the val reached the network and
  // the target refused or hung: that is the site's decision and will not change,
  // so it goes yellow and is never retried.
  const ourFault = result.error === 'val-unreachable' || result.error === 'no-result';
  return ourFault ? 'unknown' : 'blocked';
}

/**
 * Get API keys from localStorage (encrypted keys are stored there)
 */
function getApiKey(keyName) {
  try {
    // In Web Worker, we can't access localStorage directly
    // Keys need to be passed from main thread
    return null;
  } catch (e) {
    return null;
  }
}

// Store API keys passed from main thread
let apiKeys = {
  googleSafeBrowsingApiKey: null,
  yandexApiKey: null,
  virusTotalApiKey: null
};

// Rate limiting flags
let virusTotalRateLimited = false;

/**
 * Send scan result immediately (no batching for smooth progress updates)
 */
function queueResult(result) {
  self.postMessage({
    action: 'scanComplete',
    data: result
  });
}

/* [ZeroLabs] 2026-08-28 - edited: the worker owns the blocklist now */
// These used to be built on the main thread and shipped in here, which meant the
// tab froze for seconds: fetching ~97 MB, splitting it into a 2.6M-element array,
// a 3.1M-iteration loop building these three structures, then THREE Array.from
// copies and a structured clone of all of it across the postMessage boundary.
// None of that work ever needed to be on the thread that draws the UI - nothing
// out there reads these; this worker is the only consumer.
//
// Now the worker fetches, parses and caches them itself. The main thread sends
// 'loadBlocklists' and receives small progress messages back. The data also now
// exists once rather than twice, which halves peak memory.
let blocklist = new Set();
let domainSourceMap = new Map();
let domainOnlyMap = new Map();
let trustedDomains = [];
let blocklistLoading = false;
let blocklistLastUpdate = 0;

// Free, CORS-enabled endpoints. Kept in sync with the extensions' background
// scripts - if a source breaks or moves, it has to change in all three.
const BLOCKLIST_SOURCES = [
  { name: 'URLhaus (Active)', url: 'https://raw.githubusercontent.com/AbsoluteXYZero/urlhaus-list/main/urlhaus-active.txt', format: 'urlhaus_text' },
  { name: 'URLhaus (Historical)', url: 'https://curbengh.github.io/malware-filter/urlhaus-filter.txt', format: 'domains' },
  { name: 'BlockList Project (Malware)', url: 'https://blocklistproject.github.io/Lists/malware.txt', format: 'hosts' },
  { name: 'BlockList Project (Phishing)', url: 'https://blocklistproject.github.io/Lists/phishing.txt', format: 'hosts' },
  { name: 'BlockList Project (Scam)', url: 'https://blocklistproject.github.io/Lists/scam.txt', format: 'hosts' },
  // jsDelivr 403s this repo (>150 MB) and the repo dropped domains/ for wildcard/.
  // GitHub raw sends Access-Control-Allow-Origin: *. Medium tier, not full TIF.
  { name: 'HaGeZi TIF', url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt', format: 'domains' },
  { name: 'Phishing-Filter', url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt', format: 'hosts' },
  { name: 'OISD Big', url: 'https://raw.githubusercontent.com/sjhgvr/oisd/refs/heads/main/domainswild2_big.txt', format: 'domains' },
  { name: 'FMHY Filterlist', url: 'https://raw.githubusercontent.com/fmhy/FMHYFilterlist/main/filterlist-basic-domains.txt', format: 'domains' },
  { name: 'Dandelion Sprout Anti-Malware', url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Alternate%20versions%20Anti-Malware%20List/AntiMalwareHosts.txt', format: 'hosts' }
];

/* [ZeroLabs] 2026-08-28 - added: a database of its own, deliberately */
// NOT dbManager's database. That one holds the bookmarks and carries real
// migration logic in onupgradeneeded (a v1->v2 keyPath change); a second
// connection from here with a mismatched version could trigger or block an
// upgrade on the store holding Zero's data. A separate database removes that
// entire risk by construction rather than by being careful.
//
// NEVER point this at the bookmarks database.
const BLOCKLIST_DB_NAME = 'bmz-blocklists';
const BLOCKLIST_DB_VERSION = 1;
const BLOCKLIST_STORE = 'compiled';

function openBlocklistDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BLOCKLIST_DB_NAME, BLOCKLIST_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOCKLIST_STORE)) {
        db.createObjectStore(BLOCKLIST_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Blocklist database blocked'));
  });
}

async function readBlocklistCache() {
  const db = await openBlocklistDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BLOCKLIST_STORE, 'readonly');
      const req = tx.objectStore(BLOCKLIST_STORE).get('compiled');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function writeBlocklistCache(record) {
  const db = await openBlocklistDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BLOCKLIST_STORE, 'readwrite');
      tx.objectStore(BLOCKLIST_STORE).put({ key: 'compiled', ...record });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function isSameDayUtc(a, b) {
  if (!a || !b) return false;
  const d1 = new Date(a);
  const d2 = new Date(b);
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function parseBlocklistLine(line, format) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;

  let domain = null;

  if (format === 'hosts') {
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) domain = parts[1];
  } else if (format === 'urlhaus_text') {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        domain = new URL(trimmed).hostname.toLowerCase();
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

// Fold one source straight into the shared structures. The old code collected
// every source's domains into arrays first and merged afterwards, so peak memory
// held the arrays AND the Set AND both Maps at once.
function ingestSource(text, source) {
  let count = 0;
  const lines = text.split('\n');

  for (const line of lines) {
    const domain = parseBlocklistLine(line, source.format);
    if (!domain) continue;
    count++;

    blocklist.add(domain);

    const existing = domainSourceMap.get(domain);
    if (existing) {
      if (!existing.includes(source.name)) existing.push(source.name);
    } else {
      domainSourceMap.set(domain, [source.name]);
    }

    const domainPart = domain.split('/')[0];
    if (domainPart !== domain) {
      const existingDomainOnly = domainOnlyMap.get(domainPart);
      if (existingDomainOnly) {
        if (!existingDomainOnly.includes(source.name)) existingDomainOnly.push(source.name);
      } else {
        domainOnlyMap.set(domainPart, [source.name]);
      }
    }
  }

  return count;
}

async function downloadBlocklistSource(source) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(source.url, {
      method: 'GET',
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit'
    });

    if (!response.ok) {
      console.error(`[Blocklist] ${source.name} failed: HTTP ${response.status}`);
      return 0;
    }

    const text = await response.text();
    console.log(`[Blocklist] ${source.name}: ${text.length} bytes downloaded`);
    return ingestSource(text, source);
  } catch (error) {
    console.error(`[Blocklist] ${source.name} error:`, error.message);
    return 0;
  } finally {
    clearTimeout(timeoutId);
  }
}

function postBlocklistProgress(detail) {
  self.postMessage({ action: 'blocklistProgress', data: detail });
}

async function loadBlocklistsFromCache() {
  try {
    const cached = await readBlocklistCache();
    if (!cached || !isSameDayUtc(Date.now(), cached.lastUpdate)) return false;

    blocklist = new Set(cached.domains || []);
    domainSourceMap = new Map(cached.domainSourceMap || []);
    domainOnlyMap = new Map(cached.domainOnlyMap || []);
    blocklistLastUpdate = cached.lastUpdate;
    console.log(`[Blocklist] Loaded ${blocklist.size} domains from cache`);
    return true;
  } catch (error) {
    console.error('[Blocklist] Cache read failed:', error);
    return false;
  }
}

async function updateBlocklistDatabase() {
  console.log(`[Blocklist] Starting update from ${BLOCKLIST_SOURCES.length} sources...`);
  postBlocklistProgress({ current: 0, total: BLOCKLIST_SOURCES.length, status: 'starting' });

  blocklist.clear();
  domainSourceMap.clear();
  domainOnlyMap.clear();

  let totalEntries = 0;
  for (let i = 0; i < BLOCKLIST_SOURCES.length; i++) {
    const source = BLOCKLIST_SOURCES[i];
    postBlocklistProgress({
      current: i + 1,
      total: BLOCKLIST_SOURCES.length,
      sourceName: source.name,
      status: 'downloading'
    });
    totalEntries += await downloadBlocklistSource(source);
  }

  blocklistLastUpdate = Date.now();
  console.log(`[Blocklist] Database updated: ${blocklist.size} unique domains from ${totalEntries} total entries`);

  try {
    await writeBlocklistCache({
      domains: Array.from(blocklist),
      domainSourceMap: Array.from(domainSourceMap.entries()),
      domainOnlyMap: Array.from(domainOnlyMap.entries()),
      lastUpdate: blocklistLastUpdate
    });
  } catch (error) {
    // A cache failure costs a re-download tomorrow, nothing more
    console.error('[Blocklist] Cache write failed:', error);
  }

  return totalEntries;
}

// Entry point for the main thread. Resolves to counts only - the structures
// themselves never cross the boundary again.
async function ensureBlocklistReady(force = false) {
  if (blocklistLoading) {
    while (blocklistLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { domainCount: blocklist.size, totalEntries: 0, fromCache: true };
  }

  blocklistLoading = true;
  let totalEntries = 0;
  let fromCache = false;

  try {
    if (!force && blocklist.size > 0 && isSameDayUtc(Date.now(), blocklistLastUpdate)) {
      fromCache = true;
    } else if (!force && await loadBlocklistsFromCache()) {
      fromCache = true;
    } else {
      totalEntries = await updateBlocklistDatabase();
    }
    return { domainCount: blocklist.size, totalEntries, fromCache };
  } finally {
    blocklistLoading = false;
    // Always announced, so the status bar is never left holding a progress
    // message that nothing comes back to clear.
    self.postMessage({
      action: 'blocklistComplete',
      data: {
        domains: blocklist.size,
        totalEntries,
        sources: fromCache ? 0 : BLOCKLIST_SOURCES.length,
        success: blocklist.size > 0
      }
    });
  }
}

/**
 * Check URL using Google Safe Browsing API
 */
async function checkGoogleSafeBrowsing(url) {
  try {
    const apiKey = apiKeys.googleSafeBrowsingApiKey;

    if (!apiKey || apiKey.trim() === '') {
      console.log(`[Google SB] No API key configured, skipping check`);
      return 'unknown';
    }

    console.log(`[Google SB] Starting check for ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client: {
            clientId: 'bookmark-manager-zero-web',
            clientVersion: '1.0.0'
          },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[Google SB] API error: ${response.status}`);
      return 'unknown';
    }

    const data = await response.json();

    if (data.matches && data.matches.length > 0) {
      console.log(`[Google SB] Result: UNSAFE (${data.matches.length} threats found)`);
      return 'unsafe';
    }

    console.log(`[Google SB] Result: SAFE`);
    return 'safe';

  } catch (error) {
    console.error(`[Google SB] Error:`, error.message);
    return 'unknown';
  }
}

/**
 * Check URL using Yandex Safe Browsing API
 */
async function checkYandexSafeBrowsing(url) {
  try {
    const apiKey = apiKeys.yandexApiKey;

    if (!apiKey || apiKey.trim() === '') {
      console.log(`[Yandex SB] No API key configured, skipping check`);
      return 'unknown';
    }

    console.log(`[Yandex SB] Starting check for ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://sba.yandex.net/v4/threatMatches:find?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[Yandex SB] API error: ${response.status}`);
      return 'unknown';
    }

    const data = await response.json();

    if (data.matches && data.matches.length > 0) {
      console.log(`[Yandex SB] Result: UNSAFE (${data.matches.length} threats found)`);
      return 'unsafe';
    }

    console.log(`[Yandex SB] Result: SAFE`);
    return 'safe';

  } catch (error) {
    console.error(`[Yandex SB] Error:`, error.message);
    return 'unknown';
  }
}

/**
 * Check URL using VirusTotal web scraping
 * No API key required - fetches the public web page
 * Always runs on every bookmark
 * WARNING: For personal use only. May violate VirusTotal ToS if distributed.
 */
/* [ZeroLabs] 2026-08-28 - rewritten: through the val, not public CORS proxies */
// The three public proxies this used have all rotted, verified across a night of
// logs: corsproxy.io returns 403 to EVERY request without exception,
// api.codetabs.com returns 522, and api.allorigins.win works intermittently but
// hangs for 19-20 seconds before failing. Those hangs became the single largest
// cost in a scan once link checking was fixed.
//
// The val fetches URLVoid server-side and counts detections there, so a ~36KB
// page never crosses the wire - only the number does. Verified byte-identical to
// what a browser gets: pastes.io 3, netfilm.app 5, google.com 0.
//
// URLVoid is per DOMAIN, not per URL, so requests are batched by hostname. A
// full library of 2909 bookmarks is only ~600 distinct domains.

const URLVOID_BATCH_SIZE = 10;    // the val's cap: sized to its 1 min execution ceiling
const URLVOID_BATCH_WAIT_MS = 150;

const urlvoidBatch = { pending: [], timer: null };

function flushUrlvoidBatch() {
  if (urlvoidBatch.timer) {
    clearTimeout(urlvoidBatch.timer);
    urlvoidBatch.timer = null;
  }
  if (urlvoidBatch.pending.length === 0) return;

  const batch = urlvoidBatch.pending.splice(0, URLVOID_BATCH_SIZE);

  (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);

      const res = await fetch(`${LINK_VAL_URL}/urlvoid?key=${encodeURIComponent(LINK_VAL_TOKEN)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: batch.map(b => b.domain) }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`val HTTP ${res.status}`);

      const body = await res.json();
      const results = Array.isArray(body.results) ? body.results : [];
      batch.forEach((item, i) => item.resolve(results[i] || { count: null, error: 'no-result' }));
    } catch (err) {
      console.warn('[URLVoid] Batch failed:', err.message);
      // Resolve rather than reject: a failed batch means URLVoid said nothing,
      // which must abstain rather than vote either way.
      batch.forEach(item => item.resolve({ count: null, error: 'val-unreachable' }));
    }

    if (urlvoidBatch.pending.length > 0) flushUrlvoidBatch();
  })();
}

function urlvoidLookup(domain) {
  return new Promise((resolve) => {
    urlvoidBatch.pending.push({ domain, resolve });
    if (urlvoidBatch.pending.length >= URLVOID_BATCH_SIZE) {
      flushUrlvoidBatch();
    } else if (!urlvoidBatch.timer) {
      urlvoidBatch.timer = setTimeout(flushUrlvoidBatch, URLVOID_BATCH_WAIT_MS);
    }
  });
}

async function checkURLVoidScraping(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return 'unknown';
  }

  const result = await urlvoidLookup(hostname);

  // A count of null means URLVoid contributed nothing - it has never scanned the
  // domain ('no-report'), or we could not reach it. ABSTAIN. Reporting 'safe'
  // here is the bug this replaced: an unscanned domain returns a "Report Not
  // Found" page containing no "detected" either, so the old code counted zero
  // and called it clean when in truth nobody had looked.
  if (typeof result.count !== 'number') {
    console.log(`[URLVoid] ${hostname}: no verdict (${result.error || 'unknown'})`);
    return 'unknown';
  }

  console.log(`[URLVoid] ${hostname} - Detected: ${result.count}`);

  if (result.count >= 2) return 'unsafe';   // 2+ engines flagged it
  if (result.count === 1) return 'warning'; // a single engine flagged it
  return 'safe';                            // genuinely checked, nothing found
}
async function checkVirusTotal(url) {
  try {
    const apiKey = apiKeys.virusTotalApiKey;

    if (!apiKey || apiKey.trim() === '') {
      console.log(`[VirusTotal API] No API key configured, skipping`);
      return 'unknown';
    }

    if (virusTotalRateLimited) {
      console.log(`[VirusTotal API] Rate limited, skipping check for ${url}`);
      return 'unknown';
    }

    console.log(`[VirusTotal API] Starting check for ${url}`);

    const urlId = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const reportController = new AbortController();
    const reportTimeout = setTimeout(() => reportController.abort(), 8000);

    const reportResponse = await fetch(
      `https://www.virustotal.com/api/v3/urls/${urlId}`,
      {
        method: 'GET',
        signal: reportController.signal,
        headers: { 'x-apikey': apiKey }
      }
    );

    clearTimeout(reportTimeout);

    if (!reportResponse.ok) {
      if (reportResponse.status === 429) {
        virusTotalRateLimited = true;
        console.log(`[VirusTotal API] Rate limit hit, will skip remaining checks`);
      }
      return 'unknown';
    }

    const reportData = await reportResponse.json();
    const stats = reportData.data?.attributes?.last_analysis_stats;

    if (!stats) {
      console.log(`[VirusTotal API] No stats available`);
      return 'unknown';
    }

    const malicious = stats.malicious || 0;
    const suspicious = stats.suspicious || 0;

    console.log(`[VirusTotal API] Analysis - Malicious: ${malicious}, Suspicious: ${suspicious}`);

    if (malicious >= 2) {
      console.log(`[VirusTotal API] Result: UNSAFE`);
      return 'unsafe';
    }

    if (malicious >= 1 || suspicious >= 2) {
      console.log(`[VirusTotal API] Result: WARNING`);
      return 'warning';
    }

    console.log(`[VirusTotal API] Result: SAFE`);
    return 'safe';

  } catch (error) {
    console.error(`[VirusTotal API] Error:`, error.message);
    return 'unknown';
  }
}

/**
 * Check for suspicious URL patterns
 */
function checkSuspiciousPatterns(url, domain) {
  const patterns = [];

  // Check for HTTP-only (no encryption)
  if (url.toLowerCase().startsWith('http://')) {
    patterns.push('HTTP Only (Unencrypted)');
  }

  // Check for known URL shorteners
  const urlShorteners = [
    'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
    'adf.ly', 'bl.ink', 'lnkd.in', 'short.link', 'cutt.ly', 'rebrand.ly'
  ];

  const domainWithoutPort = domain.split(':')[0];
  if (urlShorteners.includes(domainWithoutPort)) {
    patterns.push('URL Shortener');
  }

  // Check for suspicious TLDs
  const suspiciousTlds = [
    '.xyz', '.top', '.tk', '.ml', '.ga', '.cf', '.gq', '.pw', '.cc', '.ws',
    '.click', '.link', '.download', '.stream', '.loan', '.win', '.bid'
  ];

  for (const tld of suspiciousTlds) {
    if (domainWithoutPort.endsWith(tld)) {
      patterns.push('Suspicious TLD');
      break;
    }
  }

  // Check for IP addresses
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/;
  if (ipv4Pattern.test(domainWithoutPort)) {
    patterns.push('IP Address');
  }

  return patterns;
}

/**
 * Check safety status (full implementation)
 */
async function checkSafetyStatus(url) {
  try {
    // Normalize URL for lookup
    const normalizedUrl = url.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    const domain = normalizedUrl.split('/')[0];
    const hostname = domain.split(':')[0];

    // Check if domain is trusted (bypass blocklist)
    let isTrusted = false;
    if (trustedDomains && trustedDomains.length > 0) {
      for (const trustedDomain of trustedDomains) {
        if (hostname === trustedDomain || hostname.endsWith('.' + trustedDomain)) {
          isTrusted = true;
          console.log(`[Blocklist] Trusted domain, skipping blocklist check`);
          break;
        }
      }
    }

    // Check blocklist if not trusted
    if (!isTrusted) {
      let blocklistSources = [];

      // Check full URL
      if (blocklist.has(normalizedUrl)) {
        blocklistSources = domainSourceMap.get(normalizedUrl) || ['Blocklist'];
      }
      // Check domain only
      else if (blocklist.has(domain)) {
        blocklistSources = domainSourceMap.get(domain) || ['Blocklist'];
      }
      // Check domain-only map
      else if (domainOnlyMap.has(domain)) {
        blocklistSources = domainOnlyMap.get(domain) || ['Blocklist'];
      }

      if (blocklistSources.length > 0) {
        console.log(`[Blocklist] URL found in malicious database (sources: ${blocklistSources.join(', ')})`);
        return { status: 'unsafe', sources: blocklistSources };
      }
    }

    let finalStatus = 'safe';
    let allSources = [];

    // Check Google Safe Browsing
    if (apiKeys.googleSafeBrowsingApiKey) {
      console.log(`[Safety Check] Checking Google Safe Browsing...`);
      const googleResult = await checkGoogleSafeBrowsing(url);
      if (googleResult === 'unsafe') {
        finalStatus = 'unsafe';
        allSources.push('Google Safe Browsing');
      }
    }

    // Check Yandex Safe Browsing
    if (apiKeys.yandexApiKey) {
      console.log(`[Safety Check] Checking Yandex Safe Browsing...`);
      const yandexResult = await checkYandexSafeBrowsing(url);
      if (yandexResult === 'unsafe') {
        finalStatus = 'unsafe';
        allSources.push('Yandex Safe Browsing');
      }
    }

    // Check URLVoid Scraping (always runs, no API key needed)
    const vtScrapingResult = await checkURLVoidScraping(url);
    if (vtScrapingResult === 'unsafe') {
      finalStatus = 'unsafe';
      allSources.push('URLVoid');
    } else if (vtScrapingResult === 'warning' && finalStatus !== 'unsafe') {
      finalStatus = 'warning';
      allSources.push('URLVoid');
    }

    // Check VirusTotal API (optional, requires API key)
    if (apiKeys.virusTotalApiKey) {
      console.log(`[Safety Check] Checking VirusTotal API...`);
      const vtApiResult = await checkVirusTotal(url);
      if (vtApiResult === 'unsafe') {
        finalStatus = 'unsafe';
        if (!allSources.includes('VirusTotal')) {
          allSources.push('VirusTotal');
        }
      } else if (vtApiResult === 'warning' && finalStatus !== 'unsafe') {
        finalStatus = 'warning';
        if (!allSources.includes('VirusTotal')) {
          allSources.push('VirusTotal');
        }
      }
    }

    // Check for suspicious patterns
    const suspiciousPatterns = checkSuspiciousPatterns(url, domain);
    if (suspiciousPatterns.length > 0 && finalStatus !== 'unsafe') {
      finalStatus = 'warning';
      allSources.push(...suspiciousPatterns);
    }

    console.log(`[Safety Check] Final result: ${finalStatus} (sources: ${allSources.join(', ')})`);
    return { status: finalStatus, sources: allSources };

  } catch (e) {
    console.error(`[Safety Check] Error:`, e);
    return { status: 'unknown', sources: [] };
  }
}

// Worker initialization state
let isWorkerInitialized = false;

/**
 * Message handler
 */
self.addEventListener('message', async (e) => {
  const { action, data } = e.data;

  switch (action) {
    case 'init':
      // Reset rate limiting flags
      virusTotalRateLimited = false;

      /* [ZeroLabs] 2026-08-28 - edited: no blocklist arrays cross this boundary */
      // init used to carry blocklist, domainSourceMap and domainOnlyMap as
      // arrays - millions of entries structured-cloned on every worker start.
      // The worker builds them itself now; only the small config comes in here.
      if (data.apiKeys) {
        apiKeys = data.apiKeys;
      }
      if (data.trustedDomains) {
        trustedDomains = data.trustedDomains;
      }

      // Mark worker as initialized
      isWorkerInitialized = true;

      self.postMessage({
        action: 'initComplete',
        data: { success: true }
      });
      break;

    /* [ZeroLabs] 2026-08-28 - added: fetch/parse/cache happen in here now */
    // Answers with counts only. requestId lets the main thread match the reply,
    // since it awaits this before starting a scan.
    case 'loadBlocklists':
      try {
        const result = await ensureBlocklistReady(data && data.force);
        self.postMessage({
          action: 'blocklistReady',
          data: { requestId: data && data.requestId, ...result }
        });
      } catch (error) {
        console.error('[Blocklist] Load failed:', error);
        self.postMessage({
          action: 'blocklistReady',
          data: {
            requestId: data && data.requestId,
            domainCount: blocklist.size,
            totalEntries: 0,
            error: error.message
          }
        });
      }
      break;

    case 'resetRateLimit':
      virusTotalRateLimited = false;
      break;

    /* [ZeroLabs] 2026-06-20 10:50 AM - added: live scan concurrency/jitter from sliders */
    case 'setConcurrency':
      networkLimiter.setMax(data.value);
      break;

    case 'setJitter':
      networkLimiter.setJitter(data.value);
      break;

    case 'scanBookmark':
      try {
        // Scan both link and safety with concurrency limiting
        const [linkStatus, safetyResult] = await Promise.all([
          networkLimiter.run(() => checkLinkStatus(data.url)),
          networkLimiter.run(() => checkSafetyStatus(data.url))
        ]);

        // Use batching for better performance
        queueResult({
          url: data.url,
          id: data.id,
          linkStatus: linkStatus,
          safetyStatus: safetyResult.status,
          safetySources: safetyResult.sources
        });
      } catch (error) {
        // Send error immediately (don't batch errors)
        self.postMessage({
          action: 'scanError',
          data: {
            url: data.url,
            id: data.id,
            error: error.message
          }
        });
      }
      break;

    default:
      console.warn('Unknown action:', action);
  }
});
