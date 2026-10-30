'use strict';

// Wellbeing reminders, free of Electron so they can be unit tested: a stretch break after a long
// stretch at the computer, and a sip of water every so often. Presence comes from the system's
// idle time: no keyboard or mouse input for a while means you're away, which counts as a break.

const AWAY_SEC = 5 * 60; // this long without input resets the stretch timer
const WATER_AWAY_SEC = 20 * 60; // ...and this long the water timer too
const MAX_STEP_MS = 60000; // longer gaps (sleep, a stalled timer) don't count as time at the desk

class Wellbeing {
  constructor() {
    this.lastTick = null;
    this.activeMs = { stretch: 0, water: 0 };
  }

  // values: { petBreaks, petBreakMinutes, petWater, petWaterMinutes }; idleSec: seconds since the
  // last input. Returns the reminders now due: 'stretch' and/or 'water'.
  tick(now, idleSec, values) {
    const dt = this.lastTick === null ? 0 : Math.max(0, Math.min(now - this.lastTick, MAX_STEP_MS));
    this.lastTick = now;
    if (idleSec >= AWAY_SEC) {
      this.activeMs.stretch = 0;
      if (idleSec >= WATER_AWAY_SEC) this.activeMs.water = 0;
      return [];
    }
    const due = [];
    const timers = [
      ['stretch', values.petBreaks, values.petBreakMinutes],
      ['water', values.petWater, values.petWaterMinutes],
    ];
    for (const [kind, on, minutes] of timers) {
      if (!on) {
        this.activeMs[kind] = 0;
        continue;
      }
      this.activeMs[kind] += dt;
      if (this.activeMs[kind] >= minutes * 60000) {
        this.activeMs[kind] = 0;
        due.push(kind);
      }
    }
    return due;
  }
}

// Whether the local hour is within the pets' night (from..to, wrapping past midnight).
function isNight(date, from, to) {
  if (from === to) return false;
  const h = date.getHours();
  return from < to ? h >= from && h < to : h >= from || h < to;
}

module.exports = { Wellbeing, isNight, AWAY_SEC, WATER_AWAY_SEC };
