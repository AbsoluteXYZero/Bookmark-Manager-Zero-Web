/**
 * GitHub OAuth - Standard Web Flow
 * Implements redirect-based OAuth for seamless authentication
 */

import authManager from './auth-manager.js';
import { GITHUB_OAUTH, getAuthorizationUrl, generateState } from '../../config/github-oauth.js';

class OAuthWeb {
  constructor() {
    this.isProcessing = false;
  }

  /**
   * Initiate OAuth flow by redirecting to GitHub
   */
  async initiateLogin() {
    // Generate and store state for CSRF protection
    const state = generateState();
    sessionStorage.setItem('oauth_state', state);

    // Store return URL for post-authentication redirect
    sessionStorage.setItem('oauth_return_url', window.location.pathname);

    // Redirect to GitHub authorization
    const authUrl = getAuthorizationUrl(state);
    console.log('Redirecting to GitHub for authorization...');
    window.location.href = authUrl;
  }

  /**
   * Handle OAuth callback from GitHub
   * Should be called when the page loads with code parameter
   */
  async handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');

    // Check for errors
    if (error) {
      throw new Error(`OAuth error: ${error} - ${params.get('error_description')}`);
    }

    // Validate we have a code
    if (!code) {
      return null; // Not an OAuth callback
    }

    // Validate state for CSRF protection
    const storedState = sessionStorage.getItem('oauth_state');
    if (!state || state !== storedState) {
      throw new Error('Invalid OAuth state - possible CSRF attack');
    }

    // Exchange code for token
    console.log('Exchanging authorization code for access token...');
    const token = await this.exchangeCodeForToken(code);

    // Store token
    await authManager.storeToken(token);

    // Clean up
    sessionStorage.removeItem('oauth_state');
    const returnUrl = sessionStorage.getItem('oauth_return_url') || '/';
    sessionStorage.removeItem('oauth_return_url');

    // Clear URL parameters
    window.history.replaceState({}, document.title, returnUrl);

    return token;
  }

  /**
   * Exchange authorization code for access token
   *
   * NOTE: This requires a backend proxy or serverless function because
   * GitHub's token endpoint doesn't support CORS for browser requests.
   *
   * Options:
   * 1. Use a serverless function (Cloudflare Workers, Vercel Edge, etc.)
   * 2. Use GitHub's CORS proxy if available
   * 3. Use a simple proxy service
   *
   * For now, this uses the direct approach (will need CORS proxy)
   */
  async exchangeCodeForToken(code) {
    const config = GITHUB_OAUTH.active;

    try {
      // Option 1: Try direct request (will fail due to CORS)
      const response = await fetch(GITHUB_OAUTH.endpoints.token, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret, // NOTE: Should NOT be exposed in production
          code: code,
          redirect_uri: config.redirectUri
        })
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`Token exchange error: ${data.error_description || data.error}`);
      }

      return data.access_token;
    } catch (error) {
      console.error('Token exchange failed:', error);

      // Fallback: Use proxy service
      // TODO: Implement proxy service or serverless function
      throw new Error(
        'Token exchange requires a backend proxy. ' +
        'Please use Device Code Login instead, or set up a proxy service.'
      );
    }
  }

  /**
   * Check if current URL is an OAuth callback
   */
  isCallback() {
    const params = new URLSearchParams(window.location.search);
    return params.has('code') || params.has('error');
  }

  /**
   * Logout (clear token)
   */
  async logout() {
    await authManager.clearToken();
    console.log('Logged out successfully');
  }
}

// Export singleton instance
const oauthWeb = new OAuthWeb();
export default oauthWeb;

// Also export the class for testing
export { OAuthWeb };
