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
    // Try HEAD request first
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      headers: headers
    });
    clearTimeout(timeoutId);

    // Check if redirected to parking domain
    if (response.redirected || response.url !== url) {
      const finalHost = new URL(response.url).hostname.toLowerCase();
      if (!isParkingExempt(finalHost) && PARKING_DOMAINS.some(domain => finalHost.includes(domain))) {
        return 'parked';
      }
    }

    // Check for successful status codes
    if (response.ok || (response.status >= 300 && response.status < 400)) {
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

    // Check for Cloudflare
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

    // 5xx or 404 - try GET fallback
    if (response.status >= 500 || response.status === 404) {
      throw new Error(`HTTP ${response.status}`);
    }

    // 410 (Gone), 451 (Legal) - truly dead
    return 'dead';

  } catch (error) {
    clearTimeout(timeoutId);

    // Timeout = slow server (live)
    if (error.name === 'AbortError') {
      return 'live';
    }

    // Try GET fallback
    try {
      const fallbackController = new AbortController();
      const fallbackTimeout = setTimeout(() => fallbackController.abort(), 8000);

      const fallbackResponse = await fetch(url, {
        method: 'GET',
        signal: fallbackController.signal,
        credentials: 'omit',
        redirect: 'follow',
        headers: headers
      });
      clearTimeout(fallbackTimeout);

      // Check Cloudflare
      const fbServerHeader = fallbackResponse.headers.get('server');
      const fbCfRay = fallbackResponse.headers.get('cf-ray');
      if (fbServerHeader?.toLowerCase().includes('cloudflare') || fbCfRay) {
        return 'live';
      }

      if (fallbackResponse.ok) {
        return 'live';
      }

      return 'dead';
    } catch (fallbackError) {
      // Timeout = slow server
      if (fallbackError.name === 'AbortError') {
        return 'live';
      }

      // NetworkError usually means CORS (site exists but blocks us)
      if (fallbackError.message?.includes('NetworkError') ||
          fallbackError.message?.includes('CORS')) {
        return 'live';
      }

      // Everything failed - likely dead
      return 'dead';
    }
  }
}

/**
 * Check safety status (basic implementation)
 */
async function checkSafetyStatus(url) {
  // TODO: Implement full safety checking with blocklists
  // For now, return safe for all non-suspicious patterns

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, // IP address
      /[a-z0-9]{32,}/, // Very long random strings
      /-free-/, /-download-/, /-crack-/, /-keygen-/
    ];

    if (suspiciousPatterns.some(pattern => pattern.test(hostname))) {
      return { status: 'warning', sources: ['Suspicious pattern detected'] };
    }

    return { status: 'safe', sources: [] };
  } catch (e) {
    return { status: 'unknown', sources: [] };
  }
}

/**
 * Message handler
 */
self.addEventListener('message', async (e) => {
  const { action, data } = e.data;

  switch (action) {
    case 'checkLink':
      try {
        const status = await checkLinkStatus(data.url);
        self.postMessage({
          action: 'linkResult',
          data: {
            url: data.url,
            id: data.id,
            status: status
          }
        });
      } catch (error) {
        self.postMessage({
          action: 'linkError',
          data: {
            url: data.url,
            id: data.id,
            error: error.message
          }
        });
      }
      break;

    case 'checkSafety':
      try {
        const result = await checkSafetyStatus(data.url);
        self.postMessage({
          action: 'safetyResult',
          data: {
            url: data.url,
            id: data.id,
            status: result.status,
            sources: result.sources
          }
        });
      } catch (error) {
        self.postMessage({
          action: 'safetyError',
          data: {
            url: data.url,
            id: data.id,
            error: error.message
          }
        });
      }
      break;

    case 'scanBookmark':
      try {
        // Scan both link and safety
        const [linkStatus, safetyResult] = await Promise.all([
          checkLinkStatus(data.url),
          checkSafetyStatus(data.url)
        ]);

        self.postMessage({
          action: 'scanComplete',
          data: {
            url: data.url,
            id: data.id,
            linkStatus: linkStatus,
            safetyStatus: safetyResult.status,
            safetySources: safetyResult.sources
          }
        });
      } catch (error) {
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
