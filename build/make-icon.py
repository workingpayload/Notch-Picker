import json, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

# Notch Picker app icon: a rounded tile with the notch pill at its top edge and the app's pixel
# cat hanging from it. Small sizes show the notch with just the cat's face peeking out.
# Usage: python make_icon.py <out_dir>
OUT = sys.argv[1]
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

data = json.loads(subprocess.check_output(['node', '-e', r'''
const s = require(process.argv[1] + '/src/pet-sprites.js');
const raw = s.SPRITES.hang.slice(3, 9).map((r) => '.' + r.slice(6, 14) + '.');
const face = s.outline(['.'.repeat(10), ...raw, '.'.repeat(10)]);
console.log(JSON.stringify({ hang: s.outline(s.SPRITES.hang), face, pal: s.PALETTES.orange }));
''', ROOT]))
HANG = data['hang']
PAL = dict(data['pal'])
PAL['c'] = '#30d158'  # collar in the status green
# The cat's face (rows 3-9 of the hanging pose, between its arms), outlined again on its own.
FACE = data['face']

def hexrgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_sprite(img, grid, x0, y0, cell):
    d = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        for x, c in enumerate(row):
            if c == '.': continue
            d.rectangle([x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 1, y0 + (y + 1) * cell - 1], fill=hexrgb(PAL.get(c, PAL['o'])) + (255,))

def render(size):
    small = size <= 32
    S = 4
    W = size * S
    m = round(W * (0.02 if small else 0.06))
    r = round(W * 0.22)
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([m, m, W - m - 1, W - m - 1], radius=r, fill=255)

    layer = Image.new('RGBA', (W, W))
    gd = ImageDraw.Draw(layer)
    top, bottom = hexrgb('#4a3aa8'), hexrgb('#16143a')
    for y in range(W):
        gd.line([(0, y), (W, y)], fill=lerp(top, bottom, (y - m) / (W - 2 * m)) + (255,))
    # Soft light behind the cat.
    glow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([W * 0.2, W * 0.2, W * 0.8, W * 0.8], fill=(150, 130, 255, 70))
    layer = Image.alpha_composite(layer, glow.filter(ImageFilter.GaussianBlur(W * 0.08)))

    # The notch: a pill flush with the tile's top edge (its top corners are cut off by the tile).
    d = ImageDraw.Draw(layer)
    pw = W * (0.74 if small else 0.68)
    ph = W * (0.30 if small else 0.155)
    px0 = (W - pw) / 2
    py1 = m + ph
    d.rounded_rectangle([px0, m - ph, px0 + pw, py1], radius=ph * (0.5 if small else 0.62), fill=(8, 8, 12, 255))
    cy = m + ph * 0.5
    dr = ph * (0.22 if small else 0.2)
    dx = px0 + (ph * 0.55 if not small else pw * 0.22)
    d.ellipse([dx - dr * 1.8, cy - dr * 1.8, dx + dr * 1.8, cy + dr * 1.8], fill=(48, 209, 88, 60))
    d.ellipse([dx - dr, cy - dr, dx + dr, cy + dr], fill=(48, 209, 88, 255))
    bx0 = dx + dr * (2.6 if not small else 2.4)
    d.rounded_rectangle([bx0, cy - dr * 0.5, px0 + pw - (ph * 0.55 if not small else pw * 0.16), cy + dr * 0.5], radius=dr * 0.5, fill=(240, 240, 245, 235))

    tile = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    tile.paste(layer, (0, 0), mask)
    tile = tile.resize((size, size), Image.LANCZOS)

    pill_bottom = py1 / S
    if small:
        # Just the face, peeking up from under the notch.
        cell = max(1, size // 14)
        fw = len(FACE[0]) * cell
        draw_sprite(tile, FACE, round((size - fw) / 2), round(pill_bottom - 2 * cell), cell)
    else:
        cell = max(1, round(size * 0.025))
        cw = len(HANG[0]) * cell
        draw_sprite(tile, HANG, round((size - cw) / 2), round(pill_bottom - 2 * cell), cell)
    return tile

big = render(1024)
big.save(OUT + r'\icon.png')
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
frames = {s: render(s) for s in sizes}
frames[256].save(OUT + r'\icon.ico', sizes=[(s, s) for s in sizes], append_images=[frames[s] for s in sizes if s != 256])
# Preview: large, then every size on dark and light backgrounds.
sheet = Image.new('RGBA', (1024 + 40 + sum(s + 24 for s in sizes) + 20, 1024), (32, 32, 36, 255))
sheet.paste(big, (0, 0), big)
for row, bg in enumerate([(32, 32, 36, 255), (243, 243, 243, 255)]):
    strip = Image.new('RGBA', (sum(s + 24 for s in sizes) + 20, 320), bg)
    x = 20
    for s in sizes:
        strip.paste(frames[s], (x, 160 - s // 2), frames[s]); x += s + 24
    sheet.paste(strip, (1044, 120 + row * 380))
if os.environ.get('ICON_PREVIEW'):
    sheet.save(OUT + r'\icon-preview.png')
zoom = Image.new('RGBA', (sum(s * 6 + 20 for s in [16, 20, 24, 32]) + 20, 32 * 6 + 40), (32, 32, 36, 255))
x = 20
for s in [16, 20, 24, 32]:
    z = frames[s].resize((s * 6, s * 6), Image.NEAREST); zoom.paste(z, (x, 20), z); x += s * 6 + 20
if os.environ.get('ICON_PREVIEW'):
    zoom.save(OUT + r'\icon-small.png')
print('ok')
