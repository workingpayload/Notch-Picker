'use strict';

// Pet levels: experience per species, earned as its pets see turns finish and todo lists get
// done. Kept in pet-stats.json in the settings folder, so levels survive restarts and sessions.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SPECIES } = require('./pet-sprites');

const XP = { turn: 1, todos: 5 };
const MAX_XP = 1e7;

// Experience needed for a level: 0, 5, 15, 30, 50, … (5 × the triangle numbers).
function xpForLevel(level) {
  const n = Math.max(1, Math.floor(level)) - 1;
  return (5 * n * (n + 1)) / 2;
}

function levelFor(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

// { level, xp, from, to, fraction }: progress towards the next level.
function progress(xp) {
  const level = levelFor(xp);
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return { level, xp, from, to, fraction: (xp - from) / (to - from) };
}

// The badge a pet wears from level 2: bronze, then silver from 5 and gold from 10.
function badgeTier(level) {
  if (level >= 10) return 'gold';
  if (level >= 5) return 'silver';
  if (level >= 2) return 'bronze';
  return null;
}

class PetStats extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.xp = {};
    this.load();
  }

  load() {
    this.xp = {};
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const sp of SPECIES) {
        const v = data && data.xp && data.xp[sp];
        if (Number.isFinite(v) && v > 0) this.xp[sp] = Math.min(MAX_XP, Math.floor(v));
      }
    } catch {
      // Missing or unreadable: everyone starts at level 1.
    }
  }

  get(species) {
    return progress(this.xp[species] || 0);
  }

  all() {
    return Object.fromEntries(SPECIES.map((sp) => [sp, this.get(sp)]));
  }

  // Adds experience to a species. Returns its new level when it went up, else 0.
  add(species, amount) {
    if (!SPECIES.includes(species) || !(amount > 0)) return 0;
    const before = levelFor(this.xp[species] || 0);
    this.xp[species] = Math.min(MAX_XP, (this.xp[species] || 0) + Math.floor(amount));
    this.save();
    this.emit('change');
    const after = levelFor(this.xp[species]);
    return after > before ? after : 0;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, xp: this.xp }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // Levels are a nicety; never break the app over them.
    }
  }
}

module.exports = { PetStats, XP, xpForLevel, levelFor, progress, badgeTier };
