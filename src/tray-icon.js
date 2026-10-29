'use strict';

// Renders the tray icon (a small "notch" pill with a status dot and an optional alert badge)
// as a BGRA bitmap, without any image assets. Pure so it can be unit tested.

const STATUS_COLORS = {
  approval: [255, 159, 10],
  input: [255, 214, 10],
  stuck: [255, 107, 53],
  error: [255, 69, 58],
  tool: [10, 132, 255],
  thinking: [191, 90, 242],
  agents: [100, 210, 255],
  done: [48, 209, 88],
  idle: [142, 142, 147],
};

const PILL = { dark: [245, 245, 247], light: [28, 28, 30] };
const BADGE = [255, 59, 48];
const SAMPLES = 4; // 4x4 supersampling for smooth edges

function inRoundedRect(x, y, l, t, r, b, radius) {
  if (x < l || x > r || y < t || y > b) return false;
  const cx = Math.min(Math.max(x, l + radius), r - radius);
  const cy = Math.min(Math.max(y, t + radius), b - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function inCircle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

// Returns { buffer, width, height } in BGRA order (what nativeImage.createFromBitmap expects).
// `taskbar` is the taskbar theme: a light pill on dark taskbars, a dark pill on light ones.
function renderTrayIcon({ status = null, badge = false, size = 32, taskbar = 'dark' } = {}) {
  const s = size / 32;
  const dot = status ? STATUS_COLORS[status] || STATUS_COLORS.idle : null;
  const buf = Buffer.alloc(size * size * 4);
  const layers = [
    { color: PILL[taskbar] || PILL.dark, hit: (x, y) => inRoundedRect(x, y, 1.5 * s, 9 * s, 30.5 * s, 23 * s, 7 * s) },
    // With no sessions the dot is punched out of the pill (transparent ring look).
    dot
      ? { color: dot, hit: (x, y) => inCircle(x, y, 9 * s, 16 * s, 4.5 * s) }
      : { color: null, hit: (x, y) => inCircle(x, y, 9 * s, 16 * s, 4 * s) },
  ];
  if (badge) {
    layers.push({ color: null, hit: (x, y) => inCircle(x, y, 25.5 * s, 7.5 * s, 7 * s) }); // gap around badge
    layers.push({ color: BADGE, hit: (x, y) => inCircle(x, y, 25.5 * s, 7.5 * s, 5.5 * s) });
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          let color = null;
          for (const layer of layers) if (layer.hit(x, y)) color = layer.color;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a++;
          }
        }
      }
      if (!a) continue;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(b / a);
      buf[i + 1] = Math.round(g / a);
      buf[i + 2] = Math.round(r / a);
      buf[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return { buffer: buf, width: size, height: size };
}

module.exports = { renderTrayIcon, STATUS_COLORS };
