'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionState, applyEvent, deriveStatus, snapshot, STALE_BETWEEN_TURNS_MS } = require('../src/session-state');
const { SessionWatcher, SessionTracker, parseWorkspaceYaml } = require('../src/watcher');

const T0 = Date.parse('2026-10-28T10:00:00.000Z');
let clock = T0;
function ev(type, data = {}, extra = {}) {
  clock += 100;
  return { type, data, timestamp: new Date(clock).toISOString(), ...extra };
}
function run(events) {
  const s = createSessionState('abc12345-0000');
  for (const e of events) applyEvent(s, e);
  return s;
}

test('user message starts thinking; text-only turn end goes idle (Done)', () => {
  const s = run([ev('user.message'), ev('assistant.turn_start'), ev('assistant.message', { content: 'hi', toolRequests: [] })]);
  assert.equal(deriveStatus(s, clock).status, 'thinking');
  applyEvent(s, ev('assistant.turn_end'));
  const st = deriveStatus(s, clock);
  assert.equal(st.status, 'idle');
  assert.equal(st.label, 'Done');
  assert.equal(deriveStatus(s, clock + 120000).label, 'Idle');
});

test('tool execution shows tool title and summarized command', () => {
  const s = run([
    ev('user.message'),
    ev('assistant.turn_start'),
    ev('assistant.message', { toolRequests: [{}] }),
    ev('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', toolTitle: 'Running command', arguments: { command: 'npm   test', description: 'Run tests' } }),
  ]);
  assert.deepEqual(
    (({ status, label, detail }) => ({ status, label, detail }))(deriveStatus(s, clock)),
    { status: 'tool', label: 'Running command', detail: 'Run tests' }
  );
  applyEvent(s, ev('tool.execution_complete', { toolCallId: 't1' }));
  applyEvent(s, ev('assistant.turn_end'));
  // Between tool turns the session is still working.
  assert.equal(deriveStatus(s, clock + 1000).status, 'thinking');
  // But if no new turn starts, it is idle (e.g. after task_complete).
  assert.equal(deriveStatus(s, clock + STALE_BETWEEN_TURNS_MS + 1).status, 'idle');
});

test('permission request takes priority and clears on completion', () => {
  const s = run([
    ev('user.message'),
    ev('tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'rm x' } }),
    ev('permission.requested', { requestId: 'p1', permissionRequest: { kind: 'shell', fullCommandText: 'rm x' } }),
  ]);
  const st = deriveStatus(s, clock);
  assert.equal(st.status, 'approval');
  assert.equal(st.label, 'Approve shell');
  assert.equal(st.detail, 'rm x');
  applyEvent(s, ev('permission.completed', { requestId: 'p1' }));
  assert.equal(deriveStatus(s, clock).status, 'tool');
});

test('ask_user shows waiting for input', () => {
  const s = run([ev('user.message'), ev('tool.execution_start', { toolCallId: 'a', toolName: 'ask_user', arguments: { message: 'Pick one' } })]);
  const st = deriveStatus(s, clock);
  assert.equal(st.status, 'input');
  assert.equal(st.detail, 'Pick one');
});

test('subagents are tracked separately and their permissions surface', () => {
  const s = run([
    ev('user.message'),
    ev('assistant.turn_start'),
    ev('assistant.message', { toolRequests: [] }),
    ev('subagent.started', { toolCallId: 'tc', agentDisplayName: 'worker', agentDescription: 'Do things' }, { agentId: 'ag1' }),
    ev('assistant.turn_end'),
    ev('tool.execution_start', { toolCallId: 'x', toolName: 'view', toolTitle: 'Viewing file', arguments: { path: 'C:\\a\\b.js' } }, { agentId: 'ag1' }),
  ]);
  let st = deriveStatus(s, clock);
  assert.equal(st.status, 'agents');
  assert.equal(st.label, '1 agent working');
  assert.equal(s.agents.get('ag1').tools.get('x').detail, 'b.js');

  applyEvent(s, ev('permission.requested', { requestId: 'p', permissionRequest: { kind: 'write', fileName: 'C:\\a\\c.js' } }, { agentId: 'ag1' }));
  st = deriveStatus(s, clock);
  assert.equal(st.status, 'approval');
  assert.equal(st.detail, 'worker: c.js');

  applyEvent(s, ev('permission.completed', { requestId: 'p' }, { agentId: 'ag1' }));
  applyEvent(s, ev('subagent.completed', { toolCallId: 'tc' }, { agentId: 'ag1' }));
  applyEvent(s, ev('hook.end', {}, { agentId: 'ag1' }));
  applyEvent(s, ev('tool.execution_start', { toolCallId: 'late', toolName: 'view' }, { agentId: 'ag1' }));
  assert.equal(s.agents.size, 0);
  assert.equal(deriveStatus(s, clock).status, 'idle');
});

test('abort, error and shutdown', () => {
  const s = run([ev('user.message'), ev('tool.execution_start', { toolCallId: 't', toolName: 'grep', arguments: { pattern: 'x' } }), ev('abort', { reason: 'user_abort' })]);
  assert.equal(deriveStatus(s, clock).status, 'idle');
  applyEvent(s, ev('session.error', { message: 'Please run /login' }));
  assert.deepEqual([deriveStatus(s, clock).status, deriveStatus(s, clock).detail], ['error', 'Please run /login']);
  applyEvent(s, ev('user.message'));
  assert.equal(deriveStatus(s, clock).status, 'thinking');
  applyEvent(s, ev('session.shutdown'));
  assert.equal(deriveStatus(s, clock).status, 'ended');
});

test('task_complete marks the turn done immediately', () => {
  const s = run([
    ev('session.start', { copilotVersion: '1.0.104' }),
    ev('user.message'),
    ev('assistant.turn_start'),
    ev('assistant.message', { toolRequests: [{}] }),
    ev('tool.execution_start', { toolCallId: 'tc', toolName: 'task_complete', arguments: {} }),
    ev('tool.execution_complete', { toolCallId: 'tc' }),
  ]);
  let st = deriveStatus(s, clock);
  assert.equal(st.status, 'idle');
  assert.equal(st.label, 'Done');
  assert.equal(s.cliVersion, '1.0.104');

  // The session.task_complete event alone is enough too.
  const s2 = run([ev('user.message'), ev('assistant.turn_start'), ev('assistant.message', { toolRequests: [{}] }), ev('session.task_complete'), ev('assistant.turn_end')]);
  st = deriveStatus(s2, clock);
  assert.equal(st.status, 'idle');
  assert.equal(st.label, 'Done');
});

test('usage counts premium requests, output tokens, context and quota', () => {
  const usage = (u, extra) => ev('session.usage_record', { usage: u }, extra);
  const s = run([
    usage({ initiator: 'user', cost: 15, outputTokens: 100, inputTokens: 5000, maxPromptTokens: 200000 }),
    usage({ initiator: 'agent', cost: 15, outputTokens: 50, inputTokens: 9000, maxPromptTokens: 200000 }),
    usage({ initiator: 'agent', cost: 15, outputTokens: 70, inputTokens: 99999 }, { agentId: 'sub' }),
    ev('model.model_call_success', {
      quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 1000, usedRequests: 900, remainingPercentage: 10, resetDate: '2026-11-01T00:00:00Z' } },
    }),
  ]);
  const snap = snapshot(s, clock);
  assert.deepEqual(snap.usage, { premiumRequests: 15, outputTokens: 220, contextTokens: 9000, contextLimit: 200000 });
  assert.equal(snap.quota.remainingPercentage, 10);
  assert.equal(snap.quota.used, 900);

  // A checkpoint total wins when the replayed tail missed earlier records.
  applyEvent(s, ev('session.usage_checkpoint', { totalPremiumRequests: 90 }));
  assert.equal(snapshot(s, clock).usage.premiumRequests, 90);
});

test('last prompt and recent activity are tracked for the main agent', () => {
  const s = run([
    ev('user.message', { content: 'fix   the\nbuild' }),
    ev('tool.execution_start', { toolCallId: 'a', toolName: 'grep', toolTitle: 'Searching files', arguments: { pattern: 'TODO' } }),
    ev('tool.execution_complete', { toolCallId: 'a', success: true }),
    ev('tool.execution_start', { toolCallId: 'b', toolName: 'powershell', toolTitle: 'Running command', arguments: { description: 'Build' } }),
    ev('tool.execution_complete', { toolCallId: 'b', success: false }),
    ev('tool.execution_start', { toolCallId: 'c', toolName: 'view', toolTitle: 'Viewing file', arguments: { path: 'C:\\x\\y.js' } }),
    ev('tool.execution_start', { toolCallId: 'sub', toolName: 'grep', arguments: {} }, { agentId: 'ag' }),
  ]);
  const snap = snapshot(s, clock);
  assert.equal(snap.lastPrompt, 'fix the build');
  assert.deepEqual(
    snap.activity.map((a) => [a.title, a.running ? 'running' : a.ok ? 'ok' : 'failed']),
    [
      ['Viewing file', 'running'],
      ['Running command', 'failed'],
      ['Searching files', 'ok'],
    ]
  );
  assert.equal(snap.activity[1].durationMs, 100);

  for (let i = 0; i < 10; i++) {
    applyEvent(s, ev('tool.execution_start', { toolCallId: `t${i}`, toolName: 'view' }));
    applyEvent(s, ev('tool.execution_complete', { toolCallId: `t${i}` }));
  }
  assert.equal(snapshot(s, clock).activity.length, 5);
});

test('long logs: usage before the replayed tail is still counted, exactly once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usage = (n) => JSON.stringify({ type: 'session.usage_record', data: { usage: { initiator: 'user', cost: 1, outputTokens: 10, inputTokens: n, maxPromptTokens: 1000 } } });
  const filler = JSON.stringify({ type: 'hook.start', data: { pad: 'x'.repeat(50) } });
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(usage(i), filler);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');

  // Try many tail sizes so the tail boundary lands mid-line and exactly on line starts.
  for (let tail = 150; tail < 600; tail += 37) {
    const tracker = new SessionTracker('s', dir, { tailBytes: tail });
    await tracker.poll();
    const snap = snapshot(tracker.state, Date.now());
    assert.equal(snap.usage.premiumRequests, 40, `tail ${tail}`);
    assert.equal(snap.usage.outputTokens, 400, `tail ${tail}`);
    assert.equal(snap.usage.contextTokens, 40, `tail ${tail}: context must come from the newest record`);
  }
});

test('parseWorkspaceYaml reads plain and quoted values', () => {
  const ws = parseWorkspaceYaml(['id: 1\r', 'name: "Fix \\"bug\\""', 'cwd: C:\\Users\\me', "summary: 'it''s'", ''].join('\n'));
  assert.deepEqual(ws, { id: '1', name: 'Fix "bug"', cwd: 'C:\\Users\\me', summary: "it's" });
});

test('watcher tails events incrementally and emits done transitions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sess-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), String(process.pid));
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'name: Demo\ncwd: C:\\demo\n');
  const file = path.join(dir, 'events.jsonl');
  const line = (e) => JSON.stringify({ ...e, timestamp: new Date().toISOString() }) + '\n';
  fs.writeFileSync(file, line({ type: 'user.message', data: {} }) + line({ type: 'assistant.turn_start', data: {} }));

  // A lock for a dead PID must be ignored.
  const dead = path.join(root, 'sess-dead');
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, 'inuse.999999.lock'), '999999');

  const w = new SessionWatcher({ root });
  const transitions = [];
  w.on('transition', (x) => transitions.push(x));
  await w.scan();
  await w.tick();
  let sessions = JSON.parse(w.lastPayload);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, 'Demo');
  assert.equal(sessions[0].status, 'thinking');

  // Write a partial line first to make sure it is buffered until complete.
  const msg = line({ type: 'assistant.message', data: { content: 'All done', toolRequests: [] } });
  fs.appendFileSync(file, msg.slice(0, 10));
  await w.tick();
  fs.appendFileSync(file, msg.slice(10) + line({ type: 'assistant.turn_end', data: {} }));
  await w.tick();
  sessions = JSON.parse(w.lastPayload);
  assert.equal(sessions[0].status, 'idle');
  assert.equal(sessions[0].label, 'Done');
  assert.equal(sessions[0].pid, process.pid);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].kind, 'done');
  w.stop();
});

test('watcher picks up appended events via fs.watch without waiting for polling', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-'));
  const dir = path.join(root, 'sess-w');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), String(process.pid));
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'name: Before\n');
  const file = path.join(dir, 'events.jsonl');
  const line = (e) => JSON.stringify({ ...e, timestamp: new Date().toISOString() }) + '\n';
  fs.writeFileSync(file, line({ type: 'user.message', data: {} }));

  // Polling, rescans and safety re-reads are all far slower than the test timeout.
  const w = new SessionWatcher({ root, pollMs: 60000, scanMs: 60000, fallbackReadMs: 60000 });
  t.after(() => {
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await w.start();
  assert.ok(w.watching, 'fs.watch should be active');
  assert.equal(JSON.parse(w.lastPayload)[0].status, 'thinking');

  const waitFor = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for update')), 3000);
      w.on('update', (sessions) => {
        if (predicate(sessions)) {
          clearTimeout(timer);
          resolve(sessions);
        }
      });
    });

  const started = Date.now();
  const toolRunning = waitFor((s) => s[0].status === 'tool');
  fs.appendFileSync(file, line({ type: 'tool.execution_start', data: { toolCallId: 'x', toolName: 'grep', arguments: { pattern: 'a' } } }));
  await toolRunning;
  assert.ok(Date.now() - started < 1500, 'update should arrive well before the polling interval');

  const renamed = waitFor((s) => s[0].name === 'After');
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'name: After\n');
  await renamed;
});

test('watcher logs unknown event types once and warns on unrecognised formats', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sess-x');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), String(process.pid));
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ type: i % 2 ? 'brand.new_event' : 'other.new_event', data: {} }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');

  const logged = [];
  const w = new SessionWatcher({ root, log: (m) => logged.push(m) });
  await w.scan();
  await w.tick();
  await w.tick();
  const [session] = JSON.parse(w.lastPayload);
  assert.match(session.warning, /format may have changed/);
  assert.equal(logged.filter((m) => m.includes('Unknown Copilot CLI event type')).length, 2);
  assert.equal(logged.filter((m) => m.includes('format may have changed')).length, 1);
  w.stop();
});
