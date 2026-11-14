"""Shared render engine for the GOAT look skills.

Every skill ships its own copy (build.py copies core/goatcut.py into each skill),
so edit the file in core/, never a copy.

Pipeline:  clips -> ffmpeg (trim, fit, look grade) -> raw RGB frames
           -> look.frame(img, t, ctx) in Python (text, cards, stickers)
           -> ffmpeg (H.264 + AAC) -> output mp4
Sound:     clip sound + voice-over (ducks the rest) + music, brought to -14 LUFS,
           then the look's sound effects at fixed levels, then a limiter

A look is a module with:
    NAME       short name, used for the default output file
    FIT_SIZE   (w, h) every clip is cover-cropped to this size (default 1080x1920)
    GRADE      ffmpeg filter chain run on the joined clips, must keep FIT_SIZE
    frame(img, t, ctx) -> 1080x1920 RGB or RGBA PIL image
    setup(ctx) optional, runs once before the sound is mixed and the first frame is drawn
    SFX(ctx)   optional, returns the look's own sound effects: [{"sound": "whoosh", "at": 1.2,
               "volume": 1.0, "dur": 2.0}]. Sound names are in sfx.py. Plan "sfx": false turns them off.

CLI:  uv run goatcut.py probe <files...>   size, length, audio, HDR, speech spans
"""
import json
import math
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

W, H, FPS = 1080, 1920, 30
# Inside this box nothing is covered by Reels/TikTok buttons (Meta + TikTok guides combined).
# Prices, phone numbers and offers go here. Below y 840, keep left of x 780 (TikTok's side column).
SAFE = (120, 270, 960, 1248)
STILL_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp"}
HDR_TRC = {"smpte2084", "arib-std-b67"}
AXIS_TAGS = {"wght": "weight", "wdth": "width", "opsz": "optical size", "slnt": "slant", "ital": "italic"}


def die(msg):
    sys.exit(f"\n[goatcut] {msg}")


def need(tool):
    if not shutil.which(tool):
        die(f"{tool} is not installed. Mac: brew install ffmpeg   Windows: winget install Gyan.FFmpeg")


# ---------------------------------------------------------------- probing

def probe(path):
    need("ffprobe")
    p = Path(path)
    if not p.exists():
        die(f"file not found: {p}")
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(p)],
                       capture_output=True, text=True)
    if r.returncode:
        die(f"ffprobe could not read {p}: {r.stderr.strip()[:300]}")
    info = json.loads(r.stdout)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if v is None:  # a sound file (voice-over, music)
        return {"file": str(p), "video": False, "w": 0, "h": 0, "still": False, "fps": 0, "hdr": False,
                "dur": float(info["format"].get("duration") or 0), "audio": True}
    still = p.suffix.lower() in STILL_EXT
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    for sd in v.get("side_data_list", []):
        rot = int(sd.get("rotation", rot) or rot)
    if abs(rot) in (90, 270):
        w, h = h, w
    num, den = (v.get("avg_frame_rate") or "0/1").split("/")
    return {
        "file": str(p), "video": True, "w": w, "h": h, "still": still,
        "dur": 0.0 if still else float(info["format"].get("duration") or v.get("duration") or 0),
        "fps": round(int(num) / int(den), 2) if int(den or 0) else 0,
        "audio": any(s["codec_type"] == "audio" for s in info["streams"]),
        "hdr": v.get("color_transfer") in HDR_TRC,
    }


def speech(path, noise="-32dB", gap=0.35):
    """Spans where someone is talking, from ffmpeg silencedetect. Good enough to time text to phrases."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af",
                        f"silencedetect=noise={noise}:d={gap}", "-f", "null", "-"],
                       capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    total = probe(path)["dur"]
    spans, cur = [], 0.0
    for s, e in zip(starts, ends + [total]):
        if s - cur > 0.15:
            spans.append([round(cur, 2), round(s, 2)])
        cur = e
    if total - cur > 0.15:
        spans.append([round(cur, 2), round(total, 2)])
    return spans


# ---------------------------------------------------------------- context given to looks

class Ctx:
    def __init__(self, plan, plan_dir, skill_dir, clips, cuts, dur):
        self.plan, self.plan_dir, self.skill_dir = plan, plan_dir, skill_dir
        self.clips, self.cuts, self.dur = clips, cuts, dur
        # start/end are optional in plans: default to the whole video, so looks can read them directly
        self.items = sorted(({**x, "start": float(x.get("start", 0)), "end": float(x.get("end", dur))}
                             for x in plan.get("texts", [])), key=lambda x: x["start"])
        self.rng = random.Random(plan.get("seed", 21))
        self._fonts, self._cache = {}, {}

    def opt(self, key, default=None):
        return self.plan.get("look", {}).get(key, default)

    def clip_at(self, t):
        """(clip index, seconds into that clip) at output time t."""
        i = max(k for k, c in enumerate(self.cuts) if c <= t + 1e-6)
        return i, t - self.cuts[i]

    def texts(self, role=None):
        return [x for x in self.items if role is None or x.get("role") == role]

    def active(self, t, role=None):
        return [x for x in self.texts(role) if x.get("start", 0) <= t < x.get("end", self.dur)]

    def path(self, rel):
        p = (self.plan_dir / rel).resolve()
        if not p.exists():
            die(f"file not found: {p}")
        return p

    def font(self, file, size, axes=None):
        """Font from the skill's fonts/ folder. axes: {"wght": 700, "wdth": 75} for variable fonts."""
        from PIL import ImageFont
        key = (file, int(size), tuple(sorted((axes or {}).items())))
        if key not in self._fonts:
            f = ImageFont.truetype(str(self.skill_dir / "fonts" / file), int(size))
            if axes:
                names = [a["name"].decode() if isinstance(a["name"], bytes) else a["name"]
                         for a in f.get_variation_axes()]
                vals = [a["default"] for a in f.get_variation_axes()]
                for tag, val in axes.items():
                    want = AXIS_TAGS.get(tag, tag).lower()
                    for i, n in enumerate(names):
                        if n.lower() == want:
                            vals[i] = val
                f.set_variation_by_axes(vals)
            self._fonts[key] = f
        return self._fonts[key]

    def fit(self, text, file, max_w, max_size, min_size=24, axes=None, tracking=0.0):
        """Largest font size (<= max_size) at which the longest line of text fits in max_w px.
        Mongolian words run long, so every big-type layout must use this."""
        size = int(max_size)
        while size > min_size:
            f = self.font(file, size, axes)
            text = drawable(text, f)
            if max(f.getlength(ln) + tracking * size * max(0, len(ln) - 1) for ln in text.split("\n")) <= max_w:
                return f
            size = int(size * 0.94)
        return self.font(file, min_size, axes)

    def cache(self, key, make):
        if key not in self._cache:
            self._cache[key] = make()
        return self._cache[key]


# ---------------------------------------------------------------- drawing helpers

def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def ease_out(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = clamp(x)
    return 3 * x * x - 2 * x * x * x


def fade(t, item, fin=0.25, fout=0.2):
    """0..1 opacity for a text item: fades in at start, out at end."""
    s, e = item.get("start", 0), item.get("end", 1e9)
    return clamp(min((t - s) / fin if fin else 1, (e - t) / fout if fout else 1))


_GLYPHS, _WARNED = {}, set()


def drawable(text, font):
    """text minus any character the font can't draw (it would show as an empty box), with a warning.
    Compares each character's bitmap with the font's 'missing glyph' bitmap, so no extra package is needed."""
    from PIL import ImageFont
    path = getattr(font, "path", None)
    if not path:
        return text
    probe_font = _GLYPHS.setdefault(path, {"f": ImageFont.truetype(path, 40), "ok": {}})
    f, ok = probe_font["f"], probe_font["ok"]
    if "notdef" not in probe_font:
        probe_font["notdef"] = bytes(f.getmask("\U000F0000"))
    out = []
    for ch in text:
        if ch.isspace() or ch == "\n":
            out.append(ch)
            continue
        if ch not in ok:
            ok[ch] = bytes(f.getmask(ch)) != probe_font["notdef"]
        if ok[ch]:
            out.append(ch)
        elif (path, ch) not in _WARNED:
            _WARNED.add((path, ch))
            print(f"[goatcut] warning: font {Path(path).name} has no {ch!r} (U+{ord(ch):04X}); left it out")
    return "".join(out)


def text_sprite(text, font, fill=(255, 255, 255, 255), stroke=0, stroke_fill=(0, 0, 0, 255),
                align="center", spacing=0.12, shadow=None, tracking=0.0):
    """Text drawn on its own transparent image, trimmed to the ink. shadow=(dx, dy, blur, (r,g,b,a)).
    tracking: extra space between letters, in em (0.3 = wide-spaced titles)."""
    from PIL import Image, ImageDraw, ImageFilter
    text = drawable(text, font)
    if tracking:
        lines = [_tracked_line(ln, font, fill, stroke, stroke_fill, None, tracking) for ln in text.split("\n")]
        gap = int(font.size * spacing)
        w = max(i.width for i in lines)
        img = Image.new("RGBA", (w, sum(i.height for i in lines) + gap * (len(lines) - 1)), (0, 0, 0, 0))
        y = 0
        for ln in lines:
            x = {"left": 0, "right": w - ln.width}.get(align, (w - ln.width) // 2)
            img.alpha_composite(ln, (x, y))
            y += ln.height + gap
        return _shadowed(img, shadow) if shadow else img
    pad = stroke + (abs(shadow[0]) + abs(shadow[1]) + shadow[2] * 3 if shadow else 0) + 8
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    gap = int(font.size * spacing)
    box = d0.multiline_textbbox((0, 0), text, font=font, stroke_width=stroke, align=align, spacing=gap)
    box = (math.floor(box[0]), math.floor(box[1]), math.ceil(box[2]), math.ceil(box[3]))  # centred lines give floats
    w, h = box[2] - box[0] + pad * 2, box[3] - box[1] + pad * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    xy = (pad - box[0], pad - box[1])
    if shadow:
        dx, dy, blur, col = shadow
        sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(sh).multiline_text((xy[0] + dx, xy[1] + dy), text, font=font, fill=col,
                                          stroke_width=stroke, stroke_fill=col, align=align, spacing=gap)
        img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(blur)) if blur else sh)
    ImageDraw.Draw(img).multiline_text(xy, text, font=font, fill=fill, stroke_width=stroke,
                                       stroke_fill=stroke_fill, align=align, spacing=gap)
    return img.crop(img.getbbox() or (0, 0, 1, 1))


def _shadowed(img, shadow):
    """img with a drop shadow under it. shadow=(dx, dy, blur, (r,g,b,a))."""
    from PIL import Image, ImageFilter
    dx, dy, blur, col = shadow
    col = tuple(col) + (255,) * (4 - len(col))
    m = int(abs(dx) + abs(dy) + blur * 3 + 2)
    out = Image.new("RGBA", (img.width + 2 * m, img.height + 2 * m), (0, 0, 0, 0))
    a = Image.new("L", out.size, 0)
    a.paste(img.getchannel("A"), (m + int(dx), m + int(dy)))
    a = a.point(lambda v: v * col[3] // 255)
    sh = Image.new("RGBA", out.size, col[:3] + (0,))
    sh.putalpha(a.filter(ImageFilter.GaussianBlur(blur)) if blur else a)
    out.alpha_composite(sh)
    out.alpha_composite(img, (m, m))
    return out.crop(out.getbbox() or (0, 0, 1, 1))


def _tracked_line(line, font, fill, stroke, stroke_fill, shadow, tracking):
    from PIL import Image
    asc, desc = font.getmetrics()
    chars = [text_sprite(c, font, fill, stroke, stroke_fill, shadow=shadow) if c.strip() else None for c in line]
    adv = [font.getlength(c) + tracking * font.size for c in line]
    pad = stroke + 8
    img = Image.new("RGBA", (int(sum(adv)) + pad * 2, asc + desc + pad * 2), (0, 0, 0, 0))
    x = pad
    for c, sp, a in zip(line, chars, adv):
        if sp is not None:
            l, t = font.getbbox(c, stroke_width=stroke)[:2]
            img.alpha_composite(sp, (max(0, int(x + l)), max(0, pad + t)))
        x += a
    return img.crop(img.getbbox() or (0, 0, 1, 1))


def with_alpha(sprite, a):
    if a >= 0.999:
        return sprite
    s = sprite.copy()
    s.putalpha(s.getchannel("A").point(lambda v: int(v * a)))
    return s


def paste(canvas, sprite, x, y, alpha=1.0, anchor="lt"):
    """Alpha-composite sprite onto an RGBA canvas. Clips at the edges.
    anchor: 'lt' top-left, 'mm' centre, 'mt' top-centre, 'mb' bottom-centre."""
    if alpha <= 0.001:
        return
    w, h = sprite.size
    if anchor[0] == "m":
        x -= w / 2
    if anchor[1] == "m":
        y -= h / 2
    elif anchor[1] == "b":
        y -= h
    x, y = int(round(x)), int(round(y))
    l, t = max(0, -x), max(0, -y)
    r, b = min(w, canvas.width - x), min(h, canvas.height - y)
    if r <= l or b <= t:
        return
    part = sprite if (l, t, r, b) == (0, 0, w, h) else sprite.crop((l, t, r, b))
    canvas.alpha_composite(with_alpha(part, alpha), (x + l, y + t))


def rounded_mask(size, radius):
    from PIL import Image, ImageDraw
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return m


# ---------------------------------------------------------------- rendering

def _clips(plan, plan_dir):
    out = []
    for i, c in enumerate(plan.get("clips", [])):
        src = (plan_dir / c["src"]).resolve()
        info = probe(src)
        if not info["video"]:
            die(f"clip {i + 1} ({src.name}) is a sound file. Put it under \"voiceover\" or \"music\" instead.")
        if info["still"]:
            dur = float(c.get("dur", 2.0))
            start = 0.0
        else:
            start = float(c.get("in", 0))
            end = float(c.get("out", info["dur"]))
            if end > info["dur"] + 0.05:
                die(f"clip {i + 1} ({src.name}) ends at {end}s but the file is only {info['dur']:.2f}s long")
            dur = end - start
        if dur <= 0.05:
            die(f"clip {i + 1} ({src.name}) has no length: check in/out")
        if info["hdr"]:
            print(f"[goatcut] warning: {src.name} is HDR. Colours may look grey or too bright. "
                  "On iPhone turn off Settings > Camera > Record Video > HDR Video for the next shoot.")
        out.append({**c, "path": src, "info": info, "start": start, "dur": dur})
    if not out:
        die("the plan has no clips")
    return out


def _inputs(clips):
    args = []
    for c in clips:
        if c["info"]["still"]:
            args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{c['dur']:.3f}", "-i", str(c["path"])]
        else:
            args += ["-ss", f"{c['start']:.3f}", "-t", f"{c['dur']:.3f}", "-i", str(c["path"])]
    return args


def _sfx_events(look, ctx):
    """Sound effects for this render: the look's own (unless "auto": false) plus the plan's "add" list."""
    cfg = ctx.plan.get("sfx", {})
    if cfg is False:
        return [], 1.0
    if not isinstance(cfg, dict):
        die('"sfx" must be false or {"auto": true, "volume": 1.0, "add": [...]}')
    events = list(look.SFX(ctx)) if cfg.get("auto", True) and hasattr(look, "SFX") else []
    events += cfg.get("add", [])
    from sfx import NAMES
    for e in events:
        if e.get("sound") not in NAMES:
            die(f'unknown sound {e.get("sound")!r}. Choose from: {", ".join(NAMES)}')
    return [e for e in events if 0 <= float(e["at"]) < ctx.dur], float(cfg.get("volume", 1.0))


def _audio(clips, plan, plan_dir, events, gain, work, log):
    """One sound file for the video: the clips' sound (silence for photos), an optional voice-over
    that ducks everything else under it, optional music, and the sound effects."""
    total = sum(c["dur"] for c in clips)
    parts, fl, extra = [], [], []
    for i, c in enumerate(clips):
        if c["info"]["audio"] and not c["info"]["still"] and c.get("sound", True):
            fl.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:{c['dur']:.3f}[a{i}]")
        else:
            fl.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{c['dur']:.3f}[a{i}]")
        parts.append(f"[a{i}]")
    fl.append("".join(parts) + f"concat=n={len(clips)}:v=0:a=1[clipsnd]")
    nxt = len(clips)
    mix = []

    vo = plan.get("voiceover")
    if vo:
        v = vo if isinstance(vo, dict) else {"src": vo}
        vp = (plan_dir / v["src"]).resolve()
        info = probe(vp)
        at = float(v.get("at", 0))
        if at + info["dur"] > total + 0.2:
            print(f"[goatcut] warning: the voice-over runs to {at + info['dur']:.1f}s but the clips end at "
                  f"{total:.1f}s, so its end is cut off. Add or lengthen clips.")
        extra += ["-i", str(vp)]
        ms = int(at * 1000)
        fl.append(f"[{nxt}:a]aresample=48000,aformat=channel_layouts=stereo,volume={float(v.get('volume', 1.0))},"
                  f"adelay={ms}|{ms},apad,atrim=0:{total:.3f},asplit=3[vo][vokey1][vokey2]")
        nxt += 1
        # duck the clips' own sound under the voice-over
        fl.append("[clipsnd][vokey1]sidechaincompress=threshold=0.02:ratio=12:attack=15:release=400[clipduck]")
        mix += ["[vo]", "[clipduck]"]
    else:
        fl.append("[clipsnd]anull[clipduck]")
        mix += ["[clipduck]"]

    music = plan.get("music")
    if music:
        m = music if isinstance(music, dict) else {"src": music}
        mp = (plan_dir / m["src"]).resolve()
        if not mp.exists():
            die(f"music file not found: {mp}")
        extra += ["-stream_loop", "-1", "-i", str(mp)]
        fl.append(f"[{nxt}:a]aresample=48000,aformat=channel_layouts=stereo,volume={float(m.get('volume', 0.25))},"
                  f"atrim=0:{total:.3f},afade=t=out:st={max(0, total - 1):.3f}:d=1[mus]")
        nxt += 1
        if vo:
            fl.append("[mus][vokey2]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=500[musduck]")
            mix.append("[musduck]")
        else:
            mix.append("[mus]")
    elif vo:
        fl.append("[vokey2]anullsink")

    # 1) the "bed": clip sound + voice-over + music, without sound effects
    if len(mix) > 1:
        fl.append("".join(mix) + f"amix=inputs={len(mix)}:duration=first:normalize=0[bed]")
    else:
        fl.append(f"{mix[0]}anull[bed]")
    bed = work / "bed.wav"
    cmd = ["ffmpeg", "-y", "-hide_banner", *_inputs(clips), *extra, "-filter_complex", ";".join(fl),
           "-map", "[bed]", "-c:a", "pcm_f32le", str(bed)]
    r = subprocess.run(cmd, stderr=open(log, "w"), stdout=subprocess.DEVNULL)
    if r.returncode:
        die(f"ffmpeg could not mix the sound. Details: {log}")

    # 2) bring the bed to -14 LUFS (Reels/TikTok level). A silent bed is left silent, so sound
    #    effects on silent footage stay at their own level instead of being pushed up to -14.
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(bed), "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    found = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    lufs = float(found[-1]) if found else -70.0
    gain_db = min(30.0, -14.0 - lufs) if lufs > -60 else 0.0

    # 3) add the sound effects at fixed levels, then a limiter so nothing clips
    args = ["-i", str(bed)]
    fl = [f"[0:a]volume={gain_db:.2f}dB[b]"]
    last = "[b]"
    if events:
        import sfx
        sfx.write_wav(work / "sfx.wav", sfx.track(events, total, gain))
        args += ["-i", str(work / "sfx.wav")]
        fl.append("[1:a]aresample=48000,aformat=channel_layouts=stereo[fx]")
        fl.append("[b][fx]amix=inputs=2:duration=first:normalize=0[m]")
        last = "[m]"
    fl.append(f"{last}alimiter=limit=0.84:level=false,aresample=48000[out]")
    cmd = ["ffmpeg", "-y", "-hide_banner", *args, "-filter_complex", ";".join(fl),
           "-map", "[out]", "-c:a", "pcm_f32le", str(work / "sound.wav")]
    r = subprocess.run(cmd, stderr=open(log, "a"), stdout=subprocess.DEVNULL)
    if r.returncode:
        die(f"ffmpeg could not mix the sound. Details: {log}")


def run(look, argv=None):
    from PIL import Image
    argv = argv or sys.argv
    if len(argv) < 2:
        die(f"usage: uv run {Path(argv[0]).name} plan.json")
    need("ffmpeg")
    plan_path = Path(argv[1]).resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    plan_dir = plan_path.parent
    skill_dir = Path(look.__file__).resolve().parent.parent
    out = (plan_dir / plan.get("output", f"output/{look.NAME}.mp4")).resolve()
    work = out.parent / f".work-{look.NAME}"
    work.mkdir(parents=True, exist_ok=True)

    clips = _clips(plan, plan_dir)
    cuts, acc = [], 0.0
    for c in clips:
        cuts.append(acc)
        acc += c["dur"]
    dur = acc
    ctx = Ctx(plan, plan_dir, skill_dir, clips, cuts, dur)
    if hasattr(look, "setup"):
        look.setup(ctx)
    events, gain = _sfx_events(look, ctx)
    _audio(clips, plan, plan_dir, events, gain, work, work / "ffmpeg-sound.log")

    fit = getattr(look, "FIT_SIZE", (W, H))
    fw, fh = fit(ctx) if callable(fit) else fit
    fl = []
    for i, c in enumerate(clips):
        cx, cy = float(c.get("cx", 0.5)), float(c.get("cy", 0.5))
        fl.append(f"[{i}:v]scale={fw}:{fh}:force_original_aspect_ratio=increase:flags=lanczos,"
                  f"crop={fw}:{fh}:(iw-{fw})*{cx}:(ih-{fh})*{cy},setsar=1,fps={FPS},format=rgb24[v{i}]")
    fl.append("".join(f"[v{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0[cat]")
    grade = getattr(look, "GRADE", "") or "null"
    if callable(grade):
        grade = grade(ctx)
    fl.append(f"[cat]{grade},scale={fw}:{fh},fps={FPS},format=rgb24[v]")
    reader = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", *_inputs(clips), "-filter_complex", ";".join(fl),
         "-map", "[v]", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE, stderr=open(work / "ffmpeg-read.log", "w"))
    writer = subprocess.Popen(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "pipe:0",
         "-i", str(work / "sound.wav"), "-map", "0:v", "-map", "1:a",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
         "-c:v", "libx264", "-preset", "medium", "-crf", str(plan.get("crf", 18)),
         "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", "-shortest", str(out)],
        stdin=subprocess.PIPE, stderr=open(work / "ffmpeg-write.log", "w"))

    size, n, total = fw * fh * 3, 0, int(round(dur * FPS))
    print(f"[goatcut] {look.NAME}: {len(clips)} clip(s), {dur:.1f}s, {total} frames, "
          f"{len(events)} sound effect(s) -> {out}")
    try:
        while True:
            buf = reader.stdout.read(size)
            if len(buf) < size:
                break
            img = Image.frombytes("RGB", (fw, fh), buf)
            frame = look.frame(img, n / FPS, ctx)
            if frame.size != (W, H):
                die(f"look returned a {frame.size} frame, expected {W}x{H}")
            writer.stdin.write(frame.convert("RGB").tobytes())
            n += 1
            if n % (FPS * 5) == 0:
                print(f"  {n / FPS:.0f}s / {dur:.0f}s", flush=True)
    except BrokenPipeError:
        pass
    finally:
        reader.stdout.close()
        reader.wait()
        if writer.stdin:
            try:
                writer.stdin.close()
            except BrokenPipeError:
                pass
        writer.wait()
    if reader.returncode or writer.returncode or n == 0:
        log = work / ("ffmpeg-read.log" if reader.returncode or n == 0 else "ffmpeg-write.log")
        die(f"render failed after {n} frames. Last lines of {log}:\n" + log.read_text()[-1500:])
    print(f"[goatcut] done: {out}")
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "probe":
        for f in sys.argv[2:]:
            info = probe(f)
            if info["audio"] and not info["still"]:
                info["speech"] = speech(f)
            print(json.dumps(info, ensure_ascii=False))
    else:
        print(__doc__)
