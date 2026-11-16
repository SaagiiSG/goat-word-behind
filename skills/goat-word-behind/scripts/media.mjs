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
const STILL_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp"]);
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

async function checkClips(plan, planDir) {
  const out = [];
  for (const [i, c] of (plan.clips ?? []).entries()) {
    const src = resolve(planDir, c.src);
    const info = await probe(src);
    const name = basename(src);
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
// cut to length, optionally held on the last frame for `pad` more seconds.
async function clipChain(c, [w, h], look, ctx, index, pad = 0) {
  const t = c.dur.toFixed(3);
  const args = c.info.still ? ["-loop", "1", "-framerate", String(FPS), "-t", t, "-i", c.path]
    : ["-ss", c.start.toFixed(3), "-t", t, "-i", c.path];
  const cx = Number(c.cx ?? 0.5), cy = Number(c.cy ?? 0.5);
  const grade = look.clipFilter ? await look.clipFilter({ index, path: c.path, info: c.info, start: c.start, dur: c.dur,
    still: c.info.still }, ctx) : "";
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${w}:${h}:(iw-${w})*${cx}:(ih-${h})*${cy},setsar=1,fps=${FPS},${grade ? grade + "," : ""}` +
    `trim=duration=${t},${pad > 0 ? `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},` : ""}format=yuv420p`;
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
  const clips = await checkClips(plan, planDir);
  const fit = (typeof look.FIT === "function" ? look.FIT(plan) : look.FIT ?? [W, H]).map(even);
  const args = [], fl = [];
  for (const [i, c] of clips.entries()) {
    const t = c.dur.toFixed(3);
    const k = await clipChain(c, fit, look, ctx, i);
    args.push(...k.args);
    fl.push(`[${i}:v]${k.vf}[v${i}]`);
    fl.push(c.info.audio && !c.info.still && c.sound !== false
      ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${t}[a${i}]`
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
  const media = join(dirname(outPath), "media");
  const side = async (name, c, size, hold, index) => {
    mkdirSync(media, { recursive: true });
    const k = await clipChain(c, size, look, ctx, index, hold ? total - c.dur : 0);
    await ffmpeg([...k.args, "-vf", k.vf, ...VIDEO_OUT, join(media, `${name}.mp4`)], `make ${name}.mp4`);
  };
  for (const x of look.EXTRA ? look.EXTRA(plan) : []) {
    const [c] = await checkClips({ clips: [x.clip] }, planDir);
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

// Spans where someone is talking, from ffmpeg silencedetect. Good enough to time text to phrases.
export async function speech(path, { noise = "-32dB", gap = 0.35 } = {}) {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-vn", "-af",
    `silencedetect=noise=${noise}:d=${gap}`, "-f", "null", "-"]);
  const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const total = (await probe(path)).dur;
  const round = (x) => Math.round(x * 100) / 100;
  const spans = [];
  let cur = 0;
  starts.forEach((s, i) => {
    if (s - cur > 0.15) spans.push([round(cur), round(s)]);
    cur = ends[i] ?? total;
  });
  if (total - cur > 0.15) spans.push([round(cur), round(total)]);
  return spans;
}
