/**
 * GitHub Gist Adapter
 * Handles CRUD operations for bookmark data stored in GitHub Gists
 */

import authManager from '../auth/auth-manager.js';

class GistAdapter {
  constructor() {
    // Check if we should use a proxy (for networks that block GitHub)
    const useProxy = localStorage.getItem('bmz_use_proxy') === 'true';
    // Default to Cloudflare Worker proxy on absolutezero.fyi domain
    const proxyUrl = localStorage.getItem('bmz_proxy_url') || 'https://github-api.absolutezero.fyi';

    if (useProxy) {
      // For Cloudflare Worker proxy, we just use the proxy URL directly
      // The worker handles the path forwarding to api.github.com
      this.apiBase = proxyUrl;
      console.log('[GistAdapter] Using Cloudflare Worker proxy:', proxyUrl);
    } else {
      this.apiBase = 'https://api.github.com';
    }

    this.useProxy = useProxy;
    this.proxyUrl = proxyUrl;
    this.gistId = null;
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
      'Content-Type': 'application/json'
    };
  }

  /**
   * Make a fetch request with automatic proxy fallback
   * If direct connection fails, automatically retry with Cloudflare Worker proxy
   */
  async fetchWithFallback(url, options = {}) {
    try {
      // Try direct connection first
      console.log('[GistAdapter] Attempting direct connection...');
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('[GistAdapter] Direct connection successful');
      return response;
    } catch (error) {
      console.warn('[GistAdapter] Direct connection failed:', error.message);

      // If direct connection failed and we're not already using proxy, try with proxy
      if (!this.useProxy) {
        console.log('[GistAdapter] Retrying with Cloudflare Worker proxy...');

        // Temporarily enable proxy
        const originalApiBase = this.apiBase;
        this.apiBase = this.proxyUrl;

        // Replace URL with proxied version
        // For Cloudflare Worker: https://api.github.com/gists -> https://github-api.absolutezero.fyi/gists
        const proxiedUrl = url.replace('https://api.github.com', this.apiBase);

        try {
          const proxyResponse = await fetch(proxiedUrl, options);

          if (!proxyResponse.ok) {
            throw new Error(`HTTP ${proxyResponse.status}`);
          }

          console.log('[GistAdapter] Cloudflare Worker proxy connection successful - permanently enabling proxy');
          // If proxy works, keep it enabled
          this.useProxy = true;
          localStorage.setItem('bmz_use_proxy', 'true');

          return proxyResponse;
        } catch (proxyError) {
          // Restore original apiBase
          this.apiBase = originalApiBase;
          console.error('[GistAdapter] Both direct and proxy connections failed');
          throw new Error(`Connection failed: ${error.message}. Proxy also failed: ${proxyError.message}`);
        }
      }

      // If we were already using proxy and it failed, just throw
      throw error;
    }
  }

  /**
   * Get all user's gists
   */
  async getAllGists() {
    try {
      const headers = await this.getHeaders();
      const response = await this.fetchWithFallback(`${this.apiBase}/gists`, { headers });

      return await response.json();
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

      const response = await this.fetchWithFallback(`${this.apiBase}/gists`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: 'BMZ Bookmarks - Managed by Bookmark Manager Zero',
          public: false,
          files: {
            'bookmarks.json': {
              content: JSON.stringify(tree, null, 2)
            }
          }
        })
      });

      const gist = await response.json();
      this.gistId = gist.id;

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
    if (!id) {
      throw new Error('No Gist ID provided');
    }

    try {
      const headers = await this.getHeaders();
      const response = await this.fetchWithFallback(`${this.apiBase}/gists/${id}`, { headers });

      const gist = await response.json();

      if (!gist.files['bookmarks.json']) {
        throw new Error('Gist does not contain bookmarks.json');
      }

      const content = gist.files['bookmarks.json'].content;
      const bookmarkData = JSON.parse(content);

      console.log('Read bookmarks from Gist:', id);
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

      const headers = await this.getHeaders();
      const response = await this.fetchWithFallback(`${this.apiBase}/gists/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          files: {
            'bookmarks.json': {
              content: JSON.stringify(dataWithMeta, null, 2)
            }
          }
        })
      });

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
      const response = await this.fetchWithFallback(`${this.apiBase}/gists/${id}`, {
        method: 'DELETE',
        headers
      });

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
   * Get all user's Gists (for debugging)
   */
  async getAllGists() {
    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/gists`, { headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch gists: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to fetch all gists:', error);
      throw error;
    }
  }

  /**
   * Get current Gist ID
   */
  getGistId() {
    return this.gistId;
  }

  /**
   * Enable proxy for GitHub API requests
   * @param {string} proxyUrl - Proxy URL (defaults to Cloudflare Worker on absolutezero.fyi)
   */
  enableProxy(proxyUrl = 'https://github-api.absolutezero.fyi') {
    this.useProxy = true;
    this.proxyUrl = proxyUrl;
    this.apiBase = proxyUrl;

    localStorage.setItem('bmz_use_proxy', 'true');
    localStorage.setItem('bmz_proxy_url', proxyUrl);

    console.log('[GistAdapter] Cloudflare Worker proxy enabled:', proxyUrl);
  }

  /**
   * Disable proxy and use direct GitHub API access
   */
  disableProxy() {
    this.useProxy = false;
    this.apiBase = 'https://api.github.com';

    localStorage.setItem('bmz_use_proxy', 'false');

    console.log('[GistAdapter] Proxy disabled');
  }

  /**
   * Check if proxy is currently enabled
   * @returns {boolean}
   */
  isProxyEnabled() {
    return this.useProxy;
  }

  /**
   * Get current proxy URL
   * @returns {string|null}
   */
  getProxyUrl() {
    return this.useProxy ? this.proxyUrl : null;
  }

}

// Export singleton instance
const gistAdapter = new GistAdapter();
export default gistAdapter;

// Also export the class for testing
export { GistAdapter };
