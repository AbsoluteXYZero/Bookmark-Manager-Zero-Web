/**
 * Error Notification Manager
 * Handles error toasts and logging for the application
 */

import { safeLocalStorage, addChangelogEntry } from './storage-utils.js';

const MAX_ERROR_LOGS = 50;

/* [ZeroLabs] 2026-09-08 6:50 AM - added: errors land in the changelog you can actually read */
// errorLogs in localStorage already held the message, the stack and the context,
// but reading it needs a console, and on the Fold 5 in the APK there is not one.
// The changelog is the only log surface reachable on the device, so errors go
// there too. They render as their own type with no Restore button, since there is
// nothing to restore.
//
// Throttled by message: a failing sync or a scan loop can raise the same rejection
// dozens of times a minute, and without this it would push every real bookmark
// change out of a 1000-entry list.
const ERROR_REPEAT_WINDOW_MS = 30000;
const recentErrorTimes = new Map();

function shouldRecordError(message) {
  const now = Date.now();

  // Drop anything that aged out, so the map cannot grow without bound.
  for (const [key, at] of recentErrorTimes) {
    if (now - at > ERROR_REPEAT_WINDOW_MS) recentErrorTimes.delete(key);
  }

  if (recentErrorTimes.has(message)) return false;
  recentErrorTimes.set(message, now);
  return true;
}

let errorToast;
let errorTitle;
let errorMessage;
let errorReload;
let errorDismiss;

/**
 * Initialize error toast DOM elements
 */
function initErrorToast() {
  errorToast = document.getElementById('errorToast');
  errorTitle = document.getElementById('errorTitle');
  errorMessage = document.getElementById('errorMessage');
  errorReload = document.getElementById('errorReload');
  errorDismiss = document.getElementById('errorDismiss');

  if (errorReload) {
    errorReload.addEventListener('click', () => {
      location.reload();
    });
  }

  if (errorDismiss) {
    errorDismiss.addEventListener('click', () => {
      hideErrorToast();
    });
  }
}

/**
 * Show error toast notification
 */
function showErrorToast(title, message) {
  if (!errorToast) return;

  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorToast.classList.remove('hidden');

  // Auto-hide after 10 seconds
  setTimeout(() => {
    hideErrorToast();
  }, 10000);
}

/**
 * Hide error toast
 */
function hideErrorToast() {
  if (errorToast) {
    errorToast.classList.add('hidden');
  }
}

/**
 * Log error to browser storage
 */
async function logError(error, context = '') {
  try {
    const errorLog = {
      timestamp: Date.now(),
      message: error.message || String(error),
      stack: error.stack || '',
      context: context,
      userAgent: navigator.userAgent,
      url: window.location.href
    };

    // Get existing error logs
    const errorLogsStr = safeLocalStorage.getItem('errorLogs');
    let errorLogs = errorLogsStr ? JSON.parse(errorLogsStr) : [];

    // Add new error
    errorLogs.unshift(errorLog);

    // Keep only last 50 errors
    if (errorLogs.length > MAX_ERROR_LOGS) {
      errorLogs = errorLogs.slice(0, MAX_ERROR_LOGS);
    }

    // Save to storage
    safeLocalStorage.setItem('errorLogs', JSON.stringify(errorLogs));
    console.error(`[Error Logged] ${context}:`, error);

    /* [ZeroLabs] 2026-09-08 6:50 AM - added: mirror it into the changelog */
    // Deliberately after the localStorage write, so a failure here can never cost
    // the error record itself. The first stack frame is carried in details, which
    // is the line that actually identifies where it came from.
    if (shouldRecordError(errorLog.message)) {
      const firstFrame = (errorLog.stack || '')
        .split('\n')
        .map(line => line.trim())
        .find(line => line.startsWith('at ') || line.includes('@')) || '';

      await addChangelogEntry(
        'error',
        'error',
        errorLog.message || 'Unknown error',
        null,
        { context: context || 'Error', frame: firstFrame }
      );
    }
  } catch (storageError) {
    console.error('Failed to log error to storage:', storageError);
  }
}

/**
 * Setup global error handlers
 */
function setupGlobalErrorHandlers() {
  // Global error handler for synchronous errors
  window.addEventListener('error', async (event) => {
    const error = event.error || new Error(event.message);
    console.error('Global error caught:', error);

    await logError(error, 'Global Error');
    showErrorToast(
      'Unexpected Error',
      error.message || 'An unexpected error occurred. The extension will continue to work, but some features may not function correctly.'
    );

    event.preventDefault();
  });

  // Global handler for unhandled promise rejections
  window.addEventListener('unhandledrejection', async (event) => {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    console.error('Unhandled promise rejection:', error);

    await logError(error, 'Unhandled Promise Rejection');
    showErrorToast(
      'Promise Error',
      error.message || 'An operation failed unexpectedly. Please try again.'
    );

    event.preventDefault();
  });
}

export {
  initErrorToast,
  showErrorToast,
  hideErrorToast,
  logError,
  setupGlobalErrorHandlers
};
