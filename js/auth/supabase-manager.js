/**
 * Supabase Manager for Bookmark Manager Zero Web
 * Handles GitLab OAuth via Supabase and cross-device PAT storage.
 * OAuth uses a full-page redirect (no browser.identity available on web).
 */

import dbManager from '../storage/indexeddb.js';

const SUPABASE_URL = 'https://zkwmxywegwgqcgssgfqv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inprd214eXdlZ3dncWNnc3NnZnF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3OTE5MjIsImV4cCI6MjA5MjM2NzkyMn0.-fvMiySTdda2ACXvFXk2Y0Dlu2tXhgxd94UzYvqPx8I';
const REDIRECT_URL = 'https://bmzweb.absolutezero.fyi/';

class SupabaseManager {
  constructor() {
    this.session = null;
  }

  get isSignedIn() {
    return !!(this.session?.access_token);
  }

  get authHeaders() {
    return {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${this.session?.access_token || SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    };
  }

  async saveSession() {
    await dbManager.put('settings', { key: 'bmz_supabase_session', value: JSON.stringify(this.session) });
  }

  async loadSession() {
    try {
      const record = await dbManager.get('settings', 'bmz_supabase_session');
      if (record?.value) {
        this.session = JSON.parse(record.value);
        if (this.session.expires_at && Math.floor(Date.now() / 1000) >= this.session.expires_at - 60) {
          const refreshed = await this.refreshSession();
          if (!refreshed) {
            this.session = null;
            await dbManager.delete('settings', 'bmz_supabase_session');
          }
        }
      }
    } catch (e) {
      this.session = null;
    }
  }

  async clearSession() {
    this.session = null;
    await dbManager.delete('settings', 'bmz_supabase_session');
  }

  async refreshSession() {
    if (!this.session?.refresh_token) return false;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: this.session.refresh_token })
      });
      if (!res.ok) return false;
      const data = await res.json();
      this.session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user: data.user || this.session.user
      };
      await this.saveSession();
      return true;
    } catch (e) {
      return false;
    }
  }

  async authFetch(url, options = {}) {
    const run = () => fetch(url, { ...options, headers: { ...this.authHeaders, ...(options.headers || {}) } });
    let res = await run();
    if (res.status === 401) {
      const refreshed = await this.refreshSession();
      if (refreshed) res = await run();
    }
    return res;
  }

  // Redirect the page to Supabase GitLab OAuth
  signInWithGitLab() {
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=gitlab&redirect_to=${encodeURIComponent(REDIRECT_URL)}`;
    window.location.href = authUrl;
  }

  // Call this early in app init — detects OAuth redirect and extracts tokens from URL fragment.
  // Returns true if an OAuth callback was processed, false otherwise.
  async handleOAuthCallback() {
    const hash = window.location.hash.slice(1);
    if (!hash) return false;

    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    if (!accessToken) return false;

    // Clear URL fragment immediately so tokens don't linger in browser history
    history.replaceState(null, '', window.location.pathname + window.location.search);

    const oauthError = params.get('error');
    if (oauthError) {
      const desc = params.get('error_description');
      throw new Error(desc ? decodeURIComponent(desc.replace(/\+/g, ' ')) : oauthError);
    }

    const refreshToken = params.get('refresh_token');
    const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    if (!userRes.ok) throw new Error('Failed to fetch account info after sign-in');
    const user = await userRes.json();

    this.session = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      user
    };
    await this.saveSession();
    return true;
  }

  // AES-GCM encryption keyed on user UID (same scheme as Firefox extension)
  async _encryptPAT(token) {
    const uid = this.session?.user?.id;
    if (!uid) throw new Error('No user session for encryption');
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(uid.padEnd(32, '0').slice(0, 32)), 'AES-GCM', false, ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial, enc.encode(token));
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  async _decryptPAT(encryptedBase64) {
    const uid = this.session?.user?.id;
    if (!uid) return null;
    try {
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(uid.padEnd(32, '0').slice(0, 32)), 'AES-GCM', false, ['decrypt']
      );
      const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: combined.slice(0, 12) }, keyMaterial, combined.slice(12)
      );
      return new TextDecoder().decode(decrypted);
    } catch (e) {
      console.error('PAT decryption failed:', e);
      return null;
    }
  }

  async saveGitLabToken(token, expiresAt) {
    if (!this.isSignedIn) return;
    const userId = this.session.user.id;
    const encrypted = await this._encryptPAT(token);

    const patchRes = await this.authFetch(
      `${SUPABASE_URL}/rest/v1/gitlab_tokens?user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ token: encrypted, expires_at: expiresAt, updated_at: new Date().toISOString() })
      }
    );
    if (patchRes.ok) {
      const rows = await patchRes.json().catch(() => []);
      if (Array.isArray(rows) && rows.length > 0) return;
    }

    const insertRes = await this.authFetch(
      `${SUPABASE_URL}/rest/v1/gitlab_tokens`,
      {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: userId, token: encrypted, expires_at: expiresAt, updated_at: new Date().toISOString() })
      }
    );
    if (!insertRes.ok) {
      const err = await insertRes.text().catch(() => '');
      throw new Error(`Failed to save token to Supabase: ${err}`);
    }
  }

  async loadGitLabToken() {
    if (!this.isSignedIn) return null;
    const userId = this.session.user.id;
    const res = await this.authFetch(
      `${SUPABASE_URL}/rest/v1/gitlab_tokens?user_id=eq.${userId}&select=token,expires_at`
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows?.length) return null;
    const token = await this._decryptPAT(rows[0].token);
    return token ? { token, expires_at: rows[0].expires_at } : null;
  }

  async deleteGitLabToken() {
    if (!this.isSignedIn) return;
    const userId = this.session.user.id;
    await this.authFetch(
      `${SUPABASE_URL}/rest/v1/gitlab_tokens?user_id=eq.${userId}`,
      { method: 'DELETE' }
    );
  }

  async getTokenMode() {
    const record = await dbManager.get('settings', 'bmz_token_mode');
    return record?.value || 'local';
  }

  async setTokenMode(mode) {
    await dbManager.put('settings', { key: 'bmz_token_mode', value: mode });
  }

  async checkAndRotateIfNeeded(currentToken) {
    if (this._rotationPromptActive) return { needsRotation: false, currentToken };

    try {
      const cached = await dbManager.get('settings', 'bmz_token_expires');
      if (cached?.value) {
        const cachedDaysLeft = (new Date(cached.value) - Date.now()) / (1000 * 60 * 60 * 24);
        if (cachedDaysLeft > 30) return { needsRotation: false, currentToken };
      }

      const res = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self', {
        headers: { 'Authorization': `Bearer ${currentToken}` }
      });
      if (res.status === 401) return { needsRotation: false, currentToken };
      if (!res.ok) return { needsRotation: false, currentToken };

      const info = await res.json();
      if (!info.expires_at) return { needsRotation: false, currentToken };

      await dbManager.put('settings', { key: 'bmz_token_expires', value: info.expires_at });

      const daysLeft = (new Date(info.expires_at) - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysLeft > 30) return { needsRotation: false, currentToken };

      const snooze = await dbManager.get('settings', 'bmz_rotation_snooze');
      if (snooze?.value) {
        const snoozeAge = Date.now() - snooze.value;
        if (snoozeAge < 24 * 60 * 60 * 1000) return { needsRotation: false, currentToken };
      }

      this._rotationPromptActive = true;
      return { needsRotation: true, daysLeft, currentToken };
    } catch (e) {
      console.error('[TokenRotation] Failed:', e);
      return { needsRotation: false, currentToken };
    }
  }

  async rotateToken(currentToken) {
    try {
      const newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + 350);
      const newExpiryStr = newExpiry.toISOString().split('T')[0];

      const rotateRes = await fetch('https://gitlab.com/api/v4/personal_access_tokens/self/rotate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_at: newExpiryStr })
      });

      if (!rotateRes.ok) {
        if (rotateRes.status === 403) throw new Error('Token renewal failed: insufficient scopes. Your token needs the "api" scope.');
        if (rotateRes.status === 429) throw new Error('Token renewal failed: GitLab rate limit hit. It will be retried later.');
        throw new Error(`Token renewal failed (${rotateRes.status}). Please try again later.`);
      }

      const rotated = await rotateRes.json();
      await dbManager.put('settings', { key: 'bmz_token_expires', value: rotated.expires_at });
      await dbManager.delete('settings', 'bmz_rotation_snooze');
      this._rotationPromptActive = false;
      return rotated;
    } catch (e) {
      this._rotationPromptActive = false;
      throw e;
    }
  }

  async snoozeRotation() {
    await dbManager.put('settings', { key: 'bmz_rotation_snooze', value: Date.now() });
    this._rotationPromptActive = false;
  }
}

const supabaseManager = new SupabaseManager();
export default supabaseManager;
