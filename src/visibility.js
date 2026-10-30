'use strict';

// Pure visibility rules for the notch windows, kept separate so they can be unit tested.

// Grace period after the last activity before an idle notch auto-hides; long enough for the
// "Done" flash and toast to be seen.
const IDLE_HIDE_DELAY_MS = 8000;

// A session counts as active (worth showing) unless it is muted or idle.
function isActive(session) {
  return !session.muted && session.status !== 'idle';
}

// Tracks when something was last active and decides whether "auto-hide when idle" applies.
class IdleTracker {
  constructor(now = Date.now(), delayMs = IDLE_HIDE_DELAY_MS) {
    // Start as if just active, so the notch is visible for a moment after launch.
    this.lastActiveAt = now;
    this.delayMs = delayMs;
  }

  // `busy`: something besides sessions is live in the notch (playing media, a running timer).
  update(sessions, now, busy = false) {
    if (busy || sessions.some(isActive)) this.lastActiveAt = now;
    return now - this.lastActiveAt >= this.delayMs;
  }
}

// Whether one notch window should be on screen.
// Pinning (hotkey / pin button) overrides every hiding rule; an in-progress hover keeps an
// idle-hidden notch from vanishing under the cursor.
function shouldShow({ pinned, userHidden, displayHidden, idleHidden, hovering }) {
  if (pinned) return true;
  if (userHidden || displayHidden) return false;
  if (idleHidden && !hovering) return false;
  return true;
}

// Collapsed pill shows only a status dot when compact mode is on and nothing needs attention.
// `busy`: the pill is showing something else live (media, timer).
function isDotOnly({ compact, top, toast, busy = false }) {
  if (!compact || toast || busy) return false;
  if (!top || top.muted) return true;
  return top.status === 'idle';
}

const api = { IdleTracker, shouldShow, isDotOnly, isActive, IDLE_HIDE_DELAY_MS };
// Shared by the main process (require) and the sandboxed notch renderer (<script>).
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NotchVisibility = api;
