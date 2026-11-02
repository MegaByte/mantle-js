// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchBuildCost — where CPatch CONVERSION time goes, and what it costs after.
//
// Draw cost is measured elsewhere (probes/_cpatchIntegrated.mjs: every curve type beats
// Loop-Blinn once the cover is grid-split). This prices construction: it runs the converter
// over a fixed workload — the synthetic families plus 60 real tiger contours — and reports
// time, with a QUALITY check outside the timed region, because a conversion speedup that
// quietly degrades the output is not a speedup and patch counts alone will not show it.
//
// WHERE THE TIME GOES. Root finding (bezRoots01 and the bezSplit it calls) dominates a
// bisecting solver, and 99.7% of calls are degree 1, 2 or 3 -- degree 1 worst of all, a
// LINEAR polynomial bisected ~24 times to find a root that is one division. So:
//   * degrees 1-3 use closed forms, the renderer's own polyRoots solvers rather than a
//     second copy. Degree 4+ subdivides (0.3% of calls).
//   * bezSplit does de Casteljau IN PLACE on one scratch array; a version that allocates
//     per level spends a fifth of the remaining time there, plus most of the GC.
//
// AND ONE TRAP only THE RENDER SHOWS. The exact solver returns a root at an endpoint as
// exactly 0, where subdivision returns ~4e-6 because that is where bisection stops. A
// (1e-7, 1-1e-7) trim would discard it — so the MORE accurate solver would silently lose
// crossings. The converter depends on them: it cuts along tangents THROUGH endpoints, so a
// crossing at a shared vertex is the common case, and losing it makes the crossing count odd
// and the loop assembler mis-pair (the arc family at N=16 under-cuts to 12 patches instead of
// 36 and renders an AA error of 167/255). gridCheck does not flag it and the patch count alone
// looks merely different; only the render does.
//
// The solver choice is not obvious from any single metric: solveCubicInUnit (Yuksel, the
// documented preference for range-bounded parameters) measures WORSE here on the
// near-degenerate polynomials this converter produces, while Cardano plus a
// Bernstein Newton polish wins. Both agree with subdivision to 3e-8 on random polynomials, so
// the difference only appears on structured input. CPATCH_AUDIT_ROOTS=1 computes both and
// records disagreements.
//
// still FAR FROM FREE: Loop-Blinn builds a whole asset in milliseconds, so at ~7.6 ms per
// contour this remains orders of magnitude more expensive. The 5.7x removes the accidental
// cost; what is left is the algorithm.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertContour, gridSplitPatch, gridCheck } from '../src/renderer/cpatchConvert.js';
import { parsePathD } from '../src/svg/path.js';
import { cubicInflections, cubicLoopCuts, cubicSlice } from '../src/geom/lbCubicMath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const C = 200,
  R = 150,
  AMT = 26;
const ngonQuad = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C,
      oy = my - C;
    const L = Math.hypot(ox, oy) || 1;
    out.push({ t: 'quad', P: [a, [mx + (ox / L) * AMT, my + (oy / L) * AMT], b] });
  }
  return out;
};
const ngonCubic = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const o = (t, amt) => {
      const x = a[0] + (b[0] - a[0]) * t,
        y = a[1] + (b[1] - a[1]) * t;
      let ox = x - C,
        oy = y - C;
      const L = Math.hypot(ox, oy) || 1;
      return [x + (ox / L) * amt, y + (oy / L) * amt];
    };
    const P = [a, o(1 / 3, AMT * 0.7), o(2 / 3, AMT * 1.45), b];
    const ts = cubicInflections(P)
      .concat(cubicLoopCuts(P))
      .sort((u, v) => u - v);
    let prev = 0;
    for (const t of ts) {
      if (t - prev > 1e-4) {
        out.push({ t: 'cubic', P: cubicSlice(P, prev, t) });
        prev = t;
      }
    }
    out.push({ t: 'cubic', P: cubicSlice(P, prev, 1) });
  }
  return out;
};

/// Real contours, so the profile is not dominated by a synthetic shape's quirks.
function tigerContours(limit) {
  const txt = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');
  const ds = [...txt.matchAll(/\sd\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const out = [];
  for (const d of ds) {
    let segs;
    try {
      segs = parsePathD(d);
    } catch {
      continue;
    }
    let cur = null;
    const flush = () => {
      if (cur && cur.length >= 2) out.push(cur);
      cur = null;
    };
    let bad = false;
    for (const s of segs) {
      if (s.subStart) flush();
      if (!cur) cur = [];
      if (s.type === 0 && s.p2) cur.push({ t: 'line', P: [s.p1, s.p2] });
      else if (s.type === 1 && s.p3) cur.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
      else if (s.type === 2 && s.p4) {
        const P = [s.p1, s.p2, s.p3, s.p4];
        const ts = cubicInflections(P)
          .concat(cubicLoopCuts(P))
          .sort((u, v) => u - v);
        let prev = 0;
        for (const t of ts) {
          if (t - prev > 1e-4) {
            cur.push({ t: 'cubic', P: cubicSlice(P, prev, t) });
            prev = t;
          }
        }
        cur.push({ t: 'cubic', P: cubicSlice(P, prev, 1) });
      } else {
        bad = true;
        break;
      }
    }
    if (!bad) flush();
    if (out.length >= limit) break;
  }
  return out.filter((c) => c.length >= 2 && c.length <= 24);
}

const WORK = [];
for (const n of [3, 5, 8, 12, 16]) {
  WORK.push(ngonQuad(n));
  WORK.push(ngonCubic(n));
}
for (const c of tigerContours(60)) WORK.push(c);

const t0 = process.hrtime.bigint();
let patches = 0,
  cells = 0,
  contours = 0;
const built = [];
for (const curves of WORK) {
  let out;
  try {
    out = convertContour(curves, { maxCurves: 8, tolPx: 0.05 });
  } catch {
    continue;
  }
  contours++;
  patches += out.patches.length;
  for (const p of out.patches) {
    const cs = gridSplitPatch(p, 8, 1.2);
    if (cs) cells += cs.length;
  }
  built.push(out);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

// QUALITY, outside the timed region. A conversion speedup that quietly degrades the output is
// not a speedup, and patch counts alone will not show it — root-finding accuracy changes which
// cuts are chosen, so the counts legitimately move while the fill must not.
let unresolved = 0,
  gridbad = 0,
  gridtot = 0;
for (const out of built) {
  unresolved += out.stats.unresolved | 0;
  for (const p of out.patches) {
    const g = gridCheck(p, 24);
    gridbad += g.bad;
    gridtot += g.tot;
  }
}
console.log(`converted ${contours} contours -> ${patches} patches -> ${cells} grid cells`);
console.log(`total ${ms.toFixed(1)} ms   ·   ${(ms / contours).toFixed(2)} ms per contour`);
console.log(`quality: ${unresolved} unresolved patch(es), gridCheck ${gridbad}/${gridtot} bad`);
