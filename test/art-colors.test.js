'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickArtColors, forBackground, artPalette, contrast, rgbToHsl } = require('../src/art-colors');
const { sanitize } = require('../src/settings');

// RGBA pixels: [[r, g, b, count], ...].
function pixels(spec) {
  const out = [];
  for (const [r, g, b, n, a = 255] of spec) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return Uint8ClampedArray.from(out);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hue = (rgb) => rgbToHsl(rgb)[0];

test('the cover\'s most vivid colour leads, with a second colour of another hue', () => {
  // Mostly dark navy background, a big red shape and some yellow.
  const cover = pixels([
    [15, 18, 40, 300],
    [220, 30, 40, 150],
    [240, 200, 20, 60],
    [128, 128, 128, 50],
  ]);
  const { primary, secondary } = pickArtColors(cover);
  assert.ok(hue(primary) < 15 || hue(primary) > 345, `red leads: ${primary}`);
  assert.ok(hue(secondary) > 40 && hue(secondary) < 65, `yellow second: ${secondary}`);
});

test('grey covers keep the default colour; a one-hue cover gets a neighbouring second hue', () => {
  assert.equal(pickArtColors(pixels([[30, 30, 30, 200], [200, 200, 200, 200]])), null);
  assert.equal(pickArtColors(pixels([[255, 0, 0, 100, 0]])), null, 'transparent pixels are ignored');
  assert.equal(pickArtColors(pixels([[20, 20, 20, 990], [200, 30, 30, 10]])), null, 'a speck of colour is not enough');
  const { primary, secondary } = pickArtColors(pixels([[40, 120, 220, 400]]));
  assert.ok(Math.abs(hue(secondary) - hue(primary) - 40) < 2);
});

test('colours are adjusted to stay readable on the dark and light notch', () => {
  const black = [0, 0, 0];
  const light = [250, 250, 252];
  for (const rgb of [[10, 20, 90], [240, 220, 30], [200, 30, 40], [30, 160, 60], [120, 120, 130]]) {
    const dark = hex(forBackground(rgb, true));
    const onLight = hex(forBackground(rgb, false));
    assert.ok(contrast(dark, black) >= 5, `${rgb} on dark: ${dark}`);
    assert.ok(contrast(onLight, light) >= 3.6, `${rgb} on light: ${onLight}`);
    assert.ok(rgbToHsl(dark)[1] >= 0.49, 'never dull');
  }
  const palette = artPalette(pixels([[220, 30, 40, 100], [30, 90, 220, 60]]));
  assert.deepEqual(Object.keys(palette), ['dark', 'dark2', 'light', 'light2']);
  for (const v of Object.values(palette)) assert.match(v, /^#[0-9a-f]{6}$/);
  assert.equal(artPalette(pixels([[90, 90, 90, 50]])), null);
});

test('album colours are on by default', () => {
  assert.equal(sanitize({}).mediaArtColors, true);
  assert.equal(sanitize({ mediaArtColors: false }).mediaArtColors, false);
});
