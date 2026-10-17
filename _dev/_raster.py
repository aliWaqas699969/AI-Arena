"""Rasterizes the recorded canvas draw calls with Pillow.

Not a browser, but it renders linear AND radial gradients properly and masks
them to the drawn shapes, so colour and glow are faithful. Shadows and
letter-spacing are still omitted.
"""
import json, math, os, re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = sys.argv[1] if len(sys.argv) > 1 else "7000"
data = json.load(open(os.path.join(HERE, "frame_" + TAG + ".json"), encoding="utf-8"))
ops = data["ops"]

W, H = 1280, 720
img = Image.new("RGBA", (W, H), (0, 0, 0, 255))


def parse_color(c):
    if not isinstance(c, str):
        return (255, 0, 255, 255)
    c = c.strip()
    if c.startswith("#"):
        c = c[1:]
        if len(c) == 3:
            c = "".join(ch * 2 for ch in c)
        if len(c) == 6:
            return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), 255)
        if len(c) == 8:
            return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), int(c[6:8], 16))
        return (255, 0, 255, 255)
    m = re.match(r"rgba?\(([^)]+)\)", c)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        r, g, b = (int(round(float(p))) for p in parts[:3])
        a = float(parts[3]) if len(parts) > 3 else 1.0
        return (r, g, b, int(max(0, min(1, a)) * 255))
    return (255, 0, 255, 255)


def with_alpha(rgba, a):
    return (rgba[0], rgba[1], rgba[2], int(rgba[3] * max(0.0, min(1.0, a))))


def gradient_image(g, box):
    bx, by, bw, bh = box
    stops = sorted([(o, parse_color(c)) for o, c in g["stops"]], key=lambda s: s[0])
    if not stops or bw <= 0 or bh <= 0:
        return None
    offs = np.array([s[0] for s in stops], dtype=float)
    cols = np.array([s[1] for s in stops], dtype=float)

    xs = np.arange(bx, bx + bw)
    ys = np.arange(by, by + bh)
    gx, gy = np.meshgrid(xs, ys)

    x0, y0, x1, y1 = g["x0"], g["y0"], g["x1"], g["y1"]
    r0 = g.get("r0", 0.0) or 0.0
    r1 = g.get("r1", 0.0) or 0.0

    if abs(r1 - r0) > 1e-6 and abs(x1 - x0) < 1e-6 and abs(y1 - y0) < 1e-6:
        d = np.sqrt((gx - x0) ** 2 + (gy - y0) ** 2)
        t = (d - r0) / (r1 - r0)
    else:
        dx, dy = (x1 - x0), (y1 - y0)
        denom = dx * dx + dy * dy
        if denom < 1e-6:
            t = np.zeros_like(gx, dtype=float)
        else:
            t = ((gx - x0) * dx + (gy - y0) * dy) / denom
    t = np.clip(t, 0, 1)

    arr = np.zeros((bh, bw, 4), dtype=np.uint8)
    for ch in range(4):
        arr[:, :, ch] = np.interp(t, offs, cols[:, ch]).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def composite_gradient(g, box, mask_img, alpha):
    gi = gradient_image(g, box)
    if gi is None:
        return
    if alpha < 1:
        gi.putalpha(gi.split()[3].point(lambda v: int(v * alpha)))
    if mask_img is not None:
        gi.putalpha(ImageChops.multiply(gi.split()[3], mask_img))
    img.alpha_composite(gi, (box[0], box[1]))


def bbox_of(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x = int(math.floor(min(xs))); y = int(math.floor(min(ys)))
    x2 = int(math.ceil(max(xs))); y2 = int(math.ceil(max(ys)))
    x = max(0, min(W - 1, x)); y = max(0, min(H - 1, y))
    x2 = max(x + 1, min(W, x2)); y2 = max(y + 1, min(H, y2))
    return (x, y, x2 - x, y2 - y)


def mask_of(pts, box):
    m = Image.new("L", (box[2], box[3]), 0)
    d = ImageDraw.Draw(m)
    shifted = [(p[0] - box[0], p[1] - box[1]) for p in pts]
    if len(shifted) >= 3:
        d.polygon(shifted, fill=255)
    return m


FONT_FILES = {
    (True, True):   [r"C:\Windows\Fonts\georgiab.ttf", r"C:\Windows\Fonts\timebd.ttf", r"C:\Windows\Fonts\timesbd.ttf", r"C:\Windows\Fonts\arialbd.ttf"],
    (True, False):  [r"C:\Windows\Fonts\georgia.ttf", r"C:\Windows\Fonts\times.ttf", r"C:\Windows\Fonts\arial.ttf"],
    (False, True):  [r"C:\Windows\Fonts\seguisb.ttf", r"C:\Windows\Fonts\arialbd.ttf"],
    (False, False): [r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"],
}
_font_cache = {}


def get_font(size, weight):
    size = max(6, int(round(size)))
    key = (size, weight >= 600)
    if key in _font_cache:
        return _font_cache[key]
    files = FONT_FILES.get(key, [])
    path = next((p for p in files if os.path.exists(p)), None)
    try:
        f = ImageFont.truetype(path, size) if path else ImageFont.load_default()
    except Exception:
        f = ImageFont.load_default()
    _font_cache[key] = f
    return f


def paint(box, rgba, shape_fn):
    """Composite a shape onto the canvas with real alpha blending.

    Pillow draws RGBA ink by REPLACING pixels on an RGBA image, so any
    semi-transparent colour would come out opaque. Render to a cropped
    layer and alpha_composite it instead.
    """
    x, y, w, h = box
    x = max(0, int(x)); y = max(0, int(y))
    w = min(W - x, int(w)); h = min(H - y, int(h))
    if w <= 0 or h <= 0:
        return
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    shape_fn(d, x, y)
    img.alpha_composite(layer, (x, y))


ANCHOR = {"left": "l", "center": "m", "right": "r"}
BASE = {"alphabetic": "s", "middle": "m", "top": "a", "bottom": "d"}

for op in ops:
    t = op["t"]
    a = op.get("alpha", 1.0)
    if t in ("save", "restore"):
        continue

    if t == "rect":
        (x, y), w, h, style = op["x"], op["w"], op["h"], op["style"]
        if w < 0: x, w = x + w, -w
        if h < 0: y, h = y + h, -h
        if w <= 0 or h <= 0:
            continue
        if isinstance(style, dict) and style.get("grad"):
            composite_gradient(style["grad"], (max(0, int(x)), max(0, int(y)), int(w), int(h)), None, a)
        else:
            col = with_alpha(parse_color(style), a)
            paint((x, y, w, h), col, lambda d, ox, oy: d.rectangle(
                [0, 0, w - 1, h - 1], fill=col))

    elif t == "strokeRect":
        (x, y), w, h = op["x"], op["w"], op["h"]
        if w < 0: x, w = x + w, -w
        if h < 0: y, h = y + h, -h
        col = with_alpha(parse_color(op["style"]), a)
        lw = max(1, int(round(op["w"])))
        pad = lw + 1
        paint((x - pad, y - pad, w + pad * 2, h + pad * 2), col,
              lambda d, ox, oy, X=x, Y=y, Wd=w, Ht=h, L=lw, P=pad: d.rectangle(
                  [P, P, P + Wd, P + Ht], outline=col, width=L))

    elif t == "fill":
        style = op["style"]
        for path in op["paths"]:
            pts = path["pts"]
            if len(pts) < 3:
                continue
            if isinstance(style, dict) and style.get("grad"):
                box = bbox_of(pts)
                composite_gradient(style["grad"], box, mask_of(pts, box), a)
            else:
                col = with_alpha(parse_color(style), a)
                box = bbox_of(pts)
                shifted = [(p[0] - box[0], p[1] - box[1]) for p in pts]
                paint((box[0], box[1], box[2], box[3]), col,
                      lambda d, ox, oy, S=shifted: d.polygon(S, fill=col))

    elif t == "stroke":
        col = with_alpha(parse_color(op["style"]), a)
        w = max(1, int(round(op["w"])))
        for path in op["paths"]:
            pts = path["pts"]
            if len(pts) < 2:
                continue
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            bx = int(min(xs)) - w - 1; by = int(min(ys)) - w - 1
            bw = int(max(xs) - min(xs)) + 2 * w + 2
            bh = int(max(ys) - min(ys)) + 2 * w + 2
            shifted = [(p[0] - bx, p[1] - by) for p in pts]
            r = w / 2.0
            caps = [shifted[0], shifted[-1]]

            def shape(d, ox, oy, S=shifted, C=caps, R=r, Wd=w):
                d.line(S, fill=col, width=Wd, joint="curve")
                for p in C:
                    d.ellipse([p[0] - R, p[1] - R, p[0] + R, p[1] + R], fill=col)

            paint((bx, by, bw, bh), col, shape)

    elif t == "text":
        style = op["style"]
        if isinstance(style, dict) and style.get("grad"):
            gi = gradient_image(style["grad"], (0, 0, W, H))
            px = min(W - 1, max(0, int(op["x"]))); py = min(H - 1, max(0, int(op["y"])))
            col = with_alpha(gi.getpixel((px, py)), a)
        else:
            col = with_alpha(parse_color(style), a)
        f = get_font(op["size"], op["weight"])
        anchor = ANCHOR.get(op["align"], "l") + BASE.get(op["baseline"], "s")
        tw = max(20, int(op["size"] * len(op["s"]) * 0.75))
        th = max(16, int(op["size"] * 2.2))
        box = (op["x"] - tw * 0.6, op["y"] - th * 0.75, tw * 1.6, th * 1.6)

        def shape(d, ox, oy, S=op["s"], F=f, A=anchor, X=op["x"], Y=op["y"], C=col):
            try:
                d.text((X - ox, Y - oy), S, font=F, fill=C, anchor=A)
            except Exception:
                d.text((X - ox, Y - oy), S, font=F, fill=C)

        if col[3] < 255:
            paint(box, col, shape)
        else:
            draw = ImageDraw.Draw(img, "RGBA")
            shape(draw, 0, 0)

out = os.path.join(HERE, "preview_" + TAG + ".png")
img.convert("RGB").save(out)
print("wrote", out, img.size, "from", len(ops), "ops")
