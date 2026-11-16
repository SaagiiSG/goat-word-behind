// Words: Whisper transcript, caption groups, silence cutting.
// Caption, pacing and silence rules adapted from Nate Herk's herk-edit-kit (MIT, © 2026 Nate Herk).
import { readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { FPS, ffmpeg, run, speech } from "./media.mjs";
import { hf } from "./hf.mjs";

const END = /[.!?…]$/;
const snap = (x) => Math.round(x * FPS);

export function parseTranscript(json) {
  const list = Array.isArray(json) ? json : json?.words ?? [];
  return list
    // "star": true marks the word a look shows in its accent font (Glass Ribbon); nothing else is kept
    .map((x) => ({ text: String(x.text ?? "").trim(), start: Number(x.start), end: Number(x.end),
      ...(x.star === true && { star: true }) }))
    .filter((x) => x.text && x.text !== "♪" && !/^[[(].*[\])]$/.test(x.text));
}

// large-v3-turbo: on an 8 GB M3, 4 s and 1.9 GB for a 6.5 s clip, against 15 s and 4 GB for large-v3,
// with Mongolian as good (14 Nov test). medium mixes in Kazakh letters and loops; small is unusable.
export const WHISPER_MODEL = "large-v3-turbo";

// language: Whisper's code for what the speaker speaks ("language" in plan.json); checked because it goes on a command line
const checkLanguage = (language) => {
  if (!/^[a-z]{2,3}$/.test(language))
    throw new Error(`"language" must be a language code like "mn" or "en", not ${JSON.stringify(language)}`);
};
export function whisperArgs(media, workDir, language = "mn") {
  checkLanguage(language);
  return ["transcribe", media, "-d", workDir, "--engine", "whisper", "--model", WHISPER_MODEL, "--language", language, "--json"];
}

// HyperFrames' cache folder (HYPERFRAMES_CACHE_DIR if set), with the model file it downloads and checks.
const cacheDir = (...parts) => join(process.env.HYPERFRAMES_CACHE_DIR ? resolve(process.env.HYPERFRAMES_CACHE_DIR) :
  join(homedir(), ".cache", "hyperframes"), ...parts);
const modelFile = () => cacheDir("whisper", "models", `ggml-${WHISPER_MODEL}.bin`);

// Where HyperFrames looks for whisper-cli, in its order: HYPERFRAMES_WHISPER_PATH, PATH, Homebrew, its own build.
export function whisperPlaces() {
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli", build = cacheDir("whisper", "whisper.cpp", "build");
  return [process.env.HYPERFRAMES_WHISPER_PATH, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, exe)),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"] : []),
    join(build, "bin", "Release", exe), join(build, "bin", exe), join(build, exe)].filter(Boolean);
}

// HyperFrames' time limit for a large-v3-turbo run: 20 s per second of sound, at least 5 minutes.
export const whisperTimeout = (seconds) => Math.max(300, Math.ceil(20 * seconds)) * 1000;

// whisper-cli as HyperFrames runs it, plus DTW token times (which need flash attention off).
export function dtwArgs(wav, outBase, language) {
  checkLanguage(language);
  return ["--model", modelFile(), "--output-json-full", "--output-file", outBase, "--suppress-nst", "--language", language,
    "--dtw", WHISPER_MODEL.replaceAll("-", "."), "-nfa", wav];
}

// whisper.cpp's JSON into words timed by DTW, or null if it has no DTW times. A token without a leading space
// continues the word before it, unless a bare " " or a [_…] token came between (whisper.cpp sends " " before
// letters it can't join to a space). DTW lands 0.04–0.24 s after the sound starts (0.14 s in the middle, on 12 words
// after a pause in Saagii's clip), so each start moves 0.15 s earlier.
export function dtwWords(json) {
  const words = [];
  let gap = true;
  for (const t of (json.transcription ?? []).flatMap((s) => s.tokens ?? [])) {
    const raw = t.text ?? "", text = raw.trim();
    if (!text || text.startsWith("[_") || text.startsWith("[BLANK")) { gap = true; continue; }
    if (!gap && !raw.startsWith(" ")) words.at(-1).text += text;
    else words.push({ text, start: t.t_dtw < 0 ? NaN : Math.max(0, (t.t_dtw * 10 - 150) / 1000) });
    gap = false;
  }
  return words.length && words.every((x) => x.start >= 0) ? words : null;
}

// HyperFrames' words with DTW start times. Flash attention off (which DTW needs) can hear an unsure word differently,
// so the words both runs heard alike (the longest common run of them) take the DTW start, and the words between
// those share, by length, the time from the first DTW word heard there to the next shared word. Throws if under a
// third are alike (the DTW run heard something else). A word ends at the next word, or sooner where its sound stops
// (`spans`, from speech()), so real pauses show as gaps, and at most 1.5 s after it starts (music after the last word).
export function dtwTimes(words, dtw, spans) {
  const norm = (x) => x.text.toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
  const a = words.map(norm), b = dtw.map(norm), n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  if (pairs.length < n / 3) throw new Error(`the DTW run heard too few of the same words (${pairs.length} of ${n})`);
  const soundEnd = (t) => spans.find(([, e]) => e > t)?.[1] ?? t + 0.5;
  const start = [];
  let i0 = 0, j0 = 0;
  for (const [i1, j1] of [...pairs, [n, m]]) {
    if (i0 < i1) {
      // no DTW word here: share the previous shared word's time (or, at the very start, use HyperFrames' own)
      const shared = j0 === j1 && i0 > 0;
      const t0 = j0 < j1 ? dtw[j0].start : shared ? start[i0 - 1] : Math.min(words[i0].start, dtw[j1]?.start ?? Infinity);
      const t1 = j1 < m ? dtw[j1].start : soundEnd(dtw[m - 1].start);
      const len = words.slice(shared ? i0 - 1 : i0, i1).map((x) => x.text.length);
      const total = len.reduce((x, y) => x + y, 0);
      let at = shared ? len[0] : 0;
      for (let i = i0; i < i1; i++, at += words[i - 1].text.length) start[i] = t0 + ((t1 - t0) * at) / total;
    }
    if (i1 < n) start[i1] = dtw[j1].start;
    [i0, j0] = [i1 + 1, j1 + 1];
  }
  return words.map((x, i) => ({ ...x, start: start[i], end: Math.min(start[i + 1] ?? Infinity, soundEnd(start[i]), start[i] + 1.5) }));
}

// A second Whisper run, straight through whisper-cli (the one HyperFrames uses), for the DTW times.
// Its sound file and JSON are removed afterwards.
export async function dtwTranscribe(media, workDir, language) {
  const wav = join(workDir, "speech-16k.wav"), json = join(workDir, "whisper-dtw.json");
  try {
    await ffmpeg(["-i", media, "-vn", "-ar", "16000", "-ac", "1", "-f", "wav", wav], "take the sound for Whisper");
    rmSync(json, { force: true }); // whisper-cli exits 0 on a flag it doesn't know, writing nothing
    const bin = whisperPlaces().find((p) => existsSync(p)) ?? "whisper-cli";
    const r = await run(bin, dtwArgs(wav, json.slice(0, -5), language), { timeout: whisperTimeout(statSync(wav).size / 32000) });
    if (r.code !== 0 || !existsSync(json))
      throw new Error(`whisper-cli ${r.code === null ? "was stopped (too slow, or it crashed)" : "wrote no transcript"}: ` +
        r.stderr.trim().split("\n").slice(-2).join(" "));
    const words = dtwWords(JSON.parse(readFileSync(json, "utf8")));
    if (!words) throw new Error("whisper-cli gave no DTW times");
    return words;
  } finally {
    for (const f of [wav, json]) rmSync(f, { force: true });
  }
}

export async function transcribe(media, workDir, language = "mn") {
  const r = await hf(whisperArgs(media, workDir, language));
  const res = JSON.parse(r.stdout.trim().split("\n").at(-1) || "{}");
  if (!res.ok) throw new Error(`Whisper could not transcribe ${media}: ${res.error?.message ?? r.stderr.slice(-500)}`);
  const file = res.transcriptPath ?? join(workDir, "transcript.json");
  let words = existsSync(file) ? parseTranscript(JSON.parse(readFileSync(file, "utf8"))) : [];
  // Whisper makes up words in long silence at the end; drop anything after the last real speech, on HyperFrames'
  // own times (re-timing would squeeze them into the last words)
  const spans = await speech(media);
  const last = spans.at(-1)?.[1] ?? 0;
  words = words.filter((x) => x.start < last + 0.1);
  // HyperFrames' word times run early (0.37 s on average, 1.8 s after a pause), so captions came before the voice
  if (words.length >= 2) {
    words = await dtwTranscribe(media, workDir, language).then((dtw) => dtwTimes(words, dtw, spans)).catch((e) => {
      console.warn(`[goat] keeping HyperFrames' rougher word times: ${e.message}`);
      return words;
    });
  }
  if (words.length < 2) {
    console.warn("[goat] no speech found; captions will be off");
    return [];
  }
  return words;
}

// 2–4 words per caption, one line, breaking on pauses and after . ! ? …, and before a second starred word.
// A caption with a starred word gets `star`: that word's place in it (0 = the first word).
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
      if (c.length && (c.length >= maxWords || len([...c, x]) > maxChars || (x.star && c.some((y) => y.star)))) chunks.push([x]);
      else c.push(x);
    }
    // don't leave one word alone at the end if the chunk before can spare one
    const [a, b] = chunks.slice(-2);
    if (b && b.length < minWords && a.length > minWords && len([a.at(-1), ...b]) <= maxChars &&
        !(a.at(-1).star && b.some((y) => y.star))) b.unshift(a.pop());
    groups.push(...chunks);
  }
  const out = groups.map((ws) => ({ text: ws.map((x) => x.text).join(" "), first: ws[0], last: ws.at(-1),
    star: ws.findIndex((x) => x.star) }));
  out.forEach((g, i) => { g.start = Math.max(0, g.first.start - lead, i ? out[i - 1].last.end : 0); });
  return out.map((g, i) => {
    const next = out[i + 1];
    const end = next && next.start - g.last.end < 0.3 ? next.start : g.last.end;
    return { text: g.text, start: g.start, end, ...(g.star >= 0 && { star: g.star }) };
  });
}

// Which parts of the source to keep: pauses ≥ 0.35 s shrink to a breath. A pause is only cut where
// ffmpeg also hears quiet (`speech` spans, each kept with 0.1 s around it), because Whisper drops and
// invents words and a word's time can be late, and never inside a photo or a clip without sound (`protect`).
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
  const keep = [...(speech ?? []).map(([a, b]) => [a - 0.1, b + 0.1]), ...protect];
  const removed = cuts
    .filter(([a, b]) => b > a)
    .flatMap((c) => keep.reduce((parts, p) => parts.flatMap((x) => minus(x, p)), [c]));
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
