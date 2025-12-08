/**
 * GitHub OAuth Configuration
 * Register your OAuth apps at: https://github.com/settings/developers
 */

// Detect environment
const isDevelopment = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

export const GITHUB_OAUTH = {
  // Development configuration (localhost)
  development: {
    clientId: 'YOUR_DEV_CLIENT_ID', // Replace with your development OAuth app client ID
    redirectUri: `${window.location.origin}/auth/callback`,
    scope: 'gist'
  },

  // Production configuration (GitHub Pages)
  production: {
    clientId: 'YOUR_PROD_CLIENT_ID', // Replace with your production OAuth app client ID
    redirectUri: `${window.location.origin}/auth/callback`,
    scope: 'gist'
  },

  // Get active configuration based on environment
  get active() {
    return isDevelopment ? this.development : this.production;
  },

  // GitHub OAuth endpoints
  endpoints: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    deviceCode: 'https://github.com/login/device/code',
    deviceAuthorize: 'https://github.com/login/device'
  }
};

// Helper to get authorization URL
export function getAuthorizationUrl(state) {
  const config = GITHUB_OAUTH.active;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state: state
  });
  return `${GITHUB_OAUTH.endpoints.authorize}?${params.toString()}`;
}

// Helper to generate secure random state
export function generateState() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
