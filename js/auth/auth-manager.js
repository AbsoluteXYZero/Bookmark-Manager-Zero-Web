/**
 * Authentication Manager for Bookmark Manager Zero
 * Handles GitLab OAuth token management with AES-256-GCM encryption
 * Adapted from background.js encryption utilities
 */

import dbManager from '../storage/indexeddb.js';
import { safeLocalStorage } from '../utils/storage-utils.js';

class AuthManager {
  constructor() {
    this.token = null;
    this.user = null;
    this.encryptionKey = null;
  }

  /**
   * Derive encryption key from browser fingerprint
   * Uses same method as browser extensions for consistency
   */
  async getDerivedKey(userPassword = null) {
    // Browser fingerprint for key derivation (using origin instead of screen dimensions)
    const appId = window.location.origin;
    const browserInfo = `${navigator.userAgent}-${navigator.language}-${appId}`;

    // Optionally add user password for additional security
    const material = userPassword ? `${browserInfo}-${userPassword}` : browserInfo;

    const encoder = new TextEncoder();
    const data = encoder.encode(material);
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
   * Encrypt a token using AES-256-GCM
   */
  async encryptToken(token, userPassword = null) {
    const key = await this.getDerivedKey(userPassword);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(token)
    );

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    // Return as base64
    return btoa(String.fromCharCode(...combined));
  }

  /**
   * Decrypt a token using AES-256-GCM
   */
  async decryptToken(encryptedBase64, userPassword = null) {
    if (!encryptedBase64) return null;

    try {
      const key = await this.getDerivedKey(userPassword);
      const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
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
      console.error('Token decryption failed:', error);
      return null;
    }
  }

  /**
   * Store encrypted token in IndexedDB
   */
  async storeToken(token, userPassword = null, provider = 'gitlab') {
    const encrypted = await this.encryptToken(token, userPassword);
    const key = `${provider}_token`;
    await dbManager.put('settings', {
      key: key,
      value: encrypted
    });

    this.token = token;
    console.log(`${provider} token stored securely`);
  }

  /**
   * Retrieve and decrypt token from IndexedDB
   */
  async loadToken(userPassword = null, provider = 'gitlab') {
    const key = `${provider}_token`;
    const record = await dbManager.get('settings', key);

    if (!record) return null;

    const token = await this.decryptToken(record.value, userPassword);
    this.token = token;
    return token;
  }

  /**
   * Remove token from storage
   */
  async clearToken(provider = 'gitlab') {
    const key = `${provider}_token`;
    await dbManager.delete('settings', key);

    // Clear in-memory state
    this.token = null;
    this.user = null;

    console.log(`${provider} token cleared`);
  }

  /**
   * Get current token (from memory or storage)
   */
  async getToken(provider = 'gitlab') {
    if (this.token) {
      return this.token;
    }
    return await this.loadToken(null, provider);
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated() {
    const token = await this.getToken();
    return !!token;
  }

  /**
   * Fetch user information from GitLab
   */
  async fetchUserInfo() {
    const token = await this.getToken();
    if (!token) throw new Error('No authentication token');

    try {
      const response = await fetch('https://gitlab.com/api/v4/user', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(`GitLab API error: ${response.status}`);
      }

      this.user = await response.json();
      return this.user;
    } catch (error) {
      console.error('Failed to fetch user info:', error);
      throw error;
    }
  }

  /**
   * Get cached user info or fetch from GitLab
   */
  async getUserInfo() {
    if (this.user) return this.user;
    return await this.fetchUserInfo();
  }

  /**
   * Validate token with GitLab API
   */
  async validateToken() {
    try {
      await this.fetchUserInfo();
      return true;
    } catch (error) {
      console.error('Token validation failed:', error);
      return false;
    }
  }

  /**
   * Encrypt and store API key (for scanning services)
   */
  async storeApiKey(keyName, apiKey, userPassword = null) {
    const encrypted = await this.encryptToken(apiKey, userPassword);
    await dbManager.put('settings', {
      key: keyName,
      value: encrypted
    });
    console.log(`API key ${keyName} stored securely`);
  }

  /**
   * Retrieve and decrypt API key
   */
  async getApiKey(keyName, userPassword = null) {
    const record = await dbManager.get('settings', keyName);
    if (!record) return null;
    return await this.decryptToken(record.value, userPassword);
  }

  /**
   * Remove API key from storage
   */
  async removeApiKey(keyName) {
    await dbManager.delete('settings', keyName);
    console.log(`API key ${keyName} removed`);
  }

  /**
   * Store user preferences
   */
  async storePreference(key, value) {
    await dbManager.put('settings', { key, value });
  }

  /**
   * Get user preference
   */
  async getPreference(key, defaultValue = null) {
    const record = await dbManager.get('settings', key);
    return record ? record.value : defaultValue;
  }

  /**
   * Generate a unique device ID for sync locking
   */
  getDeviceId() {
    try {
      let deviceId = safeLocalStorage.getItem('bmz_device_id');
      if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        safeLocalStorage.setItem('bmz_device_id', deviceId);
      }
      return deviceId;
    } catch (e) {
      // localStorage not available, generate temporary device ID
      console.warn('localStorage not available for device ID, using temporary ID');
      return `device_temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
  }

  /**
   * Get authentication status for UI
   */
  async getAuthStatus() {
    const isAuth = await this.isAuthenticated();
    if (!isAuth) {
      return {
        authenticated: false,
        user: null,
        deviceId: this.getDeviceId()
      };
    }

    try {
      const user = await this.getUserInfo();
      return {
        authenticated: true,
        user: {
          login: user.username || user.login,
          name: user.name,
          avatar: user.avatar_url,
          email: user.email
        },
        deviceId: this.getDeviceId()
      };
    } catch (error) {
      // Token invalid, clear it
      await this.clearToken();
      return {
        authenticated: false,
        user: null,
        deviceId: this.getDeviceId()
      };
    }
  }
}

// Export singleton instance
const authManager = new AuthManager();
export default authManager;

// Also export the class for testing
export { AuthManager };
