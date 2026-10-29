'use strict';

const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'focus-terminal.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const TIMEOUT_MS = 10000;

let inFlight = null;

// Brings the terminal hosting the given Copilot CLI PID to the front. Resolves { ok, detail }.
function focusTerminal(pid) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, detail: 'unsupported platform' });
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, detail: 'no pid' });
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-TargetPid', String(pid)],
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

module.exports = { focusTerminal, findTerminalWindow };

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
