/**
 * Scanner Web Worker
 * Runs bookmark scanning in background without blocking UI
 * Handles link status and safety checking
 */

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
async function checkLinkStatus(url) {
  // Privileged URLs are always live
  if (isPrivilegedUrl(url)) {
    return 'live';
  }

  let result;

  // Check if URL itself is on parking domain
  try {
    const urlHost = new URL(url).hostname.toLowerCase();
    if (!isParkingExempt(urlHost) && PARKING_DOMAINS.some(domain => urlHost.includes(domain))) {
      return 'parked';
    }
  } catch (e) {
    return 'dead'; // Invalid URL
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  try {
    // Try fetch with cors mode first to get redirect info
    // Fall back to no-cors if CORS blocks us
    let response;
    let usedCors = false;

    try {
      const corsController = new AbortController();
      const corsTimeout = setTimeout(() => corsController.abort(), 10000);

      response = await fetch(url, {
        method: 'HEAD',
        signal: corsController.signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        headers: headers
      });
      clearTimeout(corsTimeout);
      usedCors = true;
    } catch (corsError) {
      // CORS blocked, try no-cors mode with fresh controller
      const noCorsController = new AbortController();
      const noCorsTimeout = setTimeout(() => noCorsController.abort(), 10000);

      response = await fetch(url, {
        method: 'HEAD',
        signal: noCorsController.signal,
        mode: 'no-cors',
        credentials: 'omit',
        redirect: 'follow',
        headers: headers
      });
      clearTimeout(noCorsTimeout);
    }

    clearTimeout(timeoutId);

    // Check if redirected to parking domain (only works with cors mode)
    if (usedCors && response.url) {
      try {
        const finalHost = new URL(response.url).hostname.toLowerCase();
        const originalHost = new URL(url).hostname.toLowerCase();

        // Only flag if redirected to a DIFFERENT domain that's a known parking service
        if (finalHost !== originalHost &&
            !isParkingExempt(finalHost) &&
            PARKING_DOMAINS.some(domain => finalHost.includes(domain))) {
          return 'parked';
        }
      } catch (e) {
        // URL parsing failed, continue with live status
      }

      // Check response status (only available in cors mode)
      // 404, 410, 451 indicate the content is gone
      if (response.status === 404 || response.status === 410 || response.status === 451) {
        return 'dead';
      }
    }

    // Site is reachable - check for successful status codes
    if (usedCors && (response.ok || (response.status >= 300 && response.status < 400))) {
      const urlHost = new URL(url).hostname.toLowerCase();
      if (isParkingExempt(urlHost)) {
        return 'live';
      }

      // Try content-based parking detection
      try {
        const contentController = new AbortController();
        const contentTimeout = setTimeout(() => contentController.abort(), 3000);

        const contentResponse = await fetch(url, {
          method: 'GET',
          signal: contentController.signal,
          credentials: 'omit',
          redirect: 'follow',
          headers: headers
        });
        clearTimeout(contentTimeout);

        if (contentResponse.ok) {
          const html = await contentResponse.text();
          const htmlLower = html.toLowerCase();
          const contentSize = html.length;

          // Strong parking indicators
          const strongIndicators = [
            'sedo domain parking',
            'this domain is parked',
            'domain is parked',
            'parked by',
            'parked domain',
            'hugedomains.com/domain',
            'afternic.com/forsale',
            'this domain name is for sale',
            'buy this domain name',
            'domain has expired'
          ];

          if (strongIndicators.some(indicator => htmlLower.includes(indicator))) {
            return 'parked';
          }

          // Skip weak indicators for substantial content (>30KB)
          if (contentSize > 30000) {
            return 'live';
          }

          // Weak indicators - need 3+ matches on small pages
          const weakIndicators = [
            'domain for sale',
            'buy this domain',
            'make an offer',
            'expired domain',
            'purchase this domain',
            'coming soon',
            'under construction'
          ];

          const matchCount = weakIndicators.filter(indicator =>
            htmlLower.includes(indicator)
          ).length;

          if (matchCount >= 3) {
            return 'parked';
          }
        }
      } catch (contentError) {
        // Content check failed, continue
      }

      return 'live';
    }

    // Check for Cloudflare (only available in cors mode)
    if (usedCors) {
      const serverHeader = response.headers.get('server');
      const cfRay = response.headers.get('cf-ray');
      if (serverHeader?.toLowerCase().includes('cloudflare') || cfRay) {
        return 'live';
      }

      // Status codes that indicate live but blocking
      const liveButBlocking = [401, 403, 405, 406, 429];
      if (liveButBlocking.includes(response.status)) {
        return 'live';
      }

      // 5xx - try GET fallback
      if (response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
    }

    // Site is reachable and not parked
    return 'live';

  } catch (error) {
    clearTimeout(timeoutId);

    // Timeout = slow server (live)
    if (error.name === 'AbortError') {
      return 'live';
    }

    // NetworkError usually means CORS (site exists but blocks us)
    if (error.message?.includes('NetworkError') ||
        error.message?.includes('CORS')) {
      return 'live';
    }

    // Try GET fallback
    try {
      let fallbackResponse;
      let usedCorsFallback = false;

      try {
        const corsController = new AbortController();
        const corsTimeout = setTimeout(() => corsController.abort(), 8000);

        fallbackResponse = await fetch(url, {
          method: 'GET',
          signal: corsController.signal,
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow',
          headers: headers
        });
        clearTimeout(corsTimeout);
        usedCorsFallback = true;
      } catch (corsError) {
        // CORS blocked, try no-cors mode with fresh controller
        const noCorsController = new AbortController();
        const noCorsTimeout = setTimeout(() => noCorsController.abort(), 8000);

        fallbackResponse = await fetch(url, {
          method: 'GET',
          signal: noCorsController.signal,
          mode: 'no-cors',
          credentials: 'omit',
          redirect: 'follow',
          headers: headers
        });
        clearTimeout(noCorsTimeout);
      }

      // Check if redirected to parking domain (only works with cors mode)
      if (usedCorsFallback && fallbackResponse.url) {
        try {
          const finalHost = new URL(fallbackResponse.url).hostname.toLowerCase();
          const originalHost = new URL(url).hostname.toLowerCase();

          if (finalHost !== originalHost &&
              !isParkingExempt(finalHost) &&
              PARKING_DOMAINS.some(domain => finalHost.includes(domain))) {
            return 'parked';
          }
        } catch (e) {
          // URL parsing failed, continue with live status
        }

        // Check response status (only available in cors mode)
        // 404, 410, 451 indicate the content is gone
        if (fallbackResponse.status === 404 || fallbackResponse.status === 410 || fallbackResponse.status === 451) {
          return 'dead';
        }
      }

      // Check Cloudflare (only available in cors mode)
      if (usedCorsFallback) {
        const fbServerHeader = fallbackResponse.headers.get('server');
        const fbCfRay = fallbackResponse.headers.get('cf-ray');
        if (fbServerHeader?.toLowerCase().includes('cloudflare') || fbCfRay) {
          return 'live';
        }

        if (fallbackResponse.ok) {
          return 'live';
        }
      }

      return 'live';
    } catch (fallbackError) {
      // Timeout = slow server (live)
      if (fallbackError.name === 'AbortError') {
        return 'live';
      }

      // NetworkError usually means CORS (site exists but blocks us)
      if (fallbackError.message?.includes('NetworkError') ||
          fallbackError.message?.includes('CORS')) {
        return 'live';
      }

      // Both HEAD and GET failed - link is likely dead
      return 'dead';
    }
  }
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

// Performance optimization: Batch results to reduce main thread messages
let pendingResults = [];
let batchTimer = null;

/**
 * Batch scan results to reduce main thread messages
 * Instead of sending a message for each bookmark, collect results and send in batches
 */
function queueResult(result) {
  pendingResults.push(result);

  // Clear existing timer
  if (batchTimer) {
    clearTimeout(batchTimer);
  }

  // Send batch after 500ms or when 5 results are queued (reduced frequency and batch size)
  batchTimer = setTimeout(() => {
    if (pendingResults.length > 0) {
      self.postMessage({
        action: 'batchScanComplete',
        data: {
          results: pendingResults
        }
      });
      pendingResults = [];
    }
  }, 500);
}

// Store blocklist data passed from main thread
let blocklist = new Set();
let domainSourceMap = new Map();
let domainOnlyMap = new Map();
let trustedDomains = [];

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
async function checkURLVoidScraping(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    console.log(`[URLVoid Scraping] Checking ${hostname}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const urlvoidUrl = `https://www.urlvoid.com/scan/${encodeURIComponent(hostname)}/`;

    // Website version needs CORS proxy (unlike browser extensions)
    const proxiedUrl = `https://corsproxy.io/?${encodeURIComponent(urlvoidUrl)}`;

    const response = await fetch(proxiedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/91.0'
      }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[URLVoid Scraping] Failed to fetch URLVoid for ${hostname}: ${response.status}`);
      return 'unknown';
    }

    const html = await response.text();

    const detectedPattern = /detected/gi;
    const detectedMatches = html.match(detectedPattern) || [];
    const detectedCount = detectedMatches.length;

    console.log(`[URLVoid Scraping] ${hostname} - Detected: ${detectedCount}`);

    if (detectedCount >= 2) {
      return 'unsafe'; // 2 or more scanners detected malicious
    } else if (detectedCount === 1) {
      return 'warning'; // 1 scanner detected suspicious
    } else {
      return 'safe'; // No detections
    }

  } catch (error) {
    console.log(`[URLVoid Scraping] Error:`, error.message);
    return 'unknown';
  }
}

/**
 * Check URL using VirusTotal API
 * Requires API key - get free key at https://www.virustotal.com/gui/my-apikey
 * Free tier: 500 requests per day, 4 requests per minute
 */
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
    const reportTimeout = setTimeout(() => reportController.abort(), 15000);

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
  console.log(`[Safety Check] Starting safety check for ${url}`);

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

      console.log(`[Blocklist] URL not in malicious database`);
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
    console.log(`[Safety Check] Checking URLVoid scraping...`);
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

      // Initialize with API keys and blocklist data
      if (data.apiKeys) {
        apiKeys = data.apiKeys;
        console.log('[Worker] API keys initialized:', {
          google: !!apiKeys.googleSafeBrowsingApiKey,
          yandex: !!apiKeys.yandexApiKey,
          virustotal: !!apiKeys.virusTotalApiKey
        });
      }
      if (data.blocklist) {
        blocklist = new Set(data.blocklist);
        console.log(`[Worker] Blocklist initialized with ${blocklist.size} domains`);
      }
      if (data.domainSourceMap) {
        domainSourceMap = new Map(data.domainSourceMap);
        console.log(`[Worker] Domain source map initialized with ${domainSourceMap.size} entries`);
      }
      if (data.domainOnlyMap) {
        domainOnlyMap = new Map(data.domainOnlyMap);
        console.log(`[Worker] Domain-only map initialized with ${domainOnlyMap.size} entries`);
      }
      if (data.trustedDomains) {
        trustedDomains = data.trustedDomains;
        console.log(`[Worker] Trusted domains list initialized with ${trustedDomains.length} domains`);
      }

      // Mark worker as initialized
      isWorkerInitialized = true;
      console.log('[Worker] Initialization complete');

      self.postMessage({
        action: 'initComplete',
        data: { success: true }
      });
      break;

    case 'resetRateLimit':
      virusTotalRateLimited = false;
      console.log('[Worker] Rate limit reset for new scan');
      break;

    case 'scanBookmark':
      try {
        // Scan both link and safety
        const [linkStatus, safetyResult] = await Promise.all([
          checkLinkStatus(data.url),
          checkSafetyStatus(data.url)
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

console.log('Scanner worker initialized');
