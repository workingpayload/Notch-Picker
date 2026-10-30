'use strict';

// Colours from an album cover for the notch's now-playing look, shared by the notch renderer
// (<script>) and the unit tests. The lead colour is the cover's dominant colourful area (by how
// much of the cover it covers, with a mild preference for vivid colours), the second one the next
// distinct colour on the cover. Both keep the cover's own hue and saturation; only their lightness
// is moved as far as needed to stay readable on the notch's dark and light backgrounds. A cover
// with hardly any colour gives greys.

(function () {
  const BUCKETS = 12; // hue buckets of 30°
  const MIN_LEAD = 0.04; // a colour must cover at least this much of the cover to lead
  const MIN_SECOND = 0.03;
  const MIN_COLOURFUL = 0.06; // less colour than this in total: the cover counts as grey
  const NEUTRAL_S = 0.15; // pixels less saturated than this are greys
  const DARK_BG = [0, 0, 0];
  const LIGHT_BG = [250, 250, 252];
  const DARK_CONTRAST = 4.5; // the accent is used for text (the pill's title)
  const LIGHT_CONTRAST = 3.6;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function rgbToHsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function hslToRgb([h, s, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [r, g, b].map((v) => Math.round((v + m) * 255));
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  function toHex(rgb) {
    return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  // The two telling colours of an image's pixels (RGBA bytes, e.g. from a small canvas), as
  // [r, g, b]: { primary, secondary }, or null when no pixel is opaque.
  function pickArtColors(data) {
    const buckets = Array.from({ length: BUCKETS }, (_, k) => ({ k, n: 0, s: 0, r: 0, g: 0, b: 0 }));
    const grey = { n: 0, r: 0, g: 0, b: 0 };
    let total = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total++;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const [h, s, l] = rgbToHsl(rgb);
      // Near-black and near-white pixels have no reliable hue.
      const target = s < NEUTRAL_S || l < 0.06 || l > 0.94 ? grey : buckets[Math.floor(h / (360 / BUCKETS)) % BUCKETS];
      target.n++;
      target.r += rgb[0];
      target.g += rgb[1];
      target.b += rgb[2];
      if (target !== grey) target.s += s;
    }
    if (!total) return null;
    const average = (bk) => [bk.r / bk.n, bk.g / bk.n, bk.b / bk.n];
    const colourful = buckets.filter((bk) => bk.n > 0);
    const colourShare = colourful.reduce((sum, bk) => sum + bk.n, 0) / total;
    // Mostly grey, black or white: greys, lighter and darker.
    if (colourShare < MIN_COLOURFUL) {
      const g = grey.n ? average(grey) : [128, 128, 128];
      const l = rgbToHsl(g)[2];
      return { neutral: true, primary: hslToRgb([0, 0, l]), secondary: hslToRgb([0, 0, l > 0.5 ? l - 0.25 : l + 0.25]) };
    }
    const score = (bk) => (bk.n / total) * (0.5 + bk.s / bk.n);
    const ranked = colourful.sort((a, b) => score(b) - score(a));
    const lead = ranked.find((bk) => bk.n / total >= MIN_LEAD) || ranked[0];
    const apart = (bk) => {
      const d = Math.abs(bk.k - lead.k);
      return Math.min(d, BUCKETS - d) >= 2;
    };
    const primary = average(lead);
    const second = ranked.find((bk) => bk !== lead && apart(bk) && bk.n / total >= MIN_SECOND);
    if (second) return { primary, secondary: average(second) };
    // One colourful hue: a lighter or darker shade of it, as on the cover.
    const [h, s, l] = rgbToHsl(primary);
    return { primary, secondary: hslToRgb([h, s, l > 0.5 ? l - 0.2 : l + 0.2]) };
  }

  // A colour made readable on the notch: same hue and saturation, lighter on dark and darker on
  // light only as far as needed.
  function forBackground(rgb, dark) {
    const [h, s, l0] = rgbToHsl(rgb);
    const bg = dark ? DARK_BG : LIGHT_BG;
    let l = l0;
    let out = hslToRgb([h, s, l]);
    if (dark) {
      while (contrast(out, bg) < DARK_CONTRAST && l < 0.95) out = hslToRgb([h, s, (l = Math.min(0.95, l + 0.02))]);
    } else {
      while (contrast(out, bg) < LIGHT_CONTRAST && l > 0.08) out = hslToRgb([h, s, (l = Math.max(0.08, l - 0.02))]);
    }
    return toHex(out);
  }

  // A colourless (black-and-white or grey) cover: a clean monochrome look, white-ish on the dark
  // notch and near-black on the light one, with grey as the second colour.
  const MONOCHROME = { dark: '#ededed', dark2: '#8e8e8e', light: '#1c1c1c', light2: '#6e6e6e' };

  // CSS colours for the notch from a cover's pixels, or null (nothing to go by) to keep the default.
  function artPalette(data) {
    const picked = pickArtColors(data);
    if (!picked) return null;
    if (picked.neutral) return { ...MONOCHROME };
    return {
      dark: forBackground(picked.primary, true),
      dark2: forBackground(picked.secondary, true),
      light: forBackground(picked.primary, false),
      light2: forBackground(picked.secondary, false),
    };
  }

  const api = { pickArtColors, forBackground, artPalette, contrast, rgbToHsl, hslToRgb, toHex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.ArtColors = api;
})();
