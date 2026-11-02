// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMorphValidity — does a tape-paired CPatch morph stay VALID between its endpoints?
//
// _cpatchMorphStability answers a different question: can two poses be made to decompose the
// same way, so their patches can be paired at all. The decision tape solved that (4/20 -> 20/20).
// This asks the one that decides whether a CPatch morph can ship: the frames actually drawn are
// INTERPOLATIONS, and nothing about pairing the endpoints says the patch halfway between them
// is a patch. A CPatch is only a primitive while its region equals the intersection of its
// bounding curves' half-spaces, and that property is not preserved by lerping control points.
//
// The answer is no, and the failure is not marginal: with rotation in the morph it goes invalid
// within one or two percent of the way in.
//
// SAMPLING t IS NOT A PROOF, and this probe does not pretend otherwise — it reports a LOWER
// BOUND on how badly a morph breaks. A shipping guarantee needs a certificate over the whole
// interval, established once at build time: the implicits are polynomial in the control points
// and the control points are affine in t, so the validity condition is a polynomial in (curve
// parameter, t) and its non-negativity over the unit square can be certified by the bivariate
// Bernstein coefficients, subdividing in t where the bound is inconclusive. That is the shape of
// the real fix, and it is why per-frame revalidation is not one: it is the same sampling, paid
// every frame.
import { convertContour, framePatch, validatePatch } from '../src/renderer/cpatchConvert.js';

const K = 6;
/// Two poses of one blob. `phase` rotates as it morphs, which is what real motion does and what
/// pure scaling hides.
function blob(t, R0 = 40, R1 = 62, phase = 0) {
  const R = R0 + (R1 - R0) * t,
    cx = 100,
    cy = 100;
  const P = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const bow = 0.3 + 0.14 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow;
    const my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push({ t: 'quad', P: [A, [mx, my], B] });
  }
  return out;
}

const OPT = { maxCurves: 8, tolPx: 0.05 };
const lerpSeg = (a, b, u) => ({
  t: a.t,
  cut: a.cut,
  P: a.P.map((q, i) => [q[0] + (b.P[i][0] - q[0]) * u, q[1] + (b.P[i][1] - q[1]) * u]),
});

/// Every paired patch, framed and validated at one interpolation parameter.
function poseOk(src, dst, u) {
  for (let pi = 0; pi < src.patches.length; pi++) {
    const a = src.patches[pi],
      b = dst.patches[pi];
    if (!b || a.curves.length !== b.curves.length) return 'unpaired';
    const f = framePatch(a.curves.map((s, i) => lerpSeg(s, b.curves[i], u)));
    if (!f) return 'degenerate';
    if (!validatePatch(f, OPT.tolPx).ok) return 'invalid';
  }
  return null;
}

console.log(
  '\ntape-paired morph, validity across the interpolation (201 samples — a LOWER BOUND)\n',
);
console.log('  rotation | patches | bad poses | first failure | reason');
console.log('  ' + '-'.repeat(62));
const N = 201;
for (const phase of [0, 0.2, 0.35, 0.6, 1.0]) {
  const tape = [];
  const src = convertContour(blob(0, 40, 62, phase), { ...OPT, record: tape });
  const dst = convertContour(blob(1, 40, 62, phase), { ...OPT, follow: tape });
  if (!dst) {
    console.log(
      `  ${String(phase).padEnd(8)} | ${String(src.patches.length).padStart(7)} | tape REFUSED`,
    );
    continue;
  }
  let bad = 0,
    first = null,
    why = null;
  for (let k = 0; k < N; k++) {
    const r = poseOk(src, dst, k / (N - 1));
    if (!r) continue;
    bad++;
    if (first === null) {
      first = (k / (N - 1)).toFixed(3);
      why = r;
    }
  }
  console.log(
    `  ${String(phase).padEnd(8)} | ${String(src.patches.length).padStart(7)} | ${String(bad).padStart(4)}/${N}  | ${String(first ?? '-').padStart(13)} | ${why ?? 'none found'}`,
  );
}
console.log(`
  Pure scaling (rotation 0) survives; anything that rotates does not, and it fails within one or
  two percent of the start rather than drifting out gradually. So the decision tape is necessary
  and nowhere near sufficient: it makes the endpoints pairable, and says nothing about the frames
  in between, which are the only frames a morph actually draws.`);
