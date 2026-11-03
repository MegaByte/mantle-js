// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Recognize primitive geometry independently of the selected fill engine.

import { SEG_LINE, SEG_CUBIC, SEG_RQUAD } from '../primitives/seg.js';
import { mantleDebugFlag } from '../core/diagnostics.js';

// Recognition switches affect subsequent builds. Disabling primitives lets a
// forced cover route evaluate the original curves instead of an SDF mesh.
let _sdfPrimsOff = false;
/// A FORCED ENGINE PIN (setFillEngine, engineSwitch.js forcedCover) also stops recognition for the builds that follow, so the
/// pinned engine builds the circle's own geometry instead of an sdf mesh that would draw it as sdf@unified. Process-wide like the
/// switch above, and like it only for bundles prepared AFTER the pin; `primitives: 'on'` or route 'auto' lifts it.
let _sdfPrimsPinOff = false;
export const setSdfPrimitivesPinned = (off) => {
  _sdfPrimsPinOff = !!off;
};
export const sdfPrimitivesDisabled = () =>
  _sdfPrimsOff || _sdfPrimsPinOff || mantleDebugFlag('noSdfPrims') === true;
/// `on === false` disables recognition. The `__MANTLE_NO_SDF_PRIMS` global keeps working for the
/// probes that set it directly — behind `__MANTLE_DEBUG__`, like every other debug flag, so a
/// leftover one cannot change shipped pixels — and neither mechanism can turn the other back on.
export function setSdfPrimitivesEnabled(on) {
  _sdfPrimsOff = on === false;
}

function contourExtent(segs) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs)
    for (const P of [s.p1, s.p2, s.p3, s.p4]) {
      if (!P) continue;
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  return x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
}
/// A closing stub this short is an authoring artifact, not an edge; and two arcs agreeing this
/// closely are the same circle. Both as a fraction of the shape, calibrated to be the 1e-4 they
/// were tuned to on a contour ~1 unit across.
const LINE_STUB_REL = 1e-4,
  FIT_REL = 1e-4;

export function circleFromContours(contours) {
  if (sdfPrimitivesDisabled()) return null;
  if (contours.length !== 1) return null;
  const segs = contours[0];
  if (segs.length < 2) return null;
  // Fast path: native circular rquads with an authored .circle tag.
  let c = null,
    total = 0,
    nArc = 0,
    allTagged = true;
  // THE CIRCLE A STUB IS JUDGED AGAINST IS THE CONTOUR'S, even when the stub comes first: `c ? c.r : 1`
  // would make a leading stub absolute (1e-4 units), so at 2^-20 a 22-unit closing line would read as a stub.
  let rStub = 0;
  for (const s of segs)
    if (s.type === SEG_RQUAD && s.circle) {
      rStub = s.circle.r;
      break;
    }
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      // A Z-CLOSE STUB, AGAINST THE CIRCLE IT CLOSES. Recognition picks the ENGINE this shape is
      // drawn by, so an absolute 1e-4 means the same disc goes down the SDF path at one size and
      // the general fill at another -- a visible difference, not a rounding one.
      if (Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) < LINE_STUB_REL * (c ? c.r : rStub))
        continue;
      return null;
    }
    if (s.type !== SEG_RQUAD || !s.circle) {
      allTagged = false;
      break;
    }
    if (!c) c = s.circle;
    else if (
      Math.abs(s.circle.cx - c.cx) > FIT_REL * c.r ||
      Math.abs(s.circle.cy - c.cy) > FIT_REL * c.r ||
      Math.abs(s.circle.r - c.r) > FIT_REL * c.r
    )
      return null;
    let d = Math.atan2(s.p3[1] - c.cy, s.p3[0] - c.cx) - Math.atan2(s.p1[1] - c.cy, s.p1[0] - c.cx);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    nArc++;
  }
  if (allTagged) {
    if (nArc < 2) return null;
    if (Math.abs(Math.abs(total) - 2 * Math.PI) > 1e-2) return null;
    return { cx: c.cx, cy: c.cy, r: c.r };
  }
  // Cubic/quad (kappa) closed disc: fit endpoints + on-curve samples. Same 0.002·r
  // tolerance as extractAnnuli — kappa circles sit at ≤2.7e-4·r; ellipses reject.
  return fitCircularContour(segs);
}

/** On-curve sample of a non-line seg at parameter t ∈ (0,1). */
function segAt(sg, tt) {
  const u = 1 - tt;
  if (sg.type === SEG_LINE) return null;
  if (sg.type === SEG_CUBIC)
    return [
      u * u * u * sg.p1[0] +
        3 * u * u * tt * sg.p2[0] +
        3 * u * tt * tt * sg.p3[0] +
        tt * tt * tt * sg.p4[0],
      u * u * u * sg.p1[1] +
        3 * u * u * tt * sg.p2[1] +
        3 * u * tt * tt * sg.p3[1] +
        tt * tt * tt * sg.p4[1],
    ];
  const w9 = sg.type === SEG_RQUAD ? sg.w : 1;
  const a9 = u * u,
    b9 = 2 * w9 * u * tt,
    c9 = tt * tt,
    den9 = a9 + b9 + c9;
  return [
    (a9 * sg.p1[0] + b9 * sg.p2[0] + c9 * sg.p3[0]) / den9,
    (a9 * sg.p1[1] + b9 * sg.p2[1] + c9 * sg.p3[1]) / den9,
  ];
}

/** Fit a closed curve contour to a circle; null if any real straight edge or
 *  radial residual > 0.002·r (ellipses / coarse quads). */
export function fitCircularContour(segs) {
  if (!segs || segs.length < 2) return null;
  const ext9 = contourExtent(segs);
  for (const s of segs) {
    if (
      s.type === SEG_LINE &&
      Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) > LINE_STUB_REL * ext9
    )
      return null;
  }
  const f = fitCircle(segs.map((s) => s.p1));
  if (!f) return null;
  let dev = f.res;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const grow = (p) => {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  };
  for (const s of segs) {
    grow(s.p1);
    for (const tt of [0.25, 0.5, 0.75]) {
      const m = segAt(s, tt);
      if (!m) continue;
      grow(m);
      dev = Math.max(dev, Math.abs(Math.hypot(m[0] - f.cx, m[1] - f.cy) - f.r));
    }
  }
  //
  // A full circle's bounding box is exactly 2r on both axes, so requiring 1.9r of span rejects a
  // runaway fit without touching a real disc (shape 72: span 16.0 against r 7.99).
  const span = Math.max(x1 - x0, y1 - y0);
  if (!(span >= 1.9 * f.r)) return null;
  if (!enclosesOnce(segs, Math.PI * f.r * f.r)) return null;
  return dev <= 0.002 * f.r ? { cx: f.cx, cy: f.cy, r: f.r } : null;
}

/// Does the closed contour go round its curve exactly once? Every point of it lying on a circle says nothing about that: a semicircle
/// drawn there and back encloses nothing and a circle drawn twice is empty under even-odd, and the primitive paints a whole disc. The
/// signed area of the contour's own samples against the disc's area, with room for the polygon's shortfall on few segments.
function enclosesOnce(segs, area) {
  let a = 0,
    px = 0,
    py = 0,
    fx = 0,
    fy = 0,
    n = 0;
  const add = (p) => {
    if (n++) a += px * p[1] - p[0] * py;
    else {
      fx = p[0];
      fy = p[1];
    }
    px = p[0];
    py = p[1];
  };
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      add(s.p1);
      continue;
    }
    add(s.p1);
    for (const tt of [0.25, 0.5, 0.75]) add(segAt(s, tt));
  }
  a += px * fy - fx * py;
  const enclosed = Math.abs(a) / 2;
  return enclosed > 0.85 * area && enclosed < 1.15 * area;
}

/** Sample on-curve points of a closed curve contour (endpoints + mid-params). */
function contourCurveSamples(segs) {
  const ext9 = contourExtent(segs);
  const pts = [];
  for (const s of segs) {
    // Real straight edges reject (not an ellipse). Degenerate Z-close lines are
    // skipped — including them double-weights the start point and skews the PCA fit.
    if (s.type === SEG_LINE) {
      if (Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) > LINE_STUB_REL * ext9) return null;
      continue;
    }
    pts.push(s.p1);
    for (const tt of [0.25, 0.5, 0.75]) {
      const m = segAt(s, tt);
      if (m) pts.push(m);
    }
  }
  return pts.length >= 5 ? pts : null;
}

/** Fit a closed curve contour to an ellipse; null if straight edges, near-circular
 *  (circleFromContours owns those), or unit-ellipse residual > 0.004.
 *  Returns {cx,cy,rx,ry,phi} for kind-7 elliptical-SDF discs. */
export function fitEllipticalContour(segs) {
  if (!segs || segs.length < 2) return null;
  const pts = contourCurveSamples(segs);
  if (!pts) return null;
  const f = fitEllipse(pts);
  if (!f || f.res > 0.004) return null;
  // Round enough → leave to the circular SDF (0.002·r gate there).
  if (Math.abs(f.rx - f.ry) <= 0.002 * Math.max(f.rx, f.ry)) return null;
  if (!enclosesOnce(segs, Math.PI * f.rx * f.ry)) return null;
  return { cx: f.cx, cy: f.cy, rx: f.rx, ry: f.ry, phi: f.phi };
}

/** Single-contour full ellipse → elliptical-SDF params; null for multi-contour / arcs. */
export function ellipseFromContours(contours) {
  if (sdfPrimitivesDisabled()) return null;
  if (contours.length !== 1) return null;
  return fitEllipticalContour(contours[0]);
}

// 3×3 linear solve (Cramer); null if singular.
export function solve3(A, b) {
  const [a, bb, c] = A[0],
    [d, e, f] = A[1],
    [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  // The callers condition their systems to O(1) before getting here (see fitCircle), so an
  // absolute bar on the determinant is a statement about the MATRIX and not about the drawing.
  if (Math.abs(det) < 1e-12) return null;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}

// Algebraic (Kåsa) circle fit to points → {cx,cy,r,res} (res = max radial residual)
// or null. A cubic-approximated circle's on-curve points lie on the TRUE circle, so
// this recovers it exactly even though the segs are beziers, not SVG arcs.
export function fitCircle(pts) {
  if (pts.length < 3) return null;
  const n = pts.length;
  // CONDITIONED FIRST, then fitted. The normal-equation entries below mix degrees -- Sxx is a
  // squared length, Sx a length, n a count -- so on raw coordinates the matrix spans many decades
  // and the SOLVE, not the geometry, decides whether a disc is recognized. Recognition picks the
  // engine, and the SDF disc and the general fill do not paint the same pixels, so this shape read
  // as a circle at a quarter scale and as a path at full size.
  //
  // Centered on the points' mean and divided by their largest offset: both are exact under a
  // power-of-two rescale of the input, so the conditioned system is IDENTICAL at every size and
  // the fit that comes back is the same circle mapped through.
  let mx = 0,
    my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sc = 0;
  for (const [x, y] of pts) sc = Math.max(sc, Math.abs(x - mx), Math.abs(y - my));
  if (!(sc > 0)) return null;
  let Sx = 0,
    Sy = 0,
    Sxx = 0,
    Syy = 0,
    Sxy = 0,
    Sxz = 0,
    Syz = 0,
    Sz = 0;
  for (const [px, py] of pts) {
    const x = (px - mx) / sc,
      y = (py - my) / sc;
    const z = x * x + y * y;
    Sx += x;
    Sy += y;
    Sxx += x * x;
    Syy += y * y;
    Sxy += x * y;
    Sxz += x * z;
    Syz += y * z;
    Sz += z;
  }
  const sol = solve3(
    [
      [Sxx, Sxy, Sx],
      [Sxy, Syy, Sy],
      [Sx, Sy, n],
    ],
    [-Sxz, -Syz, -Sz],
  );
  if (!sol) return null;
  const ux = -sol[0] / 2,
    uy = -sol[1] / 2,
    r2 = ux * ux + uy * uy - sol[2];
  if (!(r2 > 0)) return null;
  const cx = mx + ux * sc,
    cy = my + uy * sc,
    r = Math.sqrt(r2) * sc;
  let res = 0;
  for (const [x, y] of pts) res = Math.max(res, Math.abs(Math.hypot(x - cx, y - cy) - r));
  return { cx, cy, r, res };
}

// PCA + axis-extent ellipse fit → {cx,cy,rx,ry,phi,res} or null.
// res = max |u²+v²−1| in the unit-ellipse frame (dimensionless). Kappa-cubic
// ellipses sample within ~1e-3; loose polylines reject.
export function fitEllipse(pts) {
  if (pts.length < 5) return null;
  let mx = 0,
    my = 0;
  const n = pts.length;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let xx = 0,
    xy = 0,
    yy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx,
      dy = y - my;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const phi = 0.5 * Math.atan2(2 * xy, xx - yy);
  const c = Math.cos(phi),
    s = Math.sin(phi);
  let rx = 0,
    ry = 0;
  for (const [x, y] of pts) {
    const dx = x - mx,
      dy = y - my;
    const u = dx * c + dy * s,
      v = -dx * s + dy * c;
    if (Math.abs(u) > rx) rx = Math.abs(u);
    if (Math.abs(v) > ry) ry = Math.abs(v);
  }
  if (!(rx > 0) || !(ry > 0)) return null;
  let res = 0;
  for (const [x, y] of pts) {
    const dx = x - mx,
      dy = y - my;
    const u = (dx * c + dy * s) / rx,
      v = (-dx * s + dy * c) / ry;
    res = Math.max(res, Math.abs(u * u + v * v - 1));
  }
  return { cx: mx, cy: my, rx, ry, phi, res };
}
