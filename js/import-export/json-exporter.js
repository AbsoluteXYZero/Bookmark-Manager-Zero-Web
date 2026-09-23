/**
 * JSON Bookmark Exporter
 * Exports bookmarks to JSON format (preserves all metadata)
 */

import { saveFile } from '../utils/file-save.js';

/* [ZeroLabs] 2026-09-23 5:20 PM - edited: saving goes through one helper now */
// The anchor download this used to do is dropped without an error inside the
// Android app's WebView. See js/utils/file-save.js.
/**
 * Export bookmarks as JSON file
 *
 * @returns {Promise<{filename: string, saved: boolean, location: string}>}
 */
async function exportAsJSON(bookmarkTree) {
  const json = JSON.stringify(bookmarkTree, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  // Generate filename with timestamp
  const date = new Date().toISOString().split('T')[0];
  const filename = `bookmarks-backup-${date}.json`;

  const result = await saveFile(blob, filename);
  return { filename, saved: result.saved, location: result.location };
}

export { exportAsJSON };
