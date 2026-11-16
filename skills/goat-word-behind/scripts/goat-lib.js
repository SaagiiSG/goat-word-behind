// Browser helpers for the looks (plain script, sets globalThis.GOAT). Same seed, same numbers, so every render matches.
(function () {
  const GOAT = {
    rng(seed) { // mulberry32
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    // Largest font size (px) from maxSize down to minSize at which el's text fits maxWidth on one line.
    fit(el, maxWidth, maxSize, minSize = 24) {
      let size = maxSize;
      el.style.whiteSpace = "nowrap";
      el.style.fontSize = size + "px";
      while (size > minSize && el.scrollWidth > maxWidth) el.style.fontSize = --size + "px";
      return size;
    },
    // Keep a time only if it is at least minGap after the last kept one.
    spaced(times, minGap = 1 / 3) {
      const out = [];
      for (const t of times) if (!out.length || t - out.at(-1) >= minGap - 1e-9) out.push(t);
      return out;
    },
    // Hold time on a grid of hz steps per second (stop-motion look).
    stepped(t, hz) { return Math.floor(t * hz + 1e-9) / hz; },
  };
  globalThis.GOAT = GOAT;
})();
