/**
 * Personal Access Token Authentication
 * Supports both GitHub and GitLab with auto-detection
 */

class OAuthPAT {
  constructor() {
    this.token = null;
    this.user = null;
    this.provider = null; // 'github' or 'gitlab'
  }

  /**
   * Detect provider from token format
   * GitHub: ghp_ prefix (classic) or github_pat_ (fine-grained)
   * GitLab: glpat- prefix
   * @param {string} token - PAT to analyze
   * @returns {string} 'github', 'gitlab', or 'unknown'
   */
  detectProvider(token) {
    const trimmed = token.trim();

    // GitHub tokens
    if (trimmed.startsWith('ghp_') || trimmed.startsWith('github_pat_')) {
      return 'github';
    }

    // GitLab tokens
    if (trimmed.startsWith('glpat-')) {
      return 'gitlab';
    }

    // Legacy detection: Try to infer from length and character set
    // GitHub classic PATs are 40 chars, hex
    // GitLab PATs are 20 chars, alphanumeric with dashes
    if (/^[a-f0-9]{40}$/i.test(trimmed)) {
      return 'github'; // Likely GitHub classic PAT
    }

    return 'unknown';
  }

  /**
   * Authenticate with Personal Access Token
   * Auto-detects GitHub or GitLab based on token format
   * @param {string} token - GitHub or GitLab Personal Access Token
   * @param {string} explicitProvider - Optional: force 'github' or 'gitlab'
   * @returns {Promise<Object>} User info and token
   */
  async authenticate(token, explicitProvider = null) {
    if (!token || token.trim().length === 0) {
      throw new Error('Token is required');
    }

    const trimmedToken = token.trim();

    // Detect provider if not explicitly provided
    const provider = explicitProvider || this.detectProvider(trimmedToken);

    if (provider === 'unknown') {
      throw new Error('Unable to detect token provider. Token should start with ghp_, github_pat_ (GitHub) or glpat- (GitLab)');
    }

    console.log(`Detected provider: ${provider}`);

    try {
      if (provider === 'github') {
        return await this.authenticateGitHub(trimmedToken);
      } else if (provider === 'gitlab') {
        return await this.authenticateGitLab(trimmedToken);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (error) {
      // Clear stored token on error
      this.token = null;
      this.user = null;
      this.provider = null;
      throw error;
    }
  }

  /**
   * Authenticate with GitHub PAT
   */
  async authenticateGitHub(token) {
    // Test token by fetching user info
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid GitHub token. Please check your token and try again.');
      } else if (response.status === 403) {
        throw new Error('GitHub token does not have required permissions. Please ensure "gist" scope is enabled.');
      } else {
        throw new Error(`GitHub authentication failed: ${response.statusText}`);
      }
    }

    const user = await response.json();

    // Verify token has gist scope by trying to list gists
    const gistResponse = await fetch('https://api.github.com/gists?per_page=100', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!gistResponse.ok) {
      throw new Error('GitHub token does not have "gist" scope. Please create a new token with "gist" permission.');
    }

    // Store token and user info
    this.token = token;
    this.user = user;
    this.provider = 'github';

    return {
      access_token: token,
      token_type: 'bearer',
      scope: 'gist',
      user: user,
      provider: 'github'
    };
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
    this.provider = 'gitlab';

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
   * @returns {string|null} 'github', 'gitlab', or null
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
    this.provider = null;
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
