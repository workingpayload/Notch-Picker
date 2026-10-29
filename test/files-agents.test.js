'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionState, applyEvent, snapshot, editTargets } = require('../src/session-state');
const { parseLine } = require('../src/fullscreen');

let clock = Date.parse('2026-10-28T10:00:00.000Z');
const ev = (type, data = {}, extra = {}) => ((clock += 1000), { type, data, timestamp: new Date(clock).toISOString(), ...extra });
const start = (id, toolName, args, extra) => ev('tool.execution_start', { toolCallId: id, toolName, arguments: args }, extra);
const done = (id, success = true, extra) => ev('tool.execution_complete', { toolCallId: id, success }, extra);

test('editTargets understands edit, create and apply_patch', () => {
  assert.deepEqual(editTargets('edit', { path: 'C:\\a\\x.js' }), [{ path: 'C:\\a\\x.js', kind: 'edited' }]);
  assert.deepEqual(editTargets('create', { path: 'C:\\a\\new.js' }), [{ path: 'C:\\a\\new.js', kind: 'created' }]);
  assert.deepEqual(editTargets('str_replace_editor', { command: 'create', path: 'p' }), [{ path: 'p', kind: 'created' }]);
  assert.deepEqual(editTargets('str_replace_editor', { command: 'view', path: 'p' }), []);
  assert.deepEqual(editTargets('view', { path: 'p' }), []);
  const patch = [
    '*** Begin Patch',
    '*** Update File: C:\\src\\a.js',
    '@@',
    '-x',
    '+y',
    '*** Add File: C:\\src\\b.js',
    '+new',
    '*** Delete File: C:\\src\\old.js',
    '*** Update File: C:\\src\\c.js',
    '*** Move to: C:\\src\\d.js',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(editTargets('apply_patch', patch), [
    { path: 'C:\\src\\a.js', kind: 'edited' },
    { path: 'C:\\src\\b.js', kind: 'created' },
    { path: 'C:\\src\\old.js', kind: 'deleted' },
    { path: 'C:\\src\\c.js', kind: 'edited' },
    { path: 'C:\\src\\d.js', kind: 'created' },
  ]);
});

test('files changed: only successful edits count, created stays created, subagent edits are attributed', () => {
  const s = createSessionState('s');
  const events = [
    start('1', 'create', { path: 'C:\\w\\new.js' }),
    done('1'),
    start('2', 'edit', { path: 'C:\\w\\NEW.js' }), // same file, different case
    done('2'),
    start('3', 'edit', { path: 'C:\\w\\fail.js' }),
    done('3', false),
    ev('subagent.started', { toolCallId: 'tc', agentDisplayName: 'worker' }, { agentId: 'ag' }),
    start('4', 'edit', { path: 'C:\\w\\lib.js' }, { agentId: 'ag' }),
    done('4', true, { agentId: 'ag' }),
  ];
  for (const e of events) applyEvent(s, e);
  const { files } = snapshot(s, clock);
  assert.equal(files.total, 2);
  assert.deepEqual(
    files.list.map((f) => [f.path, f.kind, f.edits, f.by]),
    [
      ['C:\\w\\lib.js', 'edited', 1, 'worker'],
      ['C:\\w\\NEW.js', 'created', 2, null],
    ]
  );
});

test('subagent tree: running agents with model and tool count, finished ones with totals', () => {
  const s = createSessionState('s');
  applyEvent(s, ev('subagent.started', { toolCallId: 'a', agentDisplayName: 'codemap-frontend', agentDescription: 'Update codemap', model: 'claude-opus-5.5' }, { agentId: 'A' }));
  applyEvent(s, start('t1', 'view', { path: 'x' }, { agentId: 'A' }));
  applyEvent(s, done('t1', true, { agentId: 'A' }));
  applyEvent(s, start('t2', 'grep', { pattern: 'y' }, { agentId: 'A' }));
  applyEvent(s, ev('subagent.started', { toolCallId: 'b', agentDisplayName: 'codemap-backend' }, { agentId: 'B' }));

  let snap = snapshot(s, clock);
  assert.deepEqual(
    snap.agents.map((a) => [a.name, a.model, a.toolCalls]),
    [
      ['codemap-frontend', 'claude-opus-5.5', 2],
      ['codemap-backend', null, 0],
    ]
  );

  applyEvent(s, ev('subagent.completed', { toolCallId: 'a', totalToolCalls: 30, totalTokens: 1172537, durationMs: 183935 }, { agentId: 'A' }));
  applyEvent(s, ev('subagent.failed', { toolCallId: 'b' }, { agentId: 'B' }));
  snap = snapshot(s, clock);
  assert.equal(snap.agents.length, 0);
  assert.deepEqual(
    snap.agentHistory.map((a) => [a.name, a.ok, a.toolCalls, a.tokens, a.durationMs, a.model]),
    [
      ['codemap-backend', false, 0, null, 2000, null],
      ['codemap-frontend', true, 30, 1172537, 183935, 'claude-opus-5.5'],
    ]
  );
});

test('helper lines carry the foreground window handle', () => {
  assert.equal(parseLine('{"quns":5,"fullscreen":null,"fg":1836332}').foreground, 1836332);
  assert.equal(parseLine('{"quns":5,"fullscreen":null}').foreground, 0);
  assert.equal(parseLine('{"quns":5,"fullscreen":null,"fg":"x"}').foreground, 0);
});
