// 13 Word Behind Head. Reads window.PLAN (written by goat.mjs) and builds one paused GSAP timeline.
const P = window.PLAN;
const SVG = "http://www.w3.org/2000/svg";
const el = (tag, cls, parent, text) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.innerHTML = `<span></span>`, (e.firstChild.textContent = text);
  parent.appendChild(e);
  return e;
};
const svg = (tag, attrs, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e);
  return e;
};
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

document.getElementById("dim").style.opacity = P.look.dim ?? 0.4;
const deco = document.getElementById("deco");
const tl = gsap.timeline({ paused: true });

// Big words, each with its line or ring behind the person
const words = P.big.map((w) => {
  const e = el("div", "word", document.getElementById("words"), w.text);
  e.firstChild.appendChild(document.createElement("i")); // sits on the baseline, so layout() can find the letters
  const { start: s, end: t } = w;
  tl.fromTo(e, { opacity: 0, y: 60, filter: "blur(12px)" },
    { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.5, ease: "power3.out" }, s);
  tl.to(e, { opacity: 0, y: -40, duration: 0.25, ease: "power2.in" }, Math.max(s + 0.5, t - 0.25));

  const head = w.head ?? { cx: 540, top: 700, width: 420 };
  if (w.deco === "line") {
    const y = head.top + 0.15 * head.width;
    const p = svg("path", { class: "wave", d: `M-100 ${y} C 120 ${y - 90}, 300 ${y + 90}, 480 ${y} S 840 ${y - 90}, 1180 ${y}` }, deco);
    tl.fromTo(p, { x: -60 }, { x: 60, duration: t - s, ease: "none" }, s);
    tl.fromTo(p, { opacity: 0 }, { opacity: 1, duration: 0.3 }, s);
    tl.to(p, { opacity: 0, duration: 0.25 }, Math.max(s + 0.3, t - 0.25));
  } else if (w.deco === "ring") {
    const r = clamp(0.8 * head.width, 220, 420), cx = head.cx, cy = head.top + Math.min(0.5 * head.width, 300);
    const len = 2 * Math.PI * r * 0.6;
    const g = svg("g", { class: "ring" }, deco);
    const arcG = svg("g", {}, g);
    const arc = svg("circle", { class: "arc", cx, cy, r, transform: `rotate(200 ${cx} ${cy})`,
      "stroke-dasharray": `${len} ${2 * Math.PI * r}`, "stroke-dashoffset": len }, arcG);
    const ticks = svg("circle", { class: "ticks", cx, cy, r: r + 45 }, g);
    tl.fromTo(g, { opacity: 0 }, { opacity: 1, duration: 0.2 }, s);
    tl.fromTo(arc, { attr: { "stroke-dashoffset": len } }, { attr: { "stroke-dashoffset": 0 }, duration: 0.6, ease: "power2.out" }, s);
    tl.fromTo(arcG, { rotation: 0 }, { rotation: 40, duration: t - s, ease: "none", svgOrigin: `${cx} ${cy}` }, s);
    tl.fromTo(ticks, { rotation: 0 }, { rotation: -30, duration: t - s, ease: "none", svgOrigin: `${cx} ${cy}` }, s);
    tl.to(g, { opacity: 0, duration: 0.25 }, Math.max(s + 0.6, t - 0.25));
  }
  return e;
});

// Chips: one per listed thing, stacked, popping in
const chipBox = document.getElementById("chips");
const chips = P.chips.map((c) => {
  const e = el("div", "chip", chipBox);
  e.innerHTML = `<span class="ico"></span><span></span>`;
  e.lastChild.textContent = c.text;
  e.style.top = `${P.chipsTop + c.slot * P.chipRow}px`;
  tl.fromTo(e, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)" }, c.start);
  tl.to(e, { opacity: 0, duration: 0.2 }, Math.max(c.start + 0.35, c.end - 0.2));
  return e;
});

// Captions: plain white, hard swap, no animation
const caps = P.captions.map((c) => {
  const e = el("div", "cap", document.getElementById("caps"), c.text);
  tl.set(e, { opacity: 1 }, c.start);
  tl.set(e, { opacity: 0 }, c.end);
  return e;
});

tl.set({}, {}, P.dur);
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;

// Sizes need the real fonts; the renderer waits for document.fonts.ready before the first frame.
const pen = document.createElement("canvas").getContext("2d");
function layout() {
  P.big.forEach((w, i) => {
    const e = words[i], span = e.firstChild;
    let size = 300;
    e.style.fontSize = `${size}px`;
    if (span.offsetWidth > 0.86 * 1080) e.style.fontSize = `${(size = (300 * 0.86 * 1080) / span.offsetWidth)}px`;
    // the letters themselves, not the line box: baseline from the marker, cap height from the font
    pen.font = `900 ${size}px "Science Gothic"`;
    const m = pen.measureText(w.text.toUpperCase()), base = span.lastChild.offsetTop;
    const glyphTop = base - m.actualBoundingBoxAscent, capH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    // the head covers the lower 40% of the letters; no head found: a fixed spot in the top third
    const want = w.head ? w.head.top - 0.6 * capH : 380 - capH / 2;
    e.style.top = `${clamp(want, 270, 800 - capH) - glyphTop}px`;
  });
  caps.forEach((e) => {
    e.style.fontSize = "60px";
    const span = e.firstChild;
    if (span.offsetWidth > 840) e.style.fontSize = `${(60 * 840) / span.offsetWidth}px`;
    e.style.top = `${P.capY - e.offsetHeight / 2}px`;
  });
  // chips end inside the safe box (x 960): icon 76 + gap 20 leaves 564 px of text from x 300
  chips.forEach((e) => {
    e.style.fontSize = "44px";
    const text = e.lastChild;
    if (text.offsetWidth > 564) e.style.fontSize = `${(44 * 564) / text.offsetWidth}px`;
  });
}
layout();
document.fonts.ready.then(layout);
