'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { snapshot } = require('../src/session-state');
const { loadSqlite } = require('../src/todos');
const {
  AgentTracker,
  AgentSessionWatcher,
  ClaudeProvider,
  CodexProvider,
  GeminiProvider,
  claudeProjectFolder,
  GEMINI_FINAL_QUIET_MS,
} = require('../src/agent-watcher');

const T0 = Date.now() - 60000;
const at = (s) => new Date(T0 + s * 1000).toISOString();
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

let tmpRoot;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-agents-'));
});
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function tempDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function append(file, records) {
  fs.appendFileSync(file, jsonl(records));
}

async function trackerFor(provider, file, info = {}) {
  const t = new AgentTracker('s-1', { file, ...info }, provider);
  await t.poll();
  return t;
}

const snap = (t, now = Date.now()) => snapshot(t.state, now);

test('Claude Code: tools, permission waits and finished turns', async () => {
  const dir = tempDir('claude-turn');
  const file = path.join(dir, 's-1.jsonl');
  const cwd = 'C:\\proj';
  fs.writeFileSync(
    file,
    jsonl([
      { type: 'user', cwd, version: '2.1.300', timestamp: at(0), message: { role: 'user', content: '<command-name>/model</command-name>' } },
      { type: 'user', cwd, version: '2.1.300', timestamp: at(1), message: { role: 'user', content: 'fix the failing test' } },
      {
        type: 'assistant',
        cwd,
        timestamp: at(2),
        message: {
          id: 'm1',
          model: 'claude-opus-4-7',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 40 },
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }],
        },
      },
      // The same message's next block repeats its usage.
      {
        type: 'assistant',
        cwd,
        timestamp: at(2),
        message: { id: 'm1', model: 'claude-opus-4-7', stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 }, content: [] },
      },
    ])
  );
  const provider = new ClaudeProvider({ home: dir });
  const t = await trackerFor(provider, file, { pid: 42 });
  let s = snap(t);
  assert.equal(s.status, 'tool');
  assert.equal(s.label, 'Bash');
  assert.equal(s.detail, 'Run tests');
  assert.equal(s.name, 'fix the failing test');
  assert.equal(s.cwd, cwd);
  assert.equal(s.model, 'claude-opus-4-7');
  assert.equal(s.cliVersion, '2.1.300');
  assert.deepEqual([s.usage.outputTokens, s.usage.contextTokens], [50, 1010]);

  // Claude Code reports it is waiting on a prompt for the running tool.
  t.update({ file, pid: 42, status: 'waiting', waitingFor: 'dialog open', statusAt: T0 + 3000 });
  assert.equal(provider.overlay(t, T0 + 4000), true);
  s = snap(t, T0 + 4000);
  assert.equal(s.status, 'approval');
  assert.equal(s.label, 'Approve shell');
  assert.equal(s.detail, 'Run tests');

  append(file, [
    { type: 'user', cwd, timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
    {
      type: 'assistant',
      cwd,
      timestamp: at(6),
      message: { id: 'm2', model: 'claude-opus-4-7', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All tests pass now.' }] },
    },
  ]);
  t.update({ file, pid: 42, status: 'busy', statusAt: T0 + 5000 });
  await t.poll();
  s = snap(t, T0 + 7000);
  assert.equal(s.status, 'idle');
  assert.equal(s.label, 'Done');
  assert.equal(s.detail, 'All tests pass now.');
  assert.deepEqual(
    s.activity.map((a) => [a.title, a.ok]),
    [['Bash', true]]
  );
});

test('Claude Code: an interrupted turn goes idle once Claude reports idle', async () => {
  const dir = tempDir('claude-interrupt');
  const file = path.join(dir, 's-1.jsonl');
  fs.writeFileSync(
    file,
    jsonl([
      { type: 'user', cwd: 'C:\\p', timestamp: at(0), message: { role: 'user', content: 'edit it' } },
      {
        type: 'assistant',
        cwd: 'C:\\p',
        timestamp: at(1),
        message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\p\\a.js' } }] },
      },
    ])
  );
  const provider = new ClaudeProvider({ home: dir });
  const t = await trackerFor(provider, file);
  t.update({ file, status: 'idle', statusAt: T0 + 2000 });
  // Within the grace period the transcript may still be catching up.
  provider.overlay(t, T0 + 3000);
  assert.equal(snap(t, T0 + 3000).status, 'tool');
  provider.overlay(t, T0 + 6000);
  assert.equal(snap(t, T0 + 6000).status, 'idle');

  // An idle status older than the newest prompt doesn't cut the new turn short, and a slow first
  // reply (only logged once complete) doesn't look finished.
  append(file, [{ type: 'user', cwd: 'C:\\p', timestamp: at(10), message: { role: 'user', content: 'again' } }]);
  await t.poll();
  provider.overlay(t, T0 + 40000);
  assert.equal(snap(t, T0 + 40000).status, 'thinking');

  append(file, [{ type: 'user', cwd: 'C:\\p', timestamp: at(12), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]);
  await t.poll();
  assert.equal(snap(t, T0 + 13000).status, 'idle');
  assert.equal(snap(t).files.total, 0);
});

test('Codex: turns, shell exit codes, patches and token usage', async () => {
  const dir = tempDir('codex-turn');
  const file = path.join(dir, 'rollout.jsonl');
  const patch = '*** Begin Patch\n*** Add File: C:\\proj\\b.js\n+x\n*** End Patch';
  fs.writeFileSync(
    file,
    jsonl([
      { timestamp: at(0), type: 'session_meta', payload: { id: 's-1', cwd: '\\\\?\\C:\\proj', cli_version: '0.150.0', source: 'cli' } },
      { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', model_context_window: 200000 } },
      { timestamp: at(0), type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'C:\\proj' } },
      { timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
      { timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a feature' }] } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"npm test"}', call_id: 'c1' } },
    ])
  );
  const t = await trackerFor(new CodexProvider({ home: dir }), file);
  let s = snap(t);
  assert.equal(s.status, 'tool');
  assert.equal(s.label, 'Shell');
  assert.equal(s.detail, 'npm test');
  assert.equal(s.lastPrompt, 'add a feature');
  assert.equal(s.cwd, 'C:\\proj');
  assert.equal(s.model, 'gpt-5.5');

  append(file, [
    { timestamp: at(3), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 1\nWall time: 2s' } },
    { timestamp: at(4), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'c2' } },
    { timestamp: at(5), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Exit code: 0' } },
    {
      timestamp: at(6),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 300 }, last_token_usage: { input_tokens: 5000 }, model_context_window: 200000 } },
    },
    { timestamp: at(7), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Added it.' } },
  ]);
  await t.poll();
  s = snap(t, T0 + 8000);
  assert.equal(s.status, 'idle');
  assert.equal(s.label, 'Done');
  assert.equal(s.detail, 'Added it.');
  assert.deepEqual(
    s.activity.map((a) => [a.title, a.detail, a.ok]),
    [
      ['Apply patch', 'b.js', true],
      ['Shell', 'npm test', false],
    ]
  );
  assert.equal(s.files.total, 1);
  assert.deepEqual([s.usage.outputTokens, s.usage.contextTokens, s.usage.contextLimit, s.usage.premiumRequests], [300, 5000, 200000, 0]);
});

test('Gemini: upserted messages, tools recorded late and a quiet end of turn', async () => {
  const dir = tempDir('gemini-turn');
  const file = path.join(dir, 'session-x.jsonl');
  const provider = new GeminiProvider({ home: dir });
  // Slightly in the future, so polling doesn't count the log as quiet yet.
  const B = Date.now() + 60000;
  const t2 = (s) => new Date(B + s * 1000).toISOString();
  const reply = { id: 'g1', timestamp: t2(2), type: 'gemini', content: 'I will read the file.', model: 'gemini-3-pro', tokens: { input: 900, output: 30, thoughts: 10 } };
  fs.writeFileSync(
    file,
    jsonl([
      { sessionId: 's-1', projectHash: 'h', startTime: t2(0), lastUpdated: t2(0), kind: 'main' },
      { id: 'u1', timestamp: t2(1), type: 'user', content: [{ text: 'make the button blue' }] },
      reply,
    ])
  );
  const t = await trackerFor(provider, file);
  // A reply announcing more work is usually followed by tools that are logged only once they finish.
  assert.equal(provider.overlay(t, B + 2000 + GEMINI_FINAL_QUIET_MS + 1000), false);
  assert.equal(snap(t, B + 3000).status, 'thinking');

  append(file, [
    { ...reply, toolCalls: [{ id: 'read_1', name: 'read_file', args: { file_path: 'a.css' }, status: 'success', displayName: 'ReadFile', timestamp: t2(3) }] },
    { $set: { summary: 'Blue button' } },
    { id: 'g2', timestamp: t2(4), type: 'gemini', content: 'Done, it is blue.', model: 'gemini-3-pro' },
  ]);
  await t.poll();
  let s = snap(t, B + 5000);
  assert.equal(s.status, 'thinking');
  assert.equal(s.name, 'Blue button');
  assert.deepEqual(
    s.activity.map((a) => [a.title, a.detail]),
    [['ReadFile', 'a.css']]
  );
  assert.equal(s.usage.outputTokens, 40);

  assert.equal(provider.overlay(t, B + 4000 + GEMINI_FINAL_QUIET_MS), true);
  s = snap(t, B + 4000 + GEMINI_FINAL_QUIET_MS);
  assert.equal(s.status, 'idle');
  assert.equal(s.label, 'Done');
  assert.equal(s.detail, 'Done, it is blue.');
});

test('Gemini: legacy JSON files are re-read without counting messages twice', async () => {
  const dir = tempDir('gemini-legacy');
  const file = path.join(dir, 'session-y.json');
  const doc = {
    sessionId: 's-1',
    projectHash: 'h',
    messages: [
      { id: 'u1', timestamp: at(0), type: 'user', content: 'hi' },
      { id: 'g1', timestamp: at(1), type: 'gemini', content: 'Hello', tokens: { output: 100 } },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(doc));
  const t = await trackerFor(new GeminiProvider({ home: dir }), file);
  doc.messages.push({ id: 'g2', timestamp: at(2), type: 'gemini', content: 'More', tokens: { output: 5 } });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await t.poll();
  assert.equal(snap(t).usage.outputTokens, 105);
  assert.equal(snap(t).lastPrompt, 'hi');
});

test('Claude Code sessions are found from live PID files', async () => {
  const home = tempDir('claude-home');
  const cwd = path.join(tmpRoot, 'my app');
  fs.mkdirSync(path.join(home, 'sessions'));
  const transcript = path.join(home, 'projects', claudeProjectFolder(cwd), 'live-1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const pidFile = (pid, sessionId, extra = {}) =>
    fs.writeFileSync(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status: 'busy', updatedAt: 1, ...extra }));
  pidFile(process.pid, 'live-1');
  pidFile(2 ** 22 + 12345, 'gone-1');
  const live = await new ClaudeProvider({ home }).discover();
  assert.deepEqual([...live.keys()], ['live-1']);
  assert.equal(live.get('live-1').file, transcript);
  assert.equal(live.get('live-1').pid, process.pid);
});

test('Gemini sessions are found per project, skipping stale and subagent chats', async () => {
  const home = tempDir('gemini-home');
  const project = path.join(home, 'tmp', 'my-app');
  fs.mkdirSync(path.join(project, 'chats', 'parent-id'), { recursive: true });
  fs.writeFileSync(path.join(project, '.project_root'), 'C:\\work\\my-app');
  const meta = (id, kind = 'main') => jsonl([{ sessionId: id, projectHash: 'h', kind }]);
  fs.writeFileSync(path.join(project, 'chats', 'session-2026-a.jsonl'), meta('fresh-1'));
  fs.writeFileSync(path.join(project, 'chats', 'session-2026-b.jsonl'), meta('stale-1'));
  fs.writeFileSync(path.join(project, 'chats', 'parent-id', 'sub-1.jsonl'), meta('sub-1', 'subagent'));
  const old = new Date(Date.now() - 2 * 3600000);
  fs.utimesSync(path.join(project, 'chats', 'session-2026-b.jsonl'), old, old);
  const live = await new GeminiProvider({ home }).discover();
  assert.deepEqual([...live.keys()], ['fresh-1']);
  assert.equal(live.get('fresh-1').cwd, 'C:\\work\\my-app');
});

test('Codex sessions come from its thread database, without subagents or archived threads', { skip: !loadSqlite() }, async () => {
  const home = tempDir('codex-db');
  const rollout = (id) => {
    const file = path.join(home, 'sessions', `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  const db = new (loadSqlite().DatabaseSync)(path.join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, thread_source TEXT);
           CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);`);
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, 0, ?, ?, ?)');
  const now = Date.now();
  insert.run('main-1', rollout('main-1'), '\\\\?\\C:\\proj', 'Add a feature', now, 0, 'user');
  insert.run('child-1', rollout('child-1'), 'C:\\proj', 'review', now, 0, 'user');
  insert.run('archived-1', rollout('archived-1'), 'C:\\proj', 'old', now, 1, 'user');
  insert.run('old-1', rollout('old-1'), 'C:\\proj', 'older', now - 2 * 3600000, 0, 'user');
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('main-1', 'child-1', 'running');
  db.close();
  const live = await new CodexProvider({ home }).discover();
  assert.deepEqual([...live.keys()], ['main-1']);
  assert.deepEqual(live.get('main-1'), { file: rollout('main-1'), cwd: 'C:\\proj', name: 'Add a feature' });
});

test('Without its database, Codex sessions are found in recent session folders', async () => {
  const home = tempDir('codex-walk');
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const id = (n) => `0000000${n}-0000-7000-8000-000000000000`;
  const write = (n, source) =>
    fs.writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${id(n)}.jsonl`), jsonl([{ type: 'session_meta', payload: { id: id(n), cwd: 'C:\\p', source } }]));
  write(1, 'cli');
  write(2, { subagent: 'review' });
  const live = await new CodexProvider({ home }).discover();
  assert.deepEqual([...live.keys()], [id(1)]);
});

test('The agent watcher tags sessions with their agent and remembers ended ones', async () => {
  const home = tempDir('claude-watch');
  fs.mkdirSync(path.join(home, 'sessions'));
  const pidPath = path.join(home, 'sessions', `${process.pid}.json`);
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, sessionId: 'w-1', cwd: tmpRoot, status: 'idle' }));
  const w = new AgentSessionWatcher({ agent: 'claude', home, watch: false });
  let sessions = [];
  w.on('update', (list) => (sessions = list));
  await w.scan();
  await w.tick();
  assert.deepEqual(
    sessions.map((s) => [s.id, s.agent, s.pid]),
    [['w-1', 'claude', process.pid]]
  );
  fs.rmSync(pidPath);
  await w.scan();
  assert.deepEqual(
    w.endedSessions.map((e) => [e.id, e.agent]),
    [['w-1', 'claude']]
  );
  w.stop();
});
