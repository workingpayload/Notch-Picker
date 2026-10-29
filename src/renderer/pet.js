'use strict';

// Draws a desktop pet. The main process decides what the pet does (src/pet.js) and moves the
// window; this page only animates the sprite and its speech bubble and forwards pointer input.

const { WIN_COLS: COLS, WIN_ROWS: ROWS, SPRITES, BUBBLES, outline, flip, shadow, bubbleOrigin, animFor, paletteFor } =
  window.PetSprites;

const SHADOW = 'rgba(0, 0, 0, 0.45)';

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const facingRight = {};
const facingLeft = {};
for (const [name, rows] of Object.entries(SPRITES)) {
  facingRight[name] = outline(rows);
  facingLeft[name] = flip(facingRight[name]);
}
const bubbles = Object.fromEntries(Object.entries(BUBBLES).map(([name, b]) => [name, { color: b.color, frames: b.frames.map(shadow) }]));

let view = { hidden: true };
let lastKey = '';
let blank = true;

// Tells the main process the pet is on screen after being blank, once the frame has been
// presented (two animation frames later), so it can retire the other window's copy.
function confirmPainted() {
  requestAnimationFrame(() => requestAnimationFrame(() => window.petApi.painted()));
}

function paint(grid, ox, oy, colorOf, k) {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '.') continue;
      ctx.fillStyle = colorOf(c);
      // Integer device-pixel edges keep the pixel art crisp at any display scaling.
      const x0 = Math.round(k.x0 + (ox + x) * k.x);
      const y0 = Math.round(k.y0 + (oy + y) * k.y);
      ctx.fillRect(x0, y0, Math.round(k.x0 + (ox + x + 1) * k.x) - x0, Math.round(k.y0 + (oy + y + 1) * k.y) - y0);
    }
  }
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(window.innerWidth * dpr);
  const height = Math.round(window.innerHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    lastKey = '';
  }
  if (view.hidden) {
    if (lastKey !== 'hidden') ctx.clearRect(0, 0, width, height);
    lastKey = 'hidden';
    blank = true;
    return;
  }
  const still = reduceMotion.matches;
  const anim = animFor(view.species, view.anim);
  // Frames follow the wall clock (not when this window got the anim) so the pet's window and the
  // carry overlay always draw the same frame while handing the pet over.
  const frameIndex = still || !anim.fps ? 0 : Math.floor((Date.now() * anim.fps) / 1000) % anim.frames.length;
  const [name, dy] = anim.frames[frameIndex];
  const bubble = view.bubble && bubbles[view.bubble];
  const bubbleIndex = bubble && !still ? Math.floor(Date.now() / 500) % bubble.frames.length : 0;

  const origin = view.origin;
  const key = `${name}|${still ? 0 : dy}|${view.facing}|${view.palette}|${view.collar}|${view.bubble}|${bubbleIndex}|${width}x${height}|${origin ? `${origin.x},${origin.y}` : ''}`;
  if (key === lastKey) return;
  lastKey = key;
  ctx.clearRect(0, 0, width, height);
  // The pet's box is drawn at a fixed scale: at the window's bottom-centre (the window may be
  // larger than the box), or at `origin` (DIPs) on the display-sized carry overlay.
  const cellPx = view.cell * dpr;
  const k = origin
    ? { x: cellPx, y: cellPx, x0: origin.x * dpr, y0: origin.y * dpr }
    : { x: cellPx, y: cellPx, x0: (width - COLS * cellPx) / 2, y0: height - ROWS * cellPx };
  const palette = paletteFor(view.species, view.palette);
  const grid = (view.facing < 0 ? facingLeft : facingRight)[name];
  // Sprites stand at the bottom-centre of the box (climbing frames are taller than wide).
  const ox = (COLS - grid[0].length) / 2;
  const oy = ROWS - grid.length + (still ? 0 : dy);
  // Collar pixels take the session's colour tag, or the neck's colour when there is none.
  paint(grid, ox, oy, (c) => (c === 'c' && view.collar) || palette[c] || palette.o, k);

  if (bubble) {
    const g = bubble.frames[bubbleIndex];
    const at = bubbleOrigin(view.anim, view.facing, oy, g[0].length, g.length);
    paint(g, at.x, at.y, (c) => (c === 's' ? SHADOW : bubble.color), k);
  }
  if (blank && fits()) {
    blank = false;
    confirmPainted();
  }
}

// Whether the window has the size this drawing is for (the carry overlay is resized right before
// it is asked to draw, and the resize can arrive after the drawing request).
function fits() {
  const f = view.fit;
  return !f || (Math.abs(window.innerWidth - f.width) <= 2 && Math.abs(window.innerHeight - f.height) <= 2);
}

setInterval(draw, 40);
window.addEventListener('resize', draw);

window.petApi.onView((next) => {
  view = next;
  document.body.classList.toggle('held', !!next.held);
  // Hovering a session's pet shows the session's name.
  if (canvas.title !== (next.title || '')) canvas.title = next.title || '';
  draw();
});

window.petApi.onSound(({ species, kind }) => window.PetSounds.play(species, kind));

// Mouse, touch and pen all arrive as pointer events. Capture keeps the release coming here even
// if a fast drag outruns the window. A touch long-press opens the menu (contextmenu) instead of
// counting as a tap. Windows doesn't move the cursor along with a finger or pen, so for those the
// position is sent along, relative to this window (Chromium's screenX/Y aren't reliable for touch).
let pressed = false;
const at = (e) => (e.pointerType === 'mouse' ? undefined : { x: e.clientX, y: e.clientY });
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pressed = true;
  canvas.setPointerCapture(e.pointerId);
  window.petApi.pointer('down', e.pointerType, at(e));
});
canvas.addEventListener('pointermove', (e) => {
  if (pressed && e.pointerType !== 'mouse') window.petApi.pointer('move', e.pointerType, at(e));
});
canvas.addEventListener('pointerup', (e) => {
  if (!pressed || e.button !== 0) return;
  pressed = false;
  window.petApi.pointer('up', e.pointerType, at(e));
});
canvas.addEventListener('lostpointercapture', (e) => {
  if (!pressed) return;
  pressed = false;
  window.petApi.pointer('cancel', e.pointerType);
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (pressed) {
    pressed = false;
    window.petApi.pointer('cancel', 'touch');
  }
  window.petApi.menu();
});

const reportMotion = () => window.petApi.ready({ reducedMotion: reduceMotion.matches });
reduceMotion.addEventListener('change', () => {
  lastKey = '';
  reportMotion();
});
reportMotion();
