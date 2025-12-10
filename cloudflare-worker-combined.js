/**
 * Combined Cloudflare Worker
 * Handles both:
 * 1. Proxying the GitHub Pages site (bmzweb.absolutezero.fyi)
 * 2. Proxying GitHub API requests (github-api.absolutezero.fyi)
 *
 * Deploy this worker and set up TWO custom domains:
 * - bmzweb.absolutezero.fyi (for the website)
 * - github-api.absolutezero.fyi (for API requests)
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Check if this is a GitHub API request
    // Any request to github-api.absolutezero.fyi should proxy to api.github.com
    if (url.hostname === 'github-api.absolutezero.fyi') {
      return handleGitHubAPI(request, url);
    }

    // Otherwise, handle as GitHub Pages proxy
    return handleGitHubPages(request, url);
  }
};

/**
 * Handle GitHub API proxy requests
 */
async function handleGitHubAPI(request, url) {
  // Build the GitHub API URL
  // Example: /gists -> https://api.github.com/gists
  const apiPath = url.pathname + url.search;
  const githubApiUrl = `https://api.github.com${apiPath}`;

  console.log('Proxying API request to:', githubApiUrl);

  // Clone the headers from the original request
  const headers = new Headers(request.headers);

  // Remove host header (will be set automatically)
  headers.delete('host');

  // Create new request to GitHub API
  const githubRequest = new Request(githubApiUrl, {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
  });

  try {
    // Fetch from GitHub API
    const githubResponse = await fetch(githubRequest);

    // Clone the response so we can modify headers
    const response = new Response(githubResponse.body, githubResponse);

    // Add CORS headers
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    response.headers.set('Access-Control-Max-Age', '86400');

    return response;
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'GitHub API proxy error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

/**
 * Handle GitHub Pages proxy requests
 */
async function handleGitHubPages(request, url) {
  // Handle preflight requests for CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  // Build the target GitHub Pages URL
  const targetUrl = new URL('https://absolutexyzero.github.io/Bookmark-Manager-Zero-Web' + url.pathname);
  targetUrl.search = url.search;

  // Fetch from GitHub Pages
  const response = await fetch(targetUrl.toString(), {
    headers: request.headers,
    method: request.method
  });

  const contentType = response.headers.get('content-type') || '';

  // Clone the response so we can modify it
  let newResponse = new Response(response.body, response);

  // Rewrite URLs in HTML
  if (contentType.includes('text/html')) {
    let html = await response.text();
    html = html.replace(/https:\/\/absolutexyzero\.github\.io\/Bookmark-Manager-Zero-Web/g, '');
    html = html.replace(/\/Bookmark-Manager-Zero-Web\//g, '/');

    // Inject CSS to hide the top link and footer
    html = html.replace('</head>', '<style>header a, .header-link, h1 a, footer, .footer, .site-footer { display: none !important; }</style></head>');

    newResponse = new Response(html, response);
  }

  // Rewrite URLs in CSS
  if (contentType.includes('text/css')) {
    let css = await response.text();
    css = css.replace(/https:\/\/absolutexyzero\.github\.io\/Bookmark-Manager-Zero-Web/g, '');
    css = css.replace(/\/Bookmark-Manager-Zero-Web\//g, '/');
    newResponse = new Response(css, response);
  }

  return newResponse;
}
