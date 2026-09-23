/**
 * File saving
 *
 * One place that knows how to hand a finished file to the user, because the
 * answer differs by platform and every exporter was getting it wrong in the
 * same way.
 */

/* [ZeroLabs] 2026-09-23 5:20 PM - added: exports were silently lost in the Android app */
// Every export built a Blob, made an <a download>, clicked it, and then told
// the user it had worked. In a browser that is correct. In the Android app it
// is not: a WebView has NO download handling of its own, so the click was
// dropped without an error and the success message was a lie. Nothing was ever
// written.
//
// The app now carries a BMZAndroid.saveFile bridge, so when it is present the
// bytes go through it and the app writes the file to Downloads. Everywhere
// else the anchor is still the right answer.
//
// Two smaller faults fixed at the same time:
//   - the object URL was revoked in the same tick as the click, which can cancel
//     a download that has not started reading yet.
//   - nothing the caller could check said whether a save had happened, so every
//     caller assumed it had.

/**
 * Read a Blob as base64, with no data URL prefix.
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * True when the page is running inside the BMZ Android app and that app is new
 * enough to save files.
 */
export function hasAndroidFileBridge() {
  return typeof window !== 'undefined'
    && window.BMZAndroid
    && typeof window.BMZAndroid.saveFile === 'function';
}

/**
 * Save a file for the user.
 *
 * @param {Blob} blob     the file content
 * @param {string} filename
 * @returns {Promise<{saved: boolean, location: string}>}
 *   `saved` is false only when a save was attempted and definitely failed.
 *   `location` is where the file went when that is known, and an empty string
 *   in a browser, where the download is the browser's business and the page is
 *   never told the outcome.
 */
export async function saveFile(blob, filename) {
  if (hasAndroidFileBridge()) {
    try {
      const base64 = await blobToBase64(blob);
      // The bridge answers with the location it wrote to, or an empty string
      const location = window.BMZAndroid.saveFile(filename, blob.type || '', base64) || '';
      return { saved: location !== '', location };
    } catch (error) {
      console.error('[FileSave] The Android bridge refused the file:', error);
      return { saved: false, location: '' };
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Give the download time to start before the URL stops resolving. One minute
  // is far longer than any of these files need and costs one object.
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  return { saved: true, location: '' };
}
