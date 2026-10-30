'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PetBrain, petMood, sessionMood, homeFor, choosePetSessions, pickSpecies, windowFloors, petSign, petStrain, todosJustFinished, stepBall, SLEEP_AFTER_MS, LEAP_MS, RELEAP_DELAY_MS, NUDGE_MS, REACT_MS } = require('../src/pet');
const { SPRITE_W, SPRITE_H, SPRITES, ANIMS, PALETTES, SPECIES, SPECIES_PALETTES, BUBBLES, outline, animFor } = require('../src/pet-sprites');
const { sanitize } = require('../src/settings');

const ground = { left: 100, right: 1800, y: 1040 };
const perch = { x: 1100, y: 90 };

// Steps the brain in 33 ms ticks (like the window's fast tick) and returns the last view.
function run(brain, from, to, input) {
  let view;
  for (let t = from; t <= to; t += 33) view = brain.step(t, { ground, ...input });
  return view;
}

test('mood follows the most urgent unmuted session', () => {
  assert.equal(petMood([]), 'none');
  assert.equal(petMood([{ status: 'approval', muted: true }, { status: 'tool' }]), 'working');
  assert.equal(petMood([{ status: 'input' }]), 'alert');
  assert.equal(petMood([{ status: 'agents' }]), 'working');
  assert.equal(petMood([{ status: 'error' }]), 'error');
  assert.equal(petMood([{ status: 'idle' }]), 'idle');
});

test('home: taskbar, notch, or the notch only while a session needs you', () => {
  assert.equal(homeFor('taskbar', 'alert', true), 'ground');
  assert.equal(homeFor('notch', 'idle', true), 'perch');
  assert.equal(homeFor('both', 'working', true), 'ground');
  assert.equal(homeFor('both', 'alert', true), 'perch');
  // No visible notch: stay on the ground whatever the placement.
  assert.equal(homeFor('notch', 'alert', false), 'ground');
});

test('in "both" the cat leaps to the notch on an alert and drops back when it clears', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  let view = run(brain, 0, 1000, { perch, placement: 'both', mood: 'working' });
  assert.equal(view.y, ground.y);

  view = run(brain, 1033, 1033 + RELEAP_DELAY_MS + LEAP_MS + 100, { perch, placement: 'both', mood: 'alert' });
  assert.deepEqual([view.x, view.y, view.anim, view.bubble], [perch.x, perch.y, 'hang', 'alert']);

  view = run(brain, 4000, 6000, { perch, placement: 'both', mood: 'idle' });
  assert.equal(view.y, ground.y);
  assert.notEqual(view.anim, 'hang');
});

test('with reduced motion the cat moves between homes without jumping or falling', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  run(brain, 0, 1500, { perch, placement: 'notch', mood: 'idle', reducedMotion: true });
  assert.equal(brain.mode, 'perch');
  brain.step(1600, { ground, perch: null, placement: 'notch', mood: 'idle', reducedMotion: true });
  assert.equal(brain.mode, 'ground');
  assert.equal(brain.y, ground.y);
});

test('falls asleep when idle, and wakes up purring when stroked', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  let view = run(brain, 0, SLEEP_AFTER_MS + 8000, { placement: 'taskbar', mood: 'idle' });
  assert.equal(view.anim, 'sleep');
  assert.equal(view.bubble, 'zzz');
  view = brain.step(SLEEP_AFTER_MS + 8100, { ground, placement: 'taskbar', mood: 'idle', hover: true });
  assert.deepEqual([view.anim, view.bubble], ['happy', 'heart']);
});

test('a needed approval keeps the alert pose even while hovered', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  const view = run(brain, 0, 500, { placement: 'taskbar', mood: 'alert', hover: true });
  assert.deepEqual([view.anim, view.bubble], ['alert', 'alert']);
});

test('a tossed cat flies, stays on the display and lands on the taskbar', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'idle' });
  brain.grab();
  let view = brain.step(133, { ground, placement: 'taskbar', mood: 'idle', held: { x: 1700, y: 600 } });
  assert.deepEqual([view.x, view.y, view.anim], [1700, 600, 'held']);
  brain.release(1500, -800);
  view = run(brain, 166, 4000, { placement: 'taskbar', mood: 'idle' });
  assert.equal(view.y, ground.y);
  assert.ok(view.x >= ground.left && view.x <= ground.right, String(view.x));
});

test('a walk ends when the ground shrinks under it (display or taskbar change)', () => {
  const brain = new PetBrain({ random: () => 0.1 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'working' });
  assert.equal(brain.act.kind, 'walk');
  brain.act.targetX = 1700;
  const small = { left: 100, right: 500, y: 1040 };
  let view;
  for (let t = 133; t <= 20000; t += 33) view = brain.step(t, { ground: small, placement: 'taskbar', mood: 'working' });
  assert.ok(view.x <= small.right);
  assert.notEqual(brain.act.targetX, 1700);
});

test('chases a cursor near the taskbar only when allowed', () => {
  const cursor = { x: 300, y: 1000 };
  const chasing = new PetBrain({ random: () => 0.9 });
  run(chasing, 0, 33, { placement: 'taskbar', mood: 'working', cursor, chase: true });
  const startX = chasing.x;
  chasing.nextChaseAt = 0;
  run(chasing, 66, 3000, { placement: 'taskbar', mood: 'working', cursor, chase: true });
  assert.ok(Math.abs(chasing.x - cursor.x) < Math.abs(startX - cursor.x) - 300, `${startX} -> ${chasing.x}`);

  const lazy = new PetBrain({ random: () => 0.9 });
  run(lazy, 0, 33, { placement: 'taskbar', mood: 'idle', cursor, chase: false });
  lazy.nextChaseAt = 0;
  const view = run(lazy, 66, 3000, { placement: 'taskbar', mood: 'idle', cursor, chase: false });
  assert.notEqual(view.anim, 'run');
});

test('sprites are 20×16 (climbing and mid-flip: 16×20), keep a free border for their outline, and use palette colours', () => {
  const colours = new Set(Object.keys(PALETTES.orange));
  for (const [name, rows] of Object.entries(SPRITES)) {
    const climbing = /(^|\.)(climb1|climb2|cling|flip1|flip3)$/.test(name);
    const [w, h] = climbing ? [SPRITE_H, SPRITE_W] : [SPRITE_W, SPRITE_H];
    assert.equal(rows.length, h, name);
    for (const row of rows) assert.equal(row.length, w, name);
    const edge = [rows[0], rows[h - 1], rows.map((r) => r[0]).join(''), rows.map((r) => r[w - 1]).join('')];
    assert.ok(edge.every((line) => /^\.*$/.test(line)), `${name} touches the edge, so its outline is clipped`);
    for (const c of rows.join('').replace(/\./g, '')) assert.ok(colours.has(c), `${name} uses unknown colour ${c}`);
    assert.equal(outline(rows).length, h);
  }
  for (const palette of [...Object.values(PALETTES), ...Object.values(SPECIES_PALETTES)]) assert.deepEqual(new Set(Object.keys(palette)), colours);
});

test('the window\'s input area covers the cat and wherever its bubble is drawn', () => {
  const { hitRects, bubbleOrigin, WIN_COLS, WIN_ROWS, SPRITE_Y } = require('../src/pet-sprites');
  const inside = (rects, x, y) => rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  for (const anim of ['sit', 'alert', 'celebrate', 'hang']) {
    for (const facing of [1, -1]) {
      const rects = hitRects({ anim, facing, bubble: 'heart' });
      for (const r of rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= WIN_COLS && r.y + r.height <= WIN_ROWS, JSON.stringify(r));
      for (const dy of anim === 'hang' ? [0] : [0, -4]) {
        for (const [w, h] of [[8, 8], [9, 9]]) {
          const at = bubbleOrigin(anim, facing, SPRITE_Y + dy, w, h);
          assert.ok(inside(rects, at.x, at.y) && inside(rects, at.x + w - 1, at.y + h - 1), `${anim} ${facing} ${dy} ${w}`);
        }
      }
    }
  }
  assert.equal(hitRects({ anim: 'sit', facing: 1, bubble: null }).length, 1);
});

test('every animation frame and bubble the cat can show exists', () => {
  for (const [name, anim] of Object.entries(ANIMS)) {
    for (const [sprite] of anim.frames) assert.ok(SPRITES[sprite], `${name} → ${sprite}`);
  }
  for (const anim of ['sit', 'walk', 'run', 'sleep', 'alert', 'happy', 'celebrate', 'scared', 'hang', 'held', 'jump', 'fall']) {
    assert.ok(ANIMS[anim], anim);
  }
  for (const bubble of ['alert', 'question', 'heart', 'note', 'zzz', 'dots']) assert.ok(BUBBLES[bubble], bubble);
});

test('every species has every animation', () => {
  for (const species of SPECIES) {
    for (const anim of Object.keys(ANIMS)) {
      for (const [sprite] of animFor(species, anim).frames) assert.ok(SPRITES[sprite], `${species} ${anim} ? ${sprite}`);
    }
  }
});

test("a session's pet follows its own status, and sleeps while the session is muted", () => {
  assert.equal(sessionMood({ status: 'approval' }), 'alert');
  assert.equal(sessionMood({ status: 'tool' }), 'working');
  assert.equal(sessionMood({ status: 'idle' }), 'idle');
  assert.equal(sessionMood({ status: 'approval', muted: true }), 'asleep');

  const brain = new PetBrain({ random: () => 0.9 });
  const view = run(brain, 0, 500, { placement: 'taskbar', mood: 'asleep', cursor: { x: 300, y: 1000 }, chase: true });
  assert.deepEqual([view.anim, view.bubble], ['sleep', 'zzz']);
});

test('the most urgent sessions get pets, but a pet is not taken for a merely busier session', () => {
  const s = (id, status, muted = false) => ({ id, status, muted });
  const sessions = [s('a', 'approval'), s('b', 'tool'), s('c', 'idle'), s('d', 'idle', true)];
  assert.deepEqual(choosePetSessions(sessions, new Set(), 2).map((x) => x.id), ['a', 'b']);
  // 'c' and 'd' have pets: a busy 'b' doesn't take one from idle 'c', but beats muted 'd'.
  assert.deepEqual(choosePetSessions(sessions.slice(1), new Set(['c', 'd']), 2).map((x) => x.id), ['c', 'b']);
  // Needing you beats an idle session's pet.
  assert.deepEqual(choosePetSessions([s('c', 'idle'), s('a', 'input')], new Set(['c']), 1).map((x) => x.id), ['a']);
});

test('new sessions take the next species, skipping ones already on screen', () => {
  const order = ['cat', 'dog', 'pig'];
  assert.deepEqual(pickSpecies(order, new Set(), 0), { species: 'cat', next: 1 });
  assert.deepEqual(pickSpecies(order, new Set(['dog']), 1), { species: 'pig', next: 3 });
  assert.deepEqual(pickSpecies(order, new Set(order), 4), { species: 'dog', next: 5 });
});

test('a pet whose session ended walks off the nearer edge and is then gone', () => {
  const brain = new PetBrain({ random: () => 0.9, startAt: 0.1 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'idle' });
  brain.leave();
  let view;
  for (let t = 133; t < 10000 && !brain.gone; t += 33) view = brain.step(t, { ground, placement: 'taskbar', mood: 'none' });
  assert.ok(brain.gone);
  assert.ok(view.x < ground.left, String(view.x));
  assert.equal(view.anim, 'walk');

  // Told to use the far edge (e.g. another monitor is next to the near one), it goes that way.
  const far = new PetBrain({ random: () => 0.9, startAt: 0.1 });
  run(far, 0, 100, { placement: 'taskbar', mood: 'idle' });
  far.leave(1);
  for (let t = 133; t < 60000 && !far.gone; t += 33) view = far.step(t, { ground, placement: 'taskbar', mood: 'none' });
  assert.ok(far.gone && view.x > ground.right, String(view.x));
});

test('pet settings are sanitised', () => {
  const v = sanitize({ petMax: 3.6, petMode: 'herd', petSpecies: { 'sess-1': 'dog', 'sess-2': 'dragon', 'bad id!': 'cat' } });
  assert.equal(v.petMax, 4);
  assert.equal(v.petMode, 'single');
  assert.deepEqual(v.petSpecies, { 'sess-1': 'dog' });
  assert.deepEqual([v.petSize, v.petSpeed, v.petActivity, v.petSounds], ['match', 'normal', 'normal', false]);
  assert.equal(sanitize({ petSize: 'gigantic' }).petSize, 'match');
});

test('pet size follows the notch size unless set', () => {
  const { petCell } = require('../src/pet-sprites');
  assert.deepEqual(['tiny', 'small', 'normal'].map((n) => petCell('match', n)), [2, 3, 4]);
  assert.deepEqual(['tiny', 'small', 'medium', 'large', 'huge'].map((p) => petCell(p, 'tiny')), [2, 3, 4, 5, 6]);
});

test('window tops are floors except where a window above covers them', () => {
  const floors = windowFloors([
    { id: 1, x: 300, y: 200, width: 200, height: 300 }, // on top, covers part of window 2's top
    { id: 2, x: 100, y: 400, width: 600, height: 300 },
    { id: 3, x: 900, y: 500, width: 30, height: 200 }, // too narrow to stand on
  ]);
  assert.deepEqual(
    floors.map((f) => [f.left, f.right, f.y]),
    [
      [300, 500, 200],
      [100, 300, 400],
      [500, 700, 400],
    ]
  );
  // A maximized window in front hides every window top behind it, and isn't a floor itself.
  assert.deepEqual(windowFloors([{ id: 9, x: 0, y: 0, width: 1920, height: 1100, cover: true }, { id: 2, x: 100, y: 400, width: 600, height: 300 }]), []);
});

const roamInput = (extra = {}) => ({ ground, placement: 'taskbar', mood: 'idle', roam: true, walls: { left: 80, right: 1820, top: 100 }, ...extra });

test('a falling pet lands on a window top, rides it when it moves, and falls when it closes', () => {
  const brain = new PetBrain({ random: () => 0.99 });
  brain.step(0, roamInput());
  const win = { id: 'win:7:0', left: 1300, right: 1700, y: 600 };
  brain.x = 1500;
  brain.y = 300;
  brain.fall();
  let view = run(brain, 33, 1000, roamInput({ floors: [win] }));
  assert.deepEqual([brain.mode, brain.floorId, view.y], ['ground', 'win:7:0', 600]);

  const x = brain.x;
  run(brain, 1033, 1100, roamInput({ floors: [{ ...win, left: 1250, right: 1650, y: 650 }] }));
  assert.ok(Math.abs(brain.x - (x - 50)) < 1 && brain.y === 650, `${brain.x} ${brain.y}`);

  view = run(brain, 1133, 3000, roamInput());
  assert.deepEqual([brain.mode, brain.floorId, view.y], ['ground', 'ground', ground.y]);
});

test('walking off the end of a window drops the pet to the ground', () => {
  const brain = new PetBrain({ random: () => 0.99 });
  const win = { id: 'win:1:0', left: 400, right: 600, y: 500 };
  brain.step(0, roamInput({ floors: [win] }));
  brain.land(0, win);
  brain.x = 590;
  brain.play({ kind: 'walk', targetX: 700, offEdge: true });
  run(brain, 33, 3000, roamInput({ floors: [win] }));
  assert.deepEqual([brain.floorId, brain.y], ['ground', ground.y]);
});

test('a pet climbs a screen edge, clings, then lets go and falls back down', () => {
  const brain = new PetBrain({ random: () => 0.5 });
  brain.step(0, roamInput({ mood: 'working' }));
  assert.ok(brain.startClimb(0, 1, roamInput({ mood: 'working' })));
  let view = brain.step(33, roamInput({ mood: 'working' }));
  assert.deepEqual([view.anim, view.x, view.facing], ['climb', 1820, 1]);
  let highest = view.y;
  for (let t = 66; t < 40000 && brain.mode !== 'air'; t += 33) {
    view = brain.step(t, roamInput({ mood: 'working' }));
    highest = Math.min(highest, view.y);
  }
  assert.ok(highest < ground.y - 200, String(highest));
  run(brain, 40000, 43000, roamInput({ mood: 'working' }));
  assert.equal(brain.mode, 'ground');
  assert.equal(brain.y, ground.y);
});

test('a pet hops up onto a window within reach', () => {
  const brain = new PetBrain({ random: () => 0.5 });
  brain.step(0, roamInput());
  const win = { id: 'win:3:0', left: brain.x - 50, right: brain.x + 150, y: ground.y - 180 };
  assert.equal(brain.reachableFloor([win], { id: 'ground' }), win);
  brain.startHop(0, win, false);
  run(brain, 33, 1000, roamInput({ floors: [win] }));
  assert.deepEqual([brain.mode, brain.floorId, brain.y], ['ground', 'win:3:0', win.y]);
  // Too high to reach.
  assert.equal(brain.reachableFloor([{ ...win, y: ground.y - 600 }], { id: 'ground' }), null);
});

test('a knocked pet tumbles away; a falling pet can land on another pet and sit there', () => {
  const brain = new PetBrain({ random: () => 0.99 });
  run(brain, 0, 100, roamInput());
  const x = brain.x;
  assert.ok(brain.knock(-1, 133));
  assert.equal(brain.mode, 'air');
  run(brain, 166, 3000, roamInput());
  assert.ok(brain.x < x && brain.mode === 'ground');

  const top = new PetBrain({ random: () => 0.99 });
  top.step(0, roamInput());
  const head = { id: 'pet:dog', left: 980, right: 1020, y: ground.y - 36 };
  top.x = 1000;
  top.y = 500;
  top.fall();
  run(top, 33, 2000, roamInput({ floors: [head] }));
  assert.deepEqual([top.floorId, top.y], ['pet:dog', head.y]);
});

test('roaming pets stay put while their session needs you', () => {
  const brain = new PetBrain({ random: () => 0.01 });
  const view = run(brain, 0, 5000, roamInput({ mood: 'alert' }));
  assert.deepEqual([brain.mode, view.anim], ['ground', 'alert']);
});

test('a finished todo list sets off a backflip with confetti on the spot', () => {
  const brain = new PetBrain({ random: () => 0.1 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'working' });
  const x = brain.x;
  brain.party(133);
  let view = run(brain, 133, 1500, { placement: 'taskbar', mood: 'working' });
  assert.deepEqual([view.anim, view.effect, brain.x], ['party', 'confetti', x]);
  view = run(brain, 1533, 133 + REACT_MS.party + 100, { placement: 'taskbar', mood: 'working' });
  assert.equal(view.effect, null);

  assert.ok(todosJustFinished({ total: 3, done: 2 }, { total: 3, done: 3 }));
  assert.ok(todosJustFinished(null, { total: 1, done: 1 }), 'a list made and finished between readings');
  assert.ok(!todosJustFinished(undefined, { total: 3, done: 3 }), 'first sighting');
  assert.ok(!todosJustFinished({ total: 3, done: 3 }, { total: 3, done: 3 }), 'already finished');
  assert.ok(!todosJustFinished({ total: 3, done: 1 }, { total: 3, done: 2 }));
});

test('a pet whose session needs you holds up a sign on the ground, not while hanging from the notch', () => {
  const session = { status: 'approval', label: 'Approve shell', detail: 'npm test --  ' + 'x'.repeat(60) };
  const sign = petSign(session);
  assert.equal(sign.kind, 'approval');
  assert.equal(sign.title, 'Approve shell');
  assert.ok(sign.text.length <= 40 && sign.text.endsWith('…'), sign.text);
  assert.equal(petSign({ status: 'input', label: 'Question for you', detail: 'Which DB?' }).kind, 'question');
  assert.equal(petSign({ status: 'tool' }), null);
  assert.equal(petSign({ ...session, muted: true }), null);

  const brain = new PetBrain({ random: () => 0.9 });
  let view = run(brain, 0, 500, { placement: 'taskbar', mood: 'alert', sign });
  assert.deepEqual([view.anim, view.bubble, view.sign], ['alert', null, sign]);
  const hanging = new PetBrain({ random: () => 0.9 });
  view = run(hanging, 0, 3000, { perch, placement: 'notch', mood: 'alert', sign });
  assert.deepEqual([view.anim, view.bubble, view.sign], ['hang', 'alert', null]);
});

test('a pet sweats when the context window is nearly full and limps, slower, after failures', () => {
  const usage = (contextTokens) => ({ usage: { contextTokens, contextLimit: 100000 } });
  assert.equal(petStrain({ status: 'idle', ...usage(90000) }).sweat, true);
  assert.equal(petStrain({ status: 'idle', ...usage(50000) }).sweat, false);
  const failed = { ok: false };
  assert.equal(petStrain({ status: 'tool', activity: [{ running: true }, failed, failed, failed] }).limp, true);
  assert.equal(petStrain({ status: 'idle', activity: [failed, failed, { ok: true }, failed] }).limp, false, 'a success breaks the run');
  assert.equal(petStrain({ status: 'error' }).limp, true);
  assert.deepEqual(petStrain({ status: 'error', muted: true, ...usage(99000) }), { sweat: false, limp: false });

  const walkFor = (strain) => {
    const brain = new PetBrain({ random: () => 0.9 });
    brain.step(0, { ground, placement: 'taskbar', mood: 'idle', strain });
    const x = brain.x;
    brain.play({ kind: 'walk', targetX: x - 500 });
    const view = run(brain, 33, 1000, { placement: 'taskbar', mood: 'idle', strain });
    return { view, moved: x - brain.x };
  };
  const limping = walkFor({ sweat: true, limp: true });
  const walking = walkFor(null);
  assert.deepEqual([limping.view.anim, limping.view.sweat], ['limp', true]);
  assert.equal(walking.view.anim, 'walk');
  assert.ok(limping.moved < walking.moved * 0.6, `${limping.moved} vs ${walking.moved}`);
});

test('fetch: the pet runs to the ball once it lands, carries it back, and puts it down', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'idle' });
  const home = brain.x;
  assert.ok(brain.fetch(133));
  let ball = { x: home - 400, y: ground.y - 200, vx: -300, vy: -200, resting: false };
  let view;
  let carried = false;
  for (let t = 166; t < 20000 && brain.isFetching(); t += 33) {
    ball = stepBall(ball, 0.033, ground);
    // Hovered by the cursor that double-clicked it: it still goes.
    view = brain.step(t, { ground, placement: 'taskbar', mood: 'idle', hover: true, ball: carried ? null : ball });
    if (view.carry === 'ball') carried = true;
  }
  assert.ok(ball.resting && ball.y === ground.y, JSON.stringify(ball));
  assert.ok(carried, 'picked the ball up');
  assert.ok(Math.abs(brain.x - home) < 2, `${brain.x} vs ${home}`);
  assert.equal(view.carry, null);

  // Not from a window top, and not while its session needs you.
  const busy = new PetBrain({ random: () => 0.9 });
  run(busy, 0, 100, { placement: 'taskbar', mood: 'alert' });
  assert.equal(busy.fetch(133), false);
});

test('the fetch ball bounces, rolls to a stop and stays on the ground', () => {
  let ball = { x: 1700, y: 900, vx: 900, vy: -400, resting: false };
  let bounced = false;
  for (let i = 0; i < 1000 && !ball.resting; i++) {
    const next = stepBall(ball, 0.016, ground);
    if (next.vx < 0 && ball.vx > 0) bounced = true;
    ball = next;
    assert.ok(ball.x >= ground.left && ball.x <= ground.right && ball.y <= ground.y);
  }
  assert.ok(ball.resting && bounced);
  assert.equal(stepBall(ball, 0.016, ground), ball, 'a resting ball stays put');
});

test('a wellbeing nudge: the pet runs below the cursor, shows the bubble, and a pat dismisses it', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'idle' });
  brain.nudge(133, 'water');
  const cursor = { x: 400, y: 500 };
  let view = run(brain, 133, 15000, { placement: 'taskbar', mood: 'idle', cursor, chase: false });
  assert.ok(Math.abs(brain.x - 400) < 2, String(brain.x));
  assert.deepEqual([view.anim, view.bubble], ['happy', 'water']);
  brain.pet(15100);
  view = run(brain, 15100, 15200 + 2000, { placement: 'taskbar', mood: 'idle', cursor, chase: false });
  assert.notEqual(view.bubble, 'water');

  const ignored = new PetBrain({ random: () => 0.9 });
  run(ignored, 0, 100, { placement: 'taskbar', mood: 'idle' });
  ignored.nudge(133, 'stretch');
  view = run(ignored, 133, 133 + NUDGE_MS + 500, { placement: 'taskbar', mood: 'idle' });
  assert.notEqual(view.bubble, 'stretch', 'it gives up after a while');
});

test('a level-up hops with a star; confetti makes the whole box drawable', () => {
  const brain = new PetBrain({ random: () => 0.9 });
  run(brain, 0, 100, { placement: 'taskbar', mood: 'idle' });
  brain.levelUp(133);
  const view = brain.step(166, { ground, placement: 'taskbar', mood: 'idle' });
  assert.deepEqual([view.anim, view.bubble], ['celebrate', 'star']);
  const { hitRects, WIN_COLS, WIN_ROWS } = require('../src/pet-sprites');
  assert.deepEqual(hitRects({ anim: 'party', facing: 1, bubble: null, effect: 'confetti' }), [{ x: 0, y: 0, width: WIN_COLS, height: WIN_ROWS }]);
});
