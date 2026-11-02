// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The exact box coverage of ONE pixel in f64, the reference for probes/fillperf/kernelIdentity.mjs --exact.
//
// The outline is mapped into the pixel's unit cell; every segment is cut into x- and y-monotone pieces at the
// roots of its derivative, each piece is bisected in f64 at x = 0, 1 and y = 0, 1, and the pieces inside
// 0 <= y <= 1 add clamp(1 - x, 0, 1) dy -- Gauss-Legendre 16 on the ones inside the cell, which is exact for a
// cubic's degree-5 x y' and converged for an arc piece inside one quadrant. The signed sum is resolved like the
// kernels': min(|w|, 1) nonzero, the triangle wave even-odd. An arc is its (cx, cy, rx, ry, rotation, th0..th1)
// definition, joined to its stored endpoints by lines so the contour closes exactly at any zoom.
//
// A reference that looks for a curve's cell crossings over x(0), x(0.5), x(1) only, and shifts any edge that enters
// its grid from above, is off on 69 of 300 random curved cells, by up to a whole pixel (the tiger cell that reads 0.98863 there is
// 0.99990, and a 300^2 signed-winding supersample agrees); renderer/signedAreaCoverage.js coverageAtPixel agrees with this to 1e-13.
// This one agrees with that supersample to 2.9e-4 (its own resolution) on the same 300 cells and to 8e-5 on
// 50 rotated ellipses.
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
  // a t^2 + b t + c
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
// seg: {ev(t)->[x,y], d(t)->[dx,dy], crit: t's where x' or y' = 0}
function mkPoly(pts) {
  const n = pts.length - 1;
  const ev = (t) => {
    let p = pts.map((q) => q.slice());
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
    let p = D.map((q) => q.slice());
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
  return { ev, dv, crit };
}
function mkArc(g, P, Pd) {
  // P maps em -> cell, Pd maps an em vector -> cell vector
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
      const th = phi + k * Math.PI,
        t = (th - g.th0) / T;
      if (t > 0 && t < 1) crit.push(t);
    }
  };
  add(Math.atan2(-g.ry * g.sp, g.rx * g.cp));
  add(Math.atan2(g.ry * g.cp, g.rx * g.sp));
  return { ev, dv, crit };
}
function contrib(s) {
  // signed sum of g(x) dy over the parts of s inside 0 <= y <= 1, g = clamp(1 - x, 0, 1)
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
export function cellCoverage(segs, c, ePx, eo) {
  const P = (x, y) => [(x - c[0]) / ePx[0] + 0.5, (y - c[1]) / ePx[1] + 0.5];
  const Pd = (x, y) => [x / ePx[0], y / ePx[1]];
  let run = 0;
  for (const g of segs) {
    if (g.t === 0) run += contrib(mkPoly([P(g.x0, g.y0), P(g.x1, g.y1)]));
    else if (g.t === 1) run += contrib(mkPoly([P(g.x0, g.y0), P(g.cx, g.cy), P(g.x1, g.y1)]));
    else if (g.t === 2)
      run += contrib(mkPoly([P(g.x0, g.y0), P(g.c1x, g.c1y), P(g.c2x, g.c2y), P(g.x1, g.y1)]));
    else {
      const A = mkArc(g, P, Pd);
      const e0 = A.ev(0),
        e1 = A.ev(1);
      run +=
        contrib(mkPoly([P(g.x0, g.y0), e0])) + contrib(A) + contrib(mkPoly([e1, P(g.x1, g.y1)]));
    }
  }
  if (eo) {
    let m = run % 2;
    if (m < 0) m += 2;
    return m <= 1 ? m : 2 - m;
  }
  return Math.min(Math.abs(run), 1);
}

/// The same integral over the pixel of a GENERAL em -> device-pixel linear map M = [[m00, m01], [m10, m11]] (rows; the
/// pixel is the unit box around M (p - c)): a rotated, skewed or mirrored draw's footprint. An affine map sends
/// a Bezier to the Bezier of the mapped control points and an arc to a mapped arc, so the pieces are mapped exactly.
export function cellCoverageMap(segs, c, M, eo) {
  const [[m00, m01], [m10, m11]] = M;
  const P = (x, y) => [
    m00 * (x - c[0]) + m01 * (y - c[1]) + 0.5,
    m10 * (x - c[0]) + m11 * (y - c[1]) + 0.5,
  ];
  const Pd = (x, y) => [m00 * x + m01 * y, m10 * x + m11 * y];
  let run = 0;
  for (const g of segs) {
    if (g.t === 0) run += contrib(mkPoly([P(g.x0, g.y0), P(g.x1, g.y1)]));
    else if (g.t === 1) run += contrib(mkPoly([P(g.x0, g.y0), P(g.cx, g.cy), P(g.x1, g.y1)]));
    else if (g.t === 2)
      run += contrib(mkPoly([P(g.x0, g.y0), P(g.c1x, g.c1y), P(g.c2x, g.c2y), P(g.x1, g.y1)]));
    else {
      // the arc point is C + U cos(th) + V sin(th): U = (cp rx, sp rx), V = (-sp ry, cp ry), each mapped by M
      const T = g.th1 - g.th0,
        U = Pd(g.cp * g.rx, g.sp * g.rx),
        V = Pd(-g.sp * g.ry, g.cp * g.ry),
        C0 = P(g.cx, g.cy);
      const A = {
        ev: (t) => {
          const th = g.th0 + T * t;
          return [
            C0[0] + U[0] * Math.cos(th) + V[0] * Math.sin(th),
            C0[1] + U[1] * Math.cos(th) + V[1] * Math.sin(th),
          ];
        },
        dv: (t) => {
          const th = g.th0 + T * t;
          return [
            T * (-U[0] * Math.sin(th) + V[0] * Math.cos(th)),
            T * (-U[1] * Math.sin(th) + V[1] * Math.cos(th)),
          ];
        },
        crit: [],
      };
      for (let ax = 0; ax < 2; ax++) {
        const phi = Math.atan2(V[ax], U[ax]);
        for (let k = -4; k <= 4; k++) {
          const t = (phi + k * Math.PI - g.th0) / T;
          if (t > 0 && t < 1) A.crit.push(t);
        }
      }
      const e0 = A.ev(0),
        e1 = A.ev(1);
      run +=
        contrib(mkPoly([P(g.x0, g.y0), e0])) + contrib(A) + contrib(mkPoly([e1, P(g.x1, g.y1)]));
    }
  }
  if (eo) {
    let m = run % 2;
    if (m < 0) m += 2;
    return m <= 1 ? m : 2 - m;
  }
  return Math.min(Math.abs(run), 1);
}
