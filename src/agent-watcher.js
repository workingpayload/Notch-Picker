'use strict';

// Session watching for Claude Code, Codex and Gemini CLI. Each provider finds the live sessions
// and their log files; AgentTracker translates log records (agent-logs.js) into the events
// session-state.js understands, so the notch, pets, alerts and webhooks work the same as for Copilot.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { SessionWatcher, SessionTracker, pidAlive, pidHasName, forgetPid } = require('./watcher');
const { createSessionState, applyEvent } = require('./session-state');
const { META, TRANSLATORS, newContext, isCodexSubagent, cleanCwd } = require('./agent-logs');
const { loadSqlite } = require('./todos');
const { agentInfo } = require('./agents');

// Codex and Gemini don't record which sessions are still open: a session counts as live while
// its log has been written to recently.
const ACTIVE_MS = 30 * 60 * 1000;
// Gemini doesn't log the end of a turn: a text-only reply counts as final after this much quiet,
// or after the longer wait when it announced more work (its tools may be running or awaiting approval).
const GEMINI_FINAL_QUIET_MS = 6000;
const GEMINI_PREAMBLE_QUIET_MS = 2 * 60 * 1000;
// ...and a Gemini turn with no log activity for this long is treated as over (e.g. cancelled).
const STALLED_TURN_MS = 10 * 60 * 1000;
// Claude Code marks itself idle just before (or, when interrupted, instead of) logging the end of a turn.
const CLAUDE_IDLE_GRACE_MS = 3000;
const FORMAT_CHECK_MIN_LINES = 30;
const ID_RE = /^[\w-]{1,64}$/;
const CLAUDE_PROCESS_NAMES = new Set(['claude.exe', 'node.exe', 'bun.exe', 'claude', 'node', 'bun']);
// Keys of the synthetic approval/question the Claude overlay adds while Claude Code waits.
const WAIT_KEY = 'notch:claude-wait';
const INPUT_KEY = 'notch:claude-input';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function truncate(text, max) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

async function mtimeOf(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function exists(file) {
  return (await mtimeOf(file)) > 0;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// First line of a JSONL file (its metadata record), without reading the whole log.
async function readFirstLine(file, max = 1024 * 1024) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const chunks = [];
    let pos = 0;
    while (pos < max) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      const part = buf.subarray(0, bytesRead);
      const nl = part.indexOf(10);
      if (nl !== -1) {
        chunks.push(part.subarray(0, nl));
        break;
      }
      chunks.push(part);
      pos += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- Claude Code ----
// Live sessions: ~/.claude/sessions/<pid>.json (pid, sessionId, cwd, status, waitingFor).
// Logs: ~/.claude/projects/<cwd with non-alphanumerics as dashes>/<sessionId>.jsonl.

function claudeProjectFolder(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function permissionFor(tool) {
  if (tool.name === 'shell') return { kind: 'shell', detail: tool.detail };
  if (['edit', 'create', 'apply_patch'].includes(tool.name)) return { kind: 'write', detail: tool.detail };
  if (tool.name === 'web_fetch') return { kind: 'url', detail: tool.detail };
  return { kind: 'tool', detail: tool.title || tool.name };
}

const CLAUDE_WAITS = { 'input needed': 'Claude Code needs your input', 'sandbox request': 'Sandbox request', 'goal proposal': 'Goal proposal' };

class ClaudeProvider {
  constructor({ home } = {}) {
    this.id = 'claude';
    this.home = home || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    this.translate = TRANSLATORS.claude;
    this.files = new Map();
    this.searched = new Map();
  }

  folder() {
    return path.join(this.home, 'projects');
  }

  watchRoots() {
    return [path.join(this.home, 'sessions'), this.folder()];
  }

  async discover() {
    const dir = path.join(this.home, 'sessions');
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return new Map();
    }
    const out = new Map();
    await Promise.all(
      names
        .filter((n) => /^\d+\.json$/.test(n))
        .map(async (n) => {
          const info = await readJson(path.join(dir, n));
          if (!info || typeof info !== 'object') return;
          const pid = Number(info.pid);
          const id = info.sessionId;
          // Spares are pre-started processes nobody is using yet.
          if (!Number.isInteger(pid) || pid <= 0 || typeof id !== 'string' || !ID_RE.test(id) || info.spare === true) return;
          // A crashed CLI leaves its file behind, and the PID may since belong to something else.
          if (!pidAlive(pid)) return forgetPid(pid);
          if (!(await pidHasName(pid, CLAUDE_PROCESS_NAMES))) return;
          const prev = out.get(id);
          if (prev && num(prev.updatedAt) >= num(info.updatedAt)) return;
          out.set(id, {
            pid,
            cwd: str(info.cwd) || null,
            name: info.nameSource === 'user' && info.name ? String(info.name) : null,
            version: info.version ? String(info.version) : null,
            status: str(info.status),
            waitingFor: str(info.waitingFor),
            statusAt: num(info.statusUpdatedAt),
            updatedAt: num(info.updatedAt),
          });
        })
    );
    for (const [id, info] of out) info.file = await this.transcript(id, info.cwd);
    return out;
  }

  // The transcript appears with the first message; long or unusual paths get another folder name.
  async transcript(id, cwd) {
    const cached = this.files.get(id);
    if (cached && (await exists(cached))) return cached;
    const guess = path.join(this.folder(), claudeProjectFolder(cwd), `${id}.jsonl`);
    if (await exists(guess)) {
      this.files.set(id, guess);
      return guess;
    }
    if (Date.now() - (this.searched.get(id) || 0) < 10000) return guess;
    this.searched.set(id, Date.now());
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.folder(), { withFileTypes: true });
    } catch {
      return guess;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(this.folder(), d.name, `${id}.jsonl`);
      if (await exists(file)) {
        this.files.set(id, file);
        return file;
      }
    }
    return guess;
  }

  // Claude Code's own status says when it is waiting on a prompt in the terminal, which its
  // transcript doesn't record.
  overlay(t, now) {
    const s = t.state;
    const info = t.info;
    let changed = false;
    const since = info.statusAt || now;
    const real = [...s.tools.entries()].filter(([k]) => k !== INPUT_KEY).map(([, v]) => v);
    const pending = real[real.length - 1];
    const asking = real.some((x) => x.name === 'ask_user');
    const waiting = info.status === 'waiting';
    const wantApproval = waiting && !!pending && !asking;
    const wantInput = waiting && !pending && !!CLAUDE_WAITS[info.waitingFor];
    if (wantApproval && !s.permissions.has(WAIT_KEY)) {
      s.permissions.set(WAIT_KEY, { ...permissionFor(pending), agentName: null, since });
      changed = true;
    } else if (!wantApproval && s.permissions.delete(WAIT_KEY)) {
      changed = true;
    }
    if (wantInput && !s.tools.has(INPUT_KEY)) {
      s.tools.set(INPUT_KEY, { name: 'ask_user', title: 'Waiting for you', detail: CLAUDE_WAITS[info.waitingFor], since });
      changed = true;
    } else if (!wantInput && s.tools.delete(INPUT_KEY)) {
      changed = true;
    }
    // Idle since after the last logged event (interrupted, or the end isn't logged yet).
    const idleSettled =
      info.status === 'idle' && info.statusAt && now - info.statusAt >= CLAUDE_IDLE_GRACE_MS && (s.lastEventAt == null || info.statusAt > s.lastEventAt);
    if (idleSettled && (s.busy || s.inTurn || s.tools.size || s.permissions.size)) {
      s.tools.clear();
      s.permissions.clear();
      s.busy = false;
      s.inTurn = false;
      changed = true;
    }
    return changed;
  }
}

// ---- Codex ----
// Threads (title, cwd, rollout path, last update): ~/.codex/state_<n>.sqlite.
// Logs: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl.

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

class CodexProvider {
  constructor({ home, activeMs = ACTIVE_MS, log = () => {} } = {}) {
    this.id = 'codex';
    this.home = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.activeMs = activeMs;
    this.log = log;
    this.translate = TRANSLATORS.codex;
    this.metaCache = new Map();
    this.dbWarned = false;
  }

  folder() {
    return path.join(this.home, 'sessions');
  }

  watchRoots() {
    return [this.folder()];
  }

  async discover(watcher) {
    const since = Date.now() - this.activeMs;
    const candidates = new Map();
    const rows = this.threads(since);
    if (rows) {
      for (const r of rows) {
        const title = str(r.title).trim();
        candidates.set(String(r.id), { file: cleanCwd(r.rollout_path), cwd: cleanCwd(r.cwd), name: title && !title.startsWith('<') ? truncate(title, 80) : null });
      }
    } else {
      for (const c of await this.walk(since)) candidates.set(c.id, c);
    }
    // Keep following sessions we already track while their log stays fresh.
    if (watcher) for (const t of watcher.trackers.values()) if (!candidates.has(t.id)) candidates.set(t.id, t.info);
    const out = new Map();
    await Promise.all(
      [...candidates].map(async ([id, info]) => {
        if (!info.file || !ID_RE.test(id)) return;
        if ((await mtimeOf(info.file)) >= since) out.set(id, { file: info.file, cwd: info.cwd || null, name: info.name || null });
      })
    );
    return out;
  }

  dbFile() {
    let best = null;
    let bestN = -1;
    try {
      for (const name of fs.readdirSync(this.home)) {
        const m = /^state_(\d+)\.sqlite$/.exec(name);
        if (m && Number(m[1]) > bestN) {
          bestN = Number(m[1]);
          best = path.join(this.home, name);
        }
      }
    } catch {
      return null;
    }
    return best;
  }

  // Recently active top-level threads from Codex's state database, or null if it can't be read.
  threads(since) {
    const lib = loadSqlite();
    const file = lib && this.dbFile();
    if (!file) return null;
    let db;
    try {
      db = new lib.DatabaseSync(file, { readOnly: true });
      const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
      if (!cols.has('id') || !cols.has('rollout_path')) return null;
      const updated = cols.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000';
      const where = [`${updated} >= ?`];
      if (cols.has('archived')) where.push('archived = 0');
      if (cols.has('thread_source')) where.push("COALESCE(thread_source, '') NOT LIKE '%subagent%'");
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'").get()) {
        where.push('id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)');
      }
      const title = cols.has('title') ? 'title' : "''";
      const cwd = cols.has('cwd') ? 'cwd' : "''";
      return db.prepare(`SELECT id, rollout_path, ${cwd} AS cwd, ${title} AS title FROM threads WHERE ${where.join(' AND ')}`).all(Math.floor(since));
    } catch (e) {
      if (!this.dbWarned) {
        this.dbWarned = true;
        this.log(`Could not read Codex threads (${e.message}); scanning session folders instead`);
      }
      return null;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
    }
  }

  // Without the database: today's and yesterday's session folders.
  async walk(since) {
    const out = [];
    const pad = (n) => String(n).padStart(2, '0');
    for (const back of [0, 1]) {
      const d = new Date(Date.now() - back * 86400000);
      const dir = path.join(this.folder(), String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const m = ROLLOUT_RE.exec(name);
        if (!m) continue;
        const file = path.join(dir, name);
        if ((await mtimeOf(file)) < since) continue;
        const meta = await this.meta(file);
        if (!meta || isCodexSubagent(meta)) continue;
        out.push({ id: m[1], file, cwd: cleanCwd(meta.cwd), name: null });
      }
    }
    return out;
  }

  async meta(file) {
    if (this.metaCache.has(file)) return this.metaCache.get(file);
    const rec = parseJson(await readFirstLine(file));
    const meta = rec && rec.type === 'session_meta' && rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
    if (meta) this.metaCache.set(file, meta);
    return meta;
  }
}

// ---- Gemini CLI ----
// Logs: ~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl (older versions: .json).
// The project folder's .project_root holds its path.

class GeminiProvider {
  constructor({ home, activeMs = ACTIVE_MS } = {}) {
    this.id = 'gemini';
    this.home = home || path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
    this.activeMs = activeMs;
    this.translate = TRANSLATORS.gemini;
    this.metaCache = new Map();
    this.roots = new Map();
  }

  folder() {
    return path.join(this.home, 'tmp');
  }

  watchRoots() {
    return [this.folder()];
  }

  wholeFile(file) {
    return file.endsWith('.json');
  }

  async discover() {
    const since = Date.now() - this.activeMs;
    let projects;
    try {
      projects = await fsp.readdir(this.folder(), { withFileTypes: true });
    } catch {
      return new Map();
    }
    const out = new Map();
    await Promise.all(
      projects
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const projectDir = path.join(this.folder(), e.name);
          const chats = path.join(projectDir, 'chats');
          let files;
          try {
            files = await fsp.readdir(chats, { withFileTypes: true });
          } catch {
            return;
          }
          // Subagent chats live in sub-folders and are skipped.
          for (const f of files) {
            if (!f.isFile() || !/^session-.*\.jsonl?$/.test(f.name)) continue;
            const file = path.join(chats, f.name);
            const mtime = await mtimeOf(file);
            if (mtime < since) continue;
            const meta = await this.meta(file);
            if (!meta || typeof meta.sessionId !== 'string' || !ID_RE.test(meta.sessionId) || meta.kind === 'subagent') continue;
            const prev = out.get(meta.sessionId);
            if (prev && prev.mtime >= mtime) continue;
            out.set(meta.sessionId, { file, mtime, cwd: await this.projectRoot(projectDir) });
          }
        })
    );
    for (const info of out.values()) delete info.mtime;
    return out;
  }

  async meta(file) {
    if (this.metaCache.has(file)) return this.metaCache.get(file);
    const rec = this.wholeFile(file) ? await readJson(file) : parseJson(await readFirstLine(file));
    const meta = rec && typeof rec === 'object' && rec.sessionId ? { sessionId: rec.sessionId, kind: rec.kind } : null;
    if (meta) this.metaCache.set(file, meta);
    return meta;
  }

  async projectRoot(projectDir) {
    if (this.roots.has(projectDir)) return this.roots.get(projectDir);
    let root = null;
    try {
      root = (await fsp.readFile(path.join(projectDir, '.project_root'), 'utf8')).trim() || null;
    } catch {
      // Older versions: look the folder's short name up in projects.json.
      const map = await readJson(path.join(this.home, 'projects.json'));
      const projects = map && map.projects && typeof map.projects === 'object' ? map.projects : {};
      const name = path.basename(projectDir);
      root = Object.keys(projects).find((p) => projects[p] === name) || null;
    }
    this.roots.set(projectDir, root);
    return root;
  }

  overlay(t, now) {
    const s = t.state;
    const ctx = s.agentCtx;
    const quietMs = ctx && ctx.preamble ? GEMINI_PREAMBLE_QUIET_MS : GEMINI_FINAL_QUIET_MS;
    if (ctx && ctx.pendingFinal && s.lastEventAt != null && now - s.lastEventAt >= quietMs) {
      ctx.pendingFinal = false;
      applyEvent(s, { type: 'assistant.turn_end', timestamp: new Date(s.lastEventAt + quietMs).toISOString() });
      return true;
    }
    if ((s.busy || s.inTurn) && s.lastEventAt != null && now - s.lastEventAt >= STALLED_TURN_MS) {
      if (ctx) ctx.pendingFinal = false;
      applyEvent(s, { type: 'abort', timestamp: new Date(now).toISOString() });
      return true;
    }
    return false;
  }
}

function createProvider(agent, opts = {}) {
  if (agent === 'claude') return new ClaudeProvider(opts);
  if (agent === 'codex') return new CodexProvider(opts);
  if (agent === 'gemini') return new GeminiProvider(opts);
  throw new Error(`Unknown agent "${agent}"`);
}

// ---- Tracking one session's log ----

class AgentTracker extends SessionTracker {
  constructor(id, info, provider) {
    super(id, path.dirname(info.file || '.'));
    this.provider = provider;
    this.info = {};
    this.eventsPath = '';
    this.wholeMtime = null;
    this.update(info);
  }

  // Applies fresh discovery info; returns whether it changed.
  update(info) {
    const before = JSON.stringify(this.info);
    this.info = info;
    if (info.file && info.file !== this.eventsPath) {
      this.eventsPath = info.file;
      this.dir = path.dirname(info.file);
      this.resetLog();
    }
    this.pid = Number.isInteger(info.pid) ? info.pid : null;
    this.applyInfo();
    return JSON.stringify(info) !== before;
  }

  resetLog() {
    this.state = createSessionState(this.id);
    this.offset = 0;
    this.partial = '';
    this.loaded = false;
    this.skipFirstLine = false;
    this.prefixEnd = 0;
    this.wholeMtime = null;
    this.stats = { lines: 0, malformed: 0, core: 0 };
    this.applyInfo();
  }

  applyInfo() {
    const s = this.state;
    const i = this.info;
    if (i.name) s.name = i.name;
    if (i.cwd && !s.cwd) s.cwd = i.cwd;
    if (i.version && !s.cliVersion) s.cliVersion = i.version;
  }

  async refreshWorkspace() {
    this.applyInfo();
  }

  async refreshTodos() {}

  // Copilot-only: its usage records are what the prefix scan looks for.
  async scanPrefixUsage() {}

  formatWarning() {
    const { lines, malformed, core } = this.stats;
    if (lines < FORMAT_CHECK_MIN_LINES) return '';
    const cli = agentInfo(this.provider.id).cli;
    if (malformed / lines > 0.5) return `Unreadable session log — ${cli} format may have changed`;
    if (core === 0) return `Unrecognised session log — ${cli} format may have changed`;
    return '';
  }

  async poll() {
    const applied = this.provider.wholeFile && this.provider.wholeFile(this.eventsPath) ? await this.pollWholeFile() : await super.poll();
    const overlaid = this.provider.overlay ? this.provider.overlay(this, Date.now()) : false;
    return applied || overlaid;
  }

  // Legacy Gemini sessions rewrite one JSON file; re-reading it is safe as messages are de-duplicated.
  async pollWholeFile() {
    const stat = await fsp.stat(this.eventsPath).catch(() => null);
    this.loaded = true;
    if (!stat || stat.mtimeMs === this.wholeMtime) return false;
    this.wholeMtime = stat.mtimeMs;
    const rec = await readJson(this.eventsPath);
    if (!rec) return false;
    this.stats.lines++;
    return this.applyRecord(rec);
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
      const rec = parseJson(line);
      if (!rec || typeof rec !== 'object') {
        this.stats.malformed++;
        continue;
      }
      applied = this.applyRecord(rec) || applied;
    }
    return applied;
  }

  applyRecord(rec) {
    const s = this.state;
    const ctx = s.agentCtx || (s.agentCtx = newContext());
    let events;
    try {
      events = this.provider.translate(rec, ctx);
    } catch {
      this.stats.malformed++;
      return false;
    }
    if (!events.length) return false;
    this.stats.core++;
    for (const e of events) {
      if (e.type === META) {
        if (e.data.summary) s.summary = truncate(e.data.summary, 80);
        if (e.data.name) s.name = truncate(e.data.name, 80);
        continue;
      }
      try {
        applyEvent(s, e);
      } catch {
        this.stats.malformed++;
      }
    }
    // Without a title from the agent, the first prompt names the session.
    if (!s.summary && s.lastPrompt) s.summary = truncate(s.lastPrompt, 60);
    this.applyInfo();
    return true;
  }
}

class AgentSessionWatcher extends SessionWatcher {
  constructor({ agent, provider, home, activeMs, ...opts } = {}) {
    super(opts);
    this.agent = agent;
    this.provider = provider || createProvider(agent, { home, activeMs, log: this.log });
    this.byFile = new Map();
    this.fsWatchers = [];
    this.endedFiles = new Map();
    this.scanning = null;
  }

  noteUnknownType() {}

  // One recursive watch per log root. If any root can't be watched (e.g. it doesn't exist yet),
  // every session is re-read on each poll instead.
  startWatching() {
    const roots = this.provider.watchRoots();
    for (const dir of roots) {
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (_type, filename) => this.onAgentFsChange(dir, filename));
        w.on('error', (e) => {
          this.log(`Watching ${dir} failed, falling back to polling: ${e.message}`);
          this.closeWatchers();
        });
        this.fsWatchers.push(w);
      } catch (e) {
        this.log(`File watching unavailable for ${dir}, using polling: ${e.message}`);
        this.closeWatchers();
        return;
      }
    }
    this.fsWatcher = this.fsWatchers[0] || null;
  }

  closeWatchers() {
    for (const w of this.fsWatchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.fsWatchers = [];
    this.fsWatcher = null;
  }

  stop() {
    super.stop();
    this.closeWatchers();
  }

  onAgentFsChange(root, filename) {
    if (filename) {
      const t = this.byFile.get(path.join(root, String(filename)).toLowerCase());
      if (t) {
        t.dirty = true;
        clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => this.requestTick(), 30);
        return;
      }
    } else {
      for (const t of this.trackers.values()) t.dirty = true;
    }
    // A new session, or a status file changed.
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scan().then(() => this.requestTick()).catch((e) => this.emit('error', e)), 300);
  }

  scan() {
    if (!this.scanning) {
      this.scanning = this.scanOnce().finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  async scanOnce() {
    const live = await this.provider.discover(this);
    for (const [id, info] of live) {
      const t = this.trackers.get(id);
      if (!t) this.trackers.set(id, new AgentTracker(id, info, this.provider));
      else if (t.update(info)) t.dirty = true;
    }
    for (const id of [...this.trackers.keys()]) {
      if (live.has(id)) continue;
      this.markEnded(this.trackers.get(id), Date.now());
      this.trackers.delete(id);
      this.lastStatus.delete(id);
    }
    this.byFile = new Map([...this.trackers.values()].filter((t) => t.eventsPath).map((t) => [t.eventsPath.toLowerCase(), t]));
    this.emitEnded();
  }

  markEnded(t, now) {
    if (t && t.eventsPath) this.endedFiles.set(t.id, t.eventsPath);
    super.markEnded(t, now);
  }

  // Log file of a live or recently ended session.
  logFile(id) {
    const t = this.trackers.get(id);
    return (t && t.eventsPath) || this.endedFiles.get(id) || null;
  }
}

// Folder holding the agent's session logs (tray menu).
function agentLogFolder(agent, copilotSessionState) {
  if (agent === 'copilot' || !agent) return copilotSessionState;
  return createProvider(agent).folder();
}

module.exports = {
  AgentSessionWatcher,
  AgentTracker,
  ClaudeProvider,
  CodexProvider,
  GeminiProvider,
  createProvider,
  agentLogFolder,
  claudeProjectFolder,
  ACTIVE_MS,
  GEMINI_FINAL_QUIET_MS,
  GEMINI_PREAMBLE_QUIET_MS,
  STALLED_TURN_MS,
};
