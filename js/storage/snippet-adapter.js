/**
 * GitLab Snippet Adapter
 * Handles CRUD operations for bookmark data stored in GitLab Snippets
 */

import authManager from '../auth/auth-manager.js';
import GitLabErrorHandler from '../utils/gitlab-error-handler.js';
import { safeLocalStorage } from '../utils/storage-utils.js';

class SnippetAdapter {
  constructor() {
    this.apiBase = 'https://gitlab.com/api/v4';
    this.snippetId = null;
    this.rateLimit = {
      remaining: null,
      limit: null,
      reset: null
    };
    this.userCache = null;
    this.userCacheExpiry = 0;
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
      'Content-Type': 'application/json',
      'User-Agent': 'Bookmark-Manager-Zero/1.0 (https://github.com/AbsoluteXYZero/bookmark-manager-zero)'
    };
  }

  /* [ZeroLabs] 2026-08-19 6:01 PM - added: request timeout so a stalled network cannot hang forever */
  /**
   * fetch with a hard timeout.
   *
   * Every request here previously had none, so a stalled mobile connection left
   * the promise pending forever: no error, no catch, no completion. That is what
   * left the Android share window sitting on "Syncing to GitLab..." after the
   * bookmark had already been written locally.
   *
   * Aborting is safe to retry: the snippet write is a whole-file PUT, so
   * repeating it produces the same result whether or not the first attempt
   * reached GitLab.
   */
  async fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`GitLab did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Update rate limit info from response headers (GitLab uses RateLimit-* headers)
   */
  updateRateLimitFromResponse(response) {
    const remaining = response.headers.get('RateLimit-Remaining');
    const limit = response.headers.get('RateLimit-Limit');
    const reset = response.headers.get('RateLimit-Reset');

    if (remaining !== null) this.rateLimit.remaining = parseInt(remaining, 10);
    if (limit !== null) this.rateLimit.limit = parseInt(limit, 10);
    if (reset !== null) this.rateLimit.reset = parseInt(reset, 10);

    // Log warning if rate limit is getting low
    if (this.rateLimit.remaining !== null && this.rateLimit.remaining < 100) {
      const resetDate = new Date(this.rateLimit.reset * 1000);
      console.warn(`[RateLimit] GitLab API rate limit low: ${this.rateLimit.remaining}/${this.rateLimit.limit} remaining (resets at ${resetDate.toLocaleTimeString()})`);
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
        throw new Error(`GitLab API rate limit nearly exhausted (${this.rateLimit.remaining} remaining). Resets at ${resetDate.toLocaleTimeString()}`);
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
   * Get all user's snippets
   */
  async getAllSnippets() {
    try {
      // Check rate limits before making API calls
      this.checkRateLimit();

      const headers = await this.getHeaders();

      // Use cached user info if available (expires after 5 minutes)
      const now = Date.now();
      if (!this.userCache || now > this.userCacheExpiry) {
        console.log('[GetAllSnippets] Fetching user info (cache expired or empty)...');
        const userResponse = await this.fetchWithTimeout(`${this.apiBase}/user`, { headers });
        this.updateRateLimitFromResponse(userResponse);

        if (userResponse.ok) {
          this.userCache = await userResponse.json();
          this.userCacheExpiry = now + (5 * 60 * 1000); // Cache for 5 minutes
          console.log('[GetAllSnippets] Authenticated as:', this.userCache.username, '(User ID:', this.userCache.id + ')');
        } else {
          console.error('[GetAllSnippets] Failed to verify user:', userResponse.status);
        }
      } else {
        console.log('[GetAllSnippets] Using cached user info:', this.userCache.username);
      }

      // Fetch all snippets for the authenticated user
      // per_page=100 ensures we get up to 100 snippets in one request
      console.log('[GetAllSnippets] Fetching from:', `${this.apiBase}/snippets?per_page=100`);
      const response = await this.fetchWithTimeout(`${this.apiBase}/snippets?per_page=100`, { headers });

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[GetAllSnippets] Response status:', response.status, response.statusText);

      // Check pagination headers
      const linkHeader = response.headers.get('Link');
      const totalCount = response.headers.get('X-Total-Count');
      if (linkHeader) {
        console.log('[GetAllSnippets] Pagination Link header:', linkHeader);
      }
      if (totalCount) {
        console.log('[GetAllSnippets] Total count:', totalCount);
      }

      if (!response.ok) {
        if (response.status === 401) {
          // Show authentication error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showAuthErrorPopup(() => {
              // Retry the entire operation
              this.getAllSnippets().then(resolve).catch(reject);
            }, false);
          });
        } else if (response.status === 403) {
          // Show permission error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showAuthErrorPopup(() => {
              // Retry the entire operation
              this.getAllSnippets().then(resolve).catch(reject);
            }, true);
          });
        } else if (response.status === 429) {
          // Show rate limit popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showRateLimitPopup(() => {
              // Retry the entire operation
              this.getAllSnippets().then(resolve).catch(reject);
            });
          });
        } else if (response.status >= 500 && response.status < 600) {
          // Show service error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showServiceErrorPopup(() => {
              // Retry the entire operation
              this.getAllSnippets().then(resolve).catch(reject);
            });
          });
        }
        const errorText = await response.text();
        console.error('[GetAllSnippets] Error response:', errorText);
        throw new Error(`Failed to fetch snippets: ${response.status}`);
      }

      const snippets = await response.json();
      console.log('[GetAllSnippets] Retrieved', snippets.length, 'snippets')

      // Log details about each snippet
      if (snippets.length > 0) {
        console.log('[GetAllSnippets] Snippet details:');
        snippets.forEach((s, idx) => {
          const fileName = s.file_name || 'unknown';
          const visibility = s.visibility || 'unknown';
          console.log(`  ${idx + 1}. ${s.id} - ${visibility} - File: ${fileName} - Title: "${s.title || 'none'}"`);
        });
      } else {
        console.warn('[GetAllSnippets] No snippets found. Possible reasons:');
        console.warn('  1. This GitLab account has no Snippets');
        console.warn('  2. Token permissions issue (needs "api" scope)');
      }

      return snippets;
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
    safeLocalStorage.setItem('bmz_snippet_id', snippetId);
    console.log('Set bookmark Snippet ID:', snippetId);
  }

  /**
   * Load saved snippet ID from storage
   */
  loadSavedSnippetId() {
    const savedId = safeLocalStorage.getItem('bmz_snippet_id');
    if (savedId) {
      // Validate that it's a string and not an object
      if (typeof savedId === 'string' && !savedId.startsWith('{') && !savedId.startsWith('[')) {
        this.snippetId = savedId;
        console.log('Loaded saved Snippet ID:', savedId);
        return savedId;
      } else {
        console.warn('Invalid snippet ID in localStorage:', savedId);
        safeLocalStorage.removeItem('bmz_snippet_id');
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

      // Check rate limits before creating
      this.checkRateLimit();

      console.log('[CreateSnippet] Sending request to GitLab API...');
      const response = await this.fetchWithTimeout(`${this.apiBase}/snippets`, {
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

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[CreateSnippet] Response status:', response.status, response.statusText);

      if (!response.ok) {
        if (response.status === 401) {
          // Show authentication error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showAuthErrorPopup(() => {
              // Retry the entire operation
              this.createBookmarkSnippet(bookmarkTree).then(resolve).catch(reject);
            }, false);
          });
        } else if (response.status === 403) {
          // Show permission error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showAuthErrorPopup(() => {
              // Retry the entire operation
              this.createBookmarkSnippet(bookmarkTree).then(resolve).catch(reject);
            }, true);
          });
        } else if (response.status === 429) {
          // Show rate limit popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showRateLimitPopup(() => {
              // Retry the entire operation
              this.createBookmarkSnippet(bookmarkTree).then(resolve).catch(reject);
            });
          });
        } else if (response.status >= 500 && response.status < 600) {
          // Show service error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showServiceErrorPopup(() => {
              // Retry the entire operation
              this.createBookmarkSnippet(bookmarkTree).then(resolve).catch(reject);
            });
          });
        }
        const errorBody = await response.text();
        console.error('[CreateSnippet] Error response:', errorBody);
        throw new Error(`Failed to create Snippet: ${response.status} - ${errorBody}`);
      }

      const snippet = await response.json();
      console.log('[CreateSnippet] Snippet created successfully:', {
        id: snippet.id,
        url: snippet.web_url,
        title: snippet.title
      });

      this.snippetId = snippet.id;
      // Save to localStorage
      this.setSnippetId(snippet.id);

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
    console.log('[ReadSnippet] Attempting to read Snippet:', {
      providedId: snippetId,
      storedId: this.snippetId,
      usingId: id
    });

    if (!id) {
      throw new Error('No Snippet ID provided');
    }

    try {
      // Check rate limits before reading
      this.checkRateLimit();

      const headers = await this.getHeaders();
      console.log('[ReadSnippet] Fetching from:', `${this.apiBase}/snippets/${id}`);
      const response = await this.fetchWithTimeout(`${this.apiBase}/snippets/${id}`, { headers });

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[ReadSnippet] Response status:', response.status, response.statusText);

      if (!response.ok) {
        if (response.status === 404) {
          const errorText = await response.text();
          console.error('[ReadSnippet] 404 Error - Snippet not found. Response:', errorText);

          // Clear the invalid Snippet ID immediately
          console.warn('[ReadSnippet] Clearing invalid Snippet ID:', id);
          this.snippetId = null;
          safeLocalStorage.removeItem('bmz_snippet_id');

          throw new Error('Bookmark Snippet not found');
        } else if (response.status >= 500 && response.status < 600) {
          // Show service error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showServiceErrorPopup(() => {
              // Retry the entire operation
              this.readBookmarks(snippetId).then(resolve).catch(reject);
            });
          });
        }
        const errorText = await response.text();
        console.error('[ReadSnippet] Error response:', errorText);
        throw new Error(`Failed to read Snippet: ${response.status}`);
      }

      const snippet = await response.json();
      console.log('[ReadSnippet] Snippet fetched successfully:', {
        id: snippet.id,
        title: snippet.title,
        filesCount: snippet.files?.length || 0
      });

      // GitLab snippets have a 'files' array
      const bookmarkFile = snippet.files?.find(f => f.path === 'bookmarks.json' || f.file_name === 'bookmarks.json');
      if (!bookmarkFile) {
        throw new Error('Snippet does not contain bookmarks.json');
      }

      console.log('[ReadSnippet] Found bookmarks.json file:', {
        path: bookmarkFile.path,
        file_name: bookmarkFile.file_name
      });

      // GitLab API v4 doesn't include content directly, need to fetch it via API
      let content = bookmarkFile.content;

      // If content is not in the response, fetch it using the API with authentication
      if (!content) {
        console.log('[ReadSnippet] Content not in response, fetching via API...');
        // Use the authenticated API endpoint instead of raw_url to avoid CORS
        const fileResponse = await this.fetchWithTimeout(`${this.apiBase}/snippets/${id}/files/main/bookmarks.json/raw`, { headers });
        if (!fileResponse.ok) {
          if (fileResponse.status === 429) {
            // Show rate limit popup and allow retry
            return new Promise((resolve, reject) => {
              GitLabErrorHandler.showRateLimitPopup(() => {
                // Retry the entire operation
                this.readBookmarks(snippetId).then(resolve).catch(reject);
              });
            });
          } else if (fileResponse.status >= 500 && fileResponse.status < 600) {
            // Show service error popup and allow retry
            return new Promise((resolve, reject) => {
              GitLabErrorHandler.showServiceErrorPopup(() => {
                // Retry the entire operation
                this.readBookmarks(snippetId).then(resolve).catch(reject);
              });
            });
          }
          console.warn('[ReadSnippet] API raw endpoint failed with status:', fileResponse.status);
          throw new Error(`Failed to fetch file content: ${fileResponse.status}`);
        }
        content = await fileResponse.text();
        console.log('[ReadSnippet] Fetched content length:', content?.length);
      }

      // If content is empty or just whitespace, return empty bookmark structure
      if (!content || content.trim() === '') {
        console.log('[ReadSnippet] Snippet file is empty, returning empty bookmark structure');
        return this.getEmptyBookmarkTree();
      }

      const bookmarkData = JSON.parse(content);

      console.log('[ReadSnippet] Bookmarks parsed successfully. Version:', bookmarkData.version);
      return bookmarkData;
    } catch (error) {
      console.error('Failed to read bookmarks from Snippet:', error);
      throw error;
    }
  }

  /**
   * Update Snippet with new bookmark data
   */
  /* [ZeroLabs] 2026-08-18 12:32 AM - added: read quick access meta file (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
  // Returns { pins, tombstones, exists } or null on a network/auth failure, so
  // callers can tell "no pins yet" apart from "could not check".
  async readQuickAccessMeta(snippetId = null) {
    const id = snippetId || this.snippetId;
    if (!id) return null;

    try {
      const headers = await this.getHeaders();
      const response = await this.fetchWithTimeout(`${this.apiBase}/snippets/${id}`, { headers });
      if (!response.ok) return null;

      const snippet = await response.json();
      const metaFile = snippet.files?.find(f =>
        f.path === 'bmz-meta.json' || f.file_name === 'bmz-meta.json'
      );

      // A snippet with no meta file means no pins yet, which is the normal state
      // of every snippet that existed before this feature. Not an error.
      if (!metaFile) return { pins: [], tombstones: [], exists: false };

      let content = metaFile.content;
      if (!content) {
        const fileResponse = await this.fetchWithTimeout(`${this.apiBase}/snippets/${id}/files/main/bmz-meta.json/raw`, { headers });
        if (!fileResponse.ok) return { pins: [], tombstones: [], exists: true };
        content = await fileResponse.text();
      }

      if (!content || content.trim() === '') return { pins: [], tombstones: [], exists: true };

      const parsed = JSON.parse(content);
      return {
        pins: Array.isArray(parsed.quickAccess) ? parsed.quickAccess : [],
        tombstones: Array.isArray(parsed.quickAccessRemoved) ? parsed.quickAccessRemoved : [],
        exists: true
      };
    } catch (error) {
      console.error('[ReadSnippet] Failed to read quick access meta:', error);
      return null;
    }
  }

  async updateBookmarks(snippetId = null, bookmarkTree, version = null) {
    const id = snippetId || this.snippetId;
    console.log('[UpdateSnippet] Attempting to update Snippet:', {
      providedId: snippetId,
      storedId: this.snippetId,
      usingId: id
    });

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

      console.log('[UpdateSnippet] Updating with version:', dataWithMeta.version);

      // Check rate limits before updating
      this.checkRateLimit();

      /* [ZeroLabs] 2026-08-18 12:32 AM - added: push quick access meta alongside (see also: Bookmark-Manager-Zero-Chrome/sidepanel.js) */
      // Pins live in their own file so a client that has never heard of Quick
      // Access cannot blank them: GitLab only rewrites the files named in the
      // request, and older builds name only bookmarks.json.
      const files = [
        {
          action: 'update',
          file_path: 'bookmarks.json',
          content: JSON.stringify(dataWithMeta, null, 2)
        }
      ];

      // Only ever write pins for a snippet whose meta has already been read,
      // otherwise a snippet switch followed by a fast sync would overwrite the
      // new snippet's pins with the previous snippet's cache.
      const metaPayload = (typeof window !== 'undefined' && window.bmzQuickAccessMeta)
        ? window.bmzQuickAccessMeta.buildPayloadFor(id)
        : null;
      if (metaPayload) {
        files.push({
          action: metaPayload.exists ? 'update' : 'create',
          file_path: 'bmz-meta.json',
          content: metaPayload.content
        });
      }

      const headers = await this.getHeaders();
      const response = await this.fetchWithTimeout(`${this.apiBase}/snippets/${id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ files })
      });

      // A successful write means the file is there now, so later pushes update
      // rather than create.
      if (metaPayload && response.ok && typeof window !== 'undefined' && window.bmzQuickAccessMeta) {
        window.bmzQuickAccessMeta.markWritten();
      }

      // Update rate limit tracking
      this.updateRateLimitFromResponse(response);

      console.log('[UpdateSnippet] Response status:', response.status, response.statusText);

      if (!response.ok) {
        if (response.status === 401) {
          // Show authentication error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showAuthErrorPopup(() => {
              // Retry the entire operation
              this.updateBookmarks(snippetId, bookmarkTree, version).then(resolve).catch(reject);
            }, false);
          });
        } else if (response.status === 403) {
          // Show permission error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showAuthErrorPopup(() => {
              // Retry the entire operation
              this.updateBookmarks(snippetId, bookmarkTree, version).then(resolve).catch(reject);
            }, true);
          });
        } else if (response.status === 429) {
          // Show rate limit popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showRateLimitPopup(() => {
              // Retry the entire operation
              this.updateBookmarks(snippetId, bookmarkTree, version).then(resolve).catch(reject);
            });
          });
        } else if (response.status >= 500 && response.status < 600) {
          // Show service error popup and allow retry
          return new Promise((resolve, reject) => {
            GitLabErrorHandler.showServiceErrorPopup(() => {
              // Retry the entire operation
              this.updateBookmarks(snippetId, bookmarkTree, version).then(resolve).catch(reject);
            });
          });
        }
        const errorText = await response.text();
        console.error('[UpdateSnippet] Error response:', errorText);
        throw new Error(`Failed to update Snippet: ${response.status} - ${errorText}`);
      }

      const snippet = await response.json();
      console.log('[UpdateSnippet] Updated bookmarks in Snippet:', id, '- New version:', dataWithMeta.version);
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
      const response = await this.fetchWithTimeout(`${this.apiBase}/snippets/${id}`, {
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

  /**
   * Get empty bookmark tree structure
   */
  getEmptyBookmarkTree() {
    return {
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
  }
}

// Export singleton instance
const snippetAdapter = new SnippetAdapter();
export default snippetAdapter;

// Also export the class for testing
export { SnippetAdapter };
