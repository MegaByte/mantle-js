// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// intersect/coincident.js — the intersection of two curves that run along the same underlying curve.
//
// Two Beziers that share a stretch have no isolated crossing along it, so a root finder cannot
// answer them, and neither general kernel can. quadQuad substitutes one parabola into the other's implicit;
// on the same parabola that quartic vanishes identically, and Ferrari divides by its zero leading
// coefficient -- four NaN hits, for identical, reversed, overlapping and even two halves of one
// parabola meeting end to end. The Bezier clipper's recursion never shrinks on a shared stretch,
// so it either trips its Bezout guard and returns nothing, or exhausts its node budget first and
// returns what it had sampled: a quad against itself degree-elevated can come back as nine
// "crossings" 1e-4 apart at t = 0.
//
// What the consumers need is the overlap's two ends. The planar graph (segmentSet -> dcel) takes
// edges that meet only at their endpoints; a curve that runs along part of another has to be cut
// where the shared stretch begins and ends, or the two edges overlap in their interiors and no
// face structure is right. cpatchGraph cuts at every hit so that overlaps become shared nodes, and
// shapeResolve reads any hit away from a shared vertex as the self-overlap it resolves. Where the
// whole of both curves coincide the ends ARE their endpoints, which no consumer cuts at, so an
// identical or reversed duplicate changes nothing; and where the stretches of one curve only meet
// at a point, that point is the whole intersection.
//
// Exact rather than sampled. Every overlap end is an endpoint of one curve lying on the other, so
// the candidates are at most four point-on-curve solves (closed-form roots, polished). Two proper
// polynomial parameterizations of one curve differ by an AFFINE map (for degree <= 3 only a line
// can be traced improperly, and lines are left to their own kernels), so two incidences fix the
// correspondence u = a*s + b, and agreement at four points of the interval proves the identity:
// A(s) - B(a*s + b) is a polynomial of degree <= 3, so four near-zeros bound it on the whole
// interval. A cubic with a loop adds one more fact: the double point is a genuine crossing between
// the stretches when they pass it on different branches.
//
// Tolerances are the pair's extent and the precision its coordinates carry, as in exactCrossings;
// parameters are dimensionless.
import { solveCubic } from '../polyRoots.js';

const PARAM_EPS = 1e-9;

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// Power-basis coefficients [x0..x3], [y0..y3] of a quad or cubic.
function powerBasis(P) {
  const out = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let k = 0; k < 2; k++) {
    if (P.length === 3) {
      const [a, b, c] = [P[0][k], P[1][k], P[2][k]];
      out[k][0] = a;
      out[k][1] = 2 * (b - a);
      out[k][2] = a - 2 * b + c;
    } else {
      const [a, b, c, d] = [P[0][k], P[1][k], P[2][k], P[3][k]];
      out[k][0] = a;
      out[k][1] = 3 * (b - a);
      out[k][2] = 3 * (a - 2 * b + c);
      out[k][3] = d - a + 3 * (b - c);
    }
  }
  return out;
}
const at = (c, s) => [
  ((c[0][3] * s + c[0][2]) * s + c[0][1]) * s + c[0][0],
  ((c[1][3] * s + c[1][2]) * s + c[1][1]) * s + c[1][0],
];
const d1 = (c, s) => [
  (3 * c[0][3] * s + 2 * c[0][2]) * s + c[0][1],
  (3 * c[1][3] * s + 2 * c[1][2]) * s + c[1][1],
];
const d2 = (c, s) => [6 * c[0][3] * s + 2 * c[0][2], 6 * c[1][3] * s + 2 * c[1][2]];

function boxOf(P, tol) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of P) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0 - tol, y0 - tol, x1 + tol, y1 + tol];
}
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

// Every s in [0,1] with C(s) within tol of pt: each axis's roots are candidates (the other axis
// catches the one an extremum makes ill-conditioned), polished by Newton on the projection.
function paramsOn(P, c, pt, tol) {
  const out = [];
  const push = (s) => {
    for (const q of out) if (Math.abs(q - s) <= PARAM_EPS) return;
    out.push(s);
  };
  const n = P.length - 1;
  if (dist(P[0], pt) <= tol) push(0);
  if (dist(P[n], pt) <= tol) push(1);
  for (let k = 0; k < 2; k++) {
    for (let s of solveCubic(c[k][3], c[k][2], c[k][1], c[k][0] - pt[k])) {
      if (!(s > -1e-3 && s < 1 + 1e-3)) continue;
      for (let it = 0; it < 4; it++) {
        const q = at(c, s),
          v = d1(c, s),
          w = d2(c, s);
        const ex = q[0] - pt[0],
          ey = q[1] - pt[1];
        const g = ex * v[0] + ey * v[1],
          dg = v[0] * v[0] + v[1] * v[1] + ex * w[0] + ey * w[1];
        if (!(dg > 0)) break;
        s -= g / dg;
      }
      s = Math.min(1, Math.max(0, s));
      if (dist(at(c, s), pt) <= tol) push(s);
    }
  }
  return out;
}

function collinear(P, tol) {
  let bi = 0,
    bj = 1,
    best = -1;
  for (let i = 0; i < P.length; i++)
    for (let j = i + 1; j < P.length; j++) {
      const d = dist(P[i], P[j]);
      if (d > best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  if (!(best > tol)) return true;
  const A = P[bi],
    B = P[bj],
    nx = -(B[1] - A[1]) / best,
    ny = (B[0] - A[0]) / best;
  for (const p of P) if (Math.abs(nx * (p[0] - A[0]) + ny * (p[1] - A[1])) > tol) return false;
  return true;
}

function pairTolerance(ctrlA, ctrlB) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    mag = 0;
  for (const P of [ctrlA, ctrlB])
    for (const p of P) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
      mag = Math.max(mag, Math.abs(p[0]), Math.abs(p[1]));
    }
  const ext = Math.max(x1 - x0, y1 - y0);
  return ext > 0 && isFinite(ext) ? Math.max(1e-9 * ext, 32e-15 * mag) : 0;
}

/** Does quad A lie on quad B's PARABOLA -- the whole curve, not just B's stretch of it?
 *
 *  Five points of A within tolerance of the parabola: A is degree 2, so B's implicit along A is a
 *  quartic, and five near-zeros bound it on all of A. Each point is projected onto the parabola
 *  from its exact linear inverse (Newton on the projection, since that inverse is only exact ON
 *  the curve), so the test is a distance and carries the pair's tolerance.
 */
export function liesOnParabola(ctrlA, ctrlB) {
  const tol = pairTolerance(ctrlA, ctrlB);
  if (!(tol > 0)) return false;
  const ox = ctrlA[0][0],
    oy = ctrlA[0][1];
  const B = ctrlB.map((p) => [p[0] - ox, p[1] - oy]);
  const cB = powerBasis(B);
  const det = cB[0][1] * cB[1][2] - cB[0][2] * cB[1][1];
  if (!(Math.abs(det) > 0)) return false;
  const cA = powerBasis(ctrlA.map((p) => [p[0] - ox, p[1] - oy]));
  for (const s of [0.5, 0, 1, 0.25, 0.75]) {
    const P = at(cA, s);
    let u = (cB[1][2] * (P[0] - cB[0][0]) - cB[0][2] * (P[1] - cB[1][0])) / det;
    for (let it = 0; it < 3; it++) {
      const q = at(cB, u),
        v = d1(cB, u),
        w = d2(cB, u);
      const ex = q[0] - P[0],
        ey = q[1] - P[1];
      const dg = v[0] * v[0] + v[1] * v[1] + ex * w[0] + ey * w[1];
      if (!(dg > 0)) break;
      u -= (ex * v[0] + ey * v[1]) / dg;
    }
    if (!(dist(at(cB, u), P) <= tol)) return false;
  }
  return true;
}

/** The hits between two quads/cubics (control-point arrays) that lie along one underlying curve.
 *
 *  Returns the ends of their shared stretch (plus a loop's double point when the stretches pass it
 *  on different branches) as `{ tA, tB, x, y, endpointA, endpointB }` records, or null when no
 *  shared stretch of positive length is established. With `onSameCurve` -- the caller has already
 *  shown algebraically that A lies on B's curve -- a shared stretch that is absent means the
 *  stretches meet only at points, and those points are returned instead of null.
 */
export function sameCurveHits(ctrlA, ctrlB, onSameCurve = false) {
  if (ctrlA.length < 3 || ctrlB.length < 3) return null;
  const tol = pairTolerance(ctrlA, ctrlB);
  if (!(tol > 0)) return null;
  // The cheap reject first, on the caller's own arrays: this runs ahead of every clipper call, and
  // nearly every pair has fewer than two endpoints inside the other's box.
  if (!onSameCurve) {
    const bA = boxOf(ctrlA, tol),
      bB = boxOf(ctrlB, tol);
    const n =
      (inBox(ctrlB[0], bA) ? 1 : 0) +
      (inBox(ctrlB[ctrlB.length - 1], bA) ? 1 : 0) +
      (inBox(ctrlA[0], bB) ? 1 : 0) +
      (inBox(ctrlA[ctrlA.length - 1], bB) ? 1 : 0);
    if (n < 2) return null;
  }
  // Worked relative to one origin, so the coefficients carry the extent rather than the offset.
  const ox = ctrlA[0][0],
    oy = ctrlA[0][1];
  const A = ctrlA.map((p) => [p[0] - ox, p[1] - oy]),
    B = ctrlB.map((p) => [p[0] - ox, p[1] - oy]);
  const boxA = boxOf(A, tol),
    boxB = boxOf(B, tol);
  const nA = A.length - 1,
    nB = B.length - 1;
  // A shared stretch has two ends, and each is an endpoint of one curve inside the other's hull.
  const ends = [
    [B[0], 'B', 0, 0],
    [B[nB], 'B', 1, nB],
    [A[0], 'A', 0, 0],
    [A[nA], 'A', 1, nA],
  ];
  const inside = ends.filter(([p, who]) => inBox(p, who === 'B' ? boxA : boxB));
  if (inside.length < 2 && !onSameCurve) return null;
  if (collinear(A, tol) || collinear(B, tol)) return null;
  const cA = powerBasis(A),
    cB = powerBasis(B);

  const inc = [];
  const addInc = (s, u, who, idx) => {
    for (const q of inc)
      if (Math.abs(q.s - s) <= PARAM_EPS && Math.abs(q.u - u) <= PARAM_EPS) return;
    inc.push({ s, u, p: who === 'B' ? ctrlB[idx] : ctrlA[idx] });
  };
  for (const [p, who, t, idx] of inside) {
    if (who === 'B') for (const s of paramsOn(A, cA, p, tol)) addInc(s, t, who, idx);
    else for (const u of paramsOn(B, cB, p, tol)) addInc(t, u, who, idx);
  }
  // `sameCurve` tells a caller with a second opinion (intersect/exact.js, shapeResolve) that this pair was
  // answered as ONE curve: an exact composition along a curve that coincides with it is a polynomial of
  // rounding noise, and its roots are points of the shared stretch, not crossings.
  const hit = (s, u, p) => ({
    tA: s,
    tB: u,
    x: p[0],
    y: p[1],
    endpointA: s === 0 || s === 1,
    endpointB: u === 0 || u === 1,
    sameCurve: true,
  });

  let best = null;
  for (let i = 0; i < inc.length; i++)
    for (let j = i + 1; j < inc.length; j++) {
      const I = inc[i],
        J = inc[j];
      if (Math.abs(J.s - I.s) <= PARAM_EPS || Math.abs(J.u - I.u) <= PARAM_EPS) continue;
      if (dist(I.p, J.p) <= tol) continue;
      if (best && Math.abs(J.s - I.s) <= Math.abs(best[1].s - best[0].s)) continue;
      const a = (J.u - I.u) / (J.s - I.s),
        b = I.u - a * I.s;
      let same = true;
      for (const k of [1, 2]) {
        const s = I.s + ((J.s - I.s) * k) / 3;
        if (dist(at(cA, s), at(cB, a * s + b)) > tol) {
          same = false;
          break;
        }
      }
      if (same) best = [I, J];
    }
  if (!best) {
    if (!onSameCurve) return null;
    const out = [];
    for (const q of inc)
      if (!out.some((h) => dist([h.x, h.y], q.p) <= tol)) out.push(hit(q.s, q.u, q.p));
    return out;
  }
  const [I, J] = best;
  const out = [hit(I.s, I.u, I.p), hit(J.s, J.u, J.p)];
  // A loop's double point: A at one branch parameter meets B where B passes the other branch.
  const a = (J.u - I.u) / (J.s - I.s),
    b = I.u - a * I.s;
  const c1 = [cA[0][1], cA[1][1]],
    c2 = [cA[0][2], cA[1][2]],
    c3 = [cA[0][3], cA[1][3]];
  const cr = c2[0] * c3[1] - c2[1] * c3[0];
  if (
    Math.hypot(c3[0], c3[1]) > tol &&
    Math.abs(cr) > 1e-12 * Math.hypot(...c2) * Math.hypot(...c3)
  ) {
    const sig = -(c1[0] * c3[1] - c1[1] * c3[0]) / cr;
    const k = Math.abs(c3[0]) >= Math.abs(c3[1]) ? 0 : 1;
    const pi = sig * sig + (c1[k] + c2[k] * sig) / c3[k];
    const disc = sig * sig - 4 * pi;
    if (disc > 0) {
      const r = Math.sqrt(disc),
        dA = (sig - r) / 2,
        dB = (sig + r) / 2;
      for (const [s, other] of [
        [dA, dB],
        [dB, dA],
      ]) {
        const u = a * other + b;
        if (!(s >= 0 && s <= 1 && u >= 0 && u <= 1)) continue;
        const q = at(cA, s);
        if (out.some((h) => Math.abs(h.tA - s) <= PARAM_EPS && Math.abs(h.tB - u) <= PARAM_EPS))
          continue;
        out.push(hit(s, u, [q[0] + ox, q[1] + oy]));
      }
    }
  }
  return out;
}

// ---- lines on one line ------------------------------------------------------------------------------

/** The hits between two line segments that lie on ONE LINE, or null when they do not.
 *
 *  Collinear means every endpoint of each is within the pair's tolerance of the other's line, a
 *  distance -- not a small determinant, which also calls two CROSSING segments parallel when one is
 *  short. On one line the answer is the same as for curves: every endpoint of one that lies within
 *  the other is an end of the shared stretch (or the lone touch point), with the endpoint's own
 *  parameter and coordinates exact. */
export function sameLineHits(a0, a1, b0, b1) {
  const tol = pairTolerance([a0, a1], [b0, b1]);
  if (!(tol > 0)) return null;
  const ax = a1[0] - a0[0],
    ay = a1[1] - a0[1],
    bx = b1[0] - b0[0],
    by = b1[1] - b0[1];
  const la = Math.hypot(ax, ay),
    lb = Math.hypot(bx, by);
  if (!(la > tol) || !(lb > tol)) return null;
  const offA = (p) => Math.abs((p[0] - a0[0]) * ay - (p[1] - a0[1]) * ax) / la;
  const offB = (p) => Math.abs((p[0] - b0[0]) * by - (p[1] - b0[1]) * bx) / lb;
  if (!(offA(b0) <= tol && offA(b1) <= tol && offB(a0) <= tol && offB(a1) <= tol)) return null;
  const onA = (p) => ((p[0] - a0[0]) * ax + (p[1] - a0[1]) * ay) / (la * la);
  const onB = (p) => ((p[0] - b0[0]) * bx + (p[1] - b0[1]) * by) / (lb * lb);
  const epsA = tol / la,
    epsB = tol / lb;
  const inc = [];
  const add = (tA, tB, p) => {
    if (inc.some((h) => dist([h.x, h.y], p) <= tol)) return;
    inc.push({
      tA,
      tB,
      x: p[0],
      y: p[1],
      endpointA: tA === 0 || tA === 1,
      endpointB: tB === 0 || tB === 1,
      sameCurve: true,
    });
  };
  // Shared endpoints first, so both parameters of such a point stay exact.
  for (const [p, tA] of [
    [a0, 0],
    [a1, 1],
  ])
    for (const [q, tB] of [
      [b0, 0],
      [b1, 1],
    ])
      if (dist(p, q) <= tol) add(tA, tB, p);
  for (const [p, tA] of [
    [a0, 0],
    [a1, 1],
  ]) {
    const u = onB(p);
    if (u >= -epsB && u <= 1 + epsB) add(tA, Math.min(1, Math.max(0, u)), p);
  }
  for (const [q, tB] of [
    [b0, 0],
    [b1, 1],
  ]) {
    const s = onA(q);
    if (s >= -epsA && s <= 1 + epsA) add(Math.min(1, Math.max(0, s)), tB, q);
  }
  return inc;
}

// ---- arcs on one ellipse ----------------------------------------------------------------------------

const arcAt = (s, th) => {
  const cp = Math.cos(s.phi || 0),
    sp = Math.sin(s.phi || 0),
    x = s.rx * Math.cos(th),
    y = s.ry * Math.sin(th);
  return [s.cx + x * cp - y * sp, s.cy + x * sp + y * cp];
};
function arcTolerance(A, B) {
  const box = (s) => {
    const r = Math.max(s.rx, s.ry);
    return [
      [s.cx - r, s.cy - r],
      [s.cx + r, s.cy + r],
    ];
  };
  return pairTolerance(box(A), box(B));
}
/** The parameter angle on arc A's ellipse of the point on it nearest p, and that distance: Newton on
 *  the projection, from the angle p has in A's scaled frame (exact for a point ON the ellipse). */
function projectOnEllipse(A, p) {
  const cp = Math.cos(A.phi || 0),
    sp = Math.sin(A.phi || 0);
  const dx = p[0] - A.cx,
    dy = p[1] - A.cy,
    qx = dx * cp + dy * sp,
    qy = -dx * sp + dy * cp;
  let th = Math.atan2(qy / A.ry, qx / A.rx);
  for (let it = 0; it < 6; it++) {
    const c = Math.cos(th),
      s = Math.sin(th);
    const ex = A.rx * c - qx,
      ey = A.ry * s - qy,
      tx = -A.rx * s,
      ty = A.ry * c;
    const g = ex * tx + ey * ty,
      dg = tx * tx + ty * ty - (ex * A.rx * c + ey * A.ry * s);
    if (!(dg > 0)) break;
    const n = th - g / dg;
    if (n === th) break;
    th = n;
  }
  return { th, d: Math.hypot(A.rx * Math.cos(th) - qx, A.ry * Math.sin(th) - qy) };
}

/** Is arc B on arc A's ELLIPSE -- the whole curve, not A's stretch of it?
 *
 *  Decided on points, not on the parameters: ellipses written with another frame angle, the radii in
 *  the other order, or theta whole turns on are one curve, and nearly equal radii are not. Five points
 *  of B within tolerance of A's ellipse: five points determine a conic, so the two agree. They sit at
 *  the middles of five equal pieces of B's sweep, so a full ellipse gives five distinct ones. */
export function sameEllipse(A, B) {
  if (!(A.rx > 0 && A.ry > 0 && B.rx > 0 && B.ry > 0)) return false;
  const tol = arcTolerance(A, B);
  if (!(tol > 0)) return false;
  const sw = B.theta_end - B.theta_start;
  for (let k = 0; k < 5; k++)
    if (!(projectOnEllipse(A, arcAt(B, B.theta_start + (sw * (k + 0.5)) / 5)).d <= tol))
      return false;
  return true;
}

/** The hits between two arcs on one ellipse, or null when they are not on one.
 *
 *  Both arcs are read as intervals of A's parameter angle, a circle. B's interval is found from B's
 *  own points (projected, so the two parameterizations never have to be reconciled) and keeps B's
 *  sweep. Two intervals of a circle overlap in up to two pieces -- arcs that meet around the back --
 *  and every end of a piece is a hit; a full ellipse's seam, being its endpoint, is one wherever the
 *  other arc covers it. */
export function sameEllipseHits(A, B) {
  if (!sameEllipse(A, B)) return null;
  const tol = arcTolerance(A, B);
  const TWO_PI = 2 * Math.PI;
  const angTol = tol / Math.min(A.rx, A.ry);
  const mod = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
  const swA = A.theta_end - A.theta_start,
    swB = B.theta_end - B.theta_start;
  const LA = Math.min(Math.abs(swA), TWO_PI),
    LB = Math.min(Math.abs(swB), TWO_PI);
  if (!(LA > 0 && LB > 0)) return null;
  // B's start and its direction, in A's angle. The direction is read a QUARTER of B's sweep in, at most
  // a quarter turn, where forward and backward differ by at least half a turn; at the middle of a full
  // ellipse they are both half a turn and rounding chose.
  const b0 = projectOnEllipse(A, arcAt(B, B.theta_start)).th;
  const bq = projectOnEllipse(A, arcAt(B, B.theta_start + swB / 4)).th;
  const fwdB = Math.abs(mod(bq - b0) - LB / 4) <= Math.abs(mod(b0 - bq) - LB / 4);
  const startA = swA >= 0 ? A.theta_start : A.theta_end;
  const oB = mod((fwdB ? b0 : b0 - LB) - startA);
  const out = [];
  const push = (o, base) => {
    let tA = Math.min(1, Math.max(0, o / LA)),
      tB = Math.min(1, Math.max(0, (o - base) / LB));
    if (swA < 0) tA = 1 - tA;
    if (!fwdB) tB = 1 - tB;
    if (tA <= angTol / LA) tA = 0;
    else if (tA >= 1 - angTol / LA) tA = 1;
    if (tB <= angTol / LB) tB = 0;
    else if (tB >= 1 - angTol / LB) tB = 1;
    const p =
      tA === 0 || tA === 1
        ? arcAt(A, tA === 0 ? A.theta_start : A.theta_end)
        : tB === 0 || tB === 1
          ? arcAt(B, tB === 0 ? B.theta_start : B.theta_end)
          : arcAt(A, A.theta_start + swA * tA);
    if (out.some((h) => dist([h.x, h.y], p) <= tol)) return;
    out.push({
      tA,
      tB,
      x: p[0],
      y: p[1],
      endpointA: tA === 0 || tA === 1,
      endpointB: tB === 0 || tB === 1,
      sameCurve: true,
    });
  };
  for (const base of [oB, oB - TWO_PI]) {
    const lo = Math.max(0, base),
      hi = Math.min(LA, base + LB);
    if (hi < lo - angTol) continue;
    push(lo, base);
    if (hi - lo > angTol) push(hi, base);
  }
  return out;
}
