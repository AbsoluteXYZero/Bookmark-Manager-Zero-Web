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
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Find user's bookmark Gist
   * Looks for Gist with "bookmarks.json" file or "BMZ" in description
   */
  async findBookmarkGist() {
    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/gists`, { headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch gists: ${response.status}`);
      }

      const gists = await response.json();

      // Look for Gist with bookmarks.json file
      const bookmarkGist = gists.find(g =>
        g.files['bookmarks.json'] ||
        g.description?.includes('BMZ') ||
        g.description?.includes('Bookmark Manager Zero')
      );

      if (bookmarkGist) {
        this.gistId = bookmarkGist.id;
        console.log('Found bookmark Gist:', this.gistId);
      }

      return bookmarkGist;
    } catch (error) {
      console.error('Failed to find bookmark Gist:', error);
      throw error;
    }
  }

  /**
   * Create a new Gist for bookmarks
   */
  async createBookmarkGist(bookmarkTree = null) {
    try {
      const headers = await this.getHeaders();

      // Default empty bookmark structure
      const defaultTree = {
        version: 1,
        checksum: '',
        lastModified: Date.now(),
        roots: {
          bookmark_bar: {
            id: '1',
            name: 'Bookmarks Bar',
            type: 'folder',
            children: []
          },
          other: {
            id: '2',
            name: 'Other Bookmarks',
            type: 'folder',
            children: []
          },
          mobile: {
            id: '3',
            name: 'Mobile Bookmarks',
            type: 'folder',
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
      return gist;
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

  /**
   * Set Gist ID manually
   */
  setGistId(gistId) {
    this.gistId = gistId;
  }
}

// Export singleton instance
const gistAdapter = new GistAdapter();
export default gistAdapter;

// Also export the class for testing
export { GistAdapter };
