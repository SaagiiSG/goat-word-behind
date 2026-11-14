// 13 Word Behind Head: a giant silver word behind the speaker's head, a teal line or ring
// behind them, teal chips for each thing they list, plain white captions from their speech.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const NAME = "word-behind";
export const TALKS = true;

const DECOS = ["auto", "line", "ring", "none"];
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

export function validate(plan) {
  const texts = plan.texts ?? [];
  if (texts.some((t) => t.role === "caption"))
    throw new Error('captions now come from transcript.json; remove the "caption" texts from plan.json');
  for (const t of texts) {
    if (!["word", "chip"].includes(t.role)) throw new Error(`text role "${t.role}" is not used by this look. Use "word" or "chip".`);
    if (!String(t.text ?? "").trim()) throw new Error(`a "${t.role}" text is empty`);
    if (!(Number(t.end) > Number(t.start))) throw new Error(`"${t.text}" must end after it starts`);
  }
  if (!texts.some((t) => t.role === "word")) throw new Error('add at least one {"role": "word"} text');
  const { dim = 0.4, deco = "auto" } = plan.look ?? {};
  if (!(dim >= 0 && dim <= 0.8)) throw new Error('"dim" must be between 0 and 0.8');
  if (!DECOS.includes(deco)) throw new Error(`"deco" must be one of ${DECOS.join(", ")}`);
}

const bigWords = (plan) => (plan.texts ?? []).filter((t) => t.role === "word").sort((a, b) => a.start - b.start);
const chips = (plan) => (plan.texts ?? []).filter((t) => t.role === "chip").sort((a, b) => a.start - b.start);
// "auto" takes turns: line, ring, line…
const decoOf = (plan, i) => {
  const d = plan.look?.deco ?? "auto";
  return d === "auto" ? (i % 2 ? "ring" : "line") : d;
};

// Head from a person mask (gray, w x h): top = first row with 7% of the width in the mask,
// width and centre from the band just under it, chin where the face narrows into the neck.
// Pixels of the 1080x1920 frame. null = nobody in frame.
export function headFromMask(gray, w, h) {
  const sx = 1080 / w, sy = 1920 / h;
  const rowSpan = (y) => {
    let a = -1, b = -1, n = 0;
    for (let x = 0; x < w; x++) if (gray[y * w + x] > 128) { if (a < 0) a = x; b = x; n++; }
    return n >= Math.max(3, w * 0.07) ? [a, b] : null; // 7% of the width: a stray curl or speck is not the head
  };
  let top = -1;
  for (let y = 0; y < h && top < 0; y++) if (rowSpan(y)) top = y;
  if (top < 0) return null;
  let a = w, b = 0;
  for (let y = top; y <= Math.min(h - 1, top + Math.round(0.06 * h)); y++) {
    const s = rowSpan(y);
    if (s) { a = Math.min(a, s[0]); b = Math.max(b, s[1]); }
  }
  // chin: the narrowest row between half a head and 1.6 heads below the top (head height ≈ its widest width)
  let headW = 0;
  for (let y = top; y < Math.min(h, top + Math.round(300 / sy)); y++) {
    const s = rowSpan(y);
    if (s) headW = Math.max(headW, s[1] - s[0] + 1);
  }
  const headH = (headW * sx) / sy;
  let chin = null, best = Infinity;
  for (let y = Math.round(top + 0.5 * headH); y <= Math.min(h - 1, Math.round(top + 1.6 * headH)); y++) {
    const s = rowSpan(y);
    if (s && s[1] - s[0] < best) { best = s[1] - s[0]; chin = y; }
  }
  return {
    cx: Math.round(((a + b + 1) / 2) * sx), top: Math.round(top * sy), width: Math.round((b - a + 1) * sx),
    chin: Math.round((chin ?? Math.min(h - 1, top + 1.2 * headH)) * sy),
  };
}

export async function headAt(run, webm, t) {
  // libvpx-vp9 must be named before -i, or ffmpeg's own VP9 decoder drops the alpha
  const r = await run("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-ss", t.toFixed(3), "-i", webm, "-frames:v", "1",
    "-vf", "alphaextract,scale=108:192", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { binary: true });
  if (r.code || r.stdout.length < 108 * 192) return null;
  return headFromMask(r.stdout, 108, 192);
}

// Captions just under the lowest chin seen (970 when there's room, as in the preview), chips under the
// captions. A close-up pushes both low; past 1248 the app's own text may cover them, so prepare() warns.
export const CHIP_ROW = 76 + 18;
export function layoutFor(heads) {
  const known = heads.filter(Boolean);
  const capY = known.length ? Math.round(clamp(Math.max(...known.map((h) => h.chin)) + 90, 970, 1420)) : 970;
  return { capY, chipsTop: capY + 60 };
}

// Captions or chips whose bottom edge falls below the safe box (y 1248), where app text can cover them.
export function offSafe({ capY, chipsTop }, chips) {
  const low = capY + 35 > 1248 ? ["captions"] : [];
  for (const c of chips) if (chipsTop + c.slot * CHIP_ROW + 76 > 1248) low.push(c.text);
  return low;
}

export async function prepare(ctx) {
  const { plan, work, hfDir, run, hf, dur } = ctx;
  const cut = join(work, "cut.mp4"), subject = join(hfDir, "subject.webm");
  if (!existsSync(subject) || statSync(subject).mtimeMs < statSync(cut).mtimeMs) {
    console.log("[goat] cutting the person out of every frame (first run downloads a 168 MB model)…");
    const r = await hf(["remove-background", cut, "-o", subject, "--quality", "best"]);
    if (r.code || !existsSync(subject))
      throw new Error(`the cut-out failed:\n${(r.stdout + r.stderr).trim().slice(-1200)}`);
  }
  const at = (t) => headAt(run, subject, clamp(Number(t), 0, dur - 0.05));
  const big = [];
  for (const [i, w] of bigWords(plan).entries())
    big.push({ text: w.text, start: Number(w.start), end: Math.min(Number(w.end), dur), deco: decoOf(plan, i),
      head: await at(Number(w.start) + 0.3) });
  // each chip takes the lowest row that no chip still on screen is using
  const list = [];
  for (const c of chips(plan)) {
    const busy = list.filter((p) => p.end > c.start).map((p) => p.slot);
    let slot = 0;
    while (busy.includes(slot)) slot++;
    list.push({ text: c.text, start: Number(c.start), end: Number(c.end), slot, head: await at(Number(c.start) + 0.2) });
  }
  const layout = layoutFor([...big, ...list].map((x) => x.head));
  const low = offSafe(layout, list);
  if (low.length)
    console.warn(`[goat] note: ${low.map((x) => `"${x}"`).join(", ")} sit below the safe area, where the app's own ` +
      "text can cover them. Keep at most 2 chips on screen at once; if the face fills the screen, film from the chest up.");
  return { big, chips: list, chipRow: CHIP_ROW, ...layout };
}

export function sfx(plan) {
  const out = [];
  bigWords(plan).forEach((w, i) => {
    out.push({ sound: "whoosh", at: Math.max(0, w.start - 0.15), volume: 0.5 });
    if (decoOf(plan, i) === "ring") out.push({ sound: "shimmer", at: w.start, volume: 0.4 });
  });
  for (const c of chips(plan)) out.push({ sound: "pop", at: c.start, volume: 0.6 });
  return out;
}
