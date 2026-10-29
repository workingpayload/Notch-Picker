'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { createSessionState, applyEvent, snapshot, isKnownEventType, CORE_EVENT_TYPES, applyHistoricalUsage } = require('./session-state');
const { readTodos, readPlanTitle } = require('./todos');

const INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const FORMAT_CHECK_MIN_LINES = 30;
const WATCHED_FILES = new Set(['events.jsonl', 'workspace.yaml', 'session.db', 'session.db-journal', 'plan.md']);
const ATTENTION = new Set(['approval', 'input']);
const BUSY = new Set(['approval', 'input', 'tool', 'thinking']);
const COPILOT_PROCESS_NAMES = new Set(['copilot.exe', 'node.exe', 'copilot', 'node']);

function copilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Lock files can outlive a crashed CLI and the PID can be reused, so confirm the process name once per PID.
const pidNameCache = new Map();
function pidIsCopilot(pid) {
  if (pidNameCache.has(pid)) return pidNameCache.get(pid);
  const pending = new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(true);
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(true);
      const m = /^"([^"]+)"/.exec(String(stdout).trim());
      resolve(m ? COPILOT_PROCESS_NAMES.has(m[1].toLowerCase()) : false);
    });
  });
  pidNameCache.set(pid, pending);
  return pending;
}

function parseWorkspaceYaml(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try {
        v = v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1).replace(/''/g, "'");
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[m[1]] = v;
  }
  return out;
}

class SessionTracker {
  constructor(id, dir, { onUnknownType, tailBytes = INITIAL_TAIL_BYTES } = {}) {
    this.id = id;
    this.dir = dir;
    this.tailBytes = tailBytes;
    this.prefixEnd = 0;
    this.pid = null;
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.state = createSessionState(id);
    this.offset = 0;
    this.partial = '';
    this.loaded = false;
    this.reading = false;
    this.onUnknownType = onUnknownType || (() => {});
    this.stats = { lines: 0, malformed: 0, core: 0 };
    this.dirty = true;
    this.lastPolled = 0;
    this.todos = null;
    this.planTitle = null;
    this.todosMtime = 0;
    this.planMtime = 0;
  }

  // Re-reads todo progress / plan title only when their files changed (cheap mtime check).
  async refreshTodos() {
    const dbPath = path.join(this.dir, 'session.db');
    const planPath = path.join(this.dir, 'plan.md');
    const [db, plan] = await Promise.all([fsp.stat(dbPath).catch(() => null), fsp.stat(planPath).catch(() => null)]);
    const dbMtime = db ? db.mtimeMs : -1;
    if (dbMtime !== this.todosMtime) {
      try {
        this.todos = db ? readTodos(dbPath) : null;
        this.todosMtime = dbMtime;
      } catch {
        // Locked mid-write by the CLI; keep the last reading and retry on the next change/poll.
      }
    }
    const planMtime = plan ? plan.mtimeMs : -1;
    if (planMtime !== this.planMtime) {
      this.planTitle = plan ? readPlanTitle(planPath) : null;
      this.planMtime = planMtime;
    }
  }

  // Non-empty warning when the events no longer look like the format this app understands.
  formatWarning() {
    const { lines, malformed, core } = this.stats;
    if (lines < FORMAT_CHECK_MIN_LINES) return '';
    if (malformed / lines > 0.5) return 'Unreadable session log — Copilot CLI format may have changed';
    if (core === 0) return 'Unrecognised session events — Copilot CLI format may have changed';
    return '';
  }

  async refreshWorkspace() {
    try {
      const ws = parseWorkspaceYaml(await fsp.readFile(path.join(this.dir, 'workspace.yaml'), 'utf8'));
      if (ws.name) this.state.name = ws.name;
      if (ws.summary) this.state.summary = ws.summary;
      if (ws.cwd) this.state.cwd = ws.cwd;
    } catch {
      // workspace.yaml is optional
    }
  }

  // Returns true if new events were applied.
  async poll() {
    if (this.reading) return false;
    this.reading = true;
    let fh;
    try {
      const stat = await fsp.stat(this.eventsPath).catch(() => null);
      if (!stat) {
        this.loaded = true;
        return false;
      }
      if (stat.size < this.offset) {
        this.state = createSessionState(this.id);
        this.offset = 0;
        this.partial = '';
        this.loaded = false;
        this.stats = { lines: 0, malformed: 0, core: 0 };
        await this.refreshWorkspace();
      }
      if (!this.loaded && stat.size > this.tailBytes) {
        this.offset = stat.size - this.tailBytes;
        this.skipFirstLine = true;
        this.prefixEnd = this.offset;
      }
      if (stat.size === this.offset) {
        this.loaded = true;
        return false;
      }
      fh = await fsp.open(this.eventsPath, 'r');
      let applied = false;
      // Older history first, so events replay in order (an edit that starts before the tail
      // and finishes inside it is still counted).
      if (this.prefixEnd) {
        await this.scanPrefixUsage(fh, this.prefixEnd);
        this.prefixEnd = 0;
        applied = true;
      }
      while (this.offset < stat.size) {
        const len = Math.min(READ_CHUNK_BYTES, stat.size - this.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        applied = this.consume(buf.subarray(0, bytesRead).toString('utf8')) || applied;
      }
      this.loaded = true;
      return applied;
    } finally {
      this.reading = false;
      if (fh) await fh.close().catch(() => {});
    }
  }

  // One pass over the log before the replayed tail, counting only usage totals so long sessions
  // report their full premium-request and token counts. Finishes the line that straddles `end`
  // (the tail skips it as partial).
  async scanPrefixUsage(fh, end) {
    let pos = 0;
    let partial = '';
    const handle = (line) => {
      if (!line.includes('"session.usage_') && !line.includes('"tool.execution_')) return;
      try {
        applyHistoricalUsage(this.state, JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    };
    while (true) {
      const len = pos < end ? Math.min(READ_CHUNK_BYTES, end - pos) : 64 * 1024;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const lines = (partial + buf.subarray(0, bytesRead).toString('utf8')).split('\n');
      partial = lines.pop();
      if (pos > end) {
        // Past the tail start: only the straddling line is still ours.
        if (lines.length) handle(lines[0]);
        return;
      }
      lines.forEach(handle);
    }
    if (partial) handle(partial);
  }

  consume(text) {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop();
    if (this.skipFirstLine) {
      lines.shift();
      this.skipFirstLine = false;
    }
    let applied = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      this.stats.lines++;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.stats.malformed++;
        continue;
      }
      if (!event || typeof event.type !== 'string') {
        this.stats.malformed++;
        continue;
      }
      if (CORE_EVENT_TYPES.has(event.type)) this.stats.core++;
      else if (!isKnownEventType(event.type)) this.onUnknownType(event.type, this.id);
      try {
        applyEvent(this.state, event);
        applied = true;
      } catch {
        this.stats.malformed++;
      }
    }
    return applied;
  }
}

class SessionWatcher extends EventEmitter {
  constructor({
    root = path.join(copilotHome(), 'session-state'),
    pollMs = 1000,
    scanMs = 2000,
    watch = true,
    fallbackReadMs = 5000,
    endedTtlMs = 30 * 60 * 1000,
    log = () => {},
  } = {}) {
    super();
    this.root = root;
    this.pollMs = pollMs;
    this.scanMs = scanMs;
    this.log = log;
    this.watch = watch;
    this.fallbackReadMs = fallbackReadMs;
    this.fsWatcher = null;
    this.unknownTypes = new Set();
    this.trackers = new Map();
    this.lastStatus = new Map();
    this.ended = new Map();
    this.endedTtlMs = endedTtlMs;
    this.lastEndedPayload = '[]';
    this.lastPayload = '';
    this.timers = [];
    this.ticking = null;
    this.tickAgain = false;
    this.changeTimer = null;
    this.scanTimer = null;
  }

  noteUnknownType(type, sessionId) {
    if (this.unknownTypes.has(type)) return;
    this.unknownTypes.add(type);
    this.log(`Unknown Copilot CLI event type "${type}" (first seen in session ${sessionId})`);
  }

  async start() {
    if (this.watch) this.startWatching();
    await this.scan();
    await this.tick();
    this.timers.push(setInterval(() => this.scan().catch((e) => this.emit('error', e)), this.scanMs));
    this.timers.push(setInterval(() => this.requestTick(), this.pollMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.changeTimer);
    clearTimeout(this.scanTimer);
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // already closed
      }
      this.fsWatcher = null;
    }
  }

  // One recursive watch on the session-state root: event-log writes mark that session dirty and
  // re-tick almost immediately; lock-file changes trigger a rescan. Polling remains as a fallback.
  startWatching() {
    try {
      this.fsWatcher = fs.watch(this.root, { recursive: true, persistent: false }, (_type, filename) => this.onFsChange(filename));
      this.fsWatcher.on('error', (e) => {
        this.log(`File watching failed, falling back to polling: ${e.message}`);
        this.fsWatcher = null;
      });
    } catch (e) {
      this.log(`File watching unavailable, using polling: ${e.message}`);
      this.fsWatcher = null;
    }
  }

  onFsChange(filename) {
    if (!filename) {
      for (const t of this.trackers.values()) t.dirty = true;
    } else {
      const [id, file] = String(filename).split(/[\\/]/);
      if (!file) return;
      if (/^inuse\.\d+\.lock$/.test(file)) {
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => this.scan().then(() => this.requestTick()).catch((e) => this.emit('error', e)), 150);
        return;
      }
      const t = this.trackers.get(id);
      if (!t || !WATCHED_FILES.has(file)) return;
      t.dirty = true;
      if (file === 'workspace.yaml') t.workspaceDirty = true;
    }
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.requestTick(), 30);
  }

  // Serialises ticks; a request during a running tick schedules exactly one follow-up.
  requestTick() {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = this.tick()
      .catch((e) => this.emit('error', e))
      .finally(() => {
        this.ticking = null;
        if (this.tickAgain) {
          this.tickAgain = false;
          this.requestTick();
        }
      });
    return this.ticking;
  }

  get watching() {
    return !!this.fsWatcher;
  }

  async liveSessionIds() {
    const ids = new Map();
    let entries;
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return ids;
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map(async (e) => {
          const dir = path.join(this.root, e.name);
          let files;
          try {
            files = await fsp.readdir(dir);
          } catch {
            return;
          }
          for (const f of files) {
            const m = /^inuse\.(\d+)\.lock$/.exec(f);
            if (!m) continue;
            const pid = Number(m[1]);
            if (pidAlive(pid) && (await pidIsCopilot(pid))) {
              ids.set(e.name, { dir, pid });
              return;
            }
            if (!pidAlive(pid)) pidNameCache.delete(pid);
          }
        })
    );
    return ids;
  }

  async scan() {
    const live = await this.liveSessionIds();
    for (const [id, { dir, pid }] of live) {
      let t = this.trackers.get(id);
      if (!t) {
        t = new SessionTracker(id, dir, { onUnknownType: (type, sid) => this.noteUnknownType(type, sid) });
        this.trackers.set(id, t);
        await t.refreshWorkspace();
      } else if (!this.watching) {
        await t.refreshWorkspace();
      }
      if (t.pid !== pid) {
        if (t.pid != null) this.log(`Session ${id} is now held by PID ${pid}`);
        t.pid = pid;
      }
    }
    for (const id of [...this.trackers.keys()]) {
      if (!live.has(id)) {
        // The CLI exited (or crashed) without us seeing a shutdown event.
        this.markEnded(this.trackers.get(id), Date.now());
        this.trackers.delete(id);
        this.lastStatus.delete(id);
      }
    }
    this.emitEnded();
  }

  // Remembers a session that was live during this run so it can be listed as "recently ended".
  markEnded(t, now) {
    const prev = this.lastStatus.get(t.id);
    if (!t.lastSnap || prev === undefined || prev === 'ended' || this.ended.has(t.id)) return;
    const s = t.lastSnap;
    this.ended.set(t.id, {
      id: t.id,
      name: s.name,
      cwd: s.cwd,
      model: s.model,
      endedAt: now,
      lastPrompt: s.lastPrompt,
      summary: t.state.lastMessage || '',
      premiumRequests: s.usage ? s.usage.premiumRequests : 0,
      todos: t.todos,
    });
  }

  dismissEnded(id) {
    if (this.ended.delete(id)) this.emitEnded();
  }

  clearEnded() {
    if (!this.ended.size) return;
    this.ended.clear();
    this.emitEnded();
  }

  emitEnded(now = Date.now()) {
    for (const [id, e] of this.ended) if (now - e.endedAt >= this.endedTtlMs) this.ended.delete(id);
    const list = [...this.ended.values()].sort((a, b) => b.endedAt - a.endedAt);
    const payload = JSON.stringify(list);
    if (payload === this.lastEndedPayload) return;
    this.lastEndedPayload = payload;
    this.emit('ended', list);
  }

  get endedSessions() {
    return [...this.ended.values()].sort((a, b) => b.endedAt - a.endedAt);
  }

  async tick() {
    const now0 = Date.now();
    // With file watching, only re-read sessions that changed (plus a slow safety re-read);
    // without it, read every session on every tick.
    const due = [...this.trackers.values()].filter(
      (t) => !this.watching || t.dirty || !t.loaded || now0 - t.lastPolled >= this.fallbackReadMs
    );
    await Promise.all(
      due.map(async (t) => {
        t.dirty = false;
        t.lastPolled = now0;
        if (t.workspaceDirty) {
          t.workspaceDirty = false;
          await t.refreshWorkspace();
        }
        await t.refreshTodos().catch(() => {});
        return t.poll().catch(() => false);
      })
    );
    const now = Date.now();
    const sessions = [];
    for (const t of this.trackers.values()) {
      if (!t.loaded) continue;
      const snap = snapshot(t.state, now);
      if (snap.status === 'ended') {
        this.markEnded(t, now);
        this.lastStatus.set(t.id, 'ended');
        continue;
      }
      // Resumed after ending (e.g. `copilot --resume`): it is live again.
      this.ended.delete(t.id);
      snap.pid = t.pid;
      snap.todos = t.todos;
      snap.planTitle = t.planTitle;
      t.lastSnap = snap;
      snap.warning = t.formatWarning();
      if (snap.warning && !t.warned) {
        t.warned = true;
        this.log(`${snap.warning} (session ${t.id}, CLI ${snap.cliVersion || 'unknown version'})`);
      }
      sessions.push(snap);
      const prev = this.lastStatus.get(t.id);
      this.lastStatus.set(t.id, snap.status);
      if (prev === undefined) continue; // no notifications for history replayed on startup
      if (ATTENTION.has(snap.status) && prev !== snap.status) {
        this.emit('transition', { kind: 'attention', session: snap });
      } else if (BUSY.has(prev) && (snap.status === 'idle' || snap.status === 'error')) {
        this.emit('transition', { kind: snap.status === 'error' ? 'error' : 'done', session: snap });
      }
    }
    sessions.sort(compareSessions);
    this.emitEnded(now);
    const payload = JSON.stringify(sessions);
    if (payload !== this.lastPayload) {
      this.lastPayload = payload;
      this.emit('update', sessions);
    }
  }
}

const PRIORITY = { approval: 0, input: 1, tool: 2, thinking: 2, agents: 3, error: 4, idle: 5 };
function compareSessions(a, b) {
  const pa = PRIORITY[a.status] ?? 9;
  const pb = PRIORITY[b.status] ?? 9;
  if (pa !== pb) return pa - pb;
  return (b.lastEventAt || 0) - (a.lastEventAt || 0);
}

module.exports = { SessionWatcher, SessionTracker, parseWorkspaceYaml, compareSessions, copilotHome };
