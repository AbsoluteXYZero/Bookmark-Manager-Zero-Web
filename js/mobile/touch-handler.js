/**
 * Mobile Touch Handler
 * Pull-to-refresh for mobile devices.
 */

/* [ZeroLabs] 2026-09-23 1:05 PM - edited: the drag half of this file is gone */
// This class used to carry its OWN press-and-hold drag: a 500 ms timer, its own
// ghost, its own drop indicators, and a `bookmark:move` event that app.js
// answered with handleTouchMove. The drag engine in sidebar-adapted.js
// (bmzDrag) now owns every drag, from a mouse, a pen or a finger, and it goes
// through the same handleDrop the desktop uses. So it knows about the root drop
// zone, Quick Access pins, dropping INTO a folder and the sync that follows -
// none of which this handler ever did.
//
// Two press-and-hold timers on one gesture would have produced two ghosts, two
// sets of drop indicators and two moves. The drag code is deleted rather than
// disabled, so it cannot come back by accident.
//
// Pull-to-refresh is untouched and still lives here.
//
// `app.js` still listens for `bookmark:move`. Nothing dispatches it any more,
// so that listener and `handleTouchMove` are inert.
class TouchHandler {
  constructor() {
    // Pull-to-refresh state
    this.touchStartPos = { x: 0, y: 0 };
    this.pullArmed = false;
    this.pullIndicator = null;
    this.pullThreshold = 80; // pixels to pull before refresh triggers
  }

  /**
   * Initialize touch handlers
   */
  init() {
    /* [ZeroLabs] 2026-09-23 1:40 PM - edited: pull-to-refresh is switched off */
    // Commented out, not deleted, while the touch drag is on trial. This
    // handler owns a non-passive touchmove of its own and reloads the page on
    // release, so it is the first thing to rule out if a drag behaves oddly
    // near the top of the screen. Put these four lines back to restore it.
    //
    // document.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    // document.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    // document.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
    // document.addEventListener('touchcancel', () => this.handleTouchCancel());
  }

  /**
   * Handle touch start - arm the pull if the touch began above the search box
   */
  handleTouchStart(e) {
    const touch = e.touches[0];
    if (!touch) return;

    const searchContainer = document.querySelector('.search-container');
    if (!searchContainer) return;

    const searchTop = searchContainer.getBoundingClientRect().top;
    if (touch.clientY < searchTop) {
      this.pullArmed = true;
      this.touchStartPos = { x: touch.clientX, y: touch.clientY };
    }
  }

  /**
   * Handle touch move
   */
  handleTouchMove(e) {
    if (!this.pullArmed) return;

    const touch = e.touches[0];
    if (!touch) return;

    const pullDistance = touch.clientY - this.touchStartPos.y;
    if (pullDistance > 0) {
      e.preventDefault();
      this.updatePullIndicator(pullDistance);
    }
  }

  /**
   * Handle touch end
   */
  handleTouchEnd(e) {
    if (!this.pullArmed) return;

    const touch = e.changedTouches[0];
    const pullDistance = touch ? touch.clientY - this.touchStartPos.y : 0;

    this.clearPullIndicator();
    this.pullArmed = false;

    if (pullDistance >= this.pullThreshold) {
      location.reload();
    }
  }

  /**
   * Handle touch cancel
   */
  handleTouchCancel() {
    if (!this.pullArmed) return;
    this.clearPullIndicator();
    this.pullArmed = false;
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
}

// Export singleton instance
const touchHandler = new TouchHandler();
export default touchHandler;
