'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { PetBrain, petMood, sessionMood, homeFor, choosePetSessions, pickSpecies, windowFloors } = require('./pet');
const { SPRITE_W, SPRITE_H, WIN_COLS, WIN_ROWS, SPECIES, COLLAR_COLORS, hitRects, petCell } = require('./pet-sprites');

// Speed and activity settings.
const SPEED = { lazy: 0.6, normal: 1, zippy: 1.6 };
const PLAY_EVERY = { calm: 2, normal: 1, playful: 0.4 }; // times PLAY_EVERY_MS
const FAST_TICK_MS = 16;
const SLOW_TICK_MS = 120;
// Movement that turns a press into a drag; fingers wobble more than a mouse.
const CLICK_SLOP = { mouse: 4, pen: 8, touch: 12 };
const STALE_PRESS_MS = 5000;
const FLING_WINDOW_MS = 100;
// Longest wait for a window to confirm it has drawn a pet before a hand-over goes ahead anyway.
const PAINT_WAIT_MS = 300;
// Gap between pets hanging side by side from the notch, in sprite pixels.
const PERCH_SPACING = 22;
// Pet windows are at least this many DIPs wide and tall: Windows won't make a window smaller than
// a minimum that depends on the display's scaling (about 56 px at 100%), and a window it silently
// enlarged would reach below the pet's feet, behind the taskbar.
const MIN_WINDOW = 64;
// How long after moving to another display a pet's shape keeps being re-applied.
const RESHAPE_MS = 500;
// Roaming and playing (sizes in sprite pixels).
const WALL_INSET = 8; // a climbing pet's centre is this far from the screen edge (its feet touch it)
const HEAD = 13; // height of a standing or sitting pet, for another pet to sit on
const SLEEPING_HEAD = 7;
const BUMP_SPEED = 500; // DIP/s a flying pet must reach to knock another over
const PLAY_DISTANCE = 700; // DIPs apart two pets may be to start playing
const PLAY_EVERY_MS = 25000; // roughly how often pets play
const PLAY_TICK_MS = 1500;
const GREET_MS = 2500;
const CHASE_PLAY_MS = 4500;
// Windows and Linux can clip a window to the pet's shape, so it takes mouse, touch and pen input
// directly. macOS can't: there the window is click-through until the cursor hovers the pet (Macs
// have no touch screens).
const USE_SHAPE = process.platform !== 'darwin';
const PET_TITLE = 'Notch Picker pet';

const windowOptions = (webPreferences, title) => ({
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  hasShadow: false,
  focusable: false,
  alwaysOnTop: true,
  show: false,
  title,
  webPreferences,
});

// One desktop pet: a small transparent window, input-transparent except over the pet, moved
// around by its PetBrain on a timer whose tick is fast only while something moves.
//
// Finger and pen drags use the manager's shared, click-through "carry" overlay. Windows keeps
// sending a touch to the window it started on, reports it relative to that window, and doesn't
// move the cursor with it; moving or resizing that window mid-drag garbles the positions and
// flashes stale frames. So while a finger or pen is on the pet, and through a throw until it
// lands, the pet's window stays put (still receiving the touch) and the overlay, spread over the
// display, draws the pet. Hand-overs are confirmed: a window stops drawing the pet only after the
// other reports it has painted it, at the same spot and pose (animations follow the wall clock),
// so the swap can't be seen.
class Pet {
  constructor(manager, { key, sessionId = null, species = 'cat', startAt = 0.8 }) {
    this.m = manager;
    this.key = key;
    this.sessionId = sessionId;
    this.species = species;
    this.mood = 'none';
    this.title = '';
    this.collar = null;
    this.rank = 0; // order among pets for spots on the notch (most urgent session first)
    this.win = null;
    this.ready = false;
    this.brain = new PetBrain({ startAt });
    this.timer = null;
    this.press = null; // button/finger down on the pet, not yet a drag: { x, y, t, type }
    this.held = null; // dragging: { dx, dy, samples }
    this.carrying = false; // drawn on the carry overlay (finger/pen on it, then its throw)
    this.carrySince = 0;
    this.carryPainted = false; // the overlay has confirmed drawing the pet
    this.handBack = false; // a carry ended: 'moving' (window moves, blank), then 'drawing'
    this.handBackSince = 0;
    this.touchPark = null; // where a finger lifted: Windows leaves the cursor there, which isn't a hover
    this.contact = null; // latest finger/pen position (screen DIPs) while pressed
    this.leaveDisplayId = null; // the display a leaving pet is walking off
    this.lastBounds = '';
    this.lastDisplayId = null;
    this.lastPayload = '';
    this.lastShape = '';
    this.reshapeUntil = 0;
    this.ignoringMouse = true;
    this.view = null;
    this.create();
  }

  create() {
    const { width, height } = this.m.size();
    const win = new BrowserWindow({ ...windowOptions(this.m.webPreferences, PET_TITLE), width, height });
    this.m.setup(win);
    if (USE_SHAPE) {
      this.applyShape(win, { anim: 'sit', facing: 1, bubble: null });
      win.setIgnoreMouseEvents(false);
      this.ignoringMouse = false;
    } else {
      win.setIgnoreMouseEvents(true);
      this.ignoringMouse = true;
    }
    win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
    win.once('ready-to-show', () => {
      // The page's <title> replaces the window title.
      win.setTitle(PET_TITLE);
      this.ready = true;
      this.schedule(0);
    });
    win.on('closed', () => this.m.forget(this));
    this.win = win;
    this.m.onWindowCreated(win);
  }

  alive() {
    return !!this.win && !this.win.isDestroyed();
  }

  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
    // Release the shared overlay if it is drawing this pet (also during a hand-back).
    if (this.m.carrier === this) this.m.endCarry(this);
    this.carrying = false;
    this.handBack = false;
    if (this.alive()) this.win.destroy();
    this.win = null;
  }

  // Its session ended (or lost its pet to a more urgent one): it walks off screen, then goes. It
  // heads for an edge of its display with no other display next to it, so it really disappears.
  leave() {
    const at = this.view ? { x: Math.round(this.view.x), y: Math.round(this.view.y - 1) } : null;
    const display = at ? screen.getDisplayNearestPoint(at) : screen.getPrimaryDisplay();
    const b = display.bounds;
    const beside = (side) =>
      screen.getAllDisplays().some((d) => {
        if (d.id === display.id || d.bounds.y >= b.y + b.height || d.bounds.y + d.bounds.height <= b.y) return false;
        return side < 0 ? Math.abs(d.bounds.x + d.bounds.width - b.x) <= 2 : Math.abs(d.bounds.x - (b.x + b.width)) <= 2;
      });
    const left = beside(-1);
    const right = beside(1);
    this.leaveDisplayId = display.id;
    this.brain.leave(left && !right ? 1 : right && !left ? -1 : 0);
    this.mood = 'none';
    this.schedule(0);
  }

  update({ mood, title, collar, species, rank }) {
    if (mood === 'alert' && this.mood !== 'alert' && this.updated) this.m.sound(this, 'alert');
    this.updated = true;
    this.mood = mood;
    this.title = title || '';
    this.collar = collar || null;
    this.species = species;
    this.rank = rank;
  }

  // Screen rectangle of the pet's sprite, for hover and click hit-testing.
  petRect() {
    if (!this.view) return null;
    const cell = this.m.cell();
    return { x: this.view.x - (SPRITE_W * cell) / 2, y: this.view.y - SPRITE_H * cell, width: SPRITE_W * cell, height: SPRITE_H * cell };
  }

  // Pointer events from the pet's window: mouse, touch or pen. For touch and pen `point` is the
  // contact's position in the window (the system cursor doesn't follow it). The window doesn't
  // move while pressed, so its position turns that into a screen position.
  pointer(phase, type = 'mouse', point = null) {
    // While a thrown pet flies on the overlay its window is blank where it used to be; a press
    // there isn't on the pet.
    if (phase === 'down' && this.carrying && !this.press) return;
    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();
    if (type !== 'mouse' && point) {
      const origin = this.win.getBounds();
      this.contact = { x: origin.x + point.x, y: origin.y + point.y };
    }
    if (phase === 'move') {
      // Follow the finger as soon as it moves, not on the next timer tick.
      if (this.press && type !== 'mouse') this.schedule(0);
      return;
    }
    if (phase === 'down') {
      this.press = { ...(type !== 'mouse' && this.contact ? this.contact : cursor), t: now, type };
      this.touchPark = null;
      if (type !== 'mouse' && this.view && this.m.startCarry(this)) {
        this.carrying = true;
        this.carryPainted = false;
        this.carrySince = now;
        this.handBack = false;
      }
    } else if (phase === 'up' || phase === 'cancel') {
      if (this.held) {
        const { vx, vy } = this.fling(now);
        this.brain.release(vx, vy);
      } else if (this.press && phase === 'up' && !this.m.onActivate(this.sessionId)) {
        this.brain.pet(now);
        this.m.sound(this, 'pet');
      }
      if (type !== 'mouse') this.touchPark = cursor;
      this.press = null;
      this.held = null;
      this.contact = null;
      // The overlay hands the pet back in tick(): right away after a tap, after landing after a throw.
    }
    this.schedule(0);
  }

  // The pet's window (not the overlay) reports it has drawn the pet after being blank.
  painted() {
    if (this.handBack !== 'drawing') return;
    this.handBack = false;
    this.m.endCarry(this);
  }

  // Clips the window (drawing and input) to the pet and its bubble; elsewhere clicks and touches
  // reach the windows underneath. The pet's box sits at the window's bottom-centre. Windows applies
  // the shape in physical pixels at the window's current scale, so it is applied again for a
  // moment after the pet moves to a display with different scaling.
  applyShape(w, view, now = 0) {
    const cell = this.m.cell();
    const { width, height } = this.m.size();
    const box = this.m.boxSize();
    const ox = (width - box.width) / 2;
    const oy = height - box.height;
    const rects = hitRects(view).map((r) => ({ x: ox + r.x * cell, y: oy + r.y * cell, width: r.width * cell, height: r.height * cell }));
    const key = JSON.stringify(rects);
    if (key === this.lastShape && now >= this.reshapeUntil) return;
    this.lastShape = key;
    w.setShape(rects);
  }

  // Release velocity from the last ~100 ms of dragging, so the pet can be tossed.
  fling(now) {
    const samples = this.held.samples.filter((s) => now - s.t <= FLING_WINDOW_MS);
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt } : { vx: 0, vy: 0 };
  }

  schedule(ms) {
    if (!this.alive() || !this.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  send(payload) {
    const json = JSON.stringify(payload);
    if (json === this.lastPayload) return;
    this.lastPayload = json;
    this.win.webContents.send('pet:view', payload);
  }

  tick() {
    const w = this.win;
    if (!this.alive() || !this.ready) return;
    if (this.brain.gone) {
      this.m.forget(this);
      return;
    }
    const values = this.m.getSettings();
    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();
    const cell = this.m.cell();

    // A press whose release never arrived (e.g. the window hid mid-click) must not keep the pet clickable.
    if (this.press && !this.held && now - this.press.t > STALE_PRESS_MS) this.press = null;
    // What's pressing the pet: the mouse cursor, or a finger/pen contact reported by the renderer.
    const pointer = this.press && this.press.type !== 'mouse' && this.contact ? this.contact : cursor;
    const slop = this.press ? CLICK_SLOP[this.press.type] || CLICK_SLOP.mouse : 0;
    if (this.press && !this.held && Math.hypot(pointer.x - this.press.x, pointer.y - this.press.y) > slop) {
      this.brain.grab();
      const view = this.view || pointer;
      this.held = { dx: view.x - this.press.x, dy: view.y - this.press.y, samples: [] };
    }
    let held = null;
    if (this.held) {
      held = { x: pointer.x + this.held.dx, y: pointer.y + this.held.dy };
      this.held.samples.push({ t: now, ...held });
      this.held.samples = this.held.samples.filter((s) => now - s.t <= FLING_WINDOW_MS * 2);
    }

    const at = this.view ? { x: Math.round(this.view.x), y: Math.round(this.view.y - 1) } : null;
    // A leaving pet keeps to the display it is leaving, and goes once it is entirely off it.
    const leavingFrom = this.brain.leaving && screen.getAllDisplays().find((d) => d.id === this.leaveDisplayId);
    const display = leavingFrom || (at ? screen.getDisplayNearestPoint(at) : screen.getPrimaryDisplay());
    if (leavingFrom && this.view) {
      const half = (SPRITE_W * cell) / 2;
      const b = leavingFrom.bounds;
      if (this.view.x + half < b.x || this.view.x - half > b.x + b.width) {
        this.m.forget(this);
        return;
      }
    }
    const rect = this.petRect();
    // Only a real mouse hovers: after a tap Windows leaves the cursor where the finger lifted.
    if (this.touchPark && Math.hypot(cursor.x - this.touchPark.x, cursor.y - this.touchPark.y) > 2) this.touchPark = null;
    // A finger resting on the pet counts as stroking it (and keeps it still under the finger).
    const touching = !!this.press && !this.held && this.press.type !== 'mouse';
    const hover =
      touching ||
      (!this.held && !this.touchPark && !!rect && cursor.x >= rect.x && cursor.x < rect.x + rect.width && cursor.y >= rect.y && cursor.y < rect.y + rect.height);

    const view = this.brain.step(now, {
      ground: this.m.ground(display),
      floors: this.m.floorsFor(this),
      walls: values.petRoam ? this.m.walls(display) : null,
      roam: values.petRoam,
      perch: values.petPlacement === 'taskbar' ? null : this.m.perchFor(this),
      placement: values.petPlacement,
      mood: this.mood,
      cursor,
      hover,
      held,
      chase: values.petChaseCursor,
      speed: SPEED[values.petSpeed] || 1,
      activity: values.petActivity,
      reducedMotion: this.m.reducedMotion,
    });
    this.view = view;
    if (values.petPlay) this.m.bump(this, now);

    // The window is at least the pet's box; the box sits at its bottom-centre (the pet's feet at
    // the window's bottom edge).
    const { width, height } = this.m.size();
    const winBox = { x: Math.round(view.x - width / 2), y: Math.round(view.y - height), width, height };
    const petBox = this.m.boxSize();
    const box = { x: Math.round(view.x - petBox.width / 2), y: Math.round(view.y - petBox.height), ...petBox };
    const shownOn = screen.getDisplayNearestPoint({ x: Math.round(view.x), y: Math.round(view.y - 1) });
    const payload = {
      anim: view.anim,
      facing: view.facing,
      bubble: view.bubble,
      species: this.species,
      palette: values.petColor,
      collar: this.collar,
      title: this.title,
      cell,
      held: !!this.held,
    };

    // Hand the pet back to its window when nothing holds it and it isn't flying: right away after
    // a tap, after landing after a throw (it's still then, so the swap can't be seen). Also if it
    // left the overlay's display. The window first moves there while blank, and only draws the
    // pet on the next tick, once the move has taken effect.
    if (this.carrying && !this.press && !this.held && (this.brain.mode !== 'air' || !this.m.carryOn(shownOn))) {
      this.carrying = false;
      this.handBack = 'moving';
      this.handBackSince = now;
    }
    // If a window never confirms its paint, don't wait for ever.
    if (this.carrying && !this.carryPainted && now - this.carrySince > PAINT_WAIT_MS) this.carryPainted = true;
    if (this.handBack && now - this.handBackSince > PAINT_WAIT_MS) {
      this.handBack = 'drawing';
      this.painted();
    }

    // The overlay draws the pet while carried, and through a hand-back too, so both windows show
    // the same pet until this window has taken over.
    if (this.carrying || this.handBack) this.m.drawCarry(this, payload, box);
    if (this.carrying) {
      // The window, which doesn't move (it still receives the touch), keeps drawing the pet until
      // the overlay has, then draws nothing.
      if (this.carryPainted) this.send({ ...payload, hidden: true });
    } else {
      const key = JSON.stringify(winBox);
      if (key !== this.lastBounds) {
        this.lastBounds = key;
        w.setBounds(winBox);
        if (shownOn.id !== this.lastDisplayId) {
          // Moving across monitors with different scaling can apply the old scale factor once,
          // and the shape is converted at the window's scale at the time.
          w.setBounds(winBox);
          this.reshapeUntil = now + RESHAPE_MS;
        }
        this.lastDisplayId = shownOn.id;
        // Windows enforces a minimum window size (which depends on the display's scaling). If
        // it gave the window more room than asked, use that size from now on, so the window is
        // placed by its real bottom edge instead of reaching below the pet's feet.
        const got = w.getBounds();
        if (got.width > winBox.width + 2 || got.height > winBox.height + 2) {
          this.m.growWindow(got.width, got.height);
          this.lastBounds = '';
          this.reshapeUntil = now + RESHAPE_MS;
        }
      }
      if (USE_SHAPE) this.applyShape(w, view, now);
      else {
        const wantMouse = hover || !!this.held || !!this.press;
        if (wantMouse === this.ignoringMouse) {
          this.ignoringMouse = !wantMouse;
          w.setIgnoreMouseEvents(!wantMouse);
        }
      }
      if (this.handBack === 'moving') {
        this.send({ ...payload, hidden: true });
        this.handBack = 'drawing';
      } else this.send(payload);
      const visible = this.held || !this.m.hiddenDisplays.has(shownOn.id);
      if (visible && !w.isVisible()) {
        w.showInactive();
        w.setAlwaysOnTop(true, 'screen-saver');
      } else if (!visible && w.isVisible()) w.hide();
    }

    this.schedule(view.moving || hover || this.press || this.held || this.carrying || this.handBack ? FAST_TICK_MS : SLOW_TICK_MS);
  }
}

// Owns the desktop pets: either one pet that follows the most urgent session, or one per session
// (up to a maximum), each reacting to its own session. Also owns the carry overlay they share.
class PetManager {
  constructor({ webPreferences, getSettings, getPerchRect, onActivate = () => false, onWindowCreated = () => {}, isQuiet = () => false }) {
    // Pet sounds play without a click in that window first.
    this.webPreferences = { ...webPreferences, autoplayPolicy: 'no-user-gesture-required' };
    this.isQuiet = isQuiet;
    this.getSettings = getSettings;
    this.getPerchRect = getPerchRect;
    this.onActivate = onActivate;
    this.onWindowCreated = onWindowCreated;
    this.pets = new Map(); // key ('single' or a session id) -> Pet
    this.leaving = new Set(); // pets walking off screen
    this.sessions = [];
    this.autoSpecies = new Map(); // session id -> species picked automatically this run
    this.nextSpecies = 0;
    this.carry = null; // { win, ready, bounds, displayId, hideTimer }
    this.carrier = null; // the pet the overlay is drawing
    this.lastCarryPayload = '';
    this.hiddenDisplays = new Set();
    this.reducedMotion = false;
    this.grown = { width: 0, height: 0 }; // smallest pet window Windows has allowed, in DIPs
    this.windowFloors = []; // tops of app windows pets can walk on
    this.nextPlayAt = Date.now() + PLAY_EVERY_MS / 2;
    this.playTimer = null;
  }

  all() {
    return [...this.pets.values(), ...this.leaving];
  }

  petFor(webContents) {
    return this.all().find((p) => p.alive() && p.win.webContents === webContents) || null;
  }

  isPetWindow(webContents) {
    return !!this.petFor(webContents);
  }

  isCarryWindow(webContents) {
    return !!this.carry && !this.carry.win.isDestroyed() && this.carry.win.webContents === webContents;
  }

  // Every window the pets use (to recognise them as the app's own).
  windows() {
    const wins = this.all().filter((p) => p.alive()).map((p) => p.win);
    if (this.carry && !this.carry.win.isDestroyed()) wins.push(this.carry.win);
    return wins;
  }

  // What a pet window shows, for its menu: { sessionId, species }.
  info(webContents) {
    const p = this.petFor(webContents);
    return p ? { sessionId: p.sessionId, species: p.species, window: p.win } : null;
  }

  // Creates, updates and removes pets to match the settings.
  sync() {
    const values = this.getSettings();
    if (!values.pet) {
      this.destroyAll();
      return;
    }
    if (USE_SHAPE && !this.carry) this.createCarry();
    if (!this.playTimer) this.playTimer = setInterval(() => this.playTick(), PLAY_TICK_MS);
    // Switching modes replaces the pets outright.
    for (const p of this.all()) if ((values.petMode === 'single') !== (p.key === 'single')) this.forget(p);
    this.setSessions(this.sessions);
    for (const w of this.windows()) w.setContentProtection(values.hideFromScreenCapture);
    for (const p of this.all()) {
      p.lastPayload = '';
      p.schedule(0);
    }
    this.lastCarryPayload = '';
  }

  // Latest sessions (sorted by urgency, muted last, with labels applied).
  setSessions(sessions) {
    this.sessions = sessions;
    const values = this.getSettings();
    if (!values.pet) return;
    if (values.petMode === 'single') {
      let pet = this.pets.get('single');
      if (!pet) {
        pet = new Pet(this, { key: 'single', species: values.petSingleSpecies });
        this.pets.set('single', pet);
      }
      pet.update({ mood: petMood(sessions), title: '', collar: null, species: values.petSingleSpecies, rank: 0 });
      return;
    }
    const withPets = new Set(this.pets.keys());
    const chosen = choosePetSessions(sessions, withPets, values.petMax);
    const chosenIds = new Set(chosen.map((s) => s.id));
    for (const [id, pet] of this.pets) {
      if (chosenIds.has(id)) continue;
      this.pets.delete(id);
      this.leaving.add(pet);
      pet.leave();
    }
    for (const s of chosen) {
      let pet = this.pets.get(s.id);
      if (!pet) {
        pet = new Pet(this, { key: s.id, sessionId: s.id, species: this.speciesFor(s.id), startAt: 0.2 + Math.random() * 0.65 });
        this.pets.set(s.id, pet);
      }
      pet.update({
        mood: sessionMood(s),
        title: s.name,
        collar: COLLAR_COLORS[s.tag] || null,
        species: this.speciesFor(s.id),
        rank: sessions.indexOf(s),
      });
    }
  }

  // The species picked automatically for a session this run, if any (for the settings window).
  autoSpeciesOf(sessionId) {
    return this.autoSpecies.get(sessionId) || null;
  }

  hasPet(sessionId) {
    return this.pets.has(sessionId);
  }

  // A session's species: the one picked for it in its menu, else the next one in turn.
  speciesFor(sessionId) {
    const chosen = this.getSettings().petSpecies[sessionId];
    if (chosen) return chosen;
    if (!this.autoSpecies.has(sessionId)) {
      const used = new Set([...this.pets.values()].filter((p) => p.sessionId && p.sessionId !== sessionId).map((p) => p.species));
      const pick = pickSpecies(SPECIES, used, this.nextSpecies);
      this.nextSpecies = pick.next;
      this.autoSpecies.set(sessionId, pick.species);
    }
    return this.autoSpecies.get(sessionId);
  }

  // Removes a pet (and its window) immediately.
  forget(pet) {
    if (this.pets.get(pet.key) === pet) this.pets.delete(pet.key);
    this.leaving.delete(pet);
    pet.destroy();
  }

  destroyAll() {
    clearInterval(this.playTimer);
    this.playTimer = null;
    for (const p of this.all()) this.forget(p);
    if (this.carry && !this.carry.win.isDestroyed()) this.carry.win.destroy();
    this.carry = null;
    this.carrier = null;
  }

  // Done or error in a session (single mode: in any session).
  celebrate(sessionId) {
    const p = this.pets.get(this.pets.has('single') ? 'single' : sessionId);
    if (p) p.brain.celebrate(Date.now());
  }

  startle(sessionId) {
    const p = this.pets.get(this.pets.has('single') ? 'single' : sessionId);
    if (p) p.brain.startle(Date.now());
  }

  pointer(webContents, phase, type, point) {
    const p = this.petFor(webContents);
    if (p) p.pointer(phase, type, point);
  }

  // A pet window or the overlay reports it has drawn a pet after being blank.
  painted(webContents) {
    if (this.isCarryWindow(webContents)) {
      const p = this.carrier;
      if (p && p.carrying && !p.carryPainted) {
        p.carryPainted = true;
        p.schedule(0);
      }
      return;
    }
    const p = this.petFor(webContents);
    if (p) p.painted();
  }

  cell() {
    const values = this.getSettings();
    return petCell(values.petSize, values.size);
  }

  // The pet's box: sprite plus room for speech bubbles.
  boxSize() {
    const cell = this.cell();
    return { width: WIN_COLS * cell, height: WIN_ROWS * cell };
  }

  // A pet window: the box, but never smaller than Windows allows (see growWindow).
  size() {
    const box = this.boxSize();
    return { width: Math.max(box.width, MIN_WINDOW, this.grown.width), height: Math.max(box.height, MIN_WINDOW, this.grown.height) };
  }

  // Windows gave a pet window more room than asked for (its minimum size): use at least that.
  growWindow(width, height) {
    this.grown = { width: Math.max(this.grown.width, width), height: Math.max(this.grown.height, height) };
  }

  setHiddenDisplays(ids) {
    this.hiddenDisplays = ids;
  }

  // A pet's call (meow, woof, oink, baa): kind 'alert' when its session needs you, 'pet' when
  // petted. Only with pet sounds and the app's sound on, and not in Focus Assist / quiet hours.
  sound(pet, kind) {
    const values = this.getSettings();
    if (!values.petSounds || !values.sound || this.isQuiet() || !pet.alive()) return;
    pet.win.webContents.send('pet:sound', { species: pet.species, kind });
  }

  setReducedMotion(reduced) {
    this.reducedMotion = !!reduced;
  }

  setup(win) {
    win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(this.getSettings().hideFromScreenCapture);
  }

  reassertTopmost() {
    for (const w of this.windows()) if (w.isVisible()) w.setAlwaysOnTop(true, 'screen-saver');
  }

  // Walkable line along the top of the taskbar (the bottom of the work area) of a display.
  ground(display) {
    const wa = display.workArea;
    const half = (SPRITE_W * this.cell()) / 2;
    return { left: wa.x + half, right: wa.x + wa.width - half, y: wa.y + wa.height };
  }

  // Where a climbing pet's centre is against each side of a display, and how high it may climb.
  walls(display) {
    const wa = display.workArea;
    const cell = this.cell();
    return { left: wa.x + WALL_INSET * cell, right: wa.x + wa.width - WALL_INSET * cell, top: wa.y + WIN_ROWS * cell };
  }

  // The visible app windows (DIPs, topmost first), whose tops pets can walk on. A window top
  // with no room above it for a pet (e.g. at the top of the screen) isn't one.
  setWindows(windows) {
    const headroom = this.boxSize().height;
    this.windowFloors = windowFloors(windows).filter((f) => {
      const d = screen.getDisplayNearestPoint({ x: Math.round((f.left + f.right) / 2), y: Math.round(f.y) });
      return f.y - headroom >= d.workArea.y && f.y < d.workArea.y + d.workArea.height - 8;
    });
  }

  // What a pet can stand on besides the taskbar: window tops (when roaming) and other pets'
  // heads (when they play), but not a pet that is standing on it.
  floorsFor(pet) {
    const values = this.getSettings();
    const floors = values.petRoam ? [...this.windowFloors] : [];
    if (!values.petPlay) return floors;
    const cell = this.cell();
    for (const p of this.pets.values()) {
      if (p === pet || !p.view || p.brain.mode !== 'ground' || p.brain.floorId === `pet:${pet.key}`) continue;
      const head = (p.view.anim === 'sleep' ? SLEEPING_HEAD : HEAD) * cell;
      floors.push({ id: `pet:${p.key}`, left: p.view.x - 5 * cell, right: p.view.x + 5 * cell, y: p.view.y - head });
    }
    return floors;
  }

  // A pet flying fast (thrown or falling) knocks over the pets it hits.
  bump(pet, now) {
    const b = pet.brain;
    if (b.mode !== 'air' || Math.hypot(b.vx, b.vy) < BUMP_SPEED) return;
    const cell = this.cell();
    for (const other of this.pets.values()) {
      if (other === pet || !other.view || now < (other.bumpedUntil || 0)) continue;
      const dx = other.view.x - b.x;
      const dy = other.view.y - b.y;
      if (Math.abs(dx) > 12 * cell || Math.abs(dy) > 12 * cell) continue;
      if (other.brain.knock(dx >= 0 ? 1 : -1, now)) {
        other.bumpedUntil = now + 1000;
        other.schedule(0);
      }
    }
  }

  // Now and then, two pets on the same floor play: greet each other, chase, or one curls up next
  // to a sleeping one.
  playTick() {
    const values = this.getSettings();
    const now = Date.now();
    if (!values.petPlay || values.petMode !== 'perSession' || now < this.nextPlayAt) return;
    const pets = [...this.pets.values()].filter((p) => p.view && p.alive() && p.ready);
    const cell = this.cell();
    const options = [];
    for (const a of pets) {
      for (const b of pets) {
        if (a === b || a.brain.floorId !== b.brain.floorId || Math.abs(a.view.x - b.view.x) > PLAY_DISTANCE) continue;
        if (!a.brain.canPlay()) continue;
        if (b.brain.isAsleep() && a.brain.mood !== 'working') options.push(['nap', a, b]);
        else if (b.brain.canPlay() && a.key < b.key) options.push([Math.random() < 0.5 ? 'greet' : 'chase', a, b]);
      }
    }
    if (!options.length) return;
    const [kind, a, b] = options[Math.floor(Math.random() * options.length)];
    this.nextPlayAt = now + PLAY_EVERY_MS * (PLAY_EVERY[values.petActivity] || 1) * (0.6 + Math.random() * 0.8);
    if (kind === 'nap') {
      const side = a.view.x < b.view.x ? -1 : 1;
      a.brain.play({ kind: 'walk', targetX: b.view.x + side * 14 * cell, then: () => ({ kind: 'sleep' }) });
    } else if (kind === 'greet') {
      const [left, right] = a.view.x < b.view.x ? [a, b] : [b, a];
      const mid = (left.view.x + right.view.x) / 2;
      left.brain.play({ kind: 'walk', targetX: mid - 7 * cell, then: (t) => ({ kind: 'greet', facing: 1, until: t + GREET_MS }) });
      right.brain.play({ kind: 'walk', targetX: mid + 7 * cell, then: (t) => ({ kind: 'greet', facing: -1, until: t + GREET_MS }) });
    } else {
      const [runner, chaser] = Math.random() < 0.5 ? [a, b] : [b, a];
      const away = runner.view.x >= chaser.view.x ? 1 : -1;
      runner.brain.play({ kind: 'walk', targetX: runner.view.x + away * 500, speed: 130 });
      chaser.brain.play({ kind: 'follow', target: () => runner.brain.x, until: now + CHASE_PLAY_MS });
    }
    a.schedule(0);
    b.schedule(0);
  }

  // Where a pet's bottom-centre goes to hang from the pill: its paws (sprite row 1) overlap the
  // pill's bottom edge by one pixel. Pets that want to hang there line up from the pill's right
  // end, most urgent session first; one that doesn't fit stays on the ground (a small pill has
  // room for one, in the middle).
  perchFor(pet) {
    const rect = this.getPerchRect();
    if (!rect) return null;
    const placement = this.getSettings().petPlacement;
    const wanting = [...this.pets.values()].filter((p) => homeFor(placement, p.mood, true) === 'perch').sort((a, b) => a.rank - b.rank);
    const i = wanting.indexOf(pet);
    if (i < 0) return null;
    const cell = this.cell();
    let x;
    if (rect.width < 28 * cell) {
      if (i > 0) return null;
      x = rect.x + rect.width / 2;
    } else {
      x = rect.x + rect.width - 14 * cell - i * PERCH_SPACING * cell;
      if (x < rect.x + 6 * cell) return null;
    }
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(rect.y) });
    const half = (SPRITE_W * cell) / 2;
    const b = display.bounds;
    return { x: Math.min(Math.max(x, b.x + half), b.x + b.width - half), y: rect.y + rect.height - 2 * cell + SPRITE_H * cell };
  }

  // ---- Carry overlay (finger/pen drags) ----

  // The overlay is never hidden or shown (Windows fades windows in, so the pet would flicker): it
  // stays on screen as a tiny invisible window and is resized instead.
  createCarry() {
    const parked = this.parkedBounds();
    const win = new BrowserWindow({ ...windowOptions(this.webPreferences, 'Notch Picker pet (carried)'), ...parked });
    this.setup(win);
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
    const carry = { win, ready: false, bounds: parked, displayId: null, hideTimer: null };
    win.once('ready-to-show', () => {
      win.setTitle('Notch Picker pet (carried)');
      carry.ready = true;
      win.showInactive();
    });
    win.on('closed', () => {
      if (this.carry === carry) this.carry = null;
    });
    this.carry = carry;
    this.onWindowCreated(win);
  }

  // Where the idle overlay waits: a tiny transparent, click-through window in a corner (Windows
  // may enforce a larger minimum size; it's still invisible).
  parkedBounds() {
    const b = screen.getPrimaryDisplay().bounds;
    return { x: b.x, y: b.y, width: 2, height: 2 };
  }

  carryReady() {
    return !!this.carry && this.carry.ready && !this.carry.win.isDestroyed();
  }

  // Whether the overlay covers that display.
  carryOn(display) {
    return !!this.carry && this.carry.displayId === display.id;
  }

  // A finger or pen touched a pet: the overlay spreads over its display (blank) to draw it there.
  // Only one pet is carried at a time; a second finger on another pet just doesn't use it.
  startCarry(pet) {
    if (!this.carryReady() || (this.carrier && this.carrier !== pet)) return false;
    const c = this.carry;
    clearTimeout(c.hideTimer);
    const display = screen.getDisplayNearestPoint({ x: Math.round(pet.view.x), y: Math.round(pet.view.y - 1) });
    if (c.displayId !== display.id) {
      c.bounds = { ...display.bounds };
      c.displayId = display.id;
      c.win.setBounds(c.bounds);
      c.win.setBounds(c.bounds);
      this.lastCarryPayload = '';
    }
    this.carrier = pet;
    return true;
  }

  // Draws the carried pet on the overlay with its box (sprite plus bubble room) at `box`. `fit` is the overlay size the drawing
  // is meant for: the overlay confirms the paint only once it has that size.
  drawCarry(pet, payload, box) {
    if (this.carrier !== pet || !this.carryReady()) return;
    const c = this.carry;
    const view = { ...payload, origin: { x: box.x - c.bounds.x, y: box.y - c.bounds.y }, fit: { width: c.bounds.width, height: c.bounds.height } };
    this.sendCarry(view);
  }

  sendCarry(view) {
    const json = JSON.stringify(view);
    if (json === this.lastCarryPayload) return;
    this.lastCarryPayload = json;
    this.carry.win.webContents.send('pet:view', view);
  }

  // The pet's own window has taken over again: clear the overlay, then park it once that clear
  // has had time to paint (a shrunken window keeps its last frame, which would show when it is
  // next spread out).
  endCarry(pet) {
    if (this.carrier !== pet) return;
    this.carrier = null;
    if (!this.carryReady()) return;
    const c = this.carry;
    clearTimeout(c.hideTimer);
    this.sendCarry({ hidden: true });
    c.hideTimer = setTimeout(() => {
      if (this.carrier || c.win.isDestroyed()) return;
      c.bounds = this.parkedBounds();
      c.displayId = null;
      c.win.setBounds(c.bounds);
    }, 100);
  }
}

module.exports = { PetManager };
