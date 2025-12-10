/**
 * GitHub Gist Adapter
 * Handles CRUD operations for bookmark data stored in GitHub Gists
 */

import authManager from '../auth/auth-manager.js';

class GistAdapter {
  constructor() {
    this.apiBase = 'https://api.github.com';
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
   * Get all user's gists
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

      const response = await fetch(`${this.apiBase}/gists`, {
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

      if (!response.ok) {
        throw new Error(`Failed to create Gist: ${response.status}`);
      }

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
      const response = await fetch(`${this.apiBase}/gists/${id}`, { headers });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Bookmark Gist not found');
        }
        throw new Error(`Failed to read Gist: ${response.status}`);
      }

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
      const response = await fetch(`${this.apiBase}/gists/${id}`, {
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

}

// Export singleton instance
const gistAdapter = new GistAdapter();
export default gistAdapter;

// Also export the class for testing
export { GistAdapter };
