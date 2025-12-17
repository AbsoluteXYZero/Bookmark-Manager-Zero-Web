/**
 * HTML Bookmark Parser
 * Parses Netscape Bookmark Format (used by Chrome, Firefox, Edge)
 */

/**
 * Parse Netscape HTML bookmark file
 * @param {string} htmlContent - Raw HTML content from file
 * @returns {Object} Bookmark tree structure
 */
function parseHTMLBookmarks(htmlContent) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');

  // Find the main bookmark list (usually in <DL> tags)
  const mainDL = doc.querySelector('DL');
  if (!mainDL) {
    throw new Error('Invalid bookmark file: No bookmark list found');
  }

  // Check for H1 header to determine default container
  const h1 = doc.querySelector('H1');
  const h1Text = h1 ? h1.textContent.trim().toLowerCase() : '';
  console.log('[HTML Import] H1 header found:', h1Text || 'none');

  // Create root structure matching BMZ format with all 4 standard folders
  const bookmarkTree = {
    roots: {
      bookmark_bar: {
        id: 'bmz_import_bar',
        title: 'Bookmarks Bar',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      },
      menu: {
        id: 'bmz_import_menu',
        title: 'Bookmarks Menu',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      },
      other: {
        id: 'bmz_import_other',
        title: 'Other Bookmarks',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      },
      mobile: {
        id: 'bmz_import_mobile',
        title: 'Mobile Bookmarks',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      }
    }
  };

  // Parse the DL structure recursively
  const parsedNodes = parseDL(mainDL);

  // Debug: Log the number of top-level nodes found
  console.log(`[HTML Import] Found ${parsedNodes.length} top-level nodes`);

  // Separate folders from bookmarks
  const folders = [];
  const orphanedBookmarks = [];

  parsedNodes.forEach((node, idx) => {
    if (node.type === 'folder') {
      const childCount = node.children ? node.children.length : 0;
      console.log(`[HTML Import] Node ${idx}: Folder "${node.title}" with ${childCount} children`);
      folders.push(node);
    } else {
      console.log(`[HTML Import] Node ${idx}: Bookmark "${node.title}" (orphaned)`);
      orphanedBookmarks.push(node);
    }
  });

  console.log(`[HTML Import] Summary: ${folders.length} folders, ${orphanedBookmarks.length} orphaned bookmarks`);

  // Track if we've found each root folder type to avoid duplicates
  let foundToolbar = false;
  let foundMenu = false;
  let foundOther = false;
  let foundMobile = false;

  // Determine default container based on H1 header
  // If H1 says "Bookmarks Menu", unmatched content goes to menu
  // Otherwise it goes to other
  const defaultContainer = h1Text.includes('bookmarks menu') ? 'menu' : 'other';
  console.log(`[HTML Import] Default container for unmatched content: ${defaultContainer}`);

  // Process folders first - match them to root folders
  for (const node of folders) {
    const title = node.title.toLowerCase();
    console.log(`[HTML Import] Processing folder: "${node.title}" (lowercase: "${title}")`);

    // Check for PERSONAL_TOOLBAR_FOLDER attribute (highest priority)
    // This is the Netscape standard way to mark the toolbar folder
    if (node.isPersonalToolbar && !foundToolbar) {
      console.log(`[HTML Import] Matched "${node.title}" to Bookmarks Bar (PERSONAL_TOOLBAR_FOLDER)`);
      bookmarkTree.roots.bookmark_bar.children = node.children || [];
      bookmarkTree.roots.bookmark_bar.title = node.title; // Preserve original name
      foundToolbar = true;
    }
    // Match Chrome's "Bookmarks bar" or Firefox's "Bookmarks Toolbar"
    else if ((title.includes('toolbar') || title.includes('bookmarks bar') || title.includes('favorites bar')) && !foundToolbar) {
      console.log(`[HTML Import] Matched "${node.title}" to Bookmarks Bar (name match)`);
      bookmarkTree.roots.bookmark_bar.children = node.children || [];
      bookmarkTree.roots.bookmark_bar.title = node.title; // Preserve original name
      foundToolbar = true;
    }
    // Match Firefox's "Bookmarks Menu"
    else if ((title.includes('bookmarks menu') || title === 'menu') && !foundMenu) {
      console.log(`[HTML Import] Matched "${node.title}" to Bookmarks Menu`);
      bookmarkTree.roots.menu.children = node.children || [];
      bookmarkTree.roots.menu.title = node.title; // Preserve original name
      foundMenu = true;
    }
    // Match Chrome's "Other bookmarks" or Firefox's "Other Bookmarks" / "Unfiled Bookmarks"
    else if ((title.includes('other bookmarks') || title.includes('unfiled')) && !foundOther) {
      console.log(`[HTML Import] Matched "${node.title}" to Other Bookmarks`);
      bookmarkTree.roots.other.children = node.children || [];
      bookmarkTree.roots.other.title = node.title; // Preserve original name
      foundOther = true;
    }
    // Match "Mobile bookmarks" or "Mobile Bookmarks"
    else if (title.includes('mobile') && !foundMobile) {
      console.log(`[HTML Import] Matched "${node.title}" to Mobile Bookmarks`);
      bookmarkTree.roots.mobile.children = node.children || [];
      bookmarkTree.roots.mobile.title = node.title; // Preserve original name
      foundMobile = true;
    }
    // Unrecognized folder - add to default container (menu or other based on H1)
    else {
      const containerName = defaultContainer === 'menu' ? 'Bookmarks Menu' : 'Other Bookmarks';
      console.log(`[HTML Import] Adding unrecognized folder "${node.title}" to ${containerName} (foundToolbar=${foundToolbar}, foundMenu=${foundMenu}, foundOther=${foundOther}, foundMobile=${foundMobile})`);
      bookmarkTree.roots[defaultContainer].children.push(node);
    }
  }

  // Add any orphaned bookmarks to default container
  if (orphanedBookmarks.length > 0) {
    const containerName = defaultContainer === 'menu' ? 'Bookmarks Menu' : 'Other Bookmarks';
    console.log(`[HTML Import] Adding ${orphanedBookmarks.length} orphaned bookmarks to ${containerName}`);
    bookmarkTree.roots[defaultContainer].children.push(...orphanedBookmarks);
  }

  // Final summary
  console.log(`[HTML Import] Final folder match status: Toolbar=${foundToolbar}, Menu=${foundMenu}, Other=${foundOther}, Mobile=${foundMobile}`);
  console.log(`[HTML Import] Bookmark counts - Bar: ${bookmarkTree.roots.bookmark_bar.children.length}, Menu: ${bookmarkTree.roots.menu.children.length}, Other: ${bookmarkTree.roots.other.children.length}, Mobile: ${bookmarkTree.roots.mobile.children.length}`);

  return bookmarkTree;
}

/**
 * Recursively parse a <DL> element containing bookmarks and folders
 * @param {Element} dlElement - The DL element to parse
 * @returns {Array} Array of bookmark/folder nodes
 */
function parseDL(dlElement) {
  const nodes = [];

  // Process each <DT> (definition term) which contains either a bookmark or folder
  const dtElements = dlElement.querySelectorAll(':scope > DT');

  dtElements.forEach(dt => {
    // Check if it's a folder (<H3>) or bookmark (<A>)
    const h3 = dt.querySelector(':scope > H3');
    const anchor = dt.querySelector(':scope > A');

    if (h3) {
      // It's a folder
      const folder = {
        id: generateImportId(),
        title: h3.textContent.trim() || 'Unnamed Folder',
        type: 'folder',
        dateAdded: parseDateAdded(h3),
        children: []
      };

      // Check for PERSONAL_TOOLBAR_FOLDER attribute (Netscape standard)
      if (h3.getAttribute('PERSONAL_TOOLBAR_FOLDER') === 'true') {
        folder.isPersonalToolbar = true;
      }

      // Find the nested <DL> that contains this folder's children
      const nestedDL = dt.querySelector(':scope > DL');
      if (nestedDL) {
        folder.children = parseDL(nestedDL);
      }

      nodes.push(folder);

    } else if (anchor) {
      // It's a bookmark
      const bookmark = {
        id: generateImportId(),
        title: anchor.textContent.trim() || 'Unnamed Bookmark',
        url: anchor.getAttribute('HREF') || '',
        type: 'bookmark',
        dateAdded: parseDateAdded(anchor)
      };

      // Optional: Parse additional attributes
      const icon = anchor.getAttribute('ICON');
      if (icon) {
        bookmark.icon = icon;
      }

      nodes.push(bookmark);
    }
  });

  return nodes;
}

/**
 * Parse ADD_DATE attribute (Unix timestamp)
 * @param {Element} element - HTML element with ADD_DATE attribute
 * @returns {number} Timestamp in milliseconds
 */
function parseDateAdded(element) {
  const addDate = element.getAttribute('ADD_DATE');
  if (addDate) {
    // ADD_DATE is usually in seconds, convert to milliseconds
    const timestamp = parseInt(addDate, 10);
    return timestamp * 1000;
  }
  return Date.now();
}

/**
 * Generate unique ID for imported bookmarks
 * @returns {string} Unique bookmark ID
 */
function generateImportId() {
  return `bmz_import_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Import bookmarks from HTML file
 * @param {File} file - HTML file from file input
 * @returns {Promise<Object>} Parsed bookmark tree
 */
async function importFromHTML(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const htmlContent = e.target.result;
        const bookmarkTree = parseHTMLBookmarks(htmlContent);
        resolve(bookmarkTree);
      } catch (error) {
        reject(new Error(`Failed to parse HTML bookmarks: ${error.message}`));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsText(file);
  });
}

export { parseHTMLBookmarks, importFromHTML };
