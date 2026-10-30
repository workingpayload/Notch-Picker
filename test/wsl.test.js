'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionWatcher } = require('../src/watcher');
const { wslFocusArgs } = require('../src/focus');
const {
  WslLocator,
  parseDistroList,
  toWindowsPath,
  parseWslPath,
  vscodeWslUrl,
  isCopilotCmdline,
  IDLE_PROBE_MS,
} = require('../src/wsl');

const SHARE = '\\\\wsl.localhost\\';
const ROOT = `${SHARE}Ubuntu\\home\\me\\.copilot\\session-state`;
const DEBIAN_ROOT = `${SHARE}Debian\\home\\dev\\.copilot\\session-state`;

test('running distros are read from wsl.exe output in UTF-16 or UTF-8', () => {
  const utf16 = Buffer.from('\uFEFFUbuntu-22.04\r\ndocker-desktop\r\nDebian\r\n', 'utf16le');
  assert.deepEqual(parseDistroList(utf16), ['Ubuntu-22.04', 'Debian']);
  assert.deepEqual(parseDistroList(Buffer.from('Ubuntu\ndocker-desktop-data\n')), ['Ubuntu']);
  assert.deepEqual(parseDistroList(Buffer.from('There are no running distributions.\r\n', 'utf16le')), []);
});

test('Linux paths map to the WSL share and back', () => {
  assert.equal(toWindowsPath('Ubuntu', '/home/me/app/'), `${SHARE}Ubuntu\\home\\me\\app`);
  assert.equal(toWindowsPath('Ubuntu', 'relative/path'), null);
  assert.equal(toWindowsPath('bad name', '/x'), null);
  assert.deepEqual(parseWslPath(`${SHARE}Ubuntu\\home\\me`), { distro: 'Ubuntu', linuxPath: '/home/me' });
  assert.deepEqual(parseWslPath('\\\\wsl$\\Debian'), { distro: 'Debian', linuxPath: '/' });
  assert.equal(parseWslPath('C:\\Users\\me'), null);
  assert.equal(vscodeWslUrl('Ubuntu-22.04', '/home/me/my app'), 'vscode://vscode-remote/wsl+Ubuntu-22.04/home/me/my%20app');
});

test('a WSL lock is live only for a Copilot CLI process', () => {
  // The native binary (its /proc comm is "MainThread"), and node running the npm package.
  assert.ok(isCopilotCmdline('/home/me/.nvm/lib/node_modules/@github/copilot-linux-x64/copilot\0'));
  assert.ok(isCopilotCmdline('node\0/home/me/.nvm/versions/node/v24/bin/copilot\0'));
  assert.ok(!isCopilotCmdline('node\0/srv/server.js\0'));
  assert.ok(!isCopilotCmdline('/bin/bash\0'));
  assert.ok(!isCopilotCmdline(''));
});

function fakeWsl({ running = 'Ubuntu\nDebian\n' } = {}) {
  const state = { running, runs: 0, fs: [], failShare: false, procError: null };
  const fail = (code) => Object.assign(new Error(code), { code });
  const dirs = {
    [`${SHARE}Ubuntu\\home`]: ['me'],
    [ROOT]: [],
    [`${SHARE}Debian\\home`]: ['dev'],
    [DEBIAN_ROOT]: [],
  };
  const fsFake = {
    readdir: async (p) => {
      state.fs.push(p);
      if (state.failShare) throw fail('EIO');
      if (dirs[p]) return dirs[p];
      throw fail('ENOENT');
    },
    stat: async (p) => {
      state.fs.push(p);
      if (dirs[p]) return { isDirectory: () => true };
      throw fail('ENOENT');
    },
    readFile: async (p) => {
      state.fs.push(p);
      if (state.procError) throw fail(state.procError);
      if (p.endsWith('\\proc\\42\\cmdline')) return Buffer.from('/home/me/copilot-linux-x64/copilot\0');
      throw fail('ENOENT');
    },
  };
  const loc = new WslLocator({
    platform: 'win32',
    fs: fsFake,
    run: async () => {
      state.runs++;
      if (state.running instanceof Error) throw state.running;
      return Buffer.from(state.running);
    },
  });
  return { loc, state };
}

const rootsOf = async (loc, live, now) => (await loc.roots(new Set(live), now)).map((r) => r.root);

test('idle distros are only probed now and then, so WSL can still shut them down', async () => {
  const { loc, state } = fakeWsl();
  // Nothing live and no WSL terminal open: one probe finds the session-state folders...
  assert.deepEqual(await rootsOf(loc, [], 1000), [ROOT, DEBIAN_ROOT]);
  assert.equal(state.runs, 1);
  // ...then nothing (not even wsl.exe) until the next probe is due.
  const touched = state.fs.length;
  assert.deepEqual(await rootsOf(loc, [], 2000), []);
  assert.equal(state.runs, 1);
  assert.equal(state.fs.length, touched);
  assert.equal((await rootsOf(loc, [], 1000 + IDLE_PROBE_MS)).length, 2);
  assert.equal(state.runs, 2);
});

test('only distros with a live session or their own open terminal are read on every scan', async () => {
  const { loc, state } = fakeWsl();
  await loc.roots(new Set(), 1000);
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 2000), [ROOT]);
  assert.deepEqual(await rootsOf(loc, [], 3000), []);
  // A terminal on Debian keeps Debian (only) read, and needs no wsl.exe call: it keeps it running.
  loc.setClients({ Debian: 1 });
  assert.deepEqual(await rootsOf(loc, [], 4000), [DEBIAN_ROOT]);
  assert.deepEqual(await rootsOf(loc, [], 20000), [DEBIAN_ROOT]);
  assert.equal(state.runs, 1);
});

test('a distro whose terminal closes is not read until wsl.exe says it still runs', async () => {
  const { loc, state } = fakeWsl();
  await loc.roots(new Set(), 1000);
  loc.setClients({ Ubuntu: 2 });
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 2000), [ROOT]);

  // One of two tabs closed: checked once, still running, read again.
  loc.setClients({ Ubuntu: 1 });
  assert.equal(loc.canRead('Ubuntu'), false);
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 3000), [ROOT]);
  assert.equal(state.runs, 2);
  assert.equal(loc.canRead('Ubuntu'), true);

  // wsl --shutdown: its terminals close and it's never touched again (that would restart it).
  state.running = '';
  loc.setClients({});
  assert.equal(loc.canRead('Ubuntu'), false);
  const touched = state.fs.length;
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 4000), []);
  assert.equal(state.fs.length, touched);
  assert.equal(loc.canRead('Ubuntu'), false);
});

test('stopped distros are never touched (reading their share would start them)', async () => {
  const { loc, state } = fakeWsl({ running: '' });
  assert.deepEqual(await loc.roots(new Set(['Ubuntu']), 1000), []);
  assert.deepEqual(state.fs, []);

  // wsl.exe failing (e.g. older versions with nothing running) lists nothing.
  const failing = fakeWsl({ running: Object.assign(new Error('exit 1'), { code: 1 }) });
  assert.deepEqual(await failing.loc.roots(new Set(), 1000), []);
  assert.deepEqual(failing.state.fs, []);
});

test('a hung wsl.exe keeps the last known distros, but a held distro stays unread', async () => {
  const { loc, state } = fakeWsl();
  await loc.roots(new Set(), 1000);
  state.running = Object.assign(new Error('timed out'), { killed: true });
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 10000), [ROOT]);

  loc.setClients({ Ubuntu: 1 });
  loc.setClients({});
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 11000), []);
  assert.equal(loc.isHeld('Ubuntu'), true);
});

test('share hiccups keep known folders and report unknown liveness', async () => {
  const { loc, state } = fakeWsl();
  await loc.roots(new Set(), 1000);
  state.failShare = true;
  assert.deepEqual(await rootsOf(loc, ['Ubuntu'], 100000), [ROOT, DEBIAN_ROOT]);

  const where = { distro: 'Ubuntu', share: SHARE };
  assert.equal(await loc.pidIsCopilot(where, 42), true);
  assert.equal(await loc.pidIsCopilot(where, 43), false);
  state.procError = 'EIO';
  assert.equal(await loc.pidIsCopilot(where, 42), null);
});
test('focus arguments for a WSL session are sanitised', () => {
  assert.deepEqual(wslFocusArgs({ distro: 'Ubuntu', folder: '-VsCode"x', vscode: true, appPid: 12 }), [
    '-WslDistro',
    'Ubuntu',
    '-Folder',
    'VsCodex',
    '-VsCode',
    '-AppPid',
    '12',
  ]);
  assert.equal(wslFocusArgs({ distro: 'x; calc' }), null);
});

test('watcher follows WSL sessions, which file watching does not reach', async (t) => {
  const winRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-win-'));
  const wslRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-wsl-'));
  const dir = path.join(wslRoot, 'wsl-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'inuse.4242.lock'), '4242');
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'name: Linux work\ncwd: /home/me/app\n');
  const file = path.join(dir, 'events.jsonl');
  const line = (e) => JSON.stringify({ ...e, timestamp: new Date().toISOString() }) + '\n';
  fs.writeFileSync(file, line({ type: 'user.message', data: {} }));

  let alive = true; // false: not Copilot; null: couldn't be checked
  let readable = true;
  let held = false;
  const wsl = {
    roots: async () => (readable ? [{ distro: 'Ubuntu', share: SHARE, home: '/home/me', root: wslRoot }] : []),
    // The lock's PID is checked in the distro, not as a Windows PID.
    pidIsCopilot: async (where, pid) => (where.distro === 'Ubuntu' && pid === 4242 ? alive : false),
    canRead: () => readable,
    isHeld: () => held,
  };
  // Safety re-reads are far slower than the test.
  const w = new SessionWatcher({ root: winRoot, wsl, pollMs: 60000, scanMs: 60000, fallbackReadMs: 60000 });
  t.after(() => {
    w.stop();
    fs.rmSync(winRoot, { recursive: true, force: true });
    fs.rmSync(wslRoot, { recursive: true, force: true });
  });
  w.startWatching();
  assert.ok(w.watching);
  await w.scan();
  await w.tick();
  let [s] = JSON.parse(w.lastPayload);
  assert.equal(s.name, 'Linux work');
  assert.equal(s.wsl, 'Ubuntu');
  assert.equal(s.pid, 4242);
  assert.equal(s.cwd, '/home/me/app');
  assert.equal(w.sessionDir('wsl-1'), dir);

  // Re-read on every tick, without file-watch events.
  fs.appendFileSync(file, line({ type: 'tool.execution_start', data: { toolCallId: 'x', toolName: 'grep', arguments: { pattern: 'a' } } }));
  await w.tick();
  [s] = JSON.parse(w.lastPayload);
  assert.equal(s.status, 'tool');

  // Held back (its terminal just closed, maybe by wsl --shutdown): not read, but not ended either.
  readable = false;
  held = true;
  fs.appendFileSync(file, line({ type: 'tool.execution_complete', data: { toolCallId: 'x', success: true } }));
  await w.scan();
  await w.tick();
  assert.ok(w.trackers.has('wsl-1'));
  assert.equal(JSON.parse(w.lastPayload)[0].status, 'tool');
  readable = true;
  held = false;
  await w.tick();
  assert.notEqual(JSON.parse(w.lastPayload)[0].status, 'tool');

  // Liveness that couldn't be checked, or a failed read of the folder, doesn't end the session.
  alive = null;
  await w.scan();
  assert.ok(w.trackers.has('wsl-1'));
  alive = true;
  fs.renameSync(wslRoot, `${wslRoot}-away`);
  try {
    await w.scan();
  } finally {
    fs.renameSync(`${wslRoot}-away`, wslRoot);
  }
  assert.ok(w.trackers.has('wsl-1'));

  // The CLI exits: listed as recently ended, still marked as WSL.
  alive = false;
  await w.scan();
  assert.equal(w.trackers.size, 0);
  assert.equal(w.endedSessions[0].wsl, 'Ubuntu');
  assert.equal(w.sessionDir('wsl-1'), dir);
});
