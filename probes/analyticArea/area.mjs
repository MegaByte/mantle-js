// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Experimental CPU reference, not a renderer or GPU cost model.
// Green's theorem: integral_P winding = integral_boundary clamp(x,0,1) [0<y<1] dy.
// Coverage equals this integral only for a boundary oriented with the filled region
// on its left, whose winding is 0/1. Resolve the fill rule before calling this.
// Independent derivation; no code from the Manson/Schaefer implementation.

const choose = (n, k) => {
  let v = 1;
  for (let i = 1; i <= k; i++) v *= (n + 1 - i) / i;
  return v;
};
const evalPoly = (p, t) => p.reduceRight((v, c) => v * t + c, 0);
const power = (b) => {
  if (b.length === 2) return [b[0], b[1] - b[0]];
  if (b.length === 3) return [b[0], 2 * (b[1] - b[0]), b[0] - 2 * b[1] + b[2]];
  return [b[0], 3 * (b[1] - b[0]), 3 * (b[0] - 2 * b[1] + b[2]), b[3] - b[0] + 3 * (b[1] - b[2])];
};

// Derivative partitions isolate crossings without Cardano cancellation. The long
// bisection is deliberately a float64 reference, NOT a proposed shader loop.
export function roots01(coeff) {
  const p = coeff.slice();
  while (p.length > 1 && p.at(-1) === 0) p.pop();
  if (p.length < 2) return [];
  if (p.length === 2) {
    const t = -p[0] / p[1];
    return t > 0 && t < 1 ? [t] : [];
  }
  const critical = roots01(p.slice(1).map((x, i) => x * (i + 1)));
  const cuts = [0, ...critical, 1],
    roots = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    let lo = cuts[i],
      hi = cuts[i + 1],
      flo = evalPoly(p, lo),
      fhi = evalPoly(p, hi);
    if (lo > 0 && flo === 0) roots.push(lo);
    if (flo === 0 || fhi === 0 || flo < 0 === fhi < 0) continue;
    for (let k = 0; k < 60; k++) {
      const m = (lo + hi) / 2,
        f = evalPoly(p, m);
      if (m === lo || m === hi || f === 0) {
        lo = hi = m;
        break;
      }
      if (f < 0 === flo < 0) {
        lo = m;
        flo = f;
      } else hi = m;
    }
    roots.push((lo + hi) / 2);
  }
  // Tangencies do not switch the integration branch; splitting them is harmless.
  return [...new Set([...roots, ...critical.filter((t) => evalPoly(p, t) === 0)])].sort(
    (a, b) => a - b,
  );
}

function blossom(P, ts) {
  let q = P.map((p) => p.slice());
  for (const t of ts) q = q.slice(0, -1).map((p, i) => p.map((x, k) => x + t * (q[i + 1][k] - x)));
  return q[0];
}
function slice(P, a, b) {
  const n = P.length - 1;
  return P.map((_, i) => blossom(P, [...Array(n - i).fill(a), ...Array(i).fill(b)]));
}
function polynomialIntegral(P, a, b) {
  const Q = slice(P, a, b),
    n = Q.length - 1;
  let sum = 0;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < n; j++) {
      sum +=
        (Q[i][0] * (Q[j + 1][1] - Q[j][1]) * choose(n, i) * choose(n - 1, j)) /
        (2 * choose(2 * n - 1, i + j));
    }
  return sum;
}

// Native elliptical arc, including shear/reflection: c + u cos(theta) + v sin(theta).
// Rational quadratics from SVG arcs (0<w<1) have this exact geometry. A w=1
// segment is polynomial. Hyperbolic rquads and arbitrary rational cubics are NOT supported.
export function ellipseFromRQuad(s) {
  const w = s.w,
    [A, M, B] = s.P;
  if (!(w > 0 && w < 1)) throw new Error('Expected an elliptical rational quadratic, 0 < w < 1');
  const h = Math.acos(w),
    sh = Math.sqrt((1 - w) * (1 + w));
  const e = A.map((x, k) => (x + B[k]) / 2);
  const u = e.map((x, k) => (w * (M[k] - x)) / ((1 - w) * (1 + w)));
  return {
    t: 'arc',
    c: e.map((x, k) => x - w * u[k]),
    u,
    v: A.map((x, k) => (B[k] - x) / (2 * sh)),
    a: -h,
    b: h,
  };
}
export function point(s, t) {
  if (s.t === 'arc') {
    const q = s.a + (s.b - s.a) * t;
    return s.c.map((x, k) => x + s.u[k] * Math.cos(q) + s.v[k] * Math.sin(q));
  }
  if (s.t === 'rquad' && s.w !== 1) {
    const u = 1 - t,
      weights = [u * u, 2 * s.w * t * u, t * t],
      d = weights.reduce((a, b) => a + b);
    return [0, 1].map((k) => weights.reduce((v, w, i) => v + w * s.P[i][k], 0) / d);
  }
  return blossom(s.P, Array(s.P.length - 1).fill(t));
}
function arcRoots(s, axis, edge) {
  const A = s.u[axis],
    B = s.v[axis],
    R = Math.hypot(A, B);
  if (R === 0) return [];
  const v = (edge - s.c[axis]) / R;
  if (v < -1 || v > 1) return [];
  const d = Math.atan2(B, A),
    a = Math.acos(v),
    out = [],
    tau = 2 * Math.PI;
  const lo = Math.min(s.a, s.b),
    hi = Math.max(s.a, s.b);
  for (const base of [d - a, d + a]) {
    for (let k = Math.ceil((lo - base) / tau); k <= Math.floor((hi - base) / tau); k++) {
      const t = (base + tau * k - s.a) / (s.b - s.a);
      if (t > 0 && t < 1) out.push(t);
    }
  }
  return out;
}
function arcIntegral(s, a, b) {
  const theta0 = s.a + (s.b - s.a) * a,
    theta1 = s.a + (s.b - s.a) * b;
  const m = (theta0 + theta1) / 2,
    h = (theta1 - theta0) / 2;
  const cm = Math.cos(m),
    sm = Math.sin(m),
    sh = Math.sin(h);
  const ax = s.u[0] * cm + s.v[0] * sm,
    bx = -s.u[0] * sm + s.v[0] * cm;
  const ay = s.u[1] * cm + s.v[1] * sm,
    by = -s.u[1] * sm + s.v[1] * cm;
  // Stable definite integral around the interval midpoint. Taylor evaluation here
  // only avoids cancellation in trig differences; it does not flatten the arc.
  const h2 = h * h;
  const p =
    Math.abs(h) < 0.01
      ? h * h2 * (-1 / 3 + h2 * (7 / 60 - (h2 * 31) / 2520))
      : h + Math.sin(2 * h) / 2 - 2 * sh;
  const q =
    Math.abs(h) < 0.01
      ? h * h2 * (2 / 3 + h2 * (-2 / 15 + (h2 * 4) / 315))
      : h - Math.sin(2 * h) / 2;
  return (s.c[0] + ax) * (2 * by * sh) + ax * by * p - bx * ay * q;
}

export function localSegment(s, x, y, px = 1) {
  const p = (q) => [(q[0] - x) / px, (q[1] - y) / px];
  if (s.t === 'arc')
    return { ...s, c: p(s.c), u: s.u.map((v) => v / px), v: s.v.map((v) => v / px) };
  const q = { ...s, P: s.P.map(p) };
  return s.t === 'rquad' && s.w !== 1 ? ellipseFromRQuad(q) : q;
}

export function segmentArea(s, x, y, px = 1, stats = null) {
  const q = localSegment(s, x, y, px),
    arc = q.t === 'arc';
  // Positive-weight curves stay in their control hull. Native arcs use an
  // intentionally loose affine-ellipse box; a production tile builder needs tight spans.
  const bounds = arc
    ? [0, 1].map((k) => [q.c[k] - Math.hypot(q.u[k], q.v[k]), q.c[k] + Math.hypot(q.u[k], q.v[k])])
    : [0, 1].map((k) => [Math.min(...q.P.map((p) => p[k])), Math.max(...q.P.map((p) => p[k]))]);
  if (bounds[1][1] <= 0 || bounds[1][0] >= 1 || bounds[0][1] <= 0) return 0;
  const cuts = [0, 1];
  for (let axis = 0; axis < 2; axis++)
    for (const edge of [0, 1]) {
      if (edge < bounds[axis][0] || edge > bounds[axis][1]) continue;
      if (stats) stats[arc ? 'arcEquations' : 'polynomialEquations']++;
      cuts.push(
        ...(arc ? arcRoots(q, axis, edge) : roots01(power(q.P.map((p) => p[axis] - edge)))),
      );
    }
  cuts.sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i],
      b = cuts[i + 1];
    if (a === b) continue;
    const mid = point(q, (a + b) / 2);
    if (mid[1] <= 0 || mid[1] >= 1 || mid[0] <= 0) continue;
    if (stats) stats.intervals++;
    if (mid[0] >= 1) total += point(q, b)[1] - point(q, a)[1];
    else total += arc ? arcIntegral(q, a, b) : polynomialIntegral(q.P, a, b);
  }
  return total;
}

// No abs/clamp: that would hide invalid topology, multiple winding, and numeric errors.
// A production caller must verify/certify its boundary and only clamp final roundoff.
export function boundaryArea(boundary, x, y, px = 1, stats = null) {
  let sum = 0,
    correction = 0;
  for (const s of boundary) {
    const a = segmentArea(s, x, y, px, stats) - correction,
      next = sum + a;
    correction = next - sum - a;
    sum = next;
  }
  return sum;
}
