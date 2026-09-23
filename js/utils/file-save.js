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

/* [ZeroLabs] 2026-09-24 4:15 AM - added: ask the user where to save, in the Android app */
// App 1.8 had only saveFile, which writes straight into Downloads with no
// question. Newer builds also offer saveFileWithPicker, which opens Android's
// own "save as" screen. That answer comes back later, through
// window.__bmzSaveFileResult, so each request carries an id and waits on a
// promise until its answer arrives.
export function hasAndroidFilePicker() {
  return typeof window !== 'undefined'
    && window.BMZAndroid
    && typeof window.BMZAndroid.saveFileWithPicker === 'function';
}

const pendingPickerSaves = new Map();

function installPickerCallback() {
  if (typeof window === 'undefined' || window.__bmzSaveFileResult) return;
  window.__bmzSaveFileResult = (requestId, savedAs, status) => {
    const resolve = pendingPickerSaves.get(requestId);
    if (!resolve) return;
    pendingPickerSaves.delete(requestId);
    resolve({
      saved: status === 'saved',
      cancelled: status === 'cancelled',
      location: savedAs || ''
    });
  };
}

async function saveWithAndroidPicker(blob, filename) {
  installPickerCallback();
  const base64 = await blobToBase64(blob);
  const requestId = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    pendingPickerSaves.set(requestId, resolve);
    const started = window.BMZAndroid.saveFileWithPicker(requestId, filename, blob.type || '', base64);
    if (!started) {
      pendingPickerSaves.delete(requestId);
      resolve({ saved: false, cancelled: false, location: '' });
    }
  });
}

/**
 * Save a file for the user.
 *
 * @param {Blob} blob     the file content
 * @param {string} filename
 * @returns {Promise<{saved: boolean, cancelled: boolean, location: string}>}
 *   `saved` is false when a save was attempted and did not happen.
 *   `cancelled` is true when the user closed the "save as" screen, which is a
 *   choice and not a failure, so callers say nothing about it.
 *   `location` is the file name or place the file went when that is known, and
 *   an empty string in a browser, where the download is the browser's business
 *   and the page is never told the outcome.
 */
export async function saveFile(blob, filename) {
  if (hasAndroidFilePicker()) {
    try {
      return await saveWithAndroidPicker(blob, filename);
    } catch (error) {
      console.error('[FileSave] The Android save screen failed:', error);
      return { saved: false, cancelled: false, location: '' };
    }
  }

  if (hasAndroidFileBridge()) {
    try {
      const base64 = await blobToBase64(blob);
      // The bridge answers with the location it wrote to, or an empty string
      const location = window.BMZAndroid.saveFile(filename, blob.type || '', base64) || '';
      return { saved: location !== '', cancelled: false, location };
    } catch (error) {
      console.error('[FileSave] The Android bridge refused the file:', error);
      return { saved: false, cancelled: false, location: '' };
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

  return { saved: true, cancelled: false, location: '' };
}
