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

const { tabHiddenDisplayIds } = require('../src/tab-hide');

test('the notch hides over a tabbed app whose tab strip is under the pill', () => {
  const notches = [
    { displayId: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, pill: { x: 540, width: 200 }, zoom: 1 },
    { displayId: 2, bounds: { x: -3440, y: 0, width: 3440, height: 1440 }, pill: { x: -1820, width: 200 }, zoom: 1 },
  ];
  const hidden = (app, rect, attention) => [...tabHiddenDisplayIds({ app, rect, notches, attention })];
  const maximized = { x: 0, y: 0, width: 1280, height: 752 };
  assert.deepEqual(hidden('chrome', maximized), [1]);
  assert.deepEqual(hidden('WindowsTerminal', { x: -5, y: -7, width: 1290, height: 760 }), [1]);
  assert.deepEqual(hidden('Code', { x: -3440, y: 0, width: 3440, height: 1392 }), [2]);
  // Not a tabbed app, tabs below the pill, beside the pill, or a session needs you.
  assert.deepEqual(hidden('mspaint', maximized), []);
  assert.deepEqual(hidden('msedge', { x: 100, y: 120, width: 900, height: 600 }), []);
  assert.deepEqual(hidden('msedge', { x: 0, y: 0, width: 520, height: 752 }), []);
  assert.deepEqual(hidden('firefox', maximized, true), []);
  assert.deepEqual(hidden('firefox', null), []);
});

test('hide over tabs is on by default and can be turned off', () => {
  assert.equal(DEFAULTS.hideOverTabs, true);
  assert.equal(sanitize({ hideOverTabs: false }).hideOverTabs, false);
});

// A NotchManager over fake Electron windows; `fake.cursor` is where the pointer is.
const fake = { cursor: { x: 0, y: 0 }, windows: [] };
function loadNotches() {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } };
  class FakeWindow {
    constructor() {
      this.visible = false;
      this.sent = [];
      this.handlers = {};
      this.webContents = { send: (channel, ...args) => this.sent.push([channel, ...args]) };
      fake.windows.push(this);
    }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    setContentProtection() {}
    loadFile() {}
    setBounds(b) { this.bounds = b; }
    getBounds() { return this.bounds; }
    once(event, cb) { this.handlers[event] = cb; }
    on() {}
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
  }
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      BrowserWindow: FakeWindow,
      screen: {
        getPrimaryDisplay: () => display,
        getAllDisplays: () => [display],
        getDisplayNearestPoint: () => display,
        getCursorScreenPoint: () => fake.cursor,
      },
    },
  };
  return require('../src/notches');
}

// A shown notch on a 1280-wide display: its window spans x 440-840, the pill x 560-720.
function newNotch(settings = {}) {
  const { NotchManager } = loadNotches();
  fake.cursor = { x: 0, y: 0 };
  const m = new NotchManager({ webPreferences: {}, getSettings: () => ({ ...DEFAULTS, ...settings }) });
  m.sync();
  const w = fake.windows[fake.windows.length - 1];
  w.handlers['ready-to-show']();
  return { m, w, n: m.notches.get('main') };
}

test('hiding the notch plays the retract animation first; showing again cancels it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m, w } = newNotch();
  assert.equal(w.visible, true);
  const visibility = () => w.sent.filter(([c]) => c === 'notch:visibility').map(([, v]) => v);

  m.setHiddenDisplays(new Set([1]));
  assert.deepEqual(visibility(), [true, false]);
  assert.equal(w.visible, true, 'still on screen while the retract animation plays');
  t.mock.timers.tick(300);
  assert.equal(w.visible, false);

  m.setHiddenDisplays(new Set());
  assert.equal(w.visible, true);
  assert.deepEqual(visibility(), [true, false, true]);

  // Shown again mid-retract: the window never hides and the animation reverses.
  m.setHiddenDisplays(new Set([1]));
  t.mock.timers.tick(100);
  m.setHiddenDisplays(new Set());
  t.mock.timers.tick(500);
  assert.equal(w.visible, true);
  assert.deepEqual(visibility(), [true, false, true, false, true]);
});

test('pointing at the top edge brings back a notch that hid itself, until the pointer leaves', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { m, w, n } = newNotch();
  n.hoverRect = { x: 120, y: 0, width: 160, height: 32, extra: [] };
  const poll = (x, y, now) => {
    fake.cursor = { x, y };
    m.pollHover(now);
  };
  m.setIdleHidden(true);
  t.mock.timers.tick(300);
  assert.equal(w.visible, false);

  // A quick touch (clicking a tab) doesn't bring it back; resting there does.
  poll(640, 0, 1000);
  poll(640, 0, 1200);
  poll(640, 40, 1250);
  poll(640, 0, 1300);
  poll(640, 0, 1500);
  assert.equal(w.visible, false);
  poll(640, 1, 1600);
  assert.equal(w.visible, true);
  // Hovering keeps it; moving away hides it again.
  poll(640, 10, 1660);
  assert.equal(n.hovering, true);
  poll(640, 400, 1720);
  t.mock.timers.tick(300);
  assert.equal(w.visible, false);
  // Beside the pill's spot (even a small one) or below the edge does nothing.
  for (const [x, y] of [[300, 0], [900, 0], [640, 5]]) {
    poll(x, y, 2000);
    poll(x, y, 2500);
  }
  assert.equal(w.visible, false);

  // Hidden over tabs: same. Hidden for a full-screen app: not.
  m.setHiddenDisplays(new Set([1]), new Set([1]));
  m.setIdleHidden(false);
  poll(640, 0, 3000);
  poll(640, 0, 3500);
  assert.equal(w.visible, false, 'full-screen app');
  m.setHiddenDisplays(new Set([1]));
  poll(640, 0, 4000);
  poll(640, 0, 4300);
  assert.equal(w.visible, true, 'over tabs');
  poll(640, 400, 4400);
  t.mock.timers.tick(300);
  assert.equal(w.visible, false);
  // A full-screen app taking over a peeking notch hides it.
  poll(640, 0, 5000);
  poll(640, 0, 5300);
  assert.equal(w.visible, true);
  m.setHiddenDisplays(new Set([1]), new Set([1]));
  t.mock.timers.tick(300);
  assert.equal(w.visible, false);
});

test('the top edge does nothing after the tray Hide or with the setting off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [settings, hide] of [
    [{}, (m) => m.setUserHidden(true)],
    [{ revealAtTopEdge: false }, (m) => m.setIdleHidden(true)],
  ]) {
    const { m, w } = newNotch(settings);
    hide(m);
    t.mock.timers.tick(300);
    fake.cursor = { x: 640, y: 0 };
    m.pollHover(1000);
    m.pollHover(2000);
    assert.equal(w.visible, false);
  }
  assert.equal(DEFAULTS.revealAtTopEdge, true);
});
