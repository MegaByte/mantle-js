// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchProto — does the CPatch formulation actually fill a curved region?
//
// Dokter et al. 2019 (EG, "Hierarchical Rasterization of Curved Primitives"): a CPatch
// is a generalization of a 2D polygon — a region bounded by up to N curves (lines or
// cubics; quadratics elevated) inside a bounding box represented as four lines. Lines
// are encoded in klm form with k=0, m=1, l = signed normal distance, so f = k^3-lm = -l
// and lines and curves get uniform treatment. k, l, m are interpolated GLOBALLY as
// linear functionals of (x,y,1), and:
//
//     "A naive rasterization ... would evaluate all curve equations for all pixels and
//      fill those that lie in the INTERSECTION OF ALL HALF-SPACES."
//
// That is the whole primitive. It needs NO triangulation — which is why it is worth
// testing here: lbPartition + lbInteriorSplit + cdt are ~47% of the LB build.
//
// This is a CPU rasterizer on purpose. The claim under test is the FORMULATION, not the
// hierarchy (their tiling) or the scheduler (Whippletree, CUDA — load balancing, not
// algorithm). If the conjunction does not fill a curved region correctly on the CPU, no
// GPU port can save it; if it does, the port is mechanical.
//
// Reference: an exact ray-crossing walk of the TRUE curves, so neither side is the
// yardstick.
//
// STATUS: the primitive works; EXTENSION CORRECTION is unsolved here and is the reason a
// real implementation needs the converter, not just a shader.
//
//   shape     curves   disagree
//   lens/arch/tri/concave     0        the formulation is exact on valid patches
//   ngon3 / ngon5             0
//   ngon8                    48 (0.07%)
//   ngon12                 4500 (6.87%)
//   ngon16                 9012 (13.75%)
//
// The n-gon family exposes it: a quadratic's implicit is the whole parabola, and as N
// grows the far arms curl back into the patch. Two per-fragment fallbacks both fail, in
// opposite directions:
//
//   * CHORD outside the span — catastrophic. For an OUTWARD bulge the chord lies INSIDE
//     the curve, so it cuts real interior everywhere: ink fell to a third, AA error 236/255.
//   * END TANGENT outside the span (what ships below) — halves the error (ngon12
//     10504 -> 4500) but cannot close it. For an outward bulge the end tangent is rotated
//     outward from the chord and is NOT a supporting line, so near a corner the
//     neighboring curve crosses it and the half-plane cuts interior.
//
// Dokter's own fix is conversion-time: "locating them and pruning the offending crossings
// by INSERTING AN ADDITIONAL CURVE to the patch". That needs information global to the
// patch — which crossings are spurious — which a per-curve fragment test cannot see. So
// the remaining work is the six-stage converter, not a better evaluator.
import { cubicKLMN, cubicSignKLMN, affineEval } from '../src/geom/lbCubicMath.js';

const N = 256;

/// A CPatch curve: klm channels + the control points their affine frame is built on,
/// plus the orientation that makes "inside the patch" positive.
function cubicCurve(P, insidePt) {
  const klmn = cubicKLMN(P);
  if (!klmn) return null; // degenerate → caller falls back
  const f = (x, y) => {
    const k = affineEval(klmn.k, P, x, y);
    const l = affineEval(klmn.l, P, x, y);
    const m = affineEval(klmn.m, P, x, y);
    return k * k * k - l * m;
  };
  // Orient from a known interior point rather than from control-hull handedness:
  // the paper's cutting pipeline guarantees a consistent side, we just pick it.
  const s = f(insidePt[0], insidePt[1]) >= 0 ? 1 : -1;
  return { eval: (x, y) => s * f(x, y), kind: 'cubic' };
}

/// Quadratic bounding curve. Loop-Blinn's quadratic implicit u^2 - v, with (u,v) at the
/// control points (0,0), (1/2,0), (1,1) and affine over the control triangle. The paper
/// elevates quadratics to cubics and rides the same k^3-lm ("we can cause a quadratic to
/// masquerade as a cubic ... yielding c = k^3 - lk"); evaluating u^2 - v directly is the
/// same predicate and keeps the prototype's arithmetic honest.
function quadCurve(Q, insidePt) {
  const P = [Q[0], Q[1], Q[2]];
  const A = P[0],
    M = P[1],
    B = P[2];
  const U = [0, 0.5, 1],
    V = [0, 0, 1];
  const raw = (x, y) => {
    const u = affineEval(U, P, x, y),
      v = affineEval(V, P, x, y);
    return u * u - v;
  };
  const s = raw(insidePt[0], insidePt[1]) >= 0 ? 1 : -1;

  // EXTENSION CORRECTION. The implicit's zero set is the whole parabola, not the segment,
  // so beyond the endpoints the far arm curls back and cuts the patch — measured on the
  // n-gon family as 0% at N<=5 rising to 26% at N=16. Outside the span the curve is
  // replaced by its END TANGENT half-plane, which is the curve's own linear continuation:
  // it agrees with the curve to first order at the endpoint (so the boundary stays
  // continuous) and, being a line, has no far arm to come back.
  //
  // The CHORD is the wrong fallback: for an OUTWARD bulge the chord lies INSIDE the curve,
  // so using it beyond the span cuts away real interior near every corner — ink collapses
  // to a third and AA error goes to 236/255.
  const tanA = [M[0] - A[0], M[1] - A[1]];
  const tanB = [B[0] - M[0], B[1] - M[1]];
  const half = (O, t) => {
    let nx = -t[1],
      ny = t[0];
    const L = Math.hypot(nx, ny) || 1;
    nx /= L;
    ny /= L;
    const sgn = (insidePt[0] - O[0]) * nx + (insidePt[1] - O[1]) * ny >= 0 ? 1 : -1;
    return (x, y) => sgn * ((x - O[0]) * nx + (y - O[1]) * ny);
  };
  const hA = half(A, tanA),
    hB = half(B, tanB);
  const abx = B[0] - A[0],
    aby = B[1] - A[1];
  const ab2 = abx * abx + aby * aby || 1;
  return {
    eval: (x, y) => {
      const t = ((x - A[0]) * abx + (y - A[1]) * aby) / ab2;
      if (t < 0) return hA(x, y);
      if (t > 1) return hB(x, y);
      return s * raw(x, y);
    },
    kind: 'quad',
  };
}

/// Straight line through A→B, in the paper's k=0, m=1, l=signed-distance form.
function lineCurve(A, B, insidePt) {
  const dx = B[0] - A[0],
    dy = B[1] - A[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L,
    ny = dx / L;
  const f = (x, y) => -((x - A[0]) * nx + (y - A[1]) * ny); // f = k^3 - l*m with k=0,m=1
  const s = f(insidePt[0], insidePt[1]) >= 0 ? 1 : -1;
  return { eval: (x, y) => s * f(x, y), kind: 'line' };
}

/// The whole primitive: inside iff every bounding curve says inside.
const inPatch = (curves, x, y) => curves.every((c) => c.eval(x, y) >= 0);

// ---- test shapes -----------------------------------------------------------------
// Each is a closed region bounded by curves that is ALREADY a valid CPatch (convex in
// the half-space sense). The paper's six-stage cutting pipeline exists to produce these
// from arbitrary SVG; it is deliberately out of scope here.
const SHAPES = {
  // a lens: two cubics bulging opposite ways
  lens: () => {
    const A = [60, 128],
      B = [196, 128];
    const top = [A, [90, 40], [166, 40], B];
    const bot = [B, [166, 216], [90, 216], A];
    return { curves: [top, bot], inside: [128, 128], type: ['cubic', 'cubic'] };
  },
  // an arch: one cubic over a straight base
  arch: () => {
    const A = [50, 200],
      B = [206, 200];
    const top = [A, [50, 40], [206, 40], B];
    return { curves: [top, [B, A]], inside: [128, 160], type: ['cubic', 'line'] };
  },
  // a curved triangle, every edge bulging OUTWARD from the centroid — the region is
  // then genuinely the intersection of the three half-spaces
  tri: () => {
    const p0 = [128, 46],
      p1 = [206, 196],
      p2 = [50, 196];
    const C = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3];
    const q = (a, b, amt) => {
      const mx = (a[0] + b[0]) / 2,
        my = (a[1] + b[1]) / 2;
      let ox = mx - C[0],
        oy = my - C[1];
      const L = Math.hypot(ox, oy) || 1;
      return [a, [mx + (ox / L) * amt, my + (oy / L) * amt], b];
    };
    return {
      curves: [q(p0, p1, 30), q(p1, p2, 30), q(p2, p0, 30)],
      inside: C,
      type: ['quad', 'quad', 'quad'],
    };
  },
  // deliberate LIMIT CASE: one edge bulges INWARD, so the region is NOT the intersection
  // of the half-spaces. The paper's six-stage cutting pipeline exists precisely to split
  // shapes like this into pieces that are — this row measures what that cutting BUYS.
  concave: () => {
    const p0 = [128, 46],
      p1 = [206, 196],
      p2 = [50, 196];
    const C = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3];
    const q = (a, b, amt) => {
      const mx = (a[0] + b[0]) / 2,
        my = (a[1] + b[1]) / 2;
      let ox = mx - C[0],
        oy = my - C[1];
      const L = Math.hypot(ox, oy) || 1;
      return [a, [mx + (ox / L) * amt, my + (oy / L) * amt], b];
    };
    return {
      curves: [q(p0, p1, 30), q(p1, p2, -34), q(p2, p0, 30)],
      inside: C,
      type: ['quad', 'quad', 'quad'],
    };
  },
  // N-gon of outward-bulging quadratics — the family that exposed the EXTENSION bug on
  // GPU at N=12: a quadratic's implicit is the whole parabola, and with many curves the
  // far arms cut back into the patch.
  ...Object.fromEntries(
    [3, 5, 8, 12, 16].map((n) => [
      'ngon' + n,
      () => {
        const C = [128, 128],
          R = 90,
          amt = 16;
        const pt = (j) => [
          C[0] + R * Math.cos((2 * Math.PI * j) / n),
          C[1] + R * Math.sin((2 * Math.PI * j) / n),
        ];
        const curves = [],
          type = [];
        for (let j = 0; j < n; j++) {
          const a = pt(j),
            b = pt((j + 1) % n);
          const mx = (a[0] + b[0]) / 2,
            my = (a[1] + b[1]) / 2;
          let ox = mx - C[0],
            oy = my - C[1];
          const L = Math.hypot(ox, oy) || 1;
          curves.push([a, [mx + (ox / L) * amt, my + (oy / L) * amt], b]);
          type.push('quad');
        }
        return { curves, inside: C, type };
      },
    ]),
  ),
};

/// Reference: exact even/odd ray crossing against the true curves (not the implicit).
function refInside(spec, x, y) {
  let w = 0;
  const B = (P, t) => {
    const u = 1 - t;
    return [
      u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
    ];
  };
  const cross = (a, b) => {
    if (a[1] > y === b[1] > y) return 0;
    const xi = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    return xi > x ? (b[1] > a[1] ? 1 : -1) : 0;
  };
  for (let ci = 0; ci < spec.curves.length; ci++) {
    const C = spec.curves[ci];
    if (spec.type[ci] === 'line') {
      w += cross(C[0], C[1]);
      continue;
    }
    const Q = (P, t) => {
      const u = 1 - t;
      return [
        u * u * P[0][0] + 2 * u * t * P[1][0] + t * t * P[2][0],
        u * u * P[0][1] + 2 * u * t * P[1][1] + t * t * P[2][1],
      ];
    };
    const ev = spec.type[ci] === 'quad' ? Q : B;
    const K = 512;
    let prev = ev(C, 0);
    for (let i = 1; i <= K; i++) {
      const cur = ev(C, i / K);
      w += cross(prev, cur);
      prev = cur;
    }
  }
  return w !== 0;
}

console.log('shape   curves   px inside (cpatch / ref)   disagree   worst run');
let anyFail = false;
for (const [name, mk] of Object.entries(SHAPES)) {
  const spec = mk();
  const curves = spec.curves.map((C, i) =>
    spec.type[i] === 'line'
      ? lineCurve(C[0], C[1], spec.inside)
      : spec.type[i] === 'quad'
        ? quadCurve(C, spec.inside)
        : cubicCurve(C, spec.inside),
  );
  if (curves.some((c) => !c)) {
    console.log(`${name.padEnd(7)} DEGENERATE klmn — skipped`);
    continue;
  }
  let inA = 0,
    inB = 0,
    bad = 0,
    run = 0,
    worst = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5,
        py = y + 0.5;
      const a = inPatch(curves, px, py),
        b = refInside(spec, px, py);
      if (a) inA++;
      if (b) inB++;
      if (a !== b) {
        bad++;
        run++;
        if (run > worst) worst = run;
      } else run = 0;
    }
  }
  const pct = ((100 * bad) / (N * N)).toFixed(2);
  if (bad > N * N * 0.01) anyFail = true;
  console.log(
    `${name.padEnd(7)} ${String(curves.length).padStart(6)} ${String(inA).padStart(11)} / ${String(inB).padStart(6)} ` +
      `${String(bad).padStart(10)} (${pct}%) ${String(worst).padStart(6)}`,
  );
}
console.log(
  anyFail
    ? '\nFAIL — the half-space conjunction does not reproduce the region.'
    : '\nThe conjunction reproduces the region: CPatch fills a curved area with NO triangulation.',
);
