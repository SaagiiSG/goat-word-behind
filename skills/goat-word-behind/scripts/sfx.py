"""Sound effects made in code: no sample files, so nothing to license. 48 kHz stereo float arrays.

make(name, dur=None, seed=0) -> numpy array (n, 2), peak about 0.9.
Each sound has a default level in LEVEL so they sit under a voice without anyone tuning them.
"""
import numpy as np

SR = 48000
LEVEL = {  # default mix level (0-1) under speech
    "whoosh": 0.45, "swish": 0.35, "pop": 0.35, "click": 0.3, "type": 0.25, "shutter": 0.45,
    "boom": 0.6, "thud": 0.55, "hit": 0.55, "riser": 0.35, "ding": 0.35, "notify": 0.35,
    "shimmer": 0.3, "paper": 0.4, "tape": 0.35, "marker": 0.25, "projector": 0.12, "tick": 0.25,
}
NAMES = sorted(LEVEL)


def _t(d):
    return np.arange(int(SR * d)) / SR


def _noise(n, rng):
    return rng.standard_normal(n)


def _band(x, lo, hi):
    """Brick-wall band-pass in the frequency domain (fine for noise textures)."""
    f = np.fft.rfft(x)
    fr = np.fft.rfftfreq(len(x), 1 / SR)
    f[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(f, len(x))


def _pink(n, rng):
    f = np.fft.rfft(rng.standard_normal(n))
    fr = np.fft.rfftfreq(n, 1 / SR)
    f /= np.sqrt(np.maximum(fr, 20))
    return np.fft.irfft(f, n)


def _norm(x, peak=0.9):
    m = np.max(np.abs(x)) or 1
    return x * (peak / m)


def _edges(x, fade=0.004):
    """Short fades at both ends so nothing clicks."""
    k = min(int(SR * fade), len(x) // 2)
    if k:
        ramp = np.linspace(0, 1, k)
        x[:k] *= ramp
        x[-k:] *= ramp[::-1]
    return x


def _glide(f0, f1, d, curve="exp"):
    t = _t(d)
    f = f0 * (f1 / f0) ** (t / d) if curve == "exp" else f0 + (f1 - f0) * t / d
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def _stereo(x, pan=0.0):
    """pan: -1 left .. 1 right, or an array per sample."""
    pan = np.asarray(pan)
    left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    return np.stack([x * left, x * right], axis=1) * np.sqrt(2)


def whoosh(rng, d=0.55, lo=250, hi=5000):
    n = int(SR * d)
    t = _t(d)
    peak = 0.62 * d
    env = np.where(t < peak, (t / peak) ** 2.2, np.exp(-(t - peak) / (0.18 * d)))
    low, high = _band(_pink(n, rng), lo, hi * 0.45), _band(_pink(n, rng), hi * 0.3, hi)
    mix = low * (1 - t / d) + high * (t / d) * 1.4  # brighter as it passes
    return _stereo(_edges(mix * env), pan=np.linspace(-0.6, 0.6, n))


def pop(rng, d=0.09):
    t = _t(d)
    return _stereo(_edges(_glide(950, 380, d) * np.exp(-t / 0.025)))


def click(rng, d=0.035, f=3200):
    t = _t(d)
    n = len(t)
    x = _band(_noise(n, rng), 1800, 11000) * np.exp(-t / 0.004) + 0.5 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.008)
    return _stereo(_edges(x))


def type_(rng, d=1.0):
    out = np.zeros(int(SR * d))
    pos = 0.0
    while pos < d - 0.05:
        c = click(rng, 0.03, f=rng.uniform(2400, 4200))[:, 0] * rng.uniform(0.5, 1.0)
        i = int(pos * SR)
        out[i:i + len(c)] += c[:len(out) - i]
        pos += rng.uniform(0.06, 0.12)
    return _stereo(_edges(out))


def shutter(rng, d=0.2):
    out = np.zeros(int(SR * d))
    for at, f, g in ((0.0, 2600, 1.0), (0.075, 2100, 0.8)):
        c = click(rng, 0.05, f=f)[:, 0] * g
        b = _band(_noise(len(c), rng), 600, 4500) * np.exp(-_t(0.05) / 0.012) * 0.8 * g
        i = int(at * SR)
        out[i:i + len(c)] += c + b
    return _stereo(_edges(out))


def boom(rng, d=1.4):
    t = _t(d)
    body = _glide(58, 36, d) * np.exp(-t / 0.45)
    hitn = _band(_noise(len(t), rng), 20, 300) * np.exp(-t / 0.04) * 0.6
    return _stereo(_edges(np.tanh((body + hitn) * 1.6)))


def thud(rng, d=0.42):
    t = _t(d)
    body = _glide(95, 42, d) * np.exp(-t / 0.12)
    tick = _band(_noise(len(t), rng), 800, 5000) * np.exp(-t / 0.006) * 0.35
    return _stereo(_edges(np.tanh((body + tick) * 1.8)))


def hit(rng, d=0.6):
    t = _t(d)
    crack = _band(_noise(len(t), rng), 150, 4500) * np.exp(-t / 0.05) * 0.7
    return thud(rng, d) + _stereo(_edges(crack))


def riser(rng, d=1.5):
    n = int(SR * d)
    t = _t(d)
    env = (t / d) ** 2.5
    lo = _band(_pink(n, rng), 300, 2500) * (1 - t / d)
    hi = _band(_pink(n, rng), 1500, 9000) * (t / d)
    tone = _glide(180, 1400, d) * 0.15
    x = (lo + hi * 1.3) * env / 3 + tone * env
    return _stereo(_edges(x, 0.01), pan=np.sin(t * 9) * 0.3)


def ding(rng, d=1.3, f=1046.5):
    t = _t(d)
    x = sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t / tau)
            for r, a, tau in ((1, 1.0, 0.55), (2.76, 0.4, 0.25), (5.4, 0.2, 0.12)) if f * r < 16000)
    return _stereo(_edges(x * (1 - np.exp(-t / 0.002))))


def notify(rng, d=0.55):
    a, b = ding(rng, 0.3, 1318.5)[:, 0], ding(rng, d - 0.11, 1760)[:, 0]
    out = np.zeros(int(SR * d))
    out[:len(a)] += a * 0.8
    out[int(0.11 * SR):int(0.11 * SR) + len(b)] += b
    return _stereo(_edges(out))


def shimmer(rng, d=1.3):
    out = np.zeros((int(SR * d), 2))
    for _ in range(7):
        f, at = rng.uniform(2200, 6500), rng.uniform(0, 0.35)
        s = ding(rng, d - at, f)[:, 0] * rng.uniform(0.3, 0.7)
        i = int(at * SR)
        out[i:i + len(s)] += _stereo(s, rng.uniform(-0.7, 0.7))
    return out


def paper(rng, d=0.5):
    n = int(SR * d)
    t = _t(d)
    grains = np.zeros(n)
    for _ in range(int(d * 90)):
        i = rng.integers(0, n - 200)
        grains[i:i + 200] += rng.uniform(0.3, 1.0) * np.exp(-np.arange(200) / 40)
    x = _band(_noise(n, rng), 900, 7000) * (0.15 + grains) * np.exp(-t / (0.6 * d))
    return _stereo(_edges(x))


def tape(rng, d=0.35):
    t = _t(d)
    rate = np.linspace(35, 70, len(t))
    teeth = (np.cumsum(rate) / SR) % 1.0
    x = _band(_noise(len(t), rng), 500, 6000) * (0.3 + teeth) * np.minimum(1, t / 0.05) * np.exp(-t / (0.7 * d))
    return _stereo(_edges(x))


def marker(rng, d=0.5):
    n = int(SR * d)
    t = _t(d)
    strokes = 0.5 + 0.5 * np.sin(2 * np.pi * np.cumsum(rng.uniform(8, 14, n)) / SR)
    squeak = np.sin(2 * np.pi * np.cumsum(2300 + 180 * np.sin(2 * np.pi * 5 * t)) / SR) * 0.08
    x = _band(_noise(n, rng), 1800, 7500) * strokes * 0.6 + squeak * strokes
    return _stereo(_edges(x, 0.02))


def projector(rng, d=3.0):
    """Super 8 projector rattle: 18 sprocket clicks a second over a low motor hum."""
    n = int(SR * d)
    t = _t(d)
    out = 0.05 * np.sin(2 * np.pi * 62 * t) + 0.04 * _band(_pink(n, rng), 100, 3000)
    k = np.exp(-np.arange(300) / 50) * _band(_noise(300, rng), 400, 5000)
    pos = 0.0
    while pos < d:
        i = int(pos * SR)
        out[i:i + 300] += k[:n - i] * rng.uniform(0.5, 0.9)
        pos += 1 / 18 + rng.uniform(-0.002, 0.002)
    return _stereo(_edges(out, 0.05))


def tick(rng, d=0.05):
    t = _t(d)
    return _stereo(_edges(np.sin(2 * np.pi * 1320 * t) * np.exp(-t / 0.012)))


_MAKERS = {"whoosh": whoosh, "swish": lambda r, d=0.28: whoosh(r, d, 1200, 9000), "pop": pop,
           "click": click, "type": type_, "shutter": shutter, "boom": boom, "thud": thud, "hit": hit,
           "riser": riser, "ding": ding, "notify": notify, "shimmer": shimmer, "paper": paper,
           "tape": tape, "marker": marker, "projector": projector, "tick": tick}
LENGTH_SOUNDS = {"type", "marker", "projector", "riser"}  # these take "dur"


def make(name, dur=None, seed=0):
    if name not in _MAKERS:
        raise ValueError(f"unknown sound {name!r}; choose from {', '.join(NAMES)}")
    rng = np.random.default_rng(seed)
    x = _MAKERS[name](rng, dur) if dur and name in LENGTH_SOUNDS else _MAKERS[name](rng)
    return _norm(np.asarray(x, dtype=np.float64))


def track(events, total, gain=1.0):
    """Mix events [{"sound", "at", "volume"?, "dur"?}] into one (n, 2) track of `total` seconds."""
    out = np.zeros((int(SR * total) + 1, 2))
    for k, e in enumerate(events):
        x = make(e["sound"], e.get("dur"), seed=k) * LEVEL[e["sound"]] * float(e.get("volume", 1.0)) * gain
        i = max(0, int(float(e["at"]) * SR))
        if i >= len(out):
            continue
        out[i:i + len(x)] += x[:len(out) - i]
    return out


def write_wav(path, x):
    import wave
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":  # uv run --with numpy sfx.py out.wav  -> every sound, one after another
    import sys
    seq, at = [], 0.3
    for nm in NAMES:
        d = 2.0 if nm in LENGTH_SOUNDS else None
        seq.append({"sound": nm, "at": at, "dur": d})
        at += (d or len(make(nm)) / SR) + 0.6
    write_wav(sys.argv[1] if len(sys.argv) > 1 else "sfx-demo.wav", track(seq, at, gain=1.2))
    print("\n".join(f"{e['at']:6.2f}s  {e['sound']}" for e in seq))
