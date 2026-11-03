// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Real polynomial roots for geometric intersections and closest-point queries.
// Quadratic/cubic/quartic solvers accept the full real line; the general solver
// uses derivative brackets on the unit interval.

const EPS = 1e-9;

// Compare degeneracy against the coefficient scale, including the zero polynomial.
function polyScale(...c) {
  let m = 0;
  for (let i = 0; i < c.length; i++) {
    const v = Math.abs(c[i]);
    if (v > m) m = v;
  }
  return m;
}

/** Solve A·t² + B·t + C = 0. Returns 0, 1, or 2 real roots.
 *  Numerically stable via Citardauq pivot. */
export function solveQuadratic(A, B, C) {
  const m = polyScale(A, B, C),
    m2 = m * m;
  if (Math.abs(A) <= EPS * m) {
    if (Math.abs(B) <= EPS * m) return [];
    return [-C / B];
  }
  const disc = B * B - 4 * A * C; // degree 2 in the coefficients
  if (disc < -EPS * m2) return [];
  if (disc < EPS * m2) return [-B / (2 * A)];
  const sd = Math.sqrt(disc);
  const q = -0.5 * (B + Math.sign(B || 1) * sd);
  const r1 = q / A;
  const r2 = Math.abs(q) < EPS * m ? r1 : C / q;
  return [r1, r2];
}

/** Solve A·t³ + B·t² + C·t + D = 0. Up to 3 real roots, via Cardano
 *  with the trigonometric branch for the 3-real-roots case. */
export function solveCubic(A, B, C, D) {
  // Only the leading test needs the scale: p, q, r below are RATIOS of coefficients, so the
  // depressed cubic and its discriminant are already scale-free.
  if (Math.abs(A) <= EPS * polyScale(A, B, C, D)) return solveQuadratic(B, C, D);
  const p = B / A,
    q = C / A,
    r = D / A;
  // Depress: t = u - p/3 → u³ + Pu + Q = 0
  const P = q - (p * p) / 3;
  const Q = (2 * p * p * p) / 27 - (p * q) / 3 + r;
  const half = Q * 0.5;
  const cube = (P * P * P) / 27;
  const disc = half * half + cube;
  const discError = 16 * Number.EPSILON * (half * half + Math.abs(cube));
  const shift = p / 3;
  if (disc > discError) {
    const sd = Math.sqrt(disc);
    const u = Math.cbrt(-half + sd);
    const v = Math.cbrt(-half - sd);
    return [u + v - shift];
  } else if (disc < -discError) {
    const rho = Math.sqrt((-P * P * P) / 27);
    const theta = Math.acos(Math.max(-1, Math.min(1, -half / rho)));
    const t = 2 * Math.cbrt(rho);
    return [
      t * Math.cos(theta / 3) - shift,
      t * Math.cos((theta + 2 * Math.PI) / 3) - shift,
      t * Math.cos((theta + 4 * Math.PI) / 3) - shift,
    ];
  } else {
    const u = Math.cbrt(-half);
    return [2 * u - shift, -u - shift];
  }
}

/** Roots of A·t³ + B·t² + C·t + D = 0 in **[0, 1]**, via Yuksel 2022
 *  (critical-point split + interval-clamped Newton). Preferred over
 *  `solveCubic` (Cardano) wherever the parameter is range-bounded and
 *  `disc≈0` robustness matters, since Cardano's depressed-cubic branch
 *  loses precision near a double root. */
export function solveCubicInUnit(A, B, C, D) {
  const out = [];
  const m = polyScale(A, B, C, D);
  // Degenerate (not a cubic) → quadratic in [0, 1].
  if (Math.abs(A) <= EPS * m) {
    if (Math.abs(B) <= EPS * m) {
      if (Math.abs(C) > EPS * m) {
        const t = -D / C;
        if (t >= 0 && t <= 1) out.push(t);
      }
      return out;
    }
    const dq = C * C - 4 * B * D;
    if (dq < 0) return out;
    const sq = Math.sqrt(dq);
    const t1 = (-C - sq) / (2 * B),
      t2 = (-C + sq) / (2 * B);
    if (t1 >= 0 && t1 <= 1) out.push(t1);
    if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-6) out.push(t2);
    return out;
  }
  const f = (t) => ((A * t + B) * t + C) * t + D;
  const fp = (t) => (3 * A * t + 2 * B) * t + C; // derivative
  // Split [0,1] at the cubic's critical points (3A·t² + 2B·t + C = 0).
  let s1 = -1,
    s2 = -1;
  const dq = 2 * B * (2 * B) - 4 * (3 * A) * C;
  if (dq >= 0) {
    const sq = Math.sqrt(dq);
    let r1 = (-2 * B - sq) / (2 * 3 * A),
      r2 = (-2 * B + sq) / (2 * 3 * A);
    if (r1 > r2) {
      const tmp = r1;
      r1 = r2;
      r2 = tmp;
    }
    if (r1 > 0 && r1 < 1) s1 = r1;
    if (r2 > 0 && r2 < 1) {
      if (s1 < 0) s1 = r2;
      else s2 = r2;
    }
  }
  const bds = [0];
  if (s1 > 0) bds.push(s1);
  if (s2 > 0) bds.push(s2);
  bds.push(1);
  for (let i = 0; i + 1 < bds.length; i++) {
    const lo = bds[i],
      hi = bds[i + 1];
    if (f(lo) > 0 === f(hi) > 0) continue; // no sign change ⇒ no root here
    let xr = 0.5 * (lo + hi); // interval-clamped Newton, ≤8 iters
    for (let k = 0; k < 8; k++) {
      const fdy = fp(xr); // degree 1 in the coefficients, like f itself
      if (Math.abs(fdy) < 1e-12 * m) break;
      const nx = Math.min(hi, Math.max(lo, xr - f(xr) / fdy));
      if (nx === xr) break; // fixed point reached — the remaining iterations recompute
      xr = nx; //   the identical xr, so this early-out is byte-for-byte exact
    }
    out.push(xr);
  }
  return out;
}

/*
Solve A·t⁴ + B·t³ + C·t² + D·t + E = 0 for its real roots (up to 4).
 *
 *
 *  So, as solveCubicInUnit does in [0, 1]: the critical points (closed-form roots of the derivative
 *  cubic, polished) split the line, out to the Cauchy bound past which there are no roots, into
 *  pieces on which the quartic is monotone. A sign change across a piece brackets exactly one
 *  simple root, closed by Newton that falls back to bisection whenever a step leaves the bracket. A
 *  root with no sign change is a multiple root, which sits at a critical point, and is taken where
 *  the quartic there is indistinguishable from zero in the arithmetic that evaluated it. Scale-free:
 *  everything after the monic step is a ratio of the coefficients.
 */
export function solveQuartic(A, B, C, D, E) {
  if (Math.abs(A) <= EPS * polyScale(A, B, C, D, E)) return solveCubic(B, C, D, E);
  const b = B / A,
    c = C / A,
    d = D / A,
    e = E / A;
  const f = (t) => (((t + b) * t + c) * t + d) * t + e;
  const f1 = (t) => ((4 * t + 3 * b) * t + 2 * c) * t + d;
  const f2 = (t) => (12 * t + 6 * b) * t + 2 * c;
  // |f(t)|'s rounding bound: the Horner sum of the magnitudes, times a few ulps per operation.
  const fErr = (t) => {
    const a = Math.abs(t);
    return (
      64 *
      Number.EPSILON *
      ((((a + Math.abs(b)) * a + Math.abs(c)) * a + Math.abs(d)) * a + Math.abs(e))
    );
  };
  const R = 1 + Math.max(Math.abs(b), Math.abs(c), Math.abs(d), Math.abs(e));
  const crit = [];
  for (let t of solveCubic(4, 3 * b, 2 * c, d)) {
    if (!Number.isFinite(t)) continue;
    for (let k = 0; k < 8; k++) {
      const g = f2(t);
      if (!(Math.abs(g) > 0)) break;
      const nt = t - f1(t) / g;
      if (!Number.isFinite(nt) || nt === t) break;
      t = nt;
    }
    if (t > -R && t < R) crit.push(t);
  }
  crit.sort((u, v) => u - v);
  const bds = [-R, ...crit, R];
  const out = [];
  for (let i = 0; i + 1 < bds.length; i++) {
    let lo = bds[i],
      hi = bds[i + 1],
      flo = f(lo);
    const fhi = f(hi);
    if (!(hi > lo) || flo === 0 || fhi === 0 || flo < 0 === fhi < 0) continue;
    let t = 0.5 * (lo + hi);
    for (let k = 0; k < 200; k++) {
      const ft = f(t);
      if (ft === 0) break;
      if (ft < 0 === flo < 0) {
        lo = t;
        flo = ft;
      } else hi = t;
      const g = f1(t);
      let nt = g !== 0 ? t - ft / g : NaN;
      if (!(nt > lo && nt < hi)) nt = 0.5 * (lo + hi);
      if (nt === t || !(hi - lo > 2 * Number.EPSILON * Math.max(1, Math.abs(t)))) break;
      t = nt;
    }
    out.push(t);
  }
  for (const t of crit) if (Math.abs(f(t)) <= fErr(t)) out.push(t);
  out.sort((u, v) => u - v);
  // A multiple root can also be closed from the pieces beside it; one root per point.
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-12 * Math.max(1, Math.abs(t)));
}

/** Sorted distinct real roots in [0, 1], with ascending power coefficients.
 * Derivative roots divide the domain into monotone intervals and expose
 * even-multiplicity roots. Refinement terminates on parameter width.
 */
export function solvePolyInUnitInterval(coeffs, tol = 1e-10) {
  let n = coeffs.length - 1;
  while (n >= 0 && coeffs[n] === 0) n--;
  if (n <= 0) return [];
  let magnitude = 0;
  for (let i = 0; i <= n; i++) {
    if (!Number.isFinite(coeffs[i])) return [];
    magnitude = Math.max(magnitude, Math.abs(coeffs[i]));
  }
  // A power-of-two scale preserves coefficient ratios without rounding them.
  const scale = 2 ** Math.min(1023, Math.max(-1074, Math.floor(Math.log2(magnitude))));
  const power = coeffs.slice(0, n + 1).map((c) => c / scale);
  return intervalRoots(
    power,
    Math.max(Number.EPSILON, Math.min(1e-10, Number.isFinite(tol) && tol > 0 ? tol : 1e-10)),
  );
}

function intervalRoots(power, tol) {
  const n = power.length - 1;
  if (n === 1) {
    const t = -power[0] / power[1];
    return t >= 0 && t <= 1 ? [t === 0 ? 0 : t] : [];
  }
  const derivative = new Array(n);
  let magnitude = Math.abs(power[0]),
    derivativeMagnitude = 0,
    curvature = 0;
  for (let i = 1; i <= n; i++) {
    derivative[i - 1] = i * power[i];
    magnitude += Math.abs(power[i]);
    derivativeMagnitude += Math.abs(derivative[i - 1]);
    curvature += i * (i - 1) * Math.abs(power[i]);
  }
  const roundoff = 4 * power.length * Number.EPSILON * magnitude;
  const derivativeRoundoff = 4 * derivative.length * Number.EPSILON * derivativeMagnitude;
  const bounds = [0, ...intervalRoots(derivative, Number.EPSILON).filter((t) => t > 0 && t < 1), 1];
  const values = bounds.map((t) => intervalValue(power, t, roundoff));
  const atRoot = bounds.map((t, i) => Math.abs(values[i]) <= intervalError(power, t));
  const roots = [];
  for (let i = 0; i < bounds.length; i++) if (atRoot[i]) roots.push(bounds[i]);
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (atRoot[i] || atRoot[i + 1] || values[i] < 0 === values[i + 1] < 0) continue;
    let lo = bounds[i],
      hi = bounds[i + 1],
      flo = values[i],
      t = (lo + hi) * 0.5,
      previousValue = Infinity;
    for (let k = 0; k < 200; k++) {
      const value = intervalValue(power, t, roundoff);
      if (value === 0) {
        lo = hi = t;
        break;
      }
      if (value < 0 === flo < 0) {
        lo = t;
        flo = value;
      } else hi = t;
      if (hi - lo <= tol) break;
      const slope = intervalValue(derivative, t, derivativeRoundoff);
      const step = slope !== 0 ? value / slope : NaN;
      let next = t - step;
      // The coefficient sum bounds |p''| on [0,1]. When the Newton
      // correction and its curvature bound are small, the nearby root is
      // within twice the correction; a narrow bracket is unnecessary.
      if (
        next >= lo &&
        next <= hi &&
        Math.abs(step) <= tol * 0.25 &&
        curvature * Math.abs(step) <= 0.25 * Math.abs(slope)
      ) {
        lo = hi = next;
        break;
      }
      // Accept Newton near a bracket end while its residual falls rapidly.
      // Otherwise bisect; rejecting every small step would prevent convergence.
      const absoluteValue = Math.abs(value);
      if (!(next > lo && next < hi) || absoluteValue > previousValue * 0.5) next = (lo + hi) * 0.5;
      previousValue = absoluteValue;
      if (next === t) break;
      t = next;
    }
    for (let k = 0; k < 64 && hi - lo > tol; k++) {
      const mid = (lo + hi) * 0.5,
        value = intervalValue(power, mid, roundoff);
      if (value === 0) {
        lo = hi = mid;
        break;
      }
      if (value < 0 === flo < 0) {
        lo = mid;
        flo = value;
      } else hi = mid;
    }
    roots.push((lo + hi) * 0.5);
  }
  roots.sort((a, b) => a - b);
  return roots.filter((t, i) => i === 0 || t - roots[i - 1] > 4 * Number.EPSILON);
}

// Compensated Horner evaluation preserves the sign near repeated roots.
// Coefficients are normalized and 0 <= t <= 1, so Dekker splitting cannot overflow.
function intervalValue(power, t, roundoff) {
  let ordinary = power[power.length - 1];
  for (let i = power.length - 2; i >= 0; i--) ordinary = ordinary * t + power[i];
  if (Math.abs(ordinary) > roundoff) return ordinary;
  let value = power[power.length - 1],
    correction = 0;
  const splitter = 134217729;
  const ts = splitter * t,
    th = ts - (ts - t),
    tl = t - th;
  for (let i = power.length - 2; i >= 0; i--) {
    const product = value * t;
    const vs = splitter * value,
      vh = vs - (vs - value),
      vl = value - vh;
    const productError = vh * th - product + vh * tl + vl * th + vl * tl;
    const sum = product + power[i],
      z = sum - product;
    const sumError = product - (sum - z) + (power[i] - z);
    correction = correction * t + (productError + sumError);
    value = sum;
  }
  return value + correction;
}

function intervalError(power, t) {
  let magnitude = Math.abs(power[power.length - 1]);
  for (let i = power.length - 2; i >= 0; i--) magnitude = magnitude * t + Math.abs(power[i]);
  return 32 * power.length * Number.EPSILON * Number.EPSILON * magnitude;
}
