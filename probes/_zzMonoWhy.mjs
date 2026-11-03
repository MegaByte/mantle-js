// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzMonoWhy — a non-monotone edge names a MECHANISM, not a shape. Between two neighbouring
// pixels the one the exact reference covers more must not be painted less; where that fails, this
// asks the binding constraint which estimator set its distance, and whether that estimator CHANGED
// between the two pixels. A switch between estimators is a discontinuity in the distance field,
// and a discontinuity is what a monotonicity violation is made of.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov, CP_AA_REACH } from '../src/renderer/cpatchCov.js';
import { rowSpans, patchBBox } from '../src/renderer/cpatchConvert.js';
import { segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';

const PX = +(process.env.PX || 256);
const MONO_EPS = +(process.env.MONO_EPS || 0.02);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const GL = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const ONLY = process.env.SHAPES ? new Set(process.env.SHAPES.split(',').map(Number)) : null;
const _r = {};
/// The binding constraint at a point: the one whose coverage is lowest, and how it got its number.
function bindAt(ps, x, y, em) {
  let best = null;
  for (const p of ps) {
    if (patchCoverage(p, x, y, em) <= 0) continue;
    for (let i = 0; i < p.impls.length; i++) {
      const pk = p.impls[i].packed;
      if (!pk) continue;
      const seg = p.curves[i];
      const isCut = !!(seg && seg.cut);
      const sgn = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
      const c = curveCov(pk, sgn, isCut, segTightBBox(seg), x, y, em, _r, seg);
      if (!best || c < best.c)
        best = {
          c,
          pick: isCut ? 'cut' : _r.pick,
          sd: _r.sd,
          implD: _r.implD,
          arcD: _r.arcD,
          arcT: _r.arcT,
        };
    }
  }
  return best;
}
const tally = new Map(),
  pairTally = new Map();
let n = 0,
  worst = 0,
  worstAt = '';
for (let S = 0; S < (sec.curveRangesByShape || []).length; S++) {
  if (ONLY && !ONLY.has(S)) continue;
  const r = sec.curveRangesByShape[S];
  if (!r) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  const ps = [];
  try {
    packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  if (!ps.length) continue;
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  const bb = patchBBox(all);
  const em = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / PX;
  const i0 = Math.floor(bb[0] / em) - 2,
    i1 = Math.ceil(bb[2] / em) + 2;
  const j0 = Math.floor(bb[1] / em) - 2,
    j1 = Math.ceil(bb[3] / em) + 2;
  const W = i1 - i0 + 1;
  const ref = new Float64Array(W * (j1 - j0 + 1)),
    got = new Float64Array(W * (j1 - j0 + 1));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * em,
        cy = (j + 0.5) * em;
      let t = 0;
      for (const [q, w] of GL) {
        const y = cy + 0.5 * em * q;
        let c2 = 0;
        for (const sp of rowSpans(all, y) || [])
          c2 += Math.max(0, Math.min(cx + em / 2, sp[1]) - Math.max(cx - em / 2, sp[0]));
        t += (w * 0.5 * c2) / em;
      }
      let open = 1;
      for (const p of ps) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, cx, cy, em)));
      ref[(j - j0) * W + (i - i0)] = Math.min(1, Math.max(0, t));
      got[(j - j0) * W + (i - i0)] = 1 - open;
    }
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i < i1; i++) {
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
      ]) {
        const a = (j - j0) * W + (i - i0),
          b = (j + dj - j0) * W + (i + di - i0);
        if (b >= ref.length) continue;
        const dr = ref[b] - ref[a],
          dg = got[b] - got[a];
        if (!(dr * dg < 0 && Math.abs(dg) > MONO_EPS && Math.abs(dr) > MONO_EPS)) continue;
        n++;
        const v = Math.min(Math.abs(dr), Math.abs(dg));
        if (v > worst) {
          worst = v;
          worstAt = `s${S} (${i},${j})+(${di},${dj})`;
        }
        const A = bindAt(ps, (i + 0.5) * em, (j + 0.5) * em, em);
        const B = bindAt(ps, (i + di + 0.5) * em, (j + dj + 0.5) * em, em);
        const ka = A ? A.pick : 'none',
          kb = B ? B.pick : 'none';
        tally.set(ka, (tally.get(ka) | 0) + 1);
        const key = ka === kb ? `${ka} (same)` : `${ka} -> ${kb}`;
        pairTally.set(key, (pairTally.get(key) | 0) + 1);
      }
    }
}
console.log(
  `${n} non-monotone neighbour pairs at ${PX}px per shape, worst ${worst.toFixed(3)} at ${worstAt}`,
);
console.log(
  '  the binding estimator, both pixels: ' +
    [...pairTally]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}:${v}`)
      .join('  '),
);
