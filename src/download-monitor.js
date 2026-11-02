'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { FolderTracker, DownloadHub, parseReport, parseTempName } = require('./downloads');

// The browser extension tries these in order (keep in sync with src/browser-extension/background.js).
const BRIDGE_PORTS = [47615, 47616, 47617];
const BRIDGE_PREFIX = '/notch-picker/';
const MAX_BODY = 64 * 1024;
const ACTIVE_SCAN_MS = 1000;
const IDLE_SCAN_MS = 4000;
const EXTENSION_ORIGIN_RE = /^(chrome-extension|moz-extension|extension|safari-web-extension):\/\/[\w.-]+$/i;

// Local endpoint for the companion browser extension. Only extensions can use it: web pages
// can't send the X-Notch-Picker header without a CORS preflight, and preflights are only
// answered for extension origins. The Host check stops DNS-rebinding pages.
class DownloadBridge {
  constructor({ onReport, log = () => {} }) {
    this.onReport = onReport;
    this.log = log;
    this.server = null;
    this.port = 0;
  }

  async start() {
    for (const port of BRIDGE_PORTS) {
      try {
        await this.listen(port);
        this.port = port;
        return port;
      } catch (e) {
        this.log(`Download bridge: port ${port} unavailable (${e.code || e.message})`);
      }
    }
    this.log('Download bridge: no port available; the browser extension cannot connect');
    return 0;
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', (e) => this.log(`Download bridge error: ${e.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
    this.port = 0;
  }

  handle(req, res) {
    const origin = req.headers.origin;
    const fromExtension = !!origin && EXTENSION_ORIGIN_RE.test(origin);
    const reply = (status, body) => {
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (fromExtension) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      res.writeHead(status, headers);
      res.end(body ? JSON.stringify(body) : '');
    };
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reply(403);
    if (origin && !fromExtension) return reply(403);
    if (!req.url || !req.url.startsWith(BRIDGE_PREFIX)) return reply(404);
    if (req.method === 'OPTIONS') {
      if (!fromExtension) return reply(403);
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-Notch-Picker',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return res.end();
    }
    if (req.headers['x-notch-picker'] !== '1') return reply(403);
    if (req.method !== 'POST' || req.url !== `${BRIDGE_PREFIX}report`) return reply(404);
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      if (size > MAX_BODY) return;
      size += c.length;
      if (size > MAX_BODY) {
        reply(413);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400);
      }
      const report = parseReport(body);
      if (!report) return reply(400);
      const commands = this.onReport(report) || [];
      reply(200, { app: 'notch-picker', v: 1, commands });
    });
  }
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

// Watches the download folders and runs the extension bridge. Emits 'change' with the list for
// the notch and 'finished' ({ key, name, path, browser, ok, error }) when a download completes or fails.
class DownloadMonitor extends EventEmitter {
  constructor({ log = () => {}, now = Date.now } = {}) {
    super();
    this.log = log;
    this.now = now;
    this.tracker = new FolderTracker();
    this.hub = new DownloadHub();
    this.bridge = new DownloadBridge({ onReport: (r) => this.onReport(r), log });
    this.folders = [];
    this.watchers = new Map(); // folder key -> fs.FSWatcher
    this.timer = null;
    this.scanSoon = null;
    this.running = false;
    this.bridgeStarting = null;
    this.last = '[]';
  }

  get state() {
    return this.hub.list(this.now(), this.tracker.list(this.now()));
  }

  status() {
    return { port: this.bridge.port, browsers: this.hub.browsers(), folders: [...this.folders] };
  }

  async start(folders) {
    this.setFolders(folders);
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    if (!this.bridgeStarting) this.bridgeStarting = this.bridge.server ? Promise.resolve() : this.bridge.start();
    await this.bridgeStarting;
    this.bridgeStarting = null;
    if (!this.running) this.bridge.stop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.scanSoon);
    this.timer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.bridge.stop();
    this.tracker = new FolderTracker();
    this.hub = new DownloadHub();
    this.emitChange();
  }

  setFolders(folders) {
    const seen = new Set();
    this.folders = (folders || []).filter((f) => {
      const k = f.toLowerCase();
      if (!f || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    for (const [k, w] of this.watchers) {
      if (!seen.has(k)) {
        w.close();
        this.watchers.delete(k);
      }
    }
    if (this.running) this.schedule(0);
  }

  // fs.watch reports in-progress files as they appear, so the scan runs right away. Folders that
  // don't exist yet (or a watcher that failed) are retried on each scan.
  ensureWatchers() {
    for (const folder of this.folders) {
      const k = folder.toLowerCase();
      if (this.watchers.has(k)) continue;
      try {
        const w = fs.watch(folder, { persistent: false }, (_type, name) => {
          if (!name || !parseTempName(String(name))) return;
          this.tracker.note(path.join(folder, String(name)), this.now());
          clearTimeout(this.scanSoon);
          this.scanSoon = setTimeout(() => this.schedule(0), 150);
        });
        w.on('error', () => {
          w.close();
          this.watchers.delete(k);
        });
        this.watchers.set(k, w);
      } catch {
        // missing or unreadable folder: try again later
      }
    }
  }

  schedule(ms) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.scan(), ms);
  }

  scan() {
    this.timer = null;
    if (!this.running) return;
    this.ensureWatchers();
    const entries = [];
    for (const folder of this.folders) {
      let names;
      try {
        names = fs.readdirSync(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of names) {
        if (!d.isFile() || !parseTempName(d.name)) continue;
        const p = path.join(folder, d.name);
        try {
          const st = fs.statSync(p);
          entries.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // finished or removed since readdir
        }
      }
    }
    const now = this.now();
    for (const f of this.tracker.update(entries, now, sizeOf)) {
      const ev = this.hub.finish({ ...f, ok: true }, now);
      if (ev) this.emit('finished', ev);
    }
    this.emitChange();
    const busy = this.hub.hasActive(this.tracker.list(now)) || this.hub.recent.length > 0;
    this.schedule(busy ? ACTIVE_SCAN_MS : IDLE_SCAN_MS);
  }

  onReport(report) {
    if (!this.running) return [];
    for (const ev of this.hub.report(report, this.now())) this.emit('finished', ev);
    this.emitChange();
    if (!this.timer) this.schedule(ACTIVE_SCAN_MS);
    return this.hub.takeCommands(report.source);
  }

  emitChange() {
    const state = this.state;
    const json = JSON.stringify(state);
    if (json === this.last) return;
    this.last = json;
    this.emit('change', state);
  }

  find(key) {
    return this.state.find((d) => d.key === key) || null;
  }

  command(key, action) {
    return this.hub.command(key, action);
  }

  dismiss(key) {
    if (this.hub.dismiss(key)) this.emitChange();
  }
}

module.exports = { DownloadMonitor, DownloadBridge, BRIDGE_PORTS };
