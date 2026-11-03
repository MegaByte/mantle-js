// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphCov — IS THE MOVED MORPH DECOMPOSITION BETTER? The AA reference, applied to morph POSES.
//
// The Loop-Blinn relative bars move nothing at scale 1 (probes/morphScale/_scale1.mjs diffs to zero).
// The CPatch ones DO: rather than a flat `tolPx: 0.05` at every hop, the bar is the pair's own
// accepted defect size -- about 0.0097 on a 124-unit drawing, five times tighter. That changes the decomposition the layout is extracted from, so the scale-1 output has to
// be SHOWN correct rather than argued correct.
//
// THE MODEL IS probes/cpatchGate/_rowGateAaRef.mjs's, term for term: a pixel's true coverage is
// area(pixel box AND filled region), `rowSpans` gives a scanline's filled spans exactly so the x
// integral is exact and only y is quadrature, and the engine's coverage is `cpatchCov.patchCoverage`
// composed over the patches the way the kernel composes it. Three things are borrowed with it:
//   - READ THE DELTA, NOT THE TOTAL. The quadrature wobbles the total by about 1% and not
//     monotonically; two arms scored against the same cached reference cancel that exactly.
//   - The raster is the whole DRAWING's, not each shape's: a shape measured on its own 512px raster
//     is being asked about a zoom nobody renders.
//   - `_rowGateSpill.mjs` is the WRONG instrument here. It thresholds at 0.5 and discards every
//     sample within half a pixel of the outline, so it is a containment measure and blind by
//     construction to the band a moved cut moves -- which is where a render's error lives.
//
// WHAT IS DIFFERENT. `_rowGateAaRef` scores a shape of an SVG through the static packer. A morph
// pose is not a file and does not go through that packer: the morph converts with `noCurveCuts`,
// `forceBezout` and a `leakMargin`, and it does it at POSES along t. So this scores the morph's own
// conversion, at several t, with the two bars -- a flat 0.05 and the derived one -- against one cached
// exact reference per pose.
//
//   node probes/morphScale/_morphCov.mjs        STEP=8 TS=0,0.5,1 SLICES=32 CANVAS=512 KIND=...
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { convertContour, rowSpans, morphTolPx } =
  await import('../../src/renderer/cpatchConvert.js');
const { patchCoverage } = await import('../../src/renderer/cpatchCov.js');
const { splitForMorph } = await import('../../src/renderer/cpatchMorphCert.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC } = await import('../../src/primitives/seg.js');
const { assetPairs, synthPairs, selfPairs } = await import('./_morphPairs.mjs');

const SLICES = +(process.env.SLICES || 32);
const CANVAS = +(process.env.CANVAS || 512);
const PAD = +(process.env.PAD || 2);
const STEP = +(process.env.STEP || 8);
const TS = (process.env.TS || '0,0.5,1').split(',').map(Number);
const KINDS = new Set((process.env.KIND || 'asset,synth,mixed,self,selfMixed').split(','));
const SELF = process.env.SELF || '../MantleSamples/Assets/Mantle/tiger.svg';
const REFFILE = process.env.REF || path.join(HERE, '_morphCovRef.json');
const refCache = existsSync(REFFILE) ? JSON.parse(readFileSync(REFFILE, 'utf8')) : {};
let refDirty = false;
const _w = console.warn;
console.warn = () => {};

const CP_T = { [SEG_LINE]: 'line', [SEG_QUAD]: 'quad', [SEG_CUBIC]: 'cubic' };
function cpCurves(contour) {
  const out = [];
  for (const sg of contour) {
    const t = CP_T[sg.type] || 'rquad';
    const P = [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean).map((q) => [q[0], q[1]]);
    if (P.length < 2) return null;
    out.push(t === 'rquad' ? { t, P, w: sg.w } : { t, P });
  }
  return out.length >= 2 ? out : null;
}
const poseAt = (A, B, t) =>
  A.map((c, i) =>
    c.w !== undefined
      ? {
          t: c.t,
          w: c.w,
          P: c.P.map((q, k) => [
            q[0] + (B[i].P[k][0] - q[0]) * t,
            q[1] + (B[i].P[k][1] - q[1]) * t,
          ]),
        }
      : {
          t: c.t,
          P: c.P.map((q, k) => [
            q[0] + (B[i].P[k][0] - q[0]) * t,
            q[1] + (B[i].P[k][1] - q[1]) * t,
          ]),
        },
  );

/// The morph's own conversion: the options cpatch.worker.js's planJob hands it, bar and all.
const convertAt = (cs, tolPx) => {
  try {
    return convertContour(cs, {
      maxCurves: 8,
      tolPx,
      noCurveCuts: true,
      forceBezout: true,
      leakMargin: tolPx,
    });
  } catch {
    return null;
  }
};
/// An open subpath is filled as if closed; rowSpans over the raw segments would find no interior.
const closed = (cs) => {
  const o = cs.slice();
  const a = cs[0].P[0],
    b = cs[cs.length - 1].P[cs[cs.length - 1].P.length - 1];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0)
    o.push({
      t: 'line',
      P: [
        [b[0], b[1]],
        [a[0], a[1]],
      ],
    });
  return o;
};
function exactCov(curves, x, y, px, slices) {
  let a = 0;
  for (let s = 0; s < slices; s++) {
    const yy = y + (px * (s + 0.5)) / slices;
    for (const sp of rowSpans(curves, yy)) {
      const lo = Math.max(sp[0], x),
        hi = Math.min(sp[1], x + px);
      if (hi > lo) a += hi - lo;
    }
  }
  return a / (px * slices);
}

const pairs = [
  ...(await assetPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(await synthPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(SELF !== 'none'
    ? await selfPairs(importSvg, parseMetaBin, curveRangeToContours, { file: SELF, step: STEP })
    : []),
].filter((p) => KINDS.has(p.kind));

const rows = [];
for (const p of pairs) {
  if (p.src.length !== 1 || p.dst.length !== 1) continue;
  const A0 = cpCurves(p.src[0]),
    B0 = cpCurves(p.dst[0]);
  if (!A0 || !B0 || A0.length !== B0.length) continue;
  let A, B;
  try {
    [A, B] = splitForMorph(A0, B0);
  } catch {
    continue;
  }
  if (A.length !== B.length) continue;
  const tolNew = morphTolPx(A, B),
    tolOld = 0.05;
  // THE RASTER IS THE whole PAIR'S: both poses in one box, so a growing morph is not re-zoomed
  // pose by pose (and the two arms see the same pixels, which is what makes the delta exact).
  let ax0 = Infinity,
    ay0 = Infinity,
    ax1 = -Infinity,
    ay1 = -Infinity;
  for (const cs of [A, B])
    for (const c of cs)
      for (const q of c.P) {
        if (q[0] < ax0) ax0 = q[0];
        if (q[0] > ax1) ax1 = q[0];
        if (q[1] < ay0) ay0 = q[1];
        if (q[1] > ay1) ay1 = q[1];
      }
  const px = Math.max(ax1 - ax0, ay1 - ay0) / CANVAS;
  if (!(px > 0)) continue;
  for (const t of TS) {
    const pose = poseAt(A, B, t);
    // convertContour returns FRAMES (impls, cover, obb) -- exactly what patchCoverage reads, and
    // what _rowGateAaRef hands it from the packer's own onPatches.
    const armOf = (tol) => {
      const c = convertAt(pose, tol);
      return c && c.patches.length ? c.patches : null;
    };
    const oldP = armOf(tolOld),
      newP = armOf(tolNew);
    if (!oldP || !newP) {
      rows.push({
        pair: `${p.kind}/${p.name}`,
        t,
        note: !oldP && !newP ? 'both null' : !oldP ? 'old null' : 'new null',
      });
      continue;
    }
    const all = closed(pose);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of all)
      for (const q of c.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    const i0 = Math.floor((x0 - ax0) / px) - PAD,
      i1 = Math.ceil((x1 - ax0) / px) + PAD;
    const j0 = Math.floor((y0 - ay0) / px) - PAD,
      j1 = Math.ceil((y1 - ay0) / px) + PAD;
    const rk = `${p.kind}/${p.name}@${t}|${CANVAS}|${SLICES}|${PAD}`;
    let ref = refCache[rk];
    const have = Array.isArray(ref) && ref.length === (i1 - i0 + 1) * (j1 - j0 + 1);
    if (!have) {
      ref = new Array((i1 - i0 + 1) * (j1 - j0 + 1));
      refDirty = true;
    }
    const score = {
      old: { err: 0, over: 0, under: 0, worst: 0 },
      new: { err: 0, over: 0, under: 0, worst: 0 },
    };
    let ri = 0;
    for (let j = j0; j <= j1; j++) {
      const py = ay0 + j * px;
      for (let i = i0; i <= i1; i++, ri++) {
        const pxx = ax0 + i * px;
        const ex = have ? ref[ri] : (ref[ri] = exactCov(all, pxx, py, px, SLICES));
        const cx = pxx + px / 2,
          cy = py + px / 2;
        for (const [k, ps] of [
          ['old', oldP],
          ['new', newP],
        ]) {
          let open = 1.0;
          for (const q of ps) {
            const c = patchCoverage(q, cx, cy, px);
            if (c <= 0) continue;
            open *= 1.0 - c;
            if (open <= 0.001) break;
          }
          const d = 1.0 - open - ex;
          if (d === 0) continue;
          const s = score[k];
          s.err += Math.abs(d);
          if (d > 0) s.over += d;
          else s.under -= d;
          if (Math.abs(d) > s.worst) s.worst = Math.abs(d);
        }
      }
    }
    if (!have) refCache[rk] = ref;
    rows.push({
      pair: `${p.kind}/${p.name}`,
      t,
      tolOld,
      tolNew,
      nOld: oldP.length,
      nNew: newP.length,
      old: score.old,
      new: score.new,
      d: score.new.err - score.old.err,
    });
  }
  console.error(`${p.kind}/${p.name} done`);
}
console.warn = _w;
if (refDirty) writeFileSync(REFFILE, JSON.stringify(refCache));
const scored = rows.filter((r) => r.d !== undefined);
scored.sort((a, b) => a.d - b.d);
console.log(`         dErr     old err     new err   patches   t      pair`);
for (const r of scored.slice(0, 12).concat(scored.slice(-12)))
  console.log(
    `  ${r.d.toFixed(3).padStart(11)} ${r.old.err.toFixed(3).padStart(11)} ${r.new.err.toFixed(3).padStart(11)}  ${String(r.nOld).padStart(3)}->${String(r.nNew).padEnd(3)}  ${r.t}  ${r.pair}`,
  );
const sum = (f) => scored.reduce((t, r) => t + f(r), 0);
console.log(`  ${scored.length} scored, ${rows.length - scored.length} unscored`);
console.log(
  `  err   ${sum((r) => r.old.err).toFixed(2)} -> ${sum((r) => r.new.err).toFixed(2)}  (delta ${sum((r) => r.d).toFixed(2)} px^2)`,
);
console.log(`  over  ${sum((r) => r.old.over).toFixed(2)} -> ${sum((r) => r.new.over).toFixed(2)}`);
console.log(
  `  under ${sum((r) => r.old.under).toFixed(2)} -> ${sum((r) => r.new.under).toFixed(2)}`,
);
console.log(
  `  patches ${sum((r) => r.nOld)} -> ${sum((r) => r.nNew)};  better ${scored.filter((r) => r.d < -1e-9).length}, worse ${scored.filter((r) => r.d > 1e-9).length}, same ${scored.filter((r) => Math.abs(r.d) <= 1e-9).length}`,
);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(rows));
