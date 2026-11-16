// Shared media helpers for the GOAT look skills (Node, no npm packages).
// Every skill ships its own copy (build.py copies core/*.mjs into each skill's scripts/),
// so edit the file in core/, never a copy.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, basename, extname, dirname, join } from "node:path";

export const W = 1080, H = 1920, FPS = 30;
// Inside this box nothing is covered by Reels/TikTok buttons (Meta + TikTok guides combined).
// Prices, phone numbers and offers go here. Below y 840, keep left of x 780 (TikTok's side column).
export const SAFE = [120, 270, 960, 1248];
const STILL_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp"]);
const HDR_TRC = new Set(["smpte2084", "arib-std-b67"]);
const INSTALL = {
  ffmpeg: "Mac: brew install ffmpeg   Windows: winget install Gyan.FFmpeg",
  ffprobe: "Mac: brew install ffmpeg   Windows: winget install Gyan.FFmpeg",
  npx: "Install Node 22 or newer from nodejs.org",
};

export function die(msg) {
  console.error(`\n[goat] ${msg}`);
  process.exit(1);
}

// Always an argument array, never a shell string: paths can have spaces and Cyrillic.
export function run(cmd, args, { binary = false, ...opts } = {}) {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", (e) =>
      fail(new Error(e.code === "ENOENT" ? `${cmd} is not installed. ${INSTALL[cmd] ?? ""}` : e.message)));
    p.on("close", (code) => {
      const stdout = Buffer.concat(out);
      done({ code, stdout: binary ? stdout : stdout.toString(), stderr: Buffer.concat(err).toString() });
    });
  });
}

export async function ffmpeg(args, what) {
  const r = await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (r.code) throw new Error(`ffmpeg could not ${what}. Details: ${r.stderr.trim().slice(-800)}`);
  return r;
}

// A member's photo as an upright PNG at `out`, with its real size and pixel format (rgba/ya/pal8 when it can be
// see-through). probe reads a photo's size as stored, but a phone JPEG is often stored sideways with an EXIF turn that
// ffmpeg applies as it decodes, so the size comes from the PNG. ffmpeg reads an iPhone HEIC as its first 512 px tile, so
// macOS's sips turns it into a JPEG first (a sips PNG would lose the photo's turn; the JPEG keeps it, and HEIC photos
// from the camera have no see-through parts to lose). platform: for tests.
export async function photoPng(src, out, platform = process.platform) {
  const name = basename(src);
  const heic = /^\.hei[cf]$/i.test(extname(src));
  if (heic && platform !== "darwin") throw new Error(`${name} is a HEIC photo, which can't be read whole here: export it as JPEG or PNG and use that`);
  if (!existsSync(src)) throw new Error(`file not found: ${src}`);
  mkdirSync(dirname(out), { recursive: true });
  let from = src;
  if (heic) {
    from = `${out}.jpg`;
    const r = await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "100", src, "--out", from]);
    if (r.code || !existsSync(from)) throw new Error(`could not read ${name}: export it as JPEG or PNG and use that. ${r.stderr.trim().slice(-300)}`);
  }
  await ffmpeg(["-i", from, "-frames:v", "1", "-update", "1", out], `read the photo ${name}`);
  const r = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", out]);
  const s = r.code ? null : JSON.parse(r.stdout).streams?.[0];
  if (!s) throw new Error(`could not read ${name}: ${r.stderr.trim().slice(-300)}`);
  return { w: Number(s.width), h: Number(s.height), pix_fmt: s.pix_fmt };
}

export async function probe(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const r = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  if (r.code) throw new Error(`ffprobe could not read ${path}: ${r.stderr.trim().slice(0, 300)}`);
  const info = JSON.parse(r.stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  const fmtDur = Number(info.format.duration ?? 0);
  const audio = info.streams.some((s) => s.codec_type === "audio");
  if (!v) return { file: path, video: false, w: 0, h: 0, still: false, dur: fmtDur, fps: 0, audio: true, hdr: false };
  const still = STILL_EXT.has(extname(path).toLowerCase());
  let [w, h] = [Number(v.width), Number(v.height)];
  const rot = (v.side_data_list ?? []).reduce((r, sd) => Number(sd.rotation ?? r) || r, 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [w, h] = [h, w];
  const [num, den] = (v.avg_frame_rate || "0/1").split("/").map(Number);
  return {
    file: path, video: true, w, h, still,
    // the picture's own length: the container's can run ~20 ms longer for AAC padding
    dur: still ? 0 : Number(v.duration ?? fmtDur),
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
    audio, hdr: HDR_TRC.has(v.color_transfer),
  };
}

const frames = (s) => Math.round(s * FPS) / FPS;

// tag names a HEIC's upright PNG in <work>/photos/ (<tag>-<i>.png)
async function checkClips(plan, planDir, work, tag = "clip") {
  const out = [];
  for (const [i, c] of (plan.clips ?? []).entries()) {
    let src = resolve(planDir, c.src);
    const name = basename(src);
    // ffmpeg can't -loop an iPhone HEIC and reads only its first 512 px tile: photoPng reads it whole (sips)
    if (/^\.hei[cf]$/i.test(extname(src))) {
      const png = join(work, "photos", `${tag}-${i}.png`);
      await photoPng(src, png);
      src = png;
    }
    const info = await probe(src);
    if (!info.video) throw new Error(`clip ${i + 1} (${name}) is a sound file. Put it under "voiceover" or "music" instead.`);
    let start = 0, dur;
    if (info.still) dur = Number(c.dur ?? 2);
    else {
      start = Number(c.in ?? 0);
      const end = Number(c.out ?? info.dur);
      if (end > info.dur + 0.05)
        throw new Error(`clip ${i + 1} (${name}) ends at ${end}s but the file is only ${info.dur.toFixed(2)}s long`);
      dur = end - start;
    }
    dur = frames(dur);
    if (dur <= 0.05) throw new Error(`clip ${i + 1} (${name}) has no length: check in/out`);
    if (info.hdr)
      console.warn(`[goat] warning: ${name} is HDR. Colours may look grey or too bright. ` +
        "On iPhone turn off Settings > Camera > Record Video > HDR Video for the next shoot.");
    out.push({ ...c, path: src, info, start, dur });
  }
  if (!out.length) throw new Error("the plan has no clips");
  return out;
}

const even = (n) => Math.round(Number(n) / 2) * 2;

// One input's args and its filter chain: cover-crop to size at cx/cy, 30 fps, the look's own grade,
// cut to length, optionally held on the last frame for `pad` more seconds. An "in" off the frame grid makes fps start
// at frame 1, so setpts restarts the picture at 0 (and asetpts the sound): otherwise concat pads a frame of silence
// per such clip and the sound drifts behind the cuts.
async function clipChain(c, [w, h], look, ctx, index, pad = 0) {
  const t = c.dur.toFixed(3);
  const args = c.info.still ? ["-loop", "1", "-framerate", String(FPS), "-t", t, "-i", c.path]
    : ["-ss", c.start.toFixed(3), "-t", t, "-i", c.path];
  const cx = Number(c.cx ?? 0.5), cy = Number(c.cy ?? 0.5);
  const grade = look.clipFilter ? await look.clipFilter({ index, path: c.path, info: c.info, start: c.start, dur: c.dur,
    still: c.info.still }, ctx) : "";
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${w}:${h}:(iw-${w})*${cx}:(ih-${h})*${cy},setsar=1,fps=${FPS},${grade ? grade + "," : ""}` +
    `trim=duration=${t},setpts=PTS-STARTPTS,${pad > 0 ? `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},` : ""}format=yuv420p`;
  return { args, vf };
}

const VIDEO_OUT = ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

// Trim, cover-crop to the look's FIT (default 1080x1920) at each clip's cx/cy, 30 fps, join. Photos and
// clips without sound (or with "sound": false) get silence, so the joined file always has a stereo track.
// A look may also set EXTRA / PER_CLIP (more files in <work>/media/).
export async function prep(plan, planDir, outPath, look = {}) {
  const ctx = { plan, planDir, run };
  if (!plan.clips?.length && look.BLANK) {
    const { dur, color } = look.BLANK(plan);
    await ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=${FPS}:d=${dur}`,
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-t", String(dur), "-c:v", "libx264", "-preset", "medium",
      "-crf", "14", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-c:a", "aac", "-b:a", "256k", outPath], "make the blank video");
    return { dur: frames(dur), cuts: [0], silent: [[0, frames(dur)]], clips: [] };
  }
  const work = dirname(outPath);
  const clips = await checkClips(plan, planDir, work);
  const fit = (typeof look.FIT === "function" ? look.FIT(plan) : look.FIT ?? [W, H]).map(even);
  const args = [], fl = [];
  for (const [i, c] of clips.entries()) {
    const t = c.dur.toFixed(3);
    const k = await clipChain(c, fit, look, ctx, i);
    args.push(...k.args);
    fl.push(`[${i}:v]${k.vf}[v${i}]`);
    // 10 ms fades so a join cut mid-waveform doesn't click (as applyCut does)
    fl.push(c.info.audio && !c.info.still && c.sound !== false
      ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${t},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=0.01,afade=t=out:st=${(c.dur - 0.01).toFixed(3)}:d=0.01[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${t}[a${i}]`);
  }
  fl.push(clips.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${clips.length}:v=1:a=1[v][a]`);
  await ffmpeg([...args, "-filter_complex", fl.join(";"), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "256k", outPath], "join the clips");
  const cuts = [], silent = [], out = [];
  let acc = 0;
  for (const c of clips) {
    cuts.push(frames(acc));
    out.push({ start: frames(acc), dur: c.dur, still: c.info.still });
    // photos and clips without sound carry no speech: the pause cut keeps them whole
    if (c.info.still || !c.info.audio || c.sound === false) silent.push([frames(acc), frames(acc + c.dur)]);
    acc += c.dur;
  }
  const total = frames(acc);

  // video-only side files: hold = pad with the last frame up to the main video's length
  const media = join(work, "media");
  const side = async (name, c, size, hold, index) => {
    mkdirSync(media, { recursive: true });
    const k = await clipChain(c, size, look, ctx, index, hold ? total - c.dur : 0);
    await ffmpeg([...k.args, "-vf", k.vf, ...VIDEO_OUT, join(media, `${name}.mp4`)], `make ${name}.mp4`);
  };
  for (const x of look.EXTRA ? look.EXTRA(plan) : []) {
    const [c] = await checkClips({ clips: [x.clip] }, planDir, work, x.name);
    await side(x.name, c, x.fit.map(even), x.hold, 0);
  }
  if (look.PER_CLIP) for (const [i, c] of clips.entries()) await side(`clip-${i}`, c, fit, true, i);
  return { dur: total, cuts, silent, clips: out };
}

// One frame per second, 270 px wide, 6 per row: a quick look at a whole render.
export async function sheet(video, outJpg) {
  const { dur } = await probe(video);
  const rows = Math.ceil(Math.max(1, Math.ceil(dur)) / 6);
  await ffmpeg(["-i", video, "-vf", `fps=1,scale=270:-2,tile=6x${rows}`, "-frames:v", "1", "-update", "1",
    "-q:v", "3", outJpg], "make the contact sheet");
}

// Spans where someone is talking. Quiet is measured against the clip's own sound: on a 30 ms loudness envelope
// (leaving out the exact silence of photos), the 10th percentile is the room and the 95th the speaker. Quiet is under
// 6 dB above the room or 25 dB below the speaker, whichever is higher (so a breath in a quiet room is quiet), but
// below halfway between them (so a sound with no pauses stays talking), for `gap` s or more. A fixed −32 dB heard no
// pause at all in an office whose noise peaks at −27 dBFS (Saagii's day-one clip).
export async function speech(path, { gap = 0.35 } = {}) {
  const r = await run("ffmpeg", ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { binary: true });
  if (r.code) throw new Error(`ffmpeg could not read the sound of ${path}: ${r.stderr.trim().slice(-300)}`);
  const x = new Float32Array(new Uint8Array(r.stdout).buffer), env = [];
  for (let i = 0; i + 480 <= x.length; i += 160) { // 30 ms windows, every 10 ms
    let e = 0;
    for (let j = i; j < i + 480; j++) e += x[j] * x[j];
    env.push(10 * Math.log10(e / 480 + 1e-10));
  }
  const sorted = env.filter((v) => v > -90).sort((a, b) => a - b), at = (q) => sorted[Math.floor(q * (sorted.length - 1))];
  if (!sorted.length) return [];
  const room = at(0.1), loud = at(0.95), quiet = Math.min(Math.max(room + 6, loud - 25), (room + loud) / 2);
  const total = x.length / 16000, round = (t) => Math.round(t * 100) / 100;
  const spans = [];
  let cur = 0, q = null;
  for (let k = 0; k <= env.length; k++) {
    if (k < env.length && env[k] < quiet) { q ??= k; continue; }
    if (q !== null && (k - q) / 100 >= gap) { // a quiet run: the middle 10 ms of windows q..k-1
      if (q / 100 + 0.01 - cur > 0.15) spans.push([round(cur), round(q / 100 + 0.01)]);
      cur = k < env.length ? k / 100 + 0.01 : total;
    }
    q = null;
  }
  if (total - cur > 0.15) spans.push([round(cur), round(total)]);
  return spans;
}
