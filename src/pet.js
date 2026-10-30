'use strict';

// Behaviour of the desktop pets, free of Electron so it can be unit tested. Positions are screen
// DIPs; (x, y) is always the bottom-centre of the pet's box, including while it hangs from the
// notch or climbs a screen edge (the caller turns the pill's edge and the screen edges into those
// points).

const GRAVITY = 2600; // px/s²
const WALK_SPEED = 40; // px/s
const RUN_SPEED = 170;
const LEAP_MS = 700;
const RELEAP_DELAY_MS = 1200; // pause after landing before jumping back up to the notch
const SLEEP_AFTER_MS = 20000;
const CHASE_MS = 7000;
const CHASE_BAND = 220; // how far above the ground the cursor may be for the cat to chase it
const MAX_FLING = 1800;
const LEAVE_PAST = 100; // how far past the ground's end a leaving pet walks (out of sight)
const REACT_MS = { happy: 1800, celebrate: 2200, scared: 1600, party: 3000 };
// Wellbeing nudges (water, stretch) stay up this long unless the pet is clicked.
const NUDGE_MS = 2 * 60 * 1000;
// Fetch: how close the pet must get to pick the ball up; a fetch never takes longer than this.
const FETCH_REACH = 10;
const FETCH_MS = 30000;
const LIMP_SPEED = 0.5;
// Strain: sweating from this share of the context window used; limping after this many failed tool
// calls in a row.
const SWEAT_AT = 0.85;
const LIMP_AFTER = 3;
// Signs: longest title and detail line held up by a pet.
const SIGN_TITLE = 28;
const SIGN_TEXT = 40;
// Fetch ball physics.
const BALL_BOUNCE = 0.45;
const BALL_FRICTION = 2.2; // per second while rolling on the ground
// Roaming the screen.
const GROUND = 'ground'; // id of the taskbar floor
const ROAM_SLEEP_AFTER_MS = 60000; // idle pets roam for a while before napping
const CLIMB_SPEED = 35; // px/s up a screen edge
const HOP_MS = 450;
const HOP_ARC = 40; // px above the straight line of a hop
const HOP_HEIGHT = 260; // highest floor a pet hops up to
const HOP_REACH = 140; // how far sideways a floor may be to hop onto it
const KNOCK_VX = 320; // a pet knocked over by a flying one tumbles this fast...
const KNOCK_VY = 520; // ...and this high
const PLAYFUL = new Set(['idle', 'working', 'none']);
// Activity setting: how often a pet sets off roaming, how long it sits, when an idle roamer naps.
const ACTIVITY = {
  calm: { roam: 0.4, sit: 1.5, sleepAfter: 30000 },
  normal: { roam: 1, sit: 1, sleepAfter: ROAM_SLEEP_AFTER_MS },
  playful: { roam: 1, sit: 0.5, sleepAfter: 120000 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A session's status as a pet mood.
function moodOfStatus(status) {
  switch (status) {
    case 'approval':
    case 'input':
      return 'alert';
    case 'tool':
    case 'thinking':
    case 'agents':
      return 'working';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// The single pet's mood follows the most urgent unmuted session (sessions arrive sorted by urgency).
function petMood(sessions) {
  const top = (sessions || []).find((s) => !s.muted);
  return top ? moodOfStatus(top.status) : 'none';
}

// A session's own pet: a muted session's pet just sleeps.
function sessionMood(session) {
  return session.muted ? 'asleep' : moodOfStatus(session.status);
}

// Where a pet wants to be. "both" lives on the taskbar and goes up to the notch when a session
// needs you; without a visible notch the cat always stays on the ground.
function homeFor(placement, mood, hasPerch) {
  if (!hasPerch || placement === 'taskbar') return 'ground';
  if (placement === 'notch') return 'perch';
  return mood === 'alert' ? 'perch' : 'ground';
}

// Which sessions get a pet when there are more sessions than pets allowed: the most urgent
// first, but a session keeps its pet unless a clearly more urgent one turns up (one needing you
// beats an idle one; a busy one doesn't), so pets don't come and go as sessions change status.
const MOOD_RANK = { alert: 0, working: 1, error: 2, idle: 3, asleep: 4 };
const KEEP_BONUS = 2.5;
function choosePetSessions(sessions, withPets, max) {
  return sessions
    .map((s, i) => ({ s, i, rank: MOOD_RANK[sessionMood(s)] - (withPets.has(s.id) ? KEEP_BONUS : 0) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, max)
    .map((x) => x.s);
}

// Next species for a new session's pet: the next in order that no other pet has, if any.
function pickSpecies(species, used, next) {
  for (let k = 0; k < species.length; k++) {
    const i = (next + k) % species.length;
    if (!used.has(species[i])) return { species: species[i], next: i + 1 };
  }
  return { species: species[next % species.length], next: next + 1 };
}

function clip(text, max) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// What a pet holds up on its sign while its session needs you, or null.
function petSign(session) {
  if (!session || session.muted || (session.status !== 'approval' && session.status !== 'input')) return null;
  const kind = session.status === 'approval' ? 'approval' : 'question';
  return {
    kind,
    title: clip(session.label || (kind === 'approval' ? 'Needs approval' : 'Question for you'), SIGN_TITLE),
    text: clip(session.detail, SIGN_TEXT),
  };
}

// How a session's work weighs on its pet: it sweats when the context window is nearly full, and
// limps after several failed tool calls in a row (or while the session shows an error).
function petStrain(session) {
  if (!session || session.muted) return { sweat: false, limp: false };
  const u = session.usage || {};
  const sweat = u.contextLimit > 0 && u.contextTokens / u.contextLimit >= SWEAT_AT;
  let failed = 0;
  for (const a of session.activity || []) {
    if (a.running) continue;
    if (a.ok !== false) break;
    failed++;
  }
  return { sweat, limp: session.status === 'error' || failed >= LIMP_AFTER };
}

// Whether a session's todo list just got finished (every todo done), comparing the previous
// reading with the new one. A list seen finished from the start doesn't count.
function todosJustFinished(prev, next) {
  const finished = (t) => !!t && t.total > 0 && t.done >= t.total;
  return prev !== undefined && finished(next) && !finished(prev);
}

// One step of the thrown ball: it flies, bounces on the ground, rolls to a stop, and bounces off
// the ground's ends. ball: { x, y, vx, vy, resting }; ground: { left, right, y }.
function stepBall(ball, dt, ground) {
  if (ball.resting) return ball;
  const b = { ...ball };
  b.vy += GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (b.x < ground.left || b.x > ground.right) {
    b.x = clamp(b.x, ground.left, ground.right);
    b.vx = -b.vx * BALL_BOUNCE;
  }
  if (b.y >= ground.y) {
    b.y = ground.y;
    b.vy = Math.abs(b.vy) > 120 ? -Math.abs(b.vy) * BALL_BOUNCE : 0;
    if (b.vy === 0) {
      b.vx *= Math.max(0, 1 - BALL_FRICTION * dt);
      if (Math.abs(b.vx) < 8) {
        b.vx = 0;
        b.resting = true;
      }
    }
  }
  return b;
}

class PetBrain {
  // startAt: where along the ground (0 = left, 1 = right) the pet first appears.
  constructor({ random = Math.random, startAt = 0.8 } = {}) {
    this.random = random;
    this.startAt = startAt;
    this.leaving = false; // its session ended: walking off screen
    this.gone = false; // off screen; the pet can be removed
    this.mode = null; // 'ground' (standing on a floor) | 'wall' | 'perch' | 'leap' | 'air' | 'held'
    this.floorId = GROUND; // the floor it stands on: the taskbar, a window's top, another pet
    this.floorCx = null; // that floor's centre last step, to ride along when it moves
    this.wall = null; // climbing a screen edge: { side: -1 | 1, targetY, clingUntil }
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.act = null; // activity on a floor: { kind, until, targetX, bubble, moving, speed, then, offEdge }
    this.react = null; // short reaction: { kind, until }
    this.mood = null;
    this.moodSince = 0;
    this.lastNow = null;
    this.nextChaseAt = 0;
    this.leap = null; // { start, ms, x0, y0, to: 'perch' | floor id, arc }
    this.landedAt = -Infinity;
    this.nudging = null; // wellbeing reminder: { bubble: 'water' | 'stretch', until, approach }
    this.limping = false;
  }

  grab() {
    this.mode = 'held';
    this.act = null;
    this.react = null;
    this.leap = null;
    this.wall = null;
  }

  release(vx = 0, vy = 0) {
    if (this.mode !== 'held') return;
    this.mode = 'air';
    this.vx = clamp(vx, -MAX_FLING, MAX_FLING);
    this.vy = clamp(vy, -MAX_FLING, MAX_FLING);
  }

  // A pat (click): wakes it up, purrs, and dismisses a wellbeing nudge.
  pet(now) {
    if (this.mode === 'held') return;
    if (this.act && this.act.kind === 'sleep') this.act = null;
    this.nudging = null;
    this.moodSince = now; // stay awake for a while after a pat
    this.react = { kind: 'happy', until: now + REACT_MS.happy };
  }

  celebrate(now) {
    if (this.mode !== 'held') this.react = { kind: 'celebrate', until: now + REACT_MS.celebrate };
  }

  // A finished todo list: a backflip with confetti.
  party(now) {
    if (this.mode !== 'held') this.react = { kind: 'party', until: now + REACT_MS.party };
  }

  // Reached a new level: a happy hop with a star.
  levelUp(now) {
    if (this.mode !== 'held') this.react = { kind: 'celebrate', until: now + REACT_MS.celebrate, bubble: 'star' };
  }

  // A wellbeing reminder: runs over towards the cursor and shows the bubble until clicked.
  nudge(now, bubble) {
    if (this.act && this.act.kind === 'sleep') this.act = null;
    this.moodSince = now;
    this.nudging = { bubble, until: now + NUDGE_MS, approach: true };
  }

  // Double-clicked: chase the ball the manager just threw, then bring it back here. Only from the
  // ground (the taskbar), and not while its session needs you.
  fetch(now) {
    if (this.mode !== 'ground' || this.floorId !== GROUND || this.leaving || this.mood === 'alert') return false;
    this.react = null;
    this.act = { kind: 'fetch', homeX: this.x, carrying: false, until: now + FETCH_MS };
    return true;
  }

  isFetching() {
    return !!this.act && this.act.kind === 'fetch';
  }

  startle(now) {
    if (this.mode !== 'held') this.react = { kind: 'scared', until: now + REACT_MS.scared };
  }

  // Its session ended: it walks off the screen, then `gone` is set. dir: -1 left, 1 right, 0 the
  // nearer edge.
  leave(dir = 0) {
    this.leaving = true;
    this.leaveDir = dir;
    this.react = null;
  }

  // Hit by a flying pet: tumbles away from it. Returns whether it was knocked.
  knock(dir, now) {
    if (this.mode !== 'ground' && this.mode !== 'wall') return false;
    this.fall(dir * KNOCK_VX, -KNOCK_VY);
    this.react = { kind: 'scared', until: now + REACT_MS.scared };
    return true;
  }

  // Whether it can join in play (greet, chase, nap): awake, on a floor, not busy.
  canPlay() {
    return (
      this.mode === 'ground' &&
      !this.leaving &&
      !this.react &&
      PLAYFUL.has(this.mood) &&
      (!this.act || ['sit', 'walk', 'land'].includes(this.act.kind)) &&
      !(this.act && this.act.then)
    );
  }

  isAsleep() {
    return this.mode === 'ground' && !!this.act && this.act.kind === 'sleep';
  }

  // Play arranged by the pet manager: walk somewhere (then greet or nap), or chase another pet.
  play(act) {
    this.act = act;
  }

  // input: { ground: { left, right, y }, floors: [{ id, left, right, y }], walls: { left, right,
  //          top } | null, perch: { x, y } | null, placement, mood, cursor: { x, y }, hover,
  //          held: { x, y } | null, chase, roam, reducedMotion, strain: { sweat, limp },
  //          sign: { kind, title, text } | null, ball: { x, resting } | null }
  // Floors are where a pet can stand (x is the pet's centre): window tops, other pets' heads. The
  // ground (taskbar) is always one. Walls are the pet-centre x for climbing each screen edge.
  step(now, rawInput) {
    // Fetching pets keep running when the cursor (which just double-clicked them) is over them.
    const input = this.isFetching() ? { ...rawInput, hover: false } : rawInput;
    const { ground, perch = null, placement = 'both', mood = 'none', hover = false, reducedMotion = false } = input;
    const dt = this.lastNow === null ? 0 : clamp((now - this.lastNow) / 1000, 0, 0.1);
    this.lastNow = now;
    this.speed = input.speed || 1; // speed setting: walking, running and climbing
    this.limping = !!(input.strain && input.strain.limp);
    if (mood !== this.mood) {
      this.mood = mood;
      this.moodSince = now;
      // A fetch carries on through ordinary mood changes, but not when a session needs you.
      const keep = this.act && (this.act.kind === 'land' || (this.act.kind === 'fetch' && mood !== 'alert' && mood !== 'asleep'));
      if (this.act && !keep) this.act = null;
    }
    if (this.react && now >= this.react.until) this.react = null;
    if (this.nudging && now >= this.nudging.until) this.nudging = null;
    if (this.mode === null) {
      this.mode = 'ground';
      this.x = ground.left + (ground.right - ground.left) * this.startAt;
      this.y = ground.y;
      this.nextChaseAt = now + 30000;
    }
    const floors = [{ id: GROUND, ...ground }, ...(input.floors || [])];
    const home = this.leaving ? 'ground' : homeFor(placement, mood, !!perch);

    switch (this.mode) {
      case 'held':
        if (input.held) {
          this.x = input.held.x;
          this.y = input.held.y;
        }
        break;
      case 'perch':
        if (home === 'perch') {
          this.x = perch.x;
          this.y = perch.y;
        } else this.drop(now, ground, reducedMotion);
        break;
      case 'leap':
        this.stepLeap(now, home, perch, floors, ground, reducedMotion);
        break;
      case 'air':
        this.stepAir(dt, now, ground, floors);
        break;
      case 'wall':
        if (home === 'perch' && !hover) this.startLeap(now, perch, reducedMotion);
        else this.stepWall(dt, now, input);
        break;
      default:
        this.stepFloor(dt, now, input, floors, home);
    }
    return this.view(input);
  }

  stepFloor(dt, now, input, floors, home) {
    const { ground, perch = null, hover = false, reducedMotion = false } = input;
    const floor = floors.find((f) => f.id === this.floorId);
    if (!floor) {
      // The window closed or moved away, or the pet underneath left.
      this.fall();
      return;
    }
    const cx = (floor.left + floor.right) / 2;
    if (this.floorId !== GROUND && this.floorCx !== null) this.x += cx - this.floorCx; // ride along
    this.floorCx = cx;
    this.y = floor.y;
    if (this.leaving) {
      this.stepLeave(dt, ground, reducedMotion);
    } else {
      if (!(this.act && this.act.offEdge)) this.x = clamp(this.x, floor.left, floor.right);
      if (home === 'perch' && !hover && now - this.landedAt >= RELEAP_DELAY_MS) {
        this.startLeap(now, perch, reducedMotion);
        return;
      }
      this.stepGround(dt, now, input, floor);
    }
    // Walked off the end of a window (or off another pet): fall to whatever is below.
    if (this.mode === 'ground' && this.floorId !== GROUND && (this.x < floor.left - 1 || this.x > floor.right + 1)) {
      this.fall(this.facing * WALK_SPEED * 1.5);
    }
  }

  fall(vx = 0, vy = 0) {
    this.mode = 'air';
    this.vx = vx;
    this.vy = vy;
    this.act = null;
    this.wall = null;
    this.leap = null;
    this.floorCx = null;
  }

  drop(now, ground, reducedMotion) {
    if (reducedMotion) {
      this.land(now, { id: GROUND, ...ground });
      return;
    }
    this.fall();
  }

  // Trots past the chosen (or nearer) end of the ground, out of sight.
  stepLeave(dt, ground, reducedMotion) {
    if (!this.exitX) {
      const dir = this.leaveDir || (this.x - ground.left < ground.right - this.x ? -1 : 1);
      this.exitX = dir < 0 ? ground.left - LEAVE_PAST : ground.right + LEAVE_PAST;
    }
    if (reducedMotion || !this.moveToward(this.exitX, WALK_SPEED * 2.5, dt)) this.gone = true;
    this.act = { kind: 'walk', moving: true, offEdge: true };
  }

  land(now, floor) {
    this.mode = 'ground';
    this.floorId = floor.id;
    this.floorCx = (floor.left + floor.right) / 2;
    this.x = clamp(this.x, floor.left, floor.right);
    this.y = floor.y;
    this.vx = 0;
    this.vy = 0;
    this.wall = null;
    this.leap = null;
    this.landedAt = now;
    this.act = { kind: 'land', until: now + 500 };
  }

  startLeap(now, perch, reducedMotion) {
    this.act = null;
    this.wall = null;
    if (perch.x !== this.x) this.facing = perch.x > this.x ? 1 : -1;
    if (reducedMotion) {
      this.mode = 'perch';
      this.x = perch.x;
      this.y = perch.y;
      return;
    }
    this.mode = 'leap';
    this.leap = { start: now, ms: LEAP_MS, x0: this.x, y0: this.y, to: 'perch' };
  }

  // Hops up onto a floor that is within reach (a window's top, another pet).
  startHop(now, floor, reducedMotion) {
    const tx = clamp(this.x + (this.random() - 0.5) * 80, floor.left + 4, floor.right - 4);
    if (tx !== this.x) this.facing = tx > this.x ? 1 : -1;
    if (reducedMotion) {
      this.x = tx;
      this.land(now, floor);
      return;
    }
    this.mode = 'leap';
    this.act = null;
    this.leap = { start: now, ms: HOP_MS, x0: this.x, y0: this.y, to: floor.id, tx: tx - (floor.left + floor.right) / 2 };
  }

  // A leap to the notch (straight across, decelerating upwards to arrive at the top of the jump)
  // or a hop onto a floor (an arc). Targets are re-read every step: they can move mid-jump.
  stepLeap(now, home, perch, floors, ground, reducedMotion) {
    const l = this.leap;
    const t = clamp((now - l.start) / l.ms, 0, 1);
    if (l.to === 'perch') {
      if (home !== 'perch') {
        this.drop(now, ground, reducedMotion);
        return;
      }
      this.x = l.x0 + (perch.x - l.x0) * t;
      this.y = l.y0 + (perch.y - l.y0) * (2 * t - t * t);
      if (t >= 1) {
        this.mode = 'perch';
        this.leap = null;
      }
      return;
    }
    const floor = floors.find((f) => f.id === l.to);
    if (!floor) {
      this.fall();
      return;
    }
    const tx = (floor.left + floor.right) / 2 + l.tx;
    this.x = l.x0 + (tx - l.x0) * t;
    this.y = l.y0 + (floor.y - l.y0) * (2 * t - t * t) - HOP_ARC * 4 * t * (1 - t);
    if (t >= 1) this.land(now, floor);
  }

  stepAir(dt, now, ground, floors) {
    const prevY = this.y;
    this.vy += GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 1 - Math.min(1, dt * 0.8);
    if (this.x < ground.left || this.x > ground.right) {
      this.x = clamp(this.x, ground.left, ground.right);
      this.vx = -this.vx * 0.4;
    }
    if (Math.abs(this.vx) > 1) this.facing = this.vx > 0 ? 1 : -1;
    if (this.vy < 0) return;
    // Lands on the first floor it passes through on the way down.
    let landing = null;
    for (const f of floors) {
      if (this.x < f.left || this.x > f.right || f.y < prevY || f.y > this.y) continue;
      if (!landing || f.y < landing.y) landing = f;
    }
    if (landing) this.land(now, landing);
    else if (this.y >= ground.y) this.land(now, { id: GROUND, ...ground });
  }

  startClimb(now, side, input) {
    const { walls, ground } = input;
    if (!walls) return false;
    this.mode = 'wall';
    this.act = null;
    this.floorCx = null;
    this.facing = side;
    this.x = side > 0 ? walls.right : walls.left;
    const top = Math.min(walls.top, ground.y);
    this.wall = { side, targetY: ground.y - (0.25 + 0.7 * this.random()) * (ground.y - top), clingUntil: 0 };
    return true;
  }

  // Climbs up the screen edge, clings for a moment, then lets go and falls (or jumps off).
  stepWall(dt, now, input) {
    const { walls, mood = 'none', hover = false } = input;
    const w = this.wall;
    if (!walls || !w) {
      this.fall();
      return;
    }
    this.x = w.side > 0 ? walls.right : walls.left;
    this.facing = w.side;
    // Needing you, or being stroked: hold on where it is.
    if (mood === 'alert' || hover) return;
    const tired = mood === 'asleep' || (mood !== 'working' && now - this.moodSince >= (ACTIVITY[input.activity] || ACTIVITY.normal).sleepAfter);
    if (tired && !w.clingUntil) w.clingUntil = now;
    if (w.clingUntil) {
      if (now >= w.clingUntil) this.fall(-w.side * (60 + this.random() * 140), -120);
      return;
    }
    this.y = Math.max(w.targetY, this.y - CLIMB_SPEED * (this.speed || 1) * dt);
    if (this.y <= w.targetY + 0.5) w.clingUntil = now + 800 + this.random() * 2200;
  }

  stepGround(dt, now, input, floor) {
    const { mood = 'none', hover = false, cursor = null, chase = true, reducedMotion = false } = input;
    if (hover && mood !== 'alert') {
      // Being stroked: stop and purr; a sleeping pet wakes up.
      if (this.act && this.act.kind === 'sleep') this.act = null;
      if (this.act) this.act.moving = false;
      this.moodSince = now;
      return;
    }
    // Mid-backflip: stay on the spot.
    if (this.react && this.react.kind === 'party') {
      if (this.act) this.act.moving = false;
      return;
    }
    if (this.act && this.act.until && now >= this.act.until) this.act = null;
    // A wellbeing nudge: run over below the cursor first, then wait there with the bubble.
    if (this.nudging && this.nudging.approach && mood !== 'alert') {
      this.nudging.approach = false;
      const target = cursor ? clamp(cursor.x, floor.left, floor.right) : this.x;
      const until = this.nudging.until;
      this.act =
        !reducedMotion && Math.abs(target - this.x) > 30
          ? { kind: 'walk', targetX: target, speed: RUN_SPEED, then: () => ({ kind: 'sit', until }) }
          : { kind: 'sit', until };
    }
    if (!this.act) this.act = this.plan(now, input, floor);

    const nearCursor = cursorNear(cursor, floor);
    const canChase =
      chase &&
      !reducedMotion &&
      !this.limping &&
      mood !== 'alert' &&
      mood !== 'asleep' &&
      !['sleep', 'chase', 'land', 'greet', 'follow', 'fetch'].includes(this.act.kind) &&
      !this.act.then;
    if (canChase && now >= this.nextChaseAt && nearCursor) {
      this.act = { kind: 'chase', until: now + CHASE_MS };
      this.nextChaseAt = now + 60000 + this.random() * 90000;
    }

    const a = this.act;
    if (a.kind === 'walk') {
      // The floor can shrink mid-walk (display, taskbar or window change); never chase a target
      // off it, unless walking off its end on purpose.
      if (!a.offEdge) a.targetX = clamp(a.targetX, floor.left, floor.right);
      a.moving = this.moveToward(a.targetX, a.speed || WALK_SPEED, dt);
      if (!a.moving) this.act = a.then ? a.then(now, input) : { kind: 'sit', until: now + 2000 + this.random() * 4000 };
    } else if (a.kind === 'fetch') {
      this.stepFetch(dt, now, input.ball, floor);
    } else if (a.kind === 'hop') {
      this.act = null;
      this.startHop(now, a.floor, reducedMotion);
    } else if (a.kind === 'follow') {
      const target = clamp(a.target(), floor.left, floor.right);
      a.moving = Math.abs(target - this.x) > 14 && this.moveToward(target, RUN_SPEED * 0.9, dt);
    } else if (a.kind === 'greet') {
      this.facing = a.facing;
    } else if (a.kind === 'chase') {
      if (!nearCursor) {
        this.act = { kind: 'sit', until: now + 2000 };
        return;
      }
      const target = clamp(cursor.x, floor.left, floor.right);
      a.moving = Math.abs(target - this.x) > 6 && this.moveToward(target, RUN_SPEED, dt);
      if (!a.moving && cursor.x !== this.x) this.facing = cursor.x > this.x ? 1 : -1;
    }
  }

  // Fetch: run to the ball (waiting below it while it flies), pick it up once it rests, and bring
  // it back to where the pet was double-clicked. The manager moves the ball and watches `carry`.
  stepFetch(dt, now, ball, floor) {
    const a = this.act;
    if (!a.carrying) {
      if (!ball) {
        this.act = null;
        return;
      }
      const target = clamp(ball.x, floor.left, floor.right);
      a.moving = Math.abs(target - this.x) > FETCH_REACH / 2 && this.moveToward(target, RUN_SPEED, dt);
      if (!a.moving && ball.x !== this.x) this.facing = ball.x > this.x ? 1 : -1;
      if (ball.resting && Math.abs(ball.x - this.x) <= FETCH_REACH) a.carrying = true;
      return;
    }
    a.moving = this.moveToward(clamp(a.homeX, floor.left, floor.right), RUN_SPEED * 0.8, dt);
    if (!a.moving) this.act = { kind: 'sit', until: now + 3000, bubble: 'heart' };
  }

  // Returns whether the pet is still on its way.
  moveToward(targetX, speed, dt) {
    const dx = targetX - this.x;
    if (Math.abs(dx) < 1) return false;
    this.facing = dx > 0 ? 1 : -1;
    const pace = speed * (this.speed || 1) * (this.limping ? LIMP_SPEED : 1);
    this.x += Math.sign(dx) * Math.min(Math.abs(dx), pace * dt);
    return true;
  }

  plan(now, input, floor) {
    const r = this.random();
    const canWalk = !input.reducedMotion;
    // A limping pet doesn't climb or hop about.
    const roam = !!input.roam && canWalk && !this.limping;
    const activity = ACTIVITY[input.activity] || ACTIVITY.normal;
    const wanders = () => roam && this.random() < activity.roam && this.roamPlan(now, input, floor);
    switch (input.mood) {
      case 'alert':
        return { kind: 'alert' };
      case 'asleep':
        return { kind: 'sleep' };
      case 'error':
        return { kind: 'sit', until: now + 4000, bubble: 'question' };
      case 'working': {
        const wander = wanders();
        if (wander) return wander;
        if (canWalk && r < 0.55) return this.walk(floor, 80 + this.random() * 220);
        return { kind: 'sit', until: now + (2000 + this.random() * 4000) * activity.sit, bubble: this.random() < 0.5 ? 'dots' : null };
      }
      default: {
        if (now - this.moodSince >= (roam ? activity.sleepAfter : SLEEP_AFTER_MS)) return { kind: 'sleep' };
        const wander = wanders();
        if (wander) return wander;
        if (canWalk && r < 0.3) return this.walk(floor, 40 + this.random() * 110);
        return { kind: 'sit', until: now + (3000 + this.random() * 4000) * activity.sit };
      }
    }
  }

  // Roaming the screen: off to climb an edge, up onto a window or another pet, or off the end
  // of a window. Returns null to do something ordinary instead.
  roamPlan(now, input, floor) {
    const r = this.random();
    if (floor.id.startsWith('pet:')) return r < 0.4 ? this.walkOff(floor) : { kind: 'sit', until: now + 2000 + this.random() * 4000 };
    if (r < 0.15 && floor.id === GROUND && input.walls) {
      const side = this.x - floor.left < floor.right - this.x ? -1 : 1;
      return {
        kind: 'walk',
        targetX: side < 0 ? floor.left : floor.right,
        then: (t, inp) => (this.startClimb(t, side, inp) ? null : { kind: 'sit', until: t + 2000 }),
      };
    }
    if (r < 0.4) {
      const up = this.reachableFloor(input.floors || [], floor);
      if (up) return { kind: 'hop', floor: up };
    }
    if (r < 0.55 && floor.id !== GROUND) return this.walkOff(floor);
    return null;
  }

  walkOff(floor) {
    const dir = this.random() < 0.5 ? -1 : 1;
    return { kind: 'walk', targetX: dir < 0 ? floor.left - 40 : floor.right + 40, offEdge: true };
  }

  // A floor above that is close enough to hop onto.
  reachableFloor(floors, current) {
    const options = floors.filter(
      (f) =>
        f.id !== current.id &&
        f.y < this.y - 30 &&
        f.y > this.y - HOP_HEIGHT &&
        f.right - f.left >= 30 &&
        Math.max(f.left - this.x, this.x - f.right, 0) < HOP_REACH
    );
    return options.length ? options[Math.floor(this.random() * options.length) % options.length] : null;
  }

  walk(floor, distance) {
    let dir = this.random() < 0.5 ? -1 : 1;
    if (Math.abs(clamp(this.x + dir * distance, floor.left, floor.right) - this.x) < 20) dir = -dir;
    return { kind: 'walk', targetX: clamp(this.x + dir * distance, floor.left, floor.right) };
  }

  view({ mood = 'none', hover = false, strain = null, sign = null }) {
    const alert = mood === 'alert';
    let anim = 'sit';
    let bubble = null;
    let moving = false;
    const reactBubble = (r) => r.bubble || { happy: 'heart', celebrate: 'note', scared: 'question', party: 'note' }[r.kind] || null;
    if (this.mode === 'held') {
      anim = 'held';
      moving = true;
    } else if (this.mode === 'leap' || this.mode === 'air') {
      anim = this.mode === 'air' && this.vy >= 0 ? 'fall' : 'jump';
      moving = true;
    } else if (this.mode === 'wall') {
      moving = !this.wall.clingUntil && !alert && !hover;
      anim = moving ? 'climb' : 'cling';
      if (alert) bubble = 'alert';
      else if (hover) bubble = 'heart';
    } else if (this.mode === 'perch') {
      anim = 'hang';
      if (alert) bubble = 'alert';
      else if (hover) bubble = 'heart';
      else if (this.react) bubble = reactBubble(this.react);
      else if (mood === 'error') bubble = 'question';
      else if (mood === 'asleep' || (mood !== 'working' && this.lastNow - this.moodSince >= SLEEP_AFTER_MS)) bubble = 'zzz';
    } else if (this.leaving) {
      anim = 'walk';
      moving = true;
    } else if (alert) {
      anim = 'alert';
      bubble = 'alert';
    } else if (hover) {
      anim = 'happy';
      bubble = 'heart';
    } else if (this.react) {
      anim = this.react.kind;
      bubble = this.react.kind === 'party' || this.react.kind === 'scared' ? null : reactBubble(this.react);
    } else if (this.nudging && !(this.act && this.act.moving)) {
      anim = 'happy';
      bubble = this.nudging.bubble;
    } else if (this.act) {
      const a = this.act;
      if (a.kind === 'walk') anim = (a.speed || WALK_SPEED) > WALK_SPEED ? 'run' : 'walk';
      else if (a.kind === 'chase' || a.kind === 'follow' || a.kind === 'fetch') anim = a.moving ? 'run' : 'sit';
      else if (a.kind === 'greet') {
        anim = 'happy';
        bubble = 'heart';
      } else if (a.kind === 'sleep') {
        anim = 'sleep';
        bubble = 'zzz';
      } else bubble = a.bubble || null;
      moving = !!a.moving;
    }
    if (this.limping && this.mode === 'ground' && (anim === 'walk' || anim === 'run')) anim = 'limp';
    // A nudge stays visible while the pet runs over (unless something more urgent shows).
    if (this.nudging && !bubble && !alert && !hover && this.mode !== 'held') bubble = this.nudging.bubble;
    // On the ground, a pet whose session needs you holds up a sign instead of the "!".
    const shownSign = alert && sign && this.mode === 'ground' && !this.leaving ? sign : null;
    if (shownSign) bubble = null;
    return {
      x: this.x,
      y: this.y,
      anim,
      facing: this.facing,
      bubble,
      moving,
      effect: this.react && this.react.kind === 'party' && this.mode !== 'held' ? 'confetti' : null,
      carry: this.isFetching() && this.act.carrying ? 'ball' : null,
      sweat: !!(strain && strain.sweat) && this.mode !== 'held',
      sign: shownSign,
    };
  }
}

function cursorNear(cursor, floor) {
  if (!cursor) return false;
  return cursor.x >= floor.left - 60 && cursor.x <= floor.right + 60 && cursor.y >= floor.y - CHASE_BAND && cursor.y <= floor.y + 80;
}

// The parts of app windows' top edges that pets can stand on: windows are [{ id, x, y, width,
// height, cover }] topmost first; a window's top edge is hidden where a window above it covers
// that line. Windows marked `cover` (maximized) only hide others. Returns floors { id, left,
// right, y } at least minWidth wide.
function windowFloors(windows, minWidth = 40) {
  const floors = [];
  windows.forEach((w, i) => {
    if (w.cover) return;
    let segments = [[w.x, w.x + w.width]];
    for (const above of windows.slice(0, i)) {
      if (above.y > w.y || above.y + above.height <= w.y) continue;
      const [l, r] = [above.x, above.x + above.width];
      segments = segments.flatMap(([a, b]) => (r <= a || l >= b ? [[a, b]] : [[a, Math.min(b, l)], [Math.max(a, r), b]].filter(([x0, x1]) => x1 > x0)));
    }
    segments
      .filter(([a, b]) => b - a >= minWidth)
      .forEach(([a, b], k) => floors.push({ id: `win:${w.id}:${k}`, left: a, right: b, y: w.y }));
  });
  return floors;
}

module.exports = {
  PetBrain,
  petMood,
  sessionMood,
  homeFor,
  choosePetSessions,
  pickSpecies,
  windowFloors,
  petSign,
  petStrain,
  todosJustFinished,
  stepBall,
  SLEEP_AFTER_MS,
  ROAM_SLEEP_AFTER_MS,
  LEAP_MS,
  RELEAP_DELAY_MS,
  NUDGE_MS,
  REACT_MS,
};
