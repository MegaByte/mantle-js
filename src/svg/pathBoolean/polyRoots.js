// polyRoots.js — closed-form polynomial root finders used by the
// intersection kernels (quadratic via Citardauq, cubic via Cardano,
// quartic via Ferrari). Higher-degree polynomials (degree 5+) need
// iterative methods, handled in their respective kernels via
// Bezier clipping.
//
// All solvers operate in REAL numbers only — complex roots are
// dropped because the intersection kernels always project geometric
// problems onto a single real parameter.

const EPS = 1e-9;

/** Solve A·t² + B·t + C = 0. Returns 0, 1, or 2 real roots.
 *  Numerically stable via Citardauq pivot. */
export function solveQuadratic(A, B, C) {
  if (Math.abs(A) < EPS) {
    if (Math.abs(B) < EPS) return [];
    return [-C / B];
  }
  const disc = B*B - 4*A*C;
  if (disc < -EPS) return [];
  if (disc < EPS) return [-B / (2*A)];
  const sd = Math.sqrt(disc);
  const q = -0.5 * (B + Math.sign(B || 1) * sd);
  const r1 = q / A;
  const r2 = (Math.abs(q) < EPS) ? r1 : C / q;
  return [r1, r2];
}

/** Solve A·t³ + B·t² + C·t + D = 0. Up to 3 real roots, via Cardano
 *  with the trigonometric branch for the 3-real-roots case. */
export function solveCubic(A, B, C, D) {
  if (Math.abs(A) < EPS) return solveQuadratic(B, C, D);
  const p = B / A, q = C / A, r = D / A;
  // Depress: t = u - p/3 → u³ + Pu + Q = 0
  const P = q - p*p/3;
  const Q = (2*p*p*p)/27 - (p*q)/3 + r;
  const half = Q * 0.5;
  const disc = half*half + (P*P*P)/27;
  const shift = p / 3;
  if (disc > EPS) {
    const sd = Math.sqrt(disc);
    const u = Math.cbrt(-half + sd);
    const v = Math.cbrt(-half - sd);
    return [u + v - shift];
  } else if (disc < -EPS) {
    const rho = Math.sqrt(-P*P*P/27);
    const theta = Math.acos(Math.max(-1, Math.min(1, -half / rho)));
    const t = 2 * Math.cbrt(rho);
    return [
      t * Math.cos(theta/3) - shift,
      t * Math.cos((theta + 2*Math.PI)/3) - shift,
      t * Math.cos((theta + 4*Math.PI)/3) - shift,
    ];
  } else {
    const u = Math.cbrt(-half);
    return [2*u - shift, -u - shift];
  }
}

/** Roots of A·t³ + B·t² + C·t + D = 0 in **[0, 1]**, via Yuksel 2022
 *  (critical-point split + interval-clamped Newton). Preferred over
 *  `solveCubic` (Cardano) wherever the parameter is range-bounded and
 *  `disc≈0` robustness matters, since Cardano's depressed-cubic branch
 *  loses precision near a double root. */
export function solveCubicInUnit(A, B, C, D) {
  const out = [];
  // Degenerate (not a cubic) → quadratic in [0, 1].
  if (Math.abs(A) < EPS) {
    if (Math.abs(B) < EPS) {
      if (Math.abs(C) > EPS) { const t = -D / C; if (t >= 0 && t <= 1) out.push(t); }
      return out;
    }
    const dq = C*C - 4*B*D;
    if (dq < 0) return out;
    const sq = Math.sqrt(dq);
    const t1 = (-C - sq) / (2*B), t2 = (-C + sq) / (2*B);
    if (t1 >= 0 && t1 <= 1) out.push(t1);
    if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-6) out.push(t2);
    return out;
  }
  const f  = (t) => ((A*t + B)*t + C)*t + D;
  const fp = (t) => (3*A*t + 2*B)*t + C;     // derivative
  // Split [0,1] at the cubic's critical points (3A·t² + 2B·t + C = 0).
  let s1 = -1, s2 = -1;
  const dq = (2*B)*(2*B) - 4*(3*A)*C;
  if (dq >= 0) {
    const sq = Math.sqrt(dq);
    let r1 = (-2*B - sq) / (2*3*A), r2 = (-2*B + sq) / (2*3*A);
    if (r1 > r2) { const tmp = r1; r1 = r2; r2 = tmp; }
    if (r1 > 0 && r1 < 1) s1 = r1;
    if (r2 > 0 && r2 < 1) { if (s1 < 0) s1 = r2; else s2 = r2; }
  }
  const bds = [0]; if (s1 > 0) bds.push(s1); if (s2 > 0) bds.push(s2); bds.push(1);
  for (let i = 0; i + 1 < bds.length; i++) {
    const lo = bds[i], hi = bds[i + 1];
    if ((f(lo) > 0) === (f(hi) > 0)) continue;   // no sign change ⇒ no root here
    let xr = 0.5 * (lo + hi);                     // interval-clamped Newton, ≤8 iters
    for (let k = 0; k < 8; k++) {
      const fdy = fp(xr);
      if (Math.abs(fdy) < 1e-12) break;
      const nx = Math.min(hi, Math.max(lo, xr - f(xr) / fdy));
      if (nx === xr) break;   // fixed point reached — the remaining iterations recompute
      xr = nx;                //   the identical xr, so this early-out is byte-for-byte exact
    }
    out.push(xr);
  }
  return out;
}

/** Solve A·t⁴ + B·t³ + C·t² + D·t + E = 0 for real roots via Ferrari.
 *  Up to 4 real roots. The resolvent cubic gives a real root y,
 *  which splits the quartic into two quadratics whose roots are the
 *  quartic's roots. */
export function solveQuartic(A, B, C, D, E) {
  if (Math.abs(A) < EPS) return solveCubic(B, C, D, E);
  // Normalise to monic.
  const b = B / A, c = C / A, d = D / A, e = E / A;
  // Depress: t = u - b/4 → u⁴ + p·u² + q·u + r = 0
  const p = c - 3*b*b/8;
  const q = b*b*b/8 - b*c/2 + d;
  const r = -3*b*b*b*b/256 + b*b*c/16 - b*d/4 + e;
  const shift = b / 4;

  // Special case: q ≈ 0 → biquadratic. Substitute v = u² in
  //   u⁴ + p·u² + r = 0   →   v² + p·v + r = 0.
  // Each non-negative root v gives u = ±√v.
  if (Math.abs(q) < EPS) {
    const vRoots = solveQuadratic(1, p, r);
    const out = [];
    for (const v of vRoots) {
      if (v < -EPS) continue;          // u² < 0 → no real u
      const sq = Math.sqrt(Math.max(0, v));
      out.push( sq - shift);
      if (sq > EPS) out.push(-sq - shift);
    }
    return out;
  }

  // Resolvent cubic: 8·y³ - 4p·y² - 8r·y + (4pr - q²) = 0 has a real
  // root y. Use that y to factor the depressed quartic.
  // (Standard Ferrari resolvent.)
  const resolvent = solveCubic(8, -4*p, -8*r, 4*p*r - q*q);
  if (resolvent.length === 0) return [];
  // Pick the resolvent root with largest 2y - p (most stable for the
  // sqrt below).
  let yBest = resolvent[0];
  for (const cand of resolvent) {
    if (2*cand - p > 2*yBest - p) yBest = cand;
  }
  const y = yBest;
  const twoYminusP = 2*y - p;
  if (twoYminusP < -EPS) return [];
  const w = Math.sqrt(Math.max(0, twoYminusP));
  // The quartic factors into two quadratics:
  //   u² - w·u + (y - q/(2w)) = 0
  //   u² + w·u + (y + q/(2w)) = 0
  // (When w ≈ 0, q must also be ≈ 0 by the resolvent; that branch is
  // handled above. So w > 0 here.)
  if (w < EPS) return [];
  const q2w = q / (2*w);
  const out = [];
  for (const u of solveQuadratic(1, -w, y - q2w)) out.push(u - shift);
  for (const u of solveQuadratic(1, +w, y + q2w)) out.push(u - shift);
  return out;
}

/** General-degree polynomial root finder for roots in [0, 1].
 *
 *  Algorithm: convert the power-form coefficients to Bernstein-form
 *  (over [0, 1]), then recursively subdivide via De Casteljau.
 *  The variation-diminishing property says: #real roots in [0, 1]
 *  ≤ #sign changes in Bernstein coefficients. When sign-change count
 *  is 0, the polynomial has no roots in [0, 1]. When ≤ 1, refine via
 *  secant on the original power-form polynomial. Otherwise split in
 *  half.
 *
 *  Useful for degree ≥ 5 (no closed-form radicals). Coefficients are
 *  in power form: `coeffs[i]` is the coefficient of `s^i`.
 *
 *  Returns real roots in [0, 1], sorted ascending.
 *
 *  @param {number[]} coeffs — coefficient array, coeffs[i] = coef of s^i
 *  @param {number} [tol=1e-10] — root refinement tolerance
 *  @returns {number[]}
 */
export function solvePolyInUnitInterval(coeffs, tol = 1e-10) {
  // Strip leading zeros (highest-degree).
  let n = coeffs.length - 1;
  while (n > 0 && Math.abs(coeffs[n]) < 1e-14) n--;
  if (n === 0) {
    return Math.abs(coeffs[0]) < 1e-14 ? [] : []; // constant nonzero → no roots
  }
  const power = coeffs.slice(0, n + 1);
  // Handle exact endpoint roots up front. The Bernstein subdivision
  // root finder skips zero coefficients in its sign-change count,
  // which can hide roots at s=0 (when power[0]=0) or s=1 (when the
  // power-form coefficients sum to 0). These are easy to detect
  // analytically.
  const out = [];
  if (Math.abs(power[0]) < 1e-12) {
    out.push(0);
    // Deflate: divide by s. The deflated polynomial has coefficients
    // shifted down by one (power[i+1] becomes power[i]).
    const deflated = power.slice(1);
    for (const r of solvePolyInUnitInterval(deflated, tol)) {
      // De-duplicate s=0 roots.
      if (r > 1e-9) out.push(r);
    }
    out.sort((a, b) => a - b);
    return out;
  }
  let sumAtOne = 0;
  for (const c of power) sumAtOne += c;
  if (Math.abs(sumAtOne) < 1e-12) {
    out.push(1);
    // Deflate: divide by (s - 1). Synthetic division.
    const deflated = new Array(power.length - 1);
    let rem = 0;
    for (let i = power.length - 1; i >= 1; i--) {
      rem = power[i] + rem;
      deflated[i - 1] = rem;
    }
    for (const r of solvePolyInUnitInterval(deflated, tol)) {
      if (r < 1 - 1e-9) out.push(r);
    }
    out.sort((a, b) => a - b);
    return out;
  }
  // Convert to Bernstein over [0, 1].
  const bern = powerToBernstein(power);
  subdivBernsteinRoots(bern, 0, 1, power, tol, out, 0);
  out.sort((a, b) => a - b);
  return out;
}

// Convert power-form coefficients c_0 + c_1 s + ... + c_n s^n
// to Bernstein-form coefficients b_0, ..., b_n where
//   p(s) = Σ_k b_k · B_{n,k}(s),   B_{n,k}(s) = C(n, k) s^k (1-s)^{n-k}.
// Formula: b_j = Σ_{i=0..j} C(j, i) / C(n, i) · c_i.
function powerToBernstein(power) {
  const n = power.length - 1;
  const bin = makeBinomial(n);
  const bern = new Array(n + 1);
  for (let j = 0; j <= n; j++) {
    let s = 0;
    for (let i = 0; i <= j; i++) {
      s += bin[j][i] / bin[n][i] * power[i];
    }
    bern[j] = s;
  }
  return bern;
}

function makeBinomial(n) {
  const C = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    C[i] = new Array(i + 1);
    C[i][0] = 1;
    C[i][i] = 1;
    for (let j = 1; j < i; j++) C[i][j] = C[i - 1][j - 1] + C[i - 1][j];
  }
  return C;
}

function countSignChanges(coeffs) {
  let count = 0;
  let last = 0;
  for (let i = 0; i < coeffs.length; i++) {
    const c = coeffs[i];
    if (Math.abs(c) < 1e-14) continue;
    const s = c > 0 ? 1 : -1;
    if (last !== 0 && s !== last) count++;
    last = s;
  }
  return count;
}

function evalPolyPower(power, s) {
  let v = power[power.length - 1];
  for (let i = power.length - 2; i >= 0; i--) v = v * s + power[i];
  return v;
}

function refineSecant(power, lo, hi, tol) {
  // Secant method bounded to [lo, hi].
  let a = lo, b = hi;
  let fa = evalPolyPower(power, a);
  let fb = evalPolyPower(power, b);
  // If endpoints have same sign, no bracketed root — return midpoint
  // (the variation-diminishing bound said ≤ 1 root, but tangent cases
  // may put both endpoints on the same side).
  if (fa * fb > 0) return 0.5 * (a + b);
  for (let i = 0; i < 60; i++) {
    if (Math.abs(b - a) < tol) break;
    if (Math.abs(fb - fa) < 1e-14) break;
    const c = b - fb * (b - a) / (fb - fa);
    if (c < a || c > b) break;
    const fc = evalPolyPower(power, c);
    if (Math.abs(fc) < tol) return c;
    if (fa * fc < 0) { b = c; fb = fc; }
    else             { a = c; fa = fc; }
  }
  return 0.5 * (a + b);
}

function subdivBernsteinRoots(bern, lo, hi, power, tol, out, depth) {
  if (depth > 50) return;
  const signChanges = countSignChanges(bern);
  if (signChanges === 0) return;
  if (signChanges === 1 || hi - lo < tol) {
    // Single root candidate — refine on the power-form polynomial.
    const root = refineSecant(power, lo, hi, tol);
    if (root >= -1e-9 && root <= 1 + 1e-9) {
      const r = Math.max(0, Math.min(1, root));
      // De-duplicate near-coincident roots.
      let dup = false;
      for (const prev of out) {
        if (Math.abs(prev - r) < 1e-6) { dup = true; break; }
      }
      if (!dup) out.push(r);
    }
    return;
  }
  // Split Bernstein at t = 0.5 in [lo, hi] local frame.
  const [left, right] = bernsteinSplit(bern, 0.5);
  const mid = 0.5 * (lo + hi);
  subdivBernsteinRoots(left,  lo, mid, power, tol, out, depth + 1);
  subdivBernsteinRoots(right, mid, hi, power, tol, out, depth + 1);
}

// De Casteljau split of a Bernstein-form polynomial at parameter t.
// Returns [leftBern, rightBern] over the sub-intervals.
function bernsteinSplit(bern, t) {
  const n = bern.length;
  const work = bern.slice();
  const left = new Array(n);
  const right = new Array(n);
  left[0] = work[0];
  right[n - 1] = work[n - 1];
  for (let level = 1; level < n; level++) {
    for (let i = 0; i < n - level; i++) {
      work[i] = work[i] + t * (work[i + 1] - work[i]);
    }
    left[level] = work[0];
    right[n - 1 - level] = work[n - 1 - level];
  }
  return [left, right];
}
