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

  // Create root structure matching BMZ format
  const bookmarkTree = {
    roots: {
      bookmark_bar: {
        id: 'bmz_import_bar',
        title: 'Bookmarks Bar',
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
      }
    }
  };

  // Parse the DL structure recursively
  const parsedNodes = parseDL(mainDL);

  // If there's a top-level folder structure, preserve it
  // Otherwise, put everything in "Other Bookmarks"
  if (parsedNodes.length > 0 && parsedNodes[0].type === 'folder') {
    // Check if first folder might be "Bookmarks Bar" or similar
    const firstFolder = parsedNodes[0];
    const title = firstFolder.title.toLowerCase();

    if (title.includes('toolbar') || title.includes('bookmarks bar') || title.includes('favorites bar')) {
      bookmarkTree.roots.bookmark_bar.children = firstFolder.children;
      bookmarkTree.roots.other.children = parsedNodes.slice(1);
    } else {
      bookmarkTree.roots.other.children = parsedNodes;
    }
  } else {
    bookmarkTree.roots.other.children = parsedNodes;
  }

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
