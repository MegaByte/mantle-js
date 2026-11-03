// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBranchDegree — are the curves whose implicit doubles back near their own arc the nearly
// DEGENERATE ones? A cubic whose image is almost a line has an implicit that almost factors, and
// the second factor runs alongside the arc. If that is what these are, a lower-degree
// representation of the same geometry has no such branch -- and the error of taking one is
// measurable, not a matter of taste.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { curveCov } from '../src/renderer/cpatchCov.js';
import { patchBBox } from '../src/renderer/cpatchConvert.js';
import { segPt, segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const ASSET = +(process.env.ASSET || 1024);
let ax0 = Infinity,
  ay0 = Infinity,
  ax1 = -Infinity,
  ay1 = -Infinity;
const shapes = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const list = contoursToConverter(
    curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
    null,
  );
  if (!list || !list.length) continue;
  const b = patchBBox(list.flat());
  ax0 = Math.min(ax0, b[0]);
  ay0 = Math.min(ay0, b[1]);
  ax1 = Math.max(ax1, b[2]);
  ay1 = Math.max(ay1, b[3]);
  shapes.push({ si, list });
}
const em = Math.max(ax1 - ax0, ay1 - ay0) / ASSET;

/// Max deviation, in em, of a cubic from its degree-reduced quadratic; and from its chord.
function degradeError(sg) {
  if (sg.t !== 'cubic') return { quad: 0, line: 0 };
  const P = sg.P;
  const Q = [
    P[0],
    [
      (3 * P[1][0] + 3 * P[2][0] - P[0][0] - P[3][0]) / 4,
      (3 * P[1][1] + 3 * P[2][1] - P[0][1] - P[3][1]) / 4,
    ],
    P[3],
  ];
  const qAt = (t) => {
    const u = 1 - t;
    return [
      u * u * Q[0][0] + 2 * u * t * Q[1][0] + t * t * Q[2][0],
      u * u * Q[0][1] + 2 * u * t * Q[1][1] + t * t * Q[2][1],
    ];
  };
  let dq = 0,
    dl = 0;
  const A = P[0],
    B = P[3],
    dx = B[0] - A[0],
    dy = B[1] - A[1],
    L = Math.hypot(dx, dy) || 1;
  for (let k = 0; k <= 64; k++) {
    const t = k / 64,
      c = segPt(sg, t),
      q = qAt(t);
    dq = Math.max(dq, Math.hypot(c[0] - q[0], c[1] - q[1]));
    dl = Math.max(dl, Math.abs((-dy * (c[0] - A[0]) + dx * (c[1] - A[1])) / L));
  }
  return { quad: dq, line: dl };
}

let n = 0,
  bad = 0;
const badQ = [],
  allQ = [];
for (const sh of shapes) {
  const patches = [];
  try {
    packCPatchShape(sh.list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {
    continue;
  }
  const seen = new Set();
  for (const p of patches)
    for (let k = 0; k < p.curves.length; k++) {
      const sg = p.curves[k],
        im = p.impls[k];
      if (sg.cut || sg.t === 'line' || !im || !im.packed) continue;
      const id = sg.P.map((q) => q.join(',')).join(';');
      if (seen.has(id)) continue;
      seen.add(id);
      n++;
      const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
      const box = segTightBBox(sg);
      // Walk outward from the arc's own midpoint and ask whether coverage comes back.
      let comesBack = false;
      const a = segPt(sg, 0.5),
        a2 = segPt(sg, 0.5 + 1e-4);
      const tx = a2[0] - a[0],
        ty = a2[1] - a[1],
        L = Math.hypot(tx, ty);
      if (L > 0) {
        let nx = -ty / L,
          ny = tx / L;
        if (nx * (p.inside[0] - a[0]) + ny * (p.inside[1] - a[1]) > 0) {
          nx = -nx;
          ny = -ny;
        }
        let lo = 1;
        for (let s2 = 0.05; s2 <= 1.5; s2 += 0.05) {
          const c = curveCov(
            im.packed,
            sgn,
            false,
            box,
            a[0] + nx * s2 * em,
            a[1] + ny * s2 * em,
            em,
            {},
          );
          if (c < lo) lo = c;
          else if (c - lo > 0.25 && lo < 0.4) {
            comesBack = true;
            break;
          }
        }
      }
      const d = degradeError(sg);
      allQ.push(d.quad / em);
      if (comesBack) {
        bad++;
        badQ.push(d.quad / em);
      }
    }
}
const q = (arr, f) =>
  arr.length
    ? arr.slice().sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(f * arr.length))]
    : NaN;
console.log(
  `${n} curves; ${bad} have coverage come back within 1.5px of their own arc (${((100 * bad) / Math.max(1, n)).toFixed(1)}%)`,
);
console.log(
  `  distance from the CUBIC to its degree-reduced QUADRATIC, in pixels at a ${ASSET}px render:`,
);
console.log(
  `    those curves: median ${q(badQ, 0.5).toExponential(2)}, p90 ${q(badQ, 0.9).toExponential(2)}, max ${q(badQ, 1).toExponential(2)}`,
);
console.log(
  `    all curves:   median ${q(allQ, 0.5).toExponential(2)}, p90 ${q(allQ, 0.9).toExponential(2)}, max ${q(allQ, 1).toExponential(2)}`,
);
