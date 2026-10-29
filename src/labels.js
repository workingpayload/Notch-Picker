'use strict';

// Your own name and colour tag for a session, to tell sessions apart. Stored in the notch's
// settings by session id (Copilot's own session files are not changed), so a resumed
// session keeps its label.

// Colours are drawn by styles.css (.tag-<name>).
const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
const MAX_NAME = 60;
const MAX_LABELS = 200;
const ID_RE = /^[\w-]{1,64}$/;

function cleanName(value) {
  if (typeof value !== 'string') return '';
  // Single line, no control characters.
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// { [sessionId]: { name?, color? } } with junk dropped; entries with neither are removed.
function sanitizeLabels(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const entries = Object.entries(input).filter(([id]) => ID_RE.test(id));
  for (const [id, v] of entries.slice(-MAX_LABELS)) {
    if (!v || typeof v !== 'object') continue;
    const label = {};
    const name = cleanName(v.name);
    if (name) label.name = name;
    if (LABEL_COLORS.includes(v.color)) label.color = v.color;
    if (label.name || label.color) out[id] = label;
  }
  return out;
}

// New labels map with one session's label changed. `patch.name === ''` resets the name,
// `patch.color === null` removes the colour.
function updateLabel(labels, id, patch) {
  const next = { ...labels };
  const current = { ...(next[id] || {}) };
  delete next[id];
  if ('name' in patch) current.name = patch.name;
  if ('color' in patch) current.color = patch.color;
  next[id] = current; // re-inserted last, so the newest labels survive the cap
  return sanitizeLabels(next);
}

// Shows the custom name (keeping Copilot's as `originalName`) and the colour tag.
function applyLabel(session, labels) {
  const label = session && labels[session.id];
  if (!label) return session;
  return {
    ...session,
    name: label.name || session.name,
    originalName: label.name ? session.name : undefined,
    tag: label.color || undefined,
  };
}

module.exports = { LABEL_COLORS, MAX_NAME, sanitizeLabels, updateLabel, applyLabel, cleanName };
