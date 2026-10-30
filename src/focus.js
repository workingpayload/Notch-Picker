'use strict';

const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'focus-terminal.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const TIMEOUT_MS = 10000;

let inFlight = null;

function runScript(args) {
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        resolve({ ok: !err && out.startsWith('ok'), detail: out || String(stderr || (err && err.message) || '').trim() });
      }
    );
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// Brings the terminal hosting the given Copilot CLI PID to the front. Resolves { ok, detail }.
function focusTerminal(pid) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, detail: 'unsupported platform' });
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, detail: 'no pid' });
  return runScript(['-TargetPid', String(pid)]);
}

// Script arguments for a session inside WSL: the distro, the session folder's name (to choose
// between several windows) and whether it runs in a VS Code terminal.
function wslFocusArgs({ distro, folder, vscode, appPid }) {
  if (!/^[\w.-]{1,64}$/.test(String(distro || ''))) return null;
  const args = ['-WslDistro', distro];
  // A leading '-' would read as a parameter name; quotes don't survive the command line.
  const name = String(folder || '').replace(/["\r\n]/g, '').replace(/^-+/, '').slice(0, 100);
  if (name) args.push('-Folder', name);
  if (vscode) args.push('-VsCode');
  if (Number.isInteger(appPid) && appPid > 0) args.push('-AppPid', String(appPid));
  return args;
}

// Brings the window of a session inside WSL to the front (best effort: see focus-terminal.ps1).
function focusWslTerminal(target) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, detail: 'unsupported platform' });
  const args = wslFocusArgs({ appPid: process.pid, ...target });
  if (!args) return Promise.resolve({ ok: false, detail: 'invalid distro' });
  return runScript(args);
}

module.exports = { focusTerminal, focusWslTerminal, wslFocusArgs, findTerminalWindow };

const terminalCache = new Map(); // pid -> Promise<hwnd number | 0>

// HWND of the terminal window hosting a Copilot CLI PID, without changing focus. Cached per PID
// (a running CLI doesn't move between terminal windows).
function findTerminalWindow(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(0);
  if (terminalCache.has(pid)) return terminalCache.get(pid);
  const pending = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-TargetPid', String(pid), '-FindOnly'],
      { windowsHide: true, timeout: TIMEOUT_MS },
      (err, stdout) => {
        const m = /^found \S+ (\d+)/.exec(String(stdout || '').trim());
        const hwnd = !err && m ? Number(m[1]) : 0;
        if (!hwnd) terminalCache.delete(pid); // retry next time
        resolve(hwnd);
      }
    );
  });
  terminalCache.set(pid, pending);
  return pending;
}
