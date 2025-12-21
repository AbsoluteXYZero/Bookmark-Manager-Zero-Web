/**
 * Error Notification Manager
 * Handles error toasts and logging for the application
 */

const MAX_ERROR_LOGS = 50;

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
    const errorLogsStr = localStorage.getItem('errorLogs');
    let errorLogs = errorLogsStr ? JSON.parse(errorLogsStr) : [];

    // Add new error
    errorLogs.unshift(errorLog);

    // Keep only last 50 errors
    if (errorLogs.length > MAX_ERROR_LOGS) {
      errorLogs = errorLogs.slice(0, MAX_ERROR_LOGS);
    }

    // Save to storage
    localStorage.setItem('errorLogs', JSON.stringify(errorLogs));
    console.error(`[Error Logged] ${context}:`, error);
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
