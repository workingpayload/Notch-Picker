'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseQuestion, validateAnswer, answerMessage } = require('../src/questions');
const { ApprovalServer, hookConfig } = require('../src/approval');

const HOOK = path.resolve(__dirname, '../src/hooks/permission-hook.js');

// ask_user arguments as logged by Copilot CLI.
const COLOR_ARGS = {
  message: 'Which color do you prefer?',
  requestedSchema: { properties: { color: { type: 'string', title: 'Color preference', enum: ['red', 'blue'], default: 'red' } } },
};
const FORM_ARGS = {
  message: 'A few choices:',
  requestedSchema: {
    properties: {
      stack: { type: 'string', title: 'Technology', oneOf: [{ const: 'wpf', title: 'C# WPF' }, { const: 'electron', title: 'Electron' }] },
      details: { type: 'array', title: 'Details', items: { enum: ['Status', 'Model', 'Cost'] }, default: ['Status'] },
      notify: { type: 'boolean', title: 'Notify', default: true },
      retries: { type: 'integer', minimum: 0, maximum: 5 },
      name: { type: 'string', title: 'Project name' },
    },
    required: ['stack', 'name'],
  },
};

test('parses ask_user forms into notch fields', () => {
  const q = parseQuestion(FORM_ARGS);
  assert.equal(q.format, 'schema');
  assert.equal(q.message, 'A few choices:');
  assert.deepEqual(
    q.fields.map((f) => [f.key, f.kind, f.required]),
    [
      ['stack', 'choice', true],
      ['details', 'multi', false],
      ['notify', 'boolean', false],
      ['retries', 'number', false],
      ['name', 'text', true],
    ]
  );
  assert.deepEqual(q.fields[0].options, [
    { value: 'wpf', label: 'C# WPF' },
    { value: 'electron', label: 'Electron' },
  ]);
  assert.deepEqual(q.fields[1].default, ['Status']);
  assert.equal(q.fields[3].integer, true);
  assert.equal(parseQuestion(COLOR_ARGS).fields[0].default, 'red');

  const legacy = parseQuestion({ question: 'Pick one', choices: ['a', 'b'], allow_freeform: false });
  assert.equal(legacy.format, 'legacy');
  assert.equal(legacy.fields[0].freeform, false);
  assert.equal(parseQuestion({ question: 'Name?' }).fields[0].kind, 'text');
});

test('forms the notch cannot show are left to the terminal', () => {
  assert.equal(parseQuestion(null), null);
  assert.equal(parseQuestion({ message: 'x', requestedSchema: { properties: { a: { type: 'object' } } } }), null);
  const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, { type: 'string' }]));
  assert.equal(parseQuestion({ message: 'x', requestedSchema: { properties: many } }), null);
  const options = Array.from({ length: 13 }, (_, i) => `o${i}`);
  assert.equal(parseQuestion({ message: 'x', requestedSchema: { properties: { a: { type: 'string', enum: options } } } }), null);
});

test('answers are validated against the form', () => {
  const q = parseQuestion(FORM_ARGS);
  assert.deepEqual(validateAnswer(q, { stack: 'electron', name: ' notch ', details: ['Model', 'Model'], notify: false, retries: '3', extra: 1 }), {
    stack: 'electron',
    name: 'notch',
    details: ['Model'],
    notify: false,
    retries: 3,
  });
  // Choice fields accept a typed ("Other…") answer.
  assert.equal(validateAnswer(q, { stack: 'Tauri', name: 'n' }).stack, 'Tauri');
  assert.equal(validateAnswer(q, { stack: 'wpf' }), null, 'missing required field');
  assert.equal(validateAnswer(q, { stack: 'wpf', name: 'n', details: ['Nope'] }), null, 'unknown option');
  assert.equal(validateAnswer(q, { stack: 'wpf', name: 'n', retries: 9 }), null, 'out of range');
  assert.equal(validateAnswer(q, { stack: 'wpf', name: 'n', retries: 1.5 }), null, 'not an integer');
  assert.equal(validateAnswer(q, { stack: 'wpf', name: 'n', notify: 'yes' }), null, 'wrong type');
  assert.equal(validateAnswer(q, 'electron'), null);

  const strict = parseQuestion({ question: 'Pick', choices: ['a', 'b'], allow_freeform: false });
  assert.equal(validateAnswer(strict, { answer: 'c' }), null);
  assert.match(answerMessage(strict, { answer: 'b' }), /The user's answer: "b"$/);
  assert.match(answerMessage(q, { stack: 'wpf' }), /\{"stack":"wpf"\}$/);
});

test('hook config adds a preToolUse hook limited to ask_user only when questions are on', () => {
  const base = { execPath: 'C:\\app\\Copilot Notch.exe', scriptPath: 'C:\\app\\hook.js', endpointFile: 'C:\\data\\endpoint.json' };
  assert.deepEqual(Object.keys(hookConfig(base).hooks), ['permissionRequest']);
  const both = hookConfig({ ...base, questions: true });
  const entry = both.hooks.preToolUse[0];
  assert.equal(entry.matcher, 'ask_user');
  assert.deepEqual(entry.args, ['C:\\app\\hook.js', 'question']);
  assert.ok(both.hooks.permissionRequest);
  assert.deepEqual(Object.keys(hookConfig({ ...base, permissions: false, questions: true }).hooks), ['preToolUse']);
});

function runQuestionHook(endpointFile, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, 'question'], { env: { ...process.env, COPILOT_NOTCH_ENDPOINT: endpointFile } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('an answer from the notch reaches Copilot as the preToolUse denial reason', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-question-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const endpointFile = path.join(dir, 'endpoint.json');
  const routed = [];
  const server = new ApprovalServer({
    endpointFile,
    route: async (input, type) => {
      routed.push(type);
      return true;
    },
    getTimeoutMs: (type) => (type === 'question' ? 5000 : 1000),
  });
  await server.start();
  t.after(() => server.stop());

  const input = { sessionId: 'sess-q', toolName: 'ask_user', toolArgs: COLOR_ARGS };
  server.once('change', (list) => {
    const q = list[0];
    assert.equal(q.type, 'question');
    assert.equal(q.message, 'Which color do you prefer?');
    assert.equal(server.forSession('sess-q').id, q.id);
    assert.equal(server.decide(q.id, 'allow'), false, 'questions cannot be "approved"');
    assert.equal(server.answer(q.id, { color: 42 }), false, 'invalid answer is refused');
    assert.equal(server.answer(q.id, { color: 'blue' }), true);
  });
  const answered = await runQuestionHook(endpointFile, input);
  assert.equal(answered.code, 0);
  const out = JSON.parse(answered.out);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /answered this question in the Notch Picker app.*\{"color":"blue"\}/);
  assert.deepEqual(routed, ['question']);

  // "Terminal" falls through to the CLI's own prompt.
  server.once('change', (list) => server.decide(list[0].id, 'terminal'));
  assert.deepEqual(await runQuestionHook(endpointFile, input).then((r) => [r.code, r.out]), [0, '']);

  // Other tools (if a CLI ignores the matcher) and unsupported forms are never held.
  assert.deepEqual(await runQuestionHook(endpointFile, { ...input, toolName: 'powershell', toolArgs: {} }).then((r) => r.out), '');
  const complex = { ...input, toolArgs: { message: 'x', requestedSchema: { properties: { a: { type: 'object' } } } } };
  assert.deepEqual(await runQuestionHook(endpointFile, complex).then((r) => r.out), '');
  assert.deepEqual(routed, ['question', 'question']);
  assert.equal(server.list().length, 0);
});
