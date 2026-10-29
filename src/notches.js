'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { SIZE_ZOOM } = require('./settings');
const { shouldShow } = require('./visibility');

const WIN_WIDTH = 400;
const WIN_HEIGHT = 350;
const EDGE_MARGIN = 12;

// Owns the notch windows: one on the primary display, one that follows the cursor's display,
// or one per display. Handles placement, hover hit-testing and full-screen hiding.
class NotchManager {
  constructor({ webPreferences, getSettings, onWindowCreated = () => {} }) {
    this.webPreferences = webPreferences;
    this.getSettings = getSettings;
    this.onWindowCreated = onWindowCreated;
    this.notches = new Map(); // slot -> { slot, win, displayId, hoverRect, hovering, ready }
    this.userHidden = false;
    this.hiddenDisplays = new Set();
    this.idleHidden = false;
    this.pinned = false;
  }

  setIdleHidden(hidden) {
    if (hidden === this.idleHidden) return;
    this.idleHidden = hidden;
    this.applyVisibility();
  }

  setPinned(pinned) {
    if (pinned === this.pinned) return;
    this.pinned = pinned;
    this.broadcast('notch:pinned', pinned);
    this.applyVisibility();
  }

  windows() {
    return [...this.notches.values()].map((n) => n.win).filter((w) => w && !w.isDestroyed());
  }

  notchFor(webContents) {
    return [...this.notches.values()].find((n) => !n.win.isDestroyed() && n.win.webContents === webContents) || null;
  }

  // The window that plays sounds and anchors menus: prefer a visible one on the primary display.
  primaryWindow() {
    const primary = screen.getPrimaryDisplay().id;
    const visible = [...this.notches.values()].filter((n) => !n.win.isDestroyed() && n.win.isVisible());
    const n = visible.find((x) => x.displayId === primary) || visible[0] || [...this.notches.values()][0];
    return n && !n.win.isDestroyed() ? n.win : null;
  }

  broadcast(channel, payload) {
    for (const w of this.windows()) w.webContents.send(channel, payload);
  }

  // Screen rectangle of the pill on the primary visible notch (where the desktop cat hangs), or
  // null when no notch is on screen.
  perchRect() {
    const w = this.primaryWindow();
    const n = w && this.notchFor(w.webContents);
    if (!n || !n.hoverRect || !w.isVisible()) return null;
    const b = w.getBounds();
    const r = n.hoverRect;
    return { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height };
  }

  desiredSlots() {
    const mode = this.getSettings().display;
    if (mode === 'all') return new Map(screen.getAllDisplays().map((d) => [`display-${d.id}`, d]));
    const display = mode === 'cursor' ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : screen.getPrimaryDisplay();
    return new Map([['main', display]]);
  }

  sync() {
    const wanted = this.desiredSlots();
    // Create/move wanted notches before destroying old ones so the app never has zero windows.
    for (const [slot, display] of wanted) {
      let n = this.notches.get(slot);
      if (!n) {
        n = this.create(slot);
        this.notches.set(slot, n);
      }
      n.displayId = display.id;
      if (!n.dragging) this.place(n, display);
    }
    for (const [slot, n] of this.notches) {
      if (wanted.has(slot)) continue;
      this.notches.delete(slot);
      if (!n.win.isDestroyed()) n.win.destroy();
    }
    this.applyVisibility();
  }

  // In "cursor" mode, move the notch when the cursor reaches another display (never mid-hover).
  followCursor() {
    if (this.getSettings().display !== 'cursor') return;
    const n = this.notches.get('main');
    if (!n || n.hovering || n.dragging) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (display.id !== n.displayId) this.sync();
  }

  create(slot) {
    const { hideFromScreenCapture } = this.getSettings();
    const win = new BrowserWindow({
      width: WIN_WIDTH,
      height: WIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      title: 'Notch Picker',
      webPreferences: { ...this.webPreferences, autoplayPolicy: 'no-user-gesture-required' },
    });
    const n = { slot, win, displayId: null, hoverRect: null, hovering: false, ready: false };
    win.setAlwaysOnTop(true, 'screen-saver');
    // macOS: stay visible on every Space, including over full-screen apps' Spaces.
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(hideFromScreenCapture);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.once('ready-to-show', () => {
      n.ready = true;
      this.applyVisibility();
    });
    win.on('closed', () => {
      if (this.notches.get(slot) === n) this.notches.delete(slot);
    });
    this.onWindowCreated(win);
    return n;
  }

  place(n, display) {
    const zoom = this.zoom();
    const width = Math.round(WIN_WIDTH * zoom);
    const height = Math.round(WIN_HEIGHT * zoom);
    const { offsetX } = this.getSettings();
    const x = this.clampX(display, width, this.anchorX(display, width) + offsetX);
    const bounds = { x, y: display.bounds.y, width, height };
    n.win.setBounds(bounds);
    // Moving across monitors with different scaling can apply the old scale factor once.
    n.win.setBounds(bounds);
  }

  // Window x for the chosen position before any drag offset. With left/right the pill is
  // aligned to that edge of its window (see body[data-align]) and sits a small margin in.
  anchorX(display, width) {
    const b = display.bounds;
    const margin = Math.round(EDGE_MARGIN * this.zoom());
    switch (this.getSettings().position) {
      case 'left':
        return b.x + margin;
      case 'right':
        return b.x + b.width - width - margin;
      default:
        return Math.round(b.x + (b.width - width) / 2);
    }
  }

  clampX(display, width, x) {
    const b = display.bounds;
    return Math.round(Math.min(Math.max(x, b.x), b.x + b.width - width));
  }

  // Horizontal drag of a notch; on release the new spot is saved as an offset from the anchor.
  // The delta comes from the real cursor position: renderer screenX drifts while its own
  // window is being moved.
  dragStart(n) {
    n.dragging = true;
    n.dragStartX = n.win.getBounds().x;
    n.dragCursorX = screen.getCursorScreenPoint().x;
  }

  dragMove(n) {
    if (!n.dragging) return null;
    const display = screen.getAllDisplays().find((d) => d.id === n.displayId) || screen.getPrimaryDisplay();
    const width = Math.round(WIN_WIDTH * this.zoom());
    const height = Math.round(WIN_HEIGHT * this.zoom());
    const dx = screen.getCursorScreenPoint().x - n.dragCursorX;
    const x = this.clampX(display, width, n.dragStartX + dx);
    n.win.setBounds({ x, y: display.bounds.y, width, height });
    return { x, width, display };
  }

  // Returns the new offset to persist, or null if the pill did not move. Computed from the
  // intended position: getBounds() can be off by a few pixels after scaling on high-DPI screens.
  dragEnd(n) {
    if (!n.dragging) return null;
    const { x, width, display } = this.dragMove(n);
    n.dragging = false;
    if (x === n.dragStartX) return null;
    return x - this.anchorX(display, width);
  }

  zoom() {
    return SIZE_ZOOM[this.getSettings().size] || 1;
  }

  applySettings(values) {
    for (const w of this.windows()) w.setContentProtection(values.hideFromScreenCapture);
    this.sync();
  }

  setUserHidden(hidden) {
    this.userHidden = hidden;
    this.applyVisibility();
  }

  setHiddenDisplays(ids) {
    this.hiddenDisplays = ids;
    this.applyVisibility();
  }

  isShown() {
    return !this.userHidden;
  }

  applyVisibility() {
    for (const n of this.notches.values()) {
      if (!n.ready || n.win.isDestroyed()) continue;
      const show = shouldShow({
        pinned: this.pinned,
        userHidden: this.userHidden,
        displayHidden: this.hiddenDisplays.has(n.displayId),
        idleHidden: this.idleHidden,
        hovering: n.hovering,
      });
      if (show && !n.win.isVisible()) {
        n.win.showInactive();
        n.win.setAlwaysOnTop(true, 'screen-saver');
      } else if (!show && n.win.isVisible()) {
        n.win.hide();
        if (n.hovering) {
          n.hovering = false;
          n.win.setIgnoreMouseEvents(true);
          n.win.webContents.send('notch:hover', false);
        }
      }
    }
  }

  // Forwarded mouse events are unreliable for click-through windows on Windows, so hover is
  // detected by polling the cursor against the pill bounds each renderer reports.
  pollHover() {
    const p = screen.getCursorScreenPoint();
    for (const n of this.notches.values()) {
      if (n.win.isDestroyed() || !n.win.isVisible() || !n.hoverRect || n.dragging) continue;
      const b = n.win.getBounds();
      const x = p.x - b.x;
      const y = p.y - b.y;
      const r = n.hoverRect;
      const inside = x >= r.x && x <= r.x + r.width && y >= 0 && y <= r.y + r.height;
      if (inside === n.hovering) continue;
      n.hovering = inside;
      n.win.setIgnoreMouseEvents(!inside);
      n.win.webContents.send('notch:hover', inside);
      // An idle-hidden notch stayed up only because it was hovered.
      if (!inside && this.idleHidden) this.applyVisibility();
    }
  }

  reassertTopmost() {
    for (const w of this.windows()) if (w.isVisible()) w.setAlwaysOnTop(true, 'screen-saver');
  }
}

module.exports = { NotchManager };
