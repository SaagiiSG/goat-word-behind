// Words: Whisper transcript, caption groups, silence cutting.
// Caption, pacing and silence rules adapted from Nate Herk's herk-edit-kit (MIT, © 2026 Nate Herk).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FPS, ffmpeg, speech } from "./media.mjs";
import { hf } from "./hf.mjs";

const END = /[.!?…]$/;
const snap = (x) => Math.round(x * FPS);

export function parseTranscript(json) {
  const list = Array.isArray(json) ? json : json?.words ?? [];
  return list
    .map((x) => ({ text: String(x.text ?? "").trim(), start: Number(x.start), end: Number(x.end) }))
    .filter((x) => x.text && x.text !== "♪" && !/^[[(].*[\])]$/.test(x.text));
}

// large-v3-turbo: on an 8 GB M3, 4 s and 1.9 GB for a 6.5 s clip, against 15 s and 4 GB for large-v3,
// with Mongolian as good (14 Nov test). medium mixes in Kazakh letters and loops; small is unusable.
export const WHISPER_MODEL = "large-v3-turbo";

export async function transcribe(media, workDir) {
  const r = await hf(["transcribe", media, "-d", workDir, "--engine", "whisper", "--model", WHISPER_MODEL,
    "--language", "mn", "--json"]);
  const res = JSON.parse(r.stdout.trim().split("\n").at(-1) || "{}");
  if (!res.ok) throw new Error(`Whisper could not transcribe ${media}: ${res.error?.message ?? r.stderr.slice(-500)}`);
  const file = res.transcriptPath ?? join(workDir, "transcript.json");
  let words = existsSync(file) ? parseTranscript(JSON.parse(readFileSync(file, "utf8"))) : [];
  // Whisper makes up words in long silence at the end; drop anything after the last real speech.
  const last = (await speech(media, { noise: "-35dB", gap: 0.6 })).at(-1)?.[1] ?? 0;
  words = words.filter((x) => x.start < last + 0.1);
  if (words.length < 2) {
    console.warn("[goat] no speech found; captions will be off");
    return [];
  }
  return words;
}

// 2–4 words per caption, one line, breaking on pauses and after . ! ? …
export function groupCaptions(words, { maxWords = 4, minWords = 2, gap = 0.15, maxChars = 22, lead = 2 / FPS } = {}) {
  const len = (ws) => ws.map((x) => x.text).join(" ").length;
  const phrases = [];
  words.forEach((x, i) => {
    if (!i || x.start - words[i - 1].end >= gap || END.test(words[i - 1].text)) phrases.push([]);
    phrases.at(-1).push(x);
  });
  const groups = [];
  for (const p of phrases) {
    const chunks = [[]];
    for (const x of p) {
      const c = chunks.at(-1);
      if (c.length && (c.length >= maxWords || len([...c, x]) > maxChars)) chunks.push([x]);
      else c.push(x);
    }
    // don't leave one word alone at the end if the chunk before can spare one
    const [a, b] = chunks.slice(-2);
    if (b && b.length < minWords && a.length > minWords && len([a.at(-1), ...b]) <= maxChars) b.unshift(a.pop());
    groups.push(...chunks);
  }
  const out = groups.map((ws) => ({ text: ws.map((x) => x.text).join(" "), first: ws[0], last: ws.at(-1) }));
  out.forEach((g, i) => { g.start = Math.max(0, g.first.start - lead, i ? out[i - 1].last.end : 0); });
  return out.map((g, i) => {
    const next = out[i + 1];
    const end = next && next.start - g.last.end < 0.3 ? next.start : g.last.end;
    return { text: g.text, start: g.start, end };
  });
}

// Which parts of the source to keep: pauses ≥ 0.35 s shrink to a breath. A pause is only cut where
// ffmpeg also hears quiet (`speech` spans), because Whisper drops and invents words, and never
// inside a photo or a clip without sound (`protect`).
const minus = ([a, b], [c, d]) => [[a, Math.min(b, c)], [Math.max(a, d), b]].filter(([x, y]) => y > x);
export function silenceKeeps(words, dur, { protect = [], speech } = {}) {
  const cuts = [];
  if (words.length) {
    cuts.push([0, words[0].start - 0.22]);
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i].end, b = words[i + 1].start, pause = b - a;
      if (pause < 0.35) continue;
      const breath = pause >= 2 ? 0.24 : END.test(words[i].text) ? 0.2 : 0.14;
      cuts.push([a + 0.55 * breath, b - 0.45 * breath]);
    }
    cuts.push([words.at(-1).end + 0.34, dur]);
  }
  const heard = ([a, b]) => (speech ?? []).reduce((n, [c, d]) => n + Math.max(0, Math.min(b, d) - Math.max(a, c)), 0);
  const removed = cuts
    .filter(([a, b]) => b > a && heard([a, b]) <= 0.2 * (b - a))
    .flatMap((c) => protect.reduce((parts, p) => parts.flatMap((x) => minus(x, p)), [c]));
  const pieces = [];
  let s = 0;
  for (const [a, b] of removed) {
    if (a > s) pieces.push([s, a]);
    s = Math.max(s, b);
  }
  if (dur > s) pieces.push([s, dur]);
  // whole frames, so every join lands on the 30 fps grid; drop slivers under 0.04 s
  const kept = pieces.map(([a, b]) => [snap(a), snap(b)]).filter(([a, b]) => (b - a) / FPS >= 0.04);
  const keptSec = kept.reduce((n, [a, b]) => n + b - a, 0) / FPS;
  if (dur - keptSec > 0.6 * dur)
    throw new Error(`the pause cut would cut ${(dur - keptSec).toFixed(1)}s of ${dur.toFixed(1)}s, so the transcript is ` +
      'probably missing words. Fix transcript.json, or add "cut": false to plan.json.');
  let t = 0;
  return kept.map(([a, b]) => {
    const k = { sourceStart: a / FPS, sourceEnd: b / FPS, start: t / FPS, end: (t + b - a) / FPS };
    t += b - a;
    return k;
  });
}

export function retime(words, keeps) {
  const map = (t) => {
    for (const k of keeps) {
      if (t < k.sourceStart) return k.start; // inside a cut: jump to where the next piece starts
      if (t <= k.sourceEnd) return k.start + t - k.sourceStart;
    }
    return keeps.at(-1)?.end ?? t;
  };
  return words.map((x) => ({ ...x, start: map(x.start), end: map(x.end) }));
}

export async function applyCut(src, keeps, out) {
  const fl = keeps.flatMap((k, i) => {
    const d = k.sourceEnd - k.sourceStart;
    return [
      `[0:v]trim=start=${k.sourceStart}:end=${k.sourceEnd},setpts=PTS-STARTPTS[v${i}]`,
      // 10 ms fades so the joins don't click
      `[0:a]atrim=start=${k.sourceStart}:end=${k.sourceEnd},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=0.01,afade=t=out:st=${Math.max(0, d - 0.01)}:d=0.01[a${i}]`,
    ];
  });
  fl.push(keeps.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${keeps.length}:v=1:a=1[v][a]`);
  await ffmpeg(["-i", src, "-filter_complex", fl.join(";"), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "256k", out], "cut the pauses");
}
