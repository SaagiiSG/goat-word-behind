// Sound: the video's own sound + voice-over (ducks the rest) + music, brought to -14 LUFS,
// then the look's sound effects at fixed levels, then a limiter.
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { run, ffmpeg, probe } from "./media.mjs";

export const SOUNDS = ["boom", "click", "ding", "hit", "marker", "notify", "paper", "pop", "projector",
  "riser", "shimmer", "shutter", "swish", "tape", "thud", "tick", "type", "whoosh"];

const LOOPED = ["type", "marker", "projector"], FILE_SEC = 4, RISER_SEC = 1.5;

export function checkEvents(events) {
  for (const e of events)
    if (!SOUNDS.includes(e.sound)) throw new Error(`unknown sound "${e.sound}". Choose from: ${SOUNDS.join(", ")}`);
}

// Integrated loudness and true peak, as Reels/TikTok measure them.
export async function loudness(path) {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const num = (re) => {
    const m = [...r.stderr.matchAll(re)].at(-1)?.[1];
    return m === undefined ? -70 : m === "-inf" ? -Infinity : Number(m);
  };
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/g), peak: num(/Peak:\s+(-inf|-?[\d.]+) dBFS/g) };
}

export async function mixSound({ bed, total, voiceover, music, events = [], gain = 1, sfxDir, out, planDir }) {
  const T = total.toFixed(3);
  const args = ["-i", bed], fl = [`[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${T}[clipsnd]`];
  const mix = [];
  let n = 1;
  if (voiceover) {
    const v = typeof voiceover === "object" ? voiceover : { src: voiceover };
    const vp = resolve(planDir, v.src);
    const at = Number(v.at ?? 0), { dur } = await probe(vp);
    if (at + dur > total + 0.2)
      console.warn(`[goat] warning: the voice-over runs to ${(at + dur).toFixed(1)}s but the video ends at ` +
        `${total.toFixed(1)}s, so its end is cut off. Add or lengthen clips.`);
    const ms = Math.round(at * 1000);
    args.push("-i", vp);
    fl.push(`[${n++}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${Number(v.volume ?? 1)},` +
      `adelay=${ms}|${ms},apad,atrim=0:${T},asplit=3[vo][vokey1][vokey2]`);
    // duck the video's own sound under the voice-over
    fl.push("[clipsnd][vokey1]sidechaincompress=threshold=0.02:ratio=12:attack=15:release=400[clipduck]");
    mix.push("[vo]", "[clipduck]");
  } else {
    fl.push("[clipsnd]anull[clipduck]");
    mix.push("[clipduck]");
  }
  if (music) {
    const m = typeof music === "object" ? music : { src: music };
    const mp = resolve(planDir, m.src);
    if (!existsSync(mp)) throw new Error(`music file not found: ${mp}`);
    args.push("-stream_loop", "-1", "-i", mp);
    fl.push(`[${n++}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${Number(m.volume ?? 0.25)},` +
      `atrim=0:${T},afade=t=out:st=${Math.max(0, total - 1).toFixed(3)}:d=1[mus]`);
    if (voiceover) {
      fl.push("[mus][vokey2]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=500[musduck]");
      mix.push("[musduck]");
    } else mix.push("[mus]");
  } else if (voiceover) fl.push("[vokey2]anullsink");
  fl.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0[bed]` : `${mix[0]}anull[bed]`);

  // 1) the "bed": video sound + voice-over + music, without sound effects
  const bedWav = join(dirname(out), "bed.wav");
  await ffmpeg([...args, "-filter_complex", fl.join(";"), "-map", "[bed]", "-c:a", "pcm_f32le", bedWav], "mix the sound");

  // 2) bring the bed to -14 LUFS. A silent bed stays silent, so effects on silent footage keep their own level.
  const { lufs } = await loudness(bedWav);
  const gainDb = lufs > -60 ? Math.min(30, -14 - lufs) : 0;

  // 3) sound effects at fixed levels on top, then a limiter so nothing clips; 0.75 (-2.5 dB) leaves room
  //    for the ~0.5 dB that AAC encoding adds to peaks, so the posted file stays under -1.5 dBTP
  checkEvents(events);
  const fx = events.filter((e) => Number(e.at) >= 0 && Number(e.at) < total);
  const a2 = ["-i", bedWav], f2 = [`[0:a]volume=${gainDb.toFixed(2)}dB[b]`];
  fx.forEach((e, i) => {
    let at = Number(e.at), dur = e.dur ? Number(e.dur) : 0, pre = "";
    if (dur && LOOPED.includes(e.sound) && dur > FILE_SEC) pre = `aloop=loop=-1:size=${FILE_SEC * 48000 + 1000},`;
    if (dur && e.sound === "riser") { // builds to its peak at the end, so keep the end
      if (dur < RISER_SEC) pre = `atrim=start=${RISER_SEC - dur},asetpts=PTS-STARTPTS,`;
      else at += dur - RISER_SEC;
    }
    const ms = Math.round(at * 1000);
    const trim = dur ? `atrim=0:${dur},afade=t=out:st=${Math.max(0, dur - 0.02)}:d=0.02,` : "";
    a2.push("-i", join(sfxDir, `${e.sound}.wav`));
    f2.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,${pre}${trim}` +
      `volume=${Number(e.volume ?? 1) * gain},adelay=${ms}|${ms}[fx${i}]`);
  });
  const last = fx.length ? "[m]" : "[b]";
  if (fx.length) f2.push(`[b]${fx.map((_, i) => `[fx${i}]`).join("")}amix=inputs=${fx.length + 1}:duration=first:normalize=0[m]`);
  f2.push(`${last}alimiter=limit=0.75:level=false,aresample=48000[out]`);
  await ffmpeg([...a2, "-filter_complex", f2.join(";"), "-map", "[out]", "-c:a", "pcm_s16le", out], "mix the sound effects");
  return loudness(out);
}
