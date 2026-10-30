'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_ITEMS = 30;

// Only documents, images, audio/video and archives are opened directly (by their default app).
// Anything else (programs, scripts, shortcuts, installers, unknown types) is shown in its folder,
// so opening a shelf item can never run code.
const OPENABLE = new Set([
  '.txt', '.md', '.rtf', '.pdf', '.csv', '.log', '.json', '.xml', '.yaml', '.yml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff', '.heic', '.avif',
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma',
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.m4v',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz',
]);

function isOpenable(file) {
  return OPENABLE.has(path.extname(String(file)).toLowerCase());
}

// A dropped path is kept only if it is an absolute local path to something that exists.
function validPath(p) {
  return typeof p === 'string' && p.length > 2 && p.length < 1024 && !p.includes('\0') && path.isAbsolute(p);
}

// The file shelf: files and folders dropped on the notch, kept (as paths, newest first) until
// removed, so they can be dragged into another app later. Stored in shelf.json.
class Shelf extends EventEmitter {
  constructor(file, { max = MAX_ITEMS, fsImpl = fs, now = Date.now } = {}) {
    super();
    this.file = file;
    this.max = max;
    this.fs = fsImpl;
    this.now = now;
    this.items = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(data) ? data : [];
      this.items = list
        .filter((i) => i && validPath(i.path))
        .map((i) => ({ path: i.path, addedAt: Number.isFinite(i.addedAt) ? i.addedAt : 0 }))
        .slice(0, this.max);
    } catch {
      this.items = [];
    }
  }

  save() {
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(this.items.map(({ path: p, addedAt }) => ({ path: p, addedAt })), null, 2));
      this.fs.renameSync(tmp, this.file);
    } catch {
      // the shelf still works for this run
    }
  }

  stat(p) {
    try {
      const st = this.fs.statSync(p);
      return { dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size };
    } catch {
      return null;
    }
  }

  has(p) {
    return this.items.some((i) => i.path === p);
  }

  // Items with their current details; files that were moved or deleted drop off.
  list() {
    const out = [];
    const keep = [];
    for (const item of this.items) {
      const st = this.stat(item.path);
      if (!st) continue;
      keep.push(item);
      out.push({ path: item.path, name: path.basename(item.path) || item.path, dir: st.dir, size: st.size, addedAt: item.addedAt });
    }
    if (keep.length !== this.items.length) {
      this.items = keep;
      this.save();
    }
    return out;
  }

  // Adds paths (newest first; re-adding moves an item to the front). Returns how many were added.
  add(paths) {
    if (!Array.isArray(paths)) return 0;
    const fresh = [...new Set(paths.filter(validPath))].filter((p) => this.stat(p)).slice(0, this.max);
    if (!fresh.length) return 0;
    const at = this.now();
    this.items = [...fresh.map((p) => ({ path: p, addedAt: at })), ...this.items.filter((i) => !fresh.includes(i.path))].slice(0, this.max);
    this.save();
    this.emit('change');
    return fresh.length;
  }

  remove(p) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.path !== p);
    if (this.items.length === before) return false;
    this.save();
    this.emit('change');
    return true;
  }

  clear() {
    if (!this.items.length) return false;
    this.items = [];
    this.save();
    this.emit('change');
    return true;
  }
}

module.exports = { Shelf, isOpenable, validPath, MAX_ITEMS };
