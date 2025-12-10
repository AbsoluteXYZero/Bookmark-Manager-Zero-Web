# Combined Cloudflare Worker Setup

This guide explains how to use a **single Cloudflare Worker** to handle both:
1. **Website Proxy**: Access the GitHub Pages site via `bmzweb.absolutezero.fyi`
2. **GitHub API Proxy**: Access GitHub API via `github-api.absolutezero.fyi`

## Benefits of Combined Worker

- ✅ Single worker deployment (easier to manage)
- ✅ Both proxies use the same worker code
- ✅ No extra cost (still within free tier)
- ✅ Simpler configuration

## Setup Steps

### 1. Update Your Existing Worker

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages
2. Find your existing worker (the one currently proxying the website)
3. Click **Edit Code**
4. **Replace all code** with the contents of `cloudflare-worker-combined.js`
5. Click **Save and Deploy**

### 2. Add Second Custom Domain

You already have `bmzweb.absolutezero.fyi` set up for the website. Now add the API proxy domain:

1. In your worker settings, go to **Triggers** tab
2. Under **Custom Domains**, click **Add Custom Domain**
3. Enter: `github-api.absolutezero.fyi`
4. Click **Add Custom Domain**
5. Wait for DNS propagation (~5 minutes)

Your worker now responds to **both** domains:
- `bmzweb.absolutezero.fyi` → GitHub Pages proxy
- `github-api.absolutezero.fyi` → GitHub API proxy

### 3. How It Works

The worker checks the hostname of incoming requests:

```javascript
if (url.hostname === 'github-api.absolutezero.fyi') {
  // Handle as GitHub API request
  // Proxy to api.github.com
} else {
  // Handle as website request
  // Proxy to GitHub Pages
}
```

**Example flows:**

```
Website access:
https://bmzweb.absolutezero.fyi/
  → Worker checks hostname
  → Proxies to https://absolutexyzero.github.io/Bookmark-Manager-Zero-Web/
  → Returns website content

API access:
https://github-api.absolutezero.fyi/user
  → Worker checks hostname
  → Proxies to https://api.github.com/user
  → Adds CORS headers
  → Returns GitHub API response
```

### 4. Test Both Functions

**Test Website Proxy:**
1. Visit `https://bmzweb.absolutezero.fyi` in your browser
2. You should see the BMZ website

**Test API Proxy:**
1. Open browser console (F12)
2. Run this test:
```javascript
fetch('https://github-api.absolutezero.fyi/user', {
  headers: {
    'Authorization': 'token YOUR_GITHUB_TOKEN',
    'Accept': 'application/vnd.github.v3+json'
  }
})
.then(r => r.json())
.then(d => console.log('API Proxy Success!', d))
.catch(e => console.error('API Proxy Failed:', e));
```

If you see your GitHub user info, both proxies are working!

## Automatic Fallback

The BMZ app is already configured to automatically use the proxy if direct GitHub access fails:

1. User opens BMZ on blocked network
2. App tries direct connection to `api.github.com` → **BLOCKED**
3. App automatically retries via `github-api.absolutezero.fyi` → **SUCCESS**
4. App saves this preference and uses proxy for all future requests

No manual configuration needed!

## What Changed from Original Worker

Your original worker only handled website proxying:
```javascript
export default {
  async fetch(request) {
    // Only handled GitHub Pages
    const targetUrl = 'https://absolutexyzero.github.io/...';
    // ...
  }
};
```

The new combined worker adds API proxy logic:
```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // NEW: Check if this is an API request
    if (url.hostname === 'github-api.absolutezero.fyi') {
      return handleGitHubAPI(request, url);  // NEW
    }

    // Original: Handle website proxy
    return handleGitHubPages(request, url);
  }
};
```

## DNS Configuration

After adding the second custom domain, your Cloudflare DNS should have:

| Type | Name | Content |
|------|------|---------|
| CNAME | bmzweb | your-worker.workers.dev |
| CNAME | github-api | your-worker.workers.dev |

Both point to the **same worker**, but the worker routes differently based on which domain was used.

## Cost & Performance

**Free Tier Limits:**
- 100,000 requests/day total (shared between both proxies)
- No bandwidth charges
- No extra cost for multiple domains on same worker

**Typical Usage:**
- Website loads: ~10 requests per page load
- API requests: ~1,500-2,000 per day for sync operations
- **Total: ~3,000-5,000 requests/day** (well within free tier)

## Troubleshooting

### Website works but API doesn't?

1. Verify `github-api.absolutezero.fyi` is in Custom Domains list
2. Check DNS propagation: `nslookup github-api.absolutezero.fyi`
3. Test worker directly: Visit worker URL in browser

### API works but website doesn't?

1. Make sure you didn't remove the website proxy code
2. Check if `bmzweb.absolutezero.fyi` is still in Custom Domains
3. Clear browser cache and try again

### Both stopped working?

1. Check worker deployment status in dashboard
2. Look for worker errors in Cloudflare logs
3. Verify you deployed the new code (Save and Deploy)

### Reset Everything

If you need to start over:

1. Delete worker in Cloudflare dashboard
2. Create new worker
3. Paste `cloudflare-worker-combined.js` code
4. Add both custom domains
5. Wait for DNS propagation

## Security Notes

- Worker does NOT store or log GitHub tokens
- All authentication headers pass through unchanged
- CORS headers only added for API proxy (needed for browser access)
- Website proxy maintains original security model

## Alternative: Separate Workers

If you prefer separate workers (more isolated but harder to manage):

1. **Worker 1** (Website): Use your original code
   - Custom domain: `bmzweb.absolutezero.fyi`

2. **Worker 2** (API): Use `cloudflare-worker-github-api-proxy.js`
   - Custom domain: `github-api.absolutezero.fyi`

Both approaches work identically from the user's perspective.

## Summary

✅ Replace your existing worker code with `cloudflare-worker-combined.js`
✅ Add `github-api.absolutezero.fyi` as second custom domain
✅ Test both domains work
✅ BMZ will automatically use proxy when needed

That's it! One worker, two domains, full functionality on blocked networks.
