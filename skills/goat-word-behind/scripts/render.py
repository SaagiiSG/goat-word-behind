# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["pillow>=10.4", "numpy>=1.26", "mediapipe==1.2.3"]
# ///
"""Word Behind Head · Толгойн ард үг.

A full-screen talking head with a giant silver word standing behind the speaker's head, a glowing
teal line or a turning teal ring behind them, teal chips for listed items and plain white captions.
A MediaPipe person cut-out on every frame puts the word between the background and the speaker.
Usage: uv run render.py plan.json
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import goatcut as g  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

NAME = "word-behind"
GRADE = "eq=contrast=1.10:brightness=-0.03:saturation=0.92,colorbalance=rs=-0.04:gs=0.01:bs=0.05,vignette=PI/5"
WORD = "ScienceGothic[CTRS,slnt,wdth,wght].ttf"
WORD_AXES = {"wght": 900, "wdth": 70}
INTER = "Inter[opsz,wght].ttf"
MODEL = "selfie_segmenter.tflite"  # MediaPipe, Apache-2.0, bundled in models/
SMALL = (288, 512)                 # the cut-out runs on this small copy of each frame
TEAL = (67, 229, 210)
CAP_Y = 960                        # caption centre; chips stack below it inside the safe box
CHIP_X, CHIP_Y, CHIP_H, CHIP_GAP = 324, 1010, 64, 12


# ---------------------------------------------------------------- person cut-out

class Matte:
    """Person mask per frame: MediaPipe selfie segmenter on a small copy, firmed up and blended
    with the previous frame's mask so edges don't flicker. Resets at every cut."""

    def __init__(self, ctx):
        from mediapipe.tasks.python import BaseOptions, vision
        model = (ctx.skill_dir / "models" / MODEL).read_bytes()  # buffer, not path: non-Latin folder names break paths
        self.seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_buffer=model),
            running_mode=vision.RunningMode.VIDEO, output_confidence_masks=True))
        self.prev, self.clip = None, -1

    def __call__(self, img, t, ctx):
        import mediapipe as mp
        small = np.ascontiguousarray(img.resize(SMALL, Image.BILINEAR))
        res = self.seg.segment_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=small), int(t * 1000))
        m = np.array(res.confidence_masks[0].numpy_view()[..., 0])
        i = ctx.clip_at(t)[0]
        self.cut = i != self.clip
        if not self.cut:
            m = 0.6 * m + 0.4 * self.prev
        self.prev, self.clip = m, i
        return m


def mask_image(m):
    small = Image.fromarray(np.clip((m - 0.3) * 2.5 * 255, 0, 255).astype(np.uint8))
    return small.filter(ImageFilter.GaussianBlur(1)).resize((g.W, g.H), Image.BILINEAR)


def head_of(m):
    """(x, top) of the speaker's head in output pixels, from the small mask. None if nobody is there."""
    rows = np.nonzero((m > 0.5).sum(1) > 0.04 * m.shape[1])[0]
    if not len(rows):
        return None
    top = rows[0]
    band = m[top:top + m.shape[0] // 12] > 0.5
    xs = np.nonzero(band.any(0))[0]
    sx, sy = g.W / m.shape[1], g.H / m.shape[0]
    return (xs.mean() * sx if len(xs) else g.W / 2), top * sy


# ---------------------------------------------------------------- sprites

def silver_sprite(text, font, top=(255, 255, 255), bottom=(169, 178, 186), stop=0.25):
    """Text filled with a top-to-bottom silver gradient, with a soft dark shadow so it reads on light walls."""
    a = g.text_sprite(text, font).getchannel("A")
    w, h = a.size
    col = Image.new("RGB", (1, h))
    col.putdata([tuple(round(c0 + (c1 - c0) * g.clamp((y / h - stop) / (1 - stop))) for c0, c1 in zip(top, bottom))
                 for y in range(h)])
    face = col.resize((w, h)).convert("RGBA")
    face.putalpha(a)
    pad = 40
    out = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
    sh.putalpha(0)
    sh.paste((0, 0, 0, 120), (pad, pad + 6), a)
    out.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(face, (pad, pad))
    return out


def glow(layer, radius, strength=1.0):
    """layer with a blurred copy of itself underneath."""
    out = layer.filter(ImageFilter.GaussianBlur(radius))
    if strength != 1.0:
        out.putalpha(out.getchannel("A").point(lambda v: min(255, int(v * strength))))
    out.alpha_composite(layer)
    return out


def bezier(p0, p1, p2, p3, n=60):
    return [tuple((1 - s) ** 3 * a + 3 * (1 - s) ** 2 * s * b + 3 * (1 - s) * s * s * c + s ** 3 * d
                  for a, b, c, d in zip(p0, p1, p2, p3)) for s in (i / n for i in range(n + 1))]


def wave_sprite():
    # the preview's path: M-60 640 C 120 550, 300 730, 480 640 S 840 550, 1140 640 (drawn around y=0 here)
    pts = bezier((-60, 0), (120, -90), (300, 90), (480, 0)) + bezier((480, 0), (660, -90), (840, -90), (1140, 0))
    img = Image.new("RGBA", (1300, 260), (0, 0, 0, 0))
    ImageDraw.Draw(img).line([(x + 100, y + 130) for x, y in pts], fill=TEAL + (255,), width=7, joint="curve")
    return glow(img, 7, 1.6)


def ring_sprite():
    s = 780
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c, r = s / 2, 300
    d.arc((c - r, c - r, c + r, c + r), 200, 200 + 216, fill=TEAL + (255,), width=9)  # 60% of the circle
    for k in range(60):  # tick marks every 6 degrees on an outer circle
        a = math.radians(k * 6)
        d.line([(c + 338 * math.cos(a), c + 338 * math.sin(a)), (c + 352 * math.cos(a), c + 352 * math.sin(a))],
               fill=(255, 255, 255, 140), width=2)
    return glow(img, 8, 1.5)


def chip_sprite(ctx, text):
    f = ctx.fit(text, INTER, 330, 30, min_size=20, axes={"wght": 600, "opsz": 24})
    label = g.text_sprite(text, f, shadow=(0, 0, 6, (0, 0, 0, 120)))
    ico, pad = 48, 30
    w = 8 + ico + 16 + label.width + 24
    img = Image.new("RGBA", (w + pad * 2, CHIP_H + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((pad, pad, pad + w, pad + CHIP_H), CHIP_H // 2, fill=(18, 20, 22, 205),
                        outline=(255, 255, 255, 46), width=2)
    # teal app icon: diagonal gradient square with a white inner square and a glow
    grad = Image.linear_gradient("L").rotate(45, expand=True).resize((ico, ico))
    tile = Image.composite(Image.new("RGB", (ico, ico), (24, 168, 151)), Image.new("RGB", (ico, ico), (107, 245, 226)),
                           grad).convert("RGBA")
    tile.putalpha(g.rounded_mask((ico, ico), 13))
    ImageDraw.Draw(tile).rounded_rectangle((ico * .3, ico * .3, ico * .7, ico * .7), 4, fill=(255, 255, 255, 255))
    ix, iy = pad + 8, pad + (CHIP_H - ico) // 2
    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle((ix, iy, ix + ico, iy + ico), 13, fill=TEAL + (150,))
    img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(10)))
    img.alpha_composite(tile, (ix, iy))
    img.alpha_composite(label, (ix + ico + 16, pad + (CHIP_H - label.height) // 2))
    return img


def caption_sprite(ctx, text):
    f = ctx.fit(text, INTER, 840, 38, axes={"wght": 800, "opsz": 32})
    return g.text_sprite(text, f, shadow=(0, 0, 10, (0, 0, 0, 160)))


# ---------------------------------------------------------------- look

def SFX(ctx):
    # a soft whoosh as each word rises behind the head, a light pop as each chip appears
    return ([{"sound": "whoosh", "at": max(0, x["start"] - 0.15), "volume": 0.5} for x in ctx.texts("word")]
            + [{"sound": "pop", "at": x["start"], "volume": 0.6} for x in ctx.texts("chip")])


def setup(ctx):
    dim = ctx.opt("dim", 0.4)
    if not isinstance(dim, (int, float)) or not 0 <= dim <= 0.8:
        g.die("look.dim must be a number from 0 (background as filmed) to 0.8 (almost black)")
    ctx.dim = float(dim)
    if not ctx.texts("word"):
        g.die('the plan has no "word" texts. Add at least one: {"role": "word", "text": "ЭНГИЙН", "start": 0.3, "end": 3}')
    ctx.matte = Matte(ctx)
    ctx.head = None
    ctx.wave, ctx.ring = wave_sprite(), ring_sprite()
    ctx.black = Image.new("RGBA", (g.W, g.H), (0, 0, 0, 255))


def word_place(ctx, item):
    """Fixed per word when it first shows: its lower third sits behind the top of the head."""
    s = ctx.cache(("word", item["text"]), lambda: silver_sprite(
        item["text"].upper(), ctx.fit(item["text"].upper(), WORD, 930, 300, axes=WORD_AXES)))
    ink = s.height - 80  # silver_sprite pads 40 px each side
    hx, top = ctx.head or (540, 700)
    y = g.clamp(top - 0.65 * ink, 270, 560) - 40
    return s, y, hx, top


def frame(img, t, ctx):
    m = ctx.matte(img, t, ctx)
    h = head_of(m)
    if ctx.matte.cut:
        ctx.head = None
    if h:
        ctx.head = h if ctx.head is None else tuple(0.85 * a + 0.15 * b for a, b in zip(ctx.head, h))
    person = img.convert("RGBA")
    canvas = Image.blend(person, ctx.black, ctx.dim) if ctx.dim else person.copy()

    # behind the speaker: the word and its accent (odd words get the line, even words the ring)
    words = ctx.texts("word")
    for item in ctx.active(t, "word")[-1:]:
        s, y, hx, top = ctx.cache(("place", id(item)), lambda: word_place(ctx, item))
        a = g.fade(t, item, 0.35, 0.25)
        k = g.ease_out((t - item["start"]) / 0.35)
        g.paste(canvas, s, 540, y + 24 * (1 - k), a, anchor="mt")
        p = g.clamp((t - item["start"]) / max(0.1, item["end"] - item["start"]))
        cx, cy = ctx.head[0] if ctx.head else hx, (ctx.head[1] if ctx.head else top) + 200
        if words.index(item) % 2 == 0:
            g.paste(canvas, ctx.wave, 540 - 40 + 80 * g.ease_in_out(p), cy, a, anchor="mm")
        else:
            ring = ctx.ring.rotate(40 - 50 * p, Image.BICUBIC)
            g.paste(canvas, ring, cx, cy, a, anchor="mm")

    canvas = Image.composite(person, canvas, mask_image(m))

    # in front: captions and chips
    for item in ctx.active(t, "caption")[-1:]:
        s = ctx.cache(("cap", item["text"]), lambda: caption_sprite(ctx, item["text"].upper()))
        g.paste(canvas, s, 540, CAP_Y, g.fade(t, item, 0.25, 0.2), anchor="mm")
    for n, item in enumerate(ctx.active(t, "chip")[-3:]):
        s = ctx.cache(("chip", item["text"]), lambda: chip_sprite(ctx, item["text"]))
        k = g.ease_out((t - item["start"]) / 0.2)
        if k < 1:
            s = s.resize((max(1, round(s.width * (0.6 + 0.4 * k))), max(1, round(s.height * (0.6 + 0.4 * k)))))
        g.paste(canvas, s, CHIP_X - 30 + s.width / 2, CHIP_Y + n * (CHIP_H + CHIP_GAP) + CHIP_H / 2,
                g.fade(t, item, 0.2, 0.2), anchor="mm")
    return canvas


if __name__ == "__main__":
    g.run(sys.modules[__name__])
