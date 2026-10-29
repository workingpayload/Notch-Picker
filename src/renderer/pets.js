'use strict';

// Pet settings window: the pet options, a live preview of the five species at the chosen size and
// cat colour, sample sounds, and each live session's pet with a species picker.

const { SPECIES, SPRITES, COLLAR_COLORS, outline, flip, animFor, paletteFor, petCell } = window.PetSprites;
const NAMES = { cat: 'Cat', dog: 'Dog', pig: 'Pig', sheep: 'Sheep', goat: 'Goat' };

const form = document.getElementById('form');
const statusEl = document.getElementById('status');
let values = null;
let statusTimer = null;

function flashStatus(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ''), 1500);
}

function fill(next) {
  values = next;
  for (const input of form.querySelectorAll('input[name], select[name]')) {
    if (!(input.name in next)) continue;
    if (input === document.activeElement && input.type === 'number') continue;
    if (input.type === 'checkbox') input.checked = !!next[input.name];
    else input.value = next[input.name];
  }
  drawPreview(true);
  renderSessions(lastSessions, true);
}

form.addEventListener('change', async (e) => {
  const input = e.target;
  if (!input.name) return;
  const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  const saved = await window.notchApi.setSettings({ [input.name]: value });
  if (input.type === 'number') input.value = saved[input.name];
  fill(saved);
  flashStatus('Saved');
});
form.addEventListener('submit', (e) => e.preventDefault());

for (const button of document.querySelectorAll('.sound-tests button')) {
  button.addEventListener('click', () => window.PetSounds.play(button.dataset.species, 'pet'));
}

// ---- Preview: the five species walking on the spot at the chosen size ----

const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const note = document.getElementById('preview-note');
const right = {};
const left = {};
for (const [name, rows] of Object.entries(SPRITES)) {
  right[name] = outline(rows);
  left[name] = flip(right[name]);
}
const SLOT = 24; // sprite pixels per pet in the row
const MAX_WIDTH = 400; // CSS px available in the window
let lastPreview = '';

function drawPreview(force = false) {
  if (!values) return;
  const cell = petCell(values.petSize, values.size);
  const scale = Math.min(1, MAX_WIDTH / (SLOT * SPECIES.length * cell));
  const px = cell * scale; // CSS px per sprite pixel
  const dpr = window.devicePixelRatio || 1;
  const t = Date.now();
  const facing = Math.floor(t / 4000) % 2 ? -1 : 1;
  const anims = SPECIES.map((sp) => animFor(sp, 'walk'));
  const frames = anims.map((a) => a.frames[Math.floor((t * a.fps) / 1000) % a.frames.length]);
  const key = `${cell}|${scale}|${values.petColor}|${values.petSingleSpecies}|${values.petMode}|${facing}|${frames.map((f) => f.join()).join()}`;
  if (!force && key === lastPreview) return;
  lastPreview = key;
  const width = Math.round(SLOT * SPECIES.length * px);
  const height = Math.round(18 * px);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const k = px * dpr;
  SPECIES.forEach((sp, i) => {
    const [name, dy] = frames[i];
    const grid = (facing < 0 ? left : right)[name];
    const palette = paletteFor(sp, values.petColor);
    const ox = i * SLOT + (SLOT - grid[0].length) / 2;
    const oy = 18 - grid.length + dy;
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        const c = grid[y][x];
        if (c === '.') continue;
        ctx.fillStyle = palette[c] || palette.o;
        const x0 = Math.round((ox + x) * k);
        const y0 = Math.round((oy + y) * k);
        ctx.fillRect(x0, y0, Math.round((ox + x + 1) * k) - x0, Math.round((oy + y + 1) * k) - y0);
      }
    }
    // Underline the pet used in "one pet for everything".
    if (values.petMode === 'single' && sp === values.petSingleSpecies) {
      ctx.fillStyle = '#0a84ff';
      ctx.fillRect(Math.round((i * SLOT + 4) * k), Math.round(17 * k), Math.round((SLOT - 8) * k), Math.max(2, Math.round(0.5 * k)));
    }
  });
  note.textContent =
    (scale < 1 ? `Shown at ${Math.round(scale * 100)}% — ` : 'Actual size — ') + SPECIES.map((sp) => NAMES[sp]).join(' · ');
}
setInterval(() => drawPreview(), 80);

// ---- Each live session's pet ----

const sessionsEl = document.getElementById('sessions');
const sessionsNote = document.getElementById('sessions-note');
let lastSessions = [];
let lastSessionsKey = '';

function renderSessions(list, force = false) {
  lastSessions = list;
  if (!values) return;
  const key = JSON.stringify([list, values.petMode, values.pet]);
  if (!force && key === lastSessionsKey) return;
  // Don't rebuild under an open picker.
  if (sessionsEl.contains(document.activeElement)) return;
  lastSessionsKey = key;
  sessionsEl.textContent = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.setAttribute('role', 'listitem');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    if (s.tag && COLLAR_COLORS[s.tag]) swatch.style.background = COLLAR_COLORS[s.tag];
    swatch.title = s.tag ? `Colour tag (collar): ${s.tag}` : 'No colour tag';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    name.title = s.name;
    const state = document.createElement('small');
    state.textContent = s.muted ? 'muted, asleep' : s.hasPet ? '' : 'no pet (limit reached)';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Pet for ${s.name}`);
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = s.auto ? `Automatic (${NAMES[s.auto]})` : 'Automatic';
    select.append(auto);
    for (const sp of SPECIES) {
      const o = document.createElement('option');
      o.value = sp;
      o.textContent = NAMES[sp];
      select.append(o);
    }
    select.value = s.chosen || '';
    select.addEventListener('change', () => {
      window.notchApi.setPetSpecies(s.id, select.value || null);
      flashStatus('Saved');
    });
    row.append(swatch, name, state, select);
    sessionsEl.append(row);
  }
  sessionsNote.textContent = !list.length
    ? 'No live Copilot sessions.'
    : values.petMode !== 'perSession'
      ? 'These apply with “One pet per session” (Pets, above).'
      : 'New sessions take the next species in turn; pick one to keep it for that session.';
}

window.notchApi.onPetSessions((list) => renderSessions(list));
window.notchApi.onSettings(fill);
window.notchApi.getSettings().then(fill);
window.notchApi.getPetSessions().then((list) => renderSessions(list, true));
