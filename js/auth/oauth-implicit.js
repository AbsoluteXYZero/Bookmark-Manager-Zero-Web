/**
 * GitHub OAuth Implicit Flow
 * Browser-friendly authentication using redirect flow
 */

import { GITHUB_OAUTH } from '../../config/github-oauth.js';

class OAuthImplicit {
  constructor() {
    this.clientId = GITHUB_OAUTH.clientId;
    this.scope = GITHUB_OAUTH.scope;
    this.redirectUri = window.location.origin + window.location.pathname;
    this.state = null;
  }

  /**
   * Generate random state for CSRF protection
   */
  generateState() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Start OAuth flow - redirect to GitHub
   */
  async startFlow() {
    // Generate and store state
    this.state = this.generateState();
    sessionStorage.setItem('oauth_state', this.state);

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scope,
      state: this.state,
      allow_signup: 'true'
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params}`;

    // Redirect to GitHub
    window.location.href = authUrl;
  }

  /**
   * Handle OAuth callback - extract code from URL
   * Returns the authorization code if present
   */
  handleCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');
    const errorDescription = urlParams.get('error_description');

    // Check for errors
    if (error) {
      console.error('OAuth error:', error, errorDescription);
      throw new Error(`Authentication failed: ${errorDescription || error}`);
    }

    // Check if we have a code
    if (!code) {
      return null;
    }

    // Verify state to prevent CSRF
    const storedState = sessionStorage.getItem('oauth_state');
    if (state !== storedState) {
      throw new Error('State mismatch - possible CSRF attack');
    }

    // Clean up
    sessionStorage.removeItem('oauth_state');

    // Clean URL (remove query parameters)
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);

    return code;
  }

  /**
   * Exchange authorization code for access token
   * This requires a backend proxy or GitHub App
   * For now, we'll return the code and handle it client-side
   */
  async exchangeCodeForToken(code) {
    // IMPORTANT: This normally requires a backend server because:
    // 1. Client secret must be kept secret
    // 2. GitHub's token endpoint doesn't support CORS
    //
    // Options:
    // A) Use GitHub App with client-side only flow (no secret needed)
    // B) Use a serverless function (Cloudflare Workers, Netlify Functions, etc.)
    // C) For now, we'll store the code and use it with GitHub API

    // For a static site, we need to use GitHub's client-side flow
    // which means using a Personal Access Token approach instead
    throw new Error('Token exchange requires a backend server. Please use Personal Access Token instead.');
  }

  /**
   * Alternative: Direct token input for testing
   * Users can create a Personal Access Token with 'gist' scope
   */
  async usePersonalAccessToken(token) {
    // Validate token by making a test API call
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error('Invalid token');
    }

    const user = await response.json();

    return {
      access_token: token,
      scope: 'gist',
      token_type: 'bearer',
      user: user
    };
  }
}

// Export singleton instance
const oauthImplicit = new OAuthImplicit();
export default oauthImplicit;
