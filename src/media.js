'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { prettyAppName } = require('./island');

const SCRIPT = path.join(__dirname, 'media-monitor.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MAX_QUICK_RESTARTS = 5;
const STATUSES = new Set(['playing', 'paused', 'changing', 'stopped']);
const ART_RE = /^data:image\/(png|jpeg|jpg|gif|bmp|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_ART = 600000;
const COMMANDS = { toggle: 'toggle', next: 'next', previous: 'prev' };

function text(v, max = 200) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function ms(v) {
  return Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 864e5 * 7) : 0;
}

// One line from media-monitor.ps1 -> { unsupported } | { media, art? } (media: null or sanitised),
// or null for anything malformed.
function parseMediaLine(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  if (v.unsupported === true) return { unsupported: true };
  if (!('media' in v)) return null;
  const out = { media: null };
  const m = v.media;
  if (m && typeof m === 'object') {
    const status = STATUSES.has(m.status) ? m.status : 'stopped';
    out.media = {
      appId: text(m.app, 300),
      app: prettyAppName(text(m.app, 300)),
      title: text(m.title),
      artist: text(m.artist),
      album: text(m.album),
      status,
      positionMs: ms(m.pos),
      durationMs: ms(m.dur),
      updatedAt: Number.isFinite(m.at) && m.at > 0 ? m.at : 0,
      canPrevious: m.prev === true,
      canNext: m.next === true,
      canToggle: m.toggle !== false,
    };
  }
  if ('art' in v) out.art = typeof v.art === 'string' && v.art.length <= MAX_ART && ART_RE.test(v.art) ? v.art : null;
  return out;
}

// Runs media-monitor.ps1 (Windows) and emits 'change' with the current media
// ({ app, title, artist, album, status, positionMs, durationMs, updatedAt, art, can* }) or null.
class MediaMonitor extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.media = null;
    this.art = null;
    this.child = null;
    this.stopped = true;
    this.unsupported = false;
    this.quickRestarts = 0;
    this.restartTimer = null;
  }

  get supported() {
    return process.platform === 'win32' && !this.unsupported;
  }

  get state() {
    if (!this.media || this.media.status === 'stopped' || (!this.media.title && !this.media.artist)) return null;
    return { ...this.media, art: this.art };
  }

  start() {
    if (!this.supported || this.child) return;
    this.stopped = false;
    const startedAt = Date.now();
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(process.pid)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.child = child;
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-500)));
    child.on('error', (e) => this.log(`Media monitor failed to start: ${e.message}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped || this.unsupported) return;
      this.quickRestarts = Date.now() - startedAt < 30000 ? this.quickRestarts + 1 : 0;
      if (this.quickRestarts > MAX_QUICK_RESTARTS) {
        this.log(`Media monitor keeps exiting (code ${code}); giving up. ${stderr.trim()}`);
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), 3000);
    });
  }

  onLine(line) {
    const next = parseMediaLine(line);
    if (!next) return;
    if (next.unsupported) {
      this.unsupported = true;
      this.log('Media controls are not supported on this Windows version');
      this.set(null, null);
      return;
    }
    this.set(next.media, 'art' in next ? next.art : this.art);
  }

  set(media, art) {
    const before = JSON.stringify(this.state);
    this.media = media;
    this.art = media ? art : null;
    const after = this.state;
    if (JSON.stringify(after) !== before) this.emit('change', after);
  }

  // 'toggle' | 'next' | 'previous'
  command(name) {
    const cmd = COMMANDS[name];
    if (!cmd || !this.child) return false;
    this.child.stdin.write(`${cmd}\n`);
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.child) this.child.kill();
    this.child = null;
    this.set(null, null);
  }
}

module.exports = { MediaMonitor, parseMediaLine };
