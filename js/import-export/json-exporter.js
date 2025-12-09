/**
 * JSON Bookmark Exporter
 * Exports bookmarks to JSON format (preserves all metadata)
 */

/**
 * Export bookmarks as JSON file
 */
function exportAsJSON(bookmarkTree) {
  const json = JSON.stringify(bookmarkTree, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Generate filename with timestamp
  const date = new Date().toISOString().split('T')[0];
  const filename = `bookmarks-backup-${date}.json`;

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

export { exportAsJSON };
