// The sharp person cut-out: MODNet (Apache-2.0, https://github.com/ZHKKKe/MODNet) at 512x896 on the CPU, through
// HyperFrames' own onnxruntime-node, plus three clean-ups: keep only the person's islands, hold the last good matte
// over a frame that loses him, and MODNet's one-frame delay against flicker. cutout.mjs falls back to HyperFrames'
// remove-background if this throws.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { W, H, FPS } from "./media.mjs";

// the version HyperFrames 0.9.46 pins (OPTIONAL_PACKAGES in its optionalPackages); re-check it when HF_VERSION moves
const ORT = "onnxruntime-node@1.21.1";
const MODEL = {
  url: "https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx",
  sha256: "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
  file: "modnet-fa2fa54.onnx",
};
const MW = 512, MH = 896, P = MW * MH; // MODNet's size: at 768x1344 it shows ghost patches of the background
// an 8x8 grey PNG: remove-background on it makes HyperFrames install onnxruntime-node the way it always does
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFElEQVR4nGOsq6tjwAZYsIoOWgkAMOsBmCeKfNQAAAAASUVORK5CYII=";
const hfCache = () =>
  process.env.HYPERFRAMES_CACHE_DIR ? resolve(process.env.HYPERFRAMES_CACHE_DIR) : join(homedir(), ".cache", "hyperframes");
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(-300);

// HyperFrames' copy of onnxruntime-node, from the folder it installs it in. Missing (HyperFrames never cut anyone
// out on this computer): a one-pixel remove-background has HyperFrames install it, with its own model.
export async function loadOrt(hf, cache = hfCache()) {
  const dir = join(cache, "optional", ORT), pkg = join(dir, "node_modules", "onnxruntime-node", "package.json");
  if (!existsSync(pkg)) {
    console.log("[goat] HyperFrames is installing its model runtime and backup cut-out model, once (about 280 MB with ours)…");
    const tmp = mkdtempSync(join(tmpdir(), "goat-ort-"));
    try {
      writeFileSync(join(tmp, "px.png"), Buffer.from(PIXEL, "base64"));
      const r = await hf(["remove-background", join(tmp, "px.png"), "-o", join(tmp, "out.png"), "--device", "cpu"]);
      if (!existsSync(pkg)) // the runtime is what we need: a later failure (its own model's download) doesn't matter
        throw new Error(`HyperFrames could not install onnxruntime-node (${oneLine(r.stdout + r.stderr) || `nothing in ${dir}`})`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return createRequire(join(dir, "package.json"))("onnxruntime-node");
}

// The pinned MODNet ONNX file in ~/.cache/goat-editing, downloaded once and checked against its sha256. A download
// that sends nothing for `stall` ms is dropped, so a dead connection reaches the fallback; a slow one that keeps
// coming is not (a total cap would cut off slow but healthy connections).
export async function modelFile(dir = join(homedir(), ".cache", "goat-editing"), get = fetch, stall = 60000) {
  const file = join(dir, MODEL.file);
  if (existsSync(file)) return file;
  const ac = new AbortController();
  let timer, data;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`the cut-out model download stalled for ${stall / 1000} s`)), stall);
  };
  try {
    alive();
    const r = await get(MODEL.url, { signal: ac.signal });
    if (!r.ok) throw new Error(`the cut-out model download failed (HTTP ${r.status})`);
    const parts = [];
    for await (const chunk of r.body) { parts.push(chunk); alive(); }
    data = Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
  }
  if (createHash("sha256").update(data).digest("hex") !== MODEL.sha256)
    throw new Error("the downloaded cut-out model is not the expected file (sha256 mismatch)");
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

// Keep the person: of the matte's islands (alpha > T, 4-way), keep the biggest, any at least `share` of its size (a
// second person, a hand held clear of the body), and any on the bottom edge at least `floor` of the frame (a desk the
// model takes in on some frames: kept on all, so it doesn't blink under a look's dim). Zero the rest: wall and pillar
// patches (Odko's pillar strip peaks at 5% of her) and specks along the bottom edge. In place.
export function keepPerson(g, w, h, T = 12, share = 0.15, floor = 0.005) {
  const P = w * h, label = new Int32Array(P), stack = new Int32Array(P), area = [0], edge = [false];
  let sp = 0, id = 0;
  const visit = (j) => { if (!label[j] && g[j] > T) { label[j] = id; stack[sp++] = j; } };
  for (let s = 0; s < P; s++) {
    if (label[s] || g[s] <= T) continue;
    id = area.length;
    let n = 0, low = false;
    visit(s);
    while (sp) {
      const i = stack[--sp], x = i % w;
      n++;
      if (i >= w) visit(i - w);
      if (i < P - w) visit(i + w);
      else low = true;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
    }
    area.push(n);
    edge.push(low);
  }
  const min = share * area.reduce((a, b) => Math.max(a, b));
  const keep = area.map((a, l) => a >= min || (edge[l] && a >= floor * P));
  for (let i = 0; i < P; i++) if (!keep[label[i]]) g[i] = 0;
  return g;
}

// A frame whose matte (pixels above T) shrinks below `drop` of the median of the last `n` frames lost the person
// (MODNet missed him, or the clean-up kept the wrong island): it goes out as the last good matte instead. The median
// counts the real sizes, so someone who really leaves is followed within n/2 frames.
export async function* holdCollapsed(frames, n = 15, drop = 0.4, T = 12) {
  const sizes = [];
  let good;
  for await (const g of frames) {
    let size = 0;
    for (let i = 0; i < g.length; i++) if (g[i] > T) size++;
    const median = sizes.length ? [...sizes].sort((a, b) => a - b)[sizes.length >> 1] : 0;
    if (good && size < drop * median) yield good;
    else yield (good = g);
    sizes.push(size);
    if (sizes.length > n) sizes.shift();
  }
}

// MODNet's one-frame delay over a stream of mattes: a pixel that jumps on one frame while the frames either side
// agree (within 40) takes their mean. Each matte goes out one frame late; the first and last go out as they are.
export async function* steady(frames) {
  let a, b;
  for await (const c of frames) {
    if (b) yield a ? oneFrameDelay(a, b, c) : b;
    [a, b] = [b, c];
  }
  if (b) yield b;
}

function oneFrameDelay(p, c, n) {
  const out = Buffer.from(c);
  for (let i = 0; i < c.length; i++)
    if (Math.abs(p[i] - n[i]) <= 40 && Math.abs(c[i] - p[i]) > 40 && Math.abs(c[i] - n[i]) > 40) out[i] = (p[i] + n[i]) >> 1;
  return out;
}

// Write the cut-out of cut.mp4 (1080x1920, 30 fps) to out: VP9 with alpha, the same file remove-background makes.
// ffmpeg shrinks each frame to MODNet's size, the matte comes back, and ffmpeg scales it up and alphamerges it onto
// cut.mp4's own pixels (no RGB round trip). Throws on any failure; cutout.mjs then uses HyperFrames' cut-out.
// `ort` and `session` can be passed in (tests use a fake session); otherwise HyperFrames' runtime and the pinned model.
export async function modnetCutOut(cut, out, { hf, ort, session }) {
  ort ??= await loadOrt(hf);
  session ??= await ort.InferenceSession.create(await modelFile(), { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
  const dec = ffmpeg(["-i", cut, "-vf", `scale=${MW}:${MH}:flags=bicubic`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], ["ignore", "pipe", "pipe"]);
  const enc = ffmpeg(["-y", "-i", cut, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${MW}x${MH}`, "-r", String(FPS), "-i", "-",
    "-filter_complex", `[1]scale=${W}:${H}:flags=bicubic[a];[0:v][a]alphamerge,format=yuva420p`,
    // remove-background's --quality best settings
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "12", "-deadline", "good", "-row-mt", "1", "-cpu-used", "4", "-auto-alt-ref", "0",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-metadata:s:v:0", "alpha_mode=1", "-an", out], ["pipe", "ignore", "pipe"]);
  try {
    await pipeline(dec.stdout, (frames) => steady(holdCollapsed(mattes(frames, ort, session))), enc.stdin);
    await Promise.all([dec.done, enc.done]);
  } catch (e) {
    dec.kill("SIGKILL"); // no-op once it has ended
    enc.kill("SIGKILL");
    await Promise.allSettled([dec.done, enc.done]); // closed before the caller deletes the half-written file (Windows)
    throw new Error([e.message, oneLine(dec.err + enc.err)].filter(Boolean).join("; "));
  } finally {
    await session.release();
  }
}

// rgb24 frames at MODNet's size in, gray mattes (0..255, islands dropped) out
async function* mattes(frames, ort, session) {
  const rgb = Buffer.alloc(P * 3), input = new Float32Array(P * 3);
  let filled = 0;
  for await (const chunk of frames) {
    for (let at = 0; at < chunk.length; ) {
      const n = chunk.copy(rgb, filled, at);
      filled += n;
      at += n;
      if (filled < rgb.length) continue;
      filled = 0;
      for (let i = 0; i < P; i++) for (let c = 0; c < 3; c++) input[c * P + i] = rgb[i * 3 + c] / 127.5 - 1; // (x/255 - 0.5) / 0.5
      const o = (await session.run({ input: new ort.Tensor("float32", input, [1, 3, MH, MW]) })).output.data;
      const g = Buffer.alloc(P);
      for (let i = 0; i < P; i++) g[i] = Math.min(255, Math.max(0, Math.round(o[i] * 255)));
      yield keepPerson(g, MW, MH);
    }
  }
}

// ffmpeg with argument arrays (no shell), its stderr kept and its exit as a promise
function ffmpeg(args, stdio) {
  const p = spawn("ffmpeg", ["-v", "error", ...args], { stdio });
  p.err = "";
  p.stderr.on("data", (d) => (p.err += d));
  p.done = new Promise((ok, fail) => {
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg stopped (${code ?? "killed"})`))));
  });
  p.done.catch(() => {}); // awaited in modnetCutOut; an early exit must not crash the process
  return p;
}
