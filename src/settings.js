'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { isAllowedFeedUrl } = require('./updater');
const { sanitizeLabels } = require('./labels');
const { SPECIES } = require('./pet-sprites');
const { AGENT_IDS } = require('./agents');

const SCHEMA = {
  // Which coding agent's sessions the notch follows.
  agent: { type: 'enum', values: AGENT_IDS, default: 'copilot' },
  // Also follow Copilot CLI sessions running inside WSL distros (Windows).
  wslSessions: { type: 'boolean', default: true },
  size: { type: 'enum', values: ['tiny', 'small', 'normal'], default: 'small' },
  display: { type: 'enum', values: ['primary', 'cursor', 'all'], default: 'primary' },
  theme: { type: 'enum', values: ['dark', 'light', 'system'], default: 'dark' },
  opacity: { type: 'number', default: 100, min: 50, max: 100 },
  position: { type: 'enum', values: ['left', 'center', 'right'], default: 'center' },
  offsetX: { type: 'number', default: 0, min: -4000, max: 4000 },
  compactWhenIdle: { type: 'boolean', default: false },
  autoHideWhenIdle: { type: 'boolean', default: false },
  // Dynamic Island look: concave edges, split bubble, squish animations, live progress and waveform.
  islandStyle: { type: 'boolean', default: true },
  // The pill grows into a short banner for events (done, error, needs you, timer, charging).
  islandBanners: { type: 'boolean', default: true },
  // 'click': hovering only peeks; a click (or swipe down) opens the panel.
  expandOn: { type: 'enum', values: ['hover', 'click'], default: 'hover' },
  // Now playing (Windows media session) with play/pause and skip.
  mediaControls: { type: 'boolean', default: true },
  // Drop files on the notch to keep them; drag them out again later.
  shelf: { type: 'boolean', default: true },
  // Banner when charging starts and when the battery runs low.
  batteryAlerts: { type: 'boolean', default: true },
  // Timer / stopwatch from the notch.
  quickTimer: { type: 'boolean', default: true },
  hotkey: { type: 'accelerator', default: 'Control+Alt+N' },
  hideInFullscreen: { type: 'boolean', default: true },
  muteInFocusAssist: { type: 'boolean', default: true },
  hideFromScreenCapture: { type: 'boolean', default: true },
  pet: { type: 'boolean', default: false },
  // 'single': one pet follows the most urgent session; 'perSession': a pet for each session.
  petMode: { type: 'enum', values: ['single', 'perSession'], default: 'single' },
  petMax: { type: 'number', default: 5, min: 1, max: 10, integer: true },
  petSingleSpecies: { type: 'enum', values: SPECIES, default: 'cat' },
  // Per-session species chosen by the user (others are assigned automatically).
  petSpecies: { type: 'speciesMap', default: {}, max: 200 },
  petPlacement: { type: 'enum', values: ['taskbar', 'notch', 'both'], default: 'both' },
  // Roam the whole screen: climb its edges, walk on app windows. Play: pets interact.
  petRoam: { type: 'boolean', default: true },
  petPlay: { type: 'boolean', default: true },
  // 'match' follows the notch's size preset.
  petSize: { type: 'enum', values: ['match', 'tiny', 'small', 'medium', 'large', 'huge'], default: 'match' },
  petSpeed: { type: 'enum', values: ['lazy', 'normal', 'zippy'], default: 'normal' },
  petActivity: { type: 'enum', values: ['calm', 'normal', 'playful'], default: 'normal' },
  // Meows, woofs, oinks and baas when a session needs you and when petted.
  petSounds: { type: 'boolean', default: false },
  petColor: { type: 'enum', values: ['orange', 'grey', 'black', 'white'], default: 'orange' },
  petChaseCursor: { type: 'boolean', default: true },
  notifications: { type: 'boolean', default: true },
  notifyDelaySeconds: { type: 'number', default: 5, min: 0, max: 600 },
  notifyOnDone: { type: 'boolean', default: false },
  sound: { type: 'boolean', default: true },
  stuckToolMinutes: { type: 'number', default: 10, min: 1, max: 240 },
  stuckApprovalMinutes: { type: 'number', default: 3, min: 1, max: 240 },
  mutedSessions: { type: 'idList', default: [], max: 100 },
  sessionLabels: { type: 'labels', default: {} },
  approveFromNotch: { type: 'boolean', default: false },
  approvalOnlyWhenAway: { type: 'boolean', default: true },
  approvalTimeoutSec: { type: 'number', default: 30, min: 10, max: 120 },
  answerFromNotch: { type: 'boolean', default: false },
  questionTimeoutSec: { type: 'number', default: 60, min: 15, max: 120 },
  webhookUrl: { type: 'httpsUrl', default: '' },
  webhookOnAttention: { type: 'boolean', default: true },
  webhookOnStuck: { type: 'boolean', default: true },
  webhookOnDone: { type: 'boolean', default: false },
  webhookOnError: { type: 'boolean', default: true },
  webhookIncludeDetails: { type: 'boolean', default: false },
  updateFeedUrl: { type: 'feedUrl', default: '' },
  autoUpdate: { type: 'boolean', default: true },
  // Off saves the GPU process's memory; the notch is small enough to draw in software.
  hardwareAcceleration: { type: 'boolean', default: false },
};

const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.default]));

// The notch is designed at "small"; other presets scale the whole UI.
const SIZE_ZOOM = { tiny: 0.85, small: 1, normal: 1.2 };

// Drops unknown keys and coerces/clamps values so a hand-edited or stale file can never break the app.
function sanitize(input, base = DEFAULTS) {
  const out = { ...base, mutedSessions: [...(base.mutedSessions || [])] };
  if (!input || typeof input !== 'object') return out;
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (!(key in input)) continue;
    const v = input[key];
    if (spec.type === 'boolean' && typeof v === 'boolean') out[key] = v;
    if (spec.type === 'enum' && spec.values.includes(v)) out[key] = v;
    // Webhook targets must be https (they may receive session names); empty disables.
    if (spec.type === 'httpsUrl' && typeof v === 'string') {
      const s = v.trim();
      if (s === '') out[key] = '';
      else if (s.length <= 1000) {
        try {
          const u = new URL(s);
          if (u.protocol === 'https:' && u.hostname) out[key] = u.toString();
        } catch {
          // invalid: keep the previous value
        }
      }
    }
    // Update feed: https, or http on this machine only. Stored as a folder URL (trailing slash).
    if (spec.type === 'feedUrl' && typeof v === 'string') {
      const s = v.trim();
      if (s === '') out[key] = '';
      else if (s.length <= 1000 && isAllowedFeedUrl(s)) {
        const u = new URL(s);
        if (!u.pathname.endsWith('/')) u.pathname += '/';
        out[key] = u.toString();
      }
    }
    // Electron accelerator such as "Control+Alt+N"; empty disables the shortcut.
    if (spec.type === 'accelerator' && typeof v === 'string') {
      const a = v.replace(/\s+/g, '');
      if (a === '' || /^([A-Za-z0-9]+\+)*[A-Za-z0-9]+$/.test(a)) out[key] = a.slice(0, 50);
    }
    if (spec.type === 'idList' && Array.isArray(v)) {
      const ids = [...new Set(v.filter((x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)))];
      out[key] = ids.slice(-spec.max);
    }
    if (spec.type === 'labels') out[key] = sanitizeLabels(v);
    if (spec.type === 'speciesMap' && v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v).filter(([id, sp]) => /^[\w-]{1,64}$/.test(id) && SPECIES.includes(sp));
      out[key] = Object.fromEntries(entries.slice(-spec.max));
    }
    if (spec.type === 'number') {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n === 'number' && Number.isFinite(n)) {
        const clamped = Math.min(spec.max, Math.max(spec.min, n));
        out[key] = spec.integer ? Math.round(clamped) : clamped;
      }
    }
  }
  return out;
}

class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      this.values = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.values = { ...DEFAULTS };
    }
    return this.values;
  }

  get() {
    return {
      ...this.values,
      mutedSessions: [...this.values.mutedSessions],
      sessionLabels: { ...this.values.sessionLabels },
      petSpecies: { ...this.values.petSpecies },
    };
  }

  set(patch) {
    const next = sanitize(patch, this.values);
    if (JSON.stringify(next) === JSON.stringify(this.values)) return this.get();
    this.values = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change', this.get());
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS, SCHEMA, sanitize, SIZE_ZOOM };
