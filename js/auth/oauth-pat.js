/**
 * Personal Access Token Authentication
 * GitLab PAT authentication
 */

class OAuthPAT {
  constructor() {
    this.token = null;
    this.user = null;
    this.provider = 'gitlab'; // Always GitLab
  }

  /**
   * Authenticate with Personal Access Token
   * @param {string} token - GitLab Personal Access Token
   * @returns {Promise<Object>} User info and token
   */
  async authenticate(token) {
    if (!token || token.trim().length === 0) {
      throw new Error('Token is required');
    }

    const trimmedToken = token.trim();

    // Validate token format (GitLab tokens start with glpat-)
    if (!trimmedToken.startsWith('glpat-')) {
      throw new Error('Invalid GitLab token format. Token should start with glpat-');
    }

    console.log('Authenticating with GitLab PAT');

    try {
      return await this.authenticateGitLab(trimmedToken);
    } catch (error) {
      // Clear stored token on error
      this.token = null;
      this.user = null;
      throw error;
    }
  }

  /**
   * Authenticate with GitLab PAT
   */
  async authenticateGitLab(token) {
    // Test token by fetching user info
    const response = await fetch('https://gitlab.com/api/v4/user', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid GitLab token. Please check your token and try again.');
      } else {
        throw new Error(`GitLab authentication failed: ${response.statusText}`);
      }
    }

    const user = await response.json();

    // Verify token has api scope by trying to list snippets
    const snippetResponse = await fetch('https://gitlab.com/api/v4/snippets', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!snippetResponse.ok) {
      throw new Error('GitLab token does not have "api" scope. Please create a new token with "api" permission.');
    }

    // Store token and user info
    this.token = token;
    this.user = user;

    return {
      access_token: token,
      token_type: 'bearer',
      scope: 'api',
      user: user,
      provider: 'gitlab'
    };
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
   * Get current provider
   * @returns {string} Always 'gitlab'
   */
  getProvider() {
    return this.provider;
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
