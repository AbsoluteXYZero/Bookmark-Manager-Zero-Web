/**
 * UI Rendering Module
 * Handles rendering bookmark cards, folders, and UI interactions
 * Ported from sidebar.js with browser API replacements
 */

import bookmarkManager from './bookmarks.js';
import scannerService from './scanner.js';

class UIManager {
  constructor() {
    this.displayOptions = {
      preview: true,
      favicon: true,
      title: true,
      url: true,
      liveStatus: true,
      safetyStatus: true
    };

    this.expandedFolders = new Set();
    this.selectedItems = new Set();
    this.multiSelectMode = false;
    this.openMenuBookmarkId = null;
    this.hasSeenSetupCard = false;
  }

  /**
   * Initialize UI manager
   * Set up event listeners and load preferences
   */
  async init() {
    // Load preferences from storage
    // TODO: Load display options and expanded folders from settings
    console.log('UI manager initialized');
  }

  /**
   * Render entire bookmark tree
   */
  renderBookmarks(bookmarkTree) {
    const bookmarkList = document.getElementById('bookmarkList');
    if (!bookmarkList) {
      console.error('Bookmark list container not found');
      return;
    }

    // Filter and search bookmarks
    const filtered = this.filterAndSearchBookmarks(bookmarkTree);

    if (filtered.length === 0) {
      bookmarkList.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--md-sys-color-on-surface-variant);">
          <div style="font-size: 48px; margin-bottom: 12px; opacity: 0.5;">🔍</div>
          <div style="font-size: 14px;">No bookmarks found</div>
        </div>
      `;
      return;
    }

    bookmarkList.innerHTML = '';

    // Show first-time setup card if not dismissed
    if (!this.hasSeenSetupCard) {
      bookmarkList.appendChild(this.createSetupCard());
    }

    // Render bookmark nodes
    this.renderNodes(filtered, bookmarkList);

    // Add root drop zone
    bookmarkList.appendChild(this.createRootDropZone());

    // Restore open menu state
    if (this.openMenuBookmarkId) {
      setTimeout(() => {
        const bookmarkDiv = document.querySelector(
          `[data-id="${this.openMenuBookmarkId}"]`
        );
        if (bookmarkDiv) {
          const menu = bookmarkDiv.querySelector('.bookmark-actions');
          if (menu) {
            menu.classList.add('show');
          }
        }
      }, 0);
    }

    // Update status bar
    this.updateTotalBookmarkCount();
  }

  /**
   * Filter and search bookmarks based on current filters
   */
  filterAndSearchBookmarks(tree) {
    if (!tree || !tree.roots) return [];

    // Get all bookmarks and folders from roots
    const allItems = [];
    Object.values(tree.roots).forEach(root => {
      if (root.children) {
        allItems.push(...root.children);
      }
    });

    // Apply search filter if present
    const searchQuery = document.getElementById('searchInput')?.value.toLowerCase();
    if (searchQuery) {
      return this.searchRecursive(allItems, searchQuery);
    }

    // Apply status filters
    // TODO: Implement filter logic based on filter buttons
    return allItems;
  }

  /**
   * Recursively search bookmarks
   */
  searchRecursive(nodes, query) {
    const results = [];

    for (const node of nodes) {
      if (node.type === 'bookmark') {
        const titleMatch = node.title?.toLowerCase().includes(query);
        const urlMatch = node.url?.toLowerCase().includes(query);
        if (titleMatch || urlMatch) {
          results.push(node);
        }
      } else if (node.type === 'folder') {
        // Search folder name
        if (node.title?.toLowerCase().includes(query)) {
          results.push(node);
        }
        // Search folder children
        if (node.children) {
          results.push(...this.searchRecursive(node.children, query));
        }
      }
    }

    return results;
  }

  /**
   * Recursively render bookmark nodes
   */
  renderNodes(nodes, container, parentId = 'root') {
    const isRootLevel = parentId === 'root';

    nodes.forEach((node, index) => {
      // Add the actual item
      if (node.type === 'folder') {
        container.appendChild(this.createFolderElement(node));
      } else if (node.url) {
        container.appendChild(this.createBookmarkElement(node));
      }

      // Add drop zone after item (except last item at root level)
      const isLastItem = index === nodes.length - 1;
      if (!isLastItem || !isRootLevel) {
        container.appendChild(this.createDropZone(parentId, index + 1));
      }
    });
  }

  /**
   * Create folder element
   */
  createFolderElement(folder) {
    const folderDiv = document.createElement('div');
    folderDiv.className = 'folder-item';
    folderDiv.dataset.id = folder.id;

    const isExpanded = this.expandedFolders.has(folder.id);
    const childCount = this.countBookmarks(folder);
    const folderTitle = folder.title || 'Unnamed Folder';

    folderDiv.innerHTML = `
      <div class="folder-header" draggable="true" role="button" aria-expanded="${isExpanded}">
        ${this.multiSelectMode ? `<input type="checkbox" class="item-checkbox" data-id="${folder.id}" ${this.selectedItems.has(folder.id) ? 'checked' : ''}>` : ''}
        <div class="folder-toggle ${isExpanded ? 'expanded' : ''}"></div>
        <div class="folder-icon-container">
          <svg class="folder-icon-outline" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 7C3 5.89543 3.89543 5 5 5H9L11 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
          </svg>
          <div class="folder-count" data-digits="${childCount.toString().length}">${childCount}</div>
        </div>
        <div class="folder-title">${this.escapeHtml(folderTitle)}</div>
        <button class="bookmark-menu-btn folder-menu-btn" aria-label="More actions">⋮</button>
        <div class="bookmark-actions">
          <button class="action-btn" data-action="rescan-folder">
            <span class="icon">📡</span>
            <span>Rescan Bookmarks in Folder</span>
          </button>
          <button class="action-btn" data-action="add-bookmark">
            <span class="icon">➕</span>
            <span>Add Bookmark Here</span>
          </button>
          <button class="action-btn" data-action="add-subfolder">
            <span class="icon">📁</span>
            <span>Add Subfolder Here</span>
          </button>
          <button class="action-btn" data-action="rename">
            <span class="icon">✏️</span>
            <span>Rename</span>
          </button>
          <button class="action-btn danger" data-action="delete">
            <span class="icon">🗑️</span>
            <span>Delete</span>
          </button>
        </div>
      </div>
      <div class="folder-children ${isExpanded ? 'show' : ''}" style="border-left: 2px solid #818cf8 !important;"></div>
    `;

    // Add event listeners
    this.attachFolderListeners(folderDiv, folder);

    // Render children if expanded
    if (isExpanded && folder.children) {
      const childContainer = folderDiv.querySelector('.folder-children');
      this.renderNodes(folder.children, childContainer, folder.id);
    }

    return folderDiv;
  }

  /**
   * Create bookmark element
   */
  createBookmarkElement(bookmark) {
    const bookmarkDiv = document.createElement('div');
    bookmarkDiv.className = 'bookmark-item';
    if (!this.displayOptions.preview) {
      bookmarkDiv.classList.add('no-preview');
    }
    bookmarkDiv.dataset.id = bookmark.id;
    bookmarkDiv.draggable = true;

    const linkStatus = bookmark.linkStatus || 'unknown';
    const safetyStatus = bookmark.safetyStatus || 'unknown';
    const safetySources = bookmark.safetySources || [];

    // Build status indicators
    let statusIndicatorsHtml = '';
    if (this.displayOptions.safetyStatus) {
      statusIndicatorsHtml += this.getShieldHtml(safetyStatus, bookmark.url, safetySources);
    }
    if (this.displayOptions.liveStatus) {
      statusIndicatorsHtml += this.getStatusDotHtml(linkStatus, bookmark.url);
    }

    // Build favicon
    let faviconHtml = '';
    if (this.displayOptions.favicon && bookmark.url) {
      const faviconUrl = this.getFaviconUrl(bookmark.url);
      if (faviconUrl) {
        // Use onerror to silently hide broken favicons without console errors
        faviconHtml = `<img class="bookmark-favicon" src="${this.escapeHtml(faviconUrl)}" alt="" onerror="this.style.display='none';this.onerror=null;" loading="lazy" />`;
      }
    }

    // Build bookmark info
    let bookmarkInfoHtml = '';
    if (this.displayOptions.title) {
      bookmarkInfoHtml += `<div class="bookmark-title" title="${this.escapeHtml(bookmark.url)}">${this.escapeHtml(bookmark.title || bookmark.url)}</div>`;
    }
    if (this.displayOptions.url) {
      try {
        const hostname = new URL(bookmark.url).hostname;
        bookmarkInfoHtml += `<div class="bookmark-url" title="${this.escapeHtml(bookmark.url)}">${this.escapeHtml(hostname)}</div>`;
      } catch (e) {
        bookmarkInfoHtml += `<div class="bookmark-url">${this.escapeHtml(bookmark.url)}</div>`;
      }
    }

    const bookmarkTitle = bookmark.title || bookmark.url;

    bookmarkDiv.innerHTML = `
      ${this.multiSelectMode ? `<input type="checkbox" class="item-checkbox" data-id="${bookmark.id}" ${this.selectedItems.has(bookmark.id) ? 'checked' : ''}>` : ''}
      <div class="status-indicators">
        ${statusIndicatorsHtml}
      </div>
      ${faviconHtml}
      <div class="bookmark-info">
        ${bookmarkInfoHtml}
      </div>
      <button class="bookmark-menu-btn" aria-label="More actions">⋮</button>
      <div class="bookmark-actions">
        <button class="action-btn" data-action="open">
          <span class="icon">🔗</span>
          <span>Open</span>
        </button>
        <button class="action-btn" data-action="open-new-tab">
          <span class="icon">🆕</span>
          <span>Open in New Tab</span>
        </button>
        <button class="action-btn" data-action="copy-url">
          <span class="icon">📋</span>
          <span>Copy URL</span>
        </button>
        <button class="action-btn" data-action="qr-code">
          <span class="icon">📱</span>
          <span>Generate QR Code</span>
        </button>
        <button class="action-btn" data-action="edit">
          <span class="icon">✏️</span>
          <span>Edit</span>
        </button>
        <button class="action-btn" data-action="recheck">
          <span class="icon">🔄</span>
          <span>Recheck Security Status</span>
        </button>
        <button class="action-btn danger" data-action="delete">
          <span class="icon">🗑️</span>
          <span>Delete</span>
        </button>
      </div>
      ${this.displayOptions.preview ? `
        <div class="bookmark-preview-container">
          <div class="preview-loading">Loading...</div>
          <img class="preview-image" alt="Preview" data-url="${this.escapeHtml(bookmark.url)}" />
        </div>
      ` : ''}
    `;

    // Add event listeners
    this.attachBookmarkListeners(bookmarkDiv, bookmark);

    return bookmarkDiv;
  }

  /**
   * Attach event listeners to folder element
   */
  attachFolderListeners(folderDiv, folder) {
    const header = folderDiv.querySelector('.folder-header');
    const menuBtn = header.querySelector('.folder-menu-btn');
    const actionsMenu = header.querySelector('.bookmark-actions');

    // Toggle folder on click
    header.addEventListener('click', (e) => {
      if (e.target.closest('.folder-menu-btn') ||
          e.target.closest('.bookmark-actions') ||
          e.target.closest('.item-checkbox')) {
        return;
      }
      if (this.multiSelectMode) return;
      this.toggleFolder(folder.id, folderDiv);
    });

    // Menu toggle
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleFolderMenu(folderDiv);
    });

    // Right-click context menu
    folderDiv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFolderMenu(folderDiv);
    });

    // Action handlers
    actionsMenu.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        await this.handleFolderAction(action, folder);
        this.closeAllMenus();
      });
    });

    // Drag handlers (basic implementation)
    header.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', folder.id);
      folderDiv.style.opacity = '0.5';
    });

    header.addEventListener('dragend', () => {
      folderDiv.style.opacity = '1';
    });
  }

  /**
   * Attach event listeners to bookmark element
   */
  attachBookmarkListeners(bookmarkDiv, bookmark) {
    const menuBtn = bookmarkDiv.querySelector('.bookmark-menu-btn');
    const actionsMenu = bookmarkDiv.querySelector('.bookmark-actions');

    // Open on click
    bookmarkDiv.addEventListener('click', (e) => {
      if (e.target.closest('.bookmark-menu-btn') ||
          e.target.closest('.bookmark-actions') ||
          e.target.closest('.bookmark-preview-container') ||
          e.target.closest('.status-indicators') ||
          e.target.closest('.item-checkbox')) {
        return;
      }
      if (this.multiSelectMode) return;
      window.open(bookmark.url, '_blank');
    });

    // Menu toggle
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleBookmarkMenu(bookmarkDiv);
    });

    // Right-click context menu
    bookmarkDiv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleBookmarkMenu(bookmarkDiv);
    });

    // Action handlers
    actionsMenu.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        await this.handleBookmarkAction(action, bookmark);
        this.closeAllMenus();
      });
    });

    // Drag handlers
    bookmarkDiv.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', bookmark.id);
      bookmarkDiv.style.opacity = '0.5';
    });

    bookmarkDiv.addEventListener('dragend', () => {
      bookmarkDiv.style.opacity = '1';
    });
  }

  /**
   * Toggle folder expand/collapse
   */
  toggleFolder(folderId, folderDiv) {
    if (this.expandedFolders.has(folderId)) {
      this.expandedFolders.delete(folderId);
    } else {
      this.expandedFolders.add(folderId);
    }

    // Re-render bookmarks to update folder state
    const tree = bookmarkManager.getTree();
    this.renderBookmarks(tree);
  }

  /**
   * Count bookmarks in folder recursively
   */
  countBookmarks(folder) {
    if (!folder.children) return 0;

    let count = 0;
    for (const child of folder.children) {
      if (child.type === 'bookmark') {
        count++;
      } else if (child.type === 'folder') {
        count += this.countBookmarks(child);
      }
    }
    return count;
  }

  /**
   * Get favicon URL for a bookmark
   */
  getFaviconUrl(url) {
    try {
      const urlObj = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get status dot HTML
   */
  getStatusDotHtml(linkStatus, url) {
    const statusIcons = {
      'live': `<span class="status-icon status-live" title="Link is live">✓</span>`,
      'dead': `<span class="status-icon status-dead" title="Link is dead">✗</span>`,
      'parked': `<span class="status-icon status-parked" title="Domain is parked">⚠</span>`,
      'checking': `<span class="status-icon status-checking" title="Checking...">⟳</span>`,
      'unknown': `<span class="status-icon status-unknown" title="Unknown">?</span>`
    };
    return statusIcons[linkStatus] || statusIcons['unknown'];
  }

  /**
   * Get shield HTML for safety status
   */
  getShieldHtml(safetyStatus, url, safetySources) {
    const shieldIcons = {
      'safe': `<span class="shield-indicator shield-safe" title="Safe">🛡️</span>`,
      'warning': `<span class="shield-indicator shield-warning" title="Warning">⚠️</span>`,
      'unsafe': `<span class="shield-indicator shield-unsafe" title="UNSAFE">🚫</span>`,
      'checking': `<span class="shield-indicator shield-scanning" title="Checking...">🔍</span>`,
      'unknown': `<span class="shield-indicator shield-unknown" title="Unknown">❓</span>`,
      'whitelisted': `<span class="shield-indicator shield-whitelisted" title="Whitelisted">✓</span>`
    };

    const isWhitelisted = safetySources && safetySources.includes('Whitelisted by user');
    if (isWhitelisted) {
      return shieldIcons['whitelisted'];
    }

    return shieldIcons[safetyStatus] || shieldIcons['unknown'];
  }

  /**
   * Create drop zone element
   */
  createDropZone(parentId, targetIndex) {
    const dropZone = document.createElement('div');
    dropZone.className = 'inter-item-drop-zone';
    dropZone.dataset.parentId = parentId;
    dropZone.dataset.targetIndex = targetIndex;

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      dropZone.classList.add('drop-zone-active');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drop-zone-active');
    });

    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drop-zone-active');

      const draggedId = e.dataTransfer.getData('text/plain');
      await this.handleDropToPosition(draggedId, parentId, targetIndex);
    });

    return dropZone;
  }

  /**
   * Create root drop zone
   */
  createRootDropZone() {
    const dropZone = document.createElement('div');
    dropZone.className = 'root-drop-zone';
    dropZone.style.minHeight = '10px';
    dropZone.style.marginTop = '4px';

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dropZone.classList.add('drop-active');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drop-active');
    });

    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drop-active');

      const draggedId = e.dataTransfer.getData('text/plain');
      await this.handleDropToRoot(draggedId);
    });

    return dropZone;
  }

  /**
   * Create first-time setup card
   */
  createSetupCard() {
    const setupCard = document.createElement('div');
    setupCard.className = 'setup-card';
    setupCard.innerHTML = `
      <div class="setup-card-header">🎆 Welcome to Bookmark Manager Zero Web! 🎆</div>
      <div class="setup-card-subheader">Your bookmarks are stored in your private GitHub Gist!</div>
      <button class="setup-card-scan-btn" id="setupScanBtn">🔍 Scan All Bookmarks Now</button>
      <div class="setup-card-info">
        Bookmarks auto-scan when you expand folders (every 7 days). Progress appears in the status bar below.
        You'll be alerted if safe bookmarks turn malicious.
      </div>
      <div class="setup-card-disclaimer">
        <strong>Note:</strong> Scanning relies on community-submitted threat lists and automated link validation.
        This may produce false positive/negative results. Use BMZ as a helpful safety tool, not a security guarantee.
      </div>
      <button class="setup-card-dismiss-btn" id="setupDismissBtn">Got it, don't show this again</button>
    `;

    // Add event listeners
    setTimeout(() => {
      const scanBtn = document.getElementById('setupScanBtn');
      const dismissBtn = document.getElementById('setupDismissBtn');

      if (scanBtn) {
        scanBtn.addEventListener('click', async () => {
          await this.dismissSetupCard();
          // TODO: Trigger full scan
        });
      }

      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => this.dismissSetupCard());
      }
    }, 0);

    return setupCard;
  }

  /**
   * Dismiss setup card
   */
  async dismissSetupCard() {
    this.hasSeenSetupCard = true;
    // TODO: Save to storage
    const tree = bookmarkManager.getTree();
    this.renderBookmarks(tree);
  }

  /**
   * Handle folder actions
   */
  async handleFolderAction(action, folder) {
    switch (action) {
      case 'rename':
        // TODO: Show rename modal
        console.log('Rename folder:', folder.id);
        break;
      case 'delete':
        if (confirm(`Delete folder "${folder.title}" and all its contents?`)) {
          await bookmarkManager.remove(folder.id);
          const tree = bookmarkManager.getTree();
          this.renderBookmarks(tree);
        }
        break;
      case 'add-bookmark':
        // TODO: Show add bookmark modal with parentId = folder.id
        console.log('Add bookmark to folder:', folder.id);
        break;
      case 'add-subfolder':
        // TODO: Show add folder modal
        console.log('Add subfolder to:', folder.id);
        break;
      case 'rescan-folder':
        await scannerService.scanFolder(folder, true);
        break;
    }
  }

  /**
   * Handle bookmark actions
   */
  async handleBookmarkAction(action, bookmark) {
    switch (action) {
      case 'open':
        window.open(bookmark.url, '_self');
        break;
      case 'open-new-tab':
        window.open(bookmark.url, '_blank');
        break;
      case 'copy-url':
        await navigator.clipboard.writeText(bookmark.url);
        this.showToast('URL copied to clipboard');
        break;
      case 'qr-code':
        // TODO: Show QR code modal
        console.log('Generate QR code for:', bookmark.url);
        break;
      case 'edit':
        // TODO: Show edit modal
        console.log('Edit bookmark:', bookmark.id);
        break;
      case 'delete':
        if (confirm(`Delete bookmark "${bookmark.title}"?`)) {
          await bookmarkManager.remove(bookmark.id);
          const tree = bookmarkManager.getTree();
          this.renderBookmarks(tree);
        }
        break;
      case 'recheck':
        await scannerService.scanBookmark(bookmark, true);
        this.showToast('Rescanning bookmark...');
        break;
    }
  }

  /**
   * Handle drop to position
   */
  async handleDropToPosition(draggedId, parentId, index) {
    try {
      await bookmarkManager.move(draggedId, { parentId, index });
      const tree = bookmarkManager.getTree();
      this.renderBookmarks(tree);
    } catch (error) {
      console.error('Move failed:', error);
      this.showToast('Failed to move item', 'error');
    }
  }

  /**
   * Handle drop to root
   */
  async handleDropToRoot(draggedId) {
    // Move to end of "Other Bookmarks"
    const tree = bookmarkManager.getTree();
    const otherBookmarks = tree.roots.other;
    await this.handleDropToPosition(draggedId, otherBookmarks.id, otherBookmarks.children.length);
  }

  /**
   * Toggle folder menu
   */
  toggleFolderMenu(folderDiv) {
    this.closeAllMenus();
    const menu = folderDiv.querySelector('.bookmark-actions');
    menu.classList.toggle('show');
    this.openMenuBookmarkId = folderDiv.dataset.id;
  }

  /**
   * Toggle bookmark menu
   */
  toggleBookmarkMenu(bookmarkDiv) {
    this.closeAllMenus();
    const menu = bookmarkDiv.querySelector('.bookmark-actions');
    menu.classList.toggle('show');
    this.openMenuBookmarkId = bookmarkDiv.dataset.id;
  }

  /**
   * Close all menus
   */
  closeAllMenus() {
    document.querySelectorAll('.bookmark-actions.show').forEach(menu => {
      menu.classList.remove('show');
    });
    this.openMenuBookmarkId = null;
  }

  /**
   * Update total bookmark count in status bar
   */
  updateTotalBookmarkCount() {
    const stats = bookmarkManager.getStats();
    const statusBar = document.querySelector('.status-bar');
    if (statusBar) {
      // TODO: Update status bar with bookmark count
      console.log('Total bookmarks:', stats.totalBookmarks);
    }
  }

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    // TODO: Implement toast system
    console.log(`[Toast ${type}]:`, message);
  }

  /**
   * Escape HTML entities
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export singleton instance
const uiManager = new UIManager();
export default uiManager;

// Also export the class for testing
export { UIManager };
