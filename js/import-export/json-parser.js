/**
 * JSON Bookmark Parser
 * Parses Chrome and Firefox JSON bookmark formats
 */

/**
 * Parse JSON bookmark file (auto-detect format)
 * @param {string} jsonContent - Raw JSON content from file
 * @returns {Object} Bookmark tree structure
 */
function parseJSONBookmarks(jsonContent) {
  let data;

  try {
    data = JSON.parse(jsonContent);
  } catch (error) {
    throw new Error(`Invalid JSON file: ${error.message}`);
  }

  // Detect format
  if (data.roots) {
    // Chrome/Edge format: { roots: { bookmark_bar: {...}, other: {...} } }
    return parseChromeFormat(data);
  } else if (Array.isArray(data)) {
    // Firefox format: Array of bookmark nodes
    return parseFirefoxFormat(data);
  } else if (data.children) {
    // Single root node format (some exports)
    return parseSingleRootFormat(data);
  } else {
    throw new Error('Unknown JSON bookmark format');
  }
}

/**
 * Parse Chrome/Edge JSON format
 * @param {Object} data - Chrome bookmark data
 * @returns {Object} Normalized bookmark tree
 */
function parseChromeFormat(data) {
  // Chrome format already matches our structure
  // Just need to ensure IDs are unique and regenerate them
  const bookmarkTree = {
    roots: {
      bookmark_bar: regenerateIds(data.roots.bookmark_bar || {
        id: 'bmz_import_bar',
        title: 'Bookmarks Bar',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      }),
      other: regenerateIds(data.roots.other || {
        id: 'bmz_import_other',
        title: 'Other Bookmarks',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      })
    }
  };

  return bookmarkTree;
}

/**
 * Parse Firefox JSON format (array of nodes)
 * @param {Array} data - Firefox bookmark array
 * @returns {Object} Normalized bookmark tree
 */
function parseFirefoxFormat(data) {
  // Firefox exports an array of bookmark nodes
  // We need to organize them into our root structure
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

  // Process each top-level node
  data.forEach(node => {
    const normalizedNode = normalizeFirefoxNode(node);

    // Check if it's a toolbar/bookmarks bar folder
    const title = (normalizedNode.title || '').toLowerCase();
    if (title.includes('toolbar') || title.includes('bookmarks bar')) {
      bookmarkTree.roots.bookmark_bar.children = normalizedNode.children || [];
    } else {
      bookmarkTree.roots.other.children.push(normalizedNode);
    }
  });

  return bookmarkTree;
}

/**
 * Parse single root node format
 * @param {Object} data - Single root node
 * @returns {Object} Normalized bookmark tree
 */
function parseSingleRootFormat(data) {
  const bookmarkTree = {
    roots: {
      bookmark_bar: {
        id: 'bmz_import_bar',
        title: 'Bookmarks Bar',
        type: 'folder',
        dateAdded: Date.now(),
        children: []
      },
      other: regenerateIds(data)
    }
  };

  return bookmarkTree;
}

/**
 * Normalize Firefox bookmark node to our format
 * @param {Object} node - Firefox bookmark node
 * @returns {Object} Normalized node
 */
function normalizeFirefoxNode(node) {
  const normalized = {
    id: generateImportId(),
    title: node.title || node.name || 'Untitled',
    type: node.type || (node.uri ? 'bookmark' : 'folder'),
    dateAdded: node.dateAdded || Date.now()
  };

  // Firefox uses 'uri' instead of 'url'
  if (node.uri) {
    normalized.url = node.uri;
  } else if (node.url) {
    normalized.url = node.url;
  }

  // Recursively normalize children
  if (node.children && Array.isArray(node.children)) {
    normalized.children = node.children.map(child => normalizeFirefoxNode(child));
  }

  return normalized;
}

/**
 * Regenerate all IDs in a bookmark tree (ensure uniqueness)
 * @param {Object} node - Bookmark node
 * @returns {Object} Node with regenerated IDs
 */
function regenerateIds(node) {
  const newNode = { ...node };
  newNode.id = generateImportId();

  if (newNode.children && Array.isArray(newNode.children)) {
    newNode.children = newNode.children.map(child => regenerateIds(child));
  }

  return newNode;
}

/**
 * Generate unique ID for imported bookmarks
 * @returns {string} Unique bookmark ID
 */
function generateImportId() {
  return `bmz_import_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Import bookmarks from JSON file
 * @param {File} file - JSON file from file input
 * @returns {Promise<Object>} Parsed bookmark tree
 */
async function importFromJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const jsonContent = e.target.result;
        const bookmarkTree = parseJSONBookmarks(jsonContent);
        resolve(bookmarkTree);
      } catch (error) {
        reject(new Error(`Failed to parse JSON bookmarks: ${error.message}`));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsText(file);
  });
}

export { parseJSONBookmarks, importFromJSON };
