// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillCoverage.js — winding ray-cast, primKind fast paths, point-in-fill.

import { solveQuadratic, solveCubicInUnit } from '../svg/pathBoolean/polyRoots.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from './curveGeom.js';
import { buildWindingTree, treeWinding } from '../geom/windingTree.js';
import { arcRayCrossings } from './bandWinding.js';

const RAY_REL = 1e-9;

const META_BBOX_XMIN = 0;
const META_BBOX_YMIN = 1;
const META_BBOX_XMAX = 2;
const META_BBOX_YMAX = 3;
const META_PRIMKIND = 44; // t11.x: 0 ray-cast, 1 circle, 2 rect, 3 roundRect
const META_PRIMRX = 46; // t11.z: roundRect corner radius (em) when primKind==3

// ── Fill: exact signed crossings of the +x ray at y = yr with each seg ──
function crossLine(s, px, yr) {
  const y0 = s.y0,
    y1 = s.y1;
  if (y0 > yr !== y1 > yr) {
    const x = s.x0 + ((yr - y0) / (y1 - y0)) * (s.x1 - s.x0);
    if (x > px) return y1 > y0 ? 1 : -1;
  }
  return 0;
}
function crossQuad(s, px, yr) {
  // y-hull cull: the curve lies within its control points' y-range (Bézier convex
  // hull), so it can't cross the ray if yr is outside — skip the root solve.
  if (yr < Math.min(s.y0, s.cy, s.y1) || yr > Math.max(s.y0, s.cy, s.y1)) return 0;
  const Ay = s.y0 - 2 * s.cy + s.y1,
    By = 2 * (s.cy - s.y0),
    Cy = s.y0 - yr;
  let w = 0;
  for (const t of solveQuadratic(Ay, By, Cy)) {
    if (t < 0 || t >= 1) continue;
    const u = 1 - t;
    const x = u * u * s.x0 + 2 * u * t * s.cx + t * t * s.x1;
    if (x > px) {
      const dy = 2 * Ay * t + By;
      if (dy > 0) w++;
      else if (dy < 0) w--;
    }
  }
  return w;
}
function crossCubic(s, px, yr) {
  // y-hull cull (Bézier convex hull): skip the cubic root solve when yr is outside
  // the control points' y-range.
  if (yr < Math.min(s.y0, s.c1y, s.c2y, s.y1) || yr > Math.max(s.y0, s.c1y, s.c2y, s.y1)) return 0;
  const D3 = -s.y0 + 3 * s.c1y - 3 * s.c2y + s.y1;
  const D2 = 3 * (s.y0 - 2 * s.c1y + s.c2y);
  const D1 = 3 * (s.c1y - s.y0);
  const D0 = s.y0 - yr;
  // Fill crossing uses the shader's cubic root finder (Yuksel clamped-Newton)
  // rather than Cardano, so the hit test's inside/outside matches what the
  // shader draws and stays robust where Cardano's disc≈0 branch loses
  // precision. Stroke/arc closest-point stays exact-analytic.
  let w = 0;
  for (const t of solveCubicInUnit(D3, D2, D1, D0)) {
    if (t < 0 || t >= 1) continue;
    const u = 1 - t;
    const x = u * u * u * s.x0 + 3 * u * u * t * s.c1x + 3 * u * t * t * s.c2x + t * t * t * s.x1;
    if (x > px) {
      const dy = 3 * D3 * t * t + 2 * D2 * t + D1;
      if (dy > 0) w++;
      else if (dy < 0) w--;
    }
  }
  return w;
}
// THE ARC'S CROSSINGS OF THE +x RAY, COUNTED FROM THE ENDPOINT SIDES on its monotone pieces -- the rule every
// renderer walker applies (bandWinding.js arcRayCrossings, _coverage.glsl's twin) -- with the END SIGNS FROM THE
// Stored vertices: s.x0/y0/x1/y1 are the record's endpoints (decodeSegs), the floats the neighboring
// segments store, so a vertex is decided by one number for the arc and the segment beside it. Solving both roots from
// the center form and keeping one by a half-open parametric range would not do: at a ray through a vertex that range's
// end is the arc's REBUILT end, and a row exactly through a rounded rect's corner or an annulus's joints would read the
// wrong side.
function crossArc(s, px, yr) {
  const lo = Math.min(s.th0, s.th1),
    hi = Math.min(Math.max(s.th0, s.th1), lo + 2 * Math.PI),
    dir = s.th1 >= s.th0 ? 1 : -1;
  const uS = s.y0 - yr,
    uE = s.y1 - yr;
  let w = 0;
  // u(θ) = y(θ) − yr = rx·sinφ·cosθ + ry·cosφ·sinθ − (yr − cy)
  for (const [code, th] of arcRayCrossings(
    lo,
    hi,
    dir,
    s.rx * s.sp,
    s.ry * s.cp,
    yr - s.cy,
    dir > 0 ? uS : uE,
    dir > 0 ? uE : uS,
    false,
  )) {
    if (code === 0) continue;
    const x = s.cx + s.rx * Math.cos(th) * s.cp - s.ry * Math.sin(th) * s.sp;
    if (x > px) w += code === 2 ? -1 : 1; // the path's last end below the ray: a crossing downward
  }
  return w;
}

/** Signed +x-ray crossings of one hit-test segment (the tree's near-leaf evaluator). */
export function crossSeg(s, px, yr) {
  if (s.t === SEG_LINE) return crossLine(s, px, yr);
  if (s.t === SEG_QUAD) return crossQuad(s, px, yr);
  if (s.t === SEG_CUBIC) return crossCubic(s, px, yr);
  return crossArc(s, px, yr);
}

// A winding tree pays off once the linear walk's per-query root solves dominate its
// build+descent cost; below this the plain loop wins.
export const WINDING_TREE_MIN_SEGS = 48;

/** Build the hit-test winding tree over decoded segs (null below the cutoff). */
function segBBox(s) {
  if (s.t === SEG_LINE)
    return [Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.max(s.x0, s.x1), Math.max(s.y0, s.y1)];
  if (s.t === SEG_QUAD)
    return [
      Math.min(s.x0, s.cx, s.x1),
      Math.min(s.y0, s.cy, s.y1),
      Math.max(s.x0, s.cx, s.x1),
      Math.max(s.y0, s.cy, s.y1),
    ];
  if (s.t === SEG_CUBIC)
    return [
      Math.min(s.x0, s.c1x, s.c2x, s.x1),
      Math.min(s.y0, s.c1y, s.c2y, s.y1),
      Math.max(s.x0, s.c1x, s.c2x, s.x1),
      Math.max(s.y0, s.c1y, s.c2y, s.y1),
    ];
  const ax = Math.abs(s.rx * s.cp) + Math.abs(s.ry * s.sp); // rotated-ellipse bound
  const ay = Math.abs(s.rx * s.sp) + Math.abs(s.ry * s.cp);
  return [s.cx - ax, s.cy - ay, s.cx + ax, s.cy + ay];
}

// The shape's extent times RAY_REL, once per decoded segment list (callers cache those and never
// edit them in place).
const _rayNudge = new WeakMap();
function rayNudgeOf(segs) {
  let n = _rayNudge.get(segs);
  if (n !== undefined) return n;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs) {
    const b = segBBox(s);
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  n = x1 >= x0 ? RAY_REL * Math.max(x1 - x0, y1 - y0) : 0;
  _rayNudge.set(segs, n);
  return n;
}

export function buildFillTree(segs) {
  if (!segs || segs.length < WINDING_TREE_MIN_SEGS) return null;
  const bbox = (i) => segBBox(segs[i]);
  return buildWindingTree(segs.length, {
    start: (i) => [segs[i].x0, segs[i].y0],
    end: (i) => [segs[i].x1, segs[i].y1],
    bbox,
    cross: (i, x, yr) => crossSeg(segs[i], x, yr),
  });
}

/** Point inside the filled region — exact signed crossings of the +x ray. An optional
 *  winding tree makes the query O(log N + near) with IDENTICAL results (far runs collapse
 *  to their chords; crossing parity equals net-signed parity, so even-odd works from the
 *  same sum). */
export function pointInFill(segs, px, py, evenOdd, tree) {
  // Nudge the ray off exact y-extrema so tangencies (double roots) don't
  // register as crossings. Never under the precision of
  // py itself, or far from the origin the nudge rounds away.
  const yr = py + Math.max(rayNudgeOf(segs), 32 * Number.EPSILON * Math.abs(py));
  let wind = 0;
  if (tree) {
    wind = treeWinding(tree, px, yr);
  } else {
    for (let i = 0; i < segs.length; i++) wind += crossSeg(segs[i], px, yr);
  }
  return evenOdd ? (wind & 1) === 1 : wind !== 0;
}

// Analytic inside-test for simple-shape primitives (meta texel 11.x).
// The renderer fills these via a closed-form SDF; the hit test must agree at
// the d=0 boundary AND skip the curve-buffer decode. Returns 1 inside, 0
// outside, or -1 = "not a fast prim here, fall back to winding" (a
// non-uniformly-scaled circle bakes to an ellipse the SDF rejects, so its hit
// test must stay on the exact arc winding too). The SDF bodies are sdCircle /
// sdRoundedBox, so the boundary is identical to the render.
export function pointInPrim(meta, off, px, py, tie = 0) {
  const kind = Math.round(meta[off + META_PRIMKIND]);
  if (kind === 0) return -1;
  const x0 = meta[off + META_BBOX_XMIN],
    y0 = meta[off + META_BBOX_YMIN];
  const x1 = meta[off + META_BBOX_XMAX],
    y1 = meta[off + META_BBOX_YMAX];
  const hex = 0.5 * (x1 - x0),
    hey = 0.5 * (y1 - y0);
  const qx = px - 0.5 * (x0 + x1),
    qy = py - 0.5 * (y0 + y1);
  if (kind === 1) {
    if (Math.abs(hex - hey) > 1e-3 * Math.max(hex, hey)) return -1;
    const r = Math.min(hex, hey);
    return qx * qx + qy * qy <= (r + tie) * (r + tie) ? 1 : 0;
  }
  const rx = kind === 3 ? meta[off + META_PRIMRX] : 0; // rect: rx=0
  const ex = Math.abs(qx) - hex + rx,
    ey = Math.abs(qy) - hey + rx;
  const ax = Math.max(ex, 0),
    ay = Math.max(ey, 0);
  const d = Math.min(Math.max(ex, ey), 0) + Math.hypot(ax, ay) - rx;
  return d <= tie ? 1 : 0;
}

// ── Fill: the exact coverage of a pixel box ──
// The renderer's fill kernel is the exact box coverage -- renderFill is AAC's walk -- so "what is drawn" at a pixel is
// this number, and the hit test reads it. Every segment is mapped into the pixel's unit cell, cut into x- and y-monotone
// pieces at the roots of its derivative, each piece bisected in f64 (to the last bit, a root solve) where it crosses
// x = 0, 1 or y = 0, 1, and the pieces inside 0 <= y <= 1 add clamp(1 - x, 0, 1) dy: exactly, by Gauss-Legendre 16 on a
// piece inside the cell (exact for a cubic's degree-5 x y', converged for an arc piece inside one quadrant). The signed
// sum is resolved as the kernels resolve it: min(|w|, 1) nonzero, the triangle wave even-odd. An arc is its center form
// joined to its STORED endpoints by lines, so the contour closes exactly at any zoom. A segment the cell cannot
// see is skipped from its box: above or below the cell it adds nothing, wholly right of it nothing (clamp(1 - x) = 0),
// wholly left its clamped dy. probes/fillperf/cellCoverage.mjs, the kernel-identity reference, is this function.
const GLX = [
  -0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.755404408355003,
  -0.6178762444026438, -0.4580167776572274, -0.2816035507792589, -0.0950125098376374,
  0.0950125098376374, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438, 0.755404408355003,
  0.8656312023878318, 0.9445750230732326, 0.9894009349916499,
];
const GLW = [
  0.0271524594117541, 0.0622535239386479, 0.0951585116824928, 0.1246289712555339,
  0.1495959888165767, 0.1691565193950025, 0.1826034150449236, 0.1894506104550685,
  0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767,
  0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541,
];
function rootsQ(a, b, c, out) {
  // a t^2 + b t + c, pushed in no order; a double root once
  const s = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (s === 0) return;
  a /= s;
  b /= s;
  c /= s;
  if (Math.abs(a) < 1e-12) {
    if (b !== 0) out.push(-c / b);
    return;
  }
  const d = b * b - 4 * a * c;
  if (d < 0) {
    out.push(-b / (2 * a));
    return;
  }
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(d));
  out.push(q / a);
  if (q !== 0) out.push(c / q);
}
// a Bezier of degree 1-3 in cell coordinates: its point, derivative, and the t's where x' or y' is zero
function mkPoly(pts) {
  const n = pts.length - 1;
  const ev = (t) => {
    const p = pts.map((q) => q.slice());
    for (let k = n; k > 0; k--)
      for (let i = 0; i < k; i++) {
        p[i][0] += (p[i + 1][0] - p[i][0]) * t;
        p[i][1] += (p[i + 1][1] - p[i][1]) * t;
      }
    return p[0];
  };
  const D = [];
  for (let i = 0; i < n; i++)
    D.push([n * (pts[i + 1][0] - pts[i][0]), n * (pts[i + 1][1] - pts[i][1])]);
  const dv = (t) => {
    if (n === 1) return D[0];
    const p = D.map((q) => q.slice());
    for (let k = n - 1; k > 0; k--)
      for (let i = 0; i < k; i++) {
        p[i][0] += (p[i + 1][0] - p[i][0]) * t;
        p[i][1] += (p[i + 1][1] - p[i][1]) * t;
      }
    return p[0];
  };
  const crit = [];
  for (let ax = 0; ax < 2; ax++) {
    if (n === 2) {
      const a = D[0][ax],
        b = D[1][ax];
      if (a !== b) crit.push(a / (a - b));
    }
    if (n === 3) {
      const d0 = D[0][ax],
        d1 = D[1][ax],
        d2 = D[2][ax];
      rootsQ(d0 - 2 * d1 + d2, 2 * (d1 - d0), d0, crit);
    }
  }
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
  return { ev, dv, crit, box: [x0, y0, x1, y1] };
}
// an arc of the center form (cx, cy, rx, ry, cp, sp, th0 .. th1) through the cell map P / Pd (em point / em vector)
function mkArc(g, P, Pd) {
  const T = g.th1 - g.th0;
  const ev = (t) => {
    const th = g.th0 + T * t;
    return P(
      g.cx + g.cp * g.rx * Math.cos(th) - g.sp * g.ry * Math.sin(th),
      g.cy + g.sp * g.rx * Math.cos(th) + g.cp * g.ry * Math.sin(th),
    );
  };
  const dv = (t) => {
    const th = g.th0 + T * t;
    return Pd(
      T * (-g.cp * g.rx * Math.sin(th) - g.sp * g.ry * Math.cos(th)),
      T * (-g.sp * g.rx * Math.sin(th) + g.cp * g.ry * Math.cos(th)),
    );
  };
  const crit = [];
  const add = (phi) => {
    for (let k = -4; k <= 4; k++) {
      const t = (phi + k * Math.PI - g.th0) / T;
      if (t > 0 && t < 1) crit.push(t);
    }
  };
  add(Math.atan2(-g.ry * g.sp, g.rx * g.cp));
  add(Math.atan2(g.ry * g.cp, g.rx * g.sp));
  // the whole ellipse's box bounds the arc (segBBox's bound, through the cell map)
  const ax = Math.abs(g.rx * g.cp) + Math.abs(g.ry * g.sp),
    ay = Math.abs(g.rx * g.sp) + Math.abs(g.ry * g.cp);
  const a = P(g.cx - ax, g.cy - ay),
    b = P(g.cx + ax, g.cy + ay);
  return {
    ev,
    dv,
    crit,
    box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
  };
}
// the signed sum of clamp(1 - x, 0, 1) dy over the parts of s inside 0 <= y <= 1
function cellContrib(s) {
  const [bx0, by0, bx1, by1] = s.box;
  if (by1 <= 0 || by0 >= 1 || bx0 >= 1) return 0; // above, below, or right of the cell
  if (bx1 <= 0) {
    // left of it: the clamped dy
    const ya = s.ev(0)[1],
      yb = s.ev(1)[1];
    return Math.min(1, Math.max(0, yb)) - Math.min(1, Math.max(0, ya));
  }
  const ts = [0, 1, ...s.crit.filter((t) => t > 0 && t < 1)].sort((a, b) => a - b);
  const cuts = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i],
      b = ts[i + 1];
    if (!(b > a)) continue;
    cuts.push(a);
    const pa = s.ev(a),
      pb = s.ev(b);
    for (let ax = 0; ax < 2; ax++)
      for (const L of [0, 1]) {
        const fa = pa[ax] - L,
          fb = pb[ax] - L;
        if (fa < 0 === fb < 0 || fa === 0 || fb === 0) continue;
        let lo = a,
          hi = b,
          flo = fa;
        for (let it = 0; it < 80; it++) {
          const m = 0.5 * (lo + hi);
          if (m <= lo || m >= hi) break;
          const fm = s.ev(m)[ax] - L;
          if (fm < 0 === flo < 0) {
            lo = m;
            flo = fm;
          } else hi = m;
        }
        cuts.push(0.5 * (lo + hi));
      }
  }
  cuts.push(1);
  cuts.sort((a, b) => a - b);
  let run = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i],
      b = cuts[i + 1];
    if (!(b > a)) continue;
    const pm = s.ev(0.5 * (a + b));
    if (pm[1] < 0 || pm[1] > 1) continue;
    const ya = s.ev(a)[1],
      yb = s.ev(b)[1];
    const ca = Math.min(1, Math.max(0, ya)),
      cb = Math.min(1, Math.max(0, yb));
    if (pm[0] >= 1) continue;
    if (pm[0] <= 0) {
      run += cb - ca;
      continue;
    }
    let I = 0;
    const h = 0.5 * (b - a),
      m = 0.5 * (a + b);
    for (let k = 0; k < 16; k++) {
      const t = m + h * GLX[k],
        p = s.ev(t),
        d = s.dv(t);
      I += GLW[k] * Math.min(1, Math.max(0, 1 - p[0])) * d[1];
    }
    run += I * h;
  }
  return run;
}
/** The exact coverage of the pixel box of size (ex, ey) em centered on (cx, cy), f64 (see above). */
export function boxCoverage(segs, cx, cy, ex, ey, evenOdd) {
  const P = (x, y) => [(x - cx) / ex + 0.5, (y - cy) / ey + 0.5];
  const Pd = (x, y) => [x / ex, y / ey];
  let run = 0;
  for (const g of segs) {
    if (g.t === SEG_LINE) run += cellContrib(mkPoly([P(g.x0, g.y0), P(g.x1, g.y1)]));
    else if (g.t === SEG_QUAD)
      run += cellContrib(mkPoly([P(g.x0, g.y0), P(g.cx, g.cy), P(g.x1, g.y1)]));
    else if (g.t === SEG_CUBIC)
      run += cellContrib(mkPoly([P(g.x0, g.y0), P(g.c1x, g.c1y), P(g.c2x, g.c2y), P(g.x1, g.y1)]));
    else {
      const A = mkArc(g, P, Pd),
        e0 = A.ev(0),
        e1 = A.ev(1);
      run +=
        cellContrib(mkPoly([P(g.x0, g.y0), e0])) +
        cellContrib(A) +
        cellContrib(mkPoly([e1, P(g.x1, g.y1)]));
    }
  }
  if (evenOdd) {
    let m = run % 2;
    if (m < 0) m += 2;
    return m <= 1 ? m : 2 - m;
  }
  return Math.min(Math.abs(run), 1);
}
