'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ApprovalServer, summarizeRequest, hookResponse, hookConfig, installHook, uninstallHook, HOOK_FILE_NAME } = require('../src/approval');

const HOOK = path.resolve(__dirname, '../src/hooks/permission-hook.js');
const INPUT = {
  hookName: 'permissionRequest',
  sessionId: 'sess-1',
  cwd: 'C:\\work',
  toolName: 'powershell',
  toolInput: { command: 'Remove-Item -Recurse dist' },
  permissionSuggestions: [],
};

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-approval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the real hook script like Copilot CLI does: JSON on stdin, decision on stdout.
function runHook(endpointFile, input = INPUT) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, COPILOT_NOTCH_ENDPOINT: endpointFile } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out, child }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function startServer(t, dir, { route = async () => true, timeoutMs = 5000 } = {}) {
  const endpointFile = path.join(dir, 'endpoint.json');
  const server = new ApprovalServer({ endpointFile, route, getTimeoutMs: () => timeoutMs });
  await server.start();
  t.after(() => server.stop());
  return { server, endpointFile };
}

test('summarizeRequest describes shell, url, file and other requests', () => {
  assert.deepEqual(summarizeRequest('powershell', { command: 'npm test' }), { kind: 'shell', detail: 'npm test', sandboxBypass: false });
  assert.deepEqual(summarizeRequest('web_fetch', { url: 'https://x.dev', requestSandboxBypass: true }), {
    kind: 'url',
    detail: 'https://x.dev',
    sandboxBypass: true,
  });
  assert.deepEqual(summarizeRequest('create', { path: 'C:\\a.js', file_text: 'x' }), { kind: 'write', detail: 'created C:\\a.js', sandboxBypass: false });
  assert.equal(summarizeRequest('mcp_tool', { q: 1 }).detail, '{"q":1}');
  assert.deepEqual(hookResponse('allow'), { behavior: 'allow' });
  assert.equal(hookResponse('deny').behavior, 'deny');
  assert.deepEqual(hookResponse('terminal'), {});
});

test('hook config is written and removed only for our file', (t) => {
  const dir = tmp(t);
  const other = path.join(dir, 'someone-else.json');
  fs.writeFileSync(other, '{}');
  const cfg = hookConfig({ execPath: 'C:\\app\\Copilot Notch.exe', scriptPath: 'C:\\app\\hook.js', endpointFile: 'C:\\data\\endpoint.json' });
  const file = installHook(dir, cfg);
  assert.equal(path.basename(file), HOOK_FILE_NAME);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = written.hooks.permissionRequest[0];
  assert.equal(written.version, 1);
  assert.equal(entry.exec, 'C:\\app\\Copilot Notch.exe');
  assert.deepEqual(entry.args, ['C:\\app\\hook.js']);
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(entry.timeoutSec > 120, 'hook must outlive the longest approval timeout');
  uninstallHook(dir);
  assert.ok(!fs.existsSync(file));
  assert.ok(fs.existsSync(other), 'other hook files are untouched');
});

test('approve and deny from the notch reach the hook output', async (t) => {
  const dir = tmp(t);
  const { server, endpointFile } = await startServer(t, dir);
  const seen = [];
  server.on('change', (list) => {
    for (const r of list) {
      if (seen.includes(r.id)) continue;
      seen.push(r.id);
      assert.equal(r.sessionId, 'sess-1');
      assert.equal(r.kind, 'shell');
      assert.equal(r.detail, 'Remove-Item -Recurse dist');
      assert.deepEqual(server.forSession('sess-1').id, r.id);
      server.decide(r.id, seen.length === 1 ? 'allow' : 'deny');
    }
  });
  const allowed = await runHook(endpointFile);
  assert.equal(allowed.code, 0);
  assert.deepEqual(JSON.parse(allowed.out), { behavior: 'allow' });
  const denied = await runHook(endpointFile);
  assert.equal(JSON.parse(denied.out).behavior, 'deny');
  assert.equal(server.list().length, 0);
});

test('falls through (empty output, exit 0) when not routed, on timeout, or when the notch is gone', async (t) => {
  const dir = tmp(t);
  const notRouted = await startServer(t, dir, { route: async () => false });
  assert.deepEqual(await runHook(notRouted.endpointFile).then((r) => [r.code, r.out]), [0, '']);

  const dir2 = tmp(t);
  const slow = await startServer(t, dir2, { timeoutMs: 300 });
  const started = Date.now();
  assert.deepEqual(await runHook(slow.endpointFile).then((r) => [r.code, r.out]), [0, '']);
  assert.ok(Date.now() - started < 5000);

  // App not running: endpoint file missing, or stale (nothing listening).
  assert.deepEqual(await runHook(path.join(dir, 'missing.json')).then((r) => [r.code, r.out]), [0, '']);
  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ port: 1, token: 'x' }));
  assert.deepEqual(await runHook(stale).then((r) => [r.code, r.out]), [0, '']);
});

test('requests without the right token are rejected, and killed hooks clean up', async (t) => {
  const dir = tmp(t);
  const { server, endpointFile } = await startServer(t, dir, { timeoutMs: 60000 });
  const { port } = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/permission', method: 'POST', headers: { 'X-Notch-Token': 'wrong' } }, (res) =>
      resolve(res.statusCode)
    );
    req.end('{}');
  });
  assert.equal(status, 403);

  // The CLI kills the hook (e.g. its own timeout): the pending request disappears.
  const child = spawn(process.execPath, [HOOK], { env: { ...process.env, COPILOT_NOTCH_ENDPOINT: endpointFile } });
  child.stdin.end(JSON.stringify(INPUT));
  await new Promise((resolve) => server.once('change', resolve));
  assert.equal(server.list().length, 1);
  const cleared = new Promise((resolve) => server.once('change', resolve));
  child.kill();
  await cleared;
  assert.equal(server.list().length, 0);

  server.stop();
  assert.ok(!fs.existsSync(endpointFile), 'endpoint file is removed on stop');
});
