'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { parseTempName, parseReport, FolderTracker, DownloadHub, FRESH_MS, STALL_MS } = require('../src/downloads');
const { DownloadBridge } = require('../src/download-monitor');
const island = require('../src/island');
const { sanitize } = require('../src/settings');

const DIR = path.join(path.parse(process.cwd()).root, 'Users', 'me', 'Downloads');
const at = (name) => path.join(DIR, name);

test('in-progress download files are recognised by browser', () => {
  assert.deepEqual(parseTempName('setup.exe.crdownload'), { suffix: '.crdownload', finalName: 'setup.exe' });
  assert.deepEqual(parseTempName('movie.mkv.part'), { suffix: '.part', finalName: 'movie.mkv' });
  assert.deepEqual(parseTempName('Unconfirmed 812345.crdownload'), { suffix: '.crdownload', finalName: '' });
  assert.equal(parseTempName('report.pdf'), null);
  assert.equal(parseTempName('.part'), null);
});

test('folder downloads show progress and speed, and finish when renamed', () => {
  const t = new FolderTracker();
  const temp = at('big.zip.crdownload');
  const final = at('big.zip');
  const exists = new Map();
  const sizeOf = (p) => (exists.has(p) ? exists.get(p) : -1);
  assert.deepEqual(t.update([{ path: temp, size: 1000, mtimeMs: 0 }], 0, sizeOf), []);
  t.update([{ path: temp, size: 3000, mtimeMs: 1000 }], 1000, sizeOf);
  const [item] = t.list(1000);
  assert.equal(item.name, 'big.zip');
  assert.equal(item.path, final);
  assert.equal(item.state, 'active');
  assert.equal(item.received, 3000);
  assert.equal(item.speed, 2000);

  t.update([{ path: temp, size: 3000, mtimeMs: 1000 }], 1000 + STALL_MS, sizeOf);
  assert.equal(t.list(1000 + STALL_MS)[0].state, 'stalled');

  exists.set(final, 5000);
  assert.deepEqual(t.update([], 20000, sizeOf), [{ name: 'big.zip', path: final }]);
  assert.deepEqual(t.list(20000), []);
});

test('cancelled, abandoned and Firefox-placeholder downloads are not reported as done', () => {
  const t = new FolderTracker();
  const sizes = new Map();
  const sizeOf = (p) => (sizes.has(p) ? sizes.get(p) : -1);
  t.update([{ path: at('a.iso.crdownload'), size: 10, mtimeMs: 0 }], 0, sizeOf);
  assert.deepEqual(t.update([], 1000, sizeOf), [], 'temp gone without a final file: cancelled');

  // Firefox keeps an empty placeholder next to the .part file while it downloads.
  sizes.set(at('b.zip'), 0);
  t.update([{ path: at('b.zip.part'), size: 500, mtimeMs: 0 }], 0, sizeOf);
  assert.deepEqual(t.update([], 1000, sizeOf), [], 'only the empty placeholder is left: cancelled');

  // A leftover from an old crash is hidden until it grows again.
  const old = at('old.bin.crdownload');
  t.update([{ path: old, size: 10, mtimeMs: 0 }], FRESH_MS + 5000, sizeOf);
  assert.deepEqual(t.list(FRESH_MS + 5000), []);
  t.update([{ path: old, size: 20, mtimeMs: FRESH_MS + 6000 }], FRESH_MS + 6000, sizeOf);
  assert.equal(t.list(FRESH_MS + 6000).length, 1);
});

test('a download that finishes between scans still counts once, via the folder event', () => {
  const t = new FolderTracker();
  const temp = at('tiny.txt.crdownload');
  const sizeOf = (p) => (p === at('tiny.txt') ? 42 : -1);
  t.note(temp, 0);
  assert.deepEqual(t.list(0), [], 'not shown until a scan sees it');
  assert.deepEqual(t.update([], 2000, sizeOf), [{ name: 'tiny.txt', path: at('tiny.txt') }]);
  t.note(temp, 2100); // the event for the temp file's removal
  assert.deepEqual(t.update([], 4000, sizeOf), []);
});

const report = (items, extra = {}) => parseReport({ v: 1, source: 'src1', browser: 'Edge', items, ...extra });
const running = (id, received, total, extra = {}) => ({ id, name: 'app.msi', path: at('app.msi'), state: 'in_progress', received, total, ...extra });

test('extension reports become live downloads with exact progress and a single "done"', () => {
  const hub = new DownloadHub();
  assert.deepEqual(hub.report(report([running(1, 100, 1000)]), 0), []);
  hub.report(report([running(1, 600, 1000)]), 1000);
  const [d] = hub.list(1000);
  assert.equal(d.key, 'b:src1:1');
  assert.equal(d.browser, 'Edge');
  assert.equal(d.speed, 500);
  assert.equal(d.etaMs, 800);
  assert.equal(d.canPause, true);

  const done = hub.report(report([{ ...running(1, 1000, 1000), state: 'complete' }]), 2000);
  assert.equal(done.length, 1);
  assert.equal(done[0].ok, true);
  assert.deepEqual(hub.report(report([{ ...running(1, 1000, 1000), state: 'complete' }]), 3000), [], 'announced once');
  assert.equal(hub.finish({ name: 'app.msi', path: at('app.msi'), ok: true }, 3500), null, 'the folder watcher saw the same file');
  assert.equal(hub.list(3500)[0].state, 'done');
});

test('the folder entry gives way to the extension, and user cancels are quiet', () => {
  const hub = new DownloadHub();
  const folder = [
    { key: 'f:1', source: 'folder', name: 'app.msi', path: at('app.msi'), state: 'active', startedAt: 0 },
    { key: 'f:2', source: 'folder', name: '', path: '', state: 'active', startedAt: 0 },
    { key: 'f:3', source: 'folder', name: 'other.zip', path: at('other.zip'), state: 'active', startedAt: 0 },
  ];
  assert.equal(hub.list(0, folder).length, 3);
  hub.report(report([running(1, 1, 10)]), 0);
  assert.deepEqual(hub.list(0, folder).map((d) => d.key), ['b:src1:1', 'f:3']);

  const cancelled = hub.report(report([{ ...running(1, 1, 10), state: 'interrupted', error: 'USER_CANCELED' }]), 1000);
  assert.deepEqual(cancelled, []);
  const failed = hub.report(report([{ ...running(2, 1, 10), state: 'interrupted', error: 'NETWORK_FAILED', canResume: true }]), 1000);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].ok, false);
});

test('pause, resume and cancel are queued for the browser that reported the download', () => {
  const hub = new DownloadHub();
  hub.report(report([running(7, 1, 10)]), 0);
  assert.equal(hub.command('b:src1:7', 'pause'), true);
  assert.equal(hub.command('b:src1:7', 'cancel'), true);
  assert.equal(hub.command('b:src1:8', 'pause'), false, 'unknown download');
  assert.equal(hub.command('b:src1:7', 'delete'), false, 'unknown action');
  assert.deepEqual(hub.takeCommands('src1'), [{ id: 7, action: 'cancel' }], 'the latest click wins');
  assert.deepEqual(hub.takeCommands('src1'), []);

  // A failed, resumable download can be retried from the finished list.
  const [ev] = hub.report(report([{ ...running(7, 5, 10), state: 'interrupted', error: 'NETWORK_FAILED', canResume: true }]), 1000);
  assert.equal(hub.command(ev.key, 'resume'), true);
  assert.deepEqual(hub.takeCommands('src1'), [{ id: 7, action: 'resume' }]);
  hub.report(report([running(7, 6, 10)]), 2000);
  assert.deepEqual(hub.list(2000).map((d) => d.key), ['b:src1:7'], 'running again: the failure is gone');

  // A browser that stops reporting was closed.
  assert.equal(hub.list(60000).length, 0);
});

test('extension reports are validated', () => {
  assert.equal(parseReport(null), null);
  assert.equal(parseReport({ v: 2, source: 'a', items: [] }), null);
  assert.equal(parseReport({ v: 1, source: 'bad id!', items: [] }), null);
  const r = parseReport({ v: 1, source: 'a', browser: 'Chrome\n', items: [{ id: 1, state: 'weird' }, { id: 2, state: 'in_progress', path: 'C:\\x\\a.zip', received: -5, error: 'net<b>' }] });
  assert.equal(r.browser, 'Chrome');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'a.zip');
  assert.equal(r.items[0].received, 0);
  assert.equal(r.items[0].error, 'NETB');
  const unsafe = parseReport({ v: 1, source: 'a', items: ['\\\\host\\share\\a.exe', '\\\\?\\C:\\a.exe', 'relative\\a.exe'].map((p, id) => ({ id, state: 'in_progress', path: p })) });
  assert.deepEqual(unsafe.items.map((i) => i.path), ['', '', ''], 'network, device and relative paths are dropped');
});

test('a failed or paused browser download does not come back as a folder download', () => {
  const hub = new DownloadHub();
  const folder = [{ key: 'f:1', source: 'folder', name: 'app.msi', path: at('app.msi'), state: 'stalled', startedAt: 0 }];
  hub.report(report([{ ...running(1, 5, 10), state: 'interrupted', error: 'NETWORK_FAILED', canResume: true }]), 0);
  hub.report(report([]), 90000); // the extension stopped reporting it a while ago
  assert.deepEqual(hub.list(90000, folder).map((d) => d.key), [], 'its leftover .crdownload stays hidden');
  hub.report(report([running(1, 6, 10)]), 95000);
  hub.report(report([]), 96000);
  assert.deepEqual(hub.list(96000, folder).map((d) => d.key), ['f:1'], 'running again: the folder may show it');
});

function request(port, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/notch-picker/report', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('the bridge only accepts the browser extension', async () => {
  const reports = [];
  const bridge = new DownloadBridge({ onReport: (r) => (reports.push(r), [{ id: 1, action: 'pause' }]) });
  const port = await bridge.start();
  assert.ok(port, 'listening');
  try {
    const body = { v: 1, source: 's', browser: 'Chrome', items: [] };
    const ext = { Origin: 'chrome-extension://abcdef', 'X-Notch-Picker': '1', 'Content-Type': 'application/json' };
    assert.equal((await request(port, { headers: { 'Content-Type': 'application/json' }, body })).status, 403, 'no header');
    assert.equal((await request(port, { headers: { ...ext, Origin: 'https://evil.example' }, body })).status, 403, 'web page');
    assert.equal((await request(port, { headers: { ...ext, Host: 'evil.example' }, body })).status, 403, 'DNS rebinding');
    const pre = await request(port, { method: 'OPTIONS', headers: { Origin: 'moz-extension://x-1', 'Access-Control-Request-Headers': 'x-notch-picker' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'moz-extension://x-1');
    assert.equal((await request(port, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
    const ok = await request(port, { headers: ext, body });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { app: 'notch-picker', v: 1, commands: [{ id: 1, action: 'pause' }] });
    assert.equal(reports.length, 1);
    assert.equal((await request(port, { headers: ext, body: { v: 1 } })).status, 400);
  } finally {
    bridge.stop();
  }
});

test('downloads are a live activity in the island, after a timer and before media', () => {
  const dl = [
    { key: 'a', name: 'a.zip', state: 'active', received: 250, total: 1000, speed: 250, etaMs: 0 },
    { key: 'b', name: 'b.zip', state: 'done' },
  ];
  const sum = island.downloadSummary(dl);
  assert.equal(sum.name, 'a.zip');
  assert.equal(sum.progress, 0.25);
  assert.equal(sum.etaMs, 3000);
  assert.equal(island.downloadSummary([{ ...dl[0], total: 0 }]).progress, null, 'unknown size');
  assert.equal(island.downloadSummary([dl[1]]), null, 'nothing running');
  assert.equal(island.downloadSummary([{ ...dl[0], state: 'stalled' }]).paused, false, 'stalled is not paused');

  const timer = { mode: 'timer', durationMs: 60000, accumulatedMs: 0, runningSince: 1 };
  const media = { title: 'Song', status: 'playing' };
  const plan = island.planIsland({ sessions: [], timer, media, downloads: dl });
  assert.equal(plan.primary.kind, 'timer');
  assert.equal(plan.secondary.kind, 'download');
  assert.equal(plan.more, 1);
  assert.equal(island.planIsland({ downloads: dl, media }).primary.kind, 'download');
});

test('download sizes, times and banners read well', () => {
  assert.equal(island.formatBytes(0), '0 B');
  assert.equal(island.formatBytes(1536), '1.5 KB');
  assert.equal(island.formatBytes(12345678), '12.3 MB');
  assert.equal(island.formatBytes(2.5e9), '2.5 GB');
  assert.equal(island.formatRate(2100000), '2.1 MB/s');
  assert.equal(island.formatEta(8200), '9 s left');
  assert.equal(island.formatEta(185000), '3 min left');
  assert.equal(island.formatEta(3900000), '1 h 5 min left');
  assert.equal(island.formatEta(0), '');

  const ok = island.downloadBanner({ key: 'r:1', name: 'a.zip', browser: 'Edge', ok: true, openable: true });
  assert.equal(ok.title, 'Downloaded');
  assert.equal(ok.subtitle, 'a.zip · Edge');
  assert.equal(ok.downloadKey, 'r:1');
  const failed = island.downloadBanner({ key: 'r:2', name: 'a.zip', ok: false, error: 'NETWORK_FAILED' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.subtitle, 'a.zip · Network error');
});

test('extra download folders must be absolute paths', () => {
  const abs = path.join(path.parse(process.cwd()).root, 'Downloads');
  const out = sanitize({ downloadFolders: `${abs}; relative\\dir; "${abs}"; ${abs}2` });
  assert.deepEqual(out.downloadFolders, [abs, `${abs}2`]);
  assert.deepEqual(sanitize({ downloadFolders: 42 }).downloadFolders, []);
});

test('the extension installs with a Chromium manifest and a separate Firefox one', () => {
  const fs = require('fs');
  const os = require('os');
  const { installExtension } = require('../src/download-monitor');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ext-'));
  try {
    installExtension(path.join(__dirname, '..', 'src', 'browser-extension'), dest);
    const read = (...p) => JSON.parse(fs.readFileSync(path.join(dest, ...p), 'utf8'));
    const chromium = read('manifest.json');
    const firefox = read('firefox', 'manifest.json');
    assert.deepEqual(chromium.background, { service_worker: 'background.js' });
    assert.equal('browser_specific_settings' in chromium, false);
    assert.deepEqual(firefox.background, { scripts: ['background.js'] });
    assert.equal(firefox.browser_specific_settings.gecko.id, 'downloads@notch-picker');
    assert.equal(firefox.manifest_version, 3);
    for (const f of ['background.js', 'icon-16.png', 'icon-48.png', 'icon-128.png']) {
      assert.ok(fs.existsSync(path.join(dest, f)) && fs.existsSync(path.join(dest, 'firefox', f)), f);
    }
    // Installing again over an existing copy (app update) works.
    installExtension(path.join(__dirname, '..', 'src', 'browser-extension'), dest);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
