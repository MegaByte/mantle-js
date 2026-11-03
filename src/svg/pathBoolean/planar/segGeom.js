// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// segGeom.js — the geometry of one DCEL edge that the planar graph needs exactly: a point on it,
// its signed area term, and where it runs near one of its ends.
//
// Every function takes a segment (LINE / QUAD / CUBIC / ARC) and a direction: dir > 0 walks it
// from its start to its end, dir < 0 from its end to its start, which is how a half-edge sees it.

import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../../segment.js';

/** Control points in the walking direction (Bezier kinds only). */
function ctrl(s, dir) {
  const P =
    s.type === SEG_LINE
      ? [s.p1, s.p2]
      : s.type === SEG_QUAD
        ? [s.p1, s.p2, s.p3]
        : [s.p1, s.p2, s.p3, s.p4];
  return dir < 0 ? P.slice().reverse() : P;
}

/** Point at parameter t in [0,1] of the walked segment. */
export function segPoint(s, t, dir = 1) {
  if (s.type === SEG_ARC) {
    const th0 = dir < 0 ? s.theta_end : s.theta_start,
      th1 = dir < 0 ? s.theta_start : s.theta_end;
    const th = th0 + (th1 - th0) * t,
      cp = Math.cos(s.phi || 0),
      sp = Math.sin(s.phi || 0);
    const x = s.rx * Math.cos(th),
      y = s.ry * Math.sin(th);
    return [s.cx + x * cp - y * sp, s.cy + x * sp + y * cp];
  }
  let P = ctrl(s, dir).map((p) => [p[0], p[1]]);
  for (let n = P.length - 1; n > 0; n--)
    for (let i = 0; i < n; i++)
      P[i] = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t];
  return P[0];
}

/** ½∮(x dy − y dx) along the walked segment, with coordinates taken relative to (ox, oy). Summed
 *  over a closed cycle this is the cycle's signed area exactly: closed form per kind, no chord. The
 *  origin is the caller's, so the products carry the cycle's own extent rather than its offset. */
export function segAreaTerm(s, dir, ox, oy) {
  if (s.type === SEG_ARC) {
    // P(θ) = C + R(θ): ∫cross(P, P')dθ = cross(C, R(θ1) − R(θ0)) + rx·ry·(θ1 − θ0).
    const th0 = dir < 0 ? s.theta_end : s.theta_start,
      th1 = dir < 0 ? s.theta_start : s.theta_end;
    const cp = Math.cos(s.phi || 0),
      sp = Math.sin(s.phi || 0);
    const R = (th) => {
      const x = s.rx * Math.cos(th),
        y = s.ry * Math.sin(th);
      return [x * cp - y * sp, x * sp + y * cp];
    };
    const r0 = R(th0),
      r1 = R(th1),
      cx = s.cx - ox,
      cy = s.cy - oy;
    const dx = r1[0] - r0[0],
      dy = r1[1] - r0[1];
    return 0.5 * (cx * dy - cy * dx + s.rx * s.ry * (th1 - th0));
  }
  const P = ctrl(s, dir),
    n = P.length - 1;
  const bx = pow(
      P.map((p) => p[0] - ox),
      n,
    ),
    by = pow(
      P.map((p) => p[1] - oy),
      n,
    );
  let A = 0;
  for (let i = 0; i <= n; i++)
    for (let j = 1; j <= n; j++) A += (bx[i] * j * by[j] - by[i] * j * bx[j]) / (i + j);
  return 0.5 * A;
}
function pow(b, n) {
  const C = (a, k) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (a - i)) / (i + 1);
    return r;
  };
  const out = [];
  for (let k = 0; k <= n; k++) {
    let acc = 0;
    for (let i = 0; i <= k; i++) acc += ((k - i) % 2 ? -1 : 1) * C(k, i) * b[i];
    out.push(C(n, k) * acc);
  }
  return out;
}

/** How far along the walked segment its distance from its own start is PROVABLY increasing, as a
 *  parameter in (0, 1], and the distance reached there.
 *
 *  Bezier: g(t) = (P(t) − P0)·P'(t) is a polynomial with g(0) = 0; below its lowest nonzero power k,
 *  g(t) = t^k (g_k + Σ_{j>k} g_j t^{j−k}) is positive while t · Σ|g_j| < g_k (t <= 1), which is a
 *  bound, not a root search. Arc: in the arc's own frame every derivative has length <= M = max(rx, ry)
 *  and the tangent has length >= m = min(rx, ry), so g > 0 for a turn below m² / (2M²). */
export function monotoneReach(s, dir) {
  if (s.type === SEG_ARC) {
    const sweep = Math.abs(s.theta_end - s.theta_start),
      M = Math.max(s.rx, s.ry),
      m = Math.min(s.rx, s.ry);
    const t = Math.min(1, (m * m) / (2 * M * M) / (sweep || 1));
    const a = segPoint(s, 0, dir),
      b = segPoint(s, t, dir);
    return { t, r: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  }
  const P = ctrl(s, dir),
    n = P.length - 1;
  const cx = pow(
      P.map((p) => p[0]),
      n,
    ),
    cy = pow(
      P.map((p) => p[1]),
      n,
    );
  const c = [1, 2, 3].map((k) => [k <= n ? cx[k] : 0, k <= n ? cy[k] : 0]);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const g = [
    0,
    dot(c[0], c[0]),
    3 * dot(c[0], c[1]),
    4 * dot(c[0], c[2]) + 2 * dot(c[1], c[1]),
    5 * dot(c[1], c[2]),
    3 * dot(c[2], c[2]),
  ];
  const scale = g.reduce((a, v) => a + Math.abs(v), 0);
  let k = 1;
  while (k < 5 && !(Math.abs(g[k]) > 1e-12 * scale)) k++;
  let tail = 0;
  for (let j = k + 1; j <= 5; j++) tail += Math.abs(g[j]);
  const t = g[k] > 0 ? (tail > 0 ? Math.min(1, g[k] / tail) : 1) : 0;
  const b = segPoint(s, t, dir);
  return { t, r: Math.hypot(b[0] - P[0][0], b[1] - P[0][1]) };
}

/** The point where the walked segment first reaches distance rho from (vx, vy), searched on [0, t]
 *  where the distance increases (monotoneReach). A root of a polynomial on a bracket it is monotone
 *  on, so bisection closes it to the precision of the arithmetic. */
export function pointAtDistance(s, dir, vx, vy, rho, t) {
  let lo = 0,
    hi = t;
  const d2 = (u) => {
    const p = segPoint(s, u, dir);
    return (p[0] - vx) ** 2 + (p[1] - vy) ** 2;
  };
  const r2 = rho * rho;
  for (let it = 0; it < 64 && hi - lo > 0; it++) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;
    if (d2(mid) < r2) lo = mid;
    else hi = mid;
  }
  return segPoint(s, hi, dir);
}
