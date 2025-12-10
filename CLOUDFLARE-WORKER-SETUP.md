# Cloudflare Worker Setup for GitHub API Proxy

This guide explains how to set up a Cloudflare Worker to proxy GitHub API requests, allowing BMZ to work on networks that block GitHub.

## Why This Is Needed

Some networks (schools, workplaces, public WiFi) block access to `github.com` and `api.github.com`. The Bookmark Manager Zero web app needs to access the GitHub API to:
- Authenticate users
- Read/write bookmark data stored in GitHub Gists
- Sync bookmarks across devices

By deploying a Cloudflare Worker on your own domain, you can proxy these requests through Cloudflare's network, bypassing the block.

## Setup Steps

### 1. Create a Cloudflare Worker

1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Go to **Workers & Pages**
3. Click **Create Application**
4. Select **Create Worker**
5. Give it a name like `github-api-proxy`
6. Click **Deploy**

### 2. Add the Worker Code

1. After deployment, click **Edit Code**
2. Delete all existing code
3. Copy the entire contents of `cloudflare-worker-github-api-proxy.js` from this repository
4. Paste it into the worker editor
5. Click **Save and Deploy**

### 3. Set Up a Custom Domain

1. In your worker settings, go to **Triggers** tab
2. Under **Custom Domains**, click **Add Custom Domain**
3. Enter a subdomain like: `github-api.absolutezero.fyi`
4. Click **Add Custom Domain**
5. Wait for DNS propagation (usually a few minutes)

### 4. Update BMZ Configuration (If Needed)

The app is already configured to use `https://github-api.absolutezero.fyi` as the default proxy URL.

If you used a different subdomain, you can update it in one of two ways:

**Option A: Change the default in code**
Edit `js/storage/gist-adapter.js` line 13:
```javascript
const proxyUrl = localStorage.getItem('bmz_proxy_url') || 'https://YOUR-SUBDOMAIN.YOUR-DOMAIN.com';
```

**Option B: Set it in browser console**
Open the app, press F12, and run:
```javascript
localStorage.setItem('bmz_proxy_url', 'https://YOUR-SUBDOMAIN.YOUR-DOMAIN.com');
```

### 5. Test the Proxy

1. Open your browser's developer console (F12)
2. Run this test:
```javascript
fetch('https://github-api.absolutezero.fyi/user', {
  headers: {
    'Authorization': 'token YOUR_GITHUB_TOKEN',
    'Accept': 'application/vnd.github.v3+json'
  }
})
.then(r => r.json())
.then(d => console.log('Success!', d))
.catch(e => console.error('Failed:', e));
```

If you see your GitHub user info, the proxy is working!

## How It Works

1. **Direct Connection Attempt**: BMZ first tries to connect directly to `api.github.com`
2. **Automatic Fallback**: If the direct connection fails (network block, timeout, etc.), it automatically retries through your Cloudflare Worker
3. **Permanent Switch**: Once the proxy connection succeeds, BMZ remembers this and uses the proxy for all future requests
4. **CORS Headers**: The worker adds necessary CORS headers so browsers allow the cross-origin requests

## Worker Request Flow

```
BMZ App → Cloudflare Worker → GitHub API → Cloudflare Worker → BMZ App
```

Example:
```
https://bmzweb.absolutezero.fyi (BMZ app)
   ↓
https://github-api.absolutezero.fyi/gists (Your proxy)
   ↓
https://api.github.com/gists (GitHub API)
   ↓
Response flows back through the same path
```

## Security Notes

- The worker does NOT store or log your GitHub token
- All authentication headers are passed directly to GitHub
- The worker only adds CORS headers to allow browser access
- Your GitHub token never touches Cloudflare's storage or logs

## Troubleshooting

### Proxy not working?

1. Check worker deployment status in Cloudflare dashboard
2. Verify custom domain is active (DNS propagated)
3. Test direct worker URL: `https://github-api-proxy.YOUR-SUBDOMAIN.workers.dev/user`
4. Check browser console for error messages

### Still can't connect?

1. Try clearing localStorage: `localStorage.clear()` in browser console
2. Check if your network also blocks Cloudflare domains
3. Verify your GitHub token is valid

### Reset to direct connection

Run in browser console:
```javascript
localStorage.setItem('bmz_use_proxy', 'false');
location.reload();
```

## Cost

Cloudflare Workers have a generous free tier:
- **100,000 requests per day** (more than enough for personal use)
- **No bandwidth charges**
- **No storage costs**

For typical BMZ usage (checking for updates every 60 seconds, manual sync operations), you'll use ~1,500-2,000 requests per day, well within the free tier.

## Alternative Proxy Services

If you can't use Cloudflare Workers, you can try these alternatives (update `bmz_proxy_url` accordingly):

- **Cloudflare Pages Functions**: Similar to Workers but deployed with your Pages site
- **Vercel Edge Functions**: Similar serverless function platform
- **AWS Lambda + API Gateway**: More complex but very reliable
- **Your own server**: Any server that can forward HTTP requests and add CORS headers

The worker code can be adapted to most serverless platforms with minimal changes.
