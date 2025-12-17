/**
 * Encryption Utilities
 * Shared encryption/decryption functions for API keys
 * Used by scanner service and sidebar for consistent encryption
 */

/**
 * Get derived encryption key from browser info
 * Uses origin, userAgent, and language for key derivation
 */
export async function getDerivedKey() {
  // Use origin and browser info for key derivation
  const appId = window.location.origin;
  const browserInfo = `${navigator.userAgent}-${navigator.language}-${appId}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(browserInfo);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext using AES-GCM
 * @param {string} plaintext - Text to encrypt
 * @returns {string|null} Base64-encoded encrypted data (IV + ciphertext)
 */
export async function encryptApiKey(plaintext) {
  if (!plaintext) return null;
  try {
    const key = await getDerivedKey();
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch (error) {
    console.error('Encryption failed:', error);
    return null;
  }
}

/**
 * Decrypt encrypted data using AES-GCM
 * @param {string} encrypted - Base64-encoded encrypted data
 * @returns {string|null} Decrypted plaintext
 */
export async function decryptApiKey(encrypted) {
  if (!encrypted) return null;
  try {
    const key = await getDerivedKey();
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Decryption failed:', error);
    return null;
  }
}
