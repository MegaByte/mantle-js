// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzMissingRegion — WHERE a shape's decomposition fails to reach, and what shape that hole is.
//
// "66 samples unpainted" does not say whether the decomposition dropped a whole loop, left a
// sliver between two patches, or built patches that are individually valid and collectively short.
// This maps the missing samples, groups them into connected regions, and reports each region's
// extent next to the shape's -- which is what tells those three apart.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import {
  convertContour,
  insideContour,
  inPatch,
  patchEval,
  patchBBox,
} from '../src/renderer/cpatchConvert.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { patchCoverage, curveCov, exactBoxCov } from '../src/renderer/cpatchCov.js';
import { segTightBBox, packedEval, implGrad } from '../src/geom/cpatchImplicit.js';
import { patchCoverLines } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const G = +(process.env.G || 512);
const SI = +process.argv[3];
const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const r = sections.curveRangesByShape[SI];
const list = contoursToConverter(
  curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
  null,
);
const all = [];
for (const c of list) {
  for (const sg of c) all.push(sg);
  const a = segPt(c[0], 0),
    b = segPt(c[c.length - 1], 1);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) all.push({ t: 'line', P: [b, a] });
}
let cycles = [];
try {
  cycles = pathToCycles(list, false) || [];
} catch {
  cycles = [];
}
if (!cycles.length)
  cycles = list.map((c) => {
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6 ? c : c.concat([{ t: 'line', P: [b, a] }]);
  });
const patches = [];
const perCycle = [];
for (const c of cycles) {
  let got = 0;
  try {
    const rr = convertContour(c, { maxCurves: 8, tolPx: 0.05 });
    if (rr && rr.patches) {
      patches.push(...rr.patches);
      got = rr.patches.length;
    }
  } catch {
    got = -1;
  }
  perCycle.push({ n: c.length, got });
}
const bb = patchBBox(all);
const ext = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
const pad = 0.02 * ext;
const sx = (bb[2] - bb[0] + 2 * pad) / G,
  sy = (bb[3] - bb[1] + 2 * pad) / G;
console.log(
  `shape ${SI}: ${list.length} subpath(s) -> ${cycles.length} cycle(s) -> ${patches.length} patches` +
    `  [${perCycle.map((c) => `${c.n}seg:${c.got < 0 ? 'REFUSED' : c.got + 'p'}`).join(' ')}]`,
);
console.log(`  extent ${ext.toFixed(2)} em, sampling step ${sx.toFixed(4)} em`);
const miss = [];
const grid = new Uint8Array(G * G);
for (let gy = 0; gy < G; gy++)
  for (let gx = 0; gx < G; gx++) {
    const x = bb[0] - pad + (gx + 0.5) * sx,
      y = bb[1] - pad + (gy + 0.5) * sy;
    if (!insideContour(all, x, y)) continue;
    let got = false;
    for (const p of patches)
      if (inPatch(p, x, y)) {
        got = true;
        break;
      }
    if (got) continue;
    grid[gy * G + gx] = 1;
    miss.push([gx, gy, x, y]);
  }
console.log(`  ${miss.length} inside samples no patch contains`);
// Connected regions, 4-neighbour.
const seen = new Uint8Array(G * G),
  regions = [];
for (const [gx, gy] of miss) {
  if (seen[gy * G + gx]) continue;
  const st = [[gx, gy]];
  seen[gy * G + gx] = 1;
  let n = 0,
    x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  while (st.length) {
    const [ax, ay] = st.pop();
    n++;
    x0 = Math.min(x0, ax);
    x1 = Math.max(x1, ax);
    y0 = Math.min(y0, ay);
    y1 = Math.max(y1, ay);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = ax + dx,
        ny = ay + dy;
      if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
      if (grid[ny * G + nx] && !seen[ny * G + nx]) {
        seen[ny * G + nx] = 1;
        st.push([nx, ny]);
      }
    }
  }
  regions.push({
    n,
    w: (x1 - x0 + 1) * sx,
    h: (y1 - y0 + 1) * sy,
    cx: bb[0] - pad + ((x0 + x1 + 1) / 2) * sx,
    cy: bb[1] - pad + ((y0 + y1 + 1) / 2) * sy,
  });
}
regions.sort((a, b) => b.n - a.n);
console.log(`  in ${regions.length} connected region(s):`);
for (const g of regions.slice(0, 6)) {
  const cov = (() => {
    let open = 1;
    for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, g.cx, g.cy, sx)));
    return 1 - open;
  })();
  // WHICH PATCH IS NEAREST TO CLAIMING IT, and by how much: the least negative half-space says
  // whether this is a hair or a hole.
  let bestPatch = -1,
    bestWorst = -Infinity;
  for (let k = 0; k < patches.length; k++) {
    let worst = Infinity;
    for (let i = 0; i < patches[k].impls.length; i++)
      worst = Math.min(worst, patchEval(patches[k], i, g.cx, g.cy));
    if (worst > bestWorst) {
      bestWorst = worst;
      bestPatch = k;
    }
  }
  console.log(
    `    ${String(g.n).padStart(4)} samples, ${g.w.toFixed(4)} x ${g.h.toFixed(4)} em` +
      ` (${((g.w / ext) * 100).toFixed(2)}% x ${((g.h / ext) * 100).toFixed(2)}% of the shape)` +
      `  kernel paints ${cov.toFixed(3)} at its centre; nearest patch ${bestPatch} misses by ${(-bestWorst).toExponential(2)}`,
  );
}

// THE LARGEST REGION, TAKEN APART. Which patch comes closest, what each of its constraints says,
// and whether the thing that zeroed it was a constraint at all or the cover hull.
if (regions.length && process.env.DUMP !== '0') {
  const g = regions[0];
  let bestPatch = -1,
    bestWorst = -Infinity;
  for (let k = 0; k < patches.length; k++) {
    let worst = Infinity;
    for (let i = 0; i < patches[k].impls.length; i++)
      worst = Math.min(worst, patchEval(patches[k], i, g.cx, g.cy));
    if (worst > bestWorst) {
      bestWorst = worst;
      bestPatch = k;
    }
  }
  // every PATCH, RANKED BY HOW BADLY IT MISSES, in pixels. One patch missing by a pixel and a half
  // is a lost region; a dozen missing by an ulp is a seam nobody claimed.
  const rank = patches
    .map((q, k) => {
      let worstPx = Infinity;
      for (let i = 0; i < q.impls.length; i++) {
        const f = patchEval(q, i, g.cx, g.cy);
        const gr = implGrad(q.impls[i].impl, g.cx, g.cy);
        const gl = Math.hypot(gr[0], gr[1]) * Math.abs(q.impls[i].s);
        worstPx = Math.min(worstPx, gl > 0 ? f / gl / sx : f >= 0 ? Infinity : -Infinity);
      }
      return { k, worstPx, n: q.curves.length, cuts: q.curves.filter((c) => c.cut).length };
    })
    .sort((a, b) => b.worstPx - a.worstPx);
  console.log(
    `\n  at (${g.cx.toFixed(4)}, ${g.cy.toFixed(4)}), the five patches that come closest:`,
  );
  for (const q of rank.slice(0, 5))
    console.log(
      `    patch ${String(q.k).padStart(2)}: outside by ${(-q.worstPx).toFixed(3)} px` +
        `  (${q.n} curves, ${q.cuts} of them cuts)`,
    );
  const p = patches[bestPatch];
  // IS IT EVEN INSIDE THE CYCLE THE CONVERTER WAS GIVEN? The arrangement resolves the subpath's
  // self-intersections and hands the converter cycles; a lobe it scores as unfilled is not the
  // converter's to cover, and a probe scoring against the RAW subpath would blame it anyway.
  for (let ci = 0; ci < cycles.length; ci++)
    console.log(
      `  cycle ${ci} (${cycles[ci].length} seg): contains the region? ` +
        (insideContour(cycles[ci], g.cx, g.cy) ? 'YES' : 'no'),
    );
  console.log(`  raw closed subpaths contain it? ${insideContour(all, g.cx, g.cy) ? 'YES' : 'no'}`);
  console.log(`  patch ${bestPatch} in full:`);
  const res = {};
  for (let i = 0; i < p.impls.length; i++) {
    const sg = p.curves[i],
      pk = p.impls[i].packed;
    const f = patchEval(p, i, g.cx, g.cy);
    const gr = implGrad(p.impls[i].impl, g.cx, g.cy);
    const gl = Math.hypot(gr[0], gr[1]);
    const sgn = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
    const c = curveCov(pk, sgn, !!sg.cut, segTightBBox(sg), g.cx, g.cy, sx, res, sg);
    console.log(
      `    c${i} ${sg.t}${sg.cut ? ' CUT' : ''} kind=${pk.kind}  f=${f.toExponential(3)}` +
        `  f/|grad| = ${(gl > 0 ? f / gl / sx : NaN).toFixed(4)} px  kernel cov=${c.toFixed(4)}`,
    );
  }
  const cover = patchCoverLines(p.curves, 16) || p.cover;
  if (cover)
    for (let h = 0; h < cover.length; h++) {
      const L = cover[h];
      const A = (L[0] * g.cx + L[1] * g.cy + L[2]) / sx;
      if (A < 2)
        console.log(
          `    hull plane ${h} kind=${L[3]}  ${A.toFixed(4)} px inside` +
            (L[3] === 2 ? `  (ramped, cov ${exactBoxCov(L[0], L[1], A).toFixed(4)})` : '  (HARD)'),
        );
    }
}
