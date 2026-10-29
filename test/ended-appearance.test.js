'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionWatcher } = require('../src/watcher');
const { sanitize, DEFAULTS } = require('../src/settings');

const line = (type, data = {}) => JSON.stringify({ type, data, timestamp: new Date().toISOString() }) + '\n';

function makeSession(root, id, name) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), String(process.pid));
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `name: ${name}\ncwd: C:\\work\\${id}\n`);
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    line('user.message', { content: `do ${name}` }) +
      line('session.usage_record', { usage: { initiator: 'user', cost: 3 } }) +
      line('assistant.message', { content: `finished ${name}`, toolRequests: [] }) +
      line('assistant.turn_end')
  );
  return dir;
}

test('sessions that end are listed as recently ended until resumed, dismissed or expired', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-ended-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = makeSession(root, 'aaa', 'Alpha');
  const b = makeSession(root, 'bbb', 'Beta');
  const c = makeSession(root, 'ccc', 'Gamma');

  const w = new SessionWatcher({ root, watch: false, endedTtlMs: 60000 });
  let ended = [];
  w.on('ended', (list) => (ended = list));
  await w.scan();
  await w.tick();
  assert.equal(JSON.parse(w.lastPayload).length, 3);
  assert.deepEqual(ended, [], 'nothing ended yet');

  // Clean exit: shutdown event.
  fs.appendFileSync(path.join(a, 'events.jsonl'), line('session.shutdown'));
  // Crash: lock file disappears without a shutdown event.
  fs.rmSync(path.join(b, `inuse.${process.pid}.lock`));
  await w.scan();
  await w.tick();
  assert.deepEqual(JSON.parse(w.lastPayload).map((s) => s.name), ['Gamma']);
  assert.deepEqual(ended.map((e) => e.name).sort(), ['Alpha', 'Beta']);
  const alpha = ended.find((e) => e.name === 'Alpha');
  assert.equal(alpha.lastPrompt, 'do Alpha');
  assert.equal(alpha.summary, 'finished Alpha');
  assert.equal(alpha.premiumRequests, 3);
  assert.equal(alpha.cwd, 'C:\\work\\aaa');

  // Resuming Alpha makes it live again and removes it from the list.
  fs.appendFileSync(path.join(a, 'events.jsonl'), line('session.resume') + line('user.message', { content: 'again' }));
  await w.tick();
  assert.deepEqual(ended.map((e) => e.name), ['Beta']);

  w.dismissEnded('bbb');
  assert.deepEqual(ended, []);

  // Expiry after the TTL.
  fs.appendFileSync(path.join(c, 'events.jsonl'), line('session.shutdown'));
  await w.tick();
  assert.deepEqual(ended.map((e) => e.name), ['Gamma']);
  w.emitEnded(Date.now() + 61000);
  assert.deepEqual(ended, []);
});

test('sessions already ended at startup are not listed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-ended-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = makeSession(root, 'old', 'Old');
  fs.appendFileSync(path.join(a, 'events.jsonl'), line('session.shutdown'));
  const w = new SessionWatcher({ root, watch: false });
  await w.scan();
  await w.tick();
  fs.rmSync(path.join(a, `inuse.${process.pid}.lock`));
  await w.scan();
  assert.deepEqual(w.endedSessions, []);
});

test('appearance settings are validated', () => {
  assert.equal(DEFAULTS.theme, 'dark');
  assert.equal(DEFAULTS.position, 'center');
  assert.equal(sanitize({ theme: 'system' }).theme, 'system');
  assert.equal(sanitize({ theme: 'neon' }).theme, 'dark');
  assert.equal(sanitize({ position: 'right', offsetX: '-120' }).offsetX, -120);
  assert.equal(sanitize({ opacity: 10 }).opacity, 50);
  assert.equal(sanitize({ offsetX: 1e9 }).offsetX, 4000);
});
