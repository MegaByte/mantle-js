// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBoxCov — the CPU twin of src/shaders/_boxCov.glsl.
//
// A LINE-FOR-LINE copy, not a re-derivation. The point of a CPU model of a shader is to say what
// the shader DOES, and a model that drifts from its kernel invalidates every measurement written
// against it (cpatchCov.js is the warning). So every function here mirrors one in _boxCov.glsl, the
// branch structure is the same, and the epsilons are the same literals.
//
// Validated by probes/lbAccuracy/_kernelSelfTest.mjs against brute-force supersampling of the very
// half-planes / chains it is handed, which is a check the GPU cannot do for us and does not need to.
//
// Modelled: exactBoxCov, exactBoxCov2, exactBoxCov3, bparamOf, cornerOf, chainFillSide, chainMissCov, chainBoxCov; and
// cbEval/cbEvalD/cbSolve/cbExtrema/cbDirStart/cbDirEnd/cbBetween/cbBorderP/cbToBorder, cubicChainBoxCov and
// cubicChain2BoxCov, whose shader text lives in _lbCoverage.glsl (only the Loop-Blinn program reads a cubic chain);
// cAtC/cTanC evaluate a cubic for the tests.

const V = (x, y) => [x, y];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);
const mix2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1]);
  return [a[0] / l, a[1] / l];
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export { V, dot, sub, add, mul, len, mix2, norm, clamp };

/** exact coverage of the pixel box [-1/2,1/2]^2 by the half-plane {p : n.p <= d}, |n| = 1. */
export function exactBoxCov(n, d) {
  const a = Math.max(Math.abs(n[0]), Math.abs(n[1]));
  const b = Math.min(Math.abs(n[0]), Math.abs(n[1]));
  const s = 0.5 * (a + b);
  const t = 0.5 * (a - b);
  if (d <= -s) return 0.0;
  if (d >= s) return 1.0;
  const ab = Math.max(2.0 * a * b, 1e-12);
  if (d <= -t) return ((d + s) * (d + s)) / ab;
  if (d >= t) return 1.0 - ((s - d) * (s - d)) / ab;
  return 0.5 + d / Math.max(a, 1e-12);
}

/** Sutherland-Hodgman clip of the box by `k` half-planes, then shoelace. */
function clipArea(planes) {
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  for (const [n, d] of planes) {
    const tmp = [];
    const cnt = poly.length;
    for (let i = 0; i < cnt; i++) {
      const a = poly[i],
        b = poly[i + 1 === cnt ? 0 : i + 1];
      const fa = dot(n, a) - d,
        fb = dot(n, b) - d;
      if (fa <= 0.0 && tmp.length < 8) tmp.push(a);
      if (fa < 0.0 !== fb < 0.0 && tmp.length < 8) tmp.push(mix2(a, b, fa / (fa - fb)));
    }
    poly = tmp;
    if (!poly.length) return 0.0;
  }
  let area = 0.0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[i + 1 === poly.length ? 0 : i + 1];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(area) * 0.5;
}

export const exactBoxCov2 = (n1, d1, n2, d2) =>
  clipArea([
    [n1, d1],
    [n2, d2],
  ]);
export const exactBoxCov3 = (n1, d1, n2, d2, n3, d3) =>
  clipArea([
    [n1, d1],
    [n2, d2],
    [n3, d3],
  ]);

/** CCW border param of a box-border point: bottom[0,1) right[1,2) top[2,3) left[3,4). */
export function bparamOf(p) {
  if (Math.abs(p[1] + 0.5) < 1e-4) return clamp(p[0] + 0.5, 0.0, 1.0);
  if (Math.abs(p[0] - 0.5) < 1e-4) return 1.0 + clamp(p[1] + 0.5, 0.0, 1.0);
  if (Math.abs(p[1] - 0.5) < 1e-4) return 2.0 + clamp(0.5 - p[0], 0.0, 1.0);
  return 3.0 + clamp(0.5 - p[1], 0.0, 1.0);
}
export const cornerOf = (j) =>
  j === 0 ? [0.5, -0.5] : j === 1 ? [0.5, 0.5] : j === 2 ? [-0.5, 0.5] : [-0.5, -0.5];

export function chainFillSide(p0, p1, p2, p3, p4) {
  let best = 1e30,
    side = true;
  const P = [p0, p1, p2, p3, p4];
  for (let s = 0; s < 4; s++) {
    const A = P[s],
      B = P[s + 1];
    const d = sub(B, A);
    const L2 = dot(d, d);
    if (L2 < 1e-20) continue;
    const t = clamp(dot([-A[0], -A[1]], d) / L2, 0.0, 1.0);
    const c = add(A, mul(d, t));
    const dd = dot(c, c);
    if (dd < best) {
      best = dd;
      side = d[1] * A[0] - d[0] * A[1] >= 0.0;
    }
  }
  return side;
}

export function chainMissCov(p0, p1, p2, p3, p4) {
  let best = 1e30,
    bA = [0, 0],
    bd2 = [0, 0],
    found = false;
  let bs = -1,
    firstS = 9,
    lastS = -1,
    bt = 0.0;
  const P = [p0, p1, p2, p3, p4];
  for (let s = 0; s < 4; s++) {
    const A = P[s],
      B = P[s + 1];
    const d = sub(B, A);
    const L2 = dot(d, d);
    if (L2 < 1e-20) continue;
    if (s < firstS) firstS = s;
    lastS = s;
    const tu = dot([-A[0], -A[1]], d) / L2;
    const t = clamp(tu, 0.0, 1.0);
    const c = add(A, mul(d, t));
    const dd = dot(c, c);
    if (dd < best) {
      best = dd;
      bA = A;
      bd2 = d;
      found = true;
      bs = s;
      bt = tu;
    }
  }
  if (!found || best > 2.0) return -1.0;
  if ((bt < 0.0 && bs === firstS) || (bt > 1.0 && bs === lastS)) return -1.0;
  const nOut = norm([bd2[1], -bd2[0]]);
  const c1 = exactBoxCov(nOut, dot(nOut, bA));
  // An interior JOINT is the sector between its two segments (see _boxCov.glsl chainMissCov).
  const atEnd = bt > 1.0,
    atStart = bt < 0.0;
  if (atEnd || atStart) {
    let s2 = atEnd ? bs + 1 : bs - 1,
      A2 = [0, 0],
      d2 = [0, 0];
    for (let k = 0; k < 4; k++) {
      if (s2 < 0 || s2 > 3) break;
      A2 = P[s2];
      d2 = sub(P[s2 + 1], A2);
      if (dot(d2, d2) >= 1e-20) break;
      s2 += atEnd ? 1 : -1;
    }
    if (s2 >= 0 && s2 <= 3 && dot(d2, d2) >= 1e-20) {
      const n2 = norm([d2[1], -d2[0]]);
      const c2 = exactBoxCov(n2, dot(n2, A2));
      const c12 = exactBoxCov2(nOut, dot(nOut, bA), n2, dot(n2, A2));
      const dIn = atEnd ? bd2 : d2,
        dOut = atEnd ? d2 : bd2;
      const turn = dIn[0] * dOut[1] - dIn[1] * dOut[0];
      if (turn > 0.0) return c12;
      if (turn < 0.0) return c1 + c2 - c12;
    }
  }
  return c1;
}

// REPRODUCTION HATCH, probe-side only (the shader has no such branch). `__LB_CHAIN_OLD_CLOSE = true`
// takes the single-walk closure instead of the piece walk: one polyline, one border walk at the
// wrap, zero-length clipped runs kept, no ring join. A comparison that cannot reproduce the model
// it compares against is an assertion (the same reason `FIT=hull` and `OPT='{"noArcMoment":true}'` exist).
const oldClose = () =>
  globalThis.__LB_CHAIN_OLD_CLOSE === true ||
  (typeof process !== 'undefined' && !!process.env && process.env.LB_CHAIN_OLD_CLOSE === '1');

export function chainBorderParam(p) {
  if (Math.abs(p[1]) >= Math.abs(p[0]))
    return p[1] < 0.0 ? clamp(p[0] + 0.5, 0.0, 1.0) : 2.0 + clamp(0.5 - p[0], 0.0, 1.0);
  return p[0] > 0.0 ? 1.0 + clamp(p[1] + 0.5, 0.0, 1.0) : 3.0 + clamp(0.5 - p[1], 0.0, 1.0);
}

const walkClose = () =>
  globalThis.__LB_CHAIN_WALK_CLOSE === true ||
  (typeof process !== 'undefined' && !!process.env && process.env.LB_CHAIN_WALK_CLOSE === '1');

export function chainBoxCov(p0, p1, p2, p3, p4, forceInside, noReject) {
  const OLD = oldClose(),
    LEGACY = OLD || walkClose();
  if (!noReject) {
    const lo = [
      Math.min(p0[0], p1[0], p2[0], p3[0], p4[0]),
      Math.min(p0[1], p1[1], p2[1], p3[1], p4[1]),
    ];
    const hi = [
      Math.max(p0[0], p1[0], p2[0], p3[0], p4[0]),
      Math.max(p0[1], p1[1], p2[1], p3[1], p4[1]),
    ];
    const m = forceInside > 1.5 ? 1.414215 : 0.500001;
    if (hi[0] < -m || lo[0] > m || hi[1] < -m || lo[1] > m)
      return forceInside > 0.5 ? 1.0 : chainFillSide(p0, p1, p2, p3, p4) ? 1.0 : 0.0;
  }
  const poly = [];
  let n = 0;
  // Piece starts, one bit per point — see the shader's own note: the chain can clip into the box
  // as SEVERAL disjoint runs, and the gap between one run's exit and the next run's entry is
  // BORDER, not outline.
  let entryMask = 0;
  const P = [p0, p1, p2, p3, p4];
  for (let s = 0; s < 4; s++) {
    const A = P[s],
      B = P[s + 1];
    const d = sub(B, A);
    if (dot(d, d) < 1e-12) continue;
    const lo = [Math.min(A[0], B[0]), Math.min(A[1], B[1])];
    const hi = [Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    if (hi[0] < -0.500001 || lo[0] > 0.500001 || hi[1] < -0.500001 || lo[1] > 0.500001) continue;
    let t0 = 0.0,
      t1 = 1.0,
      ok = true;
    for (let k = 0; k < 4; k++) {
      const Pk = k === 0 ? -d[0] : k === 1 ? d[0] : k === 2 ? -d[1] : d[1];
      const Q = k === 0 ? A[0] + 0.5 : k === 1 ? 0.5 - A[0] : k === 2 ? A[1] + 0.5 : 0.5 - A[1];
      if (Math.abs(Pk) < 1e-12) {
        if (Q < 0.0) ok = false;
      } else {
        const r = Q / Pk;
        if (Pk < 0.0) {
          if (r > t1) ok = false;
          else if (r > t0) t0 = r;
        } else {
          if (r < t0) ok = false;
          else if (r < t1) t1 = r;
        }
      }
    }
    if (!ok || t1 < t0) continue;
    // LERP, not `A + t * d` — see the shader's note on the float32 cancellation. `mix2` is the
    // OTHER form (a + (b - a) * t) and is not a substitute: it cancels at t == 1 in exactly the
    // way the note describes. Kept in the twin so the two are the same function, not the same
    // intent.
    const lerp = (t) => [A[0] * (1 - t) + B[0] * t, A[1] * (1 - t) + B[1] * t];
    const A2 = lerp(t0),
      B2 = lerp(t1);
    // A zero-length run is a TOUCH, not a run — see the shader's note.
    if (!OLD && dot(sub(B2, A2), sub(B2, A2)) < 1e-12) continue;
    const join = n > 0 && dot(sub(poly[n - 1], A2), sub(poly[n - 1], A2)) <= 1e-10;
    if (!join && n < 12) {
      poly[n] = A2;
      entryMask |= 1 << n;
      n++;
    }
    if (n < 12) {
      poly[n] = B2;
      n++;
    }
  }
  if (n < 2) {
    if (forceInside > 1.5) {
      const mc = chainMissCov(p0, p1, p2, p3, p4);
      return mc < 0.0 ? 1.0 : mc;
    }
    return forceInside > 0.5 || chainFillSide(p0, p1, p2, p3, p4) ? 1.0 : 0.0;
  }
  // A CLOSED chain whose join point falls inside the box is a RING, not two loose ends.
  const ring =
    !OLD &&
    dot(sub(p4, p0), sub(p4, p0)) < 1e-12 &&
    dot(sub(poly[0], poly[n - 1]), sub(poly[0], poly[n - 1])) <= 1e-10 &&
    n > 2;
  if (ring) {
    n--;
    entryMask &= ~1;
  }
  if (!ring) {
    // An end is continued when its RAY runs into the box (see the shader's note). The hatches keep the
    // single-walk rule: an end more than 1e-4 inside.
    const inside = (q) => Math.max(Math.abs(q[0]), Math.abs(q[1])) < 0.5 - 1e-4;
    const dEnd = sub(poly[n - 1], poly[n - 2]);
    if ((!LEGACY || inside(poly[n - 1])) && dot(dEnd, dEnd) > 1e-12 && n < 12) {
      const dn = norm(dEnd);
      const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - poly[n - 1][0]) / dn[0] : 1e9;
      const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - poly[n - 1][1]) / dn[1] : 1e9;
      const t = Math.min(tx, ty);
      if (LEGACY || t > 0.0) {
        poly[n] = add(poly[n - 1], mul(dn, t));
        n++;
      }
    }
    const dBeg = sub(poly[1], poly[0]);
    if ((!LEGACY || inside(poly[0])) && dot(dBeg, dBeg) > 1e-12 && n < 12) {
      const dn = norm([-dBeg[0], -dBeg[1]]);
      const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - poly[0][0]) / dn[0] : 1e9;
      const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - poly[0][1]) / dn[1] : 1e9;
      const t = Math.min(tx, ty);
      if (LEGACY || t > 0.0) {
        const E2 = add(poly[0], mul(dn, t));
        for (let i = 11; i >= 1; i--) if (i <= n) poly[i] = poly[i - 1];
        entryMask = ((entryMask << 1) | 1) & ~2;
        poly[0] = E2;
        n++;
      }
    }
  }
  // THE CLOSURE BY BORDER SUMS -- see the shader's note: the runs' shoelace, and the border walked
  // counterclockwise from each exit to the NEXT crossing, which is an entry of whichever run meets the border there.
  if (!LEGACY) {
    let area2 = 0.0,
      bsum = 0.0,
      minP = 8.0,
      minEntry = false,
      anyGap = false;
    for (let i = 0; i < n; i++) {
      const jn = i + 1 === n ? 0 : i + 1;
      const a = poly[i],
        b = poly[jn];
      const gap = (jn === 0 && !ring) || ((entryMask >> jn) & 1) !== 0;
      if (!gap) {
        area2 += a[0] * b[1] - a[1] * b[0];
        continue;
      }
      anyGap = true;
      const pa = chainBorderParam(a),
        pb = chainBorderParam(b);
      bsum += pb - pa;
      if (pa < minP) {
        minP = pa;
        minEntry = false;
      }
      if (pb < minP) {
        minP = pb;
        minEntry = true;
      }
    }
    if (!anyGap) return clamp(0.5 * area2 + (area2 < 0.0 ? 1.0 : 0.0), 0.0, 1.0);
    return clamp(0.5 * area2 + 0.25 * (bsum + (minEntry ? 4.0 : 0.0)), 0.0, 1.0);
  }
  // The alternative closures, for reproduction only: a walk from each exit to the NEXT RUN's entry in chain
  // order (`walkClose`), and one walk at the wrap (`oldClose`).
  let area = 0.0;
  for (let i = 0; i < n; i++) {
    const jn = i + 1 === n ? 0 : i + 1;
    const a = poly[i],
      b = poly[jn];
    const gap = (jn === 0 && !ring) || (!OLD && ((entryMask >> jn) & 1) !== 0);
    if (!gap) {
      area += a[0] * b[1] - a[1] * b[0];
      continue;
    }
    const dX = sub(a, poly[i > 0 ? i - 1 : 1]);
    const leftN = [-dX[1], dX[0]];
    let tCCW;
    if (Math.abs(a[1] + 0.5) < 1e-4 && a[0] < 0.5 - 1e-4) tCCW = [1, 0];
    else if (Math.abs(a[0] - 0.5) < 1e-4 && a[1] < 0.5 - 1e-4) tCCW = [0, 1];
    else if (Math.abs(a[1] - 0.5) < 1e-4 && a[0] > -0.5 + 1e-4) tCCW = [-1, 0];
    else tCCW = [0, -1];
    const ccw = dot(tCCW, leftN) >= 0.0;
    const pa = bparamOf(a),
      pb = bparamOf(b);
    let prev = a;
    if (ccw) {
      const pbW = pb < pa ? pb + 4.0 : pb;
      for (let j = 0; j < 8; j++) {
        const cp = j + 1;
        if (cp > pa + 1e-5 && cp < pbW - 1e-5) {
          const cnr = cornerOf(j - ((j / 4) | 0) * 4);
          area += prev[0] * cnr[1] - prev[1] * cnr[0];
          prev = cnr;
        }
      }
    } else {
      const pbW = pb > pa ? pb - 4.0 : pb;
      for (let j = 7; j >= 0; j--) {
        const cp = j + 1 - 4.0;
        if (cp < pa - 1e-5 && cp > pbW + 1e-5) {
          const cnr = cornerOf(j - ((j / 4) | 0) * 4);
          area += prev[0] * cnr[1] - prev[1] * cnr[0];
          prev = cnr;
        }
      }
    }
    area += prev[0] * b[1] - prev[1] * b[0];
  }
  return clamp(Math.abs(area) * 0.5, 0.0, 1.0);
}

// ── exact CUBIC CHAIN ───────────────────────────────────────────────────────────────────────────
// The straight chain with ONE of its segments a CUBIC Bezier: area(box ∩ fill), fill on the LEFT of the chain continued
// along its end tangents. STREAMING, with no arrays (for cost): the chain is walked once, in order, and two sums
// carry the whole answer. By Green's theorem the area is (1/2) ∮ (x dy - y dx) around the region's boundary, which is the
// chain's part inside the box and the box border's part inside the fill:
//   * the chain's part, a sub-arc [u, v] at a time: its chord's shoelace term Q(u) x Q(v), plus the exact area between
//     sub-arc and chord, 0.3 h (2 (d0 - d1) x c - h d0 x d1) with h = (v - u)/3, d0 = B'(u), d1 = B'(v), c = Q(v) - Q(u)
//     (the blossom form (3/10)(a x b + a x c + 2 b x c) with a = h d0 and b = c - h d1);
//   * the border's part: on every side x dy - y dx is 1/2 ds, so it is half the LENGTH of border inside the fill. With the
//     border parameterized counterclockwise by arc length p in [0, 4) from the corner (-1/2, -1/2), the border inside
//     runs from each exit to the next entry, so its length is (sum of entry p) - (sum of exit p) + 4 [the crossing of
//     least p is an entry] -- two running sums and a running minimum.
// area = (1/2) chain + (1/4) border.
//
// ROBUST IN FLOAT32 (so the twin and the shader agree): the crossings are not the closed-form roots of a
// cubic, whose depressed form loses every digit when its leading coefficient is small against the rest (a control
// point on its end, B = 69500 after normalization, returned the complement). Each segment is cut at its x and y extrema
// (the roots of two quadratics, any error in which only leaves a piece a rounding error away from monotone), and on a
// piece monotone in both x and y the part inside the box is ONE parameter interval, bounded by at most one crossing of
// each slab, each found by a safeguarded Newton iteration inside a sign-change bracket. Every piece end is classified
// once, from the same stored point, by both pieces that share it, so the crossings always alternate.
//
// DECIDED FIRST: a segment whose control box or fat line misses the pixel box contributes nothing, and neither does a
// monotone piece whose end-point box (its exact bounding box) misses it -- the exact work runs only where the chain can
// meet the box.
export const cAtC = (P, t) => {
  const u = 1.0 - t,
    a = u * u * u,
    b = 3.0 * u * u * t,
    c = 3.0 * u * t * t,
    d = t * t * t;
  return [
    a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0],
    a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1],
  ];
};
export const cTanC = (P, t) => {
  const u = 1.0 - t,
    a = u * u,
    b = 2.0 * u * t,
    c = t * t;
  return [
    3.0 * (a * (P[1][0] - P[0][0]) + b * (P[2][0] - P[1][0]) + c * (P[3][0] - P[2][0])),
    3.0 * (a * (P[1][1] - P[0][1]) + b * (P[2][1] - P[1][1]) + c * (P[3][1] - P[2][1])),
  ];
};
/** A power-basis coordinate co = [a, b, c, d]: a t^3 + b t^2 + c t + d, and its derivative. */
export const cbEval = (co, t) => ((co[0] * t + co[1]) * t + co[2]) * t + co[3];
export const cbEvalD = (co, t) => (3.0 * co[0] * t + 2.0 * co[1]) * t + co[2];
/**
 * The t in [t0, t1] where the power-basis coordinate co reaches L, given f0 = co(t0) - L and f1 = co(t1) - L of opposite
 * signs (or f1 = 0) on a piece where co is monotone: false position to start, then Halley (cubic convergence: most
 * crossings in one step), falling back to the bracket's midpoint whenever a step leaves the bracket, until |co(t) - L| is
 * below the rounding of the terms that make it.
 */
export function cbSolve(co, L, t0, t1, f0, f1) {
  const tolF =
    1e-6 * (1.0 + Math.abs(co[0]) + Math.abs(co[1]) + Math.abs(co[2]) + Math.abs(co[3] - L));
  let t = t0 + (t1 - t0) * clamp(f0 / (f0 - f1), 0.0, 1.0);
  for (let it = 0; it < 16; it++) {
    const ft = cbEval(co, t) - L;
    if (Math.abs(ft) <= tolF) break;
    if (ft < 0.0 === f0 < 0.0) {
      t0 = t;
      f0 = ft;
    } else t1 = t;
    const d = cbEvalD(co, t),
      dd = 6.0 * co[0] * t + 2.0 * co[1];
    const den = 2.0 * d * d - ft * dd;
    let tn = den !== 0.0 ? t - (2.0 * ft * d) / den : -1.0;
    if (!(tn > t0 && tn < t1)) tn = 0.5 * (t0 + t1);
    t = tn;
  }
  return t;
}
/** The roots in (0, 1) of A t^2 + B t + C, stably (2 = none): a cubic coordinate's extrema, from its derivative. */
export function cbExtrema(A, B, C) {
  const disc = B * B - 4.0 * A * C;
  if (disc < 0.0) return [2.0, 2.0];
  const q = -0.5 * (B + (B >= 0.0 ? Math.sqrt(disc) : -Math.sqrt(disc)));
  let r1 = A !== 0.0 ? q / A : 2.0,
    r2 = q !== 0.0 ? C / q : 2.0;
  if (!(r1 > 0.0 && r1 < 1.0)) r1 = 2.0;
  if (!(r2 > 0.0 && r2 < 1.0)) r2 = 2.0;
  return [r1, r2];
}
/** The directions a chain continues in past its ends (a control point on its end hands the tangent to the next one). */
export function cbDirStart(A, C1, C2, B) {
  let g = sub(C1, A);
  if (dot(g, g) <= 1e-24) g = sub(C2, A);
  if (dot(g, g) <= 1e-24) g = sub(B, A);
  return g;
}
export function cbDirEnd(A, C1, C2, B) {
  let g = sub(B, C2);
  if (dot(g, g) <= 1e-24) g = sub(B, C1);
  if (dot(g, g) <= 1e-24) g = sub(B, A);
  return g;
}
/** The border parameter of a point on side `side` (0 bottom, 1 right, 2 top, 3 left), counterclockwise from (-1/2, -1/2). */
export const cbBorderP = (side, q) =>
  side === 0 ? q[0] + 0.5 : side === 1 ? 1.5 + q[1] : side === 2 ? 2.5 - q[0] : 3.5 - q[1];
/** From q (in the box) along the unit direction dn to the border: the point, its side and how far it is. */
export function cbToBorder(q, dn) {
  const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0.0 ? 0.5 : -0.5) - q[0]) / dn[0] : 1e9;
  const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0.0 ? 0.5 : -0.5) - q[1]) / dn[1] : 1e9;
  if (tx <= ty)
    return {
      e: [dn[0] > 0.0 ? 0.5 : -0.5, clamp(q[1] + dn[1] * tx, -0.5, 0.5)],
      side: dn[0] > 0.0 ? 1 : 3,
      dist: tx,
    };
  return {
    e: [clamp(q[0] + dn[0] * ty, -0.5, 0.5), dn[1] > 0.0 ? 0.5 : -0.5],
    side: dn[1] > 0.0 ? 2 : 0,
    dist: ty,
  };
}
/**
 * p0..p4: a CUBIC and a straight segment in cell coordinates (fill LEFT): p0 C p1 C p2 -> p3 then the line p3 -> p4 when
 * `lineFirst` is false (the builder's mode 4), the line p0 -> p1 then the cubic p1 C p2 C p3 -> p4 when it is true (mode
 * 5). forceInside as chainBoxCov.
 */
export function cubicChainBoxCov(p0, p1, p2, p3, p4, lineFirst, forceInside) {
  const cA = lineFirst ? p1 : p0,
    cC1 = lineFirst ? p2 : p1,
    cC2 = lineFirst ? p3 : p2,
    cB = lineFirst ? p4 : p3;
  const lA = lineFirst ? p0 : p3,
    lB = lineFirst ? p1 : p4;
  const cd = sub(cB, cA),
    c1d = sub(cC1, cA),
    c2d = sub(cC2, cA),
    ld = sub(lB, lA);
  const cubOn = !(dot(cd, cd) < 1e-12 && dot(c1d, c1d) < 1e-12 && dot(c2d, c2d) < 1e-12),
    linOn = !(dot(ld, ld) < 1e-12);
  // Segment s = 0 comes first along the chain; the chain starts at the first segment present and ends at the last.
  const on0 = lineFirst ? linOn : cubOn,
    on1 = lineFirst ? cubOn : linOn;
  const sFirst = on0 ? 0 : 1,
    sLast = on1 ? 1 : 0;
  let area2 = 0.0,
    bsum = 0.0,
    minP = 8.0,
    minEntry = false,
    hit = false,
    open = false,
    pend = false,
    pendQ = null,
    pendSide = -1;
  const event = (q, side, entry) => {
    const p = cbBorderP(side, q);
    bsum += entry ? p : -p;
    if (p < minP) {
      minP = p;
      minEntry = entry;
    }
  };
  for (let s = 0; s < 2; s++) {
    const cub = lineFirst ? s === 1 : s === 0;
    if (!(cub ? cubOn : linOn)) continue;
    const A = cub ? cA : lA,
      B = cub ? cB : lB,
      C1 = cub ? cC1 : lA,
      C2 = cub ? cC2 : lB;
    const lo = cub
      ? [Math.min(A[0], B[0], C1[0], C2[0]), Math.min(A[1], B[1], C1[1], C2[1])]
      : [Math.min(A[0], B[0]), Math.min(A[1], B[1])];
    const hi = cub
      ? [Math.max(A[0], B[0], C1[0], C2[0]), Math.max(A[1], B[1], C1[1], C2[1])]
      : [Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    if (hi[0] < -0.5 || lo[0] > 0.5 || hi[1] < -0.5 || lo[1] > 0.5) continue;
    // ...and its FAT LINE (Sederberg): the arc keeps within 3/4 of its control points' distances from its chord (4/9 when
    // they are on opposite sides), so a box wholly past that slab misses it; a line's slab has no width. A segment with
    // an end in the box is never cut here, so a chain arriving inside always finds its next segment.
    if (
      Math.max(Math.abs(A[0]), Math.abs(A[1])) > 0.5 &&
      Math.max(Math.abs(B[0]), Math.abs(B[1])) > 0.5
    ) {
      const n = [A[1] - B[1], B[0] - A[0]];
      const d1 = n[0] * (C1[0] - A[0]) + n[1] * (C1[1] - A[1]),
        d2 = n[0] * (C2[0] - A[0]) + n[1] * (C2[1] - A[1]);
      const f = d1 * d2 > 0.0 ? 0.75 : 0.4444444444444444;
      const cd = -(n[0] * A[0] + n[1] * A[1]),
        sup = 0.5 * (Math.abs(n[0]) + Math.abs(n[1]));
      if (cd - sup > f * Math.max(0.0, d1, d2) || cd + sup < f * Math.min(0.0, d1, d2)) continue;
    }
    // Power basis per coordinate; a line is the cubic with no t^2 or t^3 term.
    const co = [0, 1].map((k) =>
      cub
        ? [
            -A[k] + 3.0 * C1[k] - 3.0 * C2[k] + B[k],
            3.0 * A[k] - 6.0 * C1[k] + 3.0 * C2[k],
            3.0 * (C1[k] - A[k]),
            A[k],
          ]
        : [0.0, 0.0, B[k] - A[k], A[k]],
    );
    const cx = co[0],
      cy = co[1];
    // The pieces: split at the x and y extrema, in order.
    const sp = cub
      ? [
          ...cbExtrema(3.0 * cx[0], 2.0 * cx[1], cx[2]),
          ...cbExtrema(3.0 * cy[0], 2.0 * cy[1], cy[2]),
        ].sort((a, b) => a - b)
      : [2.0, 2.0, 2.0, 2.0];
    let ta = 0.0,
      Pa = A;
    for (let k = 0; k < 5; k++) {
      const tb = k < 4 ? Math.min(sp[k], 1.0) : 1.0;
      if (!(tb > ta)) continue;
      const Pb = tb < 1.0 ? [cbEval(cx, tb), cbEval(cy, tb)] : B;
      const t0 = ta,
        Q0a = Pa;
      ta = tb;
      Pa = Pb;
      if (
        Math.max(Q0a[0], Pb[0]) < -0.5 ||
        Math.min(Q0a[0], Pb[0]) > 0.5 ||
        Math.max(Q0a[1], Pb[1]) < -0.5 ||
        Math.min(Q0a[1], Pb[1]) > 0.5
      )
        continue;
      // The x slab: x is monotone, so the part with |x| <= 1/2 is [lo, hi], each end a crossing or the piece's own.
      let lo = t0,
        loSide = -1,
        hi = tb,
        hiSide = -1;
      const fa = Q0a[0],
        fb = Pb[0];
      if (fb >= fa) {
        if (fa < -0.5) {
          lo = cbSolve(cx, -0.5, t0, tb, fa + 0.5, fb + 0.5);
          loSide = 3;
        }
        if (fb > 0.5) {
          hi = cbSolve(cx, 0.5, t0, tb, fa - 0.5, fb - 0.5);
          hiSide = 1;
        }
      } else {
        if (fa > 0.5) {
          lo = cbSolve(cx, 0.5, t0, tb, fa - 0.5, fb - 0.5);
          loSide = 1;
        }
        if (fb < -0.5) {
          hi = cbSolve(cx, -0.5, t0, tb, fa + 0.5, fb + 0.5);
          hiSide = 3;
        }
      }
      // ...and inside it the y slab, from y at its two ends (y is monotone too).
      const ya = loSide < 0 ? Q0a[1] : cbEval(cy, lo),
        yb = hiSide < 0 ? Pb[1] : cbEval(cy, hi);
      let u = lo,
        uSide = loSide,
        v = hi,
        vSide = hiSide;
      if (yb >= ya) {
        if (yb < -0.5 || ya > 0.5) continue;
        if (ya < -0.5) {
          u = cbSolve(cy, -0.5, lo, hi, ya + 0.5, yb + 0.5);
          uSide = 0;
        }
        if (yb > 0.5) {
          v = cbSolve(cy, 0.5, lo, hi, ya - 0.5, yb - 0.5);
          vSide = 2;
        }
      } else {
        if (ya < -0.5 || yb > 0.5) continue;
        if (ya > 0.5) {
          u = cbSolve(cy, 0.5, lo, hi, ya - 0.5, yb - 0.5);
          uSide = 2;
        }
        if (yb < -0.5) {
          v = cbSolve(cy, -0.5, lo, hi, ya + 0.5, yb + 0.5);
          vSide = 0;
        }
      }
      // The crossing points: the line's own coordinate, and the other one -- already in hand (ya, yb) where the x slab
      // crossing is the interval's end.
      const at = (t, side, own, yx) =>
        side < 0
          ? own
          : side === 1 || side === 3
            ? [side === 1 ? 0.5 : -0.5, clamp(yx, -0.5, 0.5)]
            : [clamp(cbEval(cx, t), -0.5, 0.5), side === 2 ? 0.5 : -0.5];
      const Q0 = at(u, uSide, Q0a, ya),
        Q3 = at(v, vSide, Pb, yb),
        zero = !(v > u);
      // WHERE THE INTERVAL STARTS. An interval of no length is the chain touching the border at one point: it adds no
      // area, and its crossings are either a pair to drop (it arrived and left at once) or the entry of a chain that
      // arrived at the border and goes on inside from the next piece -- held until that piece shows which.
      // The chain's own ends, continued along their tangents to the border.
      const startRay = (q) => {
        const g = cbDirStart(A, C1, C2, B);
        return cbToBorder(q, norm([-g[0], -g[1]]));
      };
      const endRay = (q) => cbToBorder(q, norm(cbDirEnd(A, C1, C2, B)));
      const atEnd = tb === 1.0 && s === sLast;
      if (uSide >= 0) {
        if (zero) {
          if (vSide >= 0) continue;
          if (!atEnd) {
            pend = true;
            pendQ = Q0;
            pendSide = uSide;
            continue;
          }
          // The chain arrives at the border exactly at its END: its tangent may still cross the box.
          const r = endRay(Q0);
          if (!(r.dist >= 1e-6)) continue;
          event(Q0, uSide, true);
          area2 += Q0[0] * r.e[1] - Q0[1] * r.e[0];
          event(r.e, r.side, false);
          hit = true;
          continue;
        }
        event(Q0, uSide, true);
      } else if (!(t0 === 0.0 && s === sFirst)) {
        if (zero) {
          if (vSide >= 0 && open) {
            event(Q3, vSide, false);
            open = false;
          }
          pend = false;
          continue;
        }
        if (pend) {
          event(pendQ, pendSide, true);
          pend = false;
        }
      } else {
        // The chain STARTS inside -- or on the border, leaving at once, where its tangent may still cross the box.
        const r = startRay(Q0);
        if (zero) {
          if (!(vSide >= 0 && r.dist >= 1e-6)) continue;
          event(r.e, r.side, true);
          area2 += r.e[0] * Q3[1] - r.e[1] * Q3[0];
          event(Q3, vSide, false);
          hit = true;
          continue;
        }
        area2 += r.e[0] * Q0[1] - r.e[1] * Q0[0];
        event(r.e, r.side, true);
      }
      open = true;
      hit = true;
      area2 += Q0[0] * Q3[1] - Q0[1] * Q3[0];
      if (cub) {
        const d0 = [cbEvalD(cx, u), cbEvalD(cy, u)],
          d1 = [cbEvalD(cx, v), cbEvalD(cy, v)],
          h = (v - u) / 3.0,
          c = sub(Q3, Q0);
        const dd = sub(d0, d1);
        area2 +=
          0.3 * h * (2.0 * (dd[0] * c[1] - dd[1] * c[0]) - h * (d0[0] * d1[1] - d0[1] * d1[0]));
      }
      // ...AND WHERE IT ENDS: a crossing, the chain's own end inside the box, or the next piece.
      if (vSide >= 0) {
        event(Q3, vSide, false);
        open = false;
      } else if (atEnd) {
        const r = endRay(Q3);
        area2 += Q3[0] * r.e[1] - Q3[1] * r.e[0];
        event(r.e, r.side, false);
        open = false;
      }
    }
  }
  if (!hit) {
    if (forceInside < 1.5) return forceInside > 0.5 ? 1.0 : 0.0;
    // A box the arc misses lies wholly on one side of it, and an interior face's pixel is on the fill side: its answer
    // is 1. The straight segment keeps chainBoxCov's linear miss where its nearest point is its own interior -- at its
    // joint with the arc the arc answers, and past its open end nothing does.
    const A = lineFirst ? p0 : p3,
      d = sub(lineFirst ? p1 : p4, A),
      L2 = dot(d, d);
    if (L2 < 1e-20) return 1.0;
    const tu = dot([-A[0], -A[1]], d) / L2;
    if (!(tu > 0.0 && tu < 1.0)) return 1.0;
    const c = add(A, mul(d, tu));
    if (dot(c, c) > 2.0) return 1.0;
    const nOut = norm([d[1], -d[0]]);
    return exactBoxCov(nOut, dot(nOut, A));
  }
  return clamp(0.5 * area2 + 0.25 * (bsum + (minEntry ? 4.0 : 0.0)), 0.0, 1.0);
}
