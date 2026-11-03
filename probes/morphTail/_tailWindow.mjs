// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Is the 2.5e-1 a distance or the ceiling? Read each arm at widening windows.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(ROOT + '/src/svg/importer.js');
const { curveRangeToContours } = await import(ROOT + '/src/geom/lbContour.js');
const { segmentPartitionPairMorph, tailDrift9 } = await import(
  ROOT + '/src/renderer/loopBlinnMorph.js'
);
const { pairImplicitDrift } = await import(ROOT + '/src/renderer/lbPartitionPair.js');
async function contoursOf(file) {
  const b = await importSvg(readFileSync(path.join(ROOT, file), 'utf8'), {
    preserveViewport: true,
  });
  const c = new Float32Array(b.curves),
    out = [];
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s];
    if (r) out.push(curveRangeToContours(c, r.begin, r.end));
  }
  return out;
}
const SRC = await contoursOf('examples/smoke/lbMorphEvenOdd__SRC.svg');
const DST = await contoursOf('examples/smoke/lbMorphEvenOdd__DST.svg');
const segs = segmentPartitionPairMorph(SRC[0], DST[0], 'evenodd');
console.log(`segments ${segs.length}`);
const over = segs.filter((g) => Math.max(g.tLoB - g.tLo, 0) + Math.max(g.tHi - g.tHiB, 0) > 1e-9);
console.log(`overshooting ${over.length}`);
for (const g of over) {
  const span = g.tHiB - g.tLoB;
  console.log(
    `\nseg draw [${g.tLo.toFixed(4)},${g.tHi.toFixed(4)}] built [${g.tLoB.toFixed(4)},${g.tHiB.toFixed(4)}] localT -> ${((g.tHi - g.tLoB) / span).toFixed(2)}`,
  );
  for (const lf of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) {
    const o = {};
    const d = tailDrift9(g.pair, g.tLo, g.tHi, g.tLoB, g.tHiB, o, { limFrac: lf });
    console.log(
      `   limFrac ${String(lf).padStart(4)}  drift ${d.toExponential(3)}  saturated=${o.saturated}`,
    );
  }
  const oi = {};
  console.log(
    `   interpolated [0,1] ${pairImplicitDrift(g.pair.src, g.pair.dst, 0, 1, oi).toExponential(3)} saturated=${oi.saturated}`,
  );
}

// ── the two arms the saturated oracle scored as a tie ──────────────────────────────────────────
const { buildLoopBlinnPartitionPair } = await import(ROOT + '/src/renderer/lbPartitionPair.js');
const WIDE = { limFrac: 16 };
const tailOf = (g, o) => tailDrift9(g.pair, g.tLo, g.tHi, g.tLoB, g.tHiB, o, WIDE);
const fracOf = (g) => {
  const sp = g.tHiB - g.tLoB;
  return sp > 1e-9 ? (Math.max(g.tLoB - g.tLo, 0) + Math.max(g.tHi - g.tHiB, 0)) / sp : 0;
};

const lerp = (sc, dc, t) => {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t,
    lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) =>
    cs.map((ss, si) => {
      const ds = dc[ci][si],
        o = { type: ss.type, p1: lp(ss.p1, ds.p1) };
      if (ss.w != null) o.w = ss.w;
      if (ss.p2) o.p2 = lp(ss.p2, ds.p2);
      if (ss.p3) o.p3 = lp(ss.p3, ds.p3);
      if (ss.p4) o.p4 = lp(ss.p4, ds.p4);
      return o;
    }),
  );
};

console.log('\n(c) MARGIN HALVING, read at limFrac 16');
{
  const w = over.slice().sort((a, b) => tailOf(b) - tailOf(a))[0];
  let m = w.tHi - w.tHiB;
  for (let k = 0; k < 4; k++) {
    m = Math.max(1e-4, m * 0.5);
    const aLo = w.tLoB,
      aHi = w.tHi - m;
    if (!(aHi > aLo)) break;
    let alt = null;
    try {
      alt = buildLoopBlinnPartitionPair(
        lerp(SRC[0], DST[0], aLo),
        lerp(SRC[0], DST[0], aHi),
        'evenodd',
        { plainDstRows: true },
      );
    } catch {
      alt = null;
    }
    if (!alt) {
      console.log(
        `   overshoot ${((100 * (w.tHi - aHi)) / (aHi - aLo)).toFixed(1)}%  DID NOT BUILD`,
      );
      continue;
    }
    const o = {};
    const d = tailDrift9(alt, w.tLo, w.tHi, aLo, aHi, o, WIDE);
    console.log(
      `   overshoot ${String(((100 * (w.tHi - aHi)) / (aHi - aLo)).toFixed(1)).padStart(6)}%  tail ${d.toExponential(3)}  saturated=${o.saturated}`,
    );
  }
}

// ── the CLAMP arm: freeze the implicit at the build boundary, keep the exact positions ──────────
console.log('\n(e) CLAMP the remap (implicit frozen at [0,1], positions exact), limFrac 16');
for (const g of over) {
  const span = g.tHiB - g.tLoB;
  const uLo = (g.tLo - g.tLoB) / span,
    uHi = (g.tHi - g.tLoB) / span;
  const oE = {},
    oC = {};
  const extrap = pairImplicitDrift(g.pair.src, g.pair.dst, uLo, uHi, oE, WIDE);
  const clamped = pairImplicitDrift(g.pair.src, g.pair.dst, uLo, uHi, oC, {
    limFrac: 16,
    clamp: [0, 1],
  });
  console.log(
    `   localT [${uLo.toFixed(2)}, ${uHi.toFixed(2)}]  extrapolated ${extrap.toExponential(3)} (sat=${oE.saturated})` +
      `  CLAMPED ${clamped.toExponential(3)} (sat=${oC.saturated})  ${extrap > 0 ? (extrap / clamped).toFixed(2) + 'x' : '-'}`,
  );
}

// ── (f) BOUNDED extrapolation: is there one bound that beats both arms on every segment? ────────
console.log('\n(f) clamp the implicit into [-b, 1+b] — one universal bound, limFrac 16');
const BOUNDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.35, 0.5, 0.75, 1, 1.5, Infinity];
const rowsF = [];
for (const b of BOUNDS) {
  const cells = [];
  for (const g of over) {
    const span = g.tHiB - g.tLoB;
    const uLo = (g.tLo - g.tLoB) / span,
      uHi = (g.tHi - g.tLoB) / span;
    const o = {};
    const opt = Number.isFinite(b) ? { limFrac: 16, clamp: [-b, 1 + b] } : { limFrac: 16 };
    cells.push(pairImplicitDrift(g.pair.src, g.pair.dst, uLo, uHi, o, opt));
  }
  rowsF.push({ b, cells, worst: Math.max(...cells) });
}
for (const r of rowsF) {
  console.log(
    `   bound ${String(Number.isFinite(r.b) ? r.b : 'none').padStart(5)}  ` +
      r.cells.map((c) => c.toExponential(3)).join('  ') +
      `   worst ${r.worst.toExponential(3)}`,
  );
}
const best = rowsF.slice().sort((a, b2) => a.worst - b2.worst)[0];
console.log(
  `\n   BEST bound ${Number.isFinite(best.b) ? best.b : 'none'} at worst ${best.worst.toExponential(3)}`,
);
const none = rowsF.find((r) => !Number.isFinite(r.b));
console.log(
  `   against no clamp at all: ${none.worst.toExponential(3)}  (${(none.worst / best.worst).toFixed(1)}x)`,
);

// ── (g) HAND OVER AT THE BUILD BOUNDARY — a partition change, no shader change ──────────────────
// A segment overshoots on the HIGH side because its draw range runs to the flip while its build
// range stops a margin short of it. Nothing says the handover has to happen at the flip: if each
// segment yields at its own tHiB, no segment ever extrapolates upward, and the cost moves to the
// NEXT segment's low side — which is the cheap side, because that segment is wide and the same
// absolute margin is a small fraction of its span.
console.log('\n(g) handover at tHiB instead of at the flip, limFrac 16');
{
  const sorted = segs.slice().sort((a, b) => a.tLo - b.tLo);
  let worstNow = 0,
    worstAlt = 0;
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i],
      span = g.tHiB - g.tLoB;
    // now
    const uLo0 = (g.tLo - g.tLoB) / span,
      uHi0 = (g.tHi - g.tLoB) / span;
    const d0 = pairImplicitDrift(g.pair.src, g.pair.dst, uLo0, uHi0, null, WIDE);
    // alt: this segment yields at its own tHiB; it starts where the previous one yielded
    const startAlt = i === 0 ? g.tLo : sorted[i - 1].tHiB;
    const endAlt = i === sorted.length - 1 ? g.tHi : g.tHiB;
    const uLo1 = (startAlt - g.tLoB) / span,
      uHi1 = (endAlt - g.tLoB) / span;
    const d1 = pairImplicitDrift(g.pair.src, g.pair.dst, uLo1, uHi1, null, WIDE);
    worstNow = Math.max(worstNow, d0);
    worstAlt = Math.max(worstAlt, d1);
    console.log(
      `   seg ${i}: now draw [${g.tLo.toFixed(4)},${g.tHi.toFixed(4)}] u[${uLo0.toFixed(2)},${uHi0.toFixed(2)}] drift ${d0.toExponential(3)}`,
    );
    console.log(
      `          alt draw [${startAlt.toFixed(4)},${endAlt.toFixed(4)}] u[${uLo1.toFixed(2)},${uHi1.toFixed(2)}] drift ${d1.toExponential(3)}`,
    );
  }
  console.log(
    `\n   worst now ${worstNow.toExponential(3)}   worst alt ${worstAlt.toExponential(3)}   ${(worstNow / worstAlt).toFixed(1)}x`,
  );
}

// ── (h) IS THE HANDOVER SAFE? drift cannot see CLASSIFICATION, so ask the builder ───────────────
// Arm (g) moves segment 3's draw range down across the flip at ~0.0801. Positions extrapolate
// exactly, so the MESH is right; what could be wrong is which faces are filled, and that is fixed
// at build time. The builder's own predicate is the segmenter's definition of a flip: if a pair
// spanning [a, b] does not build, a classification barrier lies between them.
console.log('\n(h) can a pair span the proposed handover? (build success = no barrier)');
{
  const probe = (a, b) => {
    try {
      return !!buildLoopBlinnPartitionPair(
        lerp(SRC[0], DST[0], a),
        lerp(SRC[0], DST[0], b),
        'evenodd',
        { plainDstRows: true },
      );
    } catch {
      return false;
    }
  };
  const sorted = segs.slice().sort((x, y) => x.tLo - y.tLo);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1],
      g = sorted[i];
    const from = prev.tHiB,
      to = g.tHiB;
    console.log(
      `   seg ${i}: pair built [${g.tLoB.toFixed(4)},${g.tHiB.toFixed(4)}]  would draw from ${from.toFixed(4)}` +
        `  -> span [${from.toFixed(4)},${to.toFixed(4)}] builds? ${probe(from, to) ? 'YES' : 'NO — barrier crossed'}`,
    );
  }
}
