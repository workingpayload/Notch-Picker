'use strict';

const { EventEmitter } = require('events');

const MAX_MS = 24 * 60 * 60 * 1000;

// One quick timer (counting down) or stopwatch (counting up), owned by the main process so every
// notch window shows the same one. Emits 'change' with snapshot() and 'done' when a countdown ends.
class QuickTimer extends EventEmitter {
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = null; // { mode, durationMs, accumulatedMs, runningSince }
    this.handle = null;
  }

  elapsed(now = this.now()) {
    const s = this.state;
    if (!s) return 0;
    return s.accumulatedMs + (s.runningSince ? now - s.runningSince : 0);
  }

  // What the renderers need to draw it: elapsed = accumulatedMs + (now - runningSince).
  snapshot() {
    if (!this.state) return null;
    return { ...this.state };
  }

  start(durationMs) {
    const ms = Math.round(Number(durationMs));
    if (!Number.isFinite(ms) || ms < 1000) return false;
    this.state = { mode: 'timer', durationMs: Math.min(ms, MAX_MS), accumulatedMs: 0, runningSince: this.now() };
    this.changed();
    return true;
  }

  startStopwatch() {
    this.state = { mode: 'stopwatch', durationMs: 0, accumulatedMs: 0, runningSince: this.now() };
    this.changed();
    return true;
  }

  pause() {
    const s = this.state;
    if (!s || !s.runningSince) return false;
    s.accumulatedMs = this.elapsed();
    s.runningSince = null;
    this.changed();
    return true;
  }

  resume() {
    const s = this.state;
    if (!s || s.runningSince) return false;
    s.runningSince = this.now();
    this.changed();
    return true;
  }

  toggle() {
    if (!this.state) return false;
    return this.state.runningSince ? this.pause() : this.resume();
  }

  // Adds time to a countdown (e.g. "+1 min").
  add(ms) {
    const s = this.state;
    const n = Math.round(Number(ms));
    if (!s || s.mode !== 'timer' || !Number.isFinite(n) || n <= 0) return false;
    s.durationMs = Math.min(MAX_MS, s.durationMs + n);
    this.changed();
    return true;
  }

  stop() {
    if (!this.state) return false;
    this.state = null;
    this.changed();
    return true;
  }

  changed() {
    this.clearTimer(this.handle);
    this.handle = null;
    const s = this.state;
    if (s && s.runningSince) {
      const left = s.mode === 'timer' ? s.durationMs - this.elapsed() : MAX_MS - this.elapsed();
      if (left <= 0) {
        this.finish();
        return;
      }
      // Timers can fire early by a millisecond or two; finish() re-checks.
      this.handle = this.setTimer(() => this.check(), Math.min(left, 2 ** 31 - 1));
    }
    this.emit('change', this.snapshot());
  }

  check() {
    this.handle = null;
    const s = this.state;
    if (!s || !s.runningSince) return;
    const left = s.mode === 'timer' ? s.durationMs - this.elapsed() : MAX_MS - this.elapsed();
    if (left > 0) this.handle = this.setTimer(() => this.check(), left);
    else this.finish();
  }

  finish() {
    const s = this.state;
    this.state = null;
    this.clearTimer(this.handle);
    this.handle = null;
    this.emit('change', null);
    this.emit('done', { mode: s.mode, durationMs: s.mode === 'timer' ? s.durationMs : MAX_MS });
  }

  dispose() {
    this.clearTimer(this.handle);
    this.handle = null;
  }
}

// "5 min", "1 h 30 min", "45 s".
function describeDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s && !h) parts.push(`${s} s`);
  return parts.join(' ') || '0 s';
}

const TIMER_PRESETS_MIN = [1, 3, 5, 10, 15, 25, 30, 45, 60];

module.exports = { QuickTimer, describeDuration, TIMER_PRESETS_MIN, MAX_MS };
