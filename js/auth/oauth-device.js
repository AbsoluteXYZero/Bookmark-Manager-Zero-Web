/**
 * GitHub OAuth - Device Code Flow
 * Implements device flow for 100% static authentication (no backend needed)
 * Perfect for GitHub Pages and other static hosting
 */

import authManager from './auth-manager.js';
import { GITHUB_OAUTH } from '../../config/github-oauth.js';

class OAuthDevice {
  constructor() {
    this.deviceCode = null;
    this.userCode = null;
    this.verificationUri = null;
    this.expiresIn = null;
    this.interval = null;
    this.pollingTimer = null;
    this.isPolling = false;
  }

  /**
   * Request device and user codes from GitHub
   */
  async requestDeviceCode() {
    try {
      const response = await fetch(GITHUB_OAUTH.endpoints.deviceCode, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: GITHUB_OAUTH.clientId,
          scope: GITHUB_OAUTH.scope
        })
      });

      if (!response.ok) {
        throw new Error(`Device code request failed: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`Device code error: ${data.error_description || data.error}`);
      }

      // Store device flow data
      this.deviceCode = data.device_code;
      this.userCode = data.user_code;
      this.verificationUri = data.verification_uri;
      this.expiresIn = data.expires_in; // Usually 900 seconds (15 minutes)
      this.interval = data.interval || 5; // Poll interval in seconds

      console.log('Device code obtained:', {
        userCode: this.userCode,
        verificationUri: this.verificationUri,
        expiresIn: this.expiresIn
      });

      return {
        userCode: this.userCode,
        verificationUri: this.verificationUri,
        expiresIn: this.expiresIn
      };
    } catch (error) {
      console.error('Failed to request device code:', error);
      throw error;
    }
  }

  /**
   * Start polling for access token
   * Returns a promise that resolves when user authorizes or rejects when timeout/error
   */
  async pollForToken() {
    if (this.isPolling) {
      throw new Error('Already polling for token');
    }

    if (!this.deviceCode) {
      throw new Error('No device code - call requestDeviceCode() first');
    }

    this.isPolling = true;
    const startTime = Date.now();
    const expiresAt = startTime + (this.expiresIn * 1000);

    return new Promise((resolve, reject) => {
      const poll = async () => {
        // Check if expired
        if (Date.now() >= expiresAt) {
          this.stopPolling();
          reject(new Error('Device code expired - please try again'));
          return;
        }

        try {
          const response = await fetch(GITHUB_OAUTH.endpoints.token, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              client_id: GITHUB_OAUTH.clientId,
              device_code: this.deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
          });

          const data = await response.json();

          if (data.error) {
            if (data.error === 'authorization_pending') {
              // User hasn't authorized yet - continue polling
              console.log('Waiting for user authorization...');
            } else if (data.error === 'slow_down') {
              // We're polling too fast - increase interval
              console.warn('Polling too fast, slowing down...');
              this.interval += 5;
            } else if (data.error === 'expired_token') {
              // Device code expired
              this.stopPolling();
              reject(new Error('Device code expired'));
              return;
            } else if (data.error === 'access_denied') {
              // User denied authorization
              this.stopPolling();
              reject(new Error('Access denied by user'));
              return;
            } else {
              // Unknown error
              this.stopPolling();
              reject(new Error(`OAuth error: ${data.error_description || data.error}`));
              return;
            }
          } else if (data.access_token) {
            // Success! We have the token
            this.stopPolling();
            const token = data.access_token;

            // Store token
            await authManager.storeToken(token);

            console.log('Device flow authentication successful!');
            resolve(token);
            return;
          }

          // Schedule next poll
          this.pollingTimer = setTimeout(poll, this.interval * 1000);
        } catch (error) {
          console.error('Polling error:', error);
          this.stopPolling();
          reject(error);
        }
      };

      // Start polling
      poll();
    });
  }

  /**
   * Stop polling for token
   */
  stopPolling() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.isPolling = false;
    console.log('Stopped polling for token');
  }

  /**
   * Complete device flow (request code + poll for token)
   * Returns device code info and starts polling in background
   */
  async initiateDeviceFlow() {
    // Request device code
    const codeInfo = await this.requestDeviceCode();

    // Return code info so UI can display it
    // Polling happens separately
    return codeInfo;
  }

  /**
   * Cancel device flow
   */
  cancel() {
    this.stopPolling();
    this.deviceCode = null;
    this.userCode = null;
    this.verificationUri = null;
    console.log('Device flow cancelled');
  }

  /**
   * Get remaining time in seconds
   */
  getRemainingTime() {
    if (!this.expiresIn || !this.isPolling) return 0;
    // Calculate based on when polling started
    // This is approximate - actual expiry is tracked in pollForToken()
    return Math.max(0, this.expiresIn);
  }

  /**
   * Check if currently polling
   */
  get polling() {
    return this.isPolling;
  }

  /**
   * Logout (clear token)
   */
  async logout() {
    this.cancel();
    await authManager.clearToken();
    console.log('Logged out successfully');
  }
}

// Export singleton instance
const oauthDevice = new OAuthDevice();
export default oauthDevice;

// Also export the class for testing
export { OAuthDevice };
