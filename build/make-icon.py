import os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

# Notch Picker app icon: a navy tile with the notch pill (status light, waveform) and a soft,
# clay-shaded tabby cat peeking over it, paws on its edge. Small sizes (16-32 px) zoom in on the
# cat and the pill and drop the fine details so they stay readable.
# Usage: python build/make-icon.py <out_dir>   (ICON_PREVIEW=1 also writes preview sheets)
OUT = sys.argv[1]

NAVY_TOP = '#1d2b64'
NAVY_BOTTOM = '#0a0f24'
GLOW = '#3b82f6'
PILL_TOP, PILL_BOTTOM, PILL_EDGE = '#1c1e29', '#050508', '#353b4f'
GREEN = '#30d158'
FUR_LIGHT, FUR, FUR_DARK = '#fdba74', '#fb923c', '#ea580c'
CREAM = '#fff7ed'
EYE = '#1e1b2e'
PINK = '#fb7185'
EAR_PINK = '#fda4af'
MOUTH = '#7c2d12'


def rgb(h, a=255):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (a,)


def render(size):
    small = size <= 32
    tiny = size <= 20
    S = 8 if small else 4
    W = size * S
    # Small icons zoom in on the cat and the pill (about the group's centre).
    k = 1.3 if small else 1.0
    gx, gy = 0.5, 0.49

    def P(x, y):
        return (W * (gx + (x - gx) * k), W * (gy + (y - gy) * k))

    def box(x0, y0, x1, y1):
        a, b = P(x0, y0), P(x1, y1)
        return [a[0], a[1], b[0], b[1]]

    def L(v):  # a length
        return W * v * k

    def mask(draw):
        m = Image.new('L', (W, W), 0)
        draw(ImageDraw.Draw(m))
        return m

    def paint(base, m, src):
        if isinstance(src, tuple):
            src = Image.new('RGBA', (W, W), src)
        layer = src.copy()
        layer.putalpha(ImageChops.multiply(src.getchannel('A'), m))
        base.alpha_composite(layer)

    def vgrad(c1, c2, y0, y1):
        a, b = rgb(c1), rgb(c2)
        col = Image.new('RGBA', (1, W))
        y0, y1 = y0 * W, y1 * W
        px = []
        for y in range(W):
            t = min(1, max(0, (y - y0) / max(1, y1 - y0)))
            px.append(tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(4)))
        col.putdata(px)
        return col.resize((W, W), Image.NEAREST)

    def soft(m, r):  # rounds a mask's corners
        return m.filter(ImageFilter.GaussianBlur(r)).point(lambda p: max(0, min(255, (p - 128) * 10 + 128)))

    def glow(base, ellipse_box, color, blur):
        g = Image.new('RGBA', (W, W), (0, 0, 0, 0))
        ImageDraw.Draw(g).ellipse(ellipse_box, fill=color)
        base.alpha_composite(g.filter(ImageFilter.GaussianBlur(blur)))

    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

    # ---- Tile: navy squircle with a soft shadow, a blue glow and a light top rim ----
    m = W * (0.03 if small else 0.06)
    r = W * (0.2 if small else 0.215)
    tile = mask(lambda d: d.rounded_rectangle([m, m, W - m, W - m], radius=r, fill=255))
    if not small:
        shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
        shadow.putalpha(tile.point(lambda p: p * 110 // 255))
        shadow = shadow.transform((W, W), Image.AFFINE, (1, 0, 0, 0, 1, -W * 0.012)).filter(ImageFilter.GaussianBlur(W * 0.016))
        img.alpha_composite(shadow)
    bg = vgrad(NAVY_TOP, NAVY_BOTTOM, m / W, 1 - m / W)
    glow(bg, box(0.16, 0.12, 0.84, 0.8), rgb(GLOW, 120), W * 0.1)
    paint(img, tile, bg)
    if not tiny:
        inset = W * (0.006 if not small else 0.012)
        inner = mask(lambda d: d.rounded_rectangle([m + inset, m + inset, W - m - inset, W - m - inset], radius=r - inset, fill=255))
        rim = ImageChops.subtract(tile, inner)
        paint(img, rim, _rim_grad(W, m))

    # ---- The cat's head, behind the pill ----
    def ear(side):
        s = -1 if side == 'l' else 1
        pts = [P(0.5 + s * 0.185, 0.39), P(0.5 + s * 0.165, 0.178), P(0.5 + s * 0.045, 0.27)]
        inner_pts = [P(0.5 + s * 0.158, 0.335), P(0.5 + s * 0.152, 0.218), P(0.5 + s * 0.075, 0.278)]
        return pts, inner_pts

    head = mask(lambda d: d.ellipse(box(0.3, 0.245, 0.7, 0.585), fill=255))
    ears = Image.new('L', (W, W), 0)
    for side in 'lr':
        pts, _ = ear(side)
        ImageDraw.Draw(ears).polygon(pts, fill=255)
    ears = soft(ears, W * 0.008 * k)
    fur = vgrad(FUR_LIGHT, FUR, gy + (0.2 - gy) * k, gy + (0.55 - gy) * k)
    # Soft contact shadow of the head on the tile.
    if not small:
        glow(img, box(0.31, 0.27, 0.69, 0.6), (0, 0, 20, 120), W * 0.03)
    paint(img, ImageChops.lighter(head, ears), fur)
    # Clay highlight on the top-left of the head.
    if not small:
        hl = Image.new('RGBA', (W, W), (0, 0, 0, 0))
        ImageDraw.Draw(hl).ellipse(box(0.34, 0.29, 0.5, 0.38), fill=(255, 255, 255, 80))
        hl = hl.filter(ImageFilter.GaussianBlur(W * 0.025))
        paint(img, head, hl)
    if not tiny:
        for side in 'lr':
            _, inner_pts = ear(side)
            paint(img, soft(mask(lambda d: d.polygon(inner_pts, fill=255)), W * 0.006 * k), rgb(EAR_PINK))
    if not small:
        # Tabby stripes on the forehead.
        for x, top, h in [(0.468, 0.272, 0.04), (0.5, 0.262, 0.055), (0.532, 0.272, 0.04)]:
            paint(img, mask(lambda d: d.rounded_rectangle(box(x - 0.009, top, x + 0.009, top + h), radius=L(0.009), fill=255)), rgb(FUR_DARK, 200))
    # Muzzle, eyes, nose, mouth, cheeks.
    if not small:
        paint(img, mask(lambda d: d.ellipse(box(0.405, 0.43, 0.595, 0.545), fill=255)), rgb(CREAM))
    eye_r = (0.032, 0.042) if not small else (0.04, 0.048)
    for x in (0.418, 0.582):
        paint(img, mask(lambda d: d.ellipse(box(x - eye_r[0], 0.405 - eye_r[1], x + eye_r[0], 0.405 + eye_r[1]), fill=255)), rgb(EYE))
        if not tiny:
            hx, hy, hr = x + 0.011, 0.39, 0.012 if not small else 0.016
            paint(img, mask(lambda d: d.ellipse(box(hx - hr, hy - hr, hx + hr, hy + hr), fill=255)), rgb('#ffffff'))
    if not tiny:
        paint(img, soft(mask(lambda d: d.polygon([P(0.48, 0.448), P(0.52, 0.448), P(0.5, 0.47)], fill=255)), W * 0.004 * k), rgb(PINK))
    if not small:
        mw = max(1, round(L(0.007)))
        mouth = mask(lambda d: (d.arc(box(0.468, 0.445, 0.502, 0.49), 20, 160, fill=255, width=mw), d.arc(box(0.498, 0.445, 0.532, 0.49), 20, 160, fill=255, width=mw)))
        paint(img, mouth, rgb(MOUTH))
        for x in (0.375, 0.625):
            blush = Image.new('RGBA', (W, W), (0, 0, 0, 0))
            ImageDraw.Draw(blush).ellipse(box(x - 0.034, 0.452, x + 0.034, 0.484), fill=rgb(PINK, 110))
            img.alpha_composite(blush.filter(ImageFilter.GaussianBlur(W * 0.006)))

    # ---- The notch pill ----
    pill_box = box(0.165, 0.535, 0.835, 0.755)
    pr = (pill_box[3] - pill_box[1]) / 2
    pill = mask(lambda d: d.rounded_rectangle(pill_box, radius=pr, fill=255))
    if not small:
        glow(img, [pill_box[0], pill_box[1] + W * 0.02, pill_box[2], pill_box[3] + W * 0.03], (0, 0, 10, 150), W * 0.025)
    paint(img, pill, vgrad(PILL_TOP, PILL_BOTTOM, pill_box[1] / W, pill_box[3] / W))
    if not tiny:
        e = W * (0.005 if not small else 0.01)
        edge = ImageChops.subtract(pill, mask(lambda d: d.rounded_rectangle([pill_box[0] + e, pill_box[1] + e, pill_box[2] - e, pill_box[3] - e], radius=pr - e, fill=255)))
        paint(img, edge, rgb(PILL_EDGE, 200))
    # Status light.
    cx, cy = P(0.275, 0.645)
    dr = L(0.036 if not small else 0.05 if not tiny else 0.062)
    if not tiny:
        glow(img, [cx - dr * 2, cy - dr * 2, cx + dr * 2, cy + dr * 2], rgb(GREEN, 120), dr * 0.7)
    paint(img, mask(lambda d: d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=255)), rgb(GREEN))
    if not small:
        paint(img, mask(lambda d: d.ellipse([cx - dr * 0.45, cy - dr * 0.6, cx + dr * 0.05, cy - dr * 0.15], fill=255)), (255, 255, 255, 120))
    # Waveform (now playing); too fine to read at taskbar sizes.
    if not small:
        bars = [(0.6, 0.045), (0.635, 0.085), (0.67, 0.115), (0.705, 0.075), (0.74, 0.042)]
        bw = 0.011
        wave = mask(lambda d: [d.rounded_rectangle(box(x - bw, 0.645 - h / 2, x + bw, 0.645 + h / 2), radius=L(bw), fill=255) for x, h in bars])
        paint(img, wave, vgrad(FUR_LIGHT, FUR_DARK, (gy + (0.585 - gy) * k), (gy + (0.705 - gy) * k)))

    # ---- Paws over the pill's top edge ----
    if not small:
        for x in (0.4, 0.6):
            pb = box(x - 0.058, 0.512, x + 0.058, 0.578)
            paint(img, mask(lambda d: d.ellipse(pb, fill=255)), vgrad(CREAM, '#fed7aa', pb[1] / W, pb[3] / W))
            if not small:
                tw = max(1, round(L(0.006)))
                toes = mask(lambda d: [d.line([P(x + dx, 0.55), P(x + dx, 0.572)], fill=255, width=tw) for dx in (-0.02, 0.02)])
                paint(img, toes, rgb('#f59e0b', 170))

    return img.resize((size, size), Image.LANCZOS)


def _rim_grad(W, m):
    # Top rim light: bright at the top edge, gone by the middle.
    col = Image.new('RGBA', (1, W))
    col.putdata([(255, 255, 255, max(0, round(90 * (1 - (y - m) / (W * 0.45))))) for y in range(W)])
    return col.resize((W, W), Image.NEAREST)


big = render(1024)
big.save(os.path.join(OUT, 'icon.png'))
sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
frames = {s: render(s) for s in sizes}
frames[256].save(os.path.join(OUT, 'icon.ico'), sizes=[(s, s) for s in sizes], append_images=[frames[s] for s in sizes if s != 256])
if os.environ.get('ICON_PREVIEW'):
    # Large icon, then every size on dark and light backgrounds, and the smallest ones zoomed.
    sheet = Image.new('RGBA', (1024 + 40 + sum(s + 24 for s in sizes) + 20, 1024), (32, 32, 36, 255))
    sheet.paste(big, (0, 0), big)
    for row, bg in enumerate([(32, 32, 36, 255), (243, 243, 243, 255)]):
        strip = Image.new('RGBA', (sum(s + 24 for s in sizes) + 20, 320), bg)
        x = 20
        for s in sizes:
            strip.paste(frames[s], (x, 160 - s // 2), frames[s])
            x += s + 24
        sheet.paste(strip, (1044, 120 + row * 380))
    sheet.save(os.path.join(OUT, 'icon-preview.png'))
    zoom = Image.new('RGBA', (sum(s * 6 + 20 for s in [16, 20, 24, 32]) + 20, 32 * 6 + 40), (32, 32, 36, 255))
    x = 20
    for s in [16, 20, 24, 32]:
        z = frames[s].resize((s * 6, s * 6), Image.NEAREST)
        zoom.paste(z, (x, 20), z)
        x += s * 6 + 20
    zoom.save(os.path.join(OUT, 'icon-small.png'))
print('ok')
