// svg/mesh.js — cover-quad emitter + supporting curve
// geometry (apex finding, cubic split, monotone subdivision, convex
// hull, OBB fitting).
//
// getCoverQuadMesh: given a shape's seg list, fill color, and fill-rule,
// it produces the per-shape OBB cover-quad mesh (COVER_QUAD_STRIDE × N
// floats) that the fill fragment shader rasterises. The OBB fit uses PCA
// on closed-form curve moments (accumMomentsForSeg + fitOBBAnalytic) so
// diagonal shapes (italic text, rotated panels) get tight bounds.

import {
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  mkLine,
  segStart, segEnd, segStartEnd,
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
  const s  = lerp(r1, r2, t);
  return [
    { type: SEG_CUBIC, p1: seg.p1, p2: q1, p3: r1, p4: s },
    { type: SEG_CUBIC, p1: s,      p2: r2, p3: q3, p4: seg.p4 },
  ];
}

// Quadratic Bezier subdivision (only y- and x-extrema, no inflection).
// Same approach.
export function splitQuadAt(seg, t) {
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const q1 = lerp(seg.p1, seg.p2, t);
  const q2 = lerp(seg.p2, seg.p3, t);
  const s  = lerp(q1, q2, t);
  return [
    { type: SEG_QUAD, p1: seg.p1, p2: q1, p3: s },
    { type: SEG_QUAD, p1: s,      p2: q2, p3: seg.p3 },
  ];
}

// Analytic OBB fit via closed-form curve moments + analytic axis
// projection. The principal axis comes from the eigenangle of the
// curve's centred covariance matrix (built by accumMomentsForSeg);
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
  if (M.L < 1e-12) return null;
  // Centred covariance: Cxx = Sxx - Sx²/L, etc.
  const mx = M.Sx / M.L;
  const my = M.Sy / M.L;
  const cxx = M.Sxx - M.Sx * mx;
  const cxy = M.Sxy - M.Sx * my;
  const cyy = M.Syy - M.Sy * my;
  const trace = cxx + cyy;
  if (trace < 1e-20) return null;
  const diff = cxx - cyy;
  const off2 = 2 * cxy;
  const angle = 0.5 * Math.atan2(off2, diff);
  // Skip OBB if eigen-axis is within ~5° of world axes. Avoids
  // rotated-by-float-noise OBBs on near-axis-aligned shapes.
  if (Math.abs(angle) < 0.087 || Math.abs(angle) > Math.PI - 0.087 ||
      Math.abs(Math.abs(angle) - 0.5 * Math.PI) < 0.087) {
    return null;
  }
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const vx = -uy, vy = ux;
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
  let uMin = eU.min, uMax = eU.max, vMin = eV.min, vMax = eV.max;
  if (padEm > 0) {
    uMin -= padEm; uMax += padEm;
    vMin -= padEm; vMax += padEm;
  }
  // Square-ish fallback: if the OBB sides are within 5%, PCA's
  // rotation choice is ill-conditioned (eigenvalues nearly equal,
  // angle dominated by noise). AABB gives the same area but stays
  // inside the shape's AABB so the band-walker's clamp logic doesn't
  // misclassify fragments outside the rotated quad.
  const uLen = uMax - uMin, vLen = vMax - vMin;
  if (uLen > 0 && vLen > 0) {
    const ratio = uLen > vLen ? vLen / uLen : uLen / vLen;
    if (ratio > 0.95) return null;
  }
  // Reconstruct 4 OBB corners. The OBB is in (u, v) space anchored
  // at the world-frame projection mean; here uMin/uMax/vMin/vMax are
  // absolute projection coordinates, so the corner mapping is:
  //   corner(u, v) = u·uHat + v·vHat (in world frame; no centroid
  //   offset because uMin/uMax already include it).
  // But our analytic projection is relative to world origin
  // (g = ux·x + uy·y), not to the centroid. So uMin/uMax already
  // span the full em-space extent along the u axis. Map back:
  //   point = (uHat * u + vHat * v) = (ux*u + vx*v, uy*u + vy*v)
  const corner = (u, v) => [ux * u + vx * v, uy * u + vy * v];
  return [
    corner(uMin, vMin),
    corner(uMax, vMin),
    corner(uMax, vMax),
    corner(uMin, vMax),
  ];
}

// ===== Analytic curve moments for PCA-OBB =====
//
// Each primitive contributes (L, Sx, Sy, Sxx, Sxy, Syy) computed by
// closed-form integrals over its natural parameter (t ∈ [0,1] for
// Bezier; θ ∈ [θ_start, θ_end] for arc). The OBB principal axis is
// then the eigenangle of the centred covariance matrix C, computed
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
function intP(c) { // ∫₀¹ p dt where p = a + bt + ct² + dt³
  return c.a + c.b/2 + c.c/3 + c.d/4;
}
function intPQ(p, q) { // ∫₀¹ p(t)·q(t) dt
  const a = p.a, b = p.b, c = p.c, d = p.d;
  const e = q.a, f = q.b, g = q.c, h = q.d;
  // (a + bt + ct² + dt³)·(e + ft + gt² + ht³) expanded:
  //   c0 = ae
  //   c1 = af + be
  //   c2 = ag + bf + ce
  //   c3 = ah + bg + cf + de
  //   c4 = bh + cg + df
  //   c5 = ch + dg
  //   c6 = dh
  // ∫₀¹ t^k = 1/(k+1)
  return a*e
       + (a*f + b*e) / 2
       + (a*g + b*f + c*e) / 3
       + (a*h + b*g + c*f + d*e) / 4
       + (b*h + c*g + d*f) / 5
       + (c*h + d*g) / 6
       + d*h / 7;
}

// Convert a segment to (px, py) power-form cubic polynomials per
// axis. Lines have c=d=0; quads have d=0; cubics use all 4 terms.
// Arc returns null (handled separately via trig integrals).
function segToPolyXY(s) {
  if (s.type === SEG_LINE) {
    return {
      px: { a: s.p1[0], b: s.p2[0]-s.p1[0], c: 0, d: 0 },
      py: { a: s.p1[1], b: s.p2[1]-s.p1[1], c: 0, d: 0 },
    };
  }
  if (s.type === SEG_QUAD) {
    const x0 = s.p1[0], x1 = s.p2[0], x2 = s.p3[0];
    const y0 = s.p1[1], y1 = s.p2[1], y2 = s.p3[1];
    return {
      px: { a: x0, b: 2*(x1-x0), c: x0 - 2*x1 + x2, d: 0 },
      py: { a: y0, b: 2*(y1-y0), c: y0 - 2*y1 + y2, d: 0 },
    };
  }
  if (s.type === SEG_CUBIC) {
    const x0 = s.p1[0], x1 = s.p2[0], x2 = s.p3[0], x3 = s.p4[0];
    const y0 = s.p1[1], y1 = s.p2[1], y2 = s.p3[1], y3 = s.p4[1];
    return {
      px: { a: x0, b: 3*(x1-x0), c: 3*(x0 - 2*x1 + x2), d: -x0 + 3*x1 - 3*x2 + x3 },
      py: { a: y0, b: 3*(y1-y0), c: 3*(y0 - 2*y1 + y2), d: -y0 + 3*y1 - 3*y2 + y3 },
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
    const cp = Math.cos(s.phi || 0), sp = Math.sin(s.phi || 0);
    const Ax = cp * s.rx, Bx = -sp * s.ry;
    const Ay = sp * s.rx, By = cp * s.ry;
    const t0 = s.theta_start, t1 = s.theta_end;
    const L = t1 - t0;
    // Antiderivatives:
    //   ∫cos θ dθ = sin θ
    //   ∫sin θ dθ = -cos θ
    //   ∫cos²θ dθ = θ/2 + sin(2θ)/4
    //   ∫sin²θ dθ = θ/2 - sin(2θ)/4
    //   ∫cos θ·sin θ dθ = -cos(2θ)/4
    const Icos  = Math.sin(t1) - Math.sin(t0);          // ∫cos
    const Isin  = -(Math.cos(t1) - Math.cos(t0));        // ∫sin
    const Icos2 = L/2 + (Math.sin(2*t1) - Math.sin(2*t0)) / 4;  // ∫cos²
    const Isin2 = L/2 - (Math.sin(2*t1) - Math.sin(2*t0)) / 4;  // ∫sin²
    const Ics   = -(Math.cos(2*t1) - Math.cos(2*t0)) / 4;       // ∫cos·sin
    // ∫x dθ = cx·L + Ax·Icos + Bx·Isin
    // ∫y dθ = cy·L + Ay·Icos + By·Isin
    M.L  += L;
    M.Sx += s.cx * L + Ax * Icos + Bx * Isin;
    M.Sy += s.cy * L + Ay * Icos + By * Isin;
    // ∫x² dθ = ∫(cx + Ax·cos + Bx·sin)² dθ
    //         = cx²·L + 2·cx·(Ax·Icos + Bx·Isin)
    //         + Ax²·Icos2 + 2·Ax·Bx·Ics + Bx²·Isin2
    M.Sxx += s.cx * s.cx * L
           + 2 * s.cx * (Ax * Icos + Bx * Isin)
           + Ax * Ax * Icos2 + 2 * Ax * Bx * Ics + Bx * Bx * Isin2;
    // ∫y² dθ analogously
    M.Syy += s.cy * s.cy * L
           + 2 * s.cy * (Ay * Icos + By * Isin)
           + Ay * Ay * Icos2 + 2 * Ay * By * Ics + By * By * Isin2;
    // ∫x·y dθ = ∫(cx + Ax·cos + Bx·sin)·(cy + Ay·cos + By·sin) dθ
    //         = cx·cy·L
    //         + cx·(Ay·Icos + By·Isin)
    //         + cy·(Ax·Icos + Bx·Isin)
    //         + Ax·Ay·Icos2 + (Ax·By + Bx·Ay)·Ics + Bx·By·Isin2
    M.Sxy += s.cx * s.cy * L
           + s.cx * (Ay * Icos + By * Isin)
           + s.cy * (Ax * Icos + Bx * Isin)
           + Ax * Ay * Icos2 + (Ax * By + Bx * Ay) * Ics + Bx * By * Isin2;
    return;
  }
  const poly = segToPolyXY(s);
  if (!poly) return;
  // Bezier (line/quad/cubic) in power form. Integration over t ∈ [0,1].
  M.L  += 1;
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
    const px = poly.px, py = poly.py;
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
      ex0 = s.p1[0]; ey0 = s.p1[1]; ex1 = s.p3[0]; ey1 = s.p3[1];
    } else {
      ex0 = s.p1[0]; ey0 = s.p1[1]; ex1 = s.p4[0]; ey1 = s.p4[1];
    }
    let g = ux * ex0 + uy * ey0;
    if (g < ext.min) ext.min = g;
    if (g > ext.max) ext.max = g;
    g = ux * ex1 + uy * ey1;
    if (g < ext.min) ext.min = g;
    if (g > ext.max) ext.max = g;
    // Critical points of g(t): solve g'(t)=0.
    if (Math.abs(D) < 1e-12) {
      // Quadratic case (D=0; quad source or cubic-degenerated-to-quad).
      if (Math.abs(C) > 1e-12) {
        const t = -B / (2 * C);
        if (t > 0 && t < 1) {
          const gv = A + B*t + C*t*t + D*t*t*t;
          if (gv < ext.min) ext.min = gv;
          if (gv > ext.max) ext.max = gv;
        }
      }
    } else {
      // Cubic case: g'(t) = B + 2Ct + 3Dt² = 0 → t = (-2C ± √(4C² - 12BD)) / (6D)
      const disc = 4 * C * C - 12 * B * D;
      if (disc >= 0) {
        const sd = Math.sqrt(disc);
        for (const t of [(-2 * C - sd) / (6 * D), (-2 * C + sd) / (6 * D)]) {
          if (t > 0 && t < 1) {
            const gv = A + B*t + C*t*t + D*t*t*t;
            if (gv < ext.min) ext.min = gv;
            if (gv > ext.max) ext.max = gv;
          }
        }
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
    const cp = Math.cos(s.phi || 0), sp = Math.sin(s.phi || 0);
    const Ax = cp * s.rx, Bx = -sp * s.ry;
    const Ay = sp * s.rx, By = cp * s.ry;
    const Cc = ux * Ax + uy * Ay;
    const Cs = ux * Bx + uy * By;
    const evalArcAt = (theta) => {
      const ct = Math.cos(theta), st = Math.sin(theta);
      const x = s.cx + Ax * ct + Bx * st;
      const y = s.cy + Ay * ct + By * st;
      const g = ux * x + uy * y;
      if (g < ext.min) ext.min = g;
      if (g > ext.max) ext.max = g;
    };
    evalArcAt(s.theta_start);
    evalArcAt(s.theta_end);
    if (Math.abs(Cc) > 1e-12 || Math.abs(Cs) > 1e-12) {
      const thetaCrit = Math.atan2(Cs, Cc);
      const t0 = s.theta_start, t1 = s.theta_end;
      const tLo = Math.min(t0, t1), tHi = Math.max(t0, t1);
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


export function getCoverQuadMesh(segs, gid, fillRgba, fillRule, padEm = 0) {
  const out = [];

  // Cover-quad model: emit ONE quad covering the WHOLE shape's extent
  // (across all subpaths). The DirectFill fragment shader runs the
  // per-pixel ray-cast at every covered pixel; coverage is the
  // silhouette mask for the entire shape.
  //
  // Cover quad: prefer an oriented bbox (PCA-fit) for tighter coverage
  // on diagonal/italic shapes, fall back to axis-aligned bbox when PCA
  // picks a near-world-aligned axis or the cloud is degenerate. Only
  // the mesh quad's verts change; the meta record's bbox stays
  // axis-aligned (it's used to derive the band-coord transform inside
  // the coverage walker, which expects em-space-axis-aligned bands).
  //
  // padEm: outward dilation of the cover quad in em units (e.g. halfW
  // for stroke shapes so the cover extends past the path-tight bbox to
  // include the full stroke envelope).
  //
  // Emitting one quad per SHAPE rather than per subpath avoids
  // double-painting at overlap regions where subpath bboxes overlap
  // (each was running coverage independently, with `Blend One
  // OneMinusSrcAlpha` then accumulating the same coverage twice for
  // an over-bright result).
  let xL = +Infinity, yT = +Infinity, xR = -Infinity, yB = -Infinity;
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
    xL -= padEm; yT -= padEm; xR += padEm; yB += padEm;
  }
  if (xR - xL > 1e-7 && yB - yT > 1e-7) {
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
      const ux = c1[0] - c0[0], uy = c1[1] - c0[1];
      const vx = c3[0] - c0[0], vy = c3[1] - c0[1];
      const uLen = Math.sqrt(ux*ux + uy*uy);
      const vLen = Math.sqrt(vx*vx + vy*vy);
      if (uLen > 1e-9 && vLen > 1e-9) {
        const uhx = ux/uLen, uhy = uy/uLen;
        const vhx = vx/vLen, vhy = vy/vLen;
        const nC0 = [-uhx - vhx, -uhy - vhy];
        const nC1 = [+uhx - vhx, +uhy - vhy];
        const nC2 = [+uhx + vhx, +uhy + vhy];
        const nC3 = [-uhx + vhx, -uhy + vhy];
        verts   = [c0,  c1,  c2,  c0,  c2,  c3 ];
        normals = [nC0, nC1, nC2, nC0, nC2, nC3];
      } else {
        // Degenerate OBB axes — drop dilation, zero normals.
        verts   = [c0, c1, c2, c0, c2, c3];
        normals = [[0,0],[0,0],[0,0],[0,0],[0,0],[0,0]];
      }
    } else {
      const tl = [xL, yT], tr = [xR, yT], br = [xR, yB], bl = [xL, yB];
      verts = [tl, tr, br, tl, br, bl];
      // SVG y is down (yT < yB), so "top" corners get sy = -1.
      normals = [[-1,-1],[+1,-1],[+1,+1],[-1,-1],[+1,+1],[-1,+1]];
    }
    for (let vi = 0; vi < verts.length; vi++) {
      const v = verts[vi], n = normals[vi];
      out.push(
        v[0], v[1],
        // First "control point" slot holds the outward bisector
        // normal. Cover quads don't use cp0..cp3 for fills, so this is
        // safe and stays layout-compatible with the mesh vertex format.
        n[0], n[1],
        0, 0, 0, 0, 0, 0,
        kind, HULL_ZONE,
      );
    }
  }
  return out;
}
