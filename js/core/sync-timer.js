/**
 * Sync Timer UI Controller
 * Manages the circular progress timer and sync enabled/disabled state
 */

import { safeLocalStorage } from '../utils/storage-utils.js';

class SyncTimer {
  constructor(syncManager) {
    this.syncManager = syncManager;
    this.timerBtn = document.getElementById('syncTimerBtn');
    this.progressCircle = document.getElementById('syncProgressCircle');
    this.countdownText = document.getElementById('syncCountdownText');
    this.disabledIcon = document.getElementById('syncDisabledIcon');
    this.disabledBanner = document.getElementById('syncDisabledBanner');
    this.enableSyncBtn = document.getElementById('enableSyncBtn');

    this.syncInterval = 60000; // 60 seconds
    this.updateInterval = 1000; // Update every second
    this.elapsedTime = 0;
    this.timerIntervalId = null;
    this.isEnabled = true;

    // Circle properties for animation
    this.circumference = 2 * Math.PI * 5; // radius is 5 (stroke-width 10 fills entire button)

    this.init();
  }

  init() {
    // Initialize circle dash properties
    this.progressCircle.style.strokeDasharray = this.circumference;
    this.progressCircle.style.strokeDashoffset = this.circumference;

    // Set up click handler for toggle button
    this.timerBtn.addEventListener('click', () => this.toggleSync());
    this.enableSyncBtn.addEventListener('click', () => this.enableSync());

    // Start the timer if sync is enabled
    if (this.syncManager && this.syncManager.autoSyncEnabled) {
      this.startTimer();
    }

    // Listen for sync events
    if (this.syncManager) {
      this.syncManager.on('syncStart', () => this.onSyncStart());
      this.syncManager.on('syncComplete', () => this.onSyncComplete());
      this.syncManager.on('syncError', () => this.onSyncError());
    }
  }

  /**
   * Start the countdown timer
   */
  startTimer() {
    if (this.timerIntervalId) {
      return; // Already running
    }

    this.elapsedTime = 0;
    this.updateProgress();

    this.timerIntervalId = setInterval(() => {
      this.elapsedTime += this.updateInterval;

      if (this.elapsedTime >= this.syncInterval) {
        // Reset when reaching 60s (sync should happen)
        this.elapsedTime = 0;
      }

      this.updateProgress();
    }, this.updateInterval);
  }

  /**
   * Stop the countdown timer
   */
  stopTimer() {
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }

    // Reset to empty
    this.elapsedTime = 0;
    this.updateProgress();
  }

  /**
   * Update the circular progress indicator
   */
  updateProgress() {
    const progress = this.elapsedTime / this.syncInterval;
    const offset = this.circumference - (progress * this.circumference);

    this.progressCircle.style.strokeDashoffset = offset;

    // Update countdown text
    const remainingSeconds = Math.ceil((this.syncInterval - this.elapsedTime) / 1000);

    if (this.countdownText) {
      this.countdownText.textContent = remainingSeconds;
    }

    // Update tooltip with static message
    this.timerBtn.title = this.isEnabled
      ? 'Time remaining until next bookmark sync'
      : 'Auto-sync disabled (Click to enable)';
  }

  /**
   * Toggle sync on/off
   */
  toggleSync() {
    if (this.isEnabled) {
      this.disableSync();
    } else {
      this.enableSync();
    }
  }

  /**
   * Disable auto-sync
   */
  disableSync() {
    this.isEnabled = false;
    this.stopTimer();

    // Stop sync manager auto-sync
    if (this.syncManager) {
      this.syncManager.stopAutoSync();
      this.syncManager.autoSyncEnabled = false;
      // Persist the setting
      safeLocalStorage.setItem('bmz_autoSyncEnabled', 'false');
    }

    // Show disabled state
    this.timerBtn.classList.add('disabled');
    this.disabledIcon.style.display = 'block';
    this.disabledBanner.style.display = 'flex';
    this.timerBtn.title = 'Auto-sync disabled (Click to enable)';

    console.log('Auto-sync disabled by user');
  }

  /**
   * Enable auto-sync
   */
  enableSync() {
    this.isEnabled = true;

    // Restart sync manager auto-sync
    if (this.syncManager) {
      this.syncManager.autoSyncEnabled = true;
      this.syncManager.startAutoSync();
      // Persist the setting
      safeLocalStorage.setItem('bmz_autoSyncEnabled', 'true');
    }

    // Hide disabled state
    this.timerBtn.classList.remove('disabled');
    this.disabledIcon.style.display = 'none';
    this.disabledBanner.style.display = 'none';

    // Restart timer
    this.startTimer();

    console.log('Auto-sync enabled by user');
  }

  /**
   * Handle sync start event
   */
  onSyncStart() {
    // Reset timer when sync starts
    this.elapsedTime = 0;
    this.updateProgress();
  }

  /**
   * Handle sync complete event
   */
  onSyncComplete() {
    // Timer will continue from current position
  }

  /**
   * Handle sync error event
   */
  onSyncError() {
    // Timer will continue from current position
  }

  /**
   * Restore sync state from localStorage
   */
  restoreState() {
    const savedState = safeLocalStorage.getItem('bmz_autoSyncEnabled');
    if (savedState === 'false') {
      this.disableSync();
    } else {
      // Default to enabled
      this.enableSync();
    }
  }
}

export default SyncTimer;
