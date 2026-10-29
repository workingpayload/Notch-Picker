'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'fullscreen-monitor.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MAX_QUICK_RESTARTS = 5;

// SHQueryUserNotificationState values.
const QUNS = { BUSY: 2, D3D_FULLSCREEN: 3, PRESENTATION: 4, ACCEPTS: 5, QUIET_TIME: 6 };

function parseLine(line) {
  try {
    const v = JSON.parse(line);
    if (Array.isArray(v.windows)) return { windows: parseWindows(v.windows) };
    const r = v.fullscreen;
    const rect = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    return {
      quns: Number.isFinite(v.quns) ? v.quns : 0,
      fullscreen: rect,
      foreground: Number.isSafeInteger(v.fg) && v.fg > 0 ? v.fg : 0,
    };
  } catch {
    return null;
  }
}

// [[hwnd, left, top, right, bottom, cover], ...] (topmost first, physical pixels) ->
// [{ id, x, y, width, height, cover }]; cover: a maximized window, which hides windows behind it.
function parseWindows(list) {
  return list
    .filter((w) => Array.isArray(w) && w.length >= 5 && w.every(Number.isFinite) && w[3] > w[1] && w[4] > w[2])
    .map(([id, l, t, r, b, cover]) => ({ id, x: l, y: t, width: r - l, height: b - t, cover: cover === 1 }));
}

// Presentation mode and Focus Assist / quiet hours mean "don't make noise".
function isQuiet(state) {
  return state.quns === QUNS.PRESENTATION || state.quns === QUNS.QUIET_TIME;
}

// Runs fullscreen-monitor.ps1 and emits 'change' with { quns, fullscreen } (fullscreen = physical
// monitor rect), and, while window tracking is on, 'windows' with the visible app windows.
class FullscreenMonitor extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.state = { quns: 0, fullscreen: null, foreground: 0 };
    this.child = null;
    this.stopped = true;
    this.quickRestarts = 0;
    this.restartTimer = null;
    this.trackWindows = false;
  }

  start() {
    if (process.platform !== 'win32' || this.child) return;
    this.stopped = false;
    const startedAt = Date.now();
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(process.pid)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.child = child;
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const next = parseLine(line);
      if (!next) return;
      if (next.windows) {
        this.emit('windows', next.windows);
        return;
      }
      this.state = next;
      this.emit('change', next);
    });
    if (this.trackWindows) child.stdin.write('windows on\n');
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-500)));
    child.on('error', (e) => this.log(`Full-screen monitor failed to start: ${e.message}`));
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.quickRestarts = Date.now() - startedAt < 30000 ? this.quickRestarts + 1 : 0;
      if (this.quickRestarts > MAX_QUICK_RESTARTS) {
        this.log(`Full-screen monitor keeps exiting (code ${code}); giving up. ${stderr.trim()}`);
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), 3000);
    });
  }

  // Asks the helper to bring a window (by HWND) back to the foreground.
  focusWindow(hwnd) {
    if (!this.child || !Number.isSafeInteger(hwnd) || hwnd <= 0) return false;
    this.child.stdin.write(`focus ${hwnd}\n`);
    return true;
  }

  // Turns reporting of the visible app windows on or off (desktop pets walk on them).
  setWindowTracking(on) {
    if (on === this.trackWindows) return;
    this.trackWindows = on;
    if (this.child) this.child.stdin.write(on ? 'windows on\n' : 'windows off\n');
    if (!on) this.emit('windows', []);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.child) this.child.kill();
    this.child = null;
  }
}

module.exports = { FullscreenMonitor, parseLine, parseWindows, isQuiet, QUNS };
