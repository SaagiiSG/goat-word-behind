// 13 Word Behind Head: a giant silver word behind the speaker's head, a teal line or ring
// behind them, teal chips for each thing they list, plain white captions from their speech.
import { cutOut, headAt, noHeadNote } from "./scripts/cutout.mjs";

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

// Captions just under the usual chin (970 when there's room, as in the preview), chips under the captions. The usual
// chin is the 75th percentile of the sampled ones, so one stray frame (a hand by the face, a bad mask) can't push them
// down. A close-up pushes both low; past 1248 the app's own text may cover them, so prepare() warns.
export const CHIP_ROW = 76 + 18;
export function layoutFor(heads) {
  const chins = heads.filter(Boolean).map((h) => h.chin).sort((a, b) => a - b);
  if (!chins.length) return { capY: 970, chipsTop: 1030 };
  const chin = chins[Math.ceil(0.75 * chins.length) - 1];
  let capY = Math.round(clamp(chin + 90, 970, 1420));
  if (capY > 1213 && chin + 65 <= 1213) capY = 1213; // a little closer to the chin keeps their bottom (+35) inside 1248
  return { capY, chipsTop: capY + 60 };
}

// Captions or chips whose bottom edge falls below the safe box (y 1248), where app text can cover them.
export function offSafe({ capY, chipsTop }, chips) {
  const low = capY + 35 > 1248 ? ["captions"] : [];
  for (const c of chips) if (chipsTop + c.slot * CHIP_ROW + 76 > 1248) low.push(c.text);
  return low;
}

export async function prepare(ctx) {
  const { plan, run, dur } = ctx;
  const subject = await cutOut(ctx);
  const at = (t) => headAt(run, subject, clamp(Number(t), 0, dur - 0.05));
  const big = [];
  for (const [i, w] of bigWords(plan).entries())
    big.push({ text: w.text, start: Number(w.start), end: Math.min(Number(w.end), dur), deco: decoOf(plan, i),
      rises: Number(w.start) >= 1 / 30, head: await at(Number(w.start) + 0.3) }); // on frame 0 (the thumbnail): already up
  // each chip takes the lowest row that no chip still on screen is using
  const list = [];
  for (const c of chips(plan)) {
    const busy = list.filter((p) => p.end > c.start).map((p) => p.slot);
    let slot = 0;
    while (busy.includes(slot)) slot++;
    list.push({ text: c.text, start: Number(c.start), end: Number(c.end), slot, head: await at(Number(c.start) + 0.2) });
  }
  const heads = [...big, ...list].map((x) => x.head);
  const none = noHeadNote(heads, Boolean, "the big words, captions and chips");
  if (none) console.warn(none);
  // the captions run the whole video: 8 more reads spread over it, so one odd frame where a word starts can't place them
  const spread = [];
  for (let i = 0; i < 8; i++) spread.push(await at(((i + 0.5) * dur) / 8));
  const layout = layoutFor([...heads, ...spread]);
  const low = offSafe(layout, list);
  if (low.length)
    console.warn(`[goat] note: ${low.map((x) => `"${x}"`).join(", ")} sit below the safe area, where the app's own ` +
      "text can cover them. Keep at most 2 chips on screen at once; if the face fills the screen, film from the chest up.");
  return { big, chips: list, chipRow: CHIP_ROW, ...layout };
}

// v1's whoosh and pop at about 30% of its levels (Saagii, 16 Nov: "bring the sounds effects down a bit"); members raise
// them with "sfx": {"volume": …}. Never two within 0.5 s: a word's whoosh beats a chip's pop, the earlier one plays.
export function sfx(plan) {
  const out = [], keep = (e) => out.every((k) => Math.abs(k.at - e.at) >= 0.5 - 1e-9) && out.push(e);
  for (const w of bigWords(plan)) keep({ sound: "whoosh", at: Math.max(0, w.start - 0.15), volume: 0.15 });
  for (const c of chips(plan)) keep({ sound: "pop", at: c.start, volume: 0.18 });
  return out.sort((a, b) => a.at - b.at);
}
