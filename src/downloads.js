'use strict';

// Browser download progress, from two sources merged into one list for the notch:
//  - folder watching (no setup): browsers write an in-progress file next to the final one
//    ("x.zip.crdownload" in Chrome/Edge/Brave/Opera/Vivaldi, "x.zip.part" in Firefox) and rename it
//    when done. That gives the name, bytes so far, speed and completion, but not the total size.
//  - the optional companion browser extension (src/browser-extension), which reports exact
//    progress over the local bridge and carries out pause / resume / cancel from the notch.
// Everything here is pure (no I/O) so it can be unit tested; download-monitor.js does the I/O.

const path = require('path');

const TEMP_SUFFIXES = ['.crdownload', '.part', '.partial', '.opdownload'];
// Chromium's name while it is still deciding where the file goes (e.g. the Save As dialog is open).
const UNCONFIRMED_RE = /^unconfirmed \d+\.crdownload$/i;

const STALL_MS = 8000; // no growth for this long: paused, or waiting on the server
const FRESH_MS = 2 * 60000; // an in-progress file untouched for longer when first seen is a leftover
const DORMANT_MS = 10 * 60000; // a tracked file that stops growing this long was abandoned
const NOTED_MS = 60000; // a temp file seen only through a folder event is remembered this long
const RECENT_MS = 60000; // finished downloads stay in the panel this long
const SOURCE_TTL_MS = 20000; // a browser that stopped reporting was closed
const DEDUPE_MS = 30000; // the same file finishing via both sources is announced once
const BROWSER_RECENT_MS = 20000; // a finished download the extension reports for the first time
// A failed or paused browser download keeps its in-progress file; the folder watcher must not
// show that file as a running download meanwhile.
const HELD_MS = DORMANT_MS;
const MAX_LIST = 8;
const ACTIONS = new Set(['pause', 'resume', 'cancel']);
const BROWSER_STATES = new Set(['in_progress', 'complete', 'interrupted']);
// Interrupt reasons that are the user's own doing, not a failure worth a banner.
const QUIET_ERRORS = new Set(['USER_CANCELED', 'USER_SHUTDOWN']);

// "setup.exe.crdownload" -> { suffix: '.crdownload', finalName: 'setup.exe' }; Chromium's
// "Unconfirmed 123.crdownload" has no final name yet. Anything else -> null.
function parseTempName(name) {
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  const suffix = TEMP_SUFFIXES.find((s) => lower.endsWith(s) && lower.length > s.length);
  if (!suffix) return null;
  if (UNCONFIRMED_RE.test(name)) return { suffix, finalName: '' };
  return { suffix, finalName: name.slice(0, -suffix.length) };
}

// Smoothed bytes per second from the previous sample.
function smoothSpeed(prevSpeed, prevBytes, prevAt, bytes, at) {
  if (!(at > prevAt) || !(bytes >= prevBytes)) return prevSpeed || 0;
  const instant = ((bytes - prevBytes) / (at - prevAt)) * 1000;
  return prevSpeed ? prevSpeed * 0.6 + instant * 0.4 : instant;
}

function fileKey(p) {
  return String(p || '').toLowerCase();
}

// Follows the in-progress files in the watched folders from one scan to the next.
class FolderTracker {
  constructor() {
    this.items = new Map(); // temp path -> item
    this.done = new Map(); // temp path -> when it finished (ignore late folder events for it)
  }

  // A folder event named an in-progress file: remember it even if it finishes before the next
  // scan, so small, fast downloads still get their "done".
  note(tempPath, now) {
    if (this.items.has(tempPath) || this.done.has(tempPath) || !parseTempName(path.basename(tempPath))) return;
    this.items.set(tempPath, this.newItem(tempPath, 0, now, now, true));
  }

  newItem(tempPath, size, mtimeMs, now, noted = false) {
    const parsed = parseTempName(path.basename(tempPath));
    const lastGrowth = Math.min(now, Number.isFinite(mtimeMs) ? mtimeMs : now);
    return {
      tempPath,
      path: parsed.finalName ? path.join(path.dirname(tempPath), parsed.finalName) : '',
      name: parsed.finalName,
      size,
      at: now,
      firstSeen: now,
      lastGrowth,
      speed: 0,
      noted,
      // Leftovers from a crash or an abandoned download stay hidden until they grow again.
      dormant: !noted && now - lastGrowth > FRESH_MS,
    };
  }

  // `entries`: [{ path, size, mtimeMs }] for every in-progress file in the watched folders now.
  // `sizeOf(path)`: the final file's size, or -1 when it doesn't exist.
  // Returns the downloads that finished since the last scan: [{ name, path }].
  update(entries, now, sizeOf) {
    const finished = [];
    const present = new Set();
    for (const e of entries) {
      if (!parseTempName(path.basename(e.path))) continue;
      present.add(e.path);
      const prev = this.items.get(e.path);
      if (!prev || prev.noted) {
        const item = this.newItem(e.path, e.size, e.mtimeMs, now);
        if (prev) Object.assign(item, { firstSeen: prev.firstSeen, dormant: false });
        this.items.set(e.path, item);
        continue;
      }
      if (e.size > prev.size) {
        prev.speed = smoothSpeed(prev.speed, prev.size, prev.at, e.size, now);
        prev.lastGrowth = now;
        prev.dormant = false;
      } else if (now - prev.lastGrowth >= STALL_MS) prev.speed = 0;
      else prev.speed = smoothSpeed(prev.speed, prev.size, prev.at, e.size, now);
      if (now - prev.lastGrowth > DORMANT_MS) prev.dormant = true;
      prev.size = e.size;
      prev.at = now;
    }
    for (const [tempPath, item] of this.items) {
      if (present.has(tempPath)) continue;
      if (item.noted && now - item.firstSeen < 1500) continue; // the scan may have raced the event
      this.items.delete(tempPath);
      if (item.noted && now - item.firstSeen > NOTED_MS) continue;
      if (item.dormant || !item.path) continue;
      // Done when the final file is there. Firefox keeps an empty placeholder while it downloads,
      // so an empty final file only counts for an empty download.
      const size = sizeOf(item.path);
      if (size > 0 || (size === 0 && item.size === 0 && !item.noted)) {
        finished.push({ name: item.name, path: item.path });
        this.done.set(tempPath, now);
      }
    }
    for (const [tempPath, at] of this.done) if (now - at > NOTED_MS) this.done.delete(tempPath);
    return finished;
  }

  // What the notch shows for the folder downloads.
  list(now) {
    const out = [];
    for (const item of this.items.values()) {
      if (item.dormant || item.noted) continue;
      out.push({
        key: `f:${item.tempPath}`,
        source: 'folder',
        browser: '',
        name: item.name,
        path: item.path,
        tempPath: item.tempPath,
        state: now - item.lastGrowth >= STALL_MS ? 'stalled' : 'active',
        received: item.size,
        total: 0,
        speed: Math.max(0, Math.round(item.speed)),
        etaMs: 0,
        startedAt: item.firstSeen,
        canPause: false,
        canResume: false,
        canCancel: false,
      });
    }
    return out;
  }
}

function text(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function bytes(v) {
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER) : 0;
}

function time(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Only plain local paths ("C:\..." or "/home/..."): no network shares (they'd be contacted when
// shown) and no "\\?\" / "\\.\" device paths.
function localPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || (p.startsWith('/') && !p.startsWith('//')) ? p : '';
}

// A report from the browser extension -> sanitised { source, browser, items } or null.
function parseReport(body) {
  if (!body || typeof body !== 'object' || body.v !== 1) return null;
  if (typeof body.source !== 'string' || !/^[\w-]{1,64}$/.test(body.source)) return null;
  if (!Array.isArray(body.items)) return null;
  const items = [];
  for (const it of body.items.slice(0, 50)) {
    if (!it || typeof it !== 'object' || !Number.isInteger(it.id) || it.id < 0) continue;
    if (!BROWSER_STATES.has(it.state)) continue;
    const p = localPath(text(it.path, 1000));
    const name = text(it.name, 260) || (p ? path.win32.basename(path.posix.basename(p)) : '');
    items.push({
      id: it.id,
      name,
      path: p,
      state: it.state,
      paused: it.paused === true,
      canResume: it.canResume === true,
      received: bytes(it.received),
      total: bytes(it.total),
      eta: time(it.eta),
      endTime: time(it.endTime),
      error: text(it.error, 40).toUpperCase().replace(/[^A-Z_]/g, ''),
    });
  }
  return { source: body.source, browser: text(body.browser, 30) || 'Browser', items };
}

// Merges the folder tracker and the browser extension into one list, keeps finished downloads
// for a minute, dedupes "done" between the two sources and queues commands for the extension.
class DownloadHub {
  constructor() {
    this.sources = new Map(); // source id -> { browser, at, items: Map<id, item>, commands: [] }
    this.recent = []; // finished: { key, name, path, browser, state: 'done' | 'failed', error, finishedAt, source, id, canResume }
    this.announced = new Map(); // file key -> when its "done" was announced
    this.held = new Map(); // file key -> when the browser last reported it failed or paused
    this.seq = 0;
  }

  // A sanitised extension report (parseReport). Returns the downloads that finished or failed.
  report({ source, browser, items }, now) {
    let src = this.sources.get(source);
    if (!src) {
      src = { browser, at: now, items: new Map(), commands: [] };
      this.sources.set(source, src);
    }
    src.browser = browser;
    src.at = now;
    const events = [];
    const next = new Map();
    for (const it of items) {
      const prev = src.items.get(it.id);
      const active = it.state === 'in_progress' && !it.paused;
      const speed = active && prev ? smoothSpeed(prev.speed, prev.received, prev.at, it.received, now) : 0;
      next.set(it.id, { ...it, at: now, speed, startedAt: prev ? prev.startedAt : now });
      if (it.path && (it.state === 'interrupted' || it.paused)) this.held.set(fileKey(it.path), now);
      else if (it.path) this.held.delete(fileKey(it.path));
      const wasRunning = prev ? prev.state === 'in_progress' : null;
      const fresh = wasRunning === true || (!prev && (!it.endTime || now - it.endTime < BROWSER_RECENT_MS));
      if (!fresh) continue;
      if (it.state === 'complete') {
        const ev = this.finish({ name: it.name, path: it.path, browser, ok: true }, now);
        if (ev) events.push(ev);
      } else if (it.state === 'interrupted' && !QUIET_ERRORS.has(it.error)) {
        const ev = this.finish({ name: it.name, path: it.path, browser, ok: false, error: it.error, source, id: it.id, canResume: it.canResume }, now);
        if (ev) events.push(ev);
      }
    }
    // A download that resumed after failing is live again.
    for (const it of next.values()) {
      if (it.state === 'in_progress') this.recent = this.recent.filter((r) => !(r.bridgeSource === source && r.bridgeId === it.id));
    }
    src.items = next;
    return events;
  }

  // Records a finished (ok) or failed download; null when it was already announced.
  finish({ name, path: p, browser = '', ok, error = '', source = null, id = null, canResume = false }, now) {
    const fk = fileKey(p || name);
    if (ok) {
      const last = this.announced.get(fk);
      if (last && now - last < DEDUPE_MS) return null;
      this.announced.set(fk, now);
    }
    this.recent = this.recent.filter((r) => fileKey(r.path || r.name) !== fk);
    const entry = {
      key: `r:${++this.seq}`,
      source: 'recent',
      name: name || (p ? path.basename(p) : 'Download'),
      path: p || '',
      browser,
      state: ok ? 'done' : 'failed',
      error: ok ? '' : error,
      finishedAt: now,
      bridgeSource: source,
      bridgeId: id,
      canResume: !ok && canResume && source != null,
    };
    this.recent.unshift(entry);
    this.recent = this.recent.slice(0, MAX_LIST);
    return { key: entry.key, name: entry.name, path: entry.path, browser, ok, error: entry.error };
  }

  expire(now) {
    for (const [id, src] of this.sources) if (now - src.at > SOURCE_TTL_MS) this.sources.delete(id);
    this.recent = this.recent.filter((r) => now - r.finishedAt <= RECENT_MS);
    for (const [k, at] of this.announced) if (now - at > DEDUPE_MS) this.announced.delete(k);
    for (const [k, at] of this.held) if (now - at > HELD_MS) this.held.delete(k);
  }

  // The browser extension reported within the last few seconds.
  get bridgeActive() {
    return this.sources.size > 0;
  }

  browsers() {
    return [...new Set([...this.sources.values()].map((s) => s.browser))];
  }

  hasActive(folderItems = []) {
    return folderItems.length > 0 || [...this.sources.values()].some((s) => [...s.items.values()].some((i) => i.state === 'in_progress'));
  }

  // Live downloads first (oldest first), then finished ones (newest first).
  list(now, folderItems = []) {
    this.expire(now);
    const live = [];
    const browserPaths = new Set();
    for (const [sourceId, src] of this.sources) {
      for (const it of src.items.values()) {
        if (it.path) browserPaths.add(fileKey(it.path));
        if (it.state !== 'in_progress') continue;
        const remaining = it.total > it.received ? it.total - it.received : 0;
        let etaMs = it.eta > now ? it.eta - now : 0;
        if (!etaMs && remaining && it.speed > 0) etaMs = Math.round((remaining / it.speed) * 1000);
        live.push({
          key: `b:${sourceId}:${it.id}`,
          source: 'browser',
          browser: src.browser,
          name: it.name,
          path: it.path,
          state: it.paused ? 'paused' : 'active',
          received: it.received,
          total: it.total,
          speed: it.paused ? 0 : Math.max(0, Math.round(it.speed)),
          etaMs: it.paused ? 0 : etaMs,
          startedAt: it.startedAt,
          canPause: !it.paused,
          canResume: it.paused && it.canResume,
          canCancel: true,
        });
      }
    }
    for (const f of folderItems) {
      if (f.path && (browserPaths.has(fileKey(f.path)) || this.held.has(fileKey(f.path)))) continue;
      // Chromium's "Unconfirmed" file: the extension reports that download properly.
      if (!f.path && this.bridgeActive) continue;
      live.push(f);
    }
    live.sort((a, b) => a.startedAt - b.startedAt);
    const finished = this.recent.map((r) => ({
      key: r.key,
      source: 'recent',
      browser: r.browser,
      name: r.name,
      path: r.path,
      state: r.state,
      error: r.error,
      finishedAt: r.finishedAt,
      received: 0,
      total: 0,
      speed: 0,
      etaMs: 0,
      canPause: false,
      canResume: r.canResume,
      canCancel: false,
    }));
    return [...live, ...finished].slice(0, MAX_LIST);
  }

  // Queues pause / resume / cancel for the extension; the reply to its next report carries it.
  // Returns false when `key` isn't a download the extension can act on.
  command(key, action) {
    if (!ACTIONS.has(action)) return false;
    let sourceId;
    let id;
    const recent = this.recent.find((r) => r.key === key);
    if (recent) {
      if (action !== 'resume' || !recent.canResume) return false;
      sourceId = recent.bridgeSource;
      id = recent.bridgeId;
    } else {
      const m = /^b:([\w-]{1,64}):(\d+)$/.exec(String(key));
      if (!m) return false;
      sourceId = m[1];
      id = Number(m[2]);
    }
    const src = this.sources.get(sourceId);
    const it = src && src.items.get(id);
    if (!it) return false;
    if (action !== 'resume' && it.state !== 'in_progress') return false;
    src.commands = src.commands.filter((c) => c.id !== id);
    src.commands.push({ id, action });
    return true;
  }

  takeCommands(sourceId) {
    const src = this.sources.get(sourceId);
    if (!src || !src.commands.length) return [];
    const out = src.commands;
    src.commands = [];
    return out;
  }

  dismiss(key) {
    const before = this.recent.length;
    this.recent = key === '*' ? [] : this.recent.filter((r) => r.key !== key);
    return this.recent.length !== before;
  }
}

module.exports = {
  parseTempName,
  parseReport,
  FolderTracker,
  DownloadHub,
  TEMP_SUFFIXES,
  STALL_MS,
  FRESH_MS,
  RECENT_MS,
  SOURCE_TTL_MS,
};
