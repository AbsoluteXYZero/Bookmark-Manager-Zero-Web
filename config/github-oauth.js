/**
 * GitHub OAuth Configuration - Device Code Flow Only
 *
 * IMPORTANT: This app uses GitHub's Device Code Flow, which is designed for
 * applications that cannot securely store client secrets (like static websites).
 *
 * Setup Instructions:
 * 1. Go to: https://github.com/settings/developers
 * 2. Click "New OAuth App"
 * 3. Fill in:
 *    - Application name: Bookmark Manager Zero Web
 *    - Homepage URL: https://bmzweb.absolutezero.fyi (or your domain)
 *    - Authorization callback URL: (leave blank - not used for device flow)
 * 4. Click "Register application"
 * 5. Copy the Client ID and paste it below
 * 6. Note: Client Secret is NOT needed for device flow
 */

export const GITHUB_OAUTH = {
  // Client ID - safe to expose publicly for device flow
  clientId: 'YOUR_CLIENT_ID_HERE', // Replace with your OAuth app client ID

  // Required scope for accessing Gists
  scope: 'gist',

  // GitHub OAuth endpoints
  endpoints: {
    deviceCode: 'https://github.com/login/device/code',
    token: 'https://github.com/login/oauth/access_token',
    deviceAuthorize: 'https://github.com/login/device'
  }
};
