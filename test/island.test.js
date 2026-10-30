'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const island = require('../src/island');
const { QuickTimer, describeDuration } = require('../src/timer');
const { Shelf, isOpenable } = require('../src/shelf');
const { parseMediaLine } = require('../src/media');
const { IdleTracker, isDotOnly } = require('../src/visibility');
const { sanitizeRect } = require('../src/notches');

const s = (id, status, extra = {}) => ({ id, name: id, status, label: status, ...extra });
const playing = { title: 'Song', artist: 'Band', status: 'playing' };

test('the pill shows the most urgent session; the next activity pops out into the bubble', () => {
  const plan = island.planIsland({ sessions: [s('a', 'approval'), s('b', 'thinking'), s('c', 'idle')], media: playing });
  assert.equal(plan.primary.id, 'a');
  assert.equal(plan.secondary.id, 'b');
  assert.equal(plan.more, 1, 'media is the third activity');

  const one = island.planIsland({ sessions: [s('a', 'tool')] });
  assert.equal(one.primary.id, 'a');
  assert.equal(one.secondary, null);
});

test('with no live session, playing media or a timer takes the pill; paused media does not', () => {
  const timer = { mode: 'timer', durationMs: 60000, accumulatedMs: 0, runningSince: 1 };
  const plan = island.planIsland({ sessions: [s('a', 'idle')], media: playing, timer });
  assert.equal(plan.primary.kind, 'timer');
  assert.equal(plan.secondary.kind, 'media');

  const paused = island.planIsland({ sessions: [s('a', 'idle')], media: { ...playing, status: 'paused' } });
  assert.equal(paused.primary.kind, 'session', 'the idle session is shown, as before');
  assert.equal(paused.secondary, null);
  assert.equal(island.planIsland({}).primary.kind, 'none');
});

test('muted sessions never take the pill or the bubble', () => {
  const plan = island.planIsland({ sessions: [s('a', 'thinking', { muted: true }), s('b', 'idle')], media: playing });
  assert.equal(plan.primary.kind, 'media');
  assert.equal(plan.secondary, null);
});

test('a session scrolled to on the pill is shown first, unless another one needs you', () => {
  const sessions = [s('a', 'thinking'), s('b', 'tool'), s('c', 'idle')];
  assert.equal(island.planIsland({ sessions, pickedId: 'c' }).primary.id, 'c');
  assert.equal(island.planIsland({ sessions, pickedId: 'c' }).secondary.id, 'a');
  const urgent = [s('a', 'input'), s('b', 'tool')];
  assert.equal(island.planIsland({ sessions: urgent, pickedId: 'b' }).primary.id, 'a');

  assert.equal(island.cycleSession(sessions, 'a', 1), 'b');
  assert.equal(island.cycleSession(sessions, 'a', -1), 'c', 'wraps around');
  assert.equal(island.cycleSession([s('a', 'tool')], 'a', 1), null);
  assert.equal(island.cycleSession([s('a', 'tool'), s('m', 'tool', { muted: true })], 'a', 1), null);
});

test('transitions become banners; a finished session does not cover one that needs you', () => {
  const done = island.bannerForTransition({ kind: 'done', session: s('a', 'idle', { tag: 'blue' }) }, s('a', 'idle'));
  assert.equal(done.title, 'Done');
  assert.equal(done.sessionId, 'a');
  assert.equal(done.tag, 'blue');
  assert.equal(island.bannerForTransition({ kind: 'done', session: s('a', 'idle') }, s('b', 'approval')), null);
  assert.ok(island.bannerForTransition({ kind: 'done', session: s('a', 'idle') }, s('b', 'approval', { muted: true })));

  const ask = island.bannerForTransition({ kind: 'attention', session: s('a', 'input', { label: 'Question for you', detail: 'Which DB?' }) });
  assert.equal(ask.status, 'input');
  assert.equal(ask.urgent, true);
  assert.equal(ask.subtitle, 'a · Which DB?');
  assert.equal(island.bannerForTransition({ kind: 'stuck', session: s('a', 'tool') }), null);
});

test('battery banners: plugging in, and crossing 20%, 10% and 5% while discharging', () => {
  assert.equal(island.batteryBanner({ charging: false, level: 0.5 }, { charging: true, level: 0.5 }).title, 'Charging');
  assert.equal(island.batteryBanner({ charging: true, level: 0.5 }, { charging: true, level: 0.6 }), null);
  const low = island.batteryBanner({ charging: false, level: 0.21 }, { charging: false, level: 0.2 });
  assert.equal(low.title, 'Low battery');
  assert.equal(low.urgent, false);
  assert.equal(island.batteryBanner({ charging: false, level: 0.2 }, { charging: false, level: 0.19 }), null, 'warns once per level');
  assert.equal(island.batteryBanner({ charging: false, level: 0.11 }, { charging: false, level: 0.1 }).urgent, true);
  assert.equal(island.batteryBanner({ charging: true, level: 0.21 }, { charging: true, level: 0.2 }), null);
});

test('media app ids get friendly names', () => {
  assert.equal(island.prettyAppName('Spotify.exe'), 'Spotify');
  assert.equal(island.prettyAppName('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'), 'Media Player');
  assert.equal(island.prettyAppName('308046B0AF4A39CB'), 'Firefox');
  assert.equal(island.prettyAppName('C:\\Tools\\mpv.exe'), 'Mpv');
  assert.equal(island.prettyAppName('ABCDEF0123456789'), '');
  assert.equal(island.prettyAppName(''), '');
});

test('media position is extrapolated while playing and clamped to the duration', () => {
  const m = { status: 'playing', positionMs: 10000, durationMs: 15000, updatedAt: 1000 };
  assert.equal(island.mediaPosition(m, 4000), 13000);
  assert.equal(island.mediaPosition(m, 99999), 15000);
  assert.equal(island.mediaPosition({ ...m, status: 'paused' }, 4000), 10000);
});

test('clock formatting', () => {
  assert.equal(island.formatClock(75000), '1:15');
  assert.equal(island.formatClock(3725000), '1:02:05');
  assert.equal(island.formatClock(5200, { roundUp: true }), '0:06');
  assert.equal(island.formatClock(-5), '0:00');
});

function fakeClock() {
  let now = 1000;
  const timers = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      for (const t of timers.filter((x) => !x.cleared && x.at <= now)) {
        t.cleared = true;
        t.fn();
      }
    },
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => t && (t.cleared = true),
  };
}

test('quick timer counts down, pauses, takes extra time and fires once when done', () => {
  const clock = fakeClock();
  const timer = new QuickTimer(clock);
  const done = [];
  timer.on('done', (d) => done.push(d));
  assert.equal(timer.start(500), false, 'under a second is refused');
  assert.equal(timer.start(60000), true);
  clock.advance(20000);
  assert.equal(timer.pause(), true);
  clock.advance(100000);
  assert.equal(timer.elapsed(), 20000, 'paused time does not count');
  assert.equal(island.timerRemaining(timer.snapshot(), clock.now()), 40000);
  timer.resume();
  timer.add(60000);
  clock.advance(99000);
  assert.equal(done.length, 0);
  clock.advance(1000);
  assert.deepEqual(done, [{ mode: 'timer', durationMs: 120000 }]);
  assert.equal(timer.snapshot(), null);
});

test('stopwatch counts up and can be stopped', () => {
  const clock = fakeClock();
  const timer = new QuickTimer(clock);
  timer.startStopwatch();
  clock.advance(65000);
  const snap = timer.snapshot();
  assert.equal(island.timerElapsed(snap, clock.now()), 65000);
  assert.ok(Math.abs(island.timerProgress(snap, clock.now()) - 5 / 60) < 1e-9);
  assert.equal(timer.add(1000), false, 'only countdowns take extra time');
  assert.equal(timer.stop(), true);
  assert.equal(timer.snapshot(), null);
  assert.equal(describeDuration(90 * 60000), '1 h 30 min');
  assert.equal(describeDuration(45000), '45 s');
});

test('the shelf keeps existing absolute paths, newest first, and drops files that went away', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.png');
  fs.writeFileSync(a, 'hello');
  fs.writeFileSync(b, 'x');
  const file = path.join(dir, 'state', 'shelf.json');
  const shelf = new Shelf(file);
  let changes = 0;
  shelf.on('change', () => changes++);

  assert.equal(shelf.add([a, 'relative.txt', path.join(dir, 'missing.txt'), 42, a]), 1);
  assert.equal(shelf.add([b]), 1);
  assert.deepEqual(shelf.list().map((i) => i.name), ['b.png', 'a.txt']);
  assert.equal(shelf.list()[1].size, 5);
  assert.equal(shelf.add([a]), 1, 're-adding moves it to the front');
  assert.deepEqual(shelf.list().map((i) => i.name), ['a.txt', 'b.png']);
  assert.equal(changes, 3);

  const reloaded = new Shelf(file);
  assert.deepEqual(reloaded.list().map((i) => i.path), [a, b]);
  fs.rmSync(b);
  assert.deepEqual(reloaded.list().map((i) => i.path), [a]);
  assert.equal(reloaded.remove(a), true);
  assert.equal(reloaded.remove(a), false);
  assert.equal(new Shelf(file).list().length, 0);

  const small = new Shelf(path.join(dir, 'small.json'), { max: 1 });
  small.add([a, b]);
  assert.equal(small.items.length, 1);
});

test('only documents and media are opened from the shelf; programs and scripts are not', () => {
  assert.equal(isOpenable('C:\\x\\report.PDF'), true);
  assert.equal(isOpenable('C:\\x\\photo.jpg'), true);
  assert.equal(isOpenable('C:\\x\\setup.exe'), false);
  assert.equal(isOpenable('C:\\x\\run.ps1'), false);
  assert.equal(isOpenable('C:\\x\\tool.py'), false);
  assert.equal(isOpenable('C:\\x\\link.lnk'), false);
  assert.equal(isOpenable('C:\\x\\no-extension'), false);
});

test('media helper lines are parsed defensively', () => {
  const line = JSON.stringify({
    media: { app: 'Spotify.exe', title: 'Song\u0007', artist: 'Band', album: 'LP', status: 'playing', pos: 61000, dur: 215000, at: 5, prev: true, next: true, toggle: true },
    art: 'data:image/png;base64,iVBORw0KGgo=',
  });
  const parsed = parseMediaLine(line);
  assert.equal(parsed.media.app, 'Spotify');
  assert.equal(parsed.media.title, 'Song');
  assert.equal(parsed.media.positionMs, 61000);
  assert.equal(parsed.media.canNext, true);
  assert.equal(parsed.art, 'data:image/png;base64,iVBORw0KGgo=');

  assert.deepEqual(parseMediaLine('{"media":null}'), { media: null });
  assert.deepEqual(parseMediaLine('{"unsupported":true}'), { unsupported: true });
  assert.equal(parseMediaLine('{"media":{"status":"weird","pos":-4}}').media.status, 'stopped');
  assert.equal(parseMediaLine('{"media":{"status":"weird","pos":-4}}').media.positionMs, 0);
  assert.equal(parseMediaLine('{"media":null,"art":"javascript:alert(1)"}').art, null);
  assert.equal(parseMediaLine('{"other":1}'), null);
  assert.equal(parseMediaLine('nope'), null);
});

test('playing media or a running timer keeps the notch from idling away and out of dot mode', () => {
  const idle = new IdleTracker(0, 1000);
  assert.equal(idle.update([], 5000, true), false);
  assert.equal(idle.update([], 7000), true);
  assert.equal(isDotOnly({ compact: true, top: null, toast: null, busy: true }), false);
  assert.equal(isDotOnly({ compact: true, top: null, toast: null }), true);
});

test('hover rectangles from the renderer are validated, with up to three extra rects', () => {
  assert.deepEqual(sanitizeRect({ x: 1, y: 0, width: 10, height: 24, extra: [{ x: 20, y: 0, width: 5, height: 24, junk: 1 }, { x: 'a' }] }), {
    x: 1,
    y: 0,
    width: 10,
    height: 24,
    extra: [{ x: 20, y: 0, width: 5, height: 24 }],
  });
  assert.equal(sanitizeRect({ x: 1, y: 0, width: NaN, height: 2 }), null);
  assert.equal(sanitizeRect(null), null);
  assert.equal(sanitizeRect({ x: 0, y: 0, width: 1, height: 1, extra: Array(9).fill({ x: 0, y: 0, width: 1, height: 1 }) }).extra.length, 3);
});
