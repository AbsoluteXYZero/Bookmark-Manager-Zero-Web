/**
 * Cloudflare Worker - GitHub API Proxy
 * Deploy this to proxy GitHub API requests through Cloudflare
 *
 * Setup:
 * 1. Go to Cloudflare Dashboard -> Workers & Pages
 * 2. Create a new Worker
 * 3. Paste this code
 * 4. Deploy
 * 5. Set up a custom domain (e.g., github-api.absolutezero.fyi)
 * 6. Update the proxyUrl in gist-adapter.js to your worker URL
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)

  // Extract the target GitHub API path from the URL
  // Example: https://github-api.absolutezero.fyi/user
  // Should proxy to: https://api.github.com/user
  const apiPath = url.pathname + url.search

  // Build the GitHub API URL
  const githubApiUrl = `https://api.github.com${apiPath}`

  console.log('Proxying request to:', githubApiUrl)

  // Clone the headers from the original request
  const headers = new Headers(request.headers)

  // Remove host header (will be set automatically)
  headers.delete('host')

  // Create new request to GitHub API
  const githubRequest = new Request(githubApiUrl, {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
  })

  try {
    // Fetch from GitHub API
    const githubResponse = await fetch(githubRequest)

    // Clone the response so we can modify headers
    const response = new Response(githubResponse.body, githubResponse)

    // Add CORS headers
    response.headers.set('Access-Control-Allow-Origin', '*')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept')
    response.headers.set('Access-Control-Max-Age', '86400')

    return response
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Proxy error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
}

// Handle preflight requests
addEventListener('fetch', event => {
  const request = event.request
  if (request.method === 'OPTIONS') {
    event.respondWith(new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Max-Age': '86400'
      }
    }))
  }
})
