/**
 * GitHub Gist Adapter
 * Handles CRUD operations for bookmark data stored in GitHub Gists
 */

import authManager from '../auth/auth-manager.js';

class GistAdapter {
  constructor() {
    this.apiBase = 'https://api.github.com';
    this.gistId = null;
    this.rateLimit = {
      remaining: null,
      limit: null,
      reset: null
    };
    this.userCache = null;
    this.userCacheExpiry = 0;
  }

  /**
   * Get authorization headers for GitHub API
   */
  async getHeaders() {
    const token = await authManager.getToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    return {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Bookmark-Manager-Zero/1.0 (https://github.com/AbsoluteXYZero/bookmark-manager-zero)'
    };
  }

  /**
   * Update rate limit info from response headers
   */
  updateRateLimitFromResponse(response) {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');
    const reset = response.headers.get('X-RateLimit-Reset');

    if (remaining !== null) this.rateLimit.remaining = parseInt(remaining, 10);
    if (limit !== null) this.rateLimit.limit = parseInt(limit, 10);
    if (reset !== null) this.rateLimit.reset = parseInt(reset, 10);

    // Log warning if rate limit is getting low
    if (this.rateLimit.remaining !== null && this.rateLimit.remaining < 100) {
      const resetDate = new Date(this.rateLimit.reset * 1000);
      console.warn(`[RateLimit] GitHub API rate limit low: ${this.rateLimit.remaining}/${this.rateLimit.limit} remaining (resets at ${resetDate.toLocaleTimeString()})`);
    }
  }

  /**
   * Check if we should proceed with API call based on rate limits
   */
  checkRateLimit() {
    if (this.rateLimit.remaining !== null && this.rateLimit.remaining < 10) {
      const resetDate = new Date(this.rateLimit.reset * 1000);
      const now = Date.now();
      const msUntilReset = (this.rateLimit.reset * 1000) - now;

      if (msUntilReset > 0) {
        throw new Error(`GitHub API rate limit nearly exhausted (${this.rateLimit.remaining} remaining). Resets at ${resetDate.toLocaleTimeString()}`);
      }
    }
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus() {
    return { ...this.rateLimit };
  }

  /**
   * Exponential backoff with jitter for retry logic
   * @param {Function} fn - The async function to retry
   * @param {number} maxRetries - Maximum number of retries (default: 3)
   * @param {number} baseDelay - Base delay in ms (default: 1000)
   * @returns {Promise} - Result of the function
   */
  async retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Don't retry on certain errors
        if (error.message.includes('404') ||
            error.message.includes('401') ||
            error.message.includes('403')) {
          throw error;
        }

        // If this was the last attempt, throw the error
        if (attempt === maxRetries) {
          throw error;
        }

        // Calculate delay with exponential backoff and jitter
        const exponentialDelay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * exponentialDelay * 0.3; // 30% jitter
        const delay = exponentialDelay + jitter;

        console.log(`[RetryBackoff] Attempt ${attempt + 1}/${maxRetries + 1} failed. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }


  /**
   * Get all user's gists
   */
  async getAllGists() {
    try {
      // Check rate limits before making API calls
      this.checkRateLimit();

      const headers = await this.getHeaders();

      // Use cached user info if available (expires after 5 minutes)
      const now = Date.now();
      if (!this.userCache || now > this.userCacheExpiry) {
        console.log('[GetAllGists] Fetching user info (cache expired or empty)...');
        const userResponse = await fetch(`${this.apiBase}/user`, { headers });
        this.updateRateLimitFromResponse(userResponse);

        if (userResponse.ok) {
          this.userCache = await userResponse.json();
          this.userCacheExpiry = now + (5 * 60 * 1000); // Cache for 5 minutes
          console.log('[GetAllGists] Authenticated as:', this.userCache.login, '(User ID:', this.userCache.id + ')');

          // Check token scopes from response headers
          const scopes = userResponse.headers.get('X-OAuth-Scopes');
          console.log('[GetAllGists] Token scopes:', scopes || 'Unable to retrieve scopes');
        } else {
          console.error('[GetAllGists] Failed to verify user:', userResponse.status);
        }
      } else {
        console.log('[GetAllGists] Using cached user info:', this.userCache.login);
      }

      // Fetch all gists (public and private) for the authenticated user
      // per_page=100 ensures we get up to 100 gists in one request
      console.log('[GetAllGists] Fetching from:', `${this.apiBase}/gists?per_page=100`);
      const response = await fetch(`${this.apiBase}/gists?per_page=100`, { headers });

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[GetAllGists] Response status:', response.status, response.statusText);

      // Check pagination headers
      const linkHeader = response.headers.get('Link');
      const totalCount = response.headers.get('X-Total-Count');
      if (linkHeader) {
        console.log('[GetAllGists] Pagination Link header:', linkHeader);
      }
      if (totalCount) {
        console.log('[GetAllGists] Total count:', totalCount);
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GetAllGists] Error response:', errorText);
        throw new Error(`Failed to fetch gists: ${response.status}`);
      }

      const gists = await response.json();
      console.log('[GetAllGists] Retrieved', gists.length, 'gists')

      // Log details about each gist
      if (gists.length > 0) {
        console.log('[GetAllGists] Gist details:');
        gists.forEach((g, idx) => {
          const fileNames = Object.keys(g.files).join(', ');
          const visibility = g.public ? 'public' : 'private';
          console.log(`  ${idx + 1}. ${g.id} - ${visibility} - Files: ${fileNames} - Desc: "${g.description || 'none'}"`);
        });
      } else {
        console.warn('[GetAllGists] No gists found. Possible reasons:');
        console.warn('  1. This GitHub account has no Gists');
        console.warn('  2. Token permissions issue (needs "gist" scope)');
      }

      return gists;
    } catch (error) {
      console.error('Failed to fetch gists:', error);
      throw error;
    }
  }

  /**
   * Find user's bookmark Gist
   * Looks for Gist with "bookmarks.json" file or "BMZ" in description
   */
  async findBookmarkGist() {
    try {
      const gists = await this.getAllGists();

      // Look for Gist with bookmarks.json file
      const bookmarkGist = gists.find(g =>
        g.files['bookmarks.json'] ||
        g.description?.includes('BMZ') ||
        g.description?.includes('Bookmark Manager Zero')
      );

      if (bookmarkGist) {
        // Validate that we can actually read from this gist
        try {
          await this.readBookmarks(bookmarkGist.id);
          this.gistId = bookmarkGist.id;
          console.log('Found and validated bookmark Gist:', this.gistId);
          return bookmarkGist.id;
        } catch (error) {
          console.warn('Found bookmark gist but cannot read from it:', bookmarkGist.id, error);
          return null;
        }
      }

      return null;
    } catch (error) {
      console.error('Failed to find bookmark Gist:', error);
      throw error;
    }
  }

  /**
   * Set gist ID to use
   */
  setGistId(gistId) {
    this.gistId = gistId;
    // Store in localStorage so we remember it
    localStorage.setItem('bmz_gist_id', gistId);
    console.log('Set bookmark Gist ID:', gistId);
  }

  /**
   * Load saved gist ID from storage
   */
  loadSavedGistId() {
    const savedId = localStorage.getItem('bmz_gist_id');
    if (savedId) {
      // Validate that it's a string and not an object
      if (typeof savedId === 'string' && !savedId.startsWith('{') && !savedId.startsWith('[')) {
        this.gistId = savedId;
        console.log('Loaded saved Gist ID:', savedId);
        return savedId;
      } else {
        console.warn('Invalid gist ID in localStorage:', savedId);
        localStorage.removeItem('bmz_gist_id');
      }
    }
    return null;
  }

  /**
   * Create a new Gist for bookmarks
   */
  async createBookmarkGist(bookmarkTree = null) {
    try {
      const headers = await this.getHeaders();

      // Default bookmark structure with standard root folders
      // Compatible with Firefox and Chrome bookmark exports
      const defaultTree = {
        version: 1,
        checksum: '',
        lastModified: Date.now(),
        roots: {
          bookmark_bar: {
            id: '1',
            title: 'Bookmarks Toolbar',
            name: 'Bookmarks Toolbar',
            type: 'folder',
            dateAdded: Date.now(),
            children: []
          },
          menu: {
            id: '2',
            title: 'Bookmarks Menu',
            name: 'Bookmarks Menu',
            type: 'folder',
            dateAdded: Date.now(),
            children: []
          },
          other: {
            id: '3',
            title: 'Other Bookmarks',
            name: 'Other Bookmarks',
            type: 'folder',
            dateAdded: Date.now(),
            children: []
          },
          mobile: {
            id: '4',
            title: 'Mobile Bookmarks',
            name: 'Mobile Bookmarks',
            type: 'folder',
            dateAdded: Date.now(),
            children: []
          }
        }
      };

      const tree = bookmarkTree || defaultTree;
      tree.checksum = await this.calculateChecksum(tree);

      // Check rate limits before creating
      this.checkRateLimit();

      console.log('[CreateGist] Sending request to GitHub API...');
      const response = await fetch(`${this.apiBase}/gists`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: 'BMZ Bookmarks - Managed by Bookmark Manager Zero',
          public: false,
          files: {
            'bookmarks.json': {
              content: JSON.stringify(tree)
            }
          }
        })
      });

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[CreateGist] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[CreateGist] Error response:', errorBody);
        throw new Error(`Failed to create Gist: ${response.status} - ${errorBody}`);
      }

      const gist = await response.json();
      console.log('[CreateGist] Gist created successfully:', {
        id: gist.id,
        url: gist.html_url,
        files: Object.keys(gist.files)
      });

      this.gistId = gist.id;
      // Save to localStorage
      this.setGistId(gist.id);

      console.log('Created bookmark Gist:', this.gistId);

      return gist.id;
    } catch (error) {
      console.error('Failed to create bookmark Gist:', error);
      throw error;
    }
  }

  /**
   * Read bookmark data from Gist
   */
  async readBookmarks(gistId = null) {
    const id = gistId || this.gistId;
    console.log('[ReadGist] Attempting to read Gist:', {
      providedId: gistId,
      storedId: this.gistId,
      usingId: id
    });

    if (!id) {
      throw new Error('No Gist ID provided');
    }

    try {
      // Check rate limits before reading
      this.checkRateLimit();

      const headers = await this.getHeaders();
      console.log('[ReadGist] Fetching from:', `${this.apiBase}/gists/${id}`);
      const response = await fetch(`${this.apiBase}/gists/${id}`, { headers });

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[ReadGist] Response status:', response.status, response.statusText);

      if (!response.ok) {
        if (response.status === 404) {
          const errorText = await response.text();
          console.error('[ReadGist] 404 Error - Gist not found. Response:', errorText);

          // Clear the invalid Gist ID immediately
          console.warn('[ReadGist] Clearing invalid Gist ID:', id);
          this.gistId = null;
          localStorage.removeItem('bmz_gist_id');

          throw new Error('Bookmark Gist not found');
        }
        const errorText = await response.text();
        console.error('[ReadGist] Error response:', errorText);
        throw new Error(`Failed to read Gist: ${response.status}`);
      }

      const gist = await response.json();
      console.log('[ReadGist] Gist fetched successfully:', {
        id: gist.id,
        files: Object.keys(gist.files),
        description: gist.description
      });

      if (!gist.files['bookmarks.json']) {
        throw new Error('Gist does not contain bookmarks.json');
      }

      const content = gist.files['bookmarks.json'].content;
      const bookmarkData = JSON.parse(content);

      console.log('[ReadGist] Bookmarks parsed successfully. Version:', bookmarkData.version);
      return bookmarkData;
    } catch (error) {
      console.error('Failed to read bookmarks from Gist:', error);
      throw error;
    }
  }

  /**
   * Update Gist with new bookmark data
   */
  async updateBookmarks(gistId = null, bookmarkTree, version = null) {
    const id = gistId || this.gistId;
    if (!id) {
      throw new Error('No Gist ID provided');
    }

    try {
      // Add version and metadata
      const dataWithMeta = {
        ...bookmarkTree,
        version: version !== null ? version : (bookmarkTree.version || 1) + 1,
        checksum: await this.calculateChecksum(bookmarkTree),
        lastModified: Date.now()
      };

      // Check rate limits before updating
      this.checkRateLimit();

      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/gists/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          files: {
            'bookmarks.json': {
              content: JSON.stringify(dataWithMeta)
            }
          }
        })
      });

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      if (!response.ok) {
        throw new Error(`Failed to update Gist: ${response.status}`);
      }

      const gist = await response.json();
      console.log('Updated bookmarks in Gist:', id);
      return gist;
    } catch (error) {
      console.error('Failed to update bookmarks in Gist:', error);
      throw error;
    }
  }

  /**
   * Calculate SHA-256 checksum for conflict detection
   */
  async calculateChecksum(data) {
    // Remove fields that change on every update
    const { checksum, lastModified, version, editLock, ...dataToHash } = data;

    const str = JSON.stringify(dataToHash, Object.keys(dataToHash).sort());
    const buffer = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buffer);

    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Delete a Gist (caution!)
   */
  async deleteGist(gistId = null) {
    const id = gistId || this.gistId;
    if (!id) {
      throw new Error('No Gist ID provided');
    }

    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/gists/${id}`, {
        method: 'DELETE',
        headers
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`Failed to delete Gist: ${response.status}`);
      }

      console.log('Deleted Gist:', id);
      if (this.gistId === id) {
        this.gistId = null;
      }
    } catch (error) {
      console.error('Failed to delete Gist:', error);
      throw error;
    }
  }

  /**
   * Get current Gist ID
   */
  getGistId() {
    return this.gistId;
  }

}

// Export singleton instance
const gistAdapter = new GistAdapter();
export default gistAdapter;

// Also export the class for testing
export { GistAdapter };
