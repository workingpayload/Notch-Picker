'use strict';

// Copilot CLI sessions running inside WSL distros. Their session-state lives in the distro's Linux
// home and is read through the \\wsl.localhost share; a lock file's PID is a Linux PID, so liveness
// is checked in the distro's /proc instead of with Windows process APIs.
//
// Reading a distro's share keeps it running (WSL counts it as activity), and reading a stopped
// distro's share starts it. So a distro is read on every scan only while it has a live Copilot
// session or a WSL terminal open on Windows; otherwise it is looked at once every IDLE_PROBE_MS,
// which still lets an unused distro shut down. Only distros `wsl.exe --list --running` reported
// are read, and a distro whose terminal closes (wsl --shutdown closes them all) is held back until
// wsl.exe confirms it's still running.

const fsp = require('fs').promises;
const { execFile } = require('child_process');

const SHARES = ['\\\\wsl.localhost\\', '\\\\wsl$\\'];
const RUNNING_TTL_MS = 5000;
const IDLE_PROBE_MS = 30000;
const DISCOVER_TTL_MS = 60000;
const ERROR_RETRY_MS = 60000;
const DISTRO_NAME = /^[\w.-]{1,64}$/;
// Docker Desktop's own distros never hold user sessions.
const SKIP_DISTROS = /^docker-desktop(-data)?$/i;

// wsl.exe prints UTF-16LE unless WSL_UTF8=1 is set.
function decodeWslOutput(out) {
  if (!Buffer.isBuffer(out)) return String(out || '');
  const utf16 = out.length >= 2 && out.includes(0);
  return (utf16 ? out.toString('utf16le') : out.toString('utf8')).replace(/^\uFEFF/, '').replace(/\0/g, '');
}

// Distro names from `wsl.exe --list --running --quiet`.
function parseDistroList(out) {
  return decodeWslOutput(out)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => DISTRO_NAME.test(s) && !SKIP_DISTROS.test(s));
}

// '/home/me/app' in distro 'Ubuntu' -> '\\wsl.localhost\Ubuntu\home\me\app'.
function toWindowsPath(distro, linuxPath, share = SHARES[0]) {
  if (!DISTRO_NAME.test(String(distro)) || typeof linuxPath !== 'string' || !linuxPath.startsWith('/')) return null;
  return share + distro + linuxPath.replace(/\/+$/, '').replace(/\//g, '\\');
}

// '\\wsl.localhost\Ubuntu\home\me' (or \\wsl$\...) -> { distro: 'Ubuntu', linuxPath: '/home/me' }.
function parseWslPath(p) {
  const m = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(String(p || ''));
  if (!m || !DISTRO_NAME.test(m[1])) return null;
  return { distro: m[1], linuxPath: (m[2] || '\\').replace(/\\/g, '/') };
}

// Opens a WSL folder in VS Code through its WSL extension.
function vscodeWslUrl(distro, linuxPath) {
  return `vscode://vscode-remote/wsl+${encodeURIComponent(distro)}${encodeURI(linuxPath)}`;
}

// /proc/<pid>/cmdline of a Copilot CLI: its native binary (whose thread name, and so /proc comm,
// is "MainThread"), or node running the npm package.
function isCopilotCmdline(cmdline) {
  const args = String(cmdline).split('\0').filter(Boolean);
  const base = (s) => s.split('/').pop().toLowerCase();
  if (!args.length) return false;
  if (base(args[0]) === 'copilot') return true;
  return /^node/.test(base(args[0])) && args.length > 1 && /copilot/i.test(args[1]);
}

function runWsl(args) {
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', args, { windowsHide: true, timeout: 5000, encoding: 'buffer' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

class WslLocator {
  constructor({ run = runWsl, fs = fsp, log = () => {}, platform = process.platform } = {}) {
    this.run = run;
    this.fs = fs;
    this.log = log;
    this.supported = platform === 'win32';
    // Open WSL terminals per distro (lower-case name -> count), reported by the full-screen
    // monitor; null when unknown.
    this.clients = null;
    // Distros whose terminal just closed, maybe by wsl --shutdown / --terminate: not read again
    // until wsl.exe confirms they're still running.
    this.held = new Set();
    this.running = { at: -Infinity, list: [] };
    this.pendingRunning = null;
    this.retryAt = -Infinity;
    this.lastProbe = -Infinity;
    this.distros = new Map(); // name -> { at, share, roots }
    this.followed = new Set(); // roots already logged
    this.warned = false;
  }

  // From the monitor: { Ubuntu: 2, ... } or null.
  setClients(map) {
    const next = map && typeof map === 'object' ? new Map() : null;
    if (next) {
      for (const [name, n] of Object.entries(map)) if (DISTRO_NAME.test(name) && n > 0) next.set(name.toLowerCase(), n);
    }
    if (this.clients) {
      for (const [name, n] of this.clients) if (!next || (next.get(name) || 0) < n) this.held.add(name);
    }
    this.clients = next;
  }

  hasTerminal(distro) {
    return !!this.clients && this.clients.has(String(distro).toLowerCase());
  }

  isHeld(distro) {
    return this.held.has(String(distro).toLowerCase());
  }

  isRunning(distro) {
    const name = String(distro).toLowerCase();
    return this.running.list.some((d) => d.toLowerCase() === name);
  }

  // Whether a distro's files can be read now without starting it.
  canRead(distro) {
    return this.supported && !this.isHeld(distro) && this.isRunning(distro);
  }

  // Session-state folders to scan now: [{ distro, share, home, root }]. `liveDistros` are the
  // distros with a live session (Copilot itself keeps those running).
  async roots(liveDistros = new Set(), now = Date.now()) {
    if (!this.supported || now < this.retryAt) return [];
    const probeDue = now - this.lastProbe >= IDLE_PROBE_MS;
    const terminals = this.clients ? [...this.clients.keys()] : [];
    if (!probeDue && !liveDistros.size && !terminals.length && !this.held.size) return [];
    // An open terminal keeps its distro running, so that distro is read without asking wsl.exe.
    // Ask when probing, when a terminal closed, when one opens on a distro not known to be
    // running, and (every few seconds) for live sessions without a terminal the monitor knows,
    // e.g. when it isn't running.
    const held = [...this.held];
    const force = probeDue || held.length > 0;
    const unknown = terminals.some((d) => !this.isRunning(d)) || [...liveDistros].some((d) => !this.hasTerminal(d));
    const fresh = force || unknown ? await this.runningDistros(now, force) : true;
    if (fresh) for (const d of held) this.held.delete(d);
    if (probeDue) this.lastProbe = now;
    const running = this.running.list;
    for (const name of this.distros.keys()) if (!running.includes(name)) this.distros.delete(name);
    const out = [];
    for (const distro of running) {
      if (!this.canRead(distro)) continue;
      if (probeDue || liveDistros.has(distro) || this.hasTerminal(distro)) out.push(...(await this.distroRoots(distro, now)));
    }
    return out;
  }

  // Refreshes the running distros (cached for RUNNING_TTL_MS unless forced). Resolves false when
  // wsl.exe hung, which leaves the previous list in place.
  async runningDistros(now, force = false) {
    if (!force && now - this.running.at < RUNNING_TTL_MS) return true;
    if (this.pendingRunning && !force) return this.pendingRunning;
    // A forced refresh must start after the caller's reason to ask.
    if (this.pendingRunning) await this.pendingRunning;
    this.pendingRunning = this.run(['--list', '--running', '--quiet'])
      .then(
        (out) => {
          this.running = { at: now, list: parseDistroList(out) };
          return true;
        },
        (e) => {
          // A hung wsl.exe (e.g. while WSL starts up) says nothing about what's running, but any
          // other failure must not leave stopped distros listed: reading them would start them.
          // Older WSL versions also fail when no distro is running.
          const timedOut = !!(e && e.killed);
          this.running = { at: now, list: timedOut ? this.running.list : [] };
          if (e && e.code === 'ENOENT') {
            this.retryAt = now + ERROR_RETRY_MS;
            if (!this.warned) this.log('WSL sessions: wsl.exe not found');
            this.warned = true;
          }
          return !timedOut;
        }
      )
      .finally(() => {
        this.pendingRunning = null;
      });
    return this.pendingRunning;
  }

  async distroRoots(distro, now) {
    const known = this.distros.get(distro);
    if (known && now - known.at < DISCOVER_TTL_MS) return known.roots;
    const found = await this.discover(distro);
    // The share didn't answer: keep what was known and try again on the next scan.
    if (!found) return known ? known.roots : [];
    this.distros.set(distro, { at: now, ...found });
    for (const r of found.roots) {
      if (!this.followed.has(r.root)) this.log(`WSL sessions: following ${r.root}`);
      this.followed.add(r.root);
    }
    return found.roots;
  }

  // Every home in the distro with a Copilot session-state folder (~/.copilot/session-state), or
  // null when the share can't be read.
  async discover(distro) {
    for (const share of SHARES) {
      let homes;
      try {
        homes = await this.fs.readdir(`${share}${distro}\\home`);
      } catch {
        continue;
      }
      const roots = [];
      for (const home of [...homes.map((h) => `/home/${h}`), '/root']) {
        const root = toWindowsPath(distro, `${home}/.copilot/session-state`, share);
        const stat = root && (await this.fs.stat(root).catch(() => null));
        if (stat && stat.isDirectory()) roots.push({ distro, share, home, root });
      }
      return { share, roots };
    }
    return null;
  }

  // /proc/<pid>/<file> in a distro: null when there's no such process, undefined when it
  // couldn't be read.
  async readProc(where, pid, file) {
    if (!Number.isInteger(pid) || pid <= 0 || !where || !DISTRO_NAME.test(where.distro)) return null;
    try {
      return await this.fs.readFile(`${where.share || SHARES[0]}${where.distro}\\proc\\${pid}\\${file}`);
    } catch (e) {
      return e && e.code === 'ENOENT' ? null : undefined;
    }
  }

  // true / false, or null when it couldn't be checked.
  async pidIsCopilot(where, pid) {
    const cmdline = await this.readProc(where, pid, 'cmdline');
    if (cmdline === undefined) return null;
    return cmdline !== null && isCopilotCmdline(cmdline);
  }

  // Hints for finding a session's terminal window: { vscode } when it runs in a VS Code terminal.
  async terminalHint(distro, pid) {
    if (!this.canRead(distro)) return { vscode: false };
    const environ = await this.readProc({ distro, share: this.shareOf(distro) }, pid, 'environ');
    const env = String(environ || '').split('\0');
    return { vscode: env.includes('TERM_PROGRAM=vscode') };
  }

  shareOf(distro) {
    const d = this.distros.get(distro);
    return (d && d.share) || SHARES[0];
  }

  // Windows path (on the WSL share) of a Linux path in a distro.
  windowsPath(distro, linuxPath) {
    return toWindowsPath(distro, linuxPath, this.shareOf(distro));
  }
}

module.exports = {
  WslLocator,
  decodeWslOutput,
  parseDistroList,
  toWindowsPath,
  parseWslPath,
  vscodeWslUrl,
  isCopilotCmdline,
  IDLE_PROBE_MS,
};
