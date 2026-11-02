// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _jaggyJoints — do jaggies cluster near smooth joints (a fact about the geometry), and if so
// WHICH joints?
//
// A JOINT is where two outline segments meet. It is SMOOTH when the incoming and outgoing unit
// tangents agree (|turn| below TURN, default 0.02 rad) -- there is no corner there, so a jaggy at
// one is a seam in the decomposition rather than a feature of the shape. It is SHARP otherwise.
//
// The measure is a RATE RATIO, not a count: the share of edge pixels within R px of a smooth joint
// that are jaggy, over the same share for edge pixels farther away. A count alone says nothing,
// because joints are where the pixels are.
//
// A jaggy is the both-axes definition: the signed error spikes
// past 0.25 against both neighbours along x, or along y, in the same direction.
//
//   node probes/lbAccuracy/_jaggyJoints.mjs FILE.svg[#shape] [FILE.svg ...]
//   CANVAS=512 SLICES=32 R=0.5 TURN=0.02 FIT=hull
//
// ── WHAT IT SHOWS ─────────────────────────────────────────────────────────────────────────────
// The fit matters: `FIT=hull` fits the CONTROL-POINT HULL rather than the box the renderer fits
// (see _lbRaster.shapesOf) and moves every number below.
//
//   tiger at 512 px, R = 0.5 px, TURN = 0.02 rad          hull fit -> renderer fit
//     within 0.5 px of a SMOOTH joint                        2.78%   ->  2.15%
//     within 0.5 px of a SHARP joint                         6.64%   ->  6.45%
//     away from any joint                                    2.24%   ->  2.10%
//     SMOOTH clustering factor                               1.24x   ->  1.03x
//     SHARP  clustering factor                               2.96x   ->  3.07x
//
// Jaggies do NOT cluster at smooth joints: on the renderer's fit smooth joints are jaggy at 1.03x
// the rate of everywhere else, which is no clustering at all. The ~3x at SHARP corners holds. It is
// a plateau, not a knife edge — over R in {0.25, 0.5, 1.0} px the smooth factor reads 0.99x /
// 1.03x / 1.13x and the sharp factor 3.37x / 3.07x / 2.77x.
import { loadSvg, shapesOf, viewOf, buildMesh, rasterMesh } from './_lbRaster.mjs';
import { refKit, exactCov } from './_lbAaRef.mjs';

console.warn = () => {};
const N = +(process.env.CANVAS || 512);
const SLICES = +(process.env.SLICES || 32);
const R = +(process.env.R || 0.5);
const TURN = +(process.env.TURN || 0.02);
const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: _jaggyJoints.mjs FILE.svg[#shape] ...');
  process.exit(2);
}

/// A segment's unit tangent at t = 0 and t = 1, from whatever control points it carries.
function tangents(sg) {
  const P = [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean);
  const nz = (a, b) => {
    const d = [b[0] - a[0], b[1] - a[1]];
    const L = Math.hypot(d[0], d[1]);
    return L > 1e-12 ? [d[0] / L, d[1] / L] : null;
  };
  let t0 = null,
    t1 = null;
  for (let i = 1; i < P.length && !t0; i++) t0 = nz(P[0], P[i]);
  for (let i = P.length - 2; i >= 0 && !t1; i--) t1 = nz(P[i], P[P.length - 1]);
  return [t0, t1, P[0], P[P.length - 1]];
}

let gSm = { near: 0, nearJ: 0, far: 0, farJ: 0 },
  gSh = { near: 0, nearJ: 0 };
for (const arg of args) {
  const [file, sel] = arg.split('#');
  const bundle = await loadSvg(file);
  const { shapes, bbox } = await shapesOf(bundle, { fit: process.env.FIT });
  const view = viewOf(bbox, N);
  const { rowSpans, contoursToConverter, closed } = await refKit();
  for (const sh of shapes) {
    if (sel != null && sel !== '' && sh.s !== +sel) continue;
    const built = await buildMesh(sh);
    if (!built) continue;
    // joints, in pixel coordinates
    const smooth = [],
      sharp = [];
    for (const c of sh.contours) {
      for (let i = 0; i < c.length; i++) {
        const a = tangents(c[i]),
          b = tangents(c[(i + 1) % c.length]);
        if (!a[1] || !b[0]) continue;
        const cross = a[1][0] * b[0][1] - a[1][1] * b[0][0];
        const dotp = a[1][0] * b[0][0] + a[1][1] * b[0][1];
        const turn = Math.abs(Math.atan2(cross, dotp));
        const p = [
          (a[3][0] - view.ox) / view.basePx - 0.5,
          (a[3][1] - view.oy) / view.basePx - 0.5,
        ];
        (turn < TURN ? smooth : sharp).push(p);
      }
    }
    const cv = contoursToConverter(sh.contours, null);
    if (!cv) continue;
    const curves = closed(cv);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of curves)
      for (const p of sg.P) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    const i0 = Math.max(1, Math.floor((x0 - view.ox) / view.basePx) - 2);
    const i1 = Math.min(N - 2, Math.ceil((x1 - view.ox) / view.basePx) + 2);
    const j0 = Math.max(1, Math.floor((y0 - view.oy) / view.basePx) - 2);
    const j1 = Math.min(N - 2, Math.ceil((y1 - view.oy) / view.basePx) + 2);
    if (i1 <= i0 || j1 <= j0) continue;
    const acc = new Float64Array(N * N).fill(1);
    rasterMesh(built.pk, view, acc, {}, null, null, null);
    const W = i1 - i0 + 1,
      H = j1 - j0 + 1;
    const sgn = new Float64Array(W * H),
      isEdge = new Uint8Array(W * H);
    for (let j = j0; j <= j1; j++) {
      const rc = new Map();
      for (let i = i0; i <= i1; i++) {
        const ex = exactCov(rowSpans, curves, i, j, view, SLICES, sh.evenOdd, rc);
        const k = (j - j0) * W + (i - i0);
        sgn[k] = 1 - acc[j * N + i] - ex;
        isEdge[k] = ex > 1e-6 && ex < 1 - 1e-6 ? 1 : 0;
      }
    }
    const at = (i, j) => sgn[(j - j0) * W + (i - i0)];
    const near = (pts, i, j) => {
      for (const p of pts)
        if (
          Math.abs(p[0] - i) <= R + 0.5 &&
          Math.abs(p[1] - j) <= R + 0.5 &&
          Math.hypot(p[0] - i, p[1] - j) <= R + 0.7072
        )
          return true;
      return false;
    };
    for (let j = j0 + 1; j < j1; j++)
      for (let i = i0 + 1; i < i1; i++) {
        if (!isEdge[(j - j0) * W + (i - i0)]) continue;
        const c = at(i, j);
        const hx =
          (c - at(i - 1, j) > 0.25 && c - at(i + 1, j) > 0.25) ||
          (at(i - 1, j) - c > 0.25 && at(i + 1, j) - c > 0.25);
        const hy =
          (c - at(i, j - 1) > 0.25 && c - at(i, j + 1) > 0.25) ||
          (at(i, j - 1) - c > 0.25 && at(i, j + 1) - c > 0.25);
        const jag = hx || hy;
        const nSm = near(smooth, i, j),
          nSh = near(sharp, i, j);
        if (nSm) {
          gSm.near++;
          if (jag) gSm.nearJ++;
        } else if (!nSh) {
          gSm.far++;
          if (jag) gSm.farJ++;
        }
        if (nSh && !nSm) {
          gSh.near++;
          if (jag) gSh.nearJ++;
        }
      }
  }
}
const rate = (a, b) => (b ? a / b : 0);
const rNear = rate(gSm.nearJ, gSm.near),
  rFar = rate(gSm.farJ, gSm.far),
  rSharp = rate(gSh.nearJ, gSh.near);
console.log(`R=${R} px, smooth joint = |turn| < ${TURN} rad, CANVAS=${N}`);
console.log(
  `  within ${R}px of a SMOOTH joint : ${gSm.nearJ} jaggy of ${gSm.near} edge px   rate ${(rNear * 100).toFixed(2)}%`,
);
console.log(
  `  within ${R}px of a SHARP  joint : ${gSh.nearJ} jaggy of ${gSh.near} edge px   rate ${(rSharp * 100).toFixed(2)}%`,
);
console.log(
  `  away from any joint            : ${gSm.farJ} jaggy of ${gSm.far} edge px   rate ${(rFar * 100).toFixed(2)}%`,
);
console.log(
  `  SMOOTH-JOINT CLUSTERING FACTOR  ${rFar > 0 ? (rNear / rFar).toFixed(2) + 'x' : 'n/a (no jaggies away from joints)'}`,
);
