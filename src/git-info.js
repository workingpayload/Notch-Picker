'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const TTL_MS = 15000;
const TIMEOUT_MS = 4000;
const MAX_CONCURRENT = 2;

// Parses `git status --porcelain=v2 --branch` output.
function parseStatus(stdout) {
  const info = { branch: null, detached: false, ahead: 0, behind: 0, changed: 0 };
  let oid = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim();
    else if (line.startsWith('# branch.head ')) info.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        info.ahead = Number(m[1]);
        info.behind = Number(m[2]);
      }
    } else if (!line.startsWith('#')) info.changed++;
  }
  if (info.branch === '(detached)') {
    info.detached = true;
    info.branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached';
  }
  return info.branch ? info : null;
}

// Caches git branch / ahead-behind / changed-file count per folder and refreshes in the
// background. Uses --no-optional-locks so it never contends with the user's own git commands.
class GitInfo extends EventEmitter {
  constructor({ ttlMs = TTL_MS, run = runGit } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.run = run;
    this.cache = new Map(); // cwd -> { info, at }
    this.pending = new Set();
    this.queue = [];
    this.active = 0;
  }

  // Returns the cached info (or null) and schedules a refresh when stale.
  get(cwd, now = Date.now()) {
    if (!cwd) return null;
    const hit = this.cache.get(cwd);
    if ((!hit || now - hit.at >= this.ttlMs) && !this.pending.has(cwd)) {
      this.pending.add(cwd);
      this.queue.push(cwd);
      this.drain();
    }
    return hit ? hit.info : null;
  }

  drain() {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const cwd = this.queue.shift();
      this.active++;
      this.run(cwd)
        .then((stdout) => (stdout == null ? null : parseStatus(stdout)))
        .catch(() => null)
        .then((info) => {
          const prev = this.cache.get(cwd);
          this.cache.set(cwd, { info, at: Date.now() });
          this.active--;
          this.pending.delete(cwd);
          if (JSON.stringify(prev && prev.info) !== JSON.stringify(info)) this.emit('change', cwd, info);
          this.drain();
        });
    }
  }

  // Drop folders no live session uses any more.
  prune(cwds) {
    const keep = new Set(cwds);
    for (const cwd of this.cache.keys()) if (!keep.has(cwd)) this.cache.delete(cwd);
  }
}

// Resolves stdout, or null when the folder is not a repository / git is unavailable.
function runGit(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}

module.exports = { GitInfo, parseStatus };
