// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzInteriorCause — why an interior pixel comes out short, and what would fix it.
//
// The shortfall is not one defect. It can be the DECOMPOSITION (the patches do not tile the pixel),
// the COVERAGE (each patch under-reports its own share), or the COMPOSITOR (each share is right and
// OVER cannot add them). Those need different fixes and only one of them is in the kernel, so this
// separates them: it measures what the patches' own LOOPS cover, what OVER gives, and what SUM
// would have given.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov, exactBoxCov } from '../src/renderer/cpatchCov.js';
import { patchCoverLines } from '../src/renderer/cpatchConvert.js';
import { CP_KERNEL_HULL_SAMPLES } from '../src/renderer/cpatchPack.js';
import { segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';
import { rowSpans, patchBBox, insideContour } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const N = +(process.env.N || 256);
const GL = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const s = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(s.curves);
let n = 0,
  sumFix = 0,
  loopTiles = 0,
  zeroPatch = 0;
// WHICH GATE BINDS on the patch that owns the pixel: one of its curve constraints, or a plane of
// its cover. They are different fixes, so the count has to be split before either can be tried.
const byGate = new Map();
for (const r of s.curveRangesByShape || []) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = cs && cs.length ? contoursToConverter(cs, null) : null;
  if (!list || !list.length) continue;
  const ps = [];
  try {
    packCPatchShape(list, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  if (!ps.length) continue;
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) all.push({ t: 'line', P: [b, a] });
  }
  const bb = patchBBox(all),
    span = Math.max(bb[2] - bb[0], bb[3] - bb[1]),
    pad = span * 0.04 + 1e-9;
  const em = (span + 2 * pad) / N,
    x0 = bb[0] - pad,
    y0 = bb[1] - pad;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const px = x0 + (i + 0.5) * em,
        py = y0 + (j + 0.5) * em;
      let t = 0;
      for (const [q, w] of GL) {
        const y = py + 0.5 * em * q;
        let c2 = 0;
        for (const sp of rowSpans(all, y) || [])
          c2 += Math.max(0, Math.min(px + em / 2, sp[1]) - Math.max(px - em / 2, sp[0]));
        t += (w * 0.5 * c2) / em;
      }
      if (!(t > 0.999)) continue;
      let open = 1,
        sum = 0,
        anyZeroButCovering = 0;
      for (const p of ps) {
        const c2 = Math.min(1, Math.max(0, patchCoverage(p, px, py, em)));
        open *= 1 - c2;
        sum += c2;
        if (c2 <= 0.001 && insideContour(p.curves, px, py)) anyZeroButCovering++;
      }
      if (!(t - (1 - open) > 0.05)) continue;
      n++;
      if (Math.min(1, sum) >= t - 0.05) sumFix++;
      if (anyZeroButCovering) zeroPatch++;
      let area = 0;
      const NS = 8;
      for (let a2 = 0; a2 < NS; a2++)
        for (let b2 = 0; b2 < NS; b2++) {
          const qx = px + ((a2 + 0.5) / NS - 0.5) * em,
            qy = py + ((b2 + 0.5) / NS - 0.5) * em;
          for (const p of ps)
            if (insideContour(p.curves, qx, qy)) {
              area++;
              break;
            }
        }
      if (area / (NS * NS) >= 0.95) loopTiles++;
      // The owning patch is the one that paints the most here; ask what held IT back.
      let own = null,
        ownC = -1;
      for (const p of ps) {
        const c2 = patchCoverage(p, px, py, em);
        if (c2 > ownC) {
          ownC = c2;
          own = p;
        }
      }
      if (own) {
        let cMin = 1,
          cutMin = 1;
        const res = {};
        for (let k = 0; k < own.impls.length; k++) {
          const sg = own.curves[k],
            pk = own.impls[k].packed;
          const sgn = packedEval(pk, own.inside[0], own.inside[1]) >= 0 ? 1 : -1;
          const v = curveCov(pk, sgn, !!sg.cut, segTightBBox(sg), px, py, em, res, sg);
          if (sg.cut) cutMin = Math.min(cutMin, v);
          else cMin = Math.min(cMin, v);
        }
        let hMin = 1,
          hKind = -1;
        for (const h of patchCoverLines(own.curves, CP_KERNEL_HULL_SAMPLES) || []) {
          const A = (h[0] * px + h[1] * py + h[2]) / em;
          const v = h[3] === 2 ? exactBoxCov(h[0], h[1], A) : A >= 0 ? 1 : 0;
          if (v < hMin) {
            hMin = v;
            hKind = h[3];
          }
        }
        const g =
          hMin < Math.min(cMin, cutMin)
            ? `cover plane, kind ${hKind}`
            : cutMin < cMin
              ? 'a cut'
              : 'a curve constraint';
        byGate.set(g, (byGate.get(g) | 0) + 1);
      }
    }
}
console.log(`${n} under-painted interior px`);
console.log(
  `  ${loopTiles} have the pixel tiled by the patches' own LOOPS -- the decomposition is right`,
);
console.log(
  `  ${sumFix} would be correct if the patches' coverages were SUMMED rather than OVERed`,
);
console.log(`  ${zeroPatch} have a patch reporting ZERO at a point its own loop contains`);
console.log('  what held the OWNING patch back:');
for (const [k, v] of [...byGate].sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(v).padStart(4)}  ${k}`);
