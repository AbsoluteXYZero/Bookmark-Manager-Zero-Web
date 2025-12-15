/**
 * GitLab Snippet Adapter
 * Handles CRUD operations for bookmark data stored in GitLab Snippets
 */

import authManager from '../auth/auth-manager.js';

class SnippetAdapter {
  constructor() {
    this.apiBase = 'https://gitlab.com/api/v4';
    this.snippetId = null;
  }

  /**
   * Get authorization headers for GitLab API
   */
  async getHeaders() {
    const token = await authManager.getToken('gitlab');
    if (!token) {
      throw new Error('No GitLab authentication token available');
    }

    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Get all user's snippets
   */
  async getAllSnippets() {
    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/snippets`, { headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch snippets: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to fetch snippets:', error);
      throw error;
    }
  }

  /**
   * Find user's bookmark Snippet
   * Looks for Snippet with "bookmarks.json" file or "BMZ" in title
   */
  async findBookmarkSnippet() {
    try {
      const snippets = await this.getAllSnippets();

      // Look for Snippet with BMZ in title or bookmarks.json file
      const bookmarkSnippet = snippets.find(s =>
        s.title?.includes('BMZ') ||
        s.title?.includes('Bookmark Manager Zero') ||
        s.file_name === 'bookmarks.json'
      );

      if (bookmarkSnippet) {
        // Validate that we can actually read from this snippet
        try {
          await this.readBookmarks(bookmarkSnippet.id);
          this.snippetId = bookmarkSnippet.id;
          console.log('Found and validated bookmark Snippet:', this.snippetId);
          return bookmarkSnippet.id;
        } catch (error) {
          console.warn('Found bookmark snippet but cannot read from it:', bookmarkSnippet.id, error);
          return null;
        }
      }

      return null;
    } catch (error) {
      console.error('Failed to find bookmark Snippet:', error);
      throw error;
    }
  }

  /**
   * Set snippet ID to use
   */
  setSnippetId(snippetId) {
    this.snippetId = snippetId;
    // Store in localStorage so we remember it
    localStorage.setItem('bmz_snippet_id', snippetId);
    console.log('Set bookmark Snippet ID:', snippetId);
  }

  /**
   * Load saved snippet ID from storage
   */
  loadSavedSnippetId() {
    const savedId = localStorage.getItem('bmz_snippet_id');
    if (savedId) {
      // Validate that it's a string and not an object
      if (typeof savedId === 'string' && !savedId.startsWith('{') && !savedId.startsWith('[')) {
        this.snippetId = savedId;
        console.log('Loaded saved Snippet ID:', savedId);
        return savedId;
      } else {
        console.warn('Invalid snippet ID in localStorage:', savedId);
        localStorage.removeItem('bmz_snippet_id');
      }
    }
    return null;
  }

  /**
   * Create a new Snippet for bookmarks
   */
  async createBookmarkSnippet(bookmarkTree = null) {
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

      const response = await fetch(`${this.apiBase}/snippets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'BMZ Bookmarks - Managed by Bookmark Manager Zero',
          visibility: 'private',
          files: [
            {
              file_path: 'bookmarks.json',
              content: JSON.stringify(tree, null, 2)
            }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create Snippet: ${response.status} - ${errorText}`);
      }

      const snippet = await response.json();
      this.snippetId = snippet.id;

      console.log('Created bookmark Snippet:', this.snippetId);
      return snippet.id;
    } catch (error) {
      console.error('Failed to create bookmark Snippet:', error);
      throw error;
    }
  }

  /**
   * Read bookmark data from Snippet
   */
  async readBookmarks(snippetId = null) {
    const id = snippetId || this.snippetId;
    if (!id) {
      throw new Error('No Snippet ID provided');
    }

    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/snippets/${id}`, { headers });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Bookmark Snippet not found');
        }
        throw new Error(`Failed to read Snippet: ${response.status}`);
      }

      const snippet = await response.json();

      // GitLab snippets have a 'files' array
      const bookmarkFile = snippet.files?.find(f => f.path === 'bookmarks.json');
      if (!bookmarkFile) {
        throw new Error('Snippet does not contain bookmarks.json');
      }

      // Fetch the raw content of the file
      const rawResponse = await fetch(bookmarkFile.raw_url, { headers });
      if (!rawResponse.ok) {
        throw new Error(`Failed to fetch snippet content: ${rawResponse.status}`);
      }

      const content = await rawResponse.text();
      const bookmarkData = JSON.parse(content);

      console.log('Read bookmarks from Snippet:', id);
      return bookmarkData;
    } catch (error) {
      console.error('Failed to read bookmarks from Snippet:', error);
      throw error;
    }
  }

  /**
   * Update Snippet with new bookmark data
   */
  async updateBookmarks(snippetId = null, bookmarkTree, version = null) {
    const id = snippetId || this.snippetId;
    if (!id) {
      throw new Error('No Snippet ID provided');
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
      const response = await fetch(`${this.apiBase}/snippets/${id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          files: [
            {
              action: 'update',
              file_path: 'bookmarks.json',
              content: JSON.stringify(dataWithMeta, null, 2)
            }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update Snippet: ${response.status} - ${errorText}`);
      }

      const snippet = await response.json();
      console.log('Updated bookmarks in Snippet:', id);
      return snippet;
    } catch (error) {
      console.error('Failed to update bookmarks in Snippet:', error);
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
   * Delete a Snippet (caution!)
   */
  async deleteSnippet(snippetId = null) {
    const id = snippetId || this.snippetId;
    if (!id) {
      throw new Error('No Snippet ID provided');
    }

    try {
      const headers = await this.getHeaders();
      const response = await fetch(`${this.apiBase}/snippets/${id}`, {
        method: 'DELETE',
        headers
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`Failed to delete Snippet: ${response.status}`);
      }

      console.log('Deleted Snippet:', id);
      if (this.snippetId === id) {
        this.snippetId = null;
      }
    } catch (error) {
      console.error('Failed to delete Snippet:', error);
      throw error;
    }
  }

  /**
   * Get current Snippet ID
   */
  getSnippetId() {
    return this.snippetId;
  }
}

// Export singleton instance
const snippetAdapter = new SnippetAdapter();
export default snippetAdapter;

// Also export the class for testing
export { SnippetAdapter };
