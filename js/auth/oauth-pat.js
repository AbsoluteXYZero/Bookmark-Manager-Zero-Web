/**
 * Personal Access Token Authentication
 * GitLab PAT authentication
 */

import GitLabErrorHandler from '../utils/gitlab-error-handler.js';

class OAuthPAT {
  constructor() {
    this.token = null;
    this.user = null;
    this.provider = 'gitlab'; // Always GitLab
  }

  /**
   * Authenticate with Personal Access Token
   * @param {string} token - GitLab Personal Access Token
   * @param {Function} retryCallback - Callback to trigger retry with new token
   * @returns {Promise<Object|null>} User info and token, or null if authentication error popup was shown
   */
  async authenticate(token, retryCallback = null) {
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
      const result = await this.authenticateGitLab(trimmedToken, retryCallback);
      if (result === null) {
        // Authentication error popup was shown, allow retry without throwing
        return null;
      }
      return result;
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
  async authenticateGitLab(token, retryCallback = null) {
    // Test token by fetching user info
    const response = await fetch('https://gitlab.com/api/v4/user', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Show informational popup and allow retry
        GitLabErrorHandler.showAuthErrorPopup(retryCallback, false);
        // Return null to indicate authentication failed but allow retry
        return null;
      } else if (response.status === 403) {
        // Show permission error popup and allow retry
        GitLabErrorHandler.showAuthErrorPopup(retryCallback, true);
        // Return null to indicate permission failed but allow retry
        return null;
      } else if (response.status === 429) {
        // Show rate limit popup and allow retry
        GitLabErrorHandler.showRateLimitPopup(retryCallback);
        // Return null to indicate rate limited but allow retry
        return null;
      } else if (response.status >= 500 && response.status < 600) {
        // Show service error popup and allow retry
        GitLabErrorHandler.showServiceErrorPopup(retryCallback);
        // Return null to indicate service error but allow retry
        return null;
      } else {
        throw new Error('GitLab authentication failed: ' + response.statusText);
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
      if (snippetResponse.status === 401) {
        // Show informational popup for scope issue
        GitLabErrorHandler.showAuthErrorPopup(retryCallback, false);
        return null;
      } else if (snippetResponse.status === 403) {
        // Show permission error popup for scope issue
        GitLabErrorHandler.showAuthErrorPopup(retryCallback, true);
        return null;
      } else if (snippetResponse.status === 429) {
        // Show rate limit popup for scope check
        GitLabErrorHandler.showRateLimitPopup(retryCallback);
        return null;
      } else if (snippetResponse.status >= 500 && snippetResponse.status < 600) {
        // Show service error popup for scope check
        GitLabErrorHandler.showServiceErrorPopup(retryCallback);
        return null;
      } else {
        throw new Error('GitLab token does not have "api" scope. Please create a new token with "api" permission.');
      }
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
