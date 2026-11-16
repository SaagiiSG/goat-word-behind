// The sharp person cut-out: MODNet (Apache-2.0, https://github.com/ZHKKKe/MODNet) at 512x896 on the CPU, through
// HyperFrames' own onnxruntime-node, plus two clean-ups: keep only what joins the body at the bottom edge, and
// MODNet's one-frame delay against flicker. cutout.mjs falls back to HyperFrames' remove-background if this throws.
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

// Zero every matte pixel not joined (alpha > T, 4-way) to the bottom edge, where a talking head's body is: drops wall
// and pillar patches the model takes for a person. If nothing touches the bottom, the matte stays as it is. In place.
export function keepBottomConnected(g, w, h, T = 12) {
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  for (let x = 0; x < w; x++) { const i = (h - 1) * w + x; if (g[i] > T) { seen[i] = 1; stack[sp++] = i; } }
  if (!sp) return g;
  while (sp) {
    const i = stack[--sp], x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
      if (j >= 0 && j < w * h && !seen[j] && g[j] > T) { seen[j] = 1; stack[sp++] = j; }
  }
  for (let i = 0; i < w * h; i++) if (!seen[i]) g[i] = 0;
  return g;
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
    await pipeline(dec.stdout, (frames) => steady(mattes(frames, ort, session)), enc.stdin);
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
      yield keepBottomConnected(g, MW, MH);
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
