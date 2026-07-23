// lbContour.js — bundle-curve decode and contour-space analysis: the packed
// curve table → seg contours, exact ray-winding tests (straight + directional),
// arc → rational-quad conversion, circle/annulus fits, per-contour interior
// calibration, and the per-seg tangent/curvature/end metadata the strip and
// cap machinery consume. Owns the quantized vertex-key origin (_kox/_koy):
// every builder that registers points keys against this shared frame.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_RQUAD, mkLine, mkQuad, mkCubic, mkRQuad } from '../primitives/seg.js';
import { buildWindingTree, treeWinding } from './windingTree.js';
export { treeWinding } from './windingTree.js';
import { solveQuadratic, solveCubicInUnit } from '../svg/pathBoolean/polyRoots.js';

// Per-build ORIGIN for the point-identity quantization keys (Math.round(p*64)).
// The keys merge coincident vertices + match triangle edges to contour edges, but
// an ABSOLUTE grid straddles rounding boundaries differently at different offsets,
// so the SAME glyph triangulated at x=0.47 (a 'v' inside "Even?") merged different
// points than at x=0 (a lone 'v') — dropping its crescents and cracking the fill
// into a visible diagonal slash. Keying RELATIVE to the shape's own min makes the
// quantization position-independent (identical to the at-origin build) without
// moving any output vertex. Each top-level builder sets this before it keys.
export let _kox = 0, _koy = 0, _koScale = 64;

export const _EPS = 1e-4;
// Minimum |unit-tangent cross| (≈ sin of the turn) above which a kind-12 band
// trusts the sampled osculating κ when chaining. Shallower joints still chain
// (so full-κ chaining is unnecessary for the wedge) but pack κ≡0 — pure tangent
// combine — because the 10%-sampled κ under-corrects local curvature and used to
// claim glyph-waist interior ('8') at small scales.
export const LB_BAND_SHARP_TURN = 0.30;

// TRAVEL-FRAME verification of a contour's interiorSign: the edgeEndMeta consumers
// (kind-10 cap-strips, kind-12 bands) need "+1 ⇔ fill on the left-perp of the travel
// direction" EXACTLY — their outward normals and convex/reflex corner types are derived
// from it. calibrateInterior's sliver probe answers the ctrl-side question, whose
// relation to the travel frame depends on which seg it lands on; the CDT builder has
// long verified it against the longest LINE seg ("a wrong sign put every kind-10 strip
// on the INK side" — the G-crossbar class), but a LINE-LESS contour (glyph bowls: the
// '8') was never verified and its bands inherited inverted normals/corner types (waist
// pixels claimed at ~0.05 coverage over interior truth 0.94). This probe generalizes the
// verification to any seg type: sample a point on the longest segs, take the SECANT
// tangent there, and ask inFill on both perp sides; a determinate answer pins the sign.
export function verifyInteriorSign(segs, inFill, interiorSign) {
  const cand = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], e = s.p4 || s.p3 || s.p2;
    cand.push([i, Math.hypot(e[0] - s.p1[0], e[1] - s.p1[1])]);
  }
  cand.sort((A, B) => B[1] - A[1]);
  for (const [i, L] of cand.slice(0, 4)) {
    if (L < 1e-9) continue;
    const s = segs[i];
    for (const t of [0.5, 0.25, 0.75]) {
      const p0 = segPt(s, t - 0.01), p1 = segPt(s, t + 0.01);
      let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-12) continue;
      dx /= dl; dy /= dl;
      const p = segPt(s, t);
      for (const rel of [0.02, 0.006]) {
        const off = L * rel;
        // claimed fill side = left-perp (−dy,dx) times the sign under test
        const nx = -dy * (interiorSign > 0 ? 1 : -1), ny = dx * (interiorSign > 0 ? 1 : -1);
        const inIn = inFill([p[0] + nx * off, p[1] + ny * off]);
        const inOut = inFill([p[0] - nx * off, p[1] - ny * off]);
        if (inIn !== inOut) return inIn ? interiorSign : -interiorSign;
      }
    }
  }
  return interiorSign;
}

export function _setKeyOrigin(contours) {
  let ox = Infinity, oy = Infinity, ox1 = -Infinity, oy1 = -Infinity;
  for (const c of contours) for (const s of c) if (s && s.p1) { if (s.p1[0] < ox) ox = s.p1[0]; if (s.p1[0] > ox1) ox1 = s.p1[0]; if (s.p1[1] < oy) oy = s.p1[1]; if (s.p1[1] > oy1) oy1 = s.p1[1]; }
  _kox = isFinite(ox) ? ox : 0; _koy = isFinite(oy) ? oy : 0;
  // Scale-AWARE quantization: a fixed ×64 gave text-normalized (0..1) contours just 64
  // buckets across the glyph — distinct apex vertices within ~1.5px merged into
  // degenerate geometry (the A/w coverage cracks). ~64k buckets across the shape keeps
  // dedup semantics for genuinely-coincident points at any coordinate scale.
  const diag = Math.hypot((isFinite(ox1) ? ox1 : 1) - _kox, (isFinite(oy1) ? oy1 : 1) - _koy);
  _koScale = diag > 1e-9 ? 65536 / diag : 64;
}

// NONZERO-winding sibling: identical crossing acceptance, but each hit adds the
// crossing DIRECTION — the sign of dP/dt of the (already solved) vertical-distance
// polynomial at t (denominators are positive on t∈[0,1], so this is sign(dy/dt)).
// TrueType fills by winding; the even-odd parity test reads a SELF-OVERLAPPING
// outline's overlap as a hole (spiral terminals: e/6/8/9), vetoing every interior
// classification exactly where Slug renders solid.
// Signed +x-ray crossings of ONE segment at (x, y) — rayWinding's per-segment body,
// factored so the winding tree (windingTree.js) can evaluate near leaves with the exact
// same solvers the linear walk uses.
// dir === 0 = the ray grazes a y-extremum (apex): the curve TOUCHES, it does
// not cross — counting it ±1 was the quad-walker miscount (the near-unfilled
// class had the same root on the coverage walker; cubics got the apex fix
// there, the builder's winding never did).
export function raySegCross(s, x, y) {
  let wsum = 0;
  const hit = (tx, t, dir) => { if (t >= 0 && t < 1 && tx > x && dir !== 0) wsum += dir > 0 ? 1 : -1; };
  if (s.type === SEG_LINE) { const y1 = s.p1[1], dy = s.p2[1] - y1; if (Math.abs(dy) < 1e-15) return 0;
    const t = (y - y1) / dy; hit(s.p1[0] + t * (s.p2[0] - s.p1[0]), t, dy); return wsum; }
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
    const w = s.type === SEG_RQUAD ? s.w : 1, d1 = s.p1[1] - y, d2 = s.p2[1] - y, d3 = s.p3[1] - y;
    const A2 = d1 - 2 * w * d2 + d3, B2 = 2 * (w * d2 - d1);
    for (const t of solveQuadratic(A2, B2, d1)) {
      const u = 1 - t, a = u * u, b = 2 * w * u * t, c = t * t, den = a + b + c;
      if (Math.abs(den) > 1e-15) hit((a * s.p1[0] + b * s.p2[0] + c * s.p3[0]) / den, t, 2 * A2 * t + B2); }
    return wsum;
  }
  const y1 = s.p1[1], y2 = s.p2[1], y3 = s.p3[1], y4 = s.p4[1];
  const a3 = -y1 + 3 * y2 - 3 * y3 + y4, b3 = 3 * (y1 - 2 * y2 + y3), c3 = 3 * (y2 - y1);
  for (const t of solveCubicInUnit(a3, b3, c3, y1 - y)) {
    const u = 1 - t;
    hit(u * u * u * s.p1[0] + 3 * u * u * t * s.p2[0] + 3 * u * t * t * s.p3[0] + t * t * t * s.p4[0], t,
        3 * a3 * t * t + 2 * b3 * t + c3); }
  return wsum;
}

export function rayWinding(segs, x, y) {
  let wsum = 0;
  for (const s of segs) wsum += raySegCross(s, x, y);
  return wsum;
}

// Build a winding tree over renderer segs (see windingTree.js): the CDT builder's inkAt
// probes call rayWinding once per curved segment (side bits) plus calibration/verify —
// O(N^2) per build on curved shapes without it. Returns null below the cutoff where the
// linear walk wins.
export function buildSegWindingTree(segs) {
  if (!segs || segs.length < 48) return null;
  const endP = (s) => s.type === SEG_LINE ? s.p2 : s.type === SEG_CUBIC ? s.p4 : s.p3;
  return buildWindingTree(segs.length, {
    start: (i) => segs[i].p1,
    end: (i) => endP(segs[i]),
    bbox: (i) => {
      const s = segs[i];
      let x0 = s.p1[0], y0 = s.p1[1], x1 = x0, y1 = y0;
      for (const p of [s.p2, s.p3, s.p4]) {
        if (!p) break;
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
      return [x0, y0, x1, y1];
    },
    cross: (i, x, yr) => raySegCross(segs[i], x, yr),
  });
}

// rayWinding along an ARBITRARY direction d (unit): project control points
// onto (d, perp(d)) about the query point and reuse the same monotone-root
// logic. Razor ink slivers (the '8' waist: two near-tangent arcs of one
// contour) tie along any single ray; probing 2-3 directions and voting is
// robust where nudging the query point is not (the sliver is thinner than
// any safe nudge).
export function rayWindingDir(segs, x, y, dx, dy) {
  let wsum = 0;
  const px9 = (X9, Y9) => dx * (X9 - x) + dy * (Y9 - y);
  const py9 = (X9, Y9) => -dy * (X9 - x) + dx * (Y9 - y);
  const hit = (tx, t, dir) => { if (t >= 0 && t < 1 && tx > 0 && dir !== 0) wsum += dir > 0 ? 1 : -1; };
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      const y1 = py9(s.p1[0], s.p1[1]), y2 = py9(s.p2[0], s.p2[1]), dyq = y2 - y1;
      if (Math.abs(dyq) < 1e-15) continue;
      const t = -y1 / dyq;
      hit(px9(s.p1[0], s.p1[1]) + t * (px9(s.p2[0], s.p2[1]) - px9(s.p1[0], s.p1[1])), t, dyq);
      continue;
    }
    if (s.type === SEG_QUAD || s.type === SEG_RQUAD) {
      const w = s.type === SEG_RQUAD ? s.w : 1;
      const d1 = py9(s.p1[0], s.p1[1]), d2 = py9(s.p2[0], s.p2[1]), d3 = py9(s.p3[0], s.p3[1]);
      const A2 = d1 - 2 * w * d2 + d3, B2 = 2 * (w * d2 - d1);
      const x1 = px9(s.p1[0], s.p1[1]), x2 = px9(s.p2[0], s.p2[1]), x3 = px9(s.p3[0], s.p3[1]);
      for (const t of solveQuadratic(A2, B2, d1)) {
        const u = 1 - t, a = u * u, b = 2 * w * u * t, c = t * t, den = a + b + c;
        if (Math.abs(den) > 1e-15) hit((a * x1 + b * x2 + c * x3) / den, t, 2 * A2 * t + B2);
      }
      continue;
    }
    const y1 = py9(s.p1[0], s.p1[1]), y2 = py9(s.p2[0], s.p2[1]), y3 = py9(s.p3[0], s.p3[1]), y4 = py9(s.p4[0], s.p4[1]);
    const a3 = -y1 + 3 * y2 - 3 * y3 + y4, b3 = 3 * (y1 - 2 * y2 + y3), c3 = 3 * (y2 - y1);
    const x1 = px9(s.p1[0], s.p1[1]), x2 = px9(s.p2[0], s.p2[1]), x3 = px9(s.p3[0], s.p3[1]), x4 = px9(s.p4[0], s.p4[1]);
    for (const t of solveCubicInUnit(a3, b3, c3, y1)) {
      const u = 1 - t;
      hit(u * u * u * x1 + 3 * u * u * t * x2 + 3 * u * t * t * x3 + t * t * t * x4, t,
          3 * a3 * t * t + 2 * b3 * t + c3);
    }
  }
  return wsum;
}

// Convert an elliptical arc (center cx,cy; radii rx,ry; x-rotation φ; sweep
// θ0→θ1) to EXACT rational-quadratic Bézier pieces, ≤90° per piece. An ellipse
// arc is the affine image of a circular arc, and a ≤180° circular arc is exactly
// a rational quadratic with middle weight w = cos(Δ/2) and control point at the
// tangent intersection — so LB renders arcs with the SAME zero error Slug does
// (Loop-Blinn §3.2), no cubic approximation. The affine map A takes the unit
// circle to the ellipse; it preserves the rational structure, so we build each
// piece on the unit circle and push its 3 control points through A (weight is
// affine-invariant).
export function arcToRationalQuads(cx, cy, rx, ry, th0, th1, phi) {
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const A = (u, vv) => { const x = rx * u, y = ry * vv; return [cx + x * cosP - y * sinP, cy + x * sinP + y * cosP]; };
  const total = th1 - th0;
  const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const dth = total / n, w = Math.cos(Math.abs(dth) / 2);
  // CIRCULAR arc (equal radii, no rotation) → carry {cx,cy,r} so the builder can
  // render an exact seam-free circular-SDF sector instead of per-piece crescents.
  const circle = Math.abs(rx - ry) < 1e-6 * (Math.abs(rx) + Math.abs(ry) + 1) ? { cx, cy, r: rx } : null;
  const segs = [];
  let a0 = th0;
  for (let i = 0; i < n; i++) {
    const a1 = a0 + dth, am = (a0 + a1) / 2;
    const P0 = A(Math.cos(a0), Math.sin(a0)), P2 = A(Math.cos(a1), Math.sin(a1));
    const P1 = A(Math.cos(am) / w, Math.sin(am) / w);   // tangent intersection on the ellipse
    segs.push(mkRQuad(P0, P1, P2, w, circle));
    a0 = a1;
  }
  return segs;
}

// A single contour that is a FULL circle → centre/radius for ONE circular-SDF
// quad (kind 7): no chord polygon, no crescents, no ≤90°-split seams.
// Accepts (a) tagged SVG arcs (rquad.circle) summing to 2π, or (b) cubic/quad
// kappa approximations that fit a circle within 0.002·r (same gate as extractAnnuli).
// Returns null for partial arcs, ellipses, mixed segs, multi-contour.
export function circleFromContours(contours) {
  if (contours.length !== 1) return null;
  const segs = contours[0];
  if (segs.length < 2) return null;
  // Fast path: native circular rquads with an authored .circle tag.
  let c = null, total = 0, nArc = 0, allTagged = true;
  for (const s of segs) {
    if (s.type === SEG_LINE) {
      if (Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) < 1e-4) continue;
      return null;
    }
    if (s.type !== SEG_RQUAD || !s.circle) { allTagged = false; break; }
    if (!c) c = s.circle;
    else if (Math.abs(s.circle.cx - c.cx) > 1e-4 || Math.abs(s.circle.cy - c.cy) > 1e-4 || Math.abs(s.circle.r - c.r) > 1e-4) return null;
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
  if (sg.type === SEG_CUBIC) return [
    u * u * u * sg.p1[0] + 3 * u * u * tt * sg.p2[0] + 3 * u * tt * tt * sg.p3[0] + tt * tt * tt * sg.p4[0],
    u * u * u * sg.p1[1] + 3 * u * u * tt * sg.p2[1] + 3 * u * tt * tt * sg.p3[1] + tt * tt * tt * sg.p4[1]];
  const w9 = sg.type === SEG_RQUAD ? sg.w : 1;
  const a9 = u * u, b9 = 2 * w9 * u * tt, c9 = tt * tt, den9 = a9 + b9 + c9;
  return [(a9 * sg.p1[0] + b9 * sg.p2[0] + c9 * sg.p3[0]) / den9,
          (a9 * sg.p1[1] + b9 * sg.p2[1] + c9 * sg.p3[1]) / den9];
}

/** Fit a closed curve contour to a circle; null if any real straight edge or
 *  radial residual > 0.002·r (ellipses / coarse quads). */
export function fitCircularContour(segs) {
  if (!segs || segs.length < 2) return null;
  for (const s of segs) {
    if (s.type === SEG_LINE && Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) > 1e-4) return null;
  }
  const f = fitCircle(segs.map(s => s.p1));
  if (!f) return null;
  let dev = f.res;
  for (const s of segs) for (const tt of [0.25, 0.5, 0.75]) {
    const m = segAt(s, tt);
    if (m) dev = Math.max(dev, Math.abs(Math.hypot(m[0] - f.cx, m[1] - f.cy) - f.r));
  }
  return dev <= 0.002 * f.r ? { cx: f.cx, cy: f.cy, r: f.r } : null;
}

/** Sample on-curve points of a closed curve contour (endpoints + mid-params). */
function contourCurveSamples(segs) {
  const pts = [];
  for (const s of segs) {
    // Real straight edges reject (not an ellipse). Degenerate Z-close lines are
    // skipped — including them double-weights the start point and skews the PCA fit.
    if (s.type === SEG_LINE) {
      if (Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) > 1e-4) return null;
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
  return { cx: f.cx, cy: f.cy, rx: f.rx, ry: f.ry, phi: f.phi };
}

/** Single-contour full ellipse → elliptical-SDF params; null for multi-contour / arcs. */
export function ellipseFromContours(contours) {
  if (contours.length !== 1) return null;
  return fitEllipticalContour(contours[0]);
}

// 3×3 linear solve (Cramer); null if singular.
export function solve3(A, b) {
  const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
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
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0; const n = pts.length;
  for (const [x, y] of pts) { const z = x * x + y * y; Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxz += x * z; Syz += y * z; Sz += z; }
  const sol = solve3([[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], [-Sxz, -Syz, -Sz]);
  if (!sol) return null;
  const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
  if (r2 <= 1e-9) return null;
  const r = Math.sqrt(r2);
  let res = 0;
  for (const [x, y] of pts) res = Math.max(res, Math.abs(Math.hypot(x - cx, y - cy) - r));
  return { cx, cy, r, res };
}

// PCA + axis-extent ellipse fit → {cx,cy,rx,ry,phi,res} or null.
// res = max |u²+v²−1| in the unit-ellipse frame (dimensionless). Kappa-cubic
// ellipses sample within ~1e-3; loose polylines reject.
export function fitEllipse(pts) {
  if (pts.length < 5) return null;
  let mx = 0, my = 0; const n = pts.length;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= n; my /= n;
  let xx = 0, xy = 0, yy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  const phi = 0.5 * Math.atan2(2 * xy, xx - yy);
  const c = Math.cos(phi), s = Math.sin(phi);
  let rx = 0, ry = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    const u = dx * c + dy * s, v = -dx * s + dy * c;
    if (Math.abs(u) > rx) rx = Math.abs(u);
    if (Math.abs(v) > ry) ry = Math.abs(v);
  }
  if (rx < 1e-9 || ry < 1e-9) return null;
  let res = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    res = Math.max(res, Math.abs(u * u + v * v - 1));
  }
  return { cx: mx, cy: my, rx, ry, phi, res };
}

export function extractAnnuli(contours, fillRule) {
  const fits = contours.map(segs => fitCircularContour(segs));
  // signed area per contour: an annulus is a RING (the inner = a hole). Under
  // NONZERO a same-wound nested circle pair is a SOLID DISC (the inner contour
  // is an invisible boundary) — pairing it as an annulus carved a phantom hole.
  // Evenodd keeps pairing regardless (nesting alone makes the hole there).
  const areas = contours.map(segs => {
    let a2 = 0;
    for (const sg of segs) {
      const q = sg.type === SEG_LINE ? sg.p2 : (sg.type === SEG_CUBIC ? sg.p4 : sg.p3);
      a2 += sg.p1[0] * q[1] - q[0] * sg.p1[1];
    }
    return a2;
  });
  const used = new Set(), annuli = [];
  for (let i = 0; i < fits.length; i++) {
    if (!fits[i] || used.has(i)) continue;
    for (let j = i + 1; j < fits.length; j++) {
      if (!fits[j] || used.has(j)) continue;
      if (fillRule !== 'evenodd' && areas[i] * areas[j] > 0) continue;   // same-wound → no hole under nonzero
      // RELATIVE tolerance only: an absolute em term paired DISJOINT
      // small circles (glyph contours live in 0..1 em — two dots < 0.5em
      // apart became a phantom ring).
      const tol = 0.03 * fits[i].r;
      if (Math.abs(fits[i].cx - fits[j].cx) < tol && Math.abs(fits[i].cy - fits[j].cy) < tol) {
        const rO = Math.max(fits[i].r, fits[j].r), rI = Math.min(fits[i].r, fits[j].r);
        annuli.push({ cx: fits[i].cx, cy: fits[i].cy, rMid: (rO + rI) / 2, halfW: (rO - rI) / 2 });
        used.add(i); used.add(j); break;
      }
    }
  }
  return annuli.length ? { annuli, rest: contours.filter((_, k) => !used.has(k)) } : { annuli: [], rest: contours };
}

// Emit a circular arc's crescent as a kind-7 SECTOR fan: triangles from the centre
// out past the radius, angularly limited to [p1,p3]. The circular SDF clips the
// outer edge to the exact arc; the angular limit stops it filling the rest of the
// disc; and adjacent co-circular sectors SHARE the radial edge to their common
// endpoint, so they tile with NO geometric gap AND one identical field — the seam
// undercount the control-triangle crescents left. Pushed as kind-7 quad entries.
export function emitCircleSector(quads, circle, p1, p3, sign) {
  const { cx, cy, r } = circle;
  const th1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  let sweep = Math.atan2(p3[1] - cy, p3[0] - cx) - th1;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const K = 2, m = 0.2 * r + 2;
  const Rout = (r + m) / Math.cos(Math.abs(sweep) / (2 * K) || 1e-3);   // outer polygon encloses r+m
  const P = i => { const t = th1 + sweep * (i / K); return [cx + Rout * Math.cos(t), cy + Rout * Math.sin(t)]; };
  for (let i = 0; i < K; i++) {
    const a = P(i), b = P(i + 1);
    quads.push({ tri: new Float32Array([cx, cy, a[0], a[1], b[0], b[1]]), sign, circle });
  }
}

// Decode one shape's slice of a bundle curve buffer (the same RGBA32F layout
// curveRangeToPathD walks) into em-space contours — [outer, ...holes], each a
// Seg array — so the renderer can build an LB mesh from an already-uploaded
// bundle without re-importing. Arcs become EXACT rational-quadratic segs (no
// cubic approximation); returns null only on a degenerate/empty range.
export function curveRangeToContours(curveF32, beginFloat, endFloat) {
  const end = Math.min(endFloat | 0, curveF32.length);
  let hdr = Math.max(0, beginFloat | 0);
  const contours = []; let cur = null;
  let penX = NaN, penY = NaN;
  while (hdr + 4 <= end) {
    const segType = (curveF32[hdr] | 0) & 3;
    const d = hdr + 4;
    let sx, sy, ex, ey, seg;
    if (segType === SEG_LINE) {
      sx = curveF32[d]; sy = curveF32[d + 1]; ex = curveF32[d + 2]; ey = curveF32[d + 3];
      seg = mkLine([sx, sy], [ex, ey]); hdr = d + 8;
    } else if (segType === SEG_QUAD) {
      sx = curveF32[d]; sy = curveF32[d + 1];
      const cx = curveF32[d + 2], cy = curveF32[d + 3]; ex = curveF32[d + 4]; ey = curveF32[d + 5];
      seg = mkQuad([sx, sy], [cx, cy], [ex, ey]); hdr = d + 12;
    } else if (segType === SEG_CUBIC) {
      sx = curveF32[d]; sy = curveF32[d + 1];
      const c2x = curveF32[d + 2], c2y = curveF32[d + 3], c3x = curveF32[d + 4], c3y = curveF32[d + 5];
      ex = curveF32[d + 6]; ey = curveF32[d + 7];
      seg = mkCubic([sx, sy], [c2x, c2y], [c3x, c3y], [ex, ey]); hdr = d + 12;
    } else { // SEG_ARC: (cx,cy,rx,ry) + (theta0,theta1,phi,_) → rational quads
      const cx = curveF32[d], cy = curveF32[d + 1], rx = curveF32[d + 2], ry = curveF32[d + 3];
      const th0 = curveF32[d + 4], th1 = curveF32[d + 5], phi = curveF32[d + 6];
      const rqs = arcToRationalQuads(cx, cy, rx, ry, th0, th1, phi);
      hdr = d + 12;
      if (!rqs.length) continue;
      sx = rqs[0].p1[0]; sy = rqs[0].p1[1];
      const last = rqs[rqs.length - 1];
      ex = last.p3[0]; ey = last.p3[1];
      if (isNaN(penX) || Math.abs(sx - penX) > _EPS || Math.abs(sy - penY) > _EPS) {
        cur = []; contours.push(cur);
      }
      for (const rq of rqs) cur.push(rq);
      penX = ex; penY = ey;
      continue;
    }
    if (isNaN(penX) || Math.abs(sx - penX) > _EPS || Math.abs(sy - penY) > _EPS) {
      cur = []; contours.push(cur);     // new subpath
    }
    cur.push(seg); penX = ex; penY = ey;
  }
  // Drop ZERO-EXTENT contours (every point coincident). A shape's curve range
  // ends at the buffer's total float count, which includes trailing zero
  // PADDING; that padding reads back as degenerate SEG_LINE [0,0]→[0,0]
  // segments and groups into a spurious empty contour. Left in, it inflates
  // contours.length — defeating the single-contour LB fast path (the only route
  // that degree-reduces a corner cubic) so the shape is forced onto the CDT
  // partition, where a degree-reducible cubic renders as a kind-4 Bezout
  // crescent and UNDER-fills (a corner-control squircle drew only its interior
  // diamond, ink 0.595 vs Slug). A zero-extent contour carries no area, so
  // dropping it changes no fill; real geometry always has extent.
  const real = contours.filter((c) => {
    let xlo = Infinity, ylo = Infinity, xhi = -Infinity, yhi = -Infinity;
    for (const s of c) for (const p of [s.p1, s.p2, s.p3, s.p4]) {
      if (!p) continue;
      if (p[0] < xlo) xlo = p[0]; if (p[0] > xhi) xhi = p[0];
      if (p[1] < ylo) ylo = p[1]; if (p[1] > yhi) yhi = p[1];
    }
    return xhi - xlo > 1e-9 || yhi - ylo > 1e-9;
  });
  return real.length ? real : null;
}

export function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ---- segment normalization -------------------------------------------------
// Accepts importer segs ({type, p1..p4}); a curve primitive list per contour.
export function segCtrlMid(s) {
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) return s.p2;
  if (s.type === SEG_CUBIC) return [(s.p2[0] + s.p3[0]) / 2, (s.p2[1] + s.p3[1]) / 2];
  return null;
}

// Which side of the CHORD polygon is the fill on — ONE probe per contour.
// inFill tests the on-curve (chord) polygon, so we must probe next to a CHORD
// (p_start→p_end), not the bulging curve, and use the chord direction — the
// same reference the per-segment cross test uses. Returns +1 if the chord's
// left-perp (-dy,dx) side is filled, −1 if right, 0 if no usable segment.
export function chordEnds(s) {
  if (s.type === SEG_LINE) return s.p2;
  if (s.type === SEG_QUAD || s.type === SEG_RQUAD) return s.p3;
  return s.p4;
}

// On-curve midpoint (t=½) of a segment; null for a line (adds nothing between
// its endpoints). Used to de-degenerate a chord ring — a contour of arcs sharing
// endpoints (a vesica: two arcs, same two vertices) collapses to a zero-area
// line, which breaks the pointInPoly fill test that drives sign calibration.
export function segMidpoint(s) {
  if (s.type === SEG_LINE) return null;
  if (s.type === SEG_QUAD) return [(s.p1[0] + 2 * s.p2[0] + s.p3[0]) / 4, (s.p1[1] + 2 * s.p2[1] + s.p3[1]) / 4];
  if (s.type === SEG_RQUAD) { const w = s.w, dn = 2 + 2 * w; return [(s.p1[0] + 2 * w * s.p2[0] + s.p3[0]) / dn, (s.p1[1] + 2 * w * s.p2[1] + s.p3[1]) / dn]; }
  return [(s.p1[0] + 3 * s.p2[0] + 3 * s.p3[0] + s.p4[0]) / 8, (s.p1[1] + 3 * s.p2[1] + 3 * s.p3[1] + s.p4[1]) / 8];
}

export function ringSignedArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a) / 2; }

// Chord ring for the even-odd fill test. Endpoints only, UNLESS that collapses
// to (near-)zero area — then re-derive with on-curve midpoints so the polygon has
// real area. Only degenerate contours change; every non-degenerate ring stays
// byte-identical (the fill calibration is tuned to the chord, so don't disturb it).
export function chordRing(segs) {
  const ring = [];
  for (const s of segs) ring.push(s.p1);
  let xlo = Infinity, ylo = Infinity, xhi = -Infinity, yhi = -Infinity;
  for (const p of ring) { if (p[0] < xlo) xlo = p[0]; if (p[0] > xhi) xhi = p[0]; if (p[1] < ylo) ylo = p[1]; if (p[1] > yhi) yhi = p[1]; }
  // Degenerate iff area ≪ the shape's true extent — measured against the bbox
  // DIAGONAL², not bbox area (a near-zero-width sliver collapses bbox area to ~0,
  // so its tiny nonzero area would spuriously pass). A vesica's endpoint ring is a
  // hairline: area/diag² ~ 1e-8, far below the 1e-4 cutoff; a genuinely thin filled
  // shape sits ~1e-2 and stays as-is.
  const diag2 = Math.max((xhi - xlo) * (xhi - xlo) + (yhi - ylo) * (yhi - ylo), 1e-12);
  if (ringSignedArea(ring) >= 1e-4 * diag2) return ring;
  const dense = [];
  for (const s of segs) { dense.push(s.p1); const m = segMidpoint(s); if (m) dense.push(m); }
  return dense;
}

export function calibrateInterior(segs, inFill) {
  // interiorSign semantics (unchanged): +1 ⇔ a control point on the LEFT of its
  // chord (positive cross) sits on the FILL side. The original probe sampled
  // 0.01·L beside the CHORD — for fat arcs the chord sags far from the outline
  // and both sides of it can read HOLE (droplet-class same-wound evenodd inner
  // contours), silently returning -1 and inverting every inner-boundary
  // crescent (solid paint over the hole: the Raindrops "flat edges" class).
  // The unambiguous probe: the midpoint BETWEEN the chord midpoint and the
  // curve midpoint always lies inside the crescent sliver, so inFill(there)
  // answers "is the control-point side of the chord filled" directly — the
  // exact question consumers (sideInFill on ctrl points) ask.
  for (const s of segs) {
    const a = s.p1, b = chordEnds(s);
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const cmx = (a[0] + b[0]) / 2, cmy = (a[1] + b[1]) / 2;
    let qx = null, qy = null, ctl = null;
    if (s.type === SEG_QUAD) {
      qx = 0.25 * a[0] + 0.5 * s.p2[0] + 0.25 * b[0];
      qy = 0.25 * a[1] + 0.5 * s.p2[1] + 0.25 * b[1];
      ctl = s.p2;
    } else if (s.type === SEG_RQUAD) {
      const w = s.w || 1, d = 2 + 2 * w;
      qx = (a[0] + 2 * w * s.p2[0] + b[0]) / d;
      qy = (a[1] + 2 * w * s.p2[1] + b[1]) / d;
      ctl = s.p2;
    } else if (s.type === SEG_CUBIC) {
      qx = 0.125 * a[0] + 0.375 * s.p2[0] + 0.375 * s.p3[0] + 0.125 * b[0];
      qy = 0.125 * a[1] + 0.375 * s.p2[1] + 0.375 * s.p3[1] + 0.125 * b[1];
      ctl = [(s.p2[0] + s.p3[0]) / 2, (s.p2[1] + s.p3[1]) / 2];
    }
    if (ctl) {
      const cross = (b[0] - a[0]) * (ctl[1] - a[1]) - (b[1] - a[1]) * (ctl[0] - a[0]);
      if (Math.abs(cross) < 1e-3 * L * L) continue;   // razor-ish: probe would sit on the ring edge
      const crossSign = cross > 0 ? 1 : -1;
      // 25% of the way from chord-mid to curve-mid: inside the sliver AND on the
      // chord side of the t=1/2 CHORD-RING polyline (inFill tests chord rings,
      // not true curves — a half-way probe straddles the ring edge for fat arcs).
      const filled = inFill([cmx + (qx - cmx) * 0.25, cmy + (qy - cmy) * 0.25]);
      return filled ? crossSign : -crossSign;
    }
    // straight seg: the chord IS the boundary — the original two-sided probe works
    const px = -dy / L, py = dx / L, off = 0.01 * L;
    const plus = inFill([cmx + px * off, cmy + py * off]);
    const minus = inFill([cmx - px * off, cmy - py * off]);
    if (plus === minus) continue;
    return plus ? 1 : -1;
  }
  return 0;
}

// Local "is the control point on the fill side of its chord" — replaces a
// global inFill(ctrl) with an O(1) cross-product side test using the
// per-contour interiorSign. chord a→b, control c.
export function sideInFill(a, b, c, interiorSign) {
  const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return (cr > 0 ? 1 : cr < 0 ? -1 : 0) === interiorSign;
}

// Endpoint tangents for a segment (used by edgeEndMeta / band tip packing).
export function segTangents(s) {
  // outward-agnostic tangents at the segment's start and end on-curve points
  if (s.type === SEG_LINE) { const d = [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]]; return { t0: d, t1: d, end: s.p2, curve: false }; }
  if (s.type === SEG_CUBIC) {
    let t0 = [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]];
    if (Math.hypot(t0[0], t0[1]) < 1e-9) t0 = [s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]];
    let t1 = [s.p4[0] - s.p3[0], s.p4[1] - s.p3[1]];
    if (Math.hypot(t1[0], t1[1]) < 1e-9) t1 = [s.p4[0] - s.p2[0], s.p4[1] - s.p2[1]];
    return { t0, t1, end: s.p4, curve: true };
  }
  // quad / rquad
  let t0 = [s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]];
  if (Math.hypot(t0[0], t0[1]) < 1e-9) t0 = [s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]];
  let t1 = [s.p3[0] - s.p2[0], s.p3[1] - s.p2[1]];
  if (Math.hypot(t1[0], t1[1]) < 1e-9) t1 = [s.p3[0] - s.p1[0], s.p3[1] - s.p1[1]];
  return { t0, t1, end: s.p3, curve: true };
}

// Signed curvature of a Bézier at an endpoint (which=0 start, 1 end): κ = (B′×B″)/|B′|³.
export function segCurvature(s, which) {
  let d1, d2;   // B′, B″ (constant for quad; linear-in-t for cubic → eval at endpoint)
  if (s.type === SEG_LINE) return 0;
  if (s.type === SEG_CUBIC) {
    const P0 = s.p1, P1 = s.p2, P2 = s.p3, P3 = s.p4;
    if (which === 0) { d1 = [3 * (P1[0] - P0[0]), 3 * (P1[1] - P0[1])]; d2 = [6 * (P2[0] - 2 * P1[0] + P0[0]), 6 * (P2[1] - 2 * P1[1] + P0[1])]; }
    else { d1 = [3 * (P3[0] - P2[0]), 3 * (P3[1] - P2[1])]; d2 = [6 * (P3[0] - 2 * P2[0] + P1[0]), 6 * (P3[1] - 2 * P2[1] + P1[1])]; }
  } else { // quad / rquad — treat as the integral quad (rquad κ differs slightly; fine for the ~1px cap)
    const P0 = s.p1, P1 = s.p2, P2 = s.p3;
    d1 = which === 0 ? [2 * (P1[0] - P0[0]), 2 * (P1[1] - P0[1])] : [2 * (P2[0] - P1[0]), 2 * (P2[1] - P1[1])];
    d2 = [2 * (P2[0] - 2 * P1[0] + P0[0]), 2 * (P2[1] - 2 * P1[1] + P0[1])];
  }
  const L = Math.hypot(d1[0], d1[1]); if (L < 1e-9) return 0;
  return (d1[0] * d2[1] - d1[1] * d2[0]) / (L * L * L);
}

// Point on a segment at parameter t (enough for curvature fits).
export function segPt(sg, t) {
  if (sg.type === SEG_LINE) return [sg.p1[0] + t * (sg.p2[0] - sg.p1[0]), sg.p1[1] + t * (sg.p2[1] - sg.p1[1])];
  if (sg.type === SEG_CUBIC) { const u = 1 - t; return [u*u*u*sg.p1[0]+3*u*u*t*sg.p2[0]+3*u*t*t*sg.p3[0]+t*t*t*sg.p4[0], u*u*u*sg.p1[1]+3*u*u*t*sg.p2[1]+3*u*t*t*sg.p3[1]+t*t*t*sg.p4[1]]; }
  const u = 1 - t, w = sg.type === SEG_RQUAD ? (sg.w || 1) : 1, d = u*u + 2*u*t*w + t*t;
  return [(u*u*sg.p1[0] + 2*u*t*w*sg.p2[0] + t*t*sg.p3[0]) / d, (u*u*sg.p1[1] + 2*u*t*w*sg.p2[1] + t*t*sg.p3[1]) / d];
}

// End metadata for a segment's band primitive (the kind-10 cap-strip; the kind-12 curve
// band): at each endpoint, the NEIGHBOUR segment's outward tangent normal, an osculating
// curvature fitted radially about the corner (κ = 2·dev/r², 0 for line neighbours), the
// corner type (+1 convex · −1 reflex · 0 straight), and whether the neighbour is a curve
// (partition against the arc's tangent plane / bisector instead of the line-line bisector).
// Generic over the OWN segment type too: the own end tangent and endpoint come from the
// segTangents row (which===1 on a curve is the on-curve END point, not the control point).
export function edgeEndMeta(segs, tg, si, which, interiorSign) {
  const n = segs.length;
  const nb = which === 0 ? (si - 1 + n) % n : (si + 1) % n;
  const V = which === 0 ? segs[si].p1 : (tg[si].end || segs[si].p2);
  const tOwnR = which === 0 ? tg[si].t0 : tg[si].t1, tNbR = which === 0 ? tg[nb].t1 : tg[nb].t0;
  const Lo = Math.hypot(tOwnR[0], tOwnR[1]) || 1, Ln = Math.hypot(tNbR[0], tNbR[1]) || 1;
  const to = [tOwnR[0] / Lo, tOwnR[1] / Lo], tn = [tNbR[0] / Ln, tNbR[1] / Ln];
  const sgn = interiorSign > 0 ? 1 : -1;
  const nN = [tn[1] * sgn, -tn[0] * sgn];                       // neighbour outward normal at V
  // turn across the corner in travel order (in → out)
  const tin = which === 0 ? tn : to, tout = which === 0 ? to : tn;
  const cross = (tin[0] * tout[1] - tin[1] * tout[0]) * interiorSign;
  const type = cross > 0.02 ? 1 : cross < -0.02 ? -1 : 0;
  const samp = segPt(segs[nb], which === 0 ? 0.9 : 0.1);
  const dev = nN[0] * (samp[0] - V[0]) + nN[1] * (samp[1] - V[1]);
  const r2 = (samp[0] - V[0]) * (samp[0] - V[0]) + (samp[1] - V[1]) * (samp[1] - V[1]);
  const k = r2 > 1e-12 ? 2 * dev / r2 : 0;
  // Direction INTO the neighbour's span from V, as a sign on perp(nN) — packed exactly so
  // the fragment's partition plane never depends on an ill-conditioned canonicalization
  // (at ~90° corners perp(nN) ⊥ the edge and a tie-break flip discards the whole band).
  const into = which === 0 ? [-tn[0], -tn[1]] : [tn[0], tn[1]];
  const tsign = into[0] * (-nN[1]) + into[1] * nN[0] > 0 ? 1 : 0;
  // qn: neighbour is bandable under kind-12 (quad / rquad / cubic).
  // turn: sharp turns (|turn| ≥ LB_BAND_SHARP_TURN) pack full sampled κ;
  // shallower bandable joints still chain but with κ≡0.
  return { nN, k, type, curve: segs[nb].type !== SEG_LINE, tsign,
    qn: segs[nb].type === SEG_QUAD || segs[nb].type === SEG_RQUAD || segs[nb].type === SEG_CUBIC,
    turn: cross };
}

// Barycentric coords of p in triangle (a,b,c).
// FAT arcs use the RING strip (15 verts); SHALLOW arcs keep the padded-bbox
// strip (6). Pack derives fatness via live fatArc — hull.fat still drives CDT
// tip-clip exemption and morph-pair strip-plan agreement.
export function fatArc(ax, ay, cx, cy, bx, by) {
  return Math.abs((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) >= 0.02 * ((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
}

