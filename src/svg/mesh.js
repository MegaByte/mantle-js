// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/mesh.js — cover-quad emitter + supporting curve
// geometry (apex finding, cubic split, monotone subdivision, convex
// hull, OBB fitting).
//
// getCoverQuadMesh: given a shape's seg list, fill color, and fill-rule,
// it produces the per-shape OBB cover-quad mesh (COVER_QUAD_STRIDE × N
// floats) that the fill fragment shader rasterizes. The OBB fit uses PCA
// on closed-form curve moments (accumMomentsForSeg + fitOBBAnalytic) so
// diagonal shapes (italic text, rotated panels) get tight bounds.

import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  mkLine,
  segStart,
  segEnd,
  segStartEnd,
} from './segment.js';
import { segBbox, segBboxInto, polygonSignedArea } from './bbox.js';

const COVER_QUAD_STRIDE = 12;

// De Casteljau cubic split at parameter t. Returns [leftSub, rightSub]
// where each sub is { p1, p2, p3, p4 }.
export function splitCubicAt(seg, t) {
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const q1 = lerp(seg.p1, seg.p2, t);
  const q2 = lerp(seg.p2, seg.p3, t);
  const q3 = lerp(seg.p3, seg.p4, t);
  const r1 = lerp(q1, q2, t);
  const r2 = lerp(q2, q3, t);
  const s = lerp(r1, r2, t);
  return [
    { type: SEG_CUBIC, p1: seg.p1, p2: q1, p3: r1, p4: s },
    { type: SEG_CUBIC, p1: s, p2: r2, p3: q3, p4: seg.p4 },
  ];
}

// Quadratic Bezier subdivision (only y- and x-extrema, no inflection).
// Same approach.
export function splitQuadAt(seg, t) {
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const q1 = lerp(seg.p1, seg.p2, t);
  const q2 = lerp(seg.p2, seg.p3, t);
  const s = lerp(q1, q2, t);
  return [
    { type: SEG_QUAD, p1: seg.p1, p2: q1, p3: s },
    { type: SEG_QUAD, p1: s, p2: q2, p3: seg.p3 },
  ];
}

// Analytic OBB fit via closed-form curve moments + analytic axis
// projection. The principal axis comes from the eigenangle of the
// curve's centerd covariance matrix (built by accumMomentsForSeg);
// the OBB extents along that axis come from projecting each segment's
// analytic min/max (projectSegExtentOnAxis). All four primitives
// (line / quad / cubic / arc) contribute exactly, with no sampling.
//
// Why analytic over PCA-on-points: per-primitive point sampling weights
// each segment by ITS sample count, not by its natural-parameter "mass",
// which biases PCA on shapes mixing primitives of unequal sweep (e.g. an
// SVG circle = one 270° arc + one 90° arc over-represents the 90°
// quadrant 4×, rotating the OBB on what should be an axisymmetric cloud).
//
// Why PCA over rotating calipers: still O(N) and yields a good-enough
// OBB. True min-area OBB needs convex hull + calipers (more code, not
// much extra win on the diagonal-stroke / italic-glyph shapes that
// motivate having an OBB at all).
//
// Tie-breakers:
//   - Principal axis within ~5° of world axes → fall back to AABB
//     (rotated-by-float-noise OBB on near-axis-aligned shapes).
//   - OBB sides within 5% (axisymmetric / regular polygons) → fall
//     back to AABB. PCA's eigenangle is ill-conditioned when the two
//     eigenvalues are nearly equal; the rotated OBB doesn't yield a
//     tighter cover than AABB but DOES extend past the AABB at the
//     rotated corners. That sticks the fragment shader into
//     evaluating coverage at em-coords outside the shape's AABB,
//     where the band-walker clamps to the boundary band and
//     mis-classifies near-edge pixels.
//
// Returns 4 quad corners in CCW order, or null if degenerate /
// fallback to AABB requested.
export function fitOBBAnalytic(M, segs, padEm) {
  if (!(M.L > 0)) return null;
  // Centerd covariance: Cxx = Sxx - Sx²/L, etc.
  const mx = M.Sx / M.L;
  const my = M.Sy / M.L;
  const cxx = M.Sxx - M.Sx * mx;
  const cxy = M.Sxy - M.Sx * my;
  const cyy = M.Syy - M.Sy * my;
  const trace = cxx + cyy;

  if (!(trace > 64 * Number.EPSILON * (Math.abs(M.Sxx) + Math.abs(M.Syy)))) return null;
  const diff = cxx - cyy;
  const off2 = 2 * cxy;
  const angle = 0.5 * Math.atan2(off2, diff);
  // Skip OBB if eigen-axis is within ~5° of world axes. Avoids
  // rotated-by-float-noise OBBs on near-axis-aligned shapes.
  if (
    Math.abs(angle) < 0.087 ||
    Math.abs(angle) > Math.PI - 0.087 ||
    Math.abs(Math.abs(angle) - 0.5 * Math.PI) < 0.087
  ) {
    return null;
  }
  const ux = Math.cos(angle),
    uy = Math.sin(angle);
  const vx = -uy,
    vy = ux;
  // Per-seg analytic extent projection onto (u, v) basis.
  const eU = { min: +Infinity, max: -Infinity };
  const eV = { min: +Infinity, max: -Infinity };
  for (const seg of segs) {
    if (!seg) continue;
    projectSegExtentOnAxis(seg, ux, uy, eU);
    projectSegExtentOnAxis(seg, vx, vy, eV);
  }
  if (!isFinite(eU.min) || !isFinite(eV.min)) return null;
  // Apply pad in OBB axes (uniform expansion in both axes).
  let uMin = eU.min,
    uMax = eU.max,
    vMin = eV.min,
    vMax = eV.max;
  if (padEm > 0) {
    uMin -= padEm;
    uMax += padEm;
    vMin -= padEm;
    vMax += padEm;
  }
  // Square-ish fallback: if the OBB sides are within 5%, PCA's
  // rotation choice is ill-conditioned (eigenvalues nearly equal,
  // angle dominated by noise). AABB gives the same area but stays
  // inside the shape's AABB so the band-walker's clamp logic doesn't
  // misclassify fragments outside the rotated quad.
  const uLen = uMax - uMin,
    vLen = vMax - vMin;
  if (uLen > 0 && vLen > 0) {
    const ratio = uLen > vLen ? vLen / uLen : uLen / vLen;
    if (ratio > 0.95) return null;
  }

  const corner = (u, v) => [ux * u + vx * v, uy * u + vy * v];
  return [corner(uMin, vMin), corner(uMax, vMin), corner(uMax, vMax), corner(uMin, vMax)];
}

// ===== Analytic curve moments for PCA-OBB =====
//
// Each primitive contributes (L, Sx, Sy, Sxx, Sxy, Syy) computed by
// closed-form integrals over its natural parameter (t ∈ [0,1] for
// Bezier; θ ∈ [θ_start, θ_end] for arc). The OBB principal axis is
// then the eigenangle of the centerd covariance matrix C, computed
// once for the whole shape — independent of any per-primitive sample
// density. Point-cloud PCA would bias the eigenangle when a shape mixes
// primitives of very different natural-parameter "mass" (e.g. an SVG
// circle made of one 270° + one 90° arc, where sampling both as the
// same 8 points gives the 90° quadrant 4× the weight per unit arc
// length and rotates the OBB on what should be an axisymmetric cloud).
//
// Choice of parameter: natural parameter (t for Bezier, θ for arc),
// NOT arc length. Closed form for natural; arc length needs numeric
// integration for Beziers. The cost is fast-moving regions get
// proportionally less integration weight — which for OBB axis choice
// is FINE because what matters is the relative distribution of curve
// "mass" along the natural parameter, not the visual arc length.

// Closed-form ∫₀¹ p(t) and ∫₀¹ p(t)·q(t) dt for cubic-power-form
// polynomials p(t) = a + bt + ct² + dt³ (and similarly for q). Used
// to fold every Bezier primitive (line / quad / cubic) into the
// same closed-form moment accumulator. Conversion of Bezier control
// points to power coefficients happens at the call site.
function intP(c) {
  // ∫₀¹ p dt where p = a + bt + ct² + dt³
  return c.a + c.b / 2 + c.c / 3 + c.d / 4;
}
function intPQ(p, q) {
  // ∫₀¹ p(t)·q(t) dt
  const a = p.a,
    b = p.b,
    c = p.c,
    d = p.d;
  const e = q.a,
    f = q.b,
    g = q.c,
    h = q.d;
  // (a + bt + ct² + dt³)·(e + ft + gt² + ht³) expanded:
  //   c0 = ae
  //   c1 = af + be
  //   c2 = ag + bf + ce
  //   c3 = ah + bg + cf + de
  //   c4 = bh + cg + df
  //   c5 = ch + dg
  //   c6 = dh
  // ∫₀¹ t^k = 1/(k+1)
  return (
    a * e +
    (a * f + b * e) / 2 +
    (a * g + b * f + c * e) / 3 +
    (a * h + b * g + c * f + d * e) / 4 +
    (b * h + c * g + d * f) / 5 +
    (c * h + d * g) / 6 +
    (d * h) / 7
  );
}

// Convert a segment to (px, py) power-form cubic polynomials per
// axis. Lines have c=d=0; quads have d=0; cubics use all 4 terms.
// Arc returns null (handled separately via trig integrals).
function segToPolyXY(s) {
  if (s.type === SEG_LINE) {
    return {
      px: { a: s.p1[0], b: s.p2[0] - s.p1[0], c: 0, d: 0 },
      py: { a: s.p1[1], b: s.p2[1] - s.p1[1], c: 0, d: 0 },
    };
  }
  if (s.type === SEG_QUAD) {
    const x0 = s.p1[0],
      x1 = s.p2[0],
      x2 = s.p3[0];
    const y0 = s.p1[1],
      y1 = s.p2[1],
      y2 = s.p3[1];
    return {
      px: { a: x0, b: 2 * (x1 - x0), c: x0 - 2 * x1 + x2, d: 0 },
      py: { a: y0, b: 2 * (y1 - y0), c: y0 - 2 * y1 + y2, d: 0 },
    };
  }
  if (s.type === SEG_CUBIC) {
    const x0 = s.p1[0],
      x1 = s.p2[0],
      x2 = s.p3[0],
      x3 = s.p4[0];
    const y0 = s.p1[1],
      y1 = s.p2[1],
      y2 = s.p3[1],
      y3 = s.p4[1];
    return {
      px: { a: x0, b: 3 * (x1 - x0), c: 3 * (x0 - 2 * x1 + x2), d: -x0 + 3 * x1 - 3 * x2 + x3 },
      py: { a: y0, b: 3 * (y1 - y0), c: 3 * (y0 - 2 * y1 + y2), d: -y0 + 3 * y1 - 3 * y2 + y3 },
    };
  }
  return null;
}

// Add segment's closed-form moments to accumulator
// M = { L, Sx, Sy, Sxx, Sxy, Syy }. Integration variable is the
// segment's natural parameter (t for Bezier, θ for arc).
export function accumMomentsForSeg(s, M) {
  if (!s) return;
  if (s.type === SEG_ARC) {
    // x(θ) = cx + Ax·cos θ + Bx·sin θ
    // y(θ) = cy + Ay·cos θ + By·sin θ
    // where Ax = cp·rx, Bx = -sp·ry, Ay = sp·rx, By = cp·ry.
    const cp = Math.cos(s.phi || 0),
      sp = Math.sin(s.phi || 0);
    const Ax = cp * s.rx,
      Bx = -sp * s.ry;
    const Ay = sp * s.rx,
      By = cp * s.ry;
    const t0 = s.theta_start,
      t1 = s.theta_end;
    const L = t1 - t0;
    // Antiderivatives:
    //   ∫cos θ dθ = sin θ
    //   ∫sin θ dθ = -cos θ
    //   ∫cos²θ dθ = θ/2 + sin(2θ)/4
    //   ∫sin²θ dθ = θ/2 - sin(2θ)/4
    //   ∫cos θ·sin θ dθ = -cos(2θ)/4
    const Icos = Math.sin(t1) - Math.sin(t0); // ∫cos
    const Isin = -(Math.cos(t1) - Math.cos(t0)); // ∫sin
    const Icos2 = L / 2 + (Math.sin(2 * t1) - Math.sin(2 * t0)) / 4; // ∫cos²
    const Isin2 = L / 2 - (Math.sin(2 * t1) - Math.sin(2 * t0)) / 4; // ∫sin²
    const Ics = -(Math.cos(2 * t1) - Math.cos(2 * t0)) / 4; // ∫cos·sin
    // ∫x dθ = cx·L + Ax·Icos + Bx·Isin
    // ∫y dθ = cy·L + Ay·Icos + By·Isin
    M.L += L;
    M.Sx += s.cx * L + Ax * Icos + Bx * Isin;
    M.Sy += s.cy * L + Ay * Icos + By * Isin;
    // ∫x² dθ = ∫(cx + Ax·cos + Bx·sin)² dθ
    //         = cx²·L + 2·cx·(Ax·Icos + Bx·Isin)
    //         + Ax²·Icos2 + 2·Ax·Bx·Ics + Bx²·Isin2
    M.Sxx +=
      s.cx * s.cx * L +
      2 * s.cx * (Ax * Icos + Bx * Isin) +
      Ax * Ax * Icos2 +
      2 * Ax * Bx * Ics +
      Bx * Bx * Isin2;
    // ∫y² dθ analogously
    M.Syy +=
      s.cy * s.cy * L +
      2 * s.cy * (Ay * Icos + By * Isin) +
      Ay * Ay * Icos2 +
      2 * Ay * By * Ics +
      By * By * Isin2;
    // ∫x·y dθ = ∫(cx + Ax·cos + Bx·sin)·(cy + Ay·cos + By·sin) dθ
    //         = cx·cy·L
    //         + cx·(Ay·Icos + By·Isin)
    //         + cy·(Ax·Icos + Bx·Isin)
    //         + Ax·Ay·Icos2 + (Ax·By + Bx·Ay)·Ics + Bx·By·Isin2
    M.Sxy +=
      s.cx * s.cy * L +
      s.cx * (Ay * Icos + By * Isin) +
      s.cy * (Ax * Icos + Bx * Isin) +
      Ax * Ay * Icos2 +
      (Ax * By + Bx * Ay) * Ics +
      Bx * By * Isin2;
    return;
  }
  const poly = segToPolyXY(s);
  if (!poly) return;
  // Bezier (line/quad/cubic) in power form. Integration over t ∈ [0,1].
  M.L += 1;
  M.Sx += intP(poly.px);
  M.Sy += intP(poly.py);
  M.Sxx += intPQ(poly.px, poly.px);
  M.Sxy += intPQ(poly.px, poly.py);
  M.Syy += intPQ(poly.py, poly.py);
}

// Find the min/max of g(t) = ux·x(t) + uy·y(t) over t ∈ [0,1] (Bezier)
// or θ ∈ [θ_start, θ_end] (arc), in closed form. Updates ext = {min, max}.
export function projectSegExtentOnAxis(s, ux, uy, ext) {
  if (s.type === SEG_LINE) {
    let g = ux * s.p1[0] + uy * s.p1[1];
    if (g < ext.min) ext.min = g;
    if (g > ext.max) ext.max = g;
    g = ux * s.p2[0] + uy * s.p2[1];
    if (g < ext.min) ext.min = g;
    if (g > ext.max) ext.max = g;
    return;
  }
  if (s.type === SEG_QUAD || s.type === SEG_CUBIC) {
    const poly = segToPolyXY(s);
    const px = poly.px,
      py = poly.py;
    // g(t) = ux·(a + bt + ct² + dt³) + uy·(e + ft + gt² + ht³)
    //      = (ux·a + uy·e) + (ux·b + uy·f)t + (ux·c + uy·g)t²
    //                                       + (ux·d + uy·h)t³
    // g'(t) = (ux·b + uy·f) + 2(ux·c + uy·g)t + 3(ux·d + uy·h)t²
    const A = ux * px.a + uy * py.a;
    const B = ux * px.b + uy * py.b;
    const C = ux * px.c + uy * py.c;
    const D = ux * px.d + uy * py.d;
    // Endpoints.
    let ex0, ey0, ex1, ey1;
    if (s.type === SEG_QUAD) {
      ex0 = s.p1[0];
      ey0 = s.p1[1];
      ex1 = s.p3[0];
      ey1 = s.p3[1];
    } else {
      ex0 = s.p1[0];
      ey0 = s.p1[1];
      ex1 = s.p4[0];
      ey1 = s.p4[1];
    }
    let g = ux * ex0 + uy * ey0;
    if (g < ext.min) ext.min = g;
    if (g > ext.max) ext.max = g;
    g = ux * ex1 + uy * ey1;
    if (g < ext.min) ext.min = g;
    if (g > ext.max) ext.max = g;

    const qa = 3 * D,
      qb = 2 * C,
      qc = B;
    const crit = [];
    if (qa === 0) {
      if (qb !== 0) crit.push(-qc / qb);
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc),
          n0 = -qb - sq,
          n1 = -qb + sq;
        crit.push(
          Math.abs(n0) >= 1e-3 * Math.abs(qb) ? n0 / (2 * qa) : (2 * qc) / n1,
          Math.abs(n1) >= 1e-3 * Math.abs(qb) ? n1 / (2 * qa) : (2 * qc) / n0,
        );
      }
    }
    for (const t of crit) {
      if (t > 0 && t < 1) {
        const gv = A + B * t + C * t * t + D * t * t * t;
        if (gv < ext.min) ext.min = gv;
        if (gv > ext.max) ext.max = gv;
      }
    }
    return;
  }
  if (s.type === SEG_ARC) {
    // g(θ) = ux·(cx + Ax·cos + Bx·sin) + uy·(cy + Ay·cos + By·sin)
    //      = const + (ux·Ax + uy·Ay)·cos θ + (ux·Bx + uy·By)·sin θ
    //      = const + R·cos(θ - φ_ax)
    // where R = √(Cc² + Cs²), Cc = ux·Ax+uy·Ay, Cs = ux·Bx+uy·By.
    // g'(θ) = -Cc·sin θ + Cs·cos θ = 0 → tan θ = Cs / Cc.
    const cp = Math.cos(s.phi || 0),
      sp = Math.sin(s.phi || 0);
    const Ax = cp * s.rx,
      Bx = -sp * s.ry;
    const Ay = sp * s.rx,
      By = cp * s.ry;
    const Cc = ux * Ax + uy * Ay;
    const Cs = ux * Bx + uy * By;
    const evalArcAt = (theta) => {
      const ct = Math.cos(theta),
        st = Math.sin(theta);
      const x = s.cx + Ax * ct + Bx * st;
      const y = s.cy + Ay * ct + By * st;
      const g = ux * x + uy * y;
      if (g < ext.min) ext.min = g;
      if (g > ext.max) ext.max = g;
    };
    evalArcAt(s.theta_start);
    evalArcAt(s.theta_end);
    if (Cc !== 0 || Cs !== 0) {
      const thetaCrit = Math.atan2(Cs, Cc);
      const t0 = s.theta_start,
        t1 = s.theta_end;
      const tLo = Math.min(t0, t1),
        tHi = Math.max(t0, t1);
      const pushIfInSweep = (theta) => {
        let th = theta;
        while (th < tLo) th += 2 * Math.PI;
        while (th > tHi) th -= 2 * Math.PI;
        if (th >= tLo && th <= tHi) evalArcAt(th);
      };
      pushIfInSweep(thetaCrit);
      pushIfInSweep(thetaCrit + Math.PI);
    }
  }
}

// ─── THE COVER FAN ─────────────────────────────────────────────────────────────────────

// CONTAINMENT. A line, quad or cubic lies in the hull of its control points; an elliptical arc piece of
// at most 30 degrees lies in the triangle of its endpoints and the meeting point of its end tangents (an
// ellipse is convex, and affine maps keep tangency). Each curve is split into pieces first, so the control
// points hug it. The hull of all of those contains the shape, and removing an edge (i, i+1) by extending its
// neighbors to their meeting point only ADDS the triangle (v_i, P, v_i+1), so the simplified hull still
// contains it. The float32 vertex buffer can round a vertex
// inward; the hull is pushed out by COVER_FAN_F32_REL of its coordinates first.
//
// DILATION, the vertex shader's own (coverQuadDilate): a cover vertex moves by `normal * d`, where d is
// half a device pixel in em along the normal's direction. A miter normal m = s (n1 + n2) / (1 + n1.n2),
// for the unit outward normals n1, n2 of the two edges meeting there, solves n1.m = n2.m = s, so each
// edge moves outward by s half-pixels; s = sqrt(2) moves it 0.7071 px -- the box filter's reach along
// ANY edge direction (a pixel has coverage iff its 1x1 box meets the shape, and that box reaches
// 0.5 (|cos a| + |sin a|) <= 0.7071 px along a normal at angle a). The dilated hull therefore holds
// every pixel center whose box meets the shape, at any rotation of an isotropic view: it drops only
// fragments whose coverage is exactly 0. (The box quad pushes each edge 0.5 px, exact for an
// axis-aligned edge and short for any other -- which a box far from the ink never showed.)
// Moving every edge out by the same distance keeps a convex polygon convex, so the fan triangles --
// each vertex dilated once, identically in every triangle that uses it -- still partition it: no
// fragment is shaded twice.
// The fan is the cover: timed per kernel on 11 assets it won on every one, fan / box 0.63-0.99
// of the frame, at the same accuracy, so there is no switch. Every fill cover takes it: the importer's two fill-row
// sites and streamGeometry's geometry-only rebuild. A stroke row (padded) and a shape the hull does not beat keep the
// box. importSvg({ coverFan: false }) still builds boxes, as a test hook only (the fan's proofs need the box to compare
// against), like rayLanes: false.
const COVER_FAN_MAX_VERTS = 8;
const COVER_FAN_MAX_RATIO = 0.85;
const COVER_FAN_F32_REL = 2 ** -21;

// The points whose convex hull contains the segment (see CONTAINMENT above). A curve's own control points can sit
// far outside it -- a bulging quad's control point is twice its sagitta out -- so each curve is split first:
// COVER_FAN_PIECES pieces for a quad or cubic (a piece's control points close in on the curve as the square of the
// piece count), and an arc into pieces of at most 30 degrees (the tangents meet 1/cos(15 deg) = 1.035 radii out).
const COVER_FAN_PIECES = 4;
function coverHullPoints(seg, out) {
  if (seg.type === SEG_LINE) {
    out.push(seg.p1, seg.p2);
    return;
  }
  if (seg.type === SEG_QUAD || seg.type === SEG_CUBIC) {
    let rest = seg;
    for (let i = COVER_FAN_PIECES; i > 1; i--) {
      const [a, b] = seg.type === SEG_QUAD ? splitQuadAt(rest, 1 / i) : splitCubicAt(rest, 1 / i);
      out.push(a.p1, a.p2, a.p3);
      if (seg.type === SEG_CUBIC) out.push(a.p4);
      rest = b;
    }
    out.push(rest.p1, rest.p2, rest.p3);
    if (seg.type === SEG_CUBIC) out.push(rest.p4);
    return;
  }
  if (seg.type !== SEG_ARC) return;
  const t0 = seg.theta_start || 0,
    t1 = seg.theta_end || 0,
    phi = seg.phi || 0;
  const cp = Math.cos(phi),
    sp = Math.sin(phi),
    rx = seg.rx,
    ry = seg.ry;
  // the ellipse's point for unit-circle coordinates (u, v)
  const E = (u, v) => [seg.cx + cp * rx * u - sp * ry * v, seg.cy + sp * rx * u + cp * ry * v];
  const sweep = Math.min(Math.abs(t1 - t0), 2 * Math.PI);
  const n = Math.max(1, Math.ceil(sweep / (Math.PI / 6) - 1e-9));
  const dir = t1 >= t0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = t0 + (dir * sweep * i) / n,
      b = i === n - 1 ? t0 + dir * sweep : t0 + (dir * sweep * (i + 1)) / n;
    const m = 0.5 * (a + b),
      h = 0.5 * Math.abs(b - a),
      k = 1 / Math.cos(h); // h <= 15 degrees
    out.push(
      E(Math.cos(a), Math.sin(a)),
      E(k * Math.cos(m), k * Math.sin(m)),
      E(Math.cos(b), Math.sin(b)),
    );
  }
}
// Andrew's monotone chain, counter-clockwise in a y-up frame (the same winding in any frame: only the SIGN
// convention of the outward normal below depends on it, and it is taken from the hull's own area).
function convexHull(pts) {
  const p = pts
    .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [],
    hi = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  lo.pop();
  hi.pop();
  return lo.concat(hi);
}
const polyArea = (h) => {
  let a = 0;
  for (let i = 0; i < h.length; i++) {
    const p = h[i],
      q = h[(i + 1) % h.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return 0.5 * a;
};
// Where the lines (a0 -> a1) and (b0 -> b1) meet, or null when they are parallel.
function lineMeet(a0, a1, b0, b1) {
  const dx = a1[0] - a0[0],
    dy = a1[1] - a0[1],
    ex = b1[0] - b0[0],
    ey = b1[1] - b0[1];
  const den = dx * ey - dy * ex;
  if (!(Math.abs(den) > 0)) return null;
  const t = ((b0[0] - a0[0]) * ey - (b0[1] - a0[1]) * ex) / den;
  return [a0[0] + t * dx, a0[1] + t * dy];
}
// Remove edges from a convex CCW hull until it has at most `maxV` vertices: each step replaces an edge
// (v_i, v_i+1) by the meeting point of its neighbors' extensions, which exists outside it when the two
// neighbors turn by less than 180 degrees together, and adds the least area of any such step.
function simplifyHull(h, maxV) {
  h = h.slice();
  while (h.length > maxV) {
    let best = -1,
      bestP = null,
      bestA = Infinity;
    const n = h.length;
    for (let i = 0; i < n; i++) {
      const a0 = h[(i - 1 + n) % n],
        a1 = h[i],
        b1 = h[(i + 1) % n],
        b0 = h[(i + 2) % n];
      // the neighbors must converge beyond the edge: their directions turn by < 180 degrees in total
      const dA = [a1[0] - a0[0], a1[1] - a0[1]],
        dB = [b0[0] - b1[0], b0[1] - b1[1]];
      if (dA[0] * dB[1] - dA[1] * dB[0] <= 0) continue;
      const P = lineMeet(a0, a1, b0, b1);
      if (!P) continue;
      const add =
        0.5 * Math.abs((b1[0] - a1[0]) * (P[1] - a1[1]) - (b1[1] - a1[1]) * (P[0] - a1[0]));
      if (add < bestA) {
        bestA = add;
        best = i;
        bestP = P;
      }
    }
    if (best < 0) return null;
    h.splice(best, 1, bestP); // v_i -> P
    h.splice((best + 1) % h.length, 1); // drop v_i+1
  }
  return h;
}

/// Do these doubles still hold the shape to better than a float32 step of its own size? A double's step at the coordinates' magnitude, 2^-52 * mag, against 2^-24 * extent (with room for the few operations on them): relative to the shape, so true at any scale.
function holdsShapePrecision(pts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const mag = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1));
  return !(mag > Math.max(x1 - x0, y1 - y0) * 2 ** 24);
}
function coverFanHull(segs, pts = []) {
  for (const seg of segs) if (seg) coverHullPoints(seg, pts);
  let h = convexHull(pts);
  if (h.length < 3) return null;
  if (polyArea(h) < 0) h.reverse(); // counter-clockwise in the coordinate frame
  if (h.length > COVER_FAN_MAX_VERTS) h = simplifyHull(h, COVER_FAN_MAX_VERTS);
  return h && h.length >= 3 ? h : null;
}
/// The cover FAN for a fill shape, or null where the box is as good: the shape's convex hull in at
/// most COVER_FAN_MAX_VERTS vertices, as a triangle list in the cover-quad vertex format, with miter
/// normals that push every edge out by the box filter's full reach. `boxArea` is the area of the box
/// quad the caller would emit; the fan is returned only if it is under COVER_FAN_MAX_RATIO of it.
/// `share` (optional): `{ cache: Map, key, tx, ty }` for a shape that recurs translated, a glyph. The hull is the costly part and every copy has the same one, so it is kept relative
/// to (tx, ty) under `key`, which must name everything but the translation. What follows depends on where this copy lands (the float32 push below) and stays per copy.
/// A copy too far out for its own size does not leave its hull for the others: its coordinates have rounded by more than a float32 step of the shape, and a copy near the origin would inherit that.
export function getCoverFanVerts(segs, boxArea, share = null) {
  let h;
  if (share) {
    let rel = share.cache.get(share.key);
    if (rel === undefined) {
      const pts = [];
      h = coverFanHull(segs, pts);
      if (holdsShapePrecision(pts)) {
        rel = h ? h.map((p) => [p[0] - share.tx, p[1] - share.ty]) : null;
        share.cache.set(share.key, rel);
      }
    } else h = rel ? rel.map((p) => [p[0] + share.tx, p[1] + share.ty]) : null;
  } else h = coverFanHull(segs);
  if (!h) return null;
  const area = polyArea(h);
  if (!(area > 0) || !(area < COVER_FAN_MAX_RATIO * boxArea)) return null;
  // unit outward normals of each edge (v_i -> v_i+1); CCW, so outward is the right-hand normal (dy, -dx)
  const normalsOf = (poly) => {
    const nn = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length],
        dx = q[0] - p[0],
        dy = q[1] - p[1],
        L = Math.hypot(dx, dy);
      if (!(L > 0)) return null;
      nn.push([dy / L, -dx / L]);
    }
    return nn;
  };
  // the miter at vertex i: n1.m = n2.m = 1 for the unit normals of the edges meeting there
  const miterOf = (nn, i) => {
    const a = nn[(i - 1 + nn.length) % nn.length],
      b = nn[i],
      c = 1 + a[0] * b[0] + a[1] * b[1];
    return c > 1e-6 ? [(a[0] + b[0]) / c, (a[1] + b[1]) / c] : null; // null: a reversal, no corner to miter
  };
  let nrm = normalsOf(h);
  if (!nrm) return null;
  // FLOAT32. The vertex buffer rounds every vertex; push the hull out by a few ulps of its coordinates first, so the
  // rounding cannot cut into it, then drop any vertex the rounding left on or inside the chord of its neighbors --
  // nearly collinear triples come back a hair reflex, and a fan over a reflex vertex can fold a sliver over its
  // neighbor. Dropping such a vertex only enlarges the polygon (it lies inside the new edge), so it still contains
  // the shape, and the result is strictly convex in the float32 values the shader reads.
  let mag = 0;
  for (const p of h) mag = Math.max(mag, Math.abs(p[0]), Math.abs(p[1]));
  const eps = COVER_FAN_F32_REL * mag;
  let poly = [];
  for (let i = 0; i < h.length; i++) {
    const m = miterOf(nrm, i);
    if (!m) return null;
    poly.push([Math.fround(h[i][0] + eps * m[0]), Math.fround(h[i][1] + eps * m[1])]);
  }
  for (let changed = true; changed && poly.length >= 3;) {
    changed = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i - 1 + poly.length) % poly.length],
        v = poly[i],
        b = poly[(i + 1) % poly.length];
      if ((v[0] - a[0]) * (b[1] - v[1]) - (v[1] - a[1]) * (b[0] - v[0]) <= 0) {
        poly.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  const n = poly.length;
  // ...and the rounded, pushed polygon must still beat the box: a shape only a few float32 ulps of its own
  // coordinates across (a speck far from the origin) grows by the push, and there the box is as good.
  if (n < 3 || !(polyArea(poly) < COVER_FAN_MAX_RATIO * boxArea)) return null;
  nrm = normalsOf(poly);
  if (!nrm) return null;
  const verts = [],
    normals = [];
  for (let i = 0; i < n; i++) {
    const m = miterOf(nrm, i);
    if (!m) return null;
    verts.push(poly[i]);
    normals.push([Math.SQRT2 * m[0], Math.SQRT2 * m[1]]);
  }
  const out = [];
  for (let i = 1; i + 1 < n; i++) for (const k of [0, i, i + 1]) out.push(verts[k], normals[k]);
  return out;
}

export function getCoverQuadMesh(
  segs,
  gid,
  fillRgba,
  fillRule,
  padEm = 0,
  coverFan = true,
  fanShare = null,
) {
  const out = [];

  // Cover-quad model: emit ONE quad covering the whole shape's extent
  // (across all subpaths). The DirectFill fragment shader runs the
  // per-pixel ray-cast at every covered pixel; coverage is the
  // silhouette mask for the entire shape.

  // padEm: outward dilation of the cover quad in em units (e.g. halfW
  // for stroke shapes so the cover extends past the path-tight bbox to
  // include the full stroke envelope).
  //
  // Emitting one quad per SHAPE rather than per subpath avoids
  // double-painting at overlap regions where subpath bboxes overlap
  // (each would run coverage independently, with `Blend One
  // OneMinusSrcAlpha` then accumulating the same coverage twice for
  // an over-bright result).
  let xL = +Infinity,
    yT = +Infinity,
    xR = -Infinity,
    yB = -Infinity;
  const bb4 = [0, 0, 0, 0]; // reusable per-seg scratch for segBboxInto
  // Closed-form moment accumulator for the analytic PCA-OBB fit.
  // Avoids point-cloud sampling, which biases PCA on shapes
  // mixing primitives of unequal natural-parameter "mass".
  const M = { L: 0, Sx: 0, Sy: 0, Sxx: 0, Sxy: 0, Syy: 0 };
  for (const seg of segs) {
    if (!seg) continue;
    segBboxInto(seg, bb4, 0);
    if (bb4[0] < xL) xL = bb4[0];
    if (bb4[1] < yT) yT = bb4[1];
    if (bb4[2] > xR) xR = bb4[2];
    if (bb4[3] > yB) yB = bb4[3];
    accumMomentsForSeg(seg, M);
  }
  // Expand AABB by `padEm` so stroke chunks cover the full stroke
  // envelope. The OBB extent is expanded post-axis-projection below.
  if (padEm > 0) {
    xL -= padEm;
    yT -= padEm;
    xR += padEm;
    yB += padEm;
  }
  // A cover needs an extent the float32 vertex buffer can hold: over 2^-23 of the coordinates. Relative, not an
  // absolute floor such as 1e-7, which would leave every fill under 1e-7 across -- a unit-sized shape at 2^-24 -- with no quad.
  const _f32Res = 2 ** -23 * Math.max(Math.abs(xL), Math.abs(xR), Math.abs(yT), Math.abs(yB));
  if (xR - xL > _f32Res && yB - yT > _f32Res) {
    const HULL_ZONE = -1.0;
    const kind = 1.0;
    // Per-vertex outward bisector normal for cover-quad dilation
    // (per Lengyel "A Decade of Slug"). The vertex shader's MantleCoverQuadDilate
    // pushes each cover-quad corner outward along this normal by half a
    // viewport pixel before rasterization. Magnitude convention:
    // adjacent edges pushed by 1 unit each move the corner by `bisector`.
    //
    // OBB corners (CCW): bisector = ±uHat ± vHat per quadrant.
    // AABB corners: bisector = (±1, ±1) per quadrant.
    const obb = fitOBBAnalytic(M, segs, padEm);
    let verts, normals;
    if (obb) {
      const [c0, c1, c2, c3] = obb;
      const ux = c1[0] - c0[0],
        uy = c1[1] - c0[1];
      const vx = c3[0] - c0[0],
        vy = c3[1] - c0[1];
      const uLen = Math.sqrt(ux * ux + uy * uy);
      const vLen = Math.sqrt(vx * vx + vy * vy);
      if (uLen > 0 && vLen > 0) {
        const uhx = ux / uLen,
          uhy = uy / uLen;
        const vhx = vx / vLen,
          vhy = vy / vLen;
        const nC0 = [-uhx - vhx, -uhy - vhy];
        const nC1 = [+uhx - vhx, +uhy - vhy];
        const nC2 = [+uhx + vhx, +uhy + vhy];
        const nC3 = [-uhx + vhx, -uhy + vhy];
        verts = [c0, c1, c2, c0, c2, c3];
        normals = [nC0, nC1, nC2, nC0, nC2, nC3];
      } else {
        // Degenerate OBB axes — drop dilation, zero normals.
        verts = [c0, c1, c2, c0, c2, c3];
        normals = [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ];
      }
    } else {
      const tl = [xL, yT],
        tr = [xR, yT],
        br = [xR, yB],
        bl = [xL, yB];
      verts = [tl, tr, br, tl, br, bl];
      // SVG y is down (yT < yB), so "top" corners get sy = -1.
      normals = [
        [-1, -1],
        [+1, -1],
        [+1, +1],
        [-1, -1],
        [+1, +1],
        [-1, +1],
      ];
    }
    // The cover fan: a FILL row takes its shape's convex hull
    // instead of the box where the hull is under COVER_FAN_MAX_RATIO of the box's area. A padded row
    // (a stroke's reach) keeps the box: its hull would need the pad too.
    if (coverFan && !(padEm > 0)) {
      const c0 = verts[0],
        c1 = verts[1],
        c2 = verts[2];
      const boxArea = Math.abs(
        (c1[0] - c0[0]) * (c2[1] - c0[1]) - (c1[1] - c0[1]) * (c2[0] - c0[0]),
      );
      const fan = getCoverFanVerts(segs, boxArea, fanShare);
      if (fan) {
        verts = [];
        normals = [];
        for (let k = 0; k < fan.length; k += 2) {
          verts.push(fan[k]);
          normals.push(fan[k + 1]);
        }
      }
    }
    for (let vi = 0; vi < verts.length; vi++) {
      const v = verts[vi],
        n = normals[vi];
      out.push(
        v[0],
        v[1],

        n[0],
        n[1],
        0,
        0,
        0,
        0,
        0,
        0,
        kind,
        HULL_ZONE,
      );
    }
  }
  return out;
}
