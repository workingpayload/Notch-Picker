'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AlertTracker, stuckKind } = require('../src/alerts');
const { Settings, DEFAULTS, sanitize } = require('../src/settings');

const settings = { ...DEFAULTS, notifyDelaySeconds: 5, stuckToolMinutes: 10, stuckApprovalMinutes: 3 };
const T = 1_000_000_000_000;
const session = (over) => ({ id: 's1', name: 'Demo', status: 'approval', label: 'Approve shell', detail: 'rm x', since: T, ...over });

test('attention alert fires once after the delay, and again for a new request', () => {
  const a = new AlertTracker();
  assert.deepEqual(a.update([session()], T + 4000, settings), []);
  assert.deepEqual(a.update([session()], T + 5000, settings).map((x) => x.kind), ['attention']);
  assert.deepEqual(a.update([session()], T + 9000, settings), []);
  // Answered, then a new approval request starts later.
  assert.deepEqual(a.update([session({ status: 'tool', since: T + 9500 })], T + 10000, settings), []);
  assert.deepEqual(a.update([session({ since: T + 20000 })], T + 26000, settings).map((x) => x.kind), ['attention']);
});

test('approval answered before the delay never alerts', () => {
  const a = new AlertTracker();
  a.update([session()], T + 2000, settings);
  assert.deepEqual(a.update([session({ status: 'thinking', since: T + 3000 })], T + 8000, settings), []);
});

test('stuck tool and overdue approval are detected once', () => {
  const a = new AlertTracker();
  const tool = session({ status: 'tool', label: 'Running command' });
  assert.equal(stuckKind(tool, T + 9 * 60000, settings), null);
  assert.equal(stuckKind(tool, T + 10 * 60000, settings), 'tool');
  assert.deepEqual(a.update([tool], T + 10 * 60000, settings).map((x) => x.kind), ['stuck-tool']);
  assert.deepEqual(a.update([tool], T + 11 * 60000, settings), []);

  const b = new AlertTracker();
  assert.equal(stuckKind(session(), T + 3 * 60000, settings), 'waiting');
  assert.deepEqual(b.update([session()], T + 3 * 60000, settings).map((x) => x.kind), ['stuck-waiting']);
  assert.equal(stuckKind(session({ status: 'thinking' }), T + 60 * 60000, settings), null);
});

test('settings sanitize, clamp and persist', (t) => {
  assert.deepEqual(sanitize({ notifyDelaySeconds: '9999', sound: 'yes', bogus: 1 }), { ...DEFAULTS, notifyDelaySeconds: 600 });
  assert.equal(sanitize({ size: 'normal' }).size, 'normal');
  assert.equal(sanitize({ size: 'huge' }).size, DEFAULTS.size);
  assert.deepEqual(sanitize({ mutedSessions: ['a-1', 'a-1', 42, '../evil', 'b_2'] }).mutedSessions, ['a-1', 'b_2']);
  assert.equal(sanitize({ mutedSessions: Array.from({ length: 150 }, (_, i) => `s${i}`) }).mutedSessions.length, 100);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{not json');
  const s = new Settings(file);
  assert.deepEqual(s.get(), DEFAULTS);

  const changes = [];
  s.on('change', (v) => changes.push(v));
  s.set({ hideFromScreenCapture: false, stuckToolMinutes: 0 });
  s.set({ hideFromScreenCapture: false });
  assert.equal(changes.length, 1);
  assert.equal(new Settings(file).get().hideFromScreenCapture, false);
  assert.equal(new Settings(file).get().stuckToolMinutes, 1);
});
