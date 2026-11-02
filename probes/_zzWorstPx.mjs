// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzWorstPx — the ONE pixel a shape is worst at, taken apart constraint by constraint.
//
// An aggregate says the AA is 0.913 off somewhere; it does not say which constraint returned what,
// nor whether the patch that painted the pixel is even the one whose boundary runs through it.
// This renders the shape the audit's way, finds the worst edge pixel, and prints every patch's
// composed coverage and every constraint's own answer at that point.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov } from '../src/renderer/cpatchCov.js';
import {
  rowSpans,
  patchBBox,
  insideContour,
  patchCoverLines,
  patchCoverHull,
} from '../src/renderer/cpatchConvert.js';
import { CP_KERNEL_HULL_SAMPLES } from '../src/renderer/cpatchPack.js';
import { segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const SI = +process.argv[3],
  N = +(process.env.N || 256),
  MODE = process.env.MODE || 'edge';
const r = sections.curveRangesByShape[SI];
const list = contoursToConverter(
  curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
  null,
);
const patches = [];
packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
const all = list.flat();
// THE AUDIT'S own FRAMING, so a pixel this names is the pixel the audit named. A probe that frames
// a shape differently reports a different worst pixel, and then nothing done about it moves the
// number being chased.
const bb = patchBBox(all);
const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
const pad = span * 0.04 + 1e-9;
const em = (span + 2 * pad) / N,
  x0 = bb[0] - pad,
  y0 = bb[1] - pad;
/// exact coverage of one pixel: exact spans in x, Gauss-Legendre in y. Not supersampling.
const GL = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
function truth(px, py) {
  let a = 0;
  for (const [t, w] of GL) {
    const y = py + 0.5 * em * t;
    let cov = 0;
    for (const sp of rowSpans(all, y) || [])
      cov += Math.max(0, Math.min(px + em / 2, sp[1]) - Math.max(px - em / 2, sp[0]));
    a += (w * 0.5 * cov) / em;
  }
  return a;
}
let worst = null;
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const px = x0 + (i + 0.5) * em,
      py = y0 + (j + 0.5) * em;
    const t = truth(px, py);
    // MODE=interior selects the worst pixel the shape covers whole and the kernel does not; the
    // default is the worst edge pixel. They are different defects and the worst of each is a
    // different pixel, so a probe that only knows one of them chases the wrong one.
    if (MODE === 'interior' ? !(t > 0.999) : !(t > 0.001 && t < 0.999)) continue;
    let open = 1;
    for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, px, py, em)));
    const got = 1 - open;
    const e = Math.abs(got - t);
    if (!worst || e > worst.e) worst = { e, px, py, t, got, i, j };
  }
if (!worst) {
  console.log('no edge pixels');
  process.exit(0);
}
const { px, py } = worst;
console.log(
  `shape ${SI}: ${patches.length} patches, worst edge pixel (${worst.i},${worst.j}) ` +
    `at (${px.toFixed(4)},${py.toFixed(4)}) em/px ${em.toFixed(5)}`,
);
console.log(
  `  painted ${worst.got.toFixed(4)}  exact ${worst.t.toFixed(4)}  off by ${worst.e.toFixed(4)}`,
);
for (let k = 0; k < patches.length; k++) {
  const p = patches[k];
  const c = patchCoverage(p, px, py, em);
  if (c <= 0.0005 && !process.env.ALL) continue;
  // IS THE FRAGMENT INSIDE this PATCH'S own LOOP? A convex cover built from points ON the curves,
  // with every plane pushed out to the exact support, CONTAINS those curves and therefore contains
  // the loop -- so a fragment inside the loop that the cover rejects means that reasoning is wrong
  // somewhere, and it is the difference between a tiling gap and a cover that is too tight.
  // WHAT FRACTION OF THE PIXEL DOES this PATCH'S own LOOP COVER? A point test at the center cannot
  // answer it, and the center is exactly what a hard seam step keys on -- so a patch covering a
  // third of the pixel reads as covering none of it.
  let area = 0;
  const NS = 16;
  for (let a = 0; a < NS; a++)
    for (let b2 = 0; b2 < NS; b2++)
      if (
        insideContour(p.curves, px + ((a + 0.5) / NS - 0.5) * em, py + ((b2 + 0.5) / NS - 0.5) * em)
      )
        area++;
  const inLoop = insideContour(p.curves, px, py);
  const kc = patchCoverLines(p.curves, CP_KERNEL_HULL_SAMPLES) || [];
  let worstPlane = Infinity,
    wpi = -1,
    wpk = -1;
  for (let h = 0; h < kc.length; h++) {
    const A = (kc[h][0] * px + kc[h][1] * py + kc[h][2]) / em;
    if (A < worstPlane) {
      worstPlane = A;
      wpi = h;
      wpk = kc[h][3];
    }
  }
  console.log(
    `  patch ${k}: composed ${c.toFixed(4)}  (${p.curves.length} curves)` +
      `  loop covers ${((area / (NS * NS)) * 100).toFixed(1)}% of the pixel (centre ${inLoop ? 'in' : 'out'})` +
      `  worst kernel hull plane ${wpi} kind=${wpk} at ${worstPlane.toFixed(3)} px`,
  );
  const res = {};
  for (let i = 0; i < p.impls.length; i++) {
    const sg = p.curves[i],
      pk = p.impls[i].packed;
    const sgn = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
    const v = curveCov(pk, sgn, !!sg.cut, segTightBBox(sg), px, py, em, res, sg);
    console.log(
      `      c${i} ${sg.t}${sg.cut ? ' CUT' : ''} kind=${pk.kind} cov=${v.toFixed(4)}` +
        ` sd=${res.sd !== undefined ? res.sd.toFixed(3) : '-'} boxPx=${res.boxPx !== undefined ? res.boxPx.toFixed(3) : '-'}`,
    );
  }
}
