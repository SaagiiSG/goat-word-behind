#!/usr/bin/env node
// GOAT look CLI. Run from the member's folder:
//   node SKILL_DIR/scripts/goat.mjs probe <files…>
//   node SKILL_DIR/scripts/goat.mjs prep|transcribe|cut|render plan.json
// The look is SKILL_DIR/look.mjs (this scripts folder's parent).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { die, run, probe, speech, prep, sheet } from "./media.mjs";
import { transcribe, groupCaptions, silenceKeeps, retime, applyCut, parseTranscript } from "./words.mjs";
import { mixSound, checkEvents, loudness } from "./sound.mjs";
import { buildProject, renderProject, mux, checkFirstFrame } from "./render.mjs";
import { hf } from "./hf.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPTS, "..");
const [cmd, ...rest] = process.argv.slice(2);
const sec = (x) => `${x.toFixed(1)}s`;

function need(path, step) {
  if (!existsSync(path)) throw new Error(`${path} is missing. Run "${step}" first.`);
  return path;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const newer = (a, b) => existsSync(a) && existsSync(b) && statSync(a).mtimeMs > statSync(b).mtimeMs;
const writeJson = (p, x) => writeFileSync(p, JSON.stringify(x, null, 2));

async function main() {
  if (cmd === "probe") {
    if (!rest.length) throw new Error("usage: goat.mjs probe <files…>");
    for (const f of rest) {
      const info = await probe(resolve(f));
      if (info.audio && !info.still) info.speech = await speech(resolve(f));
      console.log(JSON.stringify(info));
    }
    return;
  }
  if (!["prep", "transcribe", "cut", "render"].includes(cmd) || !rest[0])
    throw new Error("usage: goat.mjs probe <files…> | prep|transcribe|cut|render plan.json");

  const look = await import(pathToFileURL(join(SKILL_DIR, "look.mjs")).href);
  const planPath = resolve(rest[0]);
  const plan = readJson(need(planPath, "write plan.json"));
  const planDir = dirname(planPath);
  const work = join(planDir, `.work-${look.NAME}`);
  mkdirSync(work, { recursive: true });
  const main = join(work, "main.mp4"), cut = join(work, "cut.mp4");
  const transcript = join(work, "transcript.json"), wordsFile = join(work, "words.json");
  const prepFile = join(work, "prep.json"), keepsFile = join(work, "keeps.json"), cutsFile = join(work, "cuts.json");

  if (cmd === "prep") {
    const r = await prep(plan, planDir, main, look);
    writeJson(prepFile, r);
    console.log(`[goat] joined ${r.cuts.length} clip(s), ${sec(r.dur)} -> ${main}`);
    return;
  }

  if (cmd === "transcribe") {
    if (!look.TALKS) return console.log(`[goat] ${look.NAME} has no captions, so there is nothing to transcribe.`);
    const words = await transcribe(need(main, "prep plan.json"), work, plan.language ?? "mn");
    writeJson(transcript, words);
    console.log(`[goat] ${words.length} words -> ${transcript}`);
    console.log("Check the spelling. Fix the text in transcript.json, keep the times:");
    let i = 0;
    for (const g of groupCaptions(words)) {
      const n = g.text.split(" ").length;
      console.log(`  [${i}-${i + n - 1}] ${sec(g.start)}  ${g.text}`);
      i += n;
    }
    return;
  }

  if (cmd === "cut") {
    need(main, "prep plan.json");
    const words = look.TALKS ? parseTranscript(readJson(need(transcript, "transcribe plan.json"))) : [];
    const before = (await probe(main)).dur;
    const keeps = plan.cut === false || !words.length ? null
      : silenceKeeps(words, before, { protect: existsSync(prepFile) ? readJson(prepFile).silent ?? [] : [],
        speech: await speech(main) });
    // same cuts as last time (e.g. only the spelling was fixed): keep cut.mp4, so the cut-out isn't redone
    const key = JSON.stringify(keeps ?? "copy");
    const same = existsSync(cut) && existsSync(keepsFile) && readFileSync(keepsFile, "utf8") === key && !newer(main, cut);
    if (!same) {
      if (keeps) await applyCut(main, keeps, cut);
      else {
        copyFileSync(main, cut);
        const now = new Date();
        utimesSync(cut, now, now); // Windows keeps the source's time on a copy, which would fool the cut-out cache
      }
      writeFileSync(keepsFile, key);
    }
    writeJson(wordsFile, keeps ? retime(words, keeps) : words);
    // each clip's start in the cut timeline, for looks that place things per clip
    if (existsSync(prepFile)) {
      const starts = readJson(prepFile).cuts ?? [];
      writeJson(cutsFile, keeps ? retime(starts.map((t) => ({ start: t, end: t })), keeps).map((x) => x.start) : starts);
    }
    console.log(`[goat] ${sec(before)} -> ${sec((await probe(cut)).dur)} -> ${cut}${same ? " (video unchanged)" : ""}`);
    return;
  }

  // render
  need(cut, "cut plan.json");
  if (newer(main, cut) || (look.TALKS && newer(transcript, wordsFile)))
    throw new Error('the video or transcript.json changed after the last cut. Run "cut plan.json" again.');
  look.validate(plan);
  const t0 = Date.now();
  const dur = (await probe(cut)).dur;
  const words = readJson(need(wordsFile, "cut plan.json"));
  const captions = look.TALKS && plan.captions !== false ? groupCaptions(words) : [];
  const hfDir = join(work, "hf");
  mkdirSync(hfDir, { recursive: true });
  const cuts = existsSync(cutsFile) ? readJson(cutsFile) : [];
  const clips = existsSync(prepFile) ? (readJson(prepFile).clips ?? []).map((c, i) => ({ ...c, start: cuts[i] ?? c.start })) : [];
  const ctx = { plan, planDir, work, hfDir, skillDir: SKILL_DIR, dur, words, captions, cuts, clips, run, hf };
  const data = await look.prepare(ctx);
  await buildProject(ctx, data);

  const cfg = plan.sfx ?? {};
  if (cfg !== false && (typeof cfg !== "object" || Array.isArray(cfg)))
    throw new Error('"sfx" must be false or {"auto": true, "volume": 1.0, "add": [...]}');
  const events = cfg === false ? [] : [...(cfg.auto === false ? [] : look.sfx(plan, ctx)), ...(cfg.add ?? [])];
  checkEvents(events);
  const sound = join(work, "sound.wav");
  await mixSound({ bed: cut, total: dur, voiceover: plan.voiceover, music: plan.music, events,
    gain: Number(cfg.volume ?? 1), sfxDir: join(SCRIPTS, "sfx"), out: sound, planDir });

  const out = resolve(planDir, plan.output ?? `output/${look.NAME}.mp4`);
  mkdirSync(dirname(out), { recursive: true });
  const silent = join(work, "silent.mp4");
  await renderProject(hfDir, silent);
  await mux(silent, sound, out);
  await sheet(out, join(work, "sheet.jpg"));
  await checkFirstFrame(out);
  const { lufs, peak } = await loudness(out);
  console.log(`[goat] done: ${out}`);
  console.log(`  ${sec(dur)}, ${events.length} sound effect(s), ${lufs} LUFS, peak ${peak} dBTP, ` +
    `rendered in ${sec((Date.now() - t0) / 1000)}. Contact sheet: ${join(work, "sheet.jpg")}`);
}

main().catch((e) => die(e.message));
