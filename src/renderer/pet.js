'use strict';

// Draws a desktop pet. The main process decides what the pet does (src/pet.js) and moves the
// window; this page only animates the sprite and its speech bubble and forwards pointer input.

const {
  WIN_COLS: COLS,
  WIN_ROWS: ROWS,
  SPRITE_W,
  SPRITE_Y,
  SPRITES,
  BUBBLES,
  BALL,
  BALL_COLORS,
  BADGE,
  BADGE_COLORS,
  BADGE_OUTLINE,
  SWEAT,
  SWEAT_COLOR,
  outline,
  flip,
  shadow,
  bubbleOrigin,
  animFor,
  anchorFor,
  paletteFor,
} = window.PetSprites;

const SHADOW = 'rgba(0, 0, 0, 0.45)';
const CONFETTI = ['#ff453a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ff9f0a'];
const SIGN_COLORS = { board: '#f4e6c8', edge: '#7a5230', stick: '#8a5a32', text: '#3a2a1a', approval: '#b35c00', question: '#8a6400' };

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
const ballGrid = outline(BALL);
const badgeGrid = outline(BADGE);

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
  // The fetch ball's own window: just the ball, at its bottom-centre.
  if (view.ball) {
    const ballKey = `ball|${width}x${height}|${view.cell}`;
    if (ballKey === lastKey) return;
    lastKey = ballKey;
    ctx.clearRect(0, 0, width, height);
    const px = view.cell * dpr;
    const size = ballGrid.length;
    paint(ballGrid, 0, 0, (c) => BALL_COLORS[c], { x: px, y: px, x0: (width - size * px) / 2, y0: height - size * px });
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
  // Extras that animate on their own clocks.
  const anchor = anchorFor(view.anim);
  const confettiFrame = view.effect === 'confetti' && !still ? Math.floor(Date.now() / 60) : 0;
  const sweatFrame = view.sweat && anchor && !still ? Math.floor(Date.now() / 250) % 3 : 0;
  const sign = view.sign && !view.origin ? view.sign : null;

  const origin = view.origin;
  const key = [
    name,
    still ? 0 : dy,
    view.facing,
    view.palette,
    view.collar,
    view.bubble,
    bubbleIndex,
    `${width}x${height}`,
    origin ? `${origin.x},${origin.y}` : '',
    view.effect,
    confettiFrame,
    view.sweat,
    sweatFrame,
    view.carry,
    view.badge,
    sign ? JSON.stringify(sign) : '',
  ].join('|');
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

  // Anchors are for a pet facing right in its 20-wide sprite; mirror them for one facing left.
  const at = (p, w = 1) => ({ x: ox + (view.facing < 0 ? SPRITE_W - w - p[0] : p[0]), y: oy + p[1] });
  if (sign) drawSign(sign, dpr, k);
  if (view.badge && anchor && anchor.badge) {
    const spot = at(anchor.badge, BADGE[0].length);
    const color = BADGE_COLORS[view.badge];
    paint(badgeGrid, spot.x, spot.y, (c) => (c === 'k' ? BADGE_OUTLINE : color), k);
  }
  // Collar pixels take the session's colour tag, or the neck's colour when there is none.
  paint(grid, ox, oy, (c) => (c === 'c' && view.collar) || palette[c] || palette.o, k);

  if (view.sweat && anchor) {
    const head = at(anchor.head);
    const drop = view.facing < 0 ? flip(SWEAT) : SWEAT;
    paint(drop, head.x - (view.facing < 0 ? -1 : 2), head.y + sweatFrame, () => SWEAT_COLOR, k);
  }
  if (view.carry === 'ball' && anchor) {
    const mouth = at(anchor.mouth);
    paint(ballGrid, mouth.x - 3, mouth.y - 3, (c) => BALL_COLORS[c], k);
  }
  if (view.effect === 'confetti') drawConfetti(confettiFrame, k);

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

// Confetti falling through the pet's box (sprite pixels), for a finished todo list.
function drawConfetti(frame, k) {
  for (let i = 0; i < 22; i++) {
    const x = (i * 7 + 3 + Math.floor(i / 3)) % COLS;
    const y = Math.floor(frame * (0.6 + (i % 4) * 0.15) + i * 5) % ROWS;
    ctx.fillStyle = CONFETTI[i % CONFETTI.length];
    const x0 = Math.round(k.x0 + x * k.x);
    const y0 = Math.round(k.y0 + y * k.y);
    ctx.fillRect(x0, y0, Math.max(1, Math.round(k.x)), Math.max(1, Math.round(k.y * (i % 2 ? 1 : 2))));
  }
}

// The sign a pet holds up while its session needs you: a board above its head (window DIPs) on a
// stick down to the pet, with the request's title and detail.
function drawSign(sign, dpr, k) {
  const x = sign.x * dpr;
  const y = sign.y * dpr;
  const w = sign.width * dpr;
  const h = sign.height * dpr;
  const stickW = Math.max(2, Math.round(k.x * 0.8));
  ctx.fillStyle = SIGN_COLORS.stick;
  ctx.fillRect(Math.round(x + w / 2 - stickW / 2), Math.round(y + h), stickW, Math.round(k.y0 + (SPRITE_Y + 2) * k.y - (y + h)));
  ctx.fillStyle = SIGN_COLORS.edge;
  roundRect(x, y, w, h, 4 * dpr);
  ctx.fill();
  ctx.fillStyle = SIGN_COLORS.board;
  roundRect(x + dpr, y + dpr, w - 2 * dpr, h - 2 * dpr, 3 * dpr);
  ctx.fill();
  const pad = 6 * dpr;
  const size = sign.font * dpr;
  ctx.textBaseline = 'top';
  ctx.font = `600 ${size}px 'Segoe UI', system-ui, sans-serif`;
  ctx.fillStyle = SIGN_COLORS[sign.kind] || SIGN_COLORS.text;
  ctx.fillText(fit(sign.title, w - 2 * pad), x + pad, y + pad * 0.6);
  if (sign.text) {
    ctx.font = `${size}px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillStyle = SIGN_COLORS.text;
    ctx.fillText(fit(sign.text, w - 2 * pad), x + pad, y + pad * 0.6 + size + 3 * dpr);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Shortens text with an ellipsis to fit the width (canvas pixels) in the current font.
function fit(text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > width) s = s.slice(0, -1);
  return s + '…';
}

// Whether a point (window DIPs) is on the sign.
function onSign(x, y) {
  const s = view.sign;
  return !!s && !view.origin && x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height;
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
  // Hovering a pet shows its session's name and level, or what its sign asks.
  const title = next.sign
    ? `${next.sign.title}${next.sign.text ? ` — ${next.sign.text}` : ''}\nClick the sign to answer`
    : [next.title, next.level > 1 ? `Level ${next.level}` : ''].filter(Boolean).join(' · ');
  if (canvas.title !== title) canvas.title = title;
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
  // The sign answers the session's request instead of picking the pet up.
  if (onSign(e.clientX, e.clientY)) {
    window.petApi.sign();
    return;
  }
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
