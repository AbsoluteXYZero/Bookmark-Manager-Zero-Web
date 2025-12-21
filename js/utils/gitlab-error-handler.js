/**
 * GitLab Error Handler
 * Shared error popup utilities for GitLab API interactions
 */

class GitLabErrorHandler {
  /**
   * Show informational popup for GitLab authentication/permission errors
   */
  static showAuthErrorPopup(retryCallback, isPermissionError = false) {
    const existingPopup = document.getElementById('gitlab-auth-error-popup');
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'gitlab-auth-error-popup';
    popup.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--md-sys-color-surface, #ffffff);
      color: var(--md-sys-color-on-surface, #000000);
      border-radius: 12px;
      padding: 24px;
      max-width: 450px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      position: relative;
    `;

    if (isPermissionError) {
      dialog.innerHTML = `
        <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--md-sys-color-error, #d32f2f);">
          GitLab Permission Error
        </h2>
        <p style="margin: 0 0 16px 0; line-height: 1.5;">
          The token is valid, but GitLab denied access. This usually means insufficient permissions or scopes, or the account cannot access the resource.
        </p>
        <p style="margin: 0 0 20px 0; line-height: 1.5;">
          Ensure the token has "api" scope and the account has proper access.
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="gitlab-auth-cancel" style="
            background: var(--md-sys-color-surface-variant, #f5f5f5);
            color: var(--md-sys-color-on-surface-variant, #666666);
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
          ">Cancel</button>
          <button id="gitlab-auth-retry" style="
            background: var(--md-sys-color-primary, #1976d2);
            color: var(--md-sys-color-on-primary, #ffffff);
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          ">Retry</button>
        </div>
      `;
    } else {
      dialog.innerHTML = `
        <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--md-sys-color-error, #d32f2f);">
          GitLab Authentication Error
        </h2>
        <p style="margin: 0 0 16px 0; line-height: 1.5;">
          The PAT returned an authentication error from GitLab. The most likely cause of this is a typo, an expired token (Gitlab tokens expire every 12 months), or the token was created without the required "api" scope.
        </p>
        <p style="margin: 0 0 16px 0; line-height: 1.5;">
          If expired, create a new token with the "api" scope. If still active, you may edit it in GitLab to add the "api" scope, then retry.
        </p>
        <p style="margin: 0 0 20px 0; font-size: 14px; opacity: 0.8;">
          Account issues may also cause 401 (e.g., flagged or restricted account).
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="gitlab-auth-cancel" style="
            background: var(--md-sys-color-surface-variant, #f5f5f5);
            color: var(--md-sys-color-on-surface-variant, #666666);
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
          ">Cancel</button>
          <button id="gitlab-auth-retry" style="
            background: var(--md-sys-color-primary, #1976d2);
            color: var(--md-sys-color-on-primary, #ffffff);
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          ">Retry with New Token</button>
        </div>
      `;
    }

    popup.appendChild(dialog);
    document.body.appendChild(popup);

    dialog.querySelector('#gitlab-auth-cancel').addEventListener('click', () => {
      popup.remove();
    });

    dialog.querySelector('#gitlab-auth-retry').addEventListener('click', () => {
      popup.remove();
      if (retryCallback) {
        retryCallback();
      }
    });

    popup.addEventListener('click', (e) => {
      if (e.target === popup) {
        popup.remove();
      }
    });

    document.addEventListener('keydown', function closeOnEscape(e) {
      if (e.key === 'Escape') {
        popup.remove();
        document.removeEventListener('keydown', closeOnEscape);
      }
    });
  }

  /**
   * Show informational popup for GitLab service errors (5xx)
   */
  static showServiceErrorPopup(retryCallback) {
    const existingPopup = document.getElementById('gitlab-service-error-popup');
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'gitlab-service-error-popup';
    popup.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--md-sys-color-surface, #ffffff);
      color: var(--md-sys-color-on-surface, #000000);
      border-radius: 12px;
      padding: 24px;
      max-width: 450px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      position: relative;
    `;

    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--md-sys-color-error, #d32f2f);">
        GitLab Service Error
      </h2>
      <p style="margin: 0 0 16px 0; line-height: 1.5;">
        GitLab returned a server error. This indicates a temporary issue on GitLab's side, not a token problem.
      </p>
      <p style="margin: 0 0 20px 0; line-height: 1.5;">
        Try again later.
      </p>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="gitlab-service-error-cancel" style="
          background: var(--md-sys-color-surface-variant, #f5f5f5);
          color: var(--md-sys-color-on-surface-variant, #666666);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        ">Cancel</button>
        <button id="gitlab-service-error-retry" style="
          background: var(--md-sys-color-primary, #1976d2);
          color: var(--md-sys-color-on-primary, #ffffff);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        ">Retry</button>
      </div>
    `;

    popup.appendChild(dialog);
    document.body.appendChild(popup);

    dialog.querySelector('#gitlab-service-error-cancel').addEventListener('click', () => {
      popup.remove();
    });

    dialog.querySelector('#gitlab-service-error-retry').addEventListener('click', () => {
      popup.remove();
      setTimeout(() => {
        if (retryCallback) {
          retryCallback();
        }
      }, 2000);
    });

    popup.addEventListener('click', (e) => {
      if (e.target === popup) {
        popup.remove();
      }
    });

    document.addEventListener('keydown', function closeOnEscape(e) {
      if (e.key === 'Escape') {
        popup.remove();
        document.removeEventListener('keydown', closeOnEscape);
      }
    });
  }

  /**
   * Show informational popup for GitLab rate limiting
   */
  static showRateLimitPopup(retryCallback) {
    const existingPopup = document.getElementById('gitlab-rate-limit-popup');
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'gitlab-rate-limit-popup';
    popup.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--md-sys-color-surface, #ffffff);
      color: var(--md-sys-color-on-surface, #000000);
      border-radius: 12px;
      padding: 24px;
      max-width: 450px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      position: relative;
    `;

    dialog.innerHTML = `
      <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--md-sys-color-error, #d32f2f);">
        GitLab Rate Limit Reached
      </h2>
      <p style="margin: 0 0 16px 0; line-height: 1.5;">
        Too many requests were sent; GitLab temporarily blocked further requests.
      </p>
      <p style="margin: 0 0 20px 0; line-height: 1.5;">
        No token changes required. Wait and try again later.
      </p>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button id="gitlab-rate-limit-cancel" style="
          background: var(--md-sys-color-surface-variant, #f5f5f5);
          color: var(--md-sys-color-on-surface-variant, #666666);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        ">Cancel</button>
        <button id="gitlab-rate-limit-retry" style="
          background: var(--md-sys-color-primary, #1976d2);
          color: var(--md-sys-color-on-primary, #ffffff);
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        ">Retry</button>
      </div>
    `;

    popup.appendChild(dialog);
    document.body.appendChild(popup);

    dialog.querySelector('#gitlab-rate-limit-cancel').addEventListener('click', () => {
      popup.remove();
    });

    dialog.querySelector('#gitlab-rate-limit-retry').addEventListener('click', () => {
      popup.remove();
      setTimeout(() => {
        if (retryCallback) {
          retryCallback();
        }
      }, 2000);
    });

    popup.addEventListener('click', (e) => {
      if (e.target === popup) {
        popup.remove();
      }
    });

    document.addEventListener('keydown', function closeOnEscape(e) {
      if (e.key === 'Escape') {
        popup.remove();
        document.removeEventListener('keydown', closeOnEscape);
      }
    });
  }
}

export default GitLabErrorHandler;
