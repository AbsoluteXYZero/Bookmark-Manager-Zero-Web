/**
 * HTML Bookmark Exporter
 * Exports bookmarks to Netscape Bookmark Format (compatible with all browsers)
 */

/**
 * Convert bookmark nodes to HTML format (recursive)
 */
function bookmarksToHTML(bookmarkNodes, indent = 0) {
  let html = '';
  const indentStr = '    '.repeat(indent);

  for (const node of bookmarkNodes) {
    if (node.url) {
      // It's a bookmark
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : '';
      const title = escapeHtml(node.title || node.url);
      html += `${indentStr}<DT><A HREF="${escapeHtml(node.url)}"${addDate ? ` ADD_DATE="${addDate}"` : ''}>${title}</A>\n`;
    } else if (node.children) {
      // It's a folder
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : '';
      const title = escapeHtml(node.title || 'Untitled Folder');
      html += `${indentStr}<DT><H3${addDate ? ` ADD_DATE="${addDate}"` : ''}>${title}</H3>\n`;
      html += `${indentStr}<DL><p>\n`;
      html += bookmarksToHTML(node.children, indent + 1);
      html += `${indentStr}</DL><p>\n`;
    }
  }

  return html;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Generate complete HTML bookmark file
 */
function generateBookmarkHTML(bookmarkTree) {
  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  // Process all root folders
  if (bookmarkTree && bookmarkTree.roots) {
    const roots = Object.values(bookmarkTree.roots);
    for (const root of roots) {
      if (root.children && root.children.length > 0) {
        // Add root folder as H3
        html += `    <DT><H3>${escapeHtml(root.name || root.title)}</H3>\n`;
        html += `    <DL><p>\n`;
        html += bookmarksToHTML(root.children, 2);
        html += `    </DL><p>\n`;
      }
    }
  }

  html += `</DL><p>\n`;

  return html;
}

/**
 * Export bookmarks as HTML file
 */
function exportAsHTML(bookmarkTree) {
  const html = generateBookmarkHTML(bookmarkTree);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  // Generate filename with timestamp
  const date = new Date().toISOString().split('T')[0];
  const filename = `bookmarks-${date}.html`;

  // Create download link and trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return filename;
}

export { exportAsHTML, generateBookmarkHTML };
