'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IdleTracker, shouldShow, isDotOnly, IDLE_HIDE_DELAY_MS } = require('../src/visibility');
const { sanitize, DEFAULTS } = require('../src/settings');

test('auto-hide waits for the grace period after the last activity', () => {
  const t = new IdleTracker(0);
  const idle = [{ status: 'idle' }];
  assert.equal(t.update(idle, 1000), false, 'visible briefly after launch');
  assert.equal(t.update(idle, IDLE_HIDE_DELAY_MS), true);
  assert.equal(t.update([{ status: 'tool' }], 20000), false, 'activity shows it again');
  assert.equal(t.update(idle, 20000 + IDLE_HIDE_DELAY_MS - 1), false);
  assert.equal(t.update(idle, 20000 + IDLE_HIDE_DELAY_MS), true);
  // Muted sessions never keep the notch up; no sessions at all counts as idle.
  assert.equal(t.update([{ status: 'approval', muted: true }], 60000), true);
  assert.equal(t.update([], 60000), true);
});

test('pin overrides every hiding rule; hover keeps an idle-hidden notch up', () => {
  const base = { pinned: false, userHidden: false, displayHidden: false, idleHidden: false, hovering: false };
  assert.equal(shouldShow(base), true);
  assert.equal(shouldShow({ ...base, idleHidden: true }), false);
  assert.equal(shouldShow({ ...base, idleHidden: true, hovering: true }), true);
  assert.equal(shouldShow({ ...base, displayHidden: true, hovering: true }), false, 'full-screen hiding still wins over hover');
  for (const k of ['userHidden', 'displayHidden', 'idleHidden']) {
    assert.equal(shouldShow({ ...base, [k]: true, pinned: true }), true, `pin beats ${k}`);
  }
});

test('compact dot-only pill only when nothing needs attention', () => {
  assert.equal(isDotOnly({ compact: false, top: null, toast: null }), false);
  assert.equal(isDotOnly({ compact: true, top: null, toast: null }), true);
  assert.equal(isDotOnly({ compact: true, top: { status: 'idle' }, toast: null }), true);
  assert.equal(isDotOnly({ compact: true, top: { status: 'approval', muted: true }, toast: null }), true);
  assert.equal(isDotOnly({ compact: true, top: { status: 'tool' }, toast: null }), false);
  assert.equal(isDotOnly({ compact: true, top: { status: 'error' }, toast: null }), false);
  assert.equal(isDotOnly({ compact: true, top: { status: 'idle' }, toast: { kind: 'done' } }), false, 'Done toast still shows');
});

test('hotkey setting accepts accelerators and rejects junk', () => {
  assert.equal(DEFAULTS.hotkey, 'Control+Alt+N');
  assert.equal(sanitize({ hotkey: ' Ctrl + Shift + K ' }).hotkey, 'Ctrl+Shift+K');
  assert.equal(sanitize({ hotkey: '' }).hotkey, '');
  assert.equal(sanitize({ hotkey: 'Ctrl++' }).hotkey, DEFAULTS.hotkey);
  assert.equal(sanitize({ hotkey: 'rm -rf' }).hotkey, DEFAULTS.hotkey);
  assert.equal(sanitize({ hotkey: 42 }).hotkey, DEFAULTS.hotkey);
});
