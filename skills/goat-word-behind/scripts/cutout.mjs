// The person cut-out, for looks that put things behind or under the speaker (goat-word-behind, goat-glass-ribbon):
// make or reuse hf/subject.webm with HyperFrames' remove-background, and find the head in it.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Make hf/subject.webm from cut.mp4, or reuse it while it is newer than cut.mp4. Returns its path.
export async function cutOut({ work, hfDir, hf }) {
  const cut = join(work, "cut.mp4"), subject = join(hfDir, "subject.webm");
  if (!existsSync(subject) || statSync(subject).mtimeMs < statSync(cut).mtimeMs) {
    console.log("[goat] cutting the person out of every frame (first run downloads a 168 MB model)…");
    const r = await hf(["remove-background", cut, "-o", subject, "--quality", "best"]);
    if (r.code || !existsSync(subject))
      throw new Error(`the cut-out failed:\n${(r.stdout + r.stderr).trim().slice(-1200)}`);
  }
  return subject;
}

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

// The head at t seconds. If ffmpeg can't read the cut-out (e.g. a build without libvpx-vp9) that is not "nobody
// in frame": say so, once, since the text that follows the head then sits at its fixed spot.
let readFailed = false;
export async function headAt(run, webm, t) {
  // libvpx-vp9 must be named before -i, or ffmpeg's own VP9 decoder drops the alpha
  const r = await run("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-ss", t.toFixed(3), "-i", webm, "-frames:v", "1",
    "-vf", "alphaextract,scale=108:192", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { binary: true });
  if (r.code || r.stdout.length < 108 * 192) {
    if (!readFailed)
      console.warn(`[goat] note: ffmpeg could not read the cut-out at ${t.toFixed(2)} s (${String(r.stderr).trim().slice(-300) ||
        "no frame"}), so text that follows the head sits at its fixed spot. Reinstall ffmpeg with VP9 (Mac: brew reinstall ffmpeg).`);
    readFailed = true;
    return null;
  }
  return headFromMask(r.stdout, 108, 192);
}

// A note when heads were sampled but none is usable (nobody found, or only shapes the look doesn't trust): `what`
// then sits at its fixed spot, which on a close-up can cover the mouth. null when there is nothing to say.
export function noHeadNote(heads, usable = Boolean, what) {
  if (!heads.length || heads.some(usable)) return null;
  return `[goat] note: no head found in the cut-out, so ${what} sit at their fixed spot, which can cover the mouth on a ` +
    "close-up. Check the cut-out follows the person (a plain background helps), and film from the chest up.";
}
