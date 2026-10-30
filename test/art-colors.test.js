'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickArtColors, forBackground, artPalette, contrast, rgbToHsl } = require('../src/art-colors');
const { sanitize } = require('../src/settings');

// RGBA pixels: [[r, g, b, count, alpha?], ...].
function pixels(spec) {
  const out = [];
  for (const [r, g, b, n, a = 255] of spec) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return Uint8ClampedArray.from(out);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hue = (rgb) => rgbToHsl(rgb)[0];
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test("the cover's dominant colour leads, not a small vivid accent", () => {
  // A dark navy cover with a small red title and some grey.
  const navy = pickArtColors(
    pixels([
      [15, 18, 40, 300],
      [220, 30, 40, 60],
      [128, 128, 128, 50],
    ])
  );
  assert.ok(hueGap(hue(navy.primary), 232) < 10, `navy leads: ${navy.primary}`);
  assert.ok(hueGap(hue(navy.secondary), 357) < 10, `red second: ${navy.secondary}`);

  // A muted teal cover with a magenta sticker: teal leads.
  const teal = pickArtColors(pixels([[80, 140, 135, 700], [230, 40, 200, 100]]));
  assert.ok(hueGap(hue(teal.primary), 175) < 10, String(teal.primary));

  // On a black-and-white cover, the only colour leads even if it's small.
  const accent = pickArtColors(pixels([[5, 5, 5, 500], [245, 245, 245, 300], [200, 30, 30, 90]]));
  assert.ok(hueGap(hue(accent.primary), 0) < 10, String(accent.primary));
});

test('grey covers give greys and a monochrome look; a one-hue cover gives a shade of that hue', () => {
  const grey = pickArtColors(pixels([[30, 30, 30, 200], [200, 200, 200, 200]]));
  assert.equal(grey.neutral, true);
  assert.equal(rgbToHsl(grey.primary)[1], 0);
  // A white-on-black cover: white-ish on the dark notch, near-black on the light one.
  const mono = artPalette(pixels([[0, 0, 0, 900], [255, 255, 255, 100]]));
  for (const v of Object.values(mono)) assert.ok(rgbToHsl(hex(v))[1] < 0.1, `colourless: ${v}`);
  assert.ok(rgbToHsl(hex(mono.dark))[2] > 0.85 && rgbToHsl(hex(mono.light))[2] < 0.15, JSON.stringify(mono));
  assert.equal(pickArtColors(pixels([[255, 0, 0, 100, 0]])), null, 'transparent pixels are ignored');
  const { primary, secondary } = pickArtColors(pixels([[40, 120, 220, 400]]));
  assert.ok(hueGap(hue(secondary), hue(primary)) < 3);
  assert.ok(Math.abs(rgbToHsl(secondary)[2] - rgbToHsl(primary)[2]) > 0.15);
});

test("colours keep the cover's hue and saturation, made just readable on the dark and light notch", () => {
  const black = [0, 0, 0];
  const light = [250, 250, 252];
  for (const rgb of [[10, 20, 90], [240, 220, 30], [200, 30, 40], [30, 160, 60], [196, 170, 150], [235, 180, 190]]) {
    const [h, s] = rgbToHsl(rgb);
    for (const [dark, bg, min] of [[true, black, 4.5], [false, light, 3.6]]) {
      const out = hex(forBackground(rgb, dark));
      assert.ok(contrast(out, bg) >= min, `${rgb} → ${out}`);
      assert.ok(hueGap(hue(out), h) < 4, `hue kept: ${rgb} → ${out}`);
      assert.ok(Math.abs(rgbToHsl(out)[1] - s) < 0.08, `saturation kept: ${rgb} → ${out}`);
    }
  }
  // Already readable: unchanged.
  assert.equal(forBackground([255, 214, 10], true), '#ffd60a');
  const palette = artPalette(pixels([[220, 30, 40, 100], [30, 90, 220, 60]]));
  assert.deepEqual(Object.keys(palette), ['dark', 'dark2', 'light', 'light2']);
  for (const v of Object.values(palette)) assert.match(v, /^#[0-9a-f]{6}$/);
});

test('album colours are on by default', () => {
  assert.equal(sanitize({}).mediaArtColors, true);
  assert.equal(sanitize({ mediaArtColors: false }).mediaArtColors, false);
});
