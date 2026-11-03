// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphCert — does a tape-paired CPatch morph stay a CPatch for every t, not just at the
// poses anyone sampled?
//
// SAMPLING t CANNOT SETTLE this, and neither can re-checking per frame: that is the same sampling
// paid every frame, and it says nothing about the gap between two frames. What settles it is a
// certificate over the whole interval, computed once.
//
// The certificate is the convex-hull property the converter already leans on in one variable,
// lifted to two. Every implicit is polynomial in its curve's control points once the POSITIVE
// normalizations are cleared, and a lerp makes control points affine in t — so the clip
// condition is a polynomial B(s, t), and if every coefficient of its tensor-product Bernstein
// form over [0,1]^2 is non-negative then B >= 0 on the whole square. Coefficients that dip
// negative prove nothing on their own, so t is subdivided and the bound retried; what survives
// is a set of t-intervals where the morph genuinely cannot be certified.
import { segPt, segSlice, implGrad, segTangent, segNorm } from '../geom/cpatchImplicit.js';
import { cubicDegreeReduce } from '../geom/lbCubicMath.js';
import {
  interiorPoint,
  framePatch,
  patchEval,
  nonNegIntervals,
  validatePatch,
  morphTolPx,
} from './cpatchConvert.js';
import { mantleDebugHook } from '../core/diagnostics.js';

// ---- dense bivariate polynomials in (x, y): c[i][j] is the coefficient of x^i y^j ----
const pAdd = (A, B) => {
  const out = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const a = A[i] || [],
      b = B[i] || [],
      row = [];
    for (let j = 0; j < Math.max(a.length, b.length); j++) row.push((a[j] || 0) + (b[j] || 0));
    out.push(row);
  }
  return out;
};
const pScale = (A, k) => A.map((r) => r.map((v) => v * k));
const pMul = (A, B) => {
  const out = [];
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[i].length; j++) {
      const a = A[i][j];
      if (!a) continue;
      for (let k = 0; k < B.length; k++)
        for (let l = 0; l < B[k].length; l++) {
          const b = B[k][l];
          if (!b) continue;
          (out[i + k] || (out[i + k] = []))[j + l] = (out[i + k][j + l] || 0) + a * b;
        }
    }
  return out.map((r) => (r || []).map((v) => v || 0));
};

/// A cubic whose C3 coefficient vanishes IS a quadratic; return its control points, else null.
/// Same test the converter makes before reaching for klmn, kept local so this file stays a leaf.
/// The renderer's degree reduction, not a second opinion on it.
///
function degreeReduce(P) {
  const q = cubicDegreeReduce(P);
  return q ? [P[0], q, P[3]] : null;
}

/// Bezier control points -> POWER-basis coefficients in the curve parameter.
function bezierToPower(vals) {
  const n = vals.length - 1,
    out = new Array(n + 1).fill(0);
  const bin = (a, b) => {
    let r = 1;
    for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1);
    return r;
  };
  for (let k = 0; k <= n; k++) {
    let s = 0;
    for (let i = 0; i <= k; i++) s += ((k - i) & 1 ? -1 : 1) * bin(k, i) * vals[i];
    out[k] = bin(n, k) * s;
  }
  return out;
}

// Res_s(x*W-X, y*W-Y) is polynomial in both position and morph controls.
// Unlike normalized line/quadratic/klmn forms, it needs no division by a
// control-triangle area or discrete cubic classification. Its Bezout entries
// therefore remain valid when a control triangle changes orientation.
function polyImplicit(seg) {
  let P = seg.P;
  let n = P.length - 1;
  if (n < 1 || n > 3) return null;
  // A cubic that is really a quadratic has no cubic resultant. Its 3x3 Bezout determinant
  // vanishes identically, and the piece then has no implicit at all — which is not a rare corner
  // once splitForMorph has cut at the inflections, because the pieces either side of one are
  // close to degree-reduced. Drop to the degree the curve actually has.
  if (n === 3) {
    const q = degreeReduce(P);
    if (q) {
      P = q;
      n = P.length - 1;
    }
  }
  const isRat = seg.t === 'rquad' && seg.w != null;
  const w = isRat ? seg.w : 1;
  // Homogeneous control values. A rational quadratic carries weights (1, w, 1).
  const wts = isRat ? [1, w, 1] : P.map(() => 1);
  const X = bezierToPower(P.map((q, i) => q[0] * wts[i]));
  const Y = bezierToPower(P.map((q, i) => q[1] * wts[i]));
  const W = bezierToPower(wts);
  // f_k and g_k as affine polynomials in (x, y): f = x*W - X, g = y*W - Y.
  const f = [],
    g = [];
  for (let k = 0; k <= n; k++) {
    f.push([[-X[k]], [W[k]]]); // -X_k + W_k * x
    g.push([[-Y[k], W[k]]]); // -Y_k + W_k * y
  }
  // Bezoutian: (f(s)g(u) - f(u)g(s)) / (s - u) = sum b_ij s^i u^j.
  const B = [];
  for (let i = 0; i < n; i++) {
    B.push([]);
    for (let j = 0; j < n; j++) B[i].push([[0]]);
  }
  for (let a = 1; a <= n; a++)
    for (let b = 0; b < a; b++) {
      const c = pAdd(pMul(f[a], g[b]), pScale(pMul(f[b], g[a]), -1));
      let allZero = true;
      for (const row of c)
        for (const v of row)
          if (v) {
            allZero = false;
            break;
          }
      if (allZero) continue;
      for (let m = 0; m <= a - b - 1; m++) {
        const i = a - 1 - m,
          j = b + m;
        if (i < n && j < n) B[i][j] = pAdd(B[i][j], c);
      }
    }
  // Determinant, expanded on polynomials.
  let det;
  if (n === 1) det = B[0][0];
  else if (n === 2) det = pAdd(pMul(B[0][0], B[1][1]), pScale(pMul(B[0][1], B[1][0]), -1));
  else {
    const m = (i, j) => B[i][j];
    const c0 = pAdd(pMul(m(1, 1), m(2, 2)), pScale(pMul(m(1, 2), m(2, 1)), -1));
    const c1 = pAdd(pMul(m(1, 0), m(2, 2)), pScale(pMul(m(1, 2), m(2, 0)), -1));
    const c2 = pAdd(pMul(m(1, 0), m(2, 1)), pScale(pMul(m(1, 1), m(2, 0)), -1));
    det = pAdd(pAdd(pMul(m(0, 0), c0), pScale(pMul(m(0, 1), c1), -1)), pMul(m(0, 2), c2));
  }
  let deg = 0;
  for (let i = 0; i < det.length; i++)
    for (let j = 0; j < det[i].length; j++) if (det[i][j]) deg = Math.max(deg, i + j);
  return deg > 0 ? { deg, c: det } : null;
}

/// The clock a plan's time budget is read on (see planMorph's `maxPlanMs`).
const _clock = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/// Map both poses into the unit box around their shared center. A similarity transform leaves
/// every implicit's SIGN untouched, which is all a certificate reads.
function normalizePair(A, B) {
  let cx = 0,
    cy = 0,
    m = 0;
  for (const list of [A, B])
    for (const c of list)
      for (const q of c.P) {
        cx += q[0];
        cy += q[1];
        m++;
      }
  if (!m) return [A, B];
  cx /= m;
  cy /= m;
  let r = 0;
  for (const list of [A, B])
    for (const c of list)
      for (const q of c.P) r = Math.max(r, Math.abs(q[0] - cx), Math.abs(q[1] - cy));
  const k = r > 0 ? 1 / r : 1;
  const map = (list) =>
    list.map((c) => ({
      t: c.t,
      cut: c.cut,
      w: c.w,
      _bez: c._bez,
      P: c.P.map((q) => [(q[0] - cx) * k, (q[1] - cy) * k]),
    }));
  // `k` goes with them: a caller measuring anything in PIXELS has to scale its tolerance by the
  // same factor, or it is quietly testing a different tolerance than it asked for.
  return [map(A), map(B), k];
}

/// Exposed for the probe: the resultant must vanish ON its curve and nowhere near it otherwise.
export const _polyImplicit = (seg) => polyImplicit(seg);

/// The implicit's partial derivatives, in the same dense form. c[i][j] is the coefficient of
/// x^i*y^j, so d/dx shifts the x index down and d/dy the y index.
const polyDx = (F) => {
  const c = [];
  for (let i = 1; i < F.c.length; i++) c.push((F.c[i] || []).map((v) => v * i));
  return { deg: Math.max(0, F.deg - 1), c: c.length ? c : [[0]] };
};
const polyDy = (F) => ({
  deg: Math.max(0, F.deg - 1),
  c: F.c.map((row) => {
    const o = [];
    for (let j = 1; j < row.length; j++) o.push(row[j] * j);
    return o.length ? o : [0];
  }),
});

const evalPoly = (F, x, y) => {
  let s = 0;
  for (let i = 0; i < F.c.length; i++)
    for (let j = 0; j < F.c[i].length; j++) {
      const k = F.c[i][j];
      if (k) s += k * Math.pow(x, i) * Math.pow(y, j);
    }
  return s;
};

// These lattices describe affine control-point motion with fixed rational
// weights. Positive weights also keep the curve inside the control hull used
// by movingCover. A different endpoint weight needs another polynomial model.
function rationalPairIssue(A, B) {
  for (let i = 0; i < A.length; i++) {
    const a = A[i],
      b = B[i];
    if (a.t !== 'rquad' && (!b || b.t !== 'rquad')) continue;
    const wa = a.t === 'rquad' ? (a.w == null ? 1 : a.w) : 1;
    const wb = b && b.t === 'rquad' ? (b.w == null ? 1 : b.w) : 1;
    if (
      !b ||
      a.P.length !== 3 ||
      b.P.length !== 3 ||
      !(wa > 0) ||
      !Number.isFinite(wa) ||
      wa !== wb
    )
      return { i, why: 'rational weights must be positive and fixed across the morph' };
  }
  return null;
}

// Clear the rational point's denominator before fitting a polynomial lattice.
// The fixed (1,w,1) denominator is positive on [0,1] when w > -1; reject
// other slices instead of applying a sign-changing multiplier. Gradients use
// the same total degree as F so F/|gradient| retains its distance meaning.
function pointH(seg, u) {
  if (seg.t !== 'rquad') {
    const p = segPt(seg, u);
    return [p[0], p[1], 1];
  }
  const w = seg.w == null ? 1 : seg.w;
  if (!(w > -1) || !Number.isFinite(w)) return [NaN, NaN, NaN];
  const a = (1 - u) * (1 - u),
    b = 2 * u * (1 - u) * w,
    c = u * u,
    P = seg.P;
  return [
    a * P[0][0] + b * P[1][0] + c * P[2][0],
    a * P[0][1] + b * P[1][1] + c * P[2][1],
    a + b + c,
  ];
}
function evalAlong(F, seg, u, degree = F.deg) {
  if (seg.t !== 'rquad') {
    const p = segPt(seg, u);
    return evalPoly(F, p[0], p[1]);
  }
  const [x, y, w] = pointH(seg, u);
  let v = 0;
  for (let i = 0; i < F.c.length; i++)
    for (let j = 0; j < F.c[i].length; j++) {
      const k = F.c[i][j];
      if (k) v += k * Math.pow(x, i) * Math.pow(y, j) * Math.pow(w, degree - i - j);
    }
  return v;
}

/// Values at the D+1 equally spaced nodes -> Bernstein coefficients of the degree-D polynomial
/// through them. Small and cached; D never exceeds a dozen here.
const _v2b = new Map();
function valuesToBernstein(D) {
  const hit = _v2b.get(D);
  if (hit) return hit;
  const bin = (n, k) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };
  // M[k][m] = B_m^D(k/D)
  const M = [];
  for (let k = 0; k <= D; k++) {
    const u = D === 0 ? 0 : k / D,
      row = [];
    for (let m = 0; m <= D; m++) row.push(bin(D, m) * Math.pow(u, m) * Math.pow(1 - u, D - m));
    M.push(row);
  }
  // invert (Gauss-Jordan; D is tiny)
  const n = D + 1,
    A = M.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let j = 0; j < 2 * n; j++) A[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[col][j];
    }
  }
  const inv = A.map((r) => r.slice(n));
  _v2b.set(D, inv);
  return inv;
}

const applyInv = (inv, vals) => inv.map((row) => row.reduce((s, v, k) => s + v * vals[k], 0));

/// de Casteljau on the t index of a tensor grid: coefficients over [0,1] -> the two halves.
function splitT(grid, at = 0.5) {
  const ns = grid.length,
    nt = grid[0].length;
  const lo = [],
    hi = [];
  for (let i = 0; i < ns; i++) {
    const c = grid[i].slice(),
      l = new Array(nt),
      h = new Array(nt);
    let len = nt;
    l[0] = c[0];
    h[nt - 1] = c[len - 1];
    for (let step = 1; step < nt; step++) {
      for (let k = 0; k < len - 1; k++) c[k] += (c[k + 1] - c[k]) * at;
      len--;
      l[step] = c[0];
      h[nt - 1 - step] = c[len - 1];
    }
    lo.push(l);
    hi.push(h);
  }
  return [lo, hi];
}

const gridMin = (g) => {
  let m = Infinity;
  for (const row of g) for (const v of row) if (v < m) m = v;
  return m;
};

/// CERTIFY the clip direction over the whole morph.
///
/// For every ordered pair of curves in a paired patch, the implicit of one must stay non-negative
/// along the other for every t. Returns { ok, pairs, certified, failures, inconclusive } — where
/// `inconclusive` counts pairs no polynomial implicit was available for (cubics and rationals),
/// which are reported rather than assumed safe.
/// Which side of a curve the patch is on, PROVEN across a whole span rather than sampled.

/// So the point is used ONCE, at the start pose, where it is reliable and where it is exactly
/// what the renderer itself does -- the sign of f at an interior point. What carries that across
/// the span is local: grad(f) . n, for the curve's own normal, cannot change sign without the
/// patch changing which side of that curve it lies on. It is bounded away from zero wherever the
/// curve is not degenerate, so its Bernstein hull settles the question outright rather than
/// straddling it, and no interior point has to survive the journey. A global sign flip of the
/// resultant takes grad with it and shows up here as a straddle, which returns 0 and lets the
/// planner split -- conservative, and honest about which poses it has actually covered.
function orientAcross(segsOf, idx, deg) {
  const at0 = segsOf(0);
  const F0 = polyImplicit(at0[idx]);
  const q0 = interiorPoint(at0);
  if (!F0 || !q0) return 0;
  const v0 = evalPoly(F0, q0[0], q0[1]);
  if (!(v0 !== 0)) return 0;
  const s0 = v0 > 0 ? 1 : -1;
  const degT = Math.max(1, 3 * deg);
  const inT = valuesToBernstein(degT);
  if (!inT) return 0;
  const vals = [];
  for (let b = 0; b <= degT; b++) {
    const segs = segsOf(b / degT);
    const F = polyImplicit(segs[idx]);
    if (!F) return 0;
    const p = segPt(segs[idx], 0.5),
      tg = segTangent(segs[idx], 0.5);
    vals.push(evalPoly(polyDx(F), p[0], p[1]) * -tg[1] + evalPoly(polyDy(F), p[0], p[1]) * tg[0]);
  }
  if (vals.some((v) => !Number.isFinite(v))) return 0;
  const bez = applyInv(inT, vals);
  let mn = Infinity,
    mx = -Infinity;
  for (const v of bez) {
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
  }
  return mn > 0 || mx < 0 ? s0 : 0;
}

/// The patch's cover as half-planes that MOVE with the morph: fixed normals, offsets carried
/// linearly between the poses.
///
/// The union hull of both poses' control points is a valid cover for every pose in between and a
/// badly loose one -- on a shape that grows by half it is the LATER pose's extent at every t, so
/// the early poses are certified against a box far bigger than the one the renderer clips them
/// to. leakOf uses each pose's own tight cover, and the certificate refusing what leakOf accepts
/// is not conservatism it can afford: it plateaued at five uncertifiable regions no amount of
/// subdivision touched.
///
/// Interpolating the OFFSET is exact and sound. A pose's point is p(t) = (1-t)a + t b with a and
/// b in the two hulls, so n.p(t) + (1-t)cA + t cB = (1-t)(n.a + cA) + t(n.b + cB) >= 0 whenever
/// both poses satisfy their own offset -- and at t=0 it is pose A's own extent, not the union's.
function movingCover(curvesA, curvesB) {
  const pts = [];
  for (let k = 0; k < curvesA.length; k++) {
    for (const q of curvesA[k].P) pts.push(q);
    for (const q of curvesB[k].P) pts.push(q);
  }
  const hull = convexHull(pts);
  if (!hull || hull.length < 3) return [];
  let a2 = 0;
  for (let a = 0, b = hull.length - 1; a < hull.length; b = a++)
    a2 += hull[b][0] * hull[a][1] - hull[a][0] * hull[b][1];
  const sg = a2 >= 0 ? 1 : -1;
  const out = [];
  for (let a = 0, b = hull.length - 1; a < hull.length; b = a++) {
    const p = hull[b],
      q = hull[a];
    const nx = -(q[1] - p[1]) * sg,
      ny = (q[0] - p[0]) * sg,
      L = Math.hypot(nx, ny);
    // Scale-free already: both callers hand this the NORMALIZED pair, whose half-extent is 1 by
    // construction, so 1e-12 is a fraction of the pair and not of the drawing it came from.
    if (!(L > 1e-12)) continue;
    const ux = nx / L,
      uy = ny / L;
    const off = (list) => {
      let m = Infinity;
      for (const c of list) for (const z of c.P) m = Math.min(m, ux * z[0] + uy * z[1]);
      return -m;
    };
    out.push({ n: [ux, uy], cA: off(curvesA), cB: off(curvesB) });
  }
  return out;
}

export function certifyMorphClip(curvesA0, curvesB0, opts = {}) {
  const issue = rationalPairIssue(curvesA0, curvesB0);
  if (issue)
    return {
      ok: false,
      pairs: 0,
      boxes: 0,
      overBudget: false,
      overTime: false,
      certified: 0,
      inconclusive: 1,
      failures: [issue],
    };
  // THE BAR SCALES WITH THE PAIR (morphTolPx). `tolN` below is this number divided by
  // the pair's own half-extent, so a flat default made the NORMALIZED tolerance -- the one the
  // Bernstein bounds are actually read against -- inversely proportional to the size the drawing
  // happened to be authored at. Scaled, tolN is the same number at every size.
  const tol = opts.tolPx != null ? opts.tolPx : morphTolPx(curvesA0, curvesB0);
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 14;
  // CONDITIONING. A cubic against a cubic is degree 9 in both variables, and the value-to-
  // Bernstein inversion at that degree over coordinates in the hundreds mixes terms of wildly
  // different size — x^3 alone spans six orders of magnitude before t is involved. Centering and
  // scaling to the unit box costs nothing (a similarity leaves every sign alone) and is the
  // difference between a usable bound and noise.
  const [curvesA, curvesB, kScale] = normalizePair(curvesA0, curvesB0);
  // THE TOLERANCE IS A DISTANCE, so it travels with the normalization that made the grids usable.
  const tolN = tol * kScale;
  const n = curvesA.length;
  const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const segAt = (i, t) => ({
    t: curvesA[i].t,
    cut: curvesA[i].cut,
    w: curvesA[i].w,
    _bez: curvesA[i]._bez,
    P: curvesA[i].P.map((q, k) => lerpPt(q, curvesB[i].P[k], t)),
  });
  const segAll = (t) => curvesA.map((_, i) => segAt(i, t));
  // Memoized across the whole call. The implicit of curve j at pose t does not depend on which
  // curve's extension is being tested, which region of it, or which of the three grids wants it
  // -- so it is built once rather than for every one of them: a Bezout resultant is not cheap,
  // and on a four-curve patch that is one resultant instead of well over a thousand.
  const _implMemo = new Map();
  const implAt = (j, t) => {
    const k = j + '@' + t;
    let v = _implMemo.get(k);
    if (v === undefined) {
      v = polyImplicit(segAt(j, t)) || null;
      _implMemo.set(k, v);
    }
    return v;
  };
  const _segMemo = new Map();
  const segAtM = (j, t) => {
    const k = j + '@' + t;
    let v = _segMemo.get(k);
    if (v === undefined) {
      v = segAt(j, t);
      _segMemo.set(k, v);
    }
    return v;
  };

  const _orientMemo = new Map();
  const orientClip = (i, deg) => {
    let v = _orientMemo.get(i);
    if (v === undefined) {
      v = orientAcross(segAll, i, deg);
      _orientMemo.set(i, v);
    }
    return v;
  };
  const coverLines = movingCover(curvesA, curvesB);
  const coverGrids = (i, j, degS, degT) =>
    coverLines
      .map((h) =>
        bivSample(
          (tv) => ({ sg: segAtM(j, tv), off: h.cA + (h.cB - h.cA) * tv }),
          (c, sv) => {
            const pt = pointH(c.sg, sv);
            return h.n[0] * pt[0] + h.n[1] * pt[1] + c.off * pt[2];
          },
          degS,
          Math.max(degT, 2),
        ),
      )
      .filter(Boolean);

  let pairs = 0,
    certified = 0,
    inconclusive = 0,
    boxes = 0,
    overBudget = false,
    overTime = false;
  const maxBoxes = opts.maxBoxes > 0 ? opts.maxBoxes : 0;
  // THE PLAN'S DEADLINE, as an absolute clock reading (see planMorph's `maxPlanMs`). Asked before
  // each pair, whose grids are the expensive half of the work, and every 256 boxes inside it.
  const deadline = opts.deadline > 0 ? opts.deadline : 0;
  const failures = [];
  pairsLoop: for (let i = 0; i < n; i++) {
    if (!polyImplicit(curvesA[i]) || !polyImplicit(curvesB[i])) {
      inconclusive += n - 1;
      continue;
    }
    const di = polyImplicit(curvesA[i]).deg;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (deadline && _clock() > deadline) {
        overBudget = overTime = true;
        break pairsLoop;
      }
      pairs++;
      const nj = curvesA[j].P.length - 1;
      // Degrees, from the resultant's shape rather than guessed. f_i is degree n_i in the point,
      // its coefficients are degree 2*n_i in curve i's control points (each Bezout entry is a
      // bracket, bilinear in coefficients that are themselves affine in the control points, and
      // the determinant multiplies n_i of them), and the point substituted into it is affine in t
      // and degree n_j in s.
      const degS = di * nj;
      const degT = 3 * di;
      const inS = valuesToBernstein(degS),
        inT = valuesToBernstein(degT);
      if (!inS || !inT) {
        inconclusive++;
        continue;
      }
      // Sample the (s, t) grid exactly, then two 1-D value->Bernstein transforms. The IMPLICIT'S
      // GRADIENT rides along on the same lattice: it is what turns a raw resultant value into the
      // distance the renderer would actually mis-shade, and it costs two more evaluations at
      // points already being visited.
      // PER-t WORK HOISTED, as in bivSample: the implicit at pose t, its two derivatives and the
      // curve being walked all depend on t alone, and rebuilding them inside the s loop would be
      // degS+1 Bezout resultants per column where one does.
      const ctxT = [];
      for (let b = 0; b <= degT; b++) {
        const t = degT === 0 ? 0 : b / degT;
        const F = implAt(i, t);
        ctxT.push(F ? { F, Fx: polyDx(F), Fy: polyDy(F), sg: segAtM(j, t) } : null);
      }
      const vals = [],
        valX = [],
        valY = [];
      for (let a = 0; a <= degS; a++) {
        const s = degS === 0 ? 0 : a / degS,
          row = [],
          rowX = [],
          rowY = [];
        for (let b = 0; b <= degT; b++) {
          const c = ctxT[b];
          if (!c) {
            row.push(NaN);
            rowX.push(NaN);
            rowY.push(NaN);
            continue;
          }
          row.push(evalAlong(c.F, c.sg, s, di));
          rowX.push(evalAlong(c.Fx, c.sg, s, di));
          rowY.push(evalAlong(c.Fy, c.sg, s, di));
        }
        vals.push(row);
        valX.push(rowX);
        valY.push(rowY);
      }
      if (vals.some((r) => r.some((v) => !Number.isFinite(v)))) {
        inconclusive++;
        continue;
      }
      // s first, then t: two 1-D transforms give the tensor-product coefficients.
      const toGrid = (V) => {
        const bs2 = [];
        for (let b = 0; b <= degT; b++)
          bs2.push(
            applyInv(
              inS,
              V.map((r) => r[b]),
            ),
          );
        const out = [];
        for (let a = 0; a <= degS; a++)
          out.push(
            applyInv(
              inT,
              bs2.map((col) => col[a]),
            ),
          );
        return out;
      };
      const grid = toGrid(vals),
        gradX = toGrid(valX),
        gradY = toGrid(valY);

      const sgn = orientClip(i, di);
      if (!sgn) {
        inconclusive++;
        continue;
      }
      // RAW, and compared in PIXELS via the gradient — which is what validatePatch does, and the
      // certificate has to ask the same question as the validator the planner samples against or
      // no plan can ever satisfy both. Normalizing each grid to its own largest coefficient asks
      // a different one, and asks it worst exactly where it matters: where two pieces of the same
      // curve meet, f_i along curve j is zero to rounding, and dividing that noise by itself
      // turns 1e-16 into O(1): a false cubic failure then reads a minimum around -1e-7 against
      // coefficients no larger than that.
      const g0 = grid.map((r) => r.map((v) => v * sgn));

      // Subdivide in both variables where the hull bound is inconclusive. Splitting only t is not
      // enough: the clip condition is a minimum over s, its Bernstein bound in s is loose like any
      // other, and on a static or near-static span t-subdivision refines nothing at all -- the
      // bound in s would never tighten.
      // THE COVER PARTICIPATES, which makes this a disjunction like the leak direction. Two
      // curves of a patch meet at a shared vertex, and just past it the neighbor leaves along a
      // direction where the first curve's implicit is negative — on the OTHER branch of its
      // algebraic curve, which the drawn arc never visits. The renderer never classifies there
      // because the cover excludes it, so neither should this: a box is fine if f_i is
      // non-negative over it OR any cover line is negative over the whole of it.
      const covers = coverGrids(i, j, degS, degT);
      /** @type {Array<[number[][], number[][], number[][], number[][][], number, number, number, number, number]>} */
      const stack = [[g0, gradX, gradY, covers, 0, 1, 0, 1, 0]];
      let bad = null;
      while (stack.length) {
        const [g, gx, gy, cvs, s0, s1, t0, t1, d] = stack.pop();
        boxes++;
        // A budget the subdivision itself respects. Checked between calls it is not a bound at
        // all: one call can pop 31,000 boxes, so a caller asking for 20,000 got 155,694. Giving
        // up here is CONSERVATIVE -- an un-settled box is not certified, which is what the caller
        // already does with a failure -- so it can only ever shorten a certified span.
        if (maxBoxes > 0 && boxes > maxBoxes) {
          overBudget = true;
          bad = bad || [t0, t1];
          break;
        }
        if (deadline && (boxes & 255) === 0 && _clock() > deadline) {
          overBudget = overTime = true;
          bad = bad || [t0, t1];
          break;
        }
        const mn = gridMin(g);
        if (mn >= 0) continue; // certified non-negative here
        // ...or it dips by less than the tolerance, in pixels, exactly as validatePatch measures.
        if (-mn <= tolN * Math.max(loAbs(gx), loAbs(gy))) continue;
        if (cvs.some((c) => gridMax(c) < -1e-9)) continue; // ...or the cover excludes the box
        if (d >= maxDepth) {
          bad = bad || [t0, t1];
          bad[0] = Math.min(bad[0], t0);
          bad[1] = Math.max(bad[1], t1);
          continue;
        }
        const tVaries = (() => {
          for (const row of g)
            for (let j = 1; j < row.length; j++) if (Math.abs(row[j] - row[0]) > 1e-15) return true;
          return false;
        })();
        if (!tVaries || s1 - s0 >= t1 - t0) {
          const [lo, hi] = splitS(g),
            [xl, xh] = splitS(gx),
            [yl, yh] = splitS(gy);
          const cl = cvs.map((c) => splitS(c));
          const m = (s0 + s1) / 2;
          stack.push(
            [lo, xl, yl, cl.map((x) => x[0]), s0, m, t0, t1, d + 1],
            [hi, xh, yh, cl.map((x) => x[1]), m, s1, t0, t1, d + 1],
          );
        } else {
          const [lo, hi] = splitT(g),
            [xl, xh] = splitT(gx),
            [yl, yh] = splitT(gy);
          const cl = cvs.map((c) => splitT(c));
          const m = (t0 + t1) / 2;
          stack.push(
            [lo, xl, yl, cl.map((x) => x[0]), s0, s1, t0, m, d + 1],
            [hi, xh, yh, cl.map((x) => x[1]), s0, s1, m, t1, d + 1],
          );
        }
      }
      if (bad) failures.push({ i, j, t0: +bad[0].toFixed(4), t1: +bad[1].toFixed(4) });
      else certified++;
    }
  }
  return {
    ok: failures.length === 0 && inconclusive === 0 && !overTime,
    pairs,
    boxes,
    overBudget,
    overTime,
    certified,
    inconclusive,
    failures,
  };
}

/// The tensor-product Bernstein grid of f_i composed along curve j, over (s, t) in the unit
/// square. Shared by both directions; `segOf` supplies the curve to walk, which for the leak
/// direction is an EXTENSION rather than the curve itself.
/// Any function of (s, t) on the tensor lattice, as Bernstein coefficients. bivGrid is this with
/// the implicit-along-a-curve sampler baked in; the certificates also need products and gradients
/// of those, which are polynomials of the same shape and no other machinery.
function bivSample(perT, valAt, degS, degT) {
  const inS = valuesToBernstein(degS),
    inT = valuesToBernstein(degT);
  if (!inS || !inT) return null;
  // PER-t WORK IS HOISTED. Everything the sampler needs that depends only on t -- the implicit
  // at that pose, the sliced curve -- would otherwise be rebuilt once per (s, t) pair, which is
  // degS+1 Bezout resultants per column instead of one. On a cubic that is a factor of ten before any
  // other consideration.
  const ctx = [];
  for (let b = 0; b <= degT; b++) {
    const c = perT(degT === 0 ? 0 : b / degT);
    if (!c) return null;
    ctx.push(c);
  }
  const vals = [];
  for (let a = 0; a <= degS; a++) {
    const s = degS === 0 ? 0 : a / degS,
      row = [];
    for (let b = 0; b <= degT; b++) {
      const v = valAt(ctx[b], s);
      if (v == null || !Number.isFinite(v)) return null;
      row.push(v);
    }
    vals.push(row);
  }
  const bs = [];
  for (let b = 0; b <= degT; b++)
    bs.push(
      applyInv(
        inS,
        vals.map((r) => r[b]),
      ),
    );
  const grid = [];
  for (let a = 0; a <= degS; a++)
    grid.push(
      applyInv(
        inT,
        bs.map((col) => col[a]),
      ),
    );
  return grid;
}

/// The lower bound of |g| over a box, from its Bernstein hull. Zero when the hull straddles the
/// axis, which is the honest answer: the magnitude is not established there, so the box gets
/// subdivided rather than waved through.
const loAbs = (g) => {
  const mn = gridMin(g),
    mx = gridMax(g);
  return mn > 0 ? mn : mx < 0 ? -mx : 0;
};

function bivGrid(implOf, segOf, degS, degT) {
  const inS = valuesToBernstein(degS),
    inT = valuesToBernstein(degT);
  if (!inS || !inT) return null;
  // Same hoist as bivSample: implOf and segOf are functions of t alone, and calling them from
  // inside the s loop rebuilt a resultant and a blossom for every sample.
  const Fs = [],
    sgs = [];
  for (let b = 0; b <= degT; b++) {
    const t = degT === 0 ? 0 : b / degT;
    const F = implOf(t);
    if (!F) return null;
    Fs.push(F);
    sgs.push(segOf(t));
  }
  const vals = [];
  for (let a = 0; a <= degS; a++) {
    const s = degS === 0 ? 0 : a / degS,
      row = [];
    for (let b = 0; b <= degT; b++) {
      row.push(evalAlong(Fs[b], sgs[b], s));
    }
    vals.push(row);
  }
  if (vals.some((r) => r.some((v) => !Number.isFinite(v)))) return null;
  const bs = [];
  for (let b = 0; b <= degT; b++)
    bs.push(
      applyInv(
        inS,
        vals.map((r) => r[b]),
      ),
    );
  const grid = [];
  for (let a = 0; a <= degS; a++)
    grid.push(
      applyInv(
        inT,
        bs.map((col) => col[a]),
      ),
    );
  return grid;
}

/// Monotone chain.
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (src) => {
    const out = [];
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return build(p).concat(build(p.slice().reverse()));
}

/// How large this implicit gets over the patch — a reference the grid can be judged against.
///
/// WITHOUT ONE, "is this composition identically zero" gets asked of the grid's own largest
/// coefficient, and for two pieces of the same curve — which is exactly what splitting at an
/// inflection produces — every value is floating-point noise around zero. Normalizing noise by
/// noise turns 1e-15 into O(1) and the certificate refuses a pair that has nothing to violate.

const gridMax = (g) => {
  let m = -Infinity;
  for (const row of g) for (const v of row) if (v > m) m = v;
  return m;
};

/// de Casteljau on the s index — the leak direction subdivides in both variables, because the
/// bad set can be a sliver in s as easily as in t.
function splitS(grid, at = 0.5) {
  const ns = grid.length,
    nt = grid[0].length;
  const lo = [],
    hi = [];
  for (let j = 0; j < nt; j++) {
    const c = [];
    for (let i = 0; i < ns; i++) c.push(grid[i][j]);
    let len = ns;
    const l = new Array(ns),
      h = new Array(ns);
    l[0] = c[0];
    h[ns - 1] = c[len - 1];
    for (let step = 1; step < ns; step++) {
      for (let k = 0; k < len - 1; k++) c[k] += (c[k + 1] - c[k]) * at;
      len--;
      l[step] = c[0];
      h[ns - 1 - step] = c[len - 1];
    }
    for (let i = 0; i < ns; i++) {
      (lo[i] || (lo[i] = []))[j] = l[i];
      (hi[i] || (hi[i] = []))[j] = h[i];
    }
  }
  return [lo, hi];
}

/// CERTIFY the leak direction: no point on a curve's EXTENSION, outside its own arc, satisfies
/// every constraint — for any t.
///
/// This is not the clip condition with a different sign. Clip asks that ONE polynomial stay
/// non-negative, which a single hull bound settles. A leak is an EXISTENCE claim about a
/// conjunction, so its negation is a DISJUNCTION — at every point of the extension region SOME
/// constraint must be negative — and no single polynomial expresses that. What does settle it is
/// subdivision: a box is certified the moment any one constraint's coefficients are all negative
/// over it, since that constraint then excludes the whole box.
export function certifyMorphLeak(curvesA0, curvesB0, opts = {}) {
  const issue = rationalPairIssue(curvesA0, curvesB0);
  if (issue)
    return {
      ok: false,
      regions: 0,
      boxes: 0,
      overBudget: false,
      overTime: false,
      certified: 0,
      failures: [issue],
    };
  const [curvesA, curvesB, kScale] = normalizePair(curvesA0, curvesB0);
  const tol = opts.tolPx != null ? opts.tolPx : morphTolPx(curvesA0, curvesB0);
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 16;
  // THE TOLERANCE IS A DISTANCE, so it travels with the normalization that made the grids usable.
  const tolN = tol * kScale;
  const T = opts.extend != null ? opts.extend : 3; // fixed span, so E is the same map for all t
  const n = curvesA.length;
  const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const segAt = (i, t) => ({
    t: curvesA[i].t,
    cut: curvesA[i].cut,
    w: curvesA[i].w,
    _bez: curvesA[i]._bez,
    P: curvesA[i].P.map((q, k) => lerpPt(q, curvesB[i].P[k], t)),
  });

  const span = 1 + 2 * T,
    lo = T / span,
    hi = (1 + T) / span;
  const segAll2 = (t) => curvesA.map((_, i) => segAt(i, t));
  // Memoized across the whole call. The implicit of curve j at pose t does not depend on which
  // curve's extension is being tested, which region of it, or which of the three grids wants it
  // -- so it is built once rather than for every one of them: a Bezout resultant is not cheap,
  // and on a four-curve patch that is one resultant instead of well over a thousand.
  const _implMemo = new Map();
  const implAt = (j, t) => {
    const k = j + '@' + t;
    let v = _implMemo.get(k);
    if (v === undefined) {
      v = polyImplicit(segAt(j, t)) || null;
      _implMemo.set(k, v);
    }
    return v;
  };
  const _segMemo = new Map();
  const segAtM = (j, t) => {
    const k = j + '@' + t;
    let v = _segMemo.get(k);
    if (v === undefined) {
      v = segAt(j, t);
      _segMemo.set(k, v);
    }
    return v;
  };
  // MEMOIZED: the side a curve's patch lies on is a property of the curve and the span, not of
  // which other curve's extension happens to be under test. Recomputing it for every
  // (curve, region, constraint) triple would scan for an interior point and sample a resultant
  // along the whole span each time.
  const _orientMemo = new Map();
  const orientOf = (j) => {
    let v = _orientMemo.get(j);
    if (v === undefined) {
      const dj0 = polyImplicit(curvesA[j]);
      v = dj0 ? orientAcross(segAll2, j, dj0.deg) : 0;
      _orientMemo.set(j, v);
    }
    return v;
  };
  const coverLines = movingCover(curvesA, curvesB);
  let regions = 0,
    certified = 0,
    boxes = 0,
    overBudget = false,
    overTime = false;
  const maxBoxes = opts.maxBoxes > 0 ? opts.maxBoxes : 0;
  const deadline = opts.deadline > 0 ? opts.deadline : 0; // see certifyMorphClip
  const failures = [];
  curvesLoop: for (let i = 0; i < n; i++) {
    if (!polyImplicit(curvesA[i])) continue;
    // Memoized per pose: all fourteen graded regions of this curve walk the same extension, and
    // building it is two blossoms over a span seven times the arc.
    const _extMemo = new Map();
    const extAt = (t) => {
      let v = _extMemo.get(t);
      if (v === undefined) {
        v = segSlice(segAtM(i, t), -T, 1 + T);
        _extMemo.set(t, v);
      }
      return v;
    };
    const ni = curvesA[i].P.length - 1;
    // Both stretches that are NOT the real arc. There is no margin in PARAMETER here, and that
    // is the point: a parameter margin is not a distance, and 0.06 of an arc's parameter is more
    // than a pixel on a twenty-pixel arc, so a parameter margin would skip every leak shallower
    // than that unseen and certify spans whose poses leak by pixels. What leakOf
    // actually excuses is a leak within tolPx of the arc's own ENDS, and that is a distance --
    // carried below as two more certifiable constraints rather than a fudge on the domain.
    const m = 0;
    // Graded toward the arc's own ends. One grid per whole stretch is where the endpoint test
    // falls apart: over a stretch three curve-lengths long the squared distance to the endpoint
    // runs from 9 down to 1e-6, and a degree-6 Bernstein fit of that cannot resolve the sign
    // within a tolerance of 1.9e-3 no matter how far the box is subdivided -- the cancellation
    // has already happened in the coefficients. Halving repeatedly toward the vertex gives the
    // boxes that actually need the test a stretch whose own scale is the tolerance's.
    //
    const spans = [];
    for (const [a0, b0, endAt1] of /** @type {Array<[number,number,boolean]>} */ ([
      [0, Math.max(0, lo - m), true],
      [Math.min(1, hi + m), 1, false],
    ])) {
      if (!(b0 - a0 > 1e-9)) continue;
      let w = b0 - a0;
      for (let k = 0; k < 6; k++) {
        w /= 2;
        if (endAt1) spans.push([b0 - 2 * w, b0 - w]);
        else spans.push([a0 + w, a0 + 2 * w]);
      }
      // Only the last sliver is left over: the halvings above already tile everything up to it.
      if (endAt1) spans.push([b0 - w, b0]);
      else spans.push([a0, a0 + w]);
    }
    for (const [u0, u1] of spans) {
      if (!(u1 - u0 > 1e-12)) continue;
      // Before the region's grids, which are what a region costs.
      if (deadline && _clock() > deadline) {
        overBudget = overTime = true;
        failures.push({ i, u0, u1, why: 'plan deadline' });
        break curvesLoop;
      }
      regions++;
      // One grid per constraint, over this stretch, remapped to the unit square in s.
      const grids = [];
      const segOf0 = (t) => segSlice(extAt(t), u0, u1);
      let bad = /** @type {false|string} */ (false),
        sameCurve = false;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const nj = curvesA[j].P.length - 1;
        const dj = polyImplicit(curvesA[j]);
        if (!dj) {
          bad = 'polyImplicit(curve ' + j + ' ' + curvesA[j].t + ') null';
          break;
        }
        const degS = dj.deg * Math.max(ni, nj);
        const degT = 3 * dj.deg;
        const segOf = segOf0;
        // ONE context per t, shared by the value grid and both gradient grids: they sample the
        // same implicit along the same sliced curve and differ only in which polynomial they
        // evaluate, so building it three times would be three times the resultants and three
        // times the blossoms for one answer.
        const perT = (tv) => {
          const F = implAt(j, tv);
          return F ? { F, sg: segOf(tv) } : null;
        };
        const g = bivSample(perT, (c, sv) => evalAlong(c.F, c.sg, sv, dj.deg), degS, degT);
        if (!g) {
          bad = 'bivGrid j=' + j;
          break;
        }
        // ORIENT FROM THE PATCH INTERIOR, not from the grid. The grid samples f_j along curve i's
        // EXTENSION, which lies mostly OUTSIDE the patch, so its dominant coefficient carries the
        // outside sign and flipping by it inverts the whole test — which is why nothing certified
        // at any margin. The sign that matters is the one the renderer uses: f_j positive where
        // the patch is.
        const sj = orientOf(j);
        if (!sj) {
          bad = 'orientOf(' + j + ') inconsistent across the morph';
          break;
        }
        // CURVE i'S EXTENSION RUNS ALONG CURVE j -- two pieces of one cubic, split at an
        // inflection or separated by a cut. They bound the patch along the same algebraic curve,
        // so the extension is the patch's own boundary and encloses nothing. The sign there is
        // decided by rounding, which is why it is not a tolerance to widen.
        let gm = 0;
        for (const row of g) for (const v of row) gm = Math.max(gm, Math.abs(v));
        // The gradient rides along, so a constraint can be read in PIXELS rather than against its
        // own largest coefficient -- which is a different question, and the one that left five
        // failures on spans of zero width.
        const gx = bivSample(
          (tv) => {
            const F = implAt(j, tv);
            return F ? { F: polyDx(F), sg: segOf(tv) } : null;
          },
          (c, sv) => evalAlong(c.F, c.sg, sv, dj.deg),
          degS,
          degT,
        );
        const gy = bivSample(
          (tv) => {
            const F = implAt(j, tv);
            return F ? { F: polyDy(F), sg: segOf(tv) } : null;
          },
          (c, sv) => evalAlong(c.F, c.sg, sv, dj.deg),
          degS,
          degT,
        );
        if (!gx || !gy) {
          bad = 'gradient grid j=' + j;
          break;
        }
        // CURVE i'S EXTENSION RUNS ALONG CURVE j -- two pieces of one cubic, split at an
        // inflection or separated by a cut. They bound the patch along the same algebraic curve,
        // so the extension is the patch's own boundary and encloses no area; the case where that
        // boundary runs past curve j's drawn arc is a leak of CURVE j, found on j's own pass.
        //
        // As a distance. Against the implicit's own magnitude this is noise over noise: a cubic
        // that is nearly a quadratic has a resultant of 1e-10 everywhere, so a composition of
        // 1e-16 along it reads as a ratio of 1e-6 and no threshold on that ratio means anything.
        // Divided by the gradient it is a length, and a length has a scale to be small against.
        const gLo = Math.max(loAbs(gx), loAbs(gy));

        if (gLo > 0 && gm < 1e-3 * tolN * gLo) {
          sameCurve = true;
          break;
        }
        // The gradients do not go into the stack. They are read once, just above, to turn the
        // same-curve test into a distance; the box test itself is strict and never looks at them.
        // Carried along they would be split, allocated and re-bounded at every one of up to 2^16
        // boxes -- three grids where one is needed, and most of this function's runtime.
        grids.push({ g: g.map((r) => r.map((v) => v * sj)) });
      }
      // THE COVER IS A CONSTRAINT TOO, and leaving it out is why nothing certified. A patch is
      // bounded not only by its curves' half-spaces — which are unbounded — but by the cover the
      // renderer clips it to, exactly as leakOf clips the extension by patch.cover before looking
      // at anything else. Without it an extension that runs far away still satisfies every
      // half-space and reads as a leak, which is a false alarm and not a rare one.
      //
      // The hull of both poses' control points serves for every t at once: an intermediate pose's
      // control points are convex combinations of the two, so they stay inside it, and its edges
      // are therefore CONSTANTS rather than functions of t — no combinatorial change to track.
      if (sameCurve) {
        certified++;
        continue;
      }
      // Not a leak if it is within tolPx OF THE ARC'S own ENDS, which is exactly the escape leakOf
      // takes. Squared distance to a moving endpoint is a polynomial in (s, t) like everything
      // else here, so it certifies a box outright instead of being carved out of the domain.
      for (const end of [0, 1]) {
        const near = bivSample(
          (tv) => ({ sg: segOf0(tv), e: segPt(segAtM(i, tv), end) }),
          (c, sv) => {
            const pt = pointH(c.sg, sv);
            return (
              tolN * tolN * pt[2] * pt[2] -
              ((pt[0] - c.e[0] * pt[2]) ** 2 + (pt[1] - c.e[1] * pt[2]) ** 2)
            );
          },
          2 * ni,
          2,
        );
        if (near) grids.push({ g: near, near: true });
      }
      // A cover line's normal is a unit vector, so its value already IS a distance and needs no
      // gradient to be read in pixels.
      for (const h of coverLines) {
        const g = bivSample(
          (tv) => ({ sg: segOf0(tv), off: h.cA + (h.cB - h.cA) * tv }),
          (c, sv) => {
            const pt = pointH(c.sg, sv);
            return h.n[0] * pt[0] + h.n[1] * pt[1] + c.off * pt[2];
          },
          Math.max(1, ni),
          2,
        );
        if (g) grids.push({ g, unit: true });
      }
      if (bad || !grids.length) {
        failures.push({ i, u0, u1, why: bad || 'no constraint grids' });
        continue;
      }
      // Drop what cannot decide anything. A constraint excludes a box by being negative over the
      // whole of it, so one whose minimum over the ENTIRE region is already non-negative cannot
      // exclude any sub-box of it, ever; a `near` test succeeds by being non-negative over the
      // whole box, so one that is negative everywhere in the region cannot either. Both are
      // carried through every level of subdivision otherwise -- split, allocated and re-bounded
      // at each of 2^16 boxes -- for an answer already known at the top. Dropping them is the
      // difference between a certificate that costs seconds for one patch and one that does not.
      const live = grids.filter((c) => (c.near ? gridMax(c.g) >= 0 : gridMin(c.g) < 0));
      if (!live.length) {
        failures.push({ i, u0, u1, why: 'no constraint can exclude' });
        continue;
      }

      // THE s DIMENSION IS SOLVED, NOT SUBDIVIDED.
      //
      // What is left after intersecting is where a leak could still be, for some pose in the
      // interval. Empty means certified with no subdivision in s at all; non-empty splits t and
      // asks again, and t alone converges because the answer varies smoothly in it.
      const envHi = (g) =>
        g.map((row) => {
          let m = -Infinity;
          for (const v of row) if (v > m) m = v;
          return m;
        });
      const envLo = (g) =>
        g.map((row) => {
          let m = Infinity;
          for (const v of row) if (v < m) m = v;
          return m;
        });
      const clipTo = (feas, iv) => {
        const out = [];
        for (const [c0, c1] of iv)
          for (const [f0, f1] of feas) {
            const lo2 = Math.max(c0, f0),
              hi2 = Math.min(c1, f1);
            if (hi2 - lo2 > 1e-9) out.push([lo2, hi2]);
          }
        return out;
      };
      const subtract = (feas, iv) => {
        let out = feas;
        for (const [c0, c1] of iv) {
          const nx = [];
          for (const [f0, f1] of out) {
            if (c1 <= f0 || c0 >= f1) {
              nx.push([f0, f1]);
              continue;
            }
            if (c0 - f0 > 1e-9) nx.push([f0, c0]);
            if (f1 - c1 > 1e-9) nx.push([c1, f1]);
          }
          out = nx;
        }
        return out;
      };
      // Whether a leak can survive anywhere in this t-interval, and how much slack the envelopes
      // still have. Both come from the same pass, since the envelopes are what the answer is made
      // of and recomputing them to ask the second question doubles the work.
      const leakIn = (gs2) => {
        let feas = [[0, 1]],
          spread = 0,
          mag = 0;
        const his = [],
          los = [];
        for (const c of gs2) {
          const hi = envHi(c.g),
            lo = envLo(c.g);
          his.push(hi);
          los.push(lo);
          for (let a = 0; a < hi.length; a++) {
            if (hi[a] - lo[a] > spread) spread = hi[a] - lo[a];
            const m = Math.max(Math.abs(hi[a]), Math.abs(lo[a]));
            if (m > mag) mag = m;
          }
        }
        for (let k = 0; k < gs2.length; k++) {
          if (gs2[k].near) continue;
          feas = clipTo(feas, nonNegIntervals(his[k]));
          if (!feas.length) return null;
        }
        for (let k = 0; k < gs2.length; k++) {
          if (!gs2[k].near) continue;
          feas = subtract(feas, nonNegIntervals(los[k]));
          if (!feas.length) return null;
        }
        return { feas, spread, mag };
      };
      /** @type {Array<[Array<{g:number[][],near?:boolean,unit?:boolean}>, number, number, number]>} */
      const stack = [[live, 0, 1, 0]];
      let uncert = null;
      while (stack.length) {
        const [gs, t0, t1, d] = stack.pop();
        boxes++;
        // See the clip direction: a budget checked between CALLS is not a bound, because one call
        // can pop tens of thousands of boxes. Giving up is conservative -- an un-settled region
        // reads as uncertified, which the caller already treats as a failure.
        if (maxBoxes > 0 && boxes > maxBoxes) {
          overBudget = true;
          uncert = [t0, t1];
          break;
        }
        if (deadline && (boxes & 255) === 0 && _clock() > deadline) {
          overBudget = overTime = true;
          uncert = [t0, t1];
          break;
        }
        const res = leakIn(gs);
        if (!res) continue; // no pose in this interval can leak here
        // Converged envelopes are the answer. Splitting t tightens them and nothing else, so once
        // the spread is negligible against the constraints' own magnitude the next level asks the
        // identical question -- and on the short spans a bisecting planner lives in, that point
        // arrives within a few levels while the depth cap is sixteen.
        if (res.spread <= 1e-6 * (res.mag + 1) || d >= maxDepth) {
          // A confirmed leak ends the region. Refining the rest of the t range cannot change the
          // verdict -- the region has already failed -- and the planner only asks IF it failed.
          // Left running, the search would keep splitting toward a leak it had already found:
          // over a million t-intervals on one region of one patch.
          uncert = [t0, t1];
          break;
        }
        // Nothing varies in t on a static span, so splitting it can never change the envelopes.
        const tVaries = gs.some((c) => {
          for (const row of c.g)
            for (let j = 1; j < row.length; j++) if (Math.abs(row[j] - row[0]) > 1e-12) return true;
          return false;
        });
        if (!tVaries) {
          uncert = [t0, t1];
          break;
        }
        const tm = (t0 + t1) / 2;
        const halves = gs.map((c) => {
          const [a2, b2] = splitT(c.g);
          return [
            { g: a2, near: c.near, unit: c.unit },
            { g: b2, near: c.near, unit: c.unit },
          ];
        });
        stack.push([halves.map((h) => h[0]), t0, tm, d + 1]);
        stack.push([halves.map((h) => h[1]), tm, t1, d + 1]);
      }
      if (uncert) failures.push({ i, t0: +uncert[0].toFixed(4), t1: +uncert[1].toFixed(4) });
      else certified++;
    }
  }
  return { ok: failures.length === 0, regions, boxes, overBudget, overTime, certified, failures };
}

// ---- decomposition transfer -------------------------------------------------------------
/// EXTRACT a patch's decomposition as PARAMETRIC references rather than geometry.

/// A layout says something the far pose cannot refuse: which original curve each piece came from
/// and over which parameter range. Sliced from the other pose's curve k over the same [a, b], the
/// combinatorial structure is identical BY CONSTRUCTION — same patch count, same curve counts,
/// paired without anything having to succeed. Whether the result is VALID is a separate question,
/// and the one certifyMorphClip/certifyMorphLeak answer.
///
/// A seam carries no curve of its own, so it is stored as the two endpoints it joins, each named
/// as (curve, parameter) taken from the neighboring pieces.
/// Three well-separated points of the contour, to express anything provenance cannot reach.
/// THESE RUN ON THE POSE, NOT ON THE NORMALIZED PAIR, so their bars are in the drawing's own units
/// and an absolute one asks a different question at every size. The area is
/// priced against the anchor points' own extent squared, and the barycentric divisor against the
/// two edges it crosses -- |a x b| = |a||b| sin(t), so that one is dimensionless outright.
function anchorsOf(curves) {
  const pts = curves.map((c, k) => ({ k, p: c.P[0] }));
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const { p } of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const ext = Math.max(x1 - x0, y1 - y0);
  let best = null,
    bestA = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let m = j + 1; m < pts.length; m++) {
        const A = pts[i].p,
          B = pts[j].p,
          C = pts[m].p;
        const a = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]));
        if (a > bestA) {
          bestA = a;
          best = [pts[i].k, pts[j].k, pts[m].k];
        }
      }
  // The LARGEST triangle the contour's start points admit: below one float64 ulp of the point set's
  // own area those points are collinear, and there are no anchors to be had at any size.
  return bestA > ext * ext * 2 ** -52 ? best : null;
}
const baryOf = (p, A, B, C) => {
  const d = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
  if (
    !(
      Math.abs(d) >
      Math.hypot(B[0] - A[0], B[1] - A[1]) * Math.hypot(C[0] - A[0], C[1] - A[1]) * 2 ** -52
    )
  )
    return null;
  const b = ((p[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (p[1] - A[1])) / d;
  const c = ((B[0] - A[0]) * (p[1] - A[1]) - (p[0] - A[0]) * (B[1] - A[1])) / d;
  return [1 - b - c, b, c];
};

export function extractLayout(patches, curves) {
  // Endpoints alone cannot replay an arc crossing the root parameter's pole.
  for (const patch of patches)
    for (const c of patch.curves) {
      const source = c._src;
      if (!source) continue;
      if (!Number.isFinite(source.a) || !Number.isFinite(source.b)) return null;
      if (source.map) {
        const map = source.map,
          denominator0 = map[3],
          denominator1 = map[2] + map[3];
        if (
          !map.every(Number.isFinite) ||
          !denominator0 ||
          !denominator1 ||
          Math.sign(denominator0) !== Math.sign(denominator1)
        )
          return null;
      }
    }
  const anch = curves ? anchorsOf(curves) : null;
  const AP = anch ? anch.map((k) => curves[k].P[0]) : null;
  const out = [];
  for (const p of patches) {
    const n = p.curves.length;
    const items = p.curves.map((s) =>
      s._src
        ? { k: s._src.k, a: s._src.a, b: s._src.b, cut: !!s.cut, bez: !!s._bez }
        : { seam: true, cut: !!s.cut },
    );
    for (let i = 0; i < n; i++) {
      if (!items[i].seam) continue;
      const prev = items[(i - 1 + n) % n],
        next = items[(i + 1) % n];
      // exact where provenance reaches: a seam end that coincides with a neighboring arc's end
      // is that arc's endpoint, and transfers as a parameter on the same original curve.
      if (!prev.seam) items[i].from = { k: prev.k, u: prev.b };
      if (!next.seam) items[i].to = { k: next.k, u: next.a };
      // ...and BARYCENTRIC where it does not. A run of consecutive seams meets at points that lie
      // on no original curve — they are intersections of cut lines — so there is no parameter to
      // name. Expressed against three points of the contour they still transfer, exactly under an
      // affine morph and plausibly otherwise; the certificate is what decides whether the result
      // is valid, so an approximate anchor costs nothing but a possible refusal.
      if (!items[i].from || !items[i].to) {
        if (!AP) return null;
        const seg = p.curves[i];
        if (!items[i].from) items[i].fromB = baryOf(seg.P[0], AP[0], AP[1], AP[2]);
        if (!items[i].to) items[i].toB = baryOf(seg.P[seg.P.length - 1], AP[0], AP[1], AP[2]);
        if ((!items[i].from && !items[i].fromB) || (!items[i].to && !items[i].toB)) return null;
        items[i].anch = anch;
      }
    }
    out.push(items);
  }
  if (curves) unifySeamVertices(out, patches, curves, anch, AP);
  return out;
}

/// ONE DEFINITION PER SEAM VERTEX, SHARED BY every PATCH THAT HAS IT.
///
/// A layout names each seam end locally: the neighboring arc's end where the patch has one there, a
/// barycentric point against three contour anchors where it does not. Both reproduce the conversion
/// pose, and they agree about nothing else -- an arc end moves with its curve, a barycentric point
/// affinely with the anchors -- so wherever one vertex is named two ways, a morph that is not affine
/// pulls its copies apart. Two ways it is:

/// So the vertices are found first, and each gets ONE definition that every appearance uses: a
/// point on its original curve where any patch reaches it along an arc; else, where it sits strictly
/// inside a line of collinear, touching seams, a fixed fraction of the way between that line's two
/// extreme vertices (so it stays on the line at every pose); else one barycentric point. Every one of
/// those is linear in the pose, so the certificate's "an intermediate pose is the lerp of the span's
/// ends" still holds exactly.
///
/// "The same point" and "on the line" are decided at the conversion pose against the contour's own
/// extent. On that ring the copies of one vertex sit within 1.5e-6 of the extent of each other (the
/// converter reaches a cut's end by two routes), a junction within 7e-7 of its line, and the nearest
/// vertex that is neither 3e-4 away; 2^-16 (1.5e-5) separates them by a factor of ten or more on
/// either side, at any scale.
function unifySeamVertices(out, patches, curves, anch, AP) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of curves)
    for (const q of c.P) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
  const ext = Math.max(x1 - x0, y1 - y0);
  if (!(ext > 0 && Number.isFinite(ext))) return;
  const tol = ext * 2 ** -16;
  // Every seam end, and the vertex it is.
  const verts = [],
    seams = [];
  const vertexOf = (q, seamKey) => {
    for (let m = 0; m < verts.length; m++) {
      const v = verts[m];
      if (Math.hypot(v.q[0] - q[0], v.q[1] - q[1]) <= tol && !v.seams.has(seamKey)) {
        v.seams.add(seamKey);
        return m;
      }
    }
    verts.push({ q, seams: new Set([seamKey]), curve: null, ends: [] });
    return verts.length - 1;
  };
  for (let p = 0; p < out.length; p++)
    for (let i = 0; i < out[p].length; i++) {
      const it = out[p][i];
      if (!it.seam) continue;
      const P = patches[p].curves[i].P,
        key = p + ':' + i;
      const s = { p, i, a: P[0], b: P[P.length - 1] };
      s.va = vertexOf(s.a, key);
      s.vb = vertexOf(s.b, key);
      for (const [m, prov, end] of [
        [s.va, it.from, 0],
        [s.vb, it.to, 1],
      ]) {
        if (prov && !verts[m].curve) verts[m].curve = { k: prov.k, u: prov.u };
        verts[m].ends.push([p, i, end]);
      }
      seams.push(s);
    }
  // Lines: collinear seams whose spans along the line touch, grouped transitively.
  const offLine = (s, q) => {
    const dx = s.b[0] - s.a[0],
      dy = s.b[1] - s.a[1],
      L = Math.hypot(dx, dy);
    return L > 0 ? Math.abs(dx * (q[1] - s.a[1]) - dy * (q[0] - s.a[0])) / L : Infinity;
  };
  const along = (s, q) => {
    const dx = s.b[0] - s.a[0],
      dy = s.b[1] - s.a[1];
    return ((q[0] - s.a[0]) * dx + (q[1] - s.a[1]) * dy) / Math.hypot(dx, dy);
  };
  const par = seams.map((_, k) => k);
  const find = (k) => {
    while (par[k] !== k) {
      par[k] = par[par[k]];
      k = par[k];
    }
    return k;
  };
  for (let m = 0; m < seams.length; m++)
    for (let n = m + 1; n < seams.length; n++) {
      const s = seams[m],
        r = seams[n];
      if (!(
        offLine(s, r.a) <= tol &&
        offLine(s, r.b) <= tol &&
        offLine(r, s.a) <= tol &&
        offLine(r, s.b) <= tol
      ))
        continue;
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const u0 = Math.min(along(s, r.a), along(s, r.b)),
        u1 = Math.max(along(s, r.a), along(s, r.b));
      if (u1 < -tol || u0 > L + tol) continue;
      par[find(m)] = find(n);
    }
  const groups = new Map();
  for (let k = 0; k < seams.length; k++) {
    const g = find(k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(seams[k]);
  }
  const onLine = new Map(); // vertex -> { e0, e1, lam }, the first line it is inside
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let ref = g[0];
    for (const s of g)
      if (
        Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) >
        Math.hypot(ref.b[0] - ref.a[0], ref.b[1] - ref.a[1])
      )
        ref = s;
    let lo = null,
      hi = null;
    for (const s of g)
      for (const m of [s.va, s.vb]) {
        const u = along(ref, verts[m].q);
        if (!lo || u < lo.u) lo = { u, m };
        if (!hi || u > hi.u) hi = { u, m };
      }
    const span = hi.u - lo.u;
    if (!(span > tol)) continue;
    for (const s of g)
      for (const m of [s.va, s.vb]) {
        const u = along(ref, verts[m].q);
        if (u - lo.u > tol && hi.u - u > tol && !onLine.has(m))
          onLine.set(m, { e0: lo.m, e1: hi.m, lam: (u - lo.u) / span });
      }
  }

  const defs = new Array(verts.length),
    busy = new Set();
  const defOf = (m) => {
    if (defs[m]) return defs[m];
    const v = verts[m];
    let d = null;
    if (v.curve) d = { k: v.curve.k, u: v.curve.u };
    else if (onLine.has(m) && !busy.has(m)) {
      busy.add(m);
      const L = onLine.get(m),
        d0 = defOf(L.e0),
        d1 = defOf(L.e1);
      busy.delete(m);
      if (d0 && d1) d = { e0: d0, e1: d1, lam: L.lam };
    }
    if (!d && AP) {
      const b = baryOf(v.q, AP[0], AP[1], AP[2]);
      if (b) d = { b, anch };
    }
    defs[m] = d;
    return d;
  };
  for (let m = 0; m < verts.length; m++) {
    const d = defOf(m);
    if (!d) continue;
    for (const [p, i, end] of verts[m].ends) {
      const it = out[p][i];
      // An end the patch reaches along its own arc is that arc's end already.
      if (end === 0 ? it.from : it.to) continue;
      it[end === 0 ? 'fromV' : 'toV'] = d;
    }
  }
}

/// REBUILD the same decomposition on another pose's curves.
export function applyLayout(layout, curves) {
  const out = [];
  const builtAll = [];
  for (const items of layout) {
    const n = items.length;
    // Arcs first. Every piece with provenance is exact — slice curve k over [a, b], and ranges
    // outside [0,1] are legitimate because a curved seam is itself a slice of an extension and
    // segSlice carries the blossom past the ends.
    const built = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      if (it.seam) continue;
      const base = curves[it.k];
      if (!base) return null;
      // A whole curve is the curve. Slicing it over [0, 1] through the blossom rebuilds the same
      // control points a rounding step off; the converter passes an uncrossed curve through as
      // itself, so a rebuilt layout should too, or the geometry drifts an ulp per application.
      const piece =
        it.a === 0 && it.b === 1
          ? {
              t: base.t,
              P: base.P,
              w: base.w,
              _src: { k: it.k, a: 0, b: 1 },
              _srcP: base._srcP || (base.t === 'cubic' ? base.P : undefined),
            }
          : segSlice(base, it.a, it.b);
      if (!piece) return null;
      if (piece.w === undefined) delete piece.w;
      if (piece._srcP === undefined) delete piece._srcP;
      if (it.cut) piece.cut = true;
      if (it.bez) piece._bez = true;
      // THE FROZEN CONDITIONING, if this layout has been through freezeLayoutNorms. A layout IS
      // a morph segment, so a constant stored on it is constant for exactly the right span.
      if (it._nrm) piece.nrm = it._nrm;
      built[i] = piece;
    }

    // SEAMS TAKE THEIR ENDS FROM THE NEIGHBORS THEY actually JOIN, not from a stored anchor.
    // A patch is a closed loop, and a seam end that lands even slightly off its neighbor's end
    // opens a gap — after which the loop is not the region it is supposed to bound and every
    // patch containing one reads as leaking. Stored references reproduce the source pose exactly
    // and drift the moment the pose changes, so a transfer by stored references is valid at t = 0
    // and invalid at every t after it.
    //
    // A run of consecutive seams still needs interior vertices, and those genuinely lie on no
    // curve — they are intersections of cut lines. Those keep the barycentric anchor; only the
    // run's two ENDS are pinned to real neighbors, which is what closure needs.
    const at = (i) => ((i % n) + n) % n;
    const endOf = (b) => b.P[b.P.length - 1];
    // A shared vertex (unifySeamVertices): a point on its original curve, a fraction of the way along
    // a line between two other vertices, or a barycentric point.
    const vertexPt = (d) => {
      if (d.k != null) {
        const c = curves[d.k];
        return c ? segPt(c, d.u) : null;
      }
      if (d.b) return anchPt(d, d.b);
      const A = vertexPt(d.e0),
        B = vertexPt(d.e1);
      return A && B ? [A[0] + (B[0] - A[0]) * d.lam, A[1] + (B[1] - A[1]) * d.lam] : null;
    };
    const anchPt = (it, b) => {
      if (!b || !it.anch) return null;
      const A = curves[it.anch[0]].P[0],
        B = curves[it.anch[1]].P[0],
        C = curves[it.anch[2]].P[0];
      return [b[0] * A[0] + b[1] * B[0] + b[2] * C[0], b[0] * A[1] + b[1] * B[1] + b[2] * C[1]];
    };
    for (let i = 0; i < n; i++) {
      if (!items[i].seam) continue;
      const prev = built[at(i - 1)],
        next = built[at(i + 1)];
      // A patch can be ALL seams — a triangle of cut lines has no arc to pin to — in which case
      // every vertex is a stored anchor and there is nothing to pin against.
      const from = prev
        ? endOf(prev)
        : items[i].fromV
          ? vertexPt(items[i].fromV)
          : anchPt(items[i], items[i].fromB);
      const to = next
        ? next.P[0]
        : items[i].toV
          ? vertexPt(items[i].toV)
          : anchPt(items[i], items[i].toB);
      if (!from || !to) return null;
      built[i] = { t: 'line', P: [from, to], cut: true };
      if (items[i]._nrm) built[i].nrm = items[i]._nrm;
    }
    if (built.some((b) => !b)) return null;
    builtAll.push(built);
  }
  for (const built of builtAll) {
    // A seam whose two ends coincide (to the coordinates' precision) is not a constraint: its
    // normal is noise, and in one direction it cuts the patch in half. The cutter does not emit
    // them; an older baked layout can still carry one.
    // THE PATCH'S own EXTENT, not the largest coordinate plus one. `max|q|` is a distance from the
    // ORIGIN, so a bar from it would move when the artwork is translated as well as when it is scaled,
    // and a `+ 1` would make it a flat 1e-6 for any drawing smaller than a unit -- which is a whole glyph.
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const b of built)
      for (const q of b.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    const sc = Math.max(x1 - x0, y1 - y0);
    const kept = built.filter(
      (b) =>
        !(
          b.t === 'line' &&
          b.cut &&
          Math.hypot(b.P[1][0] - b.P[0][0], b.P[1][1] - b.P[0][1]) <= 1e-6 * sc
        ),
    );
    if (kept.length < 2) return null;
    out.push(kept);
  }
  return out;
}

/// FREEZE this layout's conditioning constants at one pose, so every pose it is later applied to
/// derives the same implicit up to a positive scale rather than its own.
///
/// The constants are chosen for numerical conditioning and any positive value is correct — but
/// they are maxima and sums of absolute values, so they KINK as the pose moves, and dividing by
/// something that kinks is exactly what stops a morphing curve's packed coefficients from being
/// a polynomial in t. Frozen, they are degree 2 in t, and three static planes reconstruct a whole
/// segment instead of the CPU repacking one every frame.
///
/// Called once per segment, at its own t0. Returns false if the layout does not apply there,
/// which leaves it underived and behaving exactly as it did before.
export function freezeLayoutNorms(layout, curves) {
  const loops = applyLayout(layout, curves);
  if (!loops || loops.length !== layout.length) return false;
  for (let i = 0; i < layout.length; i++) {
    if (loops[i].length !== layout[i].length) return false;
    for (let j = 0; j < layout[i].length; j++) layout[i][j]._nrm = segNorm(loops[i][j]);
  }
  return true;
}

// ---- planning a morph that is valid everywhere ------------------------------------------
/// PLAN a morph as a sequence of t-intervals, each with a decomposition CERTIFIED over it.
///
/// A single decomposition need not survive a whole morph, and no amount of choosing a better one
/// changes that — a heavily cut patch set can stop being a patch set a few percent in. The answer
/// is not to refuse the morph but to REDECOMPOSE: walk t forward, and wherever the certificate
/// stops, convert the pose at that point and carry on from there. Every frame is then drawn with
/// a decomposition proven valid at its own t.

/// Returns [{ t0, t1, layout }] covering [0,1], or null if a pose cannot be converted at all.
export function planMorph(curvesA, curvesB, convert, opts = {}) {
  // ONE BAR FOR THE whole PLAN, scaled to the pair (morphTolPx). It reaches the two
  // certificates, `validatePatch` on every sampled pose, and -- through `leakMargin` below -- the
  // source decomposition itself, so a flat default set the standard for all three from a constant.
  const tol = opts.tolPx != null ? opts.tolPx : morphTolPx(curvesA, curvesB);
  const minStep = opts.minStep != null ? opts.minStep : 1 / 512;
  // Matched to minStep, so the cap is the floor's own consequence rather than a second, tighter
  // limit that reports failure on a morph the floor could still have walked.
  const maxSegments = opts.maxSegments != null ? opts.maxSegments : 512;

  const leakMargin = opts.leakMargin != null ? opts.leakMargin : tol;
  const poseAt = (t) =>
    curvesA.map((c, i) => ({
      t: c.t,
      cut: c.cut,
      w: c.w,
      P: c.P.map((q, k) => [
        q[0] + (curvesB[i].P[k][0] - q[0]) * t,
        q[1] + (curvesB[i].P[k][1] - q[1]) * t,
      ]),
    }));

  // THE CERTIFICATE'S own WORK, COUNTED. Counted here so the
  // caller can see the shape of its own cost, and capped below so a pathological pair fails in
  // seconds instead of blocking a worker for two minutes.
  // `opts.report` is the same object, handed in by a caller that needs it even when the plan comes
  // back NULL.
  const work = opts.report || {};
  Object.assign(work, {
    certCalls: 0,
    clipPairs: 0,
    leakRegions: 0,
    poseChecks: 0,
    segments: 0,
    forced: 0,
    uncertified: false,
    unsupportedWeights: false,
    overBudget: false,
    exhausted: false,
    budget: 0,
    clipBoxes: 0,
    leakBoxes: 0,
    convertMs: 0,
    certMs: 0,
    poseMs: 0,
    converts: 0,
  });
  const issue = rationalPairIssue(curvesA, curvesB);
  if (issue) {
    work.uncertified = work.unsupportedWeights = true;
    work.overTime = false;
    work.elapsedMs = 0;
    work.lastFail = issue;
    return null;
  }
  // WHERE THE TIME GOES, PER PHASE: the phases are timed separately so any cliff can be bounded.
  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  let lastFail = null;
  const budget =
    opts.maxCertCalls != null
      ? opts.maxCertCalls
      : mantleDebugHook('__CP_MORPH_CERT_BUDGET') > 0
        ? mantleDebugHook('__CP_MORPH_CERT_BUDGET')
        : 20000;
  // ...AND A BUDGET IN THE UNIT THE TIME IS actually SPENT IN, WHICH IS THE BOX.
  //
  // A certificate CALL is not a fixed amount of work, and neither is a `pair` or a `region`: both
  // certifiers subdivide until every (s, t) box is settled, and `pairs` / `regions` count proofs
  // ATTEMPTED. The cliff is the subdivision inside ONE certificate, not the
  // number of spans the t axis is cut into.
  //
  // THE DEFAULT IS A RUNAWAY GUARD, NOT THE BOUND. Morphs of cubic blobs are the expensive
  // family: when the converter may cut along an arc's own end tangent, they can take tens of
  // millions of boxes and hundreds of segments (quadratic and rational-quadratic morphs stay under
  // 58k boxes). 64e6 sits a little over twice the worst of those (27,151,689 boxes, a K=8 cubic blob at
  // rotation 1), so a lower budget would drop morphs that plan -- a drawn-output decision, which is why
  // this stays a guard. In that regime the
  // SEGMENT cap (`maxSegments`) binds before the box budget does. A caller that wants a real bound
  // passes `maxCertWork`, and the decline reports the reason.
  //
  // THE EXPENSIVE CASE HAS ONE CAUSE, AND IT IS NOT THE CERTIFICATE. A seam along an arc's own END
  // TANGENT cannot survive being transferred by its endpoints: every layout holding one leaks the
  // moment the pose moves, the certificate refuses every span it is handed, and the planner walks the
  // morph a minStep at a time. cutCandidates does not offer those lines under a morph, and without
  // them the hardest cases plan in a few segments and under 70k boxes.
  //
  const workBudget =
    opts.maxCertWork != null
      ? opts.maxCertWork
      : mantleDebugHook('__CP_MORPH_WORK_BUDGET') > 0
        ? mantleDebugHook('__CP_MORPH_WORK_BUDGET')
        : 64e6;
  work.budget = budget;
  work.workBudget = workBudget;
  let overBudget = false;
  const spent = () => work.clipBoxes + work.leakBoxes;
  // ...AND A BOUND IN THE UNIT A RENDERER WAITS IN, WHICH IS TIME. A box is not a fixed amount of
  // work -- a leak region builds a dozen resultant grids before it pops one, and a conversion pops
  // none -- so a box budget bounds a plan at whatever its boxes happen to cost: 64e6 of them can
  // be minutes. What the renderer actually spends is WALL TIME: the morph draws with its fallback
  // engine until the plan lands, and a plan that has not landed after a few seconds has missed
  // every morph short enough to be animated in them. So the planner carries a deadline, read before
  // every conversion, every certificate pair and leak region, every sampled pose, and every 256
  // boxes of either subdivision, and a plan that meets it returns NULL -- a clean decline, reported
  // as `overTime`, after which the caller keeps its engine exactly as for any other refusal.
  //
  const planMs = opts.maxPlanMs != null ? opts.maxPlanMs : 5000;
  const tPlan0 = now();
  const deadline = planMs > 0 && Number.isFinite(planMs) ? tPlan0 + planMs : 0;
  work.planMs = planMs;
  let overTime = false;
  const late = () => (deadline > 0 && now() > deadline ? (overTime = true) : false);
  // Every way out that declines for work, in one place, so the report says which bound it was.
  const decline = () => {
    work.overBudget = overBudget;
    work.overTime = overTime;
    work.segments = segments.length;
    work.elapsedMs = now() - tPlan0;
    return null;
  };

  /// Is this layout certified across the whole span between two poses?
  const certifiedOn = (layout, p0, p1) => {
    if (overTime || late()) return false;
    const _t = now();
    const r = certifiedOnInner(layout, p0, p1);
    work.certMs += now() - _t;
    return r;
  };
  const certifiedOnInner = (layout, p0, p1) => {
    const A = applyLayout(layout, p0),
      B = applyLayout(layout, p1);
    if (!A || !B || A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++) {
      if (A[i].length !== B[i].length) return false;
      work.certCalls++;
      if (work.certCalls > budget) {
        overBudget = true;
        return false;
      }
      if (late()) return false;
      const c = certifyMorphClip(A[i], B[i], {
        tolPx: tol,
        maxBoxes: Math.max(1, workBudget - spent()),
        deadline,
      });
      // THE CERTIFICATE SAYS HOW MUCH IT PROVED, and both numbers are kept.
      // `pairs` is how many (curve, constraint) pairs the clip certificate had to bound and
      // `regions` how many boxes the leak certificate subdivided; together they are the cost of
      // the proof, per patch, and the only thing that tells a caller whether a slow plan is slow
      // because of its geometry or because of its segment count.
      work.clipPairs += c.pairs || 0;
      work.clipBoxes += c.boxes || 0;
      if (c.overTime) {
        overTime = true;
        return false;
      }
      if (spent() > workBudget) {
        overBudget = true;
        return false;
      }

      if (c.failures.length || c.inconclusive) {
        lastFail = {
          kind: c.failures.length ? 'clip' : 'inconclusive',
          patch: i,
          failures: c.failures.length,
          inconclusive: c.inconclusive || 0,
        };
        return false;
      }

      if (!opts.skipLeak) {
        const l = certifyMorphLeak(A[i], B[i], {
          tolPx: tol,
          eps: opts.eps,
          maxBoxes: Math.max(1, workBudget - spent()),
          deadline,
        });
        work.leakRegions += l.regions || 0;
        work.leakBoxes += l.boxes || 0;
        if (l.overTime) {
          overTime = true;
          return false;
        }
        if (spent() > workBudget) {
          overBudget = true;
          return false;
        }
        if (l.failures.length) {
          lastFail = { kind: 'leak', patch: i, failures: l.failures.length };
          return false;
        }
      }
    }
    return true;
  };

  // The Bernstein interpolation degree must bound the true degree. Interior
  // samples also reject candidates whose computed bounds are inconsistent.
  const VERIFY_N = opts.verifyPoses != null ? opts.verifyPoses : 3;
  const posesOk = (layout, a0, a1) => {
    if (overTime || late()) return false;
    const _t = now();
    const r = posesOkInner(layout, a0, a1);
    work.poseMs += now() - _t;
    return r;
  };
  const posesOkInner = (layout, a0, a1) => {
    if (VERIFY_N <= 0) return true;
    for (let k = 1; k <= VERIFY_N; k++) {
      if (late()) return false;
      const tv = a0 + ((a1 - a0) * k) / (VERIFY_N + 1);
      const loops = applyLayout(layout, poseAt(tv));
      work.poseChecks++;
      if (!loops) return false;
      for (const l of loops) {
        const fr = framePatch(l);
        // The sampled pose is held to the same bar the certificate was. Asking the validator a
        // question at one scale and the certificate the same question at another is how the two
        // disagree for reasons that are not about the geometry.
        if (!fr || !validatePatch(fr, tol).ok) return false;
      }
    }
    return true;
  };

  /** @type {any[] & {cert?:typeof work}} */
  const segments = [];
  // The plan carries its certificate work. Only certified spans are returned;
  // `uncertified` records a proof or interior-check refusal on a null result.
  // Keep `forced` and the segment flag for readers of the report format; every
  // successful plan has zero forced segments.
  segments.cert = work;
  let t0 = 0;
  for (let guard = 0; guard < maxSegments && t0 < 1 - 1e-9; guard++) {
    if (late()) return decline();
    const pose0 = poseAt(t0);
    // THE PLAIN SEARCH, not count-first: a layout of ear-clipped chords transfers worse across
    // poses (the morph plan smoke lost a pose to invalidity and 1.13% to over-fill with it on),
    // and a morph's build is not where the count-first time goes anyway.
    const _tc = now();
    const conv = convert(pose0, { leakMargin, countFirst: 0 });
    work.convertMs += now() - _tc;
    work.converts++;
    if (!conv || !conv.patches.length) return null;
    const layout = extractLayout(conv.patches, pose0);
    if (!layout) return null;

    freezeLayoutNorms(layout, pose0);
    // The whole remainder first — the common case is one segment, and probing it costs one test.
    if (certifiedOn(layout, pose0, poseAt(1)) && posesOk(layout, t0, 1)) {
      segments.push({ t0, t1: 1, layout, forced: false });
      work.segments = segments.length;
      work.lastFail = lastFail;
      work.elapsedMs = now() - tPlan0;
      return segments;
    }
    if (overBudget || overTime) return decline();
    // Otherwise the furthest certified reach — GALLOPING OUT, then refining.
    //
    // Bisecting [t0, 1] spends its full budget of probes whatever the answer is, and the answer
    // is often the floor: a plan of many segments can have most of them one minStep wide, each
    // paying a full bisection of certificate pairs to discover it. Doubling out from the floor finds a
    // short reach in one or two probes and a long one in about as many as bisection needed, so
    // the cost follows the answer instead of the search space.
    let lo = t0,
      hi = 1,
      best = null,
      step = minStep;
    while (t0 + step < 1 && certifiedOn(layout, pose0, poseAt(t0 + step))) {
      lo = t0 + step;
      best = lo;
      step *= 2;
    }
    hi = Math.min(1, t0 + step);
    for (let it = 0; it < 24 && hi - lo > minStep; it++) {
      const mid = (lo + hi) / 2;
      if (certifiedOn(layout, pose0, poseAt(mid))) {
        lo = mid;
        best = mid;
      } else hi = mid;
    }

    if (best == null) {
      work.uncertified = true;
      return decline();
    }
    let t1 = Math.min(1, best);
    // Halve a certified span until the interior checks agree, down to the
    // planning floor. If they still disagree, decline the whole plan.
    for (let k = 0; k < 10 && t1 - t0 > minStep && !posesOk(layout, t0, t1); k++)
      t1 = t0 + (t1 - t0) / 2;
    // Interior samples may expose a certificate/model disagreement. They can
    // reject a certified span, but cannot substitute for a continuum proof.
    const proved = posesOk(layout, t0, t1);
    if (!proved) {
      work.uncertified = true;
      return decline();
    }
    segments.push({ t0, t1, layout, forced: false });
    if (overBudget || overTime) return decline();
    t0 = t1;
  }
  work.segments = segments.length;
  work.lastFail = lastFail;
  work.elapsedMs = now() - tPlan0;
  if (t0 < 1 - 1e-9) work.exhausted = true; // maxSegments ran out: the cliff, hit
  return t0 >= 1 - 1e-9 ? segments : null;
}

/// The decomposition to draw at a given t, from a plan.
export function layoutAt(plan, t) {
  for (const s of plan) if (t >= s.t0 - 1e-9 && t <= s.t1 + 1e-9) return s.layout;
  return plan.length ? plan[plan.length - 1].layout : null;
}

// Split both poses at the same parameters, including sampled migrating
// inflections. Sampling proposes a layout; the interval certificate validates
// it before rendering.
export function splitForMorph(curvesA, curvesB, opts = {}) {
  const samples = opts.samples != null ? opts.samples : 9;
  const minGap = opts.minGap != null ? opts.minGap : 1 / 64;
  const cuts = curvesA.map(() => []);
  for (let si = 0; si < samples; si++) {
    const t = samples === 1 ? 0 : si / (samples - 1);
    for (let k = 0; k < curvesA.length; k++) {
      const a = curvesA[k],
        b = curvesB[k];
      if (a.t !== 'cubic' || !b || b.P.length !== a.P.length) continue;
      const P = a.P.map((q, i) => [q[0] + (b.P[i][0] - q[0]) * t, q[1] + (b.P[i][1] - q[1]) * t]);
      for (const u of inflectionsOf(P)) if (u > minGap && u < 1 - minGap) cuts[k].push(u);
    }
  }
  const splitOne = (curves) => {
    const out = [];
    for (let k = 0; k < curves.length; k++) {
      const us = cuts[k].slice().sort((x, y) => x - y);
      const keep = [];
      for (const u of us) if (!keep.length || u - keep[keep.length - 1] > minGap) keep.push(u);
      let prev = 0;
      for (const u of keep) {
        if (u - prev > minGap) {
          out.push(segSlice(curves[k], prev, u));
          prev = u;
        }
      }
      out.push(prev > 0 ? segSlice(curves[k], prev, 1) : curves[k]);
    }
    return out;
  };
  return [splitOne(curvesA), splitOne(curvesB)];
}

/// Inflection parameters of a cubic: cross(P', P'') = 0, a quadratic in s.
function inflectionsOf(P) {
  const [p0, p1, p2, p3] = P;
  const ax = 3 * (p1[0] - p0[0]),
    ay = 3 * (p1[1] - p0[1]);
  const bx = 3 * (p2[0] - 2 * p1[0] + p0[0]),
    by = 3 * (p2[1] - 2 * p1[1] + p0[1]);
  const cx = p3[0] - 3 * p2[0] + 3 * p1[0] - p0[0],
    cy = p3[1] - 3 * p2[1] + 3 * p1[1] - p0[1];
  // P'(s) = a + 2b s + 3c s^2 ; P''(s) = 2b + 6c s
  const A = 6 * (bx * cy - by * cx);
  const B = 6 * (ax * cy - ay * cx);
  const C = 2 * (ax * by - ay * bx);
  const out = [];
  // A, B and C ARE CROSS PRODUCTS of the power-basis coefficients, so each is |u||v| sin(t) and the
  // question "has the quadratic a leading term / a linear term" is a question about PARALLELISM,
  // which is dimensionless. A fixed 1e-14 would be 2^-64 of a 100-unit cubic's own product and
  // 2^36 of a glyph's, so it would decide nothing at one size and take the linear branch at the other.
  const par = (ux, uy, vx, vy) => Math.hypot(ux, uy) * Math.hypot(vx, vy) * 2 ** -52;
  if (Math.abs(A) < 6 * par(bx, by, cx, cy)) {
    if (Math.abs(B) > 6 * par(ax, ay, cx, cy)) out.push(-C / B);
  } else {
    const d = B * B - 4 * A * C;
    if (d >= 0) {
      const q = Math.sqrt(d);
      out.push((-B + q) / (2 * A), (-B - q) / (2 * A));
    }
  }
  return out.filter((u) => Number.isFinite(u));
}
