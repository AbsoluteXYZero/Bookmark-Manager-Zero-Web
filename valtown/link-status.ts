/**
 * BMZ link status checker - Val.town HTTP val
 *
 * Deployed at val.town, NOT part of the website build. The CI `pages:` job only
 * copies css/icons/js/workers/index.html, so this directory never ships - it
 * lives here for version control alongside the code that calls it.
 *
 * WHY THIS EXISTS
 * A browser cannot read the HTTP status of a cross-origin response: CORS gives
 * back an opaque result with status forced to 0. The extensions get real status
 * codes because host permissions exempt them; the website cannot. So a dead
 * bookmark shows green on the website and red in the extension.
 *
 * This val does the fetch server-side and returns just the status code with
 * permissive CORS, which the page IS allowed to read.
 *
 * WHY IT IS CHEAP
 * It never relays a body. HEAD first; if the server refuses HEAD (plenty do,
 * with 405/501) it falls back to GET and cancels the body stream the moment
 * headers arrive. Responses are ~120 bytes instead of a ~250KB page, which is
 * the difference between ~14 and ~1700 full library scans per 10GB.
 *
 * BATCH MODE MATTERS
 * Val.town free tier allows 1000 requests/minute, shared across every BMZ user
 * because they all call this one val. Checking 2909 bookmarks one request at a
 * time would burn 2909 of those. POST a batch of 50 and it costs 59 instead.
 */

// Set with: POST /v2/vals/{val_id}/environment_variables/ {"key":"BMZ_TOKEN",...}
// or through the val.town UI. Deliberately NOT hardcoded: free-tier vals are
// public, so a literal here would be readable by anyone, but environment
// variables are not source and stay secret even on a public val.
//
// It is still sent from browser JS, so anyone reading the deployed page's
// network traffic can see it - it deters drive-by scanners, not a determined
// user. The cache, the batch cap and the SSRF guard are the real protection.
const TOKEN = Deno.env.get("BMZ_TOKEN");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 8000;     // dead hosts must not hold a slot for long
const MAX_REDIRECTS = 5;
// Same 1-minute ceiling applies here: 50/15 = 4 rounds x 8s = ~32s worst case.
// At the original concurrency of 10 it was 5 rounds = 40s, which left too little
// margin once a batch arrives with many slow hosts in it.
const MAX_BATCH = 50;
const BATCH_CONCURRENCY = 15;

// url -> { status, finalUrl, redirects, expires }
// Survives between invocations while the worker is warm. Across a real user
// base many people bookmark the same sites, so this collapses duplicate
// upstream fetches to one.
const cache = new Map<string, any>();

/* [ZeroLabs] 2026-08-28 - added: reflect known origins instead of "*" */
// BMZ is open source and the token ships in the page, so this endpoint is
// effectively public. The realistic abuse is someone pointing their own site at
// it and spending Zero's shared 1000/min quota through their visitors' browsers.
//
// Reflecting only known origins stops exactly that: a browser will refuse to let
// a page read a response whose Access-Control-Allow-Origin does not match it.
//
// It does NOT stop curl or a server, which can send any Origin they like or none.
// That is accepted rather than defended against: there is nothing user-specific
// here to leak, the SSRF guard stops it being aimed at infrastructure, and the
// worst case is quota burn - fixed in two minutes by rotating BMZ_TOKEN in the
// val.town UI and the matching constant in workers/scanner-worker.js.
// ---------------------------------------------------------------------------
// SELF-HOSTING: change these.
//
// This list is specific to the author's deployment. If you are running your own
// copy of BMZ, replace the two https entries with your own domain(s), or empty
// the array entirely if you do not want any origin restriction - an empty list
// simply means every browser request gets "null" and is refused, so do not leave
// it empty by accident. To allow anything, return "*" from corsFor() instead.
//
// You will also need your OWN val rather than pointing at the author's, which
// will refuse your origin anyway. Deploy this file as an HTTP val, set a
// BMZ_TOKEN environment variable on it, then update these two constants near the
// top of workers/scanner-worker.js to match:
//
//     const LINK_VAL_URL   = 'https://<you>--<hash>.web.val.run';
//     const LINK_VAL_TOKEN = '<your BMZ_TOKEN>';
//
// The localhost entries are for running the site from a local HTTP server during
// development; harmless to keep, since a page served from localhost is yours.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://bmzweb.absolutezero.fyi",
  "https://bookmarkmanagerzero.absolutezero.fyi",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
];

function corsFor(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    // No Origin at all (curl, a server) gets "*": harmless, since there is no
    // browser to protect and nothing user-specific in any response.
    "Access-Control-Allow-Origin": allowed ? origin : (origin ? "null" : "*"),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(req ? corsFor(req) : { "Access-Control-Allow-Origin": "*" }),
      "Content-Type": "application/json",
    },
  });
}

/**
 * SSRF guard. This endpoint fetches whatever it is told to, so it must refuse
 * anything that could reach infrastructure rather than the public web.
 */
function isFetchable(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  const host = u.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".val.run") ||
    host.endsWith(".val.town")
  ) return false;

  // Literal private / loopback / link-local / metadata addresses
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (host === "[::1]" || host === "::1") return false;

  return true;
}

async function fetchStatus(target: string) {
  const cached = cache.get(target);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.value, cached: true };
  }

  if (!isFetchable(target)) {
    return { url: target, status: null, error: "unfetchable" };
  }

  let current = target;
  let redirects = 0;

  try {
    while (redirects <= MAX_REDIRECTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(current, {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; BMZ link check)" },
        });

        // Many servers reject HEAD outright. Retry as GET, but cancel the body
        // as soon as the headers are in - the status line is all we want.
        if (res.status === 405 || res.status === 501) {
          res = await fetch(current, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; BMZ link check)" },
          });
        }
      } finally {
        clearTimeout(timer);
      }

      // Never download the body, whichever method got us here
      try { await res.body?.cancel(); } catch { /* already closed */ }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current).toString();
        if (!isFetchable(next)) {
          const value = { url: target, status: null, error: "redirect-blocked" };
          cache.set(target, { value, expires: Date.now() + CACHE_TTL_MS });
          return value;
        }
        current = next;
        redirects++;
        continue;
      }

      const value = { url: target, status: res.status, finalUrl: current, redirects };
      cache.set(target, { value, expires: Date.now() + CACHE_TTL_MS });
      return value;
    }

    const value = { url: target, status: null, error: "too-many-redirects" };
    cache.set(target, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err: any) {
    // A refused connection or DNS failure is real information: the host did not
    // answer. Distinguished from a status code so the caller can decide.
    const value = {
      url: target,
      status: null,
      error: err?.name === "AbortError" ? "timeout" : "unreachable",
    };
    cache.set(target, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }
}

// Bounded parallelism: the val has a 1 minute execution ceiling, so a batch of
// 50 at 8s worst case each must not run serially.
async function checkAll(urls: string[]) {
  const results: any[] = new Array(urls.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(BATCH_CONCURRENCY, urls.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= urls.length) return;
        results[i] = await fetchStatus(urls[i]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/**
 * URLVoid detection count.
 *
 * The website reaches URLVoid through public CORS proxies today and they have
 * all rotted: corsproxy.io 403s every request without exception, codetabs
 * returns 522, and allorigins works intermittently but hangs for 19-20 seconds
 * before failing. That hanging is the single largest cost in a scan.
 *
 * Counting happens HERE and only the number crosses the wire - the page is
 * ~36KB and the answer is one integer, so this stays cheap the same way the
 * status route does.
 *
 * The count is occurrences of the word "detected" in the page. Crude, but it is
 * what the extensions already use and it is calibrated: google.com 0,
 * pastes.io 3, netfilm.app 5.
 */
// Sized against the val's 1 MINUTE execution ceiling, not against comfort.
// Worst case is (batch / concurrency) rounds x timeout: 10/5 = 2 rounds x 15s =
// 30s, leaving headroom. The obvious-looking 25/5 with a 20s timeout would be 5
// rounds = 100s and the val would be killed part way through the batch.
const URLVOID_TIMEOUT_MS = 15000;
const URLVOID_MAX_BATCH = 10;
const URLVOID_CONCURRENCY = 5;

async function urlvoidCount(domain: string) {
  const clean = String(domain || "").trim().toLowerCase();
  if (!clean || !/^[a-z0-9.-]+$/.test(clean)) {
    return { domain, count: null, error: "bad-domain" };
  }

  const cacheKey = `urlvoid:${clean}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.value, cached: true };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URLVOID_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`https://www.urlvoid.com/scan/${encodeURIComponent(clean)}/`, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      return { domain: clean, count: null, error: `http-${res.status}` };
    }

    const html = await res.text();

    // URLVoid answers 200 with a "Report Not Found" page for any domain it has
    // never scanned. That page contains no "detected" either, so a naive count
    // reads it as ZERO DETECTIONS = clean, when it actually means "no data".
    // That is a silent false-clean, and it is the failure direction that matters
    // for a safety check. Detected by the page's own marker rather than by size:
    // the same page measured 12688 bytes locally and 12834 from the val, so a
    // byte threshold would be brittle.
    if (/Report Not Found/i.test(html)) {
      const value = { domain: clean, count: null, error: "no-report", bytes: html.length };
      cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
      return value;
    }

    const count = (html.match(/detected/gi) || []).length;

    // `bytes` is returned so the caller can still sanity-check that a real scan
    // page came back, in case URLVoid introduces another shape of empty answer.
    const value = { domain: clean, count, bytes: html.length };
    cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err: any) {
    return {
      domain: clean,
      count: null,
      error: err?.name === "AbortError" ? "timeout" : "unreachable",
    };
  }
}

async function urlvoidAll(domains: string[]) {
  const results: any[] = new Array(domains.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(URLVOID_CONCURRENCY, domains.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= domains.length) return;
        results[i] = await urlvoidCount(domains[i]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsFor(req) });

  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return json({ status: "ok", cached: cache.size }, 200, req);
  }

  // Fail closed. If BMZ_TOKEN was never set, an undefined TOKEN would otherwise
  // match a caller who simply omitted ?key= and leave this wide open.
  if (!TOKEN) return json({ error: "server not configured" }, 503, req);

  const key = url.searchParams.get("key");
  if (key !== TOKEN) return json({ error: "bad key" }, 403, req);

  // URLVoid: GET ?domain=... or POST { domains: [...] }
  if (url.pathname === "/urlvoid") {
    if (req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "bad json" }, 400, req);
      }

      const domains = Array.isArray(body?.domains) ? body.domains : null;
      if (!domains) return json({ error: "expected { domains: [...] }" }, 400, req);
      if (domains.length > URLVOID_MAX_BATCH) {
        return json({ error: `max ${URLVOID_MAX_BATCH} domains per request` }, 400, req);
      }

      return json({ results: await urlvoidAll(domains) }, 200, req);
    }

    const domain = url.searchParams.get("domain");
    if (!domain) return json({ error: "missing domain" }, 400, req);
    return json(await urlvoidCount(domain), 200, req);
  }

  // Batch: POST { urls: [...] }
  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad json" }, 400, req);
    }

    const urls = Array.isArray(body?.urls) ? body.urls : null;
    if (!urls) return json({ error: "expected { urls: [...] }" }, 400, req);
    if (urls.length > MAX_BATCH) {
      return json({ error: `max ${MAX_BATCH} urls per request` }, 400, req);
    }

    return json({ results: await checkAll(urls) }, 200, req);
  }

  // Single: GET ?url=...
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "missing url" }, 400, req);

  return json(await fetchStatus(target), 200, req);
}
