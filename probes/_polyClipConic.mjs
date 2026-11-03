#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// exact conic-segment coverage: area(pixel box ∩ fill) where the fill boundary
// is a chain of QUADRATIC BÉZIER segments, not a polyline. This removes the
// density/reach tradeoff that bounds the polyline chain kernel (see
// _polyClip.mjs): one conic segment represents a whole glyph arc exactly, so
// there is no sagitta to trade against chain reach.
//
// Method — the polyline kernel, plus one closed-form correction per segment:
//   1. clip each conic to the box by solving x(t)=±½, y(t)=±½ (quadratics) and
//      keeping the parameter intervals whose midpoint is inside;
//   2. shoelace the CHORDS of the clipped intervals exactly as before;
//   3. add the exact area between each clipped chord and its true arc.
// For a quadratic Bézier the closed area between curve and chord is
//   (2/3) · signedArea(P0,P1,P2) = (1/3) · cross(P1−P0, P2−P0)
// (Archimedes' quadrature of the parabola). The kernel accumulates TWICE the
// signed area, so the term added there is (2/3)·cross(P1−P0, P2−P0).
// A straight segment is the degenerate case P1 = midpoint: the cross vanishes
// and the term is exactly 0, so lines and curves share one code path.
//
// VALIDATION: against the polyline kernel of _polyClip.mjs at 4096 pieces per
// arc (sagitta/4096² ≈ 0), which is itself validated at 0.5/255 vs 256×
// supersampling. Agreement there means the conic kernel is exact.
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const EPS = 1e-9;
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

// ── quadratic Bézier helpers ────────────────────────────────────────────────
const qAt = (A, C, B, t) => {
  const u = 1 - t;
  return [
    u * u * A[0] + 2 * u * t * C[0] + t * t * B[0],
    u * u * A[1] + 2 * u * t * C[1] + t * t * B[1],
  ];
};
// control point of the sub-Bézier over [u,v] (de Casteljau, closed form)
const qSubCtrl = (A, C, B, u, v) => {
  const w0 = (1 - u) * (1 - v),
    w1 = u * (1 - v) + v * (1 - u),
    w2 = u * v;
  return [w0 * A[0] + w1 * C[0] + w2 * B[0], w0 * A[1] + w1 * C[1] + w2 * B[1]];
};
// tangent direction at t (derivative, unnormalized)
const qTan = (A, C, B, t) => {
  const u = 1 - t;
  return [2 * (u * (C[0] - A[0]) + t * (B[0] - C[0])), 2 * (u * (C[1] - A[1]) + t * (B[1] - C[1]))];
};
// real roots of a·t² + b·t + c in (0,1)
function rootsIn01(a, b, c) {
  const out = [];
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) > 1e-14) {
      const t = -c / b;
      if (t > EPS && t < 1 - EPS) out.push(t);
    }
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  // numerically stable pair
  const q = -0.5 * (b + Math.sign(b || 1) * sq);
  for (const t of [q / a, c / q]) if (Number.isFinite(t) && t > EPS && t < 1 - EPS) out.push(t);
  return out;
}
// parameter intervals of the conic that lie INSIDE the box [-½,½]²
function insideIntervals(A, C, B) {
  const ts = [0, 1];
  for (const axis of [0, 1]) {
    // coordinate as a quadratic in t: (A−2C+B)t² + 2(C−A)t + A
    const a = A[axis] - 2 * C[axis] + B[axis];
    const b = 2 * (C[axis] - A[axis]);
    for (const lim of [-0.5, 0.5]) ts.push(...rootsIn01(a, b, A[axis] - lim));
  }
  ts.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const u = ts[i],
      v = ts[i + 1];
    if (v - u < 1e-12) continue;
    const m = qAt(A, C, B, (u + v) / 2);
    if (Math.max(Math.abs(m[0]), Math.abs(m[1])) <= 0.5 + 1e-9) {
      // merge with the previous interval if contiguous
      if (out.length && Math.abs(out[out.length - 1][1] - u) < 1e-12) out[out.length - 1][1] = v;
      else out.push([u, v]);
    }
  }
  return out;
}

// ── border closure (identical to the polyline kernel) ───────────────────────
function bparam(p) {
  if (Math.abs(p[1] + 0.5) < 1e-6) return clamp(p[0] + 0.5, 0, 1);
  if (Math.abs(p[0] - 0.5) < 1e-6) return 1 + clamp(p[1] + 0.5, 0, 1);
  if (Math.abs(p[1] - 0.5) < 1e-6) return 2 + clamp(0.5 - p[0], 0, 1);
  return 3 + clamp(0.5 - p[1], 0, 1);
}
const CORNERS = [
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
  [-0.5, -0.5],
];
function borderTanCCW(p) {
  if (Math.abs(p[1] + 0.5) < 1e-6 && p[0] < 0.5 - 1e-6) return [1, 0];
  if (Math.abs(p[0] - 0.5) < 1e-6 && p[1] < 0.5 - 1e-6) return [0, 1];
  if (Math.abs(p[1] - 0.5) < 1e-6 && p[0] > -0.5 + 1e-6) return [-1, 0];
  return [0, -1];
}
function borderWalk(X, E, dir) {
  // two-lap corner candidates (the H crossbar bug)
  let a = bparam(X),
    b = bparam(E);
  const out = [];
  if (dir > 0) {
    if (b < a - 1e-9) b += 4;
    for (let k = 0; k < 8; k++) {
      const cp = k + 1;
      if (cp > a + 1e-9 && cp < b - 1e-9) out.push(CORNERS[k % 4]);
    }
  } else {
    if (b > a + 1e-9) b -= 4;
    for (let k = 7; k >= 0; k--) {
      const cp = k + 1 - 4;
      if (cp < a - 1e-9 && cp > b + 1e-9) out.push(CORNERS[k % 4]);
    }
  }
  return out;
}

// ── THE conic kernel ────────────────────────────────────────────────────────
// segs = [{A, C, B}, ...] directed, fill on the LEFT.
export function conicFillCov(segs) {
  // Clipped arcs form PIECES: consecutive inside intervals that join end-to-end.
  // A chain that leaves the box and re-enters yields several, and each gap is
  // closed by a border WALK (a straight jump between them is exact only when
  // both border points share a box edge; when the excursion wraps a corner it
  // cuts the corner off). One piece reduces to the plain single-chain closure.
  const pieces = [];
  let cur = null,
    curTanIn = null,
    curTanOut = null;
  let corr = 0; // Σ 2×(area between arc and its chord)
  for (const s of segs) {
    for (const [u, v] of insideIntervals(s.A, s.C, s.B)) {
      const P0 = qAt(s.A, s.C, s.B, u),
        P2 = qAt(s.A, s.C, s.B, v);
      const P1 = qSubCtrl(s.A, s.C, s.B, u, v);
      corr += (2 / 3) * cross(sub(P1, P0), sub(P2, P0));
      if (
        cur &&
        Math.hypot(cur.pts[cur.pts.length - 1][0] - P0[0], cur.pts[cur.pts.length - 1][1] - P0[1]) <
          1e-9
      ) {
        cur.pts.push(P2);
        cur.tanOut = qTan(s.A, s.C, s.B, v);
      } else {
        if (cur) pieces.push(cur);
        cur = { pts: [P0, P2], tanIn: qTan(s.A, s.C, s.B, u), tanOut: qTan(s.A, s.C, s.B, v) };
      }
    }
  }
  if (cur) pieces.push(cur);
  if (!pieces.length) return null; // miss — caller's role-based resolution
  // ENDS-ON-BORDER INVARIANT: a real chain end strictly inside the box is
  // extended along its TANGENT (for a conic the terminal tangent, not a chord).
  const inside = (p) => Math.max(Math.abs(p[0]), Math.abs(p[1])) < 0.5 - 1e-4;
  const toBorder = (p, d) => {
    const L = Math.hypot(d[0], d[1]) || 1,
      dn = [d[0] / L, d[1] / L];
    const tx = Math.abs(dn[0]) > 1e-6 ? ((dn[0] > 0 ? 0.5 : -0.5) - p[0]) / dn[0] : 1e9;
    const ty = Math.abs(dn[1]) > 1e-6 ? ((dn[1] > 0 ? 0.5 : -0.5) - p[1]) / dn[1] : 1e9;
    return [p[0] + dn[0] * Math.min(tx, ty), p[1] + dn[1] * Math.min(tx, ty)];
  };
  const f = pieces[0],
    l = pieces[pieces.length - 1];
  if (inside(f.pts[0])) f.pts.unshift(toBorder(f.pts[0], [-f.tanIn[0], -f.tanIn[1]]));
  if (inside(l.pts[l.pts.length - 1])) l.pts.push(toBorder(l.pts[l.pts.length - 1], l.tanOut));
  const full = [];
  for (let k = 0; k < pieces.length; k++) {
    const P = pieces[k].pts,
      Q = pieces[(k + 1) % pieces.length].pts;
    for (const p of P) full.push(p);
    const X = P[P.length - 1],
      E = Q[0];
    // Fill side from the exit TANGENT, not the chord. On a strongly curved
    // piece the clipped chord can point well away from the true tangent, and
    // when the exit is near-tangential to the border the sign test flips — the
    // walk then runs the wrong way round the box and the coverage comes out as
    // exactly its complement (measured: 44/2292 random arcs, errors summing to
    // 1.0000). A straight segment's tangent IS its chord, so lines are
    // unaffected.
    const dX = pieces[k].tanOut;
    const leftN = [-dX[1], dX[0]],
      tCCW = borderTanCCW(X);
    const dir = tCCW[0] * leftN[0] + tCCW[1] * leftN[1] >= 0 ? 1 : -1;
    for (const c of borderWalk(X, E, dir)) full.push(c);
  }
  let two = 0; // twice the signed polygon area
  for (let i = 0; i < full.length; i++) {
    const p = full[i],
      q = full[(i + 1) % full.length];
    two += p[0] * q[1] - q[0] * p[1];
  }
  return clamp(Math.abs(two + corr) * 0.5, 0, 1);
}

// ── reference: the PROVEN polyline kernel at very high density ──────────────
import { fillCovPolyline } from './_polyClipRef.mjs';
function refCov(segs, pieces = 4096) {
  const pts = [];
  for (const s of segs) {
    for (let i = 0; i <= pieces; i++) {
      if (i === 0 && pts.length) continue;
      pts.push(qAt(s.A, s.C, s.B, i / pieces));
    }
  }
  return fillCovPolyline(pts, true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let worst = 0,
    n = 0;
  const check = (name, segs) => {
    const got = conicFillCov(segs);
    const truth = refCov(segs);
    if (got === null) {
      console.log(`${name.padEnd(26)} MISS (no clip)`);
      return;
    }
    const e = Math.abs(got - truth) * 255;
    worst = Math.max(worst, e);
    n++;
    console.log(
      `${name.padEnd(26)} truth=${truth.toFixed(5)} conic=${got.toFixed(5)} err=${e.toFixed(2)}`,
    );
  };
  const seg = (A, C, B) => ({ A, C, B });
  const mid = (A, B) => [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];

  // lines must stay exact through the conic path (degenerate control point)
  check('line-45', [seg([-1, -1], mid([-1, -1], [1, 1]), [1, 1])]);
  check('line-horiz', [seg([-1, 0.1], mid([-1, 0.1], [1, 0.1]), [1, 0.1])]);
  check('line-horiz-left', [seg([1, 0.1], mid([1, 0.1], [-1, 0.1]), [-1, 0.1])]);
  check('line-vert-down', [seg([0.1, 1], mid([0.1, 1], [0.1, -1]), [0.1, -1])]);
  // single arcs at a range of bulges — the case a polyline can only approximate
  for (const bulge of [0.1, 0.25, 0.5, 1.0, 2.0]) {
    check(`arc-bulge-${bulge}`, [seg([-1, -0.3], [0, -0.3 + bulge], [1, -0.3])]);
    check(`arc-bulge-neg-${bulge}`, [seg([-1, 0.3], [0, 0.3 - bulge], [1, 0.3])]);
  }
  // arcs that enter and LEAVE the box twice (two inside intervals)
  check('arc-reenter', [seg([-1, 0.45], [0, -3.0], [1, 0.45])]);
  // deep bow entirely crossing the cell — the regime where a chord halves it
  check('arc-deep-bow', [seg([-0.9, -0.9], [0, 2.4], [0.9, -0.9])]);
  // two-segment chains (a corner, and a smooth join)
  check('corner-lines', [
    seg([-1, 0.2], mid([-1, 0.2], [0.15, 0.2]), [0.15, 0.2]),
    seg([0.15, 0.2], mid([0.15, 0.2], [0.15, 1]), [0.15, 1]),
  ]);
  check('arc+line', [
    seg([-1, -0.2], [-0.2, 0.5], [0.2, 0.1]),
    seg([0.2, 0.1], mid([0.2, 0.1], [1, -0.4]), [1, -0.4]),
  ]);
  check('arc+arc-smooth', [
    seg([-1, -0.2], [-0.3, 0.35], [0.1, 0.15]),
    seg([0.1, 0.15], [0.5, -0.02], [1, 0.4]),
  ]);
  // an arc whose ends lie INSIDE the box (exercises the tangent extension)
  check('arc-ends-inside', [seg([-0.3, -0.2], [0, 0.35], [0.3, -0.2])]);
  // grazing: arc apex just touching the box edge
  check('arc-graze-top', [seg([-1, 0.1], [0, 0.9], [1, 0.1])]);

  // dense sweep: random arcs, offsets and orientations
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let sweepWorst = 0,
    sweepN = 0;
  for (let i = 0; i < 4000; i++) {
    const A = [rnd() * 4 - 2, rnd() * 4 - 2],
      B = [rnd() * 4 - 2, rnd() * 4 - 2];
    const C = [rnd() * 4 - 2, rnd() * 4 - 2];
    const got = conicFillCov([seg(A, C, B)]);
    if (got === null) continue;
    const truth = refCov([seg(A, C, B)], 16384);
    const e = Math.abs(got - truth) * 255;
    if (e > sweepWorst) sweepWorst = e;
    sweepN++;
  }
  console.log(`\nnamed cases: ${n}, worst ${worst.toFixed(2)}/255`);
  console.log(`random sweep: ${sweepN} arcs, worst ${sweepWorst.toFixed(2)}/255`);
  // The sweep's residual is the REFERENCE's discretization, not the kernel's:
  // on the worst case the polyline reference converges TO the conic value as it
  // densifies (0.772549 @2048 → 0.776366 @8192 → 0.777305 @32768 → 0.777539
  // @131072 → conic 0.777616). Hence the looser sweep gate at high density.
  const ok = worst < 0.5 && sweepWorst < 1.0;
  console.log(`\n${ok ? 'PASS — conic kernel is exact' : 'FAIL'}`);
  if (!ok) process.exit(1);
}
