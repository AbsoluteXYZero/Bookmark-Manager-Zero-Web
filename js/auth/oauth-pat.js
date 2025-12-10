/**
 * GitHub Personal Access Token Authentication
 * Simple client-side authentication for static sites
 */

class OAuthPAT {
  constructor() {
    this.token = null;
    this.user = null;
  }

  /**
   * Authenticate with Personal Access Token
   * @param {string} token - GitHub Personal Access Token
   * @returns {Promise<Object>} User info and token
   */
  async authenticate(token) {
    if (!token || token.trim().length === 0) {
      throw new Error('Token is required');
    }

    const trimmedToken = token.trim();

    try {
      // Test token by fetching user info
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${trimmedToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Invalid token. Please check your token and try again.');
        } else if (response.status === 403) {
          throw new Error('Token does not have required permissions. Please ensure "gist" scope is enabled.');
        } else {
          throw new Error(`Authentication failed: ${response.statusText}`);
        }
      }

      const user = await response.json();

      // Verify token has gist scope by trying to list gists
      const gistResponse = await fetch('https://api.github.com/gists', {
        headers: {
          'Authorization': `token ${trimmedToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!gistResponse.ok) {
        throw new Error('Token does not have "gist" scope. Please create a new token with "gist" permission.');
      }

      // Store token and user info
      this.token = trimmedToken;
      this.user = user;

      return {
        access_token: trimmedToken,
        token_type: 'bearer',
        scope: 'gist',
        user: user
      };

    } catch (error) {
      // Clear stored token on error
      this.token = null;
      this.user = null;
      throw error;
    }
  }

  /**
   * Get current token
   * @returns {string|null} Current token
   */
  getToken() {
    return this.token;
  }

  /**
   * Get current user
   * @returns {Object|null} Current user info
   */
  getUser() {
    return this.user;
  }

  /**
   * Clear authentication
   */
  clear() {
    this.token = null;
    this.user = null;
  }

  /**
   * Check if authenticated
   * @returns {boolean} True if authenticated
   */
  isAuthenticated() {
    return this.token !== null;
  }
}

// Export singleton instance
const oauthPAT = new OAuthPAT();
export default oauthPAT;
