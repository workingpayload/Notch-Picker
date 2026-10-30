'use strict';

// Colours from an album cover for the notch's now-playing look, shared by the notch renderer
// (<script>) and the unit tests. Picks the cover's most vivid colour that covers a fair part of it,
// plus a second colour with a different hue, then adjusts both so they stay readable on the
// notch's dark and light backgrounds.

(function () {
  const BUCKETS = 12; // hue buckets of 30°
  const MIN_SHARE = 0.03; // a colour must cover at least this much of the cover to lead
  const MIN_SECOND = 0.015;
  const DARK_BG = [0, 0, 0];
  const LIGHT_BG = [250, 250, 252];
  const DARK_CONTRAST = 5; // the accent is used for text (the pill's title)
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

  // The two most telling colours of an image's pixels (RGBA bytes, e.g. from a small canvas), as
  // [r, g, b]: { primary, secondary }, or null for a cover that is essentially grey.
  function pickArtColors(data) {
    const buckets = Array.from({ length: BUCKETS }, () => ({ n: 0, weight: 0, r: 0, g: 0, b: 0 }));
    let total = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total++;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const [h, s, l] = rgbToHsl(rgb);
      if (s < 0.25 || l < 0.12 || l > 0.9) continue;
      const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
      const w = s * (1 - Math.abs(l - 0.5));
      const bucket = buckets[k];
      bucket.n++;
      bucket.weight += w;
      bucket.r += rgb[0] * w;
      bucket.g += rgb[1] * w;
      bucket.b += rgb[2] * w;
    }
    if (!total) return null;
    const colourOf = (bk) => [bk.r / bk.weight, bk.g / bk.weight, bk.b / bk.weight];
    const ranked = buckets.map((bk, k) => ({ ...bk, k })).filter((bk) => bk.weight > 0).sort((a, b) => b.weight - a.weight);
    const lead = ranked.find((bk) => bk.n / total >= MIN_SHARE);
    if (!lead) return null;
    const apart = (bk) => {
      const d = Math.abs(bk.k - lead.k);
      return Math.min(d, BUCKETS - d) >= 2;
    };
    const second = ranked.find((bk) => bk !== lead && apart(bk) && bk.n / total >= MIN_SECOND);
    const primary = colourOf(lead);
    if (second) return { primary, secondary: colourOf(second) };
    // One colourful hue: the second colour is a neighbouring hue of it.
    const [h, s, l] = rgbToHsl(primary);
    return { primary, secondary: hslToRgb([h + 40, s, l]) };
  }

  // A colour adjusted to read well on the notch: brighter on dark, deeper on light, never dull.
  function forBackground(rgb, dark) {
    const [h, s0] = rgbToHsl(rgb);
    const s = Math.max(s0, 0.5);
    const bg = dark ? DARK_BG : LIGHT_BG;
    let l = clamp(rgbToHsl(rgb)[2], dark ? 0.5 : 0.28, dark ? 0.75 : 0.5);
    let out = hslToRgb([h, s, l]);
    if (dark) {
      while (contrast(out, bg) < DARK_CONTRAST && l < 0.92) out = hslToRgb([h, s, (l += 0.02)]);
    } else {
      while (contrast(out, bg) < LIGHT_CONTRAST && l > 0.12) out = hslToRgb([h, s, (l -= 0.02)]);
    }
    return toHex(out);
  }

  // CSS colours for the notch from a cover's pixels, or null to keep the default.
  function artPalette(data) {
    const picked = pickArtColors(data);
    if (!picked) return null;
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
