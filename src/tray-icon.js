'use strict';

// Renders the tray icon as a bitmap: the app icon with a status dot (bottom right) and an optional
// alert badge (top right). Without the app icon it falls back to a small "notch" pill drawn here.
// Pure so it can be unit tested.

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

// Returns { buffer, width, height } in premultiplied BGRA order (what nativeImage.createFromBitmap
// expects and toBitmap returns). `base` is the app icon at `size` in that format.
// `taskbar` is the taskbar theme for the fallback pill: light on dark taskbars, dark on light ones.
function renderTrayIcon({ status = null, badge = false, size = 32, taskbar = 'dark', base = null } = {}) {
  const s = size / 32;
  const dot = status ? STATUS_COLORS[status] || STATUS_COLORS.idle : null;
  const icon = base && base.buffer && base.buffer.length === size * size * 4 ? base.buffer : null;
  const buf = Buffer.alloc(size * size * 4);
  const layers = [];
  if (icon) {
    // The dot sits in the icon's corner, cut out of it with a small gap.
    if (dot) {
      layers.push({ color: null, hit: (x, y) => inCircle(x, y, 24.5 * s, 24.5 * s, 7.5 * s) });
      layers.push({ color: dot, hit: (x, y) => inCircle(x, y, 24.5 * s, 24.5 * s, 6 * s) });
    }
  } else {
    layers.push({ color: PILL[taskbar] || PILL.dark, hit: (x, y) => inRoundedRect(x, y, 1.5 * s, 9 * s, 30.5 * s, 23 * s, 7 * s) });
    // With no sessions the dot is punched out of the pill (transparent ring look).
    layers.push(
      dot
        ? { color: dot, hit: (x, y) => inCircle(x, y, 9 * s, 16 * s, 4.5 * s) }
        : { color: null, hit: (x, y) => inCircle(x, y, 9 * s, 16 * s, 4 * s) },
    );
  }
  if (badge) {
    layers.push({ color: null, hit: (x, y) => inCircle(x, y, 25.5 * s, 7.5 * s, 7 * s) }); // gap around badge
    layers.push({ color: BADGE, hit: (x, y) => inCircle(x, y, 25.5 * s, 7.5 * s, 5.5 * s) });
  }

  const n = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      // Premultiplied sums over the samples.
      let b = 0;
      let g = 0;
      let r = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          let layer = null;
          for (const l of layers) if (l.hit(x, y)) layer = l;
          if (layer) {
            if (!layer.color) continue;
            b += layer.color[2];
            g += layer.color[1];
            r += layer.color[0];
            a += 255;
          } else if (icon) {
            b += icon[i];
            g += icon[i + 1];
            r += icon[i + 2];
            a += icon[i + 3];
          }
        }
      }
      if (!a) continue;
      buf[i] = Math.round(b / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(r / n);
      buf[i + 3] = Math.round(a / n);
    }
  }
  return { buffer: buf, width: size, height: size };
}

module.exports = { renderTrayIcon, STATUS_COLORS };
