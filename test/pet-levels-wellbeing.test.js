'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PetStats, xpForLevel, levelFor, progress, badgeTier } = require('../src/pet-stats');
const { Wellbeing, isNight } = require('../src/wellbeing');
const { sanitize } = require('../src/settings');

test('levels need more experience each time, and badges go bronze, silver, gold', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(xpForLevel), [0, 5, 15, 30, 50]);
  assert.deepEqual([0, 4, 5, 14, 15, 49, 50].map(levelFor), [1, 1, 2, 2, 3, 4, 5]);
  assert.deepEqual(progress(10), { level: 2, xp: 10, from: 5, to: 15, fraction: 0.5 });
  assert.deepEqual([1, 2, 4, 5, 9, 10].map(badgeTier), [null, 'bronze', 'bronze', 'silver', 'silver', 'gold']);
});

test('pet experience is kept per species across restarts, and a level-up is reported once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-pet-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pet-stats.json');
  const stats = new PetStats(file);
  assert.equal(stats.get('fox').level, 1);
  assert.equal(stats.add('fox', 4), 0);
  assert.equal(stats.add('fox', 1), 2, 'reached level 2');
  assert.equal(stats.add('fox', 1), 0);
  assert.equal(stats.add('dragon', 50), 0, 'unknown species');
  assert.equal(new PetStats(file).get('fox').xp, 6);

  fs.writeFileSync(file, '{"xp":{"fox":-3,"cat":"lots","dog":12.7}}');
  const repaired = new PetStats(file);
  assert.deepEqual([repaired.get('fox').xp, repaired.get('cat').xp, repaired.get('dog').xp], [0, 0, 12]);
});

const MIN = 60000;
const on = { petBreaks: true, petBreakMinutes: 50, petWater: true, petWaterMinutes: 60 };

// Ticks every 30 s for `minutes`, with the given idle time; returns the reminders that came due.
function run(w, from, minutes, idleSec, values = on) {
  const due = [];
  for (let t = from; t <= from + minutes * MIN; t += 30000) due.push(...w.tick(t, idleSec, values).map((kind) => [kind, (t - from) / MIN]));
  return due;
}

test('stretch and water reminders come after time at the computer; time away is a break', () => {
  const w = new Wellbeing();
  assert.deepEqual(run(w, 0, 61, 10), [
    ['stretch', 50],
    ['water', 60],
  ]);

  // 40 minutes, a 6-minute break, 40 more: no stretch reminder (the break reset it), but water
  // keeps counting through a short break.
  const w2 = new Wellbeing();
  const due = [...run(w2, 0, 40, 10), ...run(w2, 40.5 * MIN, 6, 6 * 60), ...run(w2, 47 * MIN, 40, 10)];
  assert.deepEqual(due.map(([kind]) => kind), ['water']);

  // Turned off: nothing.
  assert.deepEqual(run(new Wellbeing(), 0, 120, 10, { ...on, petBreaks: false, petWater: false }), []);
  // A long gap between ticks (the PC slept) doesn't count as time at the desk.
  const w3 = new Wellbeing();
  w3.tick(0, 10, on);
  assert.deepEqual(w3.tick(3 * 60 * MIN, 10, on), []);
});

test('pet night hours wrap past midnight', () => {
  const at = (h) => new Date(2026, 0, 1, h, 30);
  assert.deepEqual([22, 23, 0, 6, 7, 12].map((h) => isNight(at(h), 23, 7)), [false, true, true, true, false, false]);
  assert.deepEqual([12, 13, 14].map((h) => isNight(at(h), 13, 14)), [false, true, false]);
  assert.equal(isNight(at(3), 5, 5), false);
});

test('new pet settings are sanitised', () => {
  const v = sanitize({ petBreakMinutes: 2, petWaterMinutes: 999, petNightFrom: 25, petNightTo: -1, petSingleSpecies: 'robot', petSpecies: { a: 'fox' } });
  assert.deepEqual([v.petBreakMinutes, v.petWaterMinutes, v.petNightFrom, v.petNightTo], [15, 240, 23, 0]);
  assert.equal(v.petSingleSpecies, 'robot');
  assert.deepEqual(v.petSpecies, { a: 'fox' });
  assert.deepEqual([v.petSigns, v.petLevels, v.petBreaks, v.petWater, v.petNightSleep], [true, true, true, true, true]);
});
