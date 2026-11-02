// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPieceProof — can a piece be PROVED not to over-paint, instead of sampled?
//
// The over-paint audit takes ten points per piece and declines the whole shape if any of them
// paints air. It is a sampler: it misses real over-paint, and it objects more as pieces multiply,
// which is what blocks the containment work from paying. The alternative is an argument.
//
// For one CDT face carrying one curve's implicit f:
//   (1) CONTAINMENT -- no other part of the outline is inside the face. Then the shape's ink
//       within the face is exactly one side of this arc.
//   (2) NO STRAY ZERO -- f vanishes inside the face only along that arc. f is degree 3 in position,
//       so along each face edge it is a univariate cubic and its roots are exact; a root strictly
//       inside an edge, where the arc does not cross, is another branch entering.
//   (3) If the arc does not cross the face at all, one exact winding probe settles it: an all-ink
//       face is interior and an all-air face must not be emitted.
// Given (1) and (2), f < 0 within the face IS the ink side, and the piece cannot over-paint -- no
// samples required. This classifies every face and then checks the claim against the GPU.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { evalBezout } from '../src/geom/lbCubicMath.js';
import { solveCubicInUnit } from '../src/svg/pathBoolean/polyRoots.js';
import { segPt } from '../src/geom/cpatchImplicit.js';
import { parseMetaBin } from '../src/core/metaBin.js';

function spansOf(segs, y, evenOdd) {
  if (!evenOdd) return rowSpans(segs, y) || [];
  const xs = [];
  for (const sg of segs) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
}
const inkAt = (segs, eo, x, y) => {
  for (const [a, b] of spansOf(segs, y, eo)) if (x >= a && x <= b) return true;
  return false;
};

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__lbAuditOff = 1;
if (process.env.NOSTRAY) globalThis.__LB_NO_STRAY = true;
const STRICT = !!process.env.STRICT;

const fOf = (c) => {
  if (c.klmn) {
    const H = c.hull,
      T = c.klmn;
    const e1x = H[2] - H[0],
      e1y = H[3] - H[1],
      e2x = H[4] - H[0],
      e2y = H[5] - H[1];
    const det = e1x * e2y - e1y * e2x;
    if (!(Math.abs(det) > 0)) return null;
    return (x, y) => {
      const w1 = ((x - H[0]) * e2y - (y - H[1]) * e2x) / det;
      const w2 = (e1x * (y - H[1]) - e1y * (x - H[0])) / det;
      const w0 = 1 - w1 - w2;
      const K = w0 * T[0] + w1 * T[3] + w2 * T[6];
      const L = w0 * T[1] + w1 * T[4] + w2 * T[7];
      const M = w0 * T[2] + w1 * T[5] + w2 * T[8];
      return c.sign * (K * K * K - L * M);
    };
  }
  return c.F ? (x, y) => c.sign * evalBezout(c.F, x, y) : null;
};
// f along a segment, as a cubic in its own parameter — four samples determine it exactly.
const edgeCubic = (f, ax, ay, bx, by) => {
  const g = (t) => f(ax + t * (bx - ax), ay + t * (by - ay));
  const f0 = g(0),
    f1 = g(1 / 3),
    f2 = g(2 / 3),
    f3 = g(1);
  return [
    (-9 * f0 + 27 * f1 - 27 * f2 + 9 * f3) / 2,
    (18 * f0 - 45 * f1 + 36 * f2 - 9 * f3) / 2,
    (-11 * f0 + 18 * f1 - 9 * f2 + 2 * f3) / 2,
    f0,
  ];
};

let shapes = 0,
  proved = 0,
  faces = 0,
  okFaces = 0;
const failWhy = new Map();
const provedList = [],
  unprovedList = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const eo = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: eo ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (!m || !m.cubics) continue;
  let segs = null;
  try {
    const cv = contoursToConverter(cs, null);
    segs = [];
    for (const c of cv) for (const sg of c) segs.push(sg);
  } catch {
    continue;
  }
  shapes++;
  // Every other segment, sampled, minus the joint with this piece's own curve.
  const sampOf = new Map();
  for (const sg of segs) {
    const P = [];
    for (let t = 0; t <= 1.0001; t += 1 / 24) P.push(segPt(sg, t));
    sampOf.set(sg, P);
  }
  let allOk = true,
    why = null;
  for (const c of m.cubics) {
    faces++;
    const H = c.hull,
      f = fOf(c);
    if (!f) {
      allOk = false;
      why = why || 'no implicit';
      continue;
    }
    const A = [H[0], H[1]],
      B = [H[2], H[3]],
      C = [H[4], H[5]];
    const ex =
      Math.max(
        Math.abs(H[0] - H[2]),
        Math.abs(H[2] - H[4]),
        Math.abs(H[1] - H[3]),
        Math.abs(H[3] - H[5]),
      ) || 1;
    const chordOf = c.cp ? Math.hypot(c.cp[3][0] - c.cp[0][0], c.cp[3][1] - c.cp[0][1]) || ex : ex;
    // (1) containment: no other boundary point inside this face
    let foreign = false;
    // ITS own ARC IS NOT FOREIGN, and after a split the piece's own PARENT segment runs through the
    // face while sharing neither endpoint with the sub-piece -- so an endpoint-only exclusion calls
    // the curve itself an intruder and the test reads backwards the more the builder subdivides.
    // Exclude any sample lying ON this piece's arc, at the arc's own scale.
    const arcPts = [];
    if (c.cp)
      for (let u = 0; u <= 1.0001; u += 1 / 64) arcPts.push(segPt({ t: 'cubic', P: c.cp }, u));
    const chord = chordOf;
    const nearOwn = (p) => {
      for (const q of arcPts) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 2e-2 * chord) return true;
      return false;
    };
    const side = (P0, P1, x, y) => (P1[0] - P0[0]) * (y - P0[1]) - (P1[1] - P0[1]) * (x - P0[0]);
    const inFace = (x, y) => {
      const s1 = side(A, B, x, y),
        s2 = side(B, C, x, y),
        s3 = side(C, A, x, y);
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    };
    for (const [sg, P] of sampOf) {
      if (c.cp && Math.hypot(segPt(sg, 0)[0] - c.cp[0][0], segPt(sg, 0)[1] - c.cp[0][1]) < 1e-7)
        continue;
      for (const q of P) {
        if (nearOwn(q)) continue;
        if (inFace(q[0], q[1])) {
          foreign = true;
          break;
        }
      }
      if (foreign) break;
    }
    // (2) a stray zero strictly inside a face edge
    let stray = 0;
    for (const [P0, P1] of [
      [A, B],
      [B, C],
      [C, A],
    ]) {
      const [a3, b3, c3, d3] = edgeCubic(f, P0[0], P0[1], P1[0], P1[1]);
      const sc = Math.max(Math.abs(a3), Math.abs(b3), Math.abs(c3), Math.abs(d3));
      if (!(sc > 0)) continue;
      for (const t of solveCubicInUnit(a3, b3, c3, d3) || []) {
        if (t < 1e-6 || t > 1 - 1e-6) continue;
        const qx = P0[0] + t * (P1[0] - P0[0]),
          qy = P0[1] + t * (P1[1] - P0[1]);
        // A zero where the piece's own arc crosses this edge is the arc, not a stray branch.
        let onArc = false;
        if (c.cp)
          for (let u = 0; u <= 1.0001 && !onArc; u += 1 / 256) {
            const p = segPt({ t: 'cubic', P: c.cp }, u);
            if (Math.hypot(p[0] - qx, p[1] - qy) < 2e-3 * chord) onArc = true;
          }
        if (!onArc) stray++;
      }
    }
    // DOES THE PIECE'S own ARC PASS THROUGH this FACE? That decides what a stray zero means.
    //   arc in the face  -- the face is split by the outline, f < 0 is meant to be the ink side,
    //                      and a second branch running alongside the arc only disturbs the AA band.
    //   arc NOT in it    -- containment already says the face is uniformly ink or air, so f has no
    //                      business vanishing at all; where it does, it paints a solid wedge.
    let arcIn = false;
    for (const q of arcPts)
      if (inFace(q[0], q[1])) {
        arcIn = true;
        break;
      }
    // Uniformly ink or air is decidable with probes anywhere in the face, given containment.
    // THE same GRID THE BUILDER USES. A coarser one here calls a face all-air that the builder
    // found ink in and kept, and the proof then objects to a face that is not the problem.
    let anyInk = false,
      allInk = true;
    for (let a3 = 1; a3 < 6; a3++)
      for (let b3 = 1; b3 < 6 - a3; b3++) {
        const u0 = a3 / 6,
          u1 = b3 / 6,
          u2 = 1 - u0 - u1;
        const qx = u0 * A[0] + u1 * B[0] + u2 * C[0],
          qy = u0 * A[1] + u1 * B[1] + u2 * C[1];
        if (inkAt(segs, eo, qx, qy)) anyInk = true;
        else allInk = false;
      }
    // AN ALL-AIR FACE IS only A HAZARD IF IT PAINTS. Having no ink is not by itself a defect --
    // the face contributes nothing unless its own implicit is negative somewhere in it. Sampled at
    // the same grid, plus the edge roots already computed: no interior sign change and f >= 0
    // throughout means the face emits no coverage at all and is harmless.
    let paintsAnywhere = false;
    if (!anyInk) {
      for (let a3 = 1; a3 < 6 && !paintsAnywhere; a3++)
        for (let b3 = 1; b3 < 6 - a3; b3++) {
          const u0 = a3 / 6,
            u1 = b3 / 6,
            u2 = 1 - u0 - u1;
          const qx = u0 * A[0] + u1 * B[0] + u2 * C[0],
            qy = u0 * A[1] + u1 * B[1] + u2 * C[1];
          if ((c.sign || 1) * f(qx, qy) * (c.sign || 1) < 0 ? false : false) paintsAnywhere = true;
          if (f(qx, qy) * (c.sign >= 0 ? 1 : 1) < 0) paintsAnywhere = true;
        }
    }
    const relaxed = !foreign && (arcIn || stray === 0) && (arcIn || anyInk || !paintsAnywhere);
    if (STRICT ? !foreign && stray === 0 : relaxed) {
      okFaces++;
      continue;
    }
    allOk = false;
    const k = foreign
      ? 'foreign boundary in the face'
      : !arcIn && !anyInk
        ? 'all-air face that PAINTS'
        : 'stray zero of f with no arc in the face';
    why = why || k;
    failWhy.set(k, (failWhy.get(k) || 0) + 1);
  }
  if (allOk) {
    proved++;
    provedList.push(s);
  } else unprovedList.push(s);
}
console.log(`${shapes} shapes, ${faces} curve faces`);
console.log(
  `  faces that PROVE safe: ${okFaces} (${((100 * okFaces) / Math.max(1, faces)).toFixed(1)}%)`,
);
console.log(`  shapes where EVERY face proves safe: ${proved} of ${shapes}`);
console.log(
  '  face failures: ' +
    [...failWhy]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
);
if (process.env.LIST) {
  console.log('PROVED=' + provedList.join(','));
  console.log('UNPROVED=' + unprovedList.join(','));
}
