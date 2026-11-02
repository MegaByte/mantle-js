// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcPaint.js -- native elliptical arcs for the coverage-normalization certificate (polynomialPaint.js).
//
// An arc record is the center form the importer emits: x(t) = c + R(phi) diag(rx, ry) (cos t, sin t), t from t0 to t1 (either order),
// with its path endpoints p1/p4 stored beside it (they are the neighbors' vertices, and they are what the curve plane encodes).
//
// AREA (exact, closed form). With p = c + M u(t), M = R diag(rx, ry), det M = rx ry:  p x dp = c x M u' dt + rx ry dt, and
// M (u(t1) - u(t0)) = p4 - p1, so the Green integral (x dy - y dx)/2 over the arc is
//     1/2 [ p1 x p4 + rx ry (d - sin d) ] + (terms that cancel around a closed loop),   d = t1 - t0.
// Written as the chord's triangle (the same form every line and Bezier span contributes) plus the SEGMENT between chord and arc,
// rx ry (d - sin d) / 2, which is affine invariant and is the only term that depends on the arc's angles. No subdivision, no
// cancellation at a large origin (the chord term uses translated vertices), and d - sin d is a series below |d| = 1/4.
//
// CERTIFICATE SUPPORT (used only to BOUND a proof, never to accept geometry by sampling):
//   * an arc piece of span <= pi/2 lies inside the triangle (p1, T, p4), T the intersection of its end tangents -- the control
//     polygon of its rational quadratic -- so it plays the role a Bezier's control hull plays in the separating-axis test, and a
//     piece subdivides by bisecting its angle (the pieces trace the identical ellipse; endpoints are the arc's own at the ends);
//   * the hull is padded by 2^-23 (|center| + radius): an arc's stored endpoint and its center form's rebuilt endpoint differ by
//     ~2e-8 of that, below one float32 ulp of the coordinates, and the plane the GPU integrates carries no better;
//   * a crossing of the horizontal ray is solved in closed form (asin on each monotone piece); a ray within 2^-20 of an extreme
//     is ill-conditioned and answers null (the caller declines or tries another point);
//   * whole-ellipse weak nesting (|c'| + sigma_max(M') <= 1 in the outer ellipse's unit frame) certifies that two arcs of different
//     contours cannot properly cross even though they may touch (an inner circle tangent to an outer one).
// Every tolerance is relative to the coordinates (or radii) involved, so the answer is the same from 2^-20 to 2^20 and at any offset.
const EPS = Number.EPSILON;
export const ARC_PAD = 2 ** -23;
const TWO_PI = 2 * Math.PI;

export const arcMag = (a) => Math.max(Math.abs(a.cx), Math.abs(a.cy)) + Math.max(a.rx, a.ry);
export function arcOf(g) {
  const a = {
    cx: g.cx,
    cy: g.cy,
    rx: g.rx,
    ry: g.ry,
    phi: g.phi,
    t0: g.theta_start,
    t1: g.theta_end,
  };
  for (const k in a) if (typeof a[k] !== 'number' || !Number.isFinite(a[k])) return null;
  if (a.rx < 0 || a.ry < 0) return null;
  return a;
}
export function arcPoint(a, t) {
  const cp = Math.cos(a.phi),
    sp = Math.sin(a.phi),
    ct = Math.cos(t),
    st = Math.sin(t);
  return [a.cx + cp * a.rx * ct - sp * a.ry * st, a.cy + sp * a.rx * ct + cp * a.ry * st];
}
// d - sin d, stable for small |d|
function dMinusSin(d) {
  const a = Math.abs(d);
  if (a >= 0.25) return d - Math.sin(d);
  const q = d * d;
  return (
    d *
    q *
    (1 / 6 -
      q * (1 / 120 - q * (1 / 5040 - q * (1 / 362880 - q * (1 / 39916800 - q / 6227020800)))))
  );
}
// the segment between an arc and its chord, signed with the direction of travel (twice the Green contribution beyond the chord)
export const arcBulge = (a) => (a.rx * a.ry * dMinusSin(a.t1 - a.t0)) / 2;

// n equal angular pieces of one arc; the first starts at p1 and the last ends at p4 exactly, and a shared inner vertex is ONE array
export function splitArc(a, p1, p4, n) {
  const out = [],
    step = (a.t1 - a.t0) / n;
  let prev = p1;
  for (let i = 0; i < n; i++) {
    const t0 = a.t0 + step * i,
      t1 = i === n - 1 ? a.t1 : a.t0 + step * (i + 1);
    const next = i === n - 1 ? p4 : arcPoint(a, t1);
    out.push({ arc: { ...a, t0, t1 }, P: [prev, next] });
    prev = next;
  }
  return out;
}
// Control triangle (p1, T, p4) of a piece of span <= pi/2, with the arc and its padding riding on the array
export function arcHull(a, p1, p4) {
  const h = (a.t1 - a.t0) / 2,
    tm = a.t0 + h;
  const m = arcPoint({ ...a, cx: 0, cy: 0 }, tm),
    k = Math.sin(h) * Math.tan(h);
  const T = [(p1[0] + p4[0]) / 2 + m[0] * k, (p1[1] + p4[1]) / 2 + m[1] * k];
  const H = [p1, T, p4];
  H.arc = a;
  H.pad = ARC_PAD * arcMag(a);
  return H;
}
export function splitArcHull(H) {
  const a = H.arc,
    tm = (a.t0 + a.t1) / 2,
    pm = arcPoint(a, tm);
  return [arcHull({ ...a, t1: tm }, H[0], pm), arcHull({ ...a, t0: tm }, pm, H[2])];
}

// Crossings of the ray from p toward +x with one arc, signed like the Bezier cases (+1 upward). null: ill-conditioned or on the curve.
export function arcRayWinding(a, p1, p4, p, fast = false) {
  const cp = Math.cos(a.phi),
    sp = Math.sin(a.phi);
  const A = a.rx * sp,
    B = a.ry * cp,
    Hh = Math.hypot(A, B);
  const hx = Math.hypot(a.rx * cp, a.ry * sp),
    mag = arcMag(a);
  if (
    p[0] > a.cx + hx + 128 * EPS * mag ||
    p[1] < a.cy - Hh - 128 * EPS * mag ||
    p[1] > a.cy + Hh + 128 * EPS * mag
  )
    return 0;
  if (Hh === 0) return 0;
  const psi = Math.atan2(A, B),
    lo = Math.min(a.t0, a.t1),
    hi = Math.max(a.t0, a.t1),
    fwd = a.t1 >= a.t0;
  const yAt = (t) => a.cy + Hh * Math.sin(t + psi);
  const cuts = [lo];
  for (let k = Math.ceil((lo + psi - Math.PI / 2) / Math.PI); ; k++) {
    const t = Math.PI / 2 - psi + k * Math.PI;
    if (t >= hi) break;
    if (t > lo) cuts.push(t);
  }
  cuts.push(hi);
  let w = 0;
  for (let i = 1; i < cuts.length; i++) {
    const l = cuts[i - 1],
      h = cuts[i],
      yl = i === 1 ? (fwd ? p1[1] : p4[1]) : yAt(l),
      yh = i === cuts.length - 1 ? (fwd ? p4[1] : p1[1]) : yAt(h);
    if (!(Math.min(yl, yh) <= p[1] && p[1] < Math.max(yl, yh))) continue;
    let s = (p[1] - a.cy) / Hh;
    if (1 - Math.abs(s) < 2 ** -20) return null;
    s = Math.max(-1, Math.min(1, s));
    const mid = (l + h) / 2,
      al = Math.asin(s),
      base = Math.cos(mid + psi) >= 0 ? al : Math.PI - al;
    const t0 = base - psi,
      t = Math.min(h, Math.max(l, t0 + TWO_PI * Math.round((mid - t0) / TWO_PI)));
    const ct = Math.cos(t),
      st = Math.sin(t),
      x = a.cx + cp * a.rx * ct - sp * a.ry * st;
    if (Math.abs(x - p[0]) <= 128 * EPS * (Math.abs(x) + Math.abs(p[0]) + mag)) return null;
    if (x > p[0]) w += yh > yl === fwd ? 1 : -1;
  }
  return w;
}

// Does the closed ellipse A lie inside the closed ellipse B (touching allowed)? Sufficient, conservative, and exact for similar
// ellipses: in B's unit frame, every point of A is within |c'| + sigma_max(M') of the origin.
function inside(A, B) {
  const cb = Math.cos(B.phi),
    sb = Math.sin(B.phi),
    ca = Math.cos(A.phi),
    sa = Math.sin(A.phi);
  const inv = (x, y) => [(cb * x + sb * y) / B.rx, (-sb * x + cb * y) / B.ry];
  const c = inv(A.cx - B.cx, A.cy - B.cy),
    c1 = inv(ca * A.rx, sa * A.rx),
    c2 = inv(-sa * A.ry, ca * A.ry);
  const a = c1[0],
    b = c2[0],
    cc = c1[1],
    d = c2[1];
  const smax = 0.5 * (Math.hypot(a + d, cc - b) + Math.hypot(a - d, cc + b));
  const tol = 1e-10 + (64 * EPS * (arcMag(A) + arcMag(B))) / Math.min(B.rx, B.ry);
  return Math.hypot(c[0], c[1]) + smax <= 1 + tol;
}
// 'in' (A inside B, not the same ellipse), 'out' (B inside A), or null (crossing, same, or not certifiable)
export function ellipseNesting(A, B) {
  if (!(A.rx > 0 && A.ry > 0 && B.rx > 0 && B.ry > 0)) return null;
  if (
    Math.max(A.rx, A.ry) / Math.min(A.rx, A.ry) > 1e3 ||
    Math.max(B.rx, B.ry) / Math.min(B.rx, B.ry) > 1e3
  )
    return null;
  const ab = inside(A, B),
    ba = inside(B, A);
  return ab && ba ? null : ab ? 'in' : ba ? 'out' : null;
}
