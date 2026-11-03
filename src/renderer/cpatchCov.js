// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { convexQuadraticSign } from '../geom/cpatchImplicit.js';
/// The CPatch fragment kernel, on the CPU.
///
/// So this exists to answer the other question -- what will the kernel paint -- and it must match
/// _cpatchCoverage.glsl term for term or it is worse than nothing. A model that mispredicts is not
/// a weak guard, it is a guard that endorses the wrong change: a model that cannot see a seam
/// approves kernel changes that are far worse on screen.
///
/// Checked against the screen. Run on the patches the RENDERER builds -- packCPatchShape's own,
/// via its onPatches seam, holes and all -- it reports spill for the overlap of two oppositely
/// wound circles close to what the route paints over, and none for a cubic pear and a circle,
/// both of which paint exactly. It sees the leak, on the right shape, at the right size, and stays
/// quiet on the shapes that are right.
///
/// It has to be given those patches and not a per-cycle convert's: the renderer passes HOLES to
/// the converter and gets a different decomposition from a per-cycle convert, and a leak can exist
/// only in the renderer's.
///

import {
  K_COMP,
  K_FRAME,
  CPK_LINE,
  CPK_QUAD,
  CPK_CUT,
  CPK_KLMN,
  CPK_BEZ,
  CPK_RQUAD,
  segTightBBox,
  packedEval,
  segStart,
  segEnd,
  segTangent,
} from '../geom/cpatchImplicit.js';
import { segAffMin, loopSignedArea } from './cpatchConvert.js';
import { rowSpans, patchCoverLines, patchCoverHull } from './cpatchConvert.js';
import {
  CP_KERNEL_HULL_SAMPLES,
  CP_HULL_ROW_SAMPLES,
  arcIs3,
  coverOffsetDirs,
  K_ROWS,
} from './cpatchPack.js';
import { mantleDebugHook } from '../core/diagnostics.js';

const K_KERNEL_COVER = Symbol('cp.kernelCover');
/// The polygon the rasterizer clips, cached beside the rows. It is a DIFFERENT hull from the
/// rows' -- the polygon is free to be tight because the rasterizer clips it, while every row is
/// evaluated per fragment.
const K_QUAD_COVER = Symbol('cpQuadCover');
/// What the CPatch vertex shader adds along each cover vertex's offset direction, in pixels
/// (see _cpatchVertexSetup.glsl: `aPos + aTC.xy * (1.5 * epp)`).
// Must match the vertex shader's push (cpatchVertexSetup). Hookable so the model can sweep it
// without a rebuild; the shader constant is the one the renderer uses.
//
// every KNOB IN this FILE IS READ AT CALL TIME, not captured at module scope: a flag set after
// the module loaded -- a probe's arm, or a flag a pooled worker applies per message -- must be
// the one the next evaluation uses.
const quadDilatePx = () => {
  const v = mantleDebugHook('__CP_QUAD_DILATE_PX');
  return v === undefined ? 1.5 : v;
};
/// _cpatchCoverage.glsl's CP_HULL16_DILATE and CP_HULL_AGREE.
const hull16Dilate = () => {
  const v = mantleDebugHook('__CP_HULL16_DILATE');
  return v === undefined ? 0.0 : +v;
};
const hullAgree = () => {
  const v = mantleDebugHook('__CP_HULL_AGREE');
  return v === undefined ? 0.0015 : +v;
};

/// Half a pixel box's widest projection: past this exactBoxCov saturates.
export const CP_AA_REACH = 0.7072;

function obbBox(seg) {
  if (seg._cpObb !== undefined) return seg._cpObb;
  const b = segTightBBox(seg).slice();
  const a = segStart(seg),
    e = segEnd(seg);
  const dx = e[0] - a[0],
    dy = e[1] - a[1],
    L = Math.hypot(dx, dy);
  if (L > 1e-12) {
    const nx = -dy / L,
      ny = dx / L;
    // The exact support either side of the chord's line: max f = -min(-f).
    b.strip = [nx, ny, segAffMin(seg, nx, ny).m, -segAffMin(seg, -nx, -ny).m];
  }
  seg._cpObb = b;
  return b;
}

/// How far past a seam a patch still claims, in pixels.
/// How far past a seam a patch claims: A THOUSANDTH OF A PIXEL, WHICH IS ROUNDING AND NOT OVERLAP.

const CP_POS_REL = 9.5367432e-7;
const CP_CUT_TIE = 0.0009765625; // in pixels: the kernel's, for a center exactly on a seam
let _frame = [0, 0]; // the patch being evaluated's K_FRAME, set by patchCoverage
const cutSlack = (x, y, emPerPx) =>
  mantleDebugHook('__CP_CUT_SLACK') ??
  (CP_POS_REL * (Math.abs(x - _frame[0]) + Math.abs(y - _frame[1]))) / (emPerPx > 0 ? emPerPx : 1) +
    CP_CUT_TIE;

/// THE MID-RAMP GATE, the HULL's alone (the kernel's CP_SEAM_NEAR): where the patch's own coverage is under a half and a
/// drawn arc of it is within reach, a hull plane contributes its exact area instead of its step. Seams are owned and relax
/// nowhere: a seam is a partition -- except where the shape's own edge runs through the same pixel.
///
/// The threshold is a half (`nearT`). A higher one under-paints more; a lower one, or a hard step everywhere, leaves more AA
/// error and more non-monotone ramps; relaxing everywhere under-paints badly.
///
const nearT = () => mantleDebugHook('__CP_NEAR_T') || 0.5;

/// Exact coverage of the pixel box [-1/2,1/2]^2 by the half-plane {p : n.p <= d}, |n| = 1.
/// _boxCov.glsl's exactBoxCov, which is what the kernel calls.
export function exactBoxCov(nx, ny, d) {
  const a = Math.max(Math.abs(nx), Math.abs(ny));
  const b = Math.min(Math.abs(nx), Math.abs(ny));
  const s = 0.5 * (a + b); // |d| beyond which the box is fully in/out
  const t = 0.5 * (a - b); // |d| below which the cut is a full-width band
  if (d <= -s) return 0.0;
  if (d >= s) return 1.0;
  const ab = Math.max(2.0 * a * b, 1e-12);
  if (d <= -t) return ((d + s) * (d + s)) / ab; // corner triangle
  if (d >= t) return 1.0 - ((s - d) * (s - d)) / ab; // complementary corner
  return 0.5 + d / Math.max(a, 1e-12); // band: linear in d
}

/// Exact pixel-box coverage of the INTERSECTION of half-planes {p : n.p <= d}, |n| = 1, box =
/// [-1/2,1/2]^2 -- _boxCov.glsl's exactBoxCov2 and exactBoxCov3, which is what the kernel calls.
/// Two outline constraints inside one pixel combine as the
/// Area of both half-planes, and a relaxed seam paints the intersection of those two with its own
/// side of the tightest cut.
///
/// SUTHERLAND-HODGMAN AND SHOELACE, the same kernel and the same order of operations as the
/// shader's, because a second derivation is a second thing to drift. A convex clip adds at most
/// one vertex per pass, so the box's four corners never outgrow the eight slots.
/// The normals come in outward. exactBoxCov reads only |n.x| and |n.y| and is therefore EVEN in
/// the normal -- an inward normal has always worked there by accident. This clips a REAL polygon
/// and is not even, so a caller holding a constraint's inward gradient must negate it, exactly as
/// _cpatchCoverage.glsl does (`exactBoxCov2(-exN1, exD1, ...)`).
function boxClipArea(planes) {
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  for (const [nx, ny, d] of planes) {
    const tmp = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[i + 1 === poly.length ? 0 : i + 1];
      const fa = nx * a[0] + ny * a[1] - d,
        fb = nx * b[0] + ny * b[1] - d;
      if (fa <= 0.0 && tmp.length < 8) tmp.push(a);
      if (fa < 0.0 !== fb < 0.0 && tmp.length < 8) {
        const s = fa / (fa - fb);
        tmp.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      }
    }
    poly = tmp;
    if (!poly.length) return 0.0;
  }
  let area = 0.0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[i + 1 === poly.length ? 0 : i + 1];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(area) * 0.5;
}
export function exactBoxCov2(n1x, n1y, d1, n2x, n2y, d2) {
  return boxClipArea([
    [n1x, n1y, d1],
    [n2x, n2y, d2],
  ]);
}
export function exactBoxCov3(n1x, n1y, d1, n2x, n2y, d2, n3x, n3y, d3) {
  return boxClipArea([
    [n1x, n1y, d1],
    [n2x, n2y, d2],
    [n3x, n3y, d3],
  ]);
}
/// The kernel's areas as it takes them: cpExactBoxCov23 in _cpatchCoverage.glsl, which
/// clips no polygon. `[three, two]`: the box under planes 1 and 2, and under all three when `third`.
/// Green's theorem -- half the sum, over the bounding lines, of each line's offset times the length
/// the other constraints leave standing -- with the kernel's own tie-break (the k-th plane moved
/// inward by (k+1) 2e-6 px) and its parallel floor, so this is the same arithmetic in float64. An
/// ABSENT plane is (0, 0, 1). boxClipArea above stays the exact reference both are held to. A carried
/// crossing brings its line's negated sign as the kernel's does; unfused float64 already had it.
function greenCross(px, py, tx, ty, nx, ny, d) {
  let a = nx * tx + ny * ty;
  a = Math.abs(a) < 1e-8 ? (a < 0 ? -1e-8 : 1e-8) : a;
  return [(d - (nx * px + ny * py)) / a, a];
}
/** @param {number[]} param0 @param {number[]} iv */
const greenKeep = ([r, a], iv) => {
  if (a > 0) iv[1] = Math.min(iv[1], r);
  else iv[0] = Math.max(iv[0], r);
};
/// A plane pair's crossing, found on line a and carried to line b THROUGH THE POINT (see cpGreenMap).
const greenMap = (pa, ta, r, pb, tb) =>
  ((pa[0] + r * ta[0] - pb[0]) * tb[0] + (pa[1] + r * ta[1] - pb[1]) * tb[1]) /
  (tb[0] * tb[0] + tb[1] * tb[1]);
function greenSlab(px, py, tx, ty) {
  const qx = Math.abs(tx) < 1e-8 ? (tx < 0 ? -1e-8 : 1e-8) : tx,
    qy = Math.abs(ty) < 1e-8 ? (ty < 0 ? -1e-8 : 1e-8) : ty;
  const lx = (-0.5 - px) / qx,
    hx = (0.5 - px) / qx,
    ly = (-0.5 - py) / qy,
    hy = (0.5 - py) / qy;
  return [
    Math.max(Math.min(lx, hx), Math.min(ly, hy)),
    Math.min(Math.max(lx, hx), Math.max(ly, hy)),
  ];
}
export function cpExactBoxCov23(n1x, n1y, d1, n2x, n2y, d2, n3x, n3y, d3, third) {
  d1 -= 2e-6 * Math.hypot(n1x, n1y);
  d2 -= 4e-6 * Math.hypot(n2x, n2y);
  d3 -= 6e-6 * Math.hypot(n3x, n3y);
  let a2 = 0,
    a3 = 0;
  for (const [bx, by] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]) {
    const px = 0.5 * bx,
      py = 0.5 * by,
      iv = [-0.5, 0.5];
    greenKeep(greenCross(px, py, -by, bx, n1x, n1y, d1), iv);
    greenKeep(greenCross(px, py, -by, bx, n2x, n2y, d2), iv);
    a2 += 0.25 * Math.max(0, iv[1] - iv[0]);
    greenKeep(greenCross(px, py, -by, bx, n3x, n3y, d3), iv);
    a3 += 0.25 * Math.max(0, iv[1] - iv[0]);
  }
  const line = (nx, ny, d) => {
    const L = nx * nx + ny * ny;
    return [
      [nx * (d / L), ny * (d / L)],
      [-ny, nx],
    ];
  };
  const [p1, t1] = line(n1x, n1y, d1),
    has2 = n2x * n2x + n2y * n2y > 0;
  const [p2, t2] = has2
    ? line(n2x, n2y, d2)
    : [
        [0, 0],
        [-n2y, n2x],
      ];
  const dotT = (nx, ny, t) => Math.abs(nx * t[0] + ny * t[1]) >= 1e-8;
  const c12 = greenCross(...p1, ...t1, n2x, n2y, d2),
    c13 = greenCross(...p1, ...t1, n3x, n3y, d3);
  let iv = greenSlab(...p1, ...t1);
  greenKeep(c12, iv);
  a2 += 0.5 * d1 * Math.max(0, iv[1] - iv[0]);
  greenKeep(c13, iv);
  a3 += 0.5 * d1 * Math.max(0, iv[1] - iv[0]);
  let c23 = [0, 1];
  if (has2) {
    const c21 = greenCross(...p2, ...t2, n1x, n1y, d1);
    if (dotT(n2x, n2y, t1)) {
      c21[0] = greenMap(p1, t1, c12[0], p2, t2);
      c21[1] = -c12[1];
    }
    c23 = greenCross(...p2, ...t2, n3x, n3y, d3);
    iv = greenSlab(...p2, ...t2);
    greenKeep(c21, iv);
    a2 += 0.5 * d2 * Math.max(0, iv[1] - iv[0]);
    greenKeep(c23, iv);
    a3 += 0.5 * d2 * Math.max(0, iv[1] - iv[0]);
  }
  const two = Math.min(Math.max(a2, 0), 1);
  if (!third || !(n3x * n3x + n3y * n3y > 0)) return [two, two];
  const [p3, t3] = line(n3x, n3y, d3);
  const c31 = greenCross(...p3, ...t3, n1x, n1y, d1),
    c32 = greenCross(...p3, ...t3, n2x, n2y, d2);
  if (dotT(n3x, n3y, t1)) {
    c31[0] = greenMap(p1, t1, c13[0], p3, t3);
    c31[1] = -c13[1];
  }
  if (has2 && dotT(n3x, n3y, t2)) {
    c32[0] = greenMap(p2, t2, c23[0], p3, t3);
    c32[1] = -c23[1];
  }
  iv = greenSlab(...p3, ...t3);
  greenKeep(c31, iv);
  greenKeep(c32, iv);
  a3 += 0.5 * d3 * Math.max(0, iv[1] - iv[0]);
  return [Math.min(Math.max(a3, 0), 1), two];
}

/// The packed implicit AND its gradient. packedEval gives the value alone; the coverage needs the
/// gradient to turn it into a distance, so this is CP_EVAL from the shader rather than a second
/// spelling of packedEval.
function evalGrad(pk, x, y, out) {
  const a = pk.a,
    k = pk.kind;
  const A0 = a[0][0] * x + a[0][1] * y + a[0][2];
  if (k === CPK_LINE || k === CPK_CUT) {
    out[0] = A0;
    out[1] = a[0][0];
    out[2] = a[0][1];
    return;
  }
  const A1 = a[1][0] * x + a[1][1] * y + a[1][2];
  if (k === CPK_QUAD) {
    out[0] = A0 * A0 - A1;
    out[1] = 2.0 * A0 * a[0][0] - a[1][0];
    out[2] = 2.0 * A0 * a[0][1] - a[1][1];
    return;
  }
  const A2 = a[2][0] * x + a[2][1] * y + a[2][2];
  if (k === CPK_RQUAD) {
    out[0] = A0 * A0 - A1 * A2;
    out[1] = 2.0 * A0 * a[0][0] - A2 * a[1][0] - A1 * a[2][0];
    out[2] = 2.0 * A0 * a[0][1] - A2 * a[1][1] - A1 * a[2][1];
    return;
  }
  if (k === CPK_KLMN) {
    out[0] = A0 * A0 * A0 - A1 * A2;
    out[1] = 3.0 * A0 * A0 * a[0][0] - A2 * a[1][0] - A1 * a[2][0];
    out[2] = 3.0 * A0 * A0 * a[0][1] - A2 * a[1][1] - A1 * a[2][1];
    return;
  }
  const A3 = a[3][0] * x + a[3][1] * y + a[3][2];
  const C0 = pk.c[0],
    C1 = pk.c[1];
  out[0] = C1 * A0 * A3 - C0 * C0 * A0 - C1 * A1 * A1 + 2.0 * C0 * A1 * A2 - A3 * A2 * A2;
  out[1] =
    (C1 * A3 - C0 * C0) * a[0][0] +
    (C1 * A0 - A2 * A2) * a[3][0] +
    (2.0 * C0 * A2 - 2.0 * C1 * A1) * a[1][0] +
    (2.0 * C0 * A1 - 2.0 * A3 * A2) * a[2][0];
  out[2] =
    (C1 * A3 - C0 * C0) * a[0][1] +
    (C1 * A0 - A2 * A2) * a[3][1] +
    (2.0 * C0 * A2 - 2.0 * C1 * A1) * a[1][1] +
    (2.0 * C0 * A1 - 2.0 * A3 * A2) * a[2][1];
}

const _fg = [0, 0, 0],
  _fq = [0, 0, 0];

/// THE CLOSEST POINT ON THE DRAWN ARC, IN THE TERMS THE KERNEL WILL HAVE IT.
///
/// A dense sample-and-golden-section search settles WHAT the answer is but is not a thing a
/// fragment shader can run. This is the same quantity computed from four control points and a weight -- exactly what the
/// wire carries in texels 5 and 6 -- as the roots of the closest-point polynomial (see arcDistK).
const _bp = [0, 0, 0, 0];
/// B(t) and B'(t) ON THE CURVE'S own DEGREE. A quadratic is evaluated as a quadratic, a rational
/// quadratic as a rational one, a cubic as a cubic -- the same rule the stroke shaders follow. The
/// wire says which in bit 5 of the kind (see arcIs3 in cpatchPack), so nothing here has to guess.
///
/// Three paths rather than one elevated cubic, and the cheapest of them is the common one: a
/// polynomial quadratic costs no divide at all, where routing it through the rational form pays one
/// per evaluation and the arc solve runs sixteen of them per band fragment.
function arcEval(g, t, out) {
  const u = 1 - t;
  const P0 = g.P0,
    P1 = g.P1,
    P2 = g.P2;
  // A line is its own native degree. Elevating it to a quadratic to reuse the branch below would
  // compute the same point through three multiplies and a rounding, for a curve whose position and
  // tangent are one subtraction each.
  if (g.deg === 1) {
    out[0] = P0[0] + t * (P1[0] - P0[0]);
    out[1] = P0[1] + t * (P1[1] - P0[1]);
    out[2] = P1[0] - P0[0];
    out[3] = P1[1] - P0[1];
    return;
  }
  if (g.deg === 2) {
    if (g.w === 1) {
      const b0 = u * u,
        b1 = 2 * u * t,
        b2 = t * t;
      out[0] = b0 * P0[0] + b1 * P1[0] + b2 * P2[0];
      out[1] = b0 * P0[1] + b1 * P1[1] + b2 * P2[1];
      const c0 = 2 * u,
        c1 = 2 * t;
      out[2] = c0 * (P1[0] - P0[0]) + c1 * (P2[0] - P1[0]);
      out[3] = c0 * (P1[1] - P0[1]) + c1 * (P2[1] - P1[1]);
      return;
    }
    // The homogeneous quadratic and its derivative, by the quotient rule.
    const w = g.w;
    const b0 = u * u,
      b1 = 2 * u * t * w,
      b2 = t * t;
    const hx = b0 * P0[0] + b1 * P1[0] + b2 * P2[0];
    const hy = b0 * P0[1] + b1 * P1[1] + b2 * P2[1];
    const hw = b0 + b1 + b2;
    const d0 = -2 * u,
      d1 = 2 * w * (1 - 2 * t),
      d2 = 2 * t;
    const dx = d0 * P0[0] + d1 * P1[0] + d2 * P2[0];
    const dy = d0 * P0[1] + d1 * P1[1] + d2 * P2[1];
    const dw = d0 + d1 + d2;
    const iw = hw !== 0 ? 1 / hw : 0; // a zero divisor, not a magnitude
    out[0] = hx * iw;
    out[1] = hy * iw;
    out[2] = (dx - out[0] * dw) * iw;
    out[3] = (dy - out[1] * dw) * iw;
    return;
  }
  const P3 = g.P3;
  const b0 = u * u * u,
    b1 = 3 * u * u * t,
    b2 = 3 * u * t * t,
    b3 = t * t * t;
  out[0] = b0 * P0[0] + b1 * P1[0] + b2 * P2[0] + b3 * P3[0];
  out[1] = b0 * P0[1] + b1 * P1[1] + b2 * P2[1] + b3 * P3[1];
  const c0 = 3 * u * u,
    c1 = 6 * u * t,
    c2 = 3 * t * t;
  out[2] = c0 * (P1[0] - P0[0]) + c1 * (P2[0] - P1[0]) + c2 * (P3[0] - P2[0]);
  out[3] = c0 * (P1[1] - P0[1]) + c1 * (P2[1] - P1[1]) + c2 * (P3[1] - P2[1]);
}
/// A rational quadratic is not defined everywhere. Its homogeneous denominator vanishes off the
/// arc, and past that zero the point flies through infinity and comes back -- so a seed there is
/// not on the extension at all. Polynomials are defined for every t.
function arcDefined(g, t) {
  if (g.deg !== 2 || g.w === 1) return true;
  const u = 1 - t;
  return u * u + 2 * u * t * g.w + t * t > 0;
}

function closestPoly(g, px, py) {
  // (B(t) - p).B'(t), or for a conic the numerator u.v, in the power basis: c[k] multiplies t^k.
  const mul = (a, b) => {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j];
    return r;
  };
  const add = (a, b) => {
    const r = new Array(Math.max(a.length, b.length)).fill(0);
    a.forEach((v, i) => {
      r[i] += v;
    });
    b.forEach((v, i) => {
      r[i] += v;
    });
    return r;
  };
  const scale = (a, k) => a.map((v) => v * k);
  const der = (a) => a.slice(1).map((v, i) => v * (i + 1));
  // One axis of a Bezier of RELATIVE points (the curve minus p), in the power basis.
  const basis = (Q, k) => {
    const q = Q.map((pt) => pt[k]);
    if (q.length === 2) return [q[0], q[1] - q[0]];
    if (q.length === 3) return [q[0], 2 * (q[1] - q[0]), q[0] - 2 * q[1] + q[2]];
    return [q[0], 3 * (q[1] - q[0]), 3 * (q[0] - 2 * q[1] + q[2]), q[3] - q[0] + 3 * (q[1] - q[2])];
  };
  const rel = (pt, k = 1) => [k * (pt[0] - px), k * (pt[1] - py)];
  if (g.deg === 2 && g.w !== 1) {
    // u(t) = h(t) - p hw(t) is the quadratic Bezier of (P0 - p, w (P1 - p), P2 - p), hw = 1 + 2(w - 1)t + (2 - 2w)t^2.
    const Q = [rel(g.P0), rel(g.P1, g.w), rel(g.P2)],
      ux = basis(Q, 0),
      uy = basis(Q, 1),
      W = [1, 2 * (g.w - 1), 2 - 2 * g.w];
    const vx = add(mul(der(ux), W), scale(mul(ux, der(W)), -1)),
      vy = add(mul(der(uy), W), scale(mul(uy, der(W)), -1));
    return add(mul(ux, vx), mul(uy, vy)).slice(0, 5); // v's cubic terms cancel: a quartic
  }
  const Q = (
    g.deg === 1 ? [g.P0, g.P1] : g.deg === 2 ? [g.P0, g.P1, g.P2] : [g.P0, g.P1, g.P2, g.P3]
  ).map((pt) => rel(pt));
  const bx = basis(Q, 0),
    by = basis(Q, 1);
  return add(mul(bx, der(bx)), mul(by, der(by)));
}
function polyRoots01(c) {
  // Roots in (0, 1), ascending, by the descending chain: each level's roots bracket the next one's.
  const ev = (a, t) => {
    let v = 0;
    for (let i = a.length - 1; i >= 0; i--) v = v * t + a[i];
    return v;
  };
  let n = c.length - 1;
  while (n > 0 && c[n] === 0) n--;
  const chain = [c.slice(0, n + 1)];
  for (let k = 1; k < n; k++) {
    const q = chain[k - 1];
    chain.push(q.slice(1).map((v, i) => v * (i + 1)));
  }
  let rts = [];
  for (let lv = chain.length - 1; lv >= 0; lv--) {
    const q = chain[lv],
      nxt = [];
    let lo = 0,
      flo = ev(q, 0);
    for (let i = 0; i <= rts.length; i++) {
      const hi = i === rts.length ? 1 : rts[i],
        fhi = ev(q, hi);
      if (flo === 0 && lo > 0) nxt.push(lo);
      if (flo * fhi < 0) {
        let x = lo,
          y = hi,
          fx = flo;
        for (let k = 0; k < 60; k++) {
          const m = 0.5 * (x + y),
            fm = ev(q, m);
          if (fx * fm <= 0) y = m;
          else {
            x = m;
            fx = fm;
          }
        }
        nxt.push(0.5 * (x + y));
      }
      lo = hi;
      flo = fhi;
    }
    rts = nxt;
  }
  return rts;
}
function arcDistK(g, px, py, emPerPx) {
  //
  // The ENDS ARE CANDIDATES of their own, and keep a tie, so t comes back exactly 0 or 1 there.
  const d2 = (t) => {
    arcEval(g, t, _bp);
    const dx = _bp[0] - px,
      dy = _bp[1] - py;
    return dx * dx + dy * dy;
  };
  let bt = 0,
    bd = d2(0);
  const d1 = d2(1);
  if (d1 < bd) {
    bd = d1;
    bt = 1;
  }
  for (const t of polyRoots01(closestPoly(g, px, py))) {
    if (!arcDefined(g, t)) continue;
    const d = d2(t);
    if (d < bd) {
      bd = d;
      bt = t;
    }
  }
  arcEval(g, bt, _bp);
  const dx = _bp[0] - px,
    dy = _bp[1] - py;
  // ...AND THE FOOT POINT, because the distance alone is only half of a linearization. See
  // the arc normal in curveCov: the coverage is the area of a pixel box cut by a line, and that line
  // needs a direction as well as an offset.
  return {
    d: Math.sqrt(dx * dx + dy * dy) / (emPerPx > 0 ? emPerPx : 1),
    t: bt,
    fx: _bp[0],
    fy: _bp[1],
  };
}
/// The arc as the wire carries it. `arcIs3` is asked in ONE place -- here and in the packer, of the
/// same segment -- so the model and the wire cannot disagree about the degree. A model reading
/// `seg.t` while the packer reads the packed KIND would, for a quadratic packing to the conic
/// implicit, write four cubic control points where three points and a weight are read, so a
/// fragment standing on the boundary would come back at coverage 1.0.
export function arcGeom(seg) {
  const P = seg.P;
  if (P.length === 2) return { deg: 1, w: 1, P0: P[0], P1: P[1] };
  if (arcIs3(seg))
    return {
      deg: 2,
      w: seg.t === 'rquad' && seg.w != null ? seg.w : 1,
      P0: P[0],
      P1: P[1],
      P2: P[2],
    };
  return { deg: 3, w: 1, P0: P[0], P1: P[1], P2: P[2], P3: P[3] };
}
const K_ARCG = Symbol('cp.arcGeom');
/// The distance to a segment's own arc, in pixels -- for callers that hold the segment.
export function arcDistOf(seg, px, py, emPerPx) {
  return arcDistSeg(seg, px, py, emPerPx).d;
}
function arcDistSeg(seg, px, py, emPerPx) {
  let g = seg[K_ARCG];
  if (g === undefined) {
    g = arcGeom(seg);
    seg[K_ARCG] = g;
  }
  return arcDistK(g, px, py, emPerPx);
}

/// One constraint's coverage of the pixel box at (px, py).
///
/// `soft` is the ramped answer a cut would give if it were not hard, and `nearArc` says this
/// fragment is on REAL outline rather than on a seam -- the two together are what let the
/// composition relax a cut where a drawn curve runs through the same pixel.
export function curveCov(pk, sign, isCut, box, px, py, emPerPx, res, seg) {
  res.soft = 1.0;
  res.nearArc = false;

  res.sd = 1e30;
  res.nx = 0;
  res.ny = 0;
  if (seg?._convexEnd && seg.t === 'quad') {
    const [a, b, c] = seg.P,
      t0 = [b[0] - a[0], b[1] - a[1]],
      t1 = [c[0] - b[0], c[1] - b[1]];
    const before = (px - a[0]) * t0[0] + (py - a[1]) * t0[1] <= 0;
    const after = (px - c[0]) * t1[0] + (py - c[1]) * t1[1] >= 0;
    if (before || after) {
      const t = before ? t0 : t1,
        ep = before ? a : c,
        len = Math.hypot(...t);
      res.nx = (-t[1] / len) * seg._convexEnd;
      res.ny = (t[0] / len) * seg._convexEnd;
      res.sd = ((px - ep[0]) * res.nx + (py - ep[1]) * res.ny) / emPerPx;
      res.nearArc = Math.abs(res.sd) <= CP_AA_REACH;
      res.soft = exactBoxCov(res.nx, res.ny, res.sd);
      return res.soft;
    }
  }
  const isLine = pk.kind === CPK_LINE || pk.kind === CPK_CUT;
  // THE SIGN IS THE PACKER'S, AND IT IS NOT impls[i].s.
  //
  // The term-list orientation and the packed one are not the same number and cannot be swapped:
  // packLine NEGATES its functional, and undividing an odd-degree kind multiplies by a power of a
  // determinant whose sign varies per constraint -- one KLMN here evaluates to +0.00239 packed
  // where its term list reads -0.2238 against a sign of -1. Both say INSIDE; the factor between
  // them is negative. That is the whole reason the converter is told never to evaluate the packed
  // form.
  //
  // cpatchPack does not try to reconcile them. It asks the packed form directly, at the patch's own
  // interior point, and takes the orientation that is positive there -- then folds that into a
  // line's coefficients and writes it beside a curve's. Reading impls[i].s instead would mispaint
  // interior samples of a shape that renders correctly.
  const sg = sign;
  evalGrad(pk, px, py, _fg);
  let f = _fg[0] * sg,
    gx = _fg[1] * sg,
    gy = _fg[2] * sg;
  const glen = Math.hypot(gx, gy);

  const gpx = glen * emPerPx;
  // A seam decides along its own span and no further -- the kernel's: past the
  // filter's reach of the seam's own bound its step has nothing to say. The bound is the arc's box, or for the Bezout cubic the
  // slab across its chord between its ends -- unless the seam carries a companion, whose texels the kernel would be reading.
  const hardSeam = isCut && !!seg;
  if (hardSeam) {
    const e = emPerPx > 0 ? emPerPx : 1;
    if (pk.kind === CPK_BEZ) {
      if (!res.comp) {
        const a = segStart(seg),
          z = segEnd(seg),
          dx = z[0] - a[0],
          dy = z[1] - a[1],
          L = Math.hypot(dx, dy);
        const u = L > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / L : 0,
          r = CP_AA_REACH * e;
        if (u < -r || u > L + r) {
          res.nearArc = true;
          return f >= 0 ? 1.0 : 0.0;
        }
      }
    } else if (box) {
      const ox = Math.max(Math.max(box[0] - px, px - box[2]), 0.0),
        oy = Math.max(Math.max(box[1] - py, py - box[3]), 0.0);
      if (Math.hypot(ox, oy) / e > CP_AA_REACH) {
        res.nearArc = true;
        return f >= 0 ? 1.0 : 0.0;
      }
    }
  }
  // Far enough inside that the box is wholly covered; nothing below can change it.
  // A cut waits for the full reach too: the twin of the kernel's `if (f > gpx * 0.7072) return 1.0;`, kept at the full
  // reach since the relaxed seams' exact piece (which needed it) went with them.
  // A HORN ARC'S IMPLICIT CAN SAY INSIDE ON both SIDES OF THE ARC NEAR ITS CUSP (the kernel's CP_HORN): deep inside
  // by f is not deep inside within the reach of the arc's bound.
  let hornNear = false;
  if (res.hornE && !isCut && box) {
    const e = emPerPx > 0 ? emPerPx : 1;
    const ox = Math.max(Math.max(box[0] - px, px - box[2]), 0.0),
      oy = Math.max(Math.max(box[1] - py, py - box[3]), 0.0);
    let hp = Math.hypot(ox, oy) / e;
    if (box.strip) {
      const o = box.strip,
        vv = px * o[0] + py * o[1];
      hp = Math.max(hp, Math.max(Math.max(o[2] - vv, vv - o[3]), 0.0) / e);
    }
    hornNear = hp <= CP_AA_REACH;
  }
  if (f > gpx * CP_AA_REACH && !hornNear) return 1.0;
  if (isLine) {
    let sdL = f / (glen > 0 ? glen : 1) / (emPerPx > 0 ? emPerPx : 1);
    const nx = gx / (glen > 0 ? glen : 1),
      ny = gy / (glen > 0 ? glen : 1);
    // A line has no far branch -- its implicit IS its line -- BUT IT HAS TWO ENDS. Past its own
    // segment the line goes on attenuating: a fragment 0.87px from the segment but a quarter of a
    // pixel from the line it lies on would read 0.777 coverage, deep inside a shape that covers the
    // pixel whole.
    // The box is the segment's own, so off it the distance is taken from the box instead, exactly
    // as every curved kind does.
    // ...and on a MORPH's pack, not past an end where the patch's loop turns onto another outline curve (the kernel's
    // CP_END): that corner is convex, and its area is the two half-planes' intersection.
    if (box && !isCut) {
      const ox = Math.max(Math.max(box[0] - px, px - box[2]), 0.0);
      const oy = Math.max(Math.max(box[1] - py, py - box[3]), 0.0);
      let bpx = Math.hypot(ox, oy) / (emPerPx > 0 ? emPerPx : 1);
      if (
        sdL >= 0.0 &&
        sdL <= CP_AA_REACH &&
        bpx > sdL &&
        res.endF & 12 &&
        seg &&
        seg.P.length === 2
      ) {
        const P0 = seg.P[0],
          P1 = seg.P[1],
          dx = P1[0] - P0[0],
          dy = P1[1] - P0[1],
          u = (px - P0[0]) * dx + (py - P0[1]) * dy;
        if ((u < 0 && res.endF & 4) || (u > dx * dx + dy * dy && res.endF & 8)) bpx = 0;
      }
      if (sdL >= 0.0) sdL = Math.max(sdL, bpx);
    }
    // A MORPH'S SQUARED SEAM CORNER (the kernel's CP_END): outside this line and beyond the normal at such an end the
    // patch paints nothing, which is where a static cover stops.
    if (!isCut && res.endF & 3 && sdL < 0.0 && seg && seg.P.length === 2) {
      const P0 = seg.P[0],
        P1 = seg.P[1],
        dx = P1[0] - P0[0],
        dy = P1[1] - P0[1];
      if (
        (res.endF & 1 && (px - P0[0]) * dx + (py - P0[1]) * dy < 0) ||
        (res.endF & 2 && (px - P1[0]) * dx + (py - P1[1]) * dy > 0)
      ) {
        res.soft = 0.0;
        res.sd = sdL;
        res.nx = nx;
        res.ny = ny;
        return 0.0;
      }
    }
    res.soft = exactBoxCov(nx, ny, sdL);
    res.nearArc = !isCut && Math.abs(sdL) <= CP_AA_REACH;

    res.sd = sdL;
    res.nx = nx;
    res.ny = ny;
    // A SEAM PAST ITS OUTLINE END DEFERS TO THE OUTLINE'S NORMAL (the kernel rule): see markSeamEnds.
    if (isCut && res.seamEnd && seg && seg.P.length === 2 && !(sdL >= -cutSlack(px, py, emPerPx))) {
      for (const k of [0, 1]) {
        const e = res.seamEnd[k];
        if (!e) continue;
        const V = seg.P[k],
          W = seg.P[1 - k],
          qx = px - V[0],
          qy = py - V[1];
        if (
          qx * (V[0] - W[0]) + qy * (V[1] - W[1]) > 0 &&
          qx * e[0] + qy * e[1] >= 0 &&
          qx * e[2] + qy * e[3] < 0
        )
          return 1.0;
      }
    }
    return isCut ? (sdL >= -cutSlack(px, py, emPerPx) ? 1.0 : 0.0) : res.soft;
  }
  let dpx;
  if (isCut) {
    dpx = Math.abs(f) / (glen > 0 ? glen : 1) / (emPerPx > 0 ? emPerPx : 1);
  } else {
    // Two Newton steps onto the zero set. A curved boundary's distance is not |f|/|grad| except in
    // the limit, and the AA band is exactly where that difference shows.
    let qx = px,
      qy = py,
      fq = f,
      gqx = gx,
      gqy = gy;
    for (let it = 0; it < 2; it++) {
      const g2 = gqx * gqx + gqy * gqy;

      if (!(g2 > 0)) break;
      qx -= (fq * gqx) / g2;
      qy -= (fq * gqy) / g2;
      evalGrad(pk, qx, qy, _fq);
      fq = _fq[0] * sg;
      gqx = _fq[1] * sg;
      gqy = _fq[2] * sg;
    }
    dpx = Math.hypot(px - qx, py - qy) / (emPerPx > 0 ? emPerPx : 1);
  }
  // Off the arc's own box the implicit is still zero somewhere -- the curve carries on past its
  // endpoint -- so distance is taken from the box instead, which is what stops an extension
  // cutting back in. every kind carries one, the Bezout cubic included: its coefficients fill all
  // four of its texels, so its box rides in a fifth.
  const hasBox = !!box;
  let boxPx = 0.0;
  if (hasBox) {
    const ox = Math.max(Math.max(box[0] - px, px - box[2]), 0.0);
    const oy = Math.max(Math.max(box[1] - py, py - box[3]), 0.0);
    boxPx = Math.hypot(ox, oy) / (emPerPx > 0 ? emPerPx : 1);
    // AN AXIS-ALIGNED BOX IS A LOOSE BOUND ON A DIAGONAL ARC, and the bound is what says whether
    // this constraint has any business here: an implicit's zero set carries a second branch, and
    // where the box still contains the fragment the branch reduces coverage a pixel deep inside
    // the shape. The arc's own ORIENTED box -- its exact extents along the chord and across it --
    // hugs it, and both extents come from the same exact support the cover's planes use.
    if (box.strip) {
      const o = box.strip,
        vv = px * o[0] + py * o[1];
      const d = Math.max(Math.max(o[2] - vv, vv - o[3]), 0.0);
      boxPx = Math.max(boxPx, d / (emPerPx > 0 ? emPerPx : 1));
    }
  }

  res.implD = dpx;
  res.arcD = NaN;
  res.arcT = NaN;
  res.fx = NaN;
  res.fy = NaN;
  res.pick = 'impl';
  // And a curved hard seam takes its side from its arc where the implicit cannot be trusted with it -- the kernel's. A
  // rejection only (f < 0): off the cross-chord strip the side the patch is on is the gradient at the arc's end where it is
  // larger; within the strip, a Newton landing outside the strip is a far branch, and the arc's foot point decides, below.
  let cutArc = false,
    cutSdOn = false,
    cutSd = 0;
  if (hardSeam && !res.comp && f < 0.0 && box && box.strip) {
    const o = box.strip,
      e = emPerPx > 0 ? emPerPx : 1,
      vv = px * o[0] + py * o[1];
    const stripPx = Math.max(Math.max(o[2] - vv, vv - o[3]), 0.0) / e;
    if (stripPx > CP_AA_REACH) {
      const a = segStart(seg),
        z = segEnd(seg);
      evalGrad(pk, a[0], a[1], _fq);
      const g0x = _fq[1],
        g0y = _fq[2];
      evalGrad(pk, z[0], z[1], _fq);
      const g1x = _fq[1],
        g1y = _fq[2];
      const big0 = g0x * g0x + g0y * g0y >= g1x * g1x + g1y * g1y;
      const cin = ((big0 ? g0x : g1x) * o[0] + (big0 ? g0y : g1y) * o[1]) * sg;
      if ((vv > o[3] && cin > 0) || (vv < o[2] && cin < 0)) {
        cutSdOn = true;
        cutSd = stripPx;
      }
    } else {
      let qx = px,
        qy = py,
        fq = f,
        gqx = gx,
        gqy = gy;
      for (let it = 0; it < 2; it++) {
        const g2 = gqx * gqx + gqy * gqy;
        if (!(g2 > 0)) break;
        qx -= (fq * gqx) / g2;
        qy -= (fq * gqy) / g2;
        evalGrad(pk, qx, qy, _fq);
        fq = _fq[0] * sg;
        gqx = _fq[1] * sg;
        gqy = _fq[2] * sg;
      }
      const vq = qx * o[0] + qy * o[1];
      cutArc = vq < o[2] || vq > o[3];
    }
  }
  let hornGeo = false,
    hornLine = false,
    hFx = 0,
    hFy = 0,
    hTx = 0,
    hTy = 0,
    hAd = 0;
  if (seg && ((!isCut && (dpx <= CP_AA_REACH || boxPx <= CP_AA_REACH || hornNear)) || cutArc)) {
    const a = arcDistSeg(seg, px, py, emPerPx);
    res.arcD = a.d;
    res.arcT = a.t;
    res.fx = a.fx;
    res.fy = a.fy;
    // A MORPH'S SQUARED SEAM CORNER (the kernel's CP_END): outside this arc, with its foot at such an end.
    if (
      !isCut &&
      res.endF & 3 &&
      f < 0.0 &&
      ((res.endF & 1 && a.t <= 0) || (res.endF & 2 && a.t >= 1))
    ) {
      res.soft = 0.0;
      res.sd = -a.d;
      res.nx = 0;
      res.ny = 0;
      return 0.0;
    }
    // A horn arc takes its own side (the kernel's CP_HORN): the arc's normal at an interior foot; at the CUSP, the
    // tangent line through the tip, along P2 - P1.
    if (res.hornE && a.d <= CP_AA_REACH) {
      const P = seg.P,
        cusp0 = a.t <= 0 && res.hornE & 1,
        cusp1 = a.t >= 1 && res.hornE & 2;
      if (a.t > 0 && a.t < 1) {
        const T = segTangent(seg, a.t);
        if (T[0] * T[0] + T[1] * T[1] > 0) {
          hornGeo = true;
          hFx = a.fx;
          hFy = a.fy;
          hTx = T[0];
          hTy = T[1];
          hAd = a.d;
        }
      } else {
        // At either END the tangent line there (the kernel's), along P2 - P1 at a cusp.
        const e1 = a.t > 0,
          T = cusp0 || cusp1 ? [P[2][0] - P[1][0], P[2][1] - P[1][1]] : segTangent(seg, e1 ? 1 : 0);
        const E = e1 ? P[P.length - 1] : P[0];
        if (T[0] * T[0] + T[1] * T[1] > 0) {
          hornGeo = hornLine = true;
          hFx = E[0];
          hFy = E[1];
          hTx = T[0];
          hTy = T[1];
        }
      }
    }
    if (a.t > 0 && a.t < 1) {
      dpx = a.d;
      res.pick = 'arc';
      // the arc's own side at its foot (the kernel rule): the implicit's sign can be another branch's
      if (!isCut && f < 0.0) {
        const tg = segTangent(seg, a.t);
        if (tg[0] * tg[0] + tg[1] * tg[1] > 0)
          f = ((py - a.fy) * tg[0] - (px - a.fx) * tg[1]) * (res.hornRight ? -1 : 1);
      }
    } else if (f >= 0.0 && a.d > dpx) {
      dpx = a.d;
      res.pick = 'arcEnd';
    }
    if (cutArc && a.t > 0 && a.t < 1) {
      evalGrad(pk, a.fx, a.fy, _fq);
      cutSdOn = true;
      cutSd = ((px - a.fx) * _fq[1] + (py - a.fy) * _fq[2]) * sg >= 0 ? a.d : -a.d;
    }
  }
  if (hasBox && !isCut && f >= 0.0 && boxPx > dpx) {
    dpx = boxPx;
    res.pick = 'box';
  }

  const sd = f < 0.0 ? -dpx : dpx;
  let nrx = gx / (glen > 0 ? glen : 1),
    nry = gy / (glen > 0 ? glen : 1);

  if (res.pick === 'arc' && res.fx === res.fx) {
    const vx = px - res.fx,
      vy = py - res.fy,
      vl = Math.hypot(vx, vy);
    // ON the arc there is no direction to take; the gradient is the only thing left that has one.
    if (vl > 0) {
      const k = f < 0.0 ? -1 / vl : 1 / vl;
      nrx = vx * k;
      nry = vy * k;
    }
  }
  let sdv = sd;
  res.hornGeo = hornGeo;
  if (hornGeo) {
    const tl = Math.hypot(hTx, hTy),
      k = res.hornRight ? -1 : 1,
      lx = (-hTy / tl) * k,
      ly = (hTx / tl) * k;
    const e = emPerPx > 0 ? emPerPx : 1;
    if (hornLine) {
      sdv = (lx * (px - hFx) + ly * (py - hFy)) / e;
      nrx = lx;
      nry = ly;
    } else {
      const vx = px - hFx,
        vy = py - hFy,
        vl = Math.hypot(vx, vy),
        hs = lx * vx + ly * vy < 0 ? -1 : 1;
      sdv = hs * hAd;
      if (vl > 0) {
        nrx = (hs * vx) / vl;
        nry = (hs * vy) / vl;
      } else {
        nrx = lx;
        nry = ly;
      }
    }
  }
  res.soft = exactBoxCov(nrx, nry, sdv);
  res.sd = sdv;
  res.boxPx = boxPx;
  res.nx = nrx;
  res.ny = nry;
  // Near the zero set AND inside the drawn arc's box. Both halves matter: an implicit's zero set
  // is the whole algebraic curve, so the far branch is near ITS zero set too.
  res.nearArc = !isCut && hasBox && Math.abs(sdv) <= CP_AA_REACH && boxPx <= CP_AA_REACH;
  // A QUADRATIC SEAM PAST ITS OUTLINE END DEFERS TO THE OUTLINE'S NORMAL (the kernel rule): see markSeamEnds.
  if (
    isCut &&
    res.seamEnd &&
    seg &&
    seg.P.length === 3 &&
    !((cutSdOn ? cutSd : sd) >= -cutSlack(px, py, emPerPx))
  ) {
    for (const k of [0, 1]) {
      const e = res.seamEnd[k];
      if (!e) continue;
      const V = seg.P[k === 0 ? 0 : 2],
        M = seg.P[1],
        qx = px - V[0],
        qy = py - V[1];
      const ao = Math.fround(Math.atan2(e[1], e[0])),
        at = Math.fround(Math.atan2(e[3], e[2]));
      if (
        qx * (V[0] - M[0]) + qy * (V[1] - M[1]) > 0 &&
        qx * Math.cos(ao) + qy * Math.sin(ao) >= 0 &&
        qx * Math.cos(at) + qy * Math.sin(at) < 0
      )
        return 1.0;
    }
  }
  return isCut ? ((cutSdOn ? cutSd : sd) >= -cutSlack(px, py, emPerPx) ? 1.0 : 0.0) : res.soft;
}

const _res = { soft: 1.0, nearArc: false };

/// A SEAM'S OUTLINE ENDS, per straight cut of a patch: at each end where the patch's loop turns from the cut
/// onto an outline curve of its own (d_own, its leg from the end) and exactly one other outline curve meets the same
/// point (d_oth, its leg), the pair; else null. Past such an end the outline goes on as one of the two curves, and the
/// fragment belongs to the patch whose curve it is beside -- the side of that curve's normal at the end -- whichever side
/// of the seam's extension it lies on.
export const K_SEAMEND = Symbol('cp.seamEnd');
export function markSeamEnds(patches) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const outl = [];
  for (const p of patches)
    for (const c of p.curves) {
      for (const q of c.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
      if (!c.cut) outl.push(c);
    }
  const tol = 1e-6 * Math.max(x1 - x0, y1 - y0, 0);
  const at = (q, V) => Math.abs(q[0] - V[0]) <= tol && Math.abs(q[1] - V[1]) <= tol;
  for (const p of patches) {
    const C = p.curves,
      n = C.length,
      m = new Map();
    for (let i = 0; i < n; i++) {
      const c = C[i];
      if (!c || !c.cut || n < 2 || !(c.P.length === 2 || (c.P.length === 3 && c.t !== 'rquad')))
        continue;
      const ends = [null, null];
      for (const k of [0, 1]) {
        const own = C[k === 0 ? (i - 1 + n) % n : (i + 1) % n];
        if (!own || own.cut) continue;
        const V = c.P[k === 0 ? 0 : c.P.length - 1],
          dOwn = legFrom(own, k === 1);
        const others = [];
        for (const o of outl) {
          if (o === own) continue;
          if (at(o.P[0], V)) others.push(legFrom(o, true));
          else if (at(o.P[o.P.length - 1], V)) others.push(legFrom(o, false));
        }
        if (dOwn && others.length === 1 && others[0])
          ends[k] = [dOwn[0], dOwn[1], others[0][0], others[0][1]];
      }
      if (ends[0] || ends[1]) m.set(c, ends);
    }
    p[K_SEAMEND] = m;
  }
  return patches;
}
/// A MORPH'S CORNERS, per curve of a patch, as markSeamCorners leaves them. A morph's cover is the span's
/// dilated hull -- no skirt, no squared corner, no fence -- so the corners a static cover draws have to be drawn by the
/// kernel instead, and the morph packer flags them on each outline curve: bit 0 (its start) and bit 1 (its end) where
/// the patch's loop turns onto a seam at a corner a static skirt would square off (the curve's leg and the seam's meet
/// under 72.3 or over 107.7 degrees: past 1.05 of the reach, cpatchPack's `corner`), and bit 2 (its start) and bit 3 (its
/// end) where the loop turns onto another OUTLINE curve -- a convex corner, past which a line's box floor does not hold.
/// A static pack writes none of these and its kernel is unchanged; the kernel's CP_END reads the same bits off a morph's
/// kind word (cpatchPack's CPK_END).
export const K_ENDF = Symbol('cp.endF');
export function arcEndFlags(patch, i) {
  const f = patch[K_ENDF];
  return f ? f[i] | 0 : 0;
}
// A seam corner squares once its miter would run past 1.05 of the reach (cpatchPack's MCAP): sin(angle) under 1 / 1.05.
const CP_SQUARE_SIN = 1 / 1.05;
// The direction from a curve's end into the curve: its first control leg of nonzero length.
function legFrom(c, atStart) {
  const P = atStart ? c.P : c.P.slice().reverse(),
    V = P[0];
  for (let k = 1; k < P.length; k++) {
    const dx = P[k][0] - V[0],
      dy = P[k][1] - V[1];
    if (dx !== 0 || dy !== 0) return [dx, dy];
  }
  return null;
}
/// Marks every patch with its curves' corner bits (K_ENDF). Geometry only -- the patch's own loop -- so every pose of a
/// morph's layout marks alike, and the bits ride the kind word unchanged across a segment's blend.
export function markSeamCorners(patches) {
  for (const p of patches) {
    const C = p.curves,
      n = C.length,
      f = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const c = C[i];
      if (!c || c.cut || n < 2) continue;
      for (const atStart of [true, false]) {
        const nb = C[atStart ? (i - 1 + n) % n : (i + 1) % n];
        if (!nb) continue;
        if (!nb.cut) {
          f[i] |= atStart ? 4 : 8;
          continue;
        }
        const a = legFrom(c, atStart),
          b = legFrom(nb, !atStart);
        if (!a || !b) continue;
        const cr = Math.abs(a[0] * b[1] - a[1] * b[0]),
          la = Math.hypot(a[0], a[1]),
          lb = Math.hypot(b[0], b[1]);
        if (cr < CP_SQUARE_SIN * la * lb) f[i] |= atStart ? 1 : 2;
      }
    }
    p[K_ENDF] = f;
  }
  return patches;
}
/// THE HORN ARCS OF A PATCH (the packer's CPK_HORN0/1/_RIGHT, the kernel's CP_HORN), per curve: 1 and 2 where it
/// ends at its own curve's cusp at t = 0 and t = 1 -- a zero-length handle there, exactly, and the loop not going on
/// through the cusp along the same curve -- and 4 where the patch's inside is on the arc's right. Null when none.
const K_HORNS = Symbol('cp.horns');
function patchHorns(patch) {
  if (patch[K_HORNS] !== undefined) return patch[K_HORNS];
  const cs = patch.curves,
    n = cs.length,
    pks = patch.impls.map((im) => im.packed);
  const same = (u, v) =>
    !!u &&
    !!v &&
    u.kind === v.kind &&
    u.a.every((r, i) => r.every((x, j) => x === v.a[i][j])) &&
    u.c.every((x, i) => x === v.c[i]);
  let out = null;
  const right = loopSignedArea(cs) < 0;
  for (let i = 0; i < n; i++) {
    const A = cs[i];
    if (!A || A.cut || A.t !== 'cubic' || A.P.length !== 4 || n < 2) continue;
    const P = A.P,
      z0 = P[0][0] === P[1][0] && P[0][1] === P[1][1],
      z1 = P[2][0] === P[3][0] && P[2][1] === P[3][1];
    const thr = (j) => !cs[j].cut && same(pks[j], pks[i]);
    const h = (z0 && !thr((i - 1 + n) % n) ? 1 : 0) + (z1 && !thr((i + 1) % n) ? 2 : 0);
    if (h) {
      out = out || new Array(n).fill(0);
      out[i] = h + (right ? 4 : 0);
    }
  }
  return (patch[K_HORNS] = out);
}

/// What the kernel paints for one patch at one point: the same composition the shader does, seam
/// relaxation and cover clip included.
function convexAreaCoverage(curves, x, y, emPerPx) {
  let area = 0;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  for (const curve of curves) {
    const p = curve.P.map((q) => [(q[0] - x) / emPerPx + 0.5, (q[1] - y) / emPerPx + 0.5]);
    if (p.length === 2)
      p.splice(
        1,
        0,
        p[0].map((v, j) => (v + p[1][j]) / 2),
      );
    const [p0, p1, p2] = p;
    if (Math.max(...p.map((q) => q[0])) <= 0) continue;
    if (Math.min(...p.map((q) => q[0])) >= 1) {
      area += clamp(p2[1]) - clamp(p0[1]);
      continue;
    }
    if (Math.max(...p.map((q) => q[1])) <= 0 || Math.min(...p.map((q) => q[1])) >= 1) continue;
    const evalAt = (t) =>
      p0.map((v, j) => (1 - t) * ((1 - t) * v + t * p1[j]) + t * ((1 - t) * p1[j] + t * p2[j]));
    const cuts = [
      { t: 0, y: p0[1] },
      { t: 1, y: p2[1] },
    ];
    for (const j of [0, 1])
      for (const wall of [0, 1]) {
        const a = p0[j] - 2 * p1[j] + p2[j],
          b = 2 * (p1[j] - p0[j]),
          c = p0[j] - wall;
        let roots = [];
        if (a === 0) {
          if (b !== 0) roots = [-c / b];
        } else {
          const disc = b * b - 4 * a * c;
          if (disc >= 0) {
            const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
            roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
          }
        }
        for (const t of roots)
          if (t > 0 && t < 1) cuts.push({ t, y: j === 1 ? wall : evalAt(t)[1] });
      }
    cuts.sort((a, b) => a.t - b.t);
    for (let i = 1; i < cuts.length; i++) {
      const lo = cuts[i - 1],
        hi = cuts[i],
        h = hi.t - lo.t,
        m = (lo.t + hi.t) / 2,
        pm = evalAt(m);
      if (pm[1] <= 0 || pm[1] >= 1 || pm[0] <= 0) continue;
      if (pm[0] >= 1) {
        area += clamp(hi.y) - clamp(lo.y);
        continue;
      }
      const d = h / Math.sqrt(12),
        integrand = (t) => evalAt(t)[0] * 2 * ((1 - t) * (p1[1] - p0[1]) + t * (p2[1] - p1[1]));
      area += 0.5 * h * (integrand(m - d) + integrand(m + d));
    }
  }
  return clamp(Math.abs(area));
}

export function patchCoverage(patch, x, y, emPerPx) {
  _frame = patch[K_FRAME] || [0, 0];
  const b = patch.bbox;
  if (b && (x < b[0] - emPerPx || x > b[2] + emPerPx || y < b[1] - emPerPx || y > b[3] + emPerPx))
    return 0;
  if (
    emPerPx > 0 &&
    patch.curves.length >= 3 &&
    patch.curves.length <= 64 &&
    patch.curves.every((c) => c._convexEnd && !c.cut && (c.t === 'line' || c.t === 'quad'))
  )
    return convexAreaCoverage(patch.curves, x, y, emPerPx);
  let cov = 1.0,
    cutHard = 1.0,
    cutFar = 1.0,
    nearArc = false,
    sdEdge = Infinity,
    edgeIdx = -1;
  // The two most limiting outline constraints -- the kernel's exC1/exC2. min() over constraints is the coverage of the tightest ONE; where a SECOND edge also
  // cuts the pixel -- the far side of a stem narrower than a pixel, the other leg of a corner --
  // the true coverage is the area of both half-planes' INTERSECTION, which min() overstates.
  // See the composition at the end of this function, and exactBoxCov2/3 above.
  let exC1 = 1.0,
    exD1 = 0.0,
    exN1x = 0.0,
    exN1y = 0.0;
  let exC2 = 1.0,
    exD2 = 0.0,
    exN2x = 0.0,
    exN2y = 0.0;
  const horns = patchHorns(patch),
    loopRight = loopSignedArea(patch.curves) < 0;
  for (let i = 0; i < patch.impls.length; i++) {
    const im = patch.impls[i];
    const pk = im.packed;
    if (!pk) return 0;
    const seg = patch.curves[i];
    // Every cut is a seam here: the packer emits a hard step for each one and nothing marks a
    // cut as a boundary, so the model keys on seg.cut exactly as the wire does.
    const isCut = !!(seg && seg.cut);
    // every KIND HAS AN ARC BOX, the Bezout cubic included -- it reads its from a fifth
    // texel rather than sharing texel 3. See cpatchPack for the wire layout.
    const box = obbBox(seg);
    const sgn =
      seg._convexEnd && seg.t === 'quad'
        ? convexQuadraticSign(seg, pk)
        : packedEval(pk, patch.inside[0], patch.inside[1]) >= 0
          ? 1
          : -1;
    _res.hornE = horns ? horns[i] & 3 : 0;
    _res.hornRight = loopRight;
    _res.endF = arcEndFlags(patch, i);
    _res.seamEnd = isCut && patch[K_SEAMEND] ? patch[K_SEAMEND].get(seg) || null : null;
    _res.comp = !!(isCut && patch[K_COMP] && patch[K_COMP].get(seg));
    const c = curveCov(pk, sgn, isCut, box, x, y, emPerPx, _res, seg);
    if (isCut) {
      // past its span (res.nearArc set on a cut) the step holds only off the patch's own edges -- the kernel's cutFar
      if (_res.nearArc) cutFar = Math.min(cutFar, c);
      else cutHard = Math.min(cutHard, c);
      // THE OUTLINE ACROSS THE SEAM (the kernel's CP_COMP): where this fragment is within the
      // filter's reach of the seam and of its companion's box, the companion bounds it as an outline
      // row does, and names no edge.
      const comp = patch[K_COMP] ? patch[K_COMP].get(seg) : null;
      if (comp && _res.sd <= 1e29 && _res.sd >= -CP_AA_REACH) {
        const cb = segTightBBox(comp),
          e = emPerPx > 0 ? emPerPx : 1;
        const ox = Math.max(Math.max(cb[0] - x, x - cb[2]), 0.0),
          oy = Math.max(Math.max(cb[1] - y, y - cb[3]), 0.0);
        if (Math.hypot(ox, oy) <= CP_AA_REACH * e) {
          const a = arcDistSeg(comp, x, y, emPerPx),
            vx = x - a.fx,
            vy = y - a.fy,
            vl = Math.hypot(vx, vy);
          const b2 = vl > 0 ? exactBoxCov(vx / vl, vy / vl, a.d) : 1;
          if (b2 < cov) {
            sdEdge = Infinity;
            edgeIdx = -1;
          }
          cov = Math.min(cov, b2);
        }
      }
    }
    // sdEdge IS THE DISTANCE TO THE CONSTRAINT THAT SET THE COVERAGE, and the hull's redundancy
    // test below is the only thing that wants it: a hull plane standing the same distance away as
    // the patch's own edge IS that edge, and must not be minned in a second time.
    else {
      if (c < cov) {
        sdEdge = _res.sd;
        edgeIdx = i;
      }
      cov = Math.min(cov, c);
      nearArc = nearArc || _res.nearArc;
      if (c < 1.0 && _res.nx * _res.nx + _res.ny * _res.ny > 0.0) {
        if (c < exC1) {
          exC2 = exC1;
          exD2 = exD1;
          exN2x = exN1x;
          exN2y = exN1y;
          exC1 = c;
          exD1 = _res.sd;
          exN1x = _res.nx;
          exN1y = _res.ny;
        } else if (c < exC2) {
          exC2 = c;
          exD2 = _res.sd;
          exN2x = _res.nx;
          exN2y = _res.ny;
        }
      }
    }
  }

  //
  // The patch that owns the pixel paints what the shape covers there: the exact pair, and no seam's piece.
  const NEAR_T = nearT();
  if (exC2 < 1.0)
    cov = Math.min(
      cov,
      cpExactBoxCov23(-exN1x, -exN1y, exD1, -exN2x, -exN2y, exD2, 0, 0, 1, false)[1],
    );
  // An opt-in record of the intermediates, so a dropped pixel can be read rather than re-derived:
  // which of cov, the seam and the cover produced the number this returns.
  if (globalThis.__CP_TRACE)
    globalThis.__cpTrace = { cov, cutHard, nearArc, exC1, exC2, stage: 'outline' };
  if (cov <= 0.001) return 0;
  // THE COVER THE KERNEL CLIPS AGAINST, which is not patch.cover. The packer emits its hull rows
  // from a SAMPLED hull (CP_KERNEL_HULL_SAMPLES) while patch.cover stays the control-point hull the
  // search validates against, so reading patch.cover here would model a looser clip than the GPU
  // performs and under-report the spill this exists to find. Cached on the patch: one hull per
  // patch, not one per sample.
  let cover = patch[K_KERNEL_COVER];
  if (cover === undefined) {
    cover =
      patchCoverLines(
        patch.curves,
        mantleDebugHook('__CP_HULL_ROW_SAMPLES') != null
          ? mantleDebugHook('__CP_HULL_ROW_SAMPLES')
          : CP_HULL_ROW_SAMPLES,
      ) ||
      patch.cover ||
      (patch.obb && patch.obb.lines) ||
      null;
    patch[K_KERNEL_COVER] = cover;
  }
  // ...AND THE QUAD, which is the other half of the kernel's bound and is not a row at all. The
  // rasterizer clips the cover POLYGON -- the full CP_KERNEL_HULL_SAMPLES hull, dilated so the AA
  // ramp has somewhere to live -- so the GPU's region is the polygon INTERSECT the rows. Modeling
  // only the rows leaves the model looser than the renderer in every direction the rows do not
  // sample, which is the same failure as modeling a different hull, just the other way up.

  let quad = patch[K_QUAD_COVER];
  if (quad === undefined) {
    const hull = patchCoverHull(patch.curves, CP_KERNEL_HULL_SAMPLES);
    quad = hull && hull.length >= 3 ? { hull, dirs: coverOffsetDirs(hull, null) } : null;
    patch[K_QUAD_COVER] = quad;
  }
  if (quad) {
    const d = quadDilatePx() * (emPerPx > 0 ? emPerPx : 1),
      H = quad.hull,
      D = quad.dirs;
    const px0 = H[0][0] + D[0][0] * d,
      py0 = H[0][1] + D[0][1] * d;
    let hit = false;
    for (let k = 1; k + 1 < H.length && !hit; k++) {
      const ax = H[k][0] + D[k][0] * d,
        ay = H[k][1] + D[k][1] * d;
      const bx = H[k + 1][0] + D[k + 1][0] * d,
        by = H[k + 1][1] + D[k + 1][1] * d;
      const d1 = (ax - px0) * (y - py0) - (x - px0) * (ay - py0);
      const d2 = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      const d3 = (px0 - bx) * (y - by) - (x - bx) * (py0 - by);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) hit = true;
    }
    if (!hit) {
      if (globalThis.__CP_TRACE) globalThis.__cpTrace.stage = 'quad';
      return 0;
    }
  }
  // THE PATCH'S own BOX, WHICH IS THE KERNEL'S CHEAPEST FENCE.
  //
  // A CPatch is its curves INSIDE A BOX (Dokter et al.), and _cpatchCoverage.glsl enforces that on
  // every fragment for two dot products (cBoxA / cBoxU / cBoxV, dilated by CP_BOX_SLACK so it
  // cannot clip the AA band). Without it here the model would score an unfenced patch against its
  // half-spaces alone -- an UNBOUNDED convex intersection -- and report ink the renderer does not
  // put down, which is exactly the arm the hull-row gate has to be judged in. It is also the bound
  // the gate's own question is asked against (patchLeaksInBox tests the extension inside the OBB),
  // so a model without it cannot check that gate at all.
  if (patch.obb && patch.obb.lines) {
    const em = emPerPx > 0 ? emPerPx : 1;
    for (const h of patch.obb.lines) if ((h[0] * x + h[1] * y + h[2]) / em < -CP_AA_REACH) return 0;
  }
  if (globalThis.__CP_TRACE) globalThis.__cpTrace.stage = 'rows';
  // THE HULL ROWS, only ON THE PATCHES THAT KEPT THEM. The packer's gate exempts a patch whose
  // half-spaces already close inside its own box (see K_ROWS in cpatchPack), and a model that
  // fences every patch is measuring a renderer that does not exist. An unpacked patch has no flag and
  // keeps the rows, which is what every caller predating the gate expects.
  if (cover && patch[K_ROWS] !== false) {
    //
    //   SLACK       the plane's distance carries CP_POS_REL (or CP_HULL16_DILATE for a bridging
    //               plane), so it does not clip exactly on itself
    //   AREA        every plane publishes its exact box area beside its verdict, and the SEAM GATE
    //               spends the area wherever the patch's own outline says the fragment is mid-ramp
    //   REDUNDANT   a plane standing the same distance away as the patch's own edge IS that edge;
    //               minning it in a second time is what made CPatch's edges binary
    //
    // THE REDUNDANCY TEST COMPARES DISTANCES only, as the kernel's does: what the hull term holds
    // back is AA band, not solid interior.
    const emH = emPerPx > 0 ? emPerPx : 1;
    const HULL16 = hull16Dilate(),
      SLACK = cutSlack(x, y, emH);
    let hullHard = 1.0,
      hullSoft = 1.0,
      sdHull = Infinity;
    for (const h of cover) {
      const gH = Math.max(Math.hypot(h[0], h[1]), 1e-20);
      // A PLANE AN OUTLINE ARC RUNS ALONG RAMPS, and only beside the arc it follows: past the
      // arc's own span it is a wall the fragment is nowhere near (cpHullRamp).
      if (h[3] === 2) {
        const a2 = (h[0] * x + h[1] * y + h[2]) / emH;
        const on =
          h.length < 6 ||
          (() => {
            const u = x * -h[1] + y * h[0];
            return u >= h[4] - CP_AA_REACH * emH && u <= h[5] + CP_AA_REACH * emH;
          })();
        const v = on || a2 < 0 ? exactBoxCov(h[0], h[1], a2) : 1; // off its span: the step inside only
        hullHard = Math.min(hullHard, v);
        hullSoft = Math.min(hullSoft, v);
        if (a2 < sdHull) sdHull = a2;
        continue;
      }
      const sdH = (h[0] * x + h[1] * y + h[2]) / gH / emH + (h[3] === 0 ? HULL16 : SLACK);
      hullHard = Math.min(hullHard, sdH >= 0 ? 1 : 0);
      hullSoft = Math.min(hullSoft, exactBoxCov(h[0] / gH, h[1] / gH, sdH));
      if (sdH < sdHull) sdHull = sdH;
    }
    // OWNERSHIP IS THE SEAM'S, so the plane only decides the AA band beside the patch's own arc, and ramps there.
    const midRamp = nearArc && cov < NEAR_T;
    const redundant =
      midRamp && sdEdge < 1e29 && sdHull < 1e29 && Math.abs(sdEdge - sdHull) < hullAgree();
    if (globalThis.__CP_TRACE) {
      globalThis.__cpTrace = {
        ...globalThis.__cpTrace,
        stage: 'hull',
        covIn: cov,
        hullHard,
        hullSoft,
        sdEdge,
        sdHull,
        edgeIdx,
        midRamp,
        nearArc,
        redundant,
      };
    }
    cov = Math.min(cov, redundant ? 1.0 : midRamp ? hullSoft : hullHard);
    if (cov <= 0.001) return 0;
  }
  // ── THE SEAM, LAST, WHICH IS WHERE THE KERNEL SPENDS IT: a step, which is the ownership ─────────────────
  cov = Math.min(cov, cutHard);
  if (!nearArc) cov = Math.min(cov, cutFar);
  if (globalThis.__CP_TRACE)
    globalThis.__cpTrace = { ...globalThis.__cpTrace, stage: 'seam', cov, cutHard };
  // The kernel's own discard. `if (cov < 0.004) discard;` is the last line of cpatchCoverage, so a
  // fragment under it paints nothing -- and a model that returns 0.003 has that patch contributing
  // ink the renderer does not put down.
  if (cov < 0.004) return 0;
  return cov;
}

/// The shape-level coverage guard: true when this decomposition PROVABLY cannot cover its shape.
///
/// Loop-Blinn has had one since the fast mesh existed (lbBuildCore.meshUnderCovers -- a mesh whose
/// whole triangle area is under half the contour's is refused before it can draw), and CPatch had
/// nothing equivalent. Its per-patch tests do not answer this question and cannot: validatePatch
/// asks whether a patch admits territory outside its own loop, and gridCheck compares a patch to
/// THAT loop's spans, so a cut handing one side a loop with no interior yields a patch covering
/// nothing and both tests pass it vacuously. Nothing between the search and the draw asked whether
/// the union of the patches paints the shape the artwork specifies.
///
/// n = 32 is a 1024-sample grid, and the cost is carried by the EARLY OUT: a sample stops asking
/// patches the moment one of them paints it past a half, so a healthy shape pays one or two
/// patchCoverage calls a sample and only a broken decomposition pays the whole list.
///
export function shapeUnderCovers(contours, patches, evenOdd = false, n = 32) {
  if (!contours || !contours.length || !patches) return false;
  const curves = [];
  for (const q of contours) {
    if (!q || !q.length) continue;
    for (const sg of q) curves.push(sg);
    const a = segStart(q[0]),
      b = segEnd(q[q.length - 1]);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9)
      curves.push({
        t: 'line',
        P: [
          [b[0], b[1]],
          [a[0], a[1]],
        ],
      });
  }
  if (!curves.length) return false;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of curves)
    for (const p of s.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  if (!(x1 > x0) || !(y1 > y0)) return false;
  // The same nominal raster coverageMiss uses: the shape across 512 px.
  const emPerPx = Math.max(x1 - x0, y1 - y0) / 512.0;
  if (!(emPerPx > 0)) return false;
  let tot = 0,
    missed = 0;
  const row = [];
  for (let j = 0; j < n; j++) {
    const y = y0 + ((y1 - y0) * (j + 0.5)) / n;
    let spans;
    try {
      spans = rowSpans(curves, y, evenOdd);
    } catch {
      return false;
    }
    if (!spans.length) continue;
    // Only the patches this row can reach. A patch is a box first; asking every patch at every
    // sample is what makes a whole-shape sweep unaffordable on a shape that has hundreds.
    row.length = 0;
    for (const p of patches) {
      const b = p.bbox;
      if (!b || (y >= b[1] - emPerPx && y <= b[3] + emPerPx)) row.push(p);
    }
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
      let inR = false,
        edge = Infinity;
      for (const sp of spans) {
        if (x >= sp[0] && x <= sp[1]) {
          inR = true;
          edge = Math.min(x - sp[0], sp[1] - x);
          break;
        }
      }
      if (!inR) continue;

      if (edge < 0.5 * emPerPx) continue;
      let open = 1.0;
      for (const p of row) {
        const c = patchCoverage(p, x, y, emPerPx);
        if (c <= 0) continue;
        open *= 1.0 - c;
        if (open < 0.5) break; // painted past a half; nothing below can change it
      }
      if (open >= 0.5) {
        if (distToContour(curves, x, y) < 0.5 * emPerPx) continue; // the AA band is nobody's miss
        tot++;
        missed++;
      } else tot++;
    }
  }

  if (tot < 24) return false;
  return missed > 0.5 * tot;
}

/// Measure kernel coverage against the shape in both directions, including the shortfall.
///
///   miss  -- interior the patches do not reach
///   over  -- ink outside the contour: a patch admitting territory the shape does not have
///   thin  -- mean coverage shortfall over the interior, which is the only one of the three that
///            can see a SEAM: miss and over threshold at 0.5, so two patches meeting at an edge
///            and each contributing 0.5 union to 0.75 and read as painted while the frame shows a
///            visibly lighter pixel.
/// `evenOdd` picks the fill rule the interior is taken under, and it is not optional information:
/// the even-odd region is a strict subset of the nonzero one, so an even-odd shape scored against
/// nonzero spans is charged for its own holes as interior the patches missed. It defaults to
/// nonzero for the callers that predate it.
export function coverageMiss(curves, patches, n = 64, evenOdd = false) {
  if (!patches || !patches.length) return { miss: 100, over: 0, thin: 100 };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of curves)
    for (const p of s.P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  if (!(x1 > x0) || !(y1 > y0)) return { miss: 0, over: 0, thin: 0 };
  // A nominal raster: the shape across ~512 pixels, which is the scale these assets are authored
  // and reviewed at.
  let emPerPx = Math.max(x1 - x0, y1 - y0) / 512.0;
  if (!(emPerPx > 0)) emPerPx = 1e-6;
  // Grown so there is somewhere OUTSIDE the shape to sample; a patch that spills does so past the
  // contour, which the contour's own box need not contain.
  const gw = (x1 - x0) * 0.15,
    gh = (y1 - y0) * 0.15;
  x0 -= gw;
  x1 += gw;
  y0 -= gh;
  y1 += gh;
  let miss = 0,
    tot = 0,
    spill = 0,
    shortfall = 0;
  for (let j = 0; j < n; j++) {
    const y = y0 + ((y1 - y0) * (j + 0.5)) / n;
    const spans = rowSpans(curves, y, evenOdd);
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
      let inR = false,
        edge = Infinity;
      for (const sp of spans) {
        if (x >= sp[0] && x <= sp[1]) {
          inR = true;
          edge = Math.min(x - sp[0], sp[1] - x);
          break;
        }
        edge = Math.min(edge, Math.min(Math.abs(x - sp[0]), Math.abs(x - sp[1])));
      }

      if (edge < 0.5 * emPerPx) continue;
      let open = 1.0;
      for (const p of patches) {
        const c = patchCoverage(p, x, y, emPerPx);
        if (c <= 0) continue;
        open *= 1.0 - c;
        if (open <= 0.001) break;
      }
      const painted = 1.0 - open;
      const counts = inR ? painted < 0.5 : painted > 0.5;
      if (counts && distToContour(curves, x, y) < 0.5 * emPerPx) continue;
      if (inR) {
        tot++;
        if (painted < 0.5) miss++;
        shortfall += 1.0 - painted;
      } else if (painted > 0.5) spill++;
    }
  }
  return {
    miss: tot ? (100 * miss) / tot : 0,
    over: tot ? (100 * spill) / tot : 0,
    thin: tot ? (100 * shortfall) / tot : 0,
  };
}

/// Distance to the contour itself, not along a scanline: where the outline runs near-horizontally
/// a sample a fraction of a pixel off it has no span near it in x and reads as far away.
///
export function distToContour(curves, x, y) {
  let d2 = Infinity;
  const pts = [];
  for (const sg of curves) {
    const P = sg.P,
      n = P.length;
    let px = 0,
      py = 0;
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      let qx = 0,
        qy = 0;
      // de Casteljau, which is what segPt does; inlined to keep this off the allocation path.
      const ax = P[0][0],
        ay = P[0][1];
      if (n === 2) {
        qx = ax + (P[1][0] - ax) * t;
        qy = ay + (P[1][1] - ay) * t;
      } else {
        pts.length = 0;
        for (let m = 0; m < n; m++) pts.push(P[m][0], P[m][1]);
        for (let r = n - 1; r > 0; r--)
          for (let m = 0; m < r; m++) {
            pts[2 * m] += (pts[2 * m + 2] - pts[2 * m]) * t;
            pts[2 * m + 1] += (pts[2 * m + 3] - pts[2 * m + 1]) * t;
          }
        qx = pts[0];
        qy = pts[1];
      }
      let dd = (qx - x) * (qx - x) + (qy - y) * (qy - y);
      if (k > 0) {
        // The point's distance to the chord [p, q], clamped to the segment.
        const ex = qx - px,
          ey = qy - py,
          L2 = ex * ex + ey * ey;
        if (L2 > 0) {
          let s = ((x - px) * ex + (y - py) * ey) / L2;
          if (s > 0 && s < 1) {
            const cx = px + ex * s - x,
              cy = py + ey * s - y;
            const cd = cx * cx + cy * cy;
            if (cd < dd) dd = cd;
          }
        }
      }
      if (dd < d2) d2 = dd;
      px = qx;
      py = qy;
    }
  }
  return Math.sqrt(d2);
}
