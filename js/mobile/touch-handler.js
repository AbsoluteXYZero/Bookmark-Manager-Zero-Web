/**
 * Mobile Touch Handler
 * Handles touch gestures for mobile devices
 * Press-and-hold to enter move mode, drag to reorder
 */

class TouchHandler {
  constructor() {
    this.touchStartTime = 0;
    this.touchStartPos = { x: 0, y: 0 };
    this.pressTimer = null;
    this.isMoving = false;
    this.draggedElement = null;
    this.dragGhost = null;
    this.touchMoveThreshold = 10; // pixels
    this.pressHoldDuration = 500; // milliseconds
    this.currentDropTarget = null;

    // Pull-to-refresh state
    this.pullArmed = false;
    this.pullIndicator = null;
    this.pullThreshold = 80; // pixels to pull before refresh triggers
  }

  /**
   * Initialize touch handlers
   */
  init() {
    // Add touch event listeners to bookmark list
    document.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    document.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    document.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
    document.addEventListener('touchcancel', (e) => this.handleTouchCancel(e));
  }

  /**
   * Handle touch start
   */
  handleTouchStart(e) {
    // Ignore if already in move mode
    if (this.isMoving) return;

    // Get the touched element
    const touch = e.touches[0];

    // Arm pull-to-refresh if touch starts above the search box
    const searchContainer = document.querySelector('.search-container');
    if (searchContainer) {
      const searchTop = searchContainer.getBoundingClientRect().top;
      if (touch.clientY < searchTop) {
        this.pullArmed = true;
        this.touchStartPos = { x: touch.clientX, y: touch.clientY };
        return;
      }
    }

    let target = document.elementFromPoint(touch.clientX, touch.clientY);

    // Find the bookmark or folder element
    const bookmarkItem = target.closest('.bookmark-item, .folder-item');
    if (!bookmarkItem) return;

    // Ignore if touching menu button or preview image
    if (target.closest('.bookmark-menu-btn') || target.closest('.preview-image')) {
      return;
    }

    // Record touch start
    this.touchStartTime = Date.now();
    this.touchStartPos = { x: touch.clientX, y: touch.clientY };
    this.draggedElement = bookmarkItem;

    // Start press-and-hold timer
    this.pressTimer = setTimeout(() => {
      this.enterMoveMode(bookmarkItem, touch);
    }, this.pressHoldDuration);
  }

  /**
   * Handle touch move
   */
  handleTouchMove(e) {
    const touch = e.touches[0];

    // Handle pull-to-refresh
    if (this.pullArmed) {
      const pullDistance = touch.clientY - this.touchStartPos.y;
      if (pullDistance > 0) {
        e.preventDefault();
        this.updatePullIndicator(pullDistance);
      }
      return;
    }

    // If we have a press timer, check if user moved too much
    if (this.pressTimer && !this.isMoving) {
      const deltaX = Math.abs(touch.clientX - this.touchStartPos.x);
      const deltaY = Math.abs(touch.clientY - this.touchStartPos.y);

      // If moved beyond threshold, cancel press-and-hold
      if (deltaX > this.touchMoveThreshold || deltaY > this.touchMoveThreshold) {
        this.cancelPressTimer();
      }
    }

    // If in move mode, update drag ghost position
    if (this.isMoving && this.dragGhost) {
      e.preventDefault();

      this.dragGhost.style.left = `${touch.clientX - 50}px`;
      this.dragGhost.style.top = `${touch.clientY - 25}px`;

      // Find drop target
      const elementBelow = document.elementFromPoint(touch.clientX, touch.clientY);
      const dropTarget = elementBelow?.closest('.bookmark-item, .folder-item');

      if (dropTarget && dropTarget !== this.draggedElement) {
        this.updateDropIndicators(dropTarget, touch.clientY);
      } else {
        this.clearDropIndicators();
      }
    }
  }

  /**
   * Handle touch end
   */
  handleTouchEnd(e) {
    // Handle pull-to-refresh release
    if (this.pullArmed) {
      const touch = e.changedTouches[0];
      const pullDistance = touch.clientY - this.touchStartPos.y;
      this.clearPullIndicator();
      this.pullArmed = false;
      if (pullDistance >= this.pullThreshold) {
        location.reload();
      }
      return;
    }

    // Cancel press timer if active
    this.cancelPressTimer();

    // If in move mode, perform the drop
    if (this.isMoving) {
      e.preventDefault();
      this.performDrop();
      this.exitMoveMode();
    }

    // Reset state
    this.draggedElement = null;
  }

  /**
   * Handle touch cancel
   */
  handleTouchCancel() {
    if (this.pullArmed) {
      this.clearPullIndicator();
      this.pullArmed = false;
      return;
    }
    this.cancelPressTimer();
    if (this.isMoving) {
      this.exitMoveMode();
    }
    this.draggedElement = null;
  }

  /**
   * Enter move mode
   */
  enterMoveMode(element, touch) {
    this.isMoving = true;

    // Add move mode class to element
    element.classList.add('move-mode');

    // Haptic feedback (if available)
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }

    // Create drag ghost
    this.createDragGhost(element, touch);

    // Show toast
    this.showToast('Move mode active. Drag to reorder.');

    console.log('Entered move mode for:', element);
  }

  /**
   * Exit move mode
   */
  exitMoveMode() {
    this.isMoving = false;

    // Remove move mode class
    if (this.draggedElement) {
      this.draggedElement.classList.remove('move-mode');
    }

    // Remove drag ghost
    if (this.dragGhost) {
      this.dragGhost.remove();
      this.dragGhost = null;
    }

    // Clear drop indicators
    this.clearDropIndicators();

    // Hide toast
    this.hideToast();

    console.log('Exited move mode');
  }

  /**
   * Update pull-to-refresh indicator
   */
  updatePullIndicator(pullDistance) {
    if (!this.pullIndicator) {
      this.pullIndicator = document.createElement('div');
      this.pullIndicator.style.cssText = `
        position: fixed;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 16px;
        background: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary);
        border-radius: 0 0 12px 12px;
        font-size: 13px;
        font-weight: 500;
        pointer-events: none;
        z-index: 10000;
        transition: opacity 0.1s;
      `;
      document.body.appendChild(this.pullIndicator);
    }
    const ready = pullDistance >= this.pullThreshold;
    this.pullIndicator.textContent = ready ? '↓ Release to refresh' : '↓ Pull to refresh';
    this.pullIndicator.style.opacity = Math.min(pullDistance / this.pullThreshold, 1).toFixed(2);
  }

  /**
   * Remove pull-to-refresh indicator
   */
  clearPullIndicator() {
    if (this.pullIndicator) {
      this.pullIndicator.remove();
      this.pullIndicator = null;
    }
  }

  /**
   * Cancel press timer
   */
  cancelPressTimer() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  /**
   * Create drag ghost element
   */
  createDragGhost(element, touch) {
    this.dragGhost = document.createElement('div');
    this.dragGhost.className = 'drag-ghost';
    this.dragGhost.style.cssText = `
      position: fixed;
      left: ${touch.clientX - 50}px;
      top: ${touch.clientY - 25}px;
      width: 100px;
      height: 50px;
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.8;
      pointer-events: none;
      z-index: 10000;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;

    // Get title from element
    const titleEl = element.querySelector('.bookmark-title, .folder-title');
    const title = titleEl?.textContent || 'Item';
    this.dragGhost.textContent = title.length > 15 ? title.substring(0, 15) + '...' : title;

    document.body.appendChild(this.dragGhost);
  }

  /**
   * Update drop indicators
   */
  updateDropIndicators(dropTarget, touchY) {
    // Clear previous indicators
    this.clearDropIndicators();

    this.currentDropTarget = dropTarget;

    // Get drop target position
    const rect = dropTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;

    // Determine if dropping before, after, or into (for folders)
    const isFolder = dropTarget.classList.contains('folder-item');

    if (touchY < midpoint) {
      // Drop before
      dropTarget.classList.add('drop-before');
    } else if (isFolder && touchY > midpoint + 20) {
      // Drop into folder (if touching lower part)
      dropTarget.classList.add('drop-into');
    } else {
      // Drop after
      dropTarget.classList.add('drop-after');
    }
  }

  /**
   * Clear drop indicators
   */
  clearDropIndicators() {
    document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(el => {
      el.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
    this.currentDropTarget = null;
  }

  /**
   * Perform drop operation
   */
  performDrop() {
    if (!this.draggedElement || !this.currentDropTarget) {
      console.log('No valid drop target');
      return;
    }

    // Get bookmark IDs
    const draggedId = this.draggedElement.dataset.id;
    const targetId = this.currentDropTarget.dataset.id;

    if (!draggedId || !targetId || draggedId === targetId) {
      console.log('Invalid drop operation');
      return;
    }

    // Determine drop position
    let dropPosition = 'after';
    if (this.currentDropTarget.classList.contains('drop-before')) {
      dropPosition = 'before';
    } else if (this.currentDropTarget.classList.contains('drop-into')) {
      dropPosition = 'into';
    }

    console.log(`Drop ${draggedId} ${dropPosition} ${targetId}`);

    // Dispatch custom event for bookmark move
    const event = new CustomEvent('bookmark:move', {
      detail: {
        draggedId,
        targetId,
        position: dropPosition
      }
    });
    window.dispatchEvent(event);

    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate(30);
    }
  }

  /**
   * Show toast notification
   */
  showToast(message) {
    // Check if toast already exists
    let toast = document.querySelector('.touch-toast');

    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'touch-toast';
      toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 20px;
        background: var(--md-sys-color-surface-variant);
        color: var(--md-sys-color-on-surface-variant);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 9999;
        font-size: 14px;
        font-weight: 500;
      `;
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.display = 'block';
  }

  /**
   * Hide toast notification
   */
  hideToast() {
    const toast = document.querySelector('.touch-toast');
    if (toast) {
      toast.style.display = 'none';
    }
  }
}

// Export singleton instance
const touchHandler = new TouchHandler();
export default touchHandler;
