// Which characters a font file can draw: reads the 'cmap' table (formats 4 and 12), Node built-ins only.
import { readFileSync } from "node:fs";

export function glyphs(fontPath) {
  const b = readFileSync(fontPath);
  let base = 0;
  if (b.toString("latin1", 0, 4) === "ttcf") base = b.readUInt32BE(12); // first font of a collection
  const n = b.readUInt16BE(base + 4);
  let cmap = -1;
  for (let i = 0; i < n; i++) {
    const r = base + 12 + i * 16;
    if (b.toString("latin1", r, r + 4) === "cmap") cmap = b.readUInt32BE(r + 8);
  }
  if (cmap < 0) throw new Error(`${fontPath} has no cmap table`);
  // best Unicode subtable: 3/10, then 3/1, then platform 0
  const rank = (p, e) => (p === 3 && e === 10 ? 3 : p === 3 && e === 1 ? 2 : p === 0 ? 1 : 0);
  let best = null, bestRank = 0;
  for (let i = 0, c = b.readUInt16BE(cmap + 2); i < c; i++) {
    const r = cmap + 4 + i * 8, k = rank(b.readUInt16BE(r), b.readUInt16BE(r + 2));
    if (k > bestRank) { bestRank = k; best = cmap + b.readUInt32BE(r + 4); }
  }
  if (best === null) throw new Error(`${fontPath} has no Unicode cmap`);
  const set = new Set(), fmt = b.readUInt16BE(best);
  if (fmt === 4) {
    const segs = b.readUInt16BE(best + 6) / 2, end = best + 14, start = end + segs * 2 + 2;
    const delta = start + segs * 2, range = delta + segs * 2;
    for (let s = 0; s < segs; s++) {
      const e = b.readUInt16BE(end + s * 2), st = b.readUInt16BE(start + s * 2);
      const d = b.readUInt16BE(delta + s * 2), ro = b.readUInt16BE(range + s * 2);
      for (let c = st; c <= e && c < 0xffff; c++) {
        let g = c;
        if (ro) {
          g = b.readUInt16BE(range + s * 2 + ro + (c - st) * 2);
          if (g) g = (g + d) & 0xffff;
        } else g = (c + d) & 0xffff;
        if (g) set.add(c);
      }
    }
  } else if (fmt === 12) {
    for (let i = 0, g = b.readUInt32BE(best + 12); i < g; i++) {
      const r = best + 16 + i * 12, st = b.readUInt32BE(r), e = b.readUInt32BE(r + 4), gid = b.readUInt32BE(r + 8);
      for (let c = st; c <= e; c++) if (gid + (c - st)) set.add(c);
    }
  } else throw new Error(`${fontPath}: cmap format ${fmt} is not supported`);
  return set;
}

export function missing(text, fontPath) {
  const g = glyphs(fontPath);
  return [...new Set([...text].filter((ch) => !/\s/.test(ch) && !g.has(ch.codePointAt(0))))];
}
