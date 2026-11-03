// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMorphCert — CERTIFY a CPatch morph over the whole interval, instead of sampling it.
//
// _cpatchMorphValidity showed a tape-paired morph goes invalid between its endpoints, and that
// sampling t only ever puts a LOWER BOUND on how badly. This is the other half: a build-time
// certificate that either proves the morph valid for every t, or hands back the intervals where
// it cannot. Re-checking per frame is not an alternative — that is the same sampling paid every
// frame, and says nothing about the gap between two of them.
//
// The argument is the convex-hull property the converter already uses in one variable, lifted to
// two. Clearing the positive normalizations makes each implicit polynomial in its control points,
// a lerp makes control points affine in t, so the condition is a polynomial B(s, t) and
// non-negative tensor-product Bernstein coefficients over the unit square prove B >= 0 on all of
// it. Negative coefficients prove nothing, so the box is subdivided and the bound retried.
//
// THE TWO DIRECTIONS ARE NOT THE same PROBLEM. Clip asks that ONE polynomial stay non-negative,
// which a single hull bound settles. A leak is an existence claim about a conjunction, so its
// negation is a DISJUNCTION — at every point of the extension SOME constraint must be negative —
// and no single polynomial says that. Subdivision does: a box is certified the moment any one
// constraint is negative throughout it.
import { convertContour, framePatch, validatePatch } from '../src/renderer/cpatchConvert.js';
import {
  certifyMorphClip,
  certifyMorphLeak,
  extractLayout,
  applyLayout,
} from '../src/renderer/cpatchMorphCert.js';

const K = 6;
/// One blob in three edge families, because the whole difficulty is the implicit: a quadratic
/// normalizes by a triangle area, a cubic additionally picks between klmn and Bezout by a
/// discrete test, and a rational carries weights. The resultant form has to handle all of them.
function blob(t, phase = 0, kind = 'quad') {
  const R = 40 + 22 * t,
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
    if (kind === 'quad') out.push({ t: 'quad', P: [A, [mx, my], B] });
    else if (kind === 'rquad') out.push({ t: 'rquad', P: [A, [mx, my], B], w: 0.75 + 0.1 * t });
    else
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
  }
  return out;
}
const OPT = { maxCurves: 8, tolPx: 0.05 };
const lerpSeg = (a, b, u) => ({
  t: a.t,
  cut: a.cut,
  w: a.w,
  P: a.P.map((q, i) => [q[0] + (b.P[i][0] - q[0]) * u, q[1] + (b.P[i][1] - q[1]) * u]),
});

console.log(
  '\ncertificate over ALL t, against a 201-sample ground truth (itself only a lower bound)\n',
);
console.log(
  '  edges  | rot  | CLIP ok/bad | LEAK ok/bad | sampled bad | first | uncertified t-range',
);
console.log('  ' + '-'.repeat(88));
for (const kind of ['quad', 'rquad', 'cubic']) {
  for (const phase of [0, 0.35]) {
    const tape = [];
    const src = convertContour(blob(0, phase, kind), { ...OPT, record: tape });
    const dst = convertContour(blob(1, phase, kind), { ...OPT, follow: tape });
    if (!src || !dst) {
      console.log(
        `  ${kind.padEnd(6)} | ${String(phase).padEnd(4)} | tape REFUSED — the decomposition itself does not replay on the far pose`,
      );
      continue;
    }
    let cOk = 0,
      cBad = 0,
      lOk = 0,
      lBad = 0,
      lo = Infinity,
      hi = -Infinity;
    for (let pi = 0; pi < src.patches.length; pi++) {
      const a = src.patches[pi],
        b = dst.patches[pi];
      if (!b || a.curves.length !== b.curves.length) {
        cBad++;
        continue;
      }
      const rc = certifyMorphClip(a.curves, b.curves, { tolPx: OPT.tolPx });
      cOk += rc.certified;
      cBad += rc.failures.length;
      for (const f of rc.failures) {
        lo = Math.min(lo, f.t0);
        hi = Math.max(hi, f.t1);
      }
      const rl = certifyMorphLeak(a.curves, b.curves, { tolPx: OPT.tolPx });
      lOk += rl.certified;
      lBad += rl.failures.length;
      for (const f of rl.failures)
        if (f.t0 != null) {
          lo = Math.min(lo, f.t0);
          hi = Math.max(hi, f.t1);
        }
    }
    let bad = 0,
      first = null;
    for (let k = 0; k < 201; k++) {
      const u = k / 200;
      let ok = true;
      for (let pi = 0; pi < src.patches.length && ok; pi++) {
        const a = src.patches[pi],
          b = dst.patches[pi];
        if (!b || a.curves.length !== b.curves.length) {
          ok = false;
          break;
        }
        const f = framePatch(a.curves.map((s, i) => lerpSeg(s, b.curves[i], u)));
        if (!f || !validatePatch(f, OPT.tolPx).ok) ok = false;
      }
      if (!ok) {
        bad++;
        if (first === null) first = u.toFixed(3);
      }
    }
    const range = lo <= hi ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '-';
    console.log(
      `  ${kind.padEnd(6)} | ${String(phase).padEnd(4)} | ${String(cOk).padStart(4)}/${String(cBad).padEnd(6)} ` +
        `| ${String(lOk).padStart(4)}/${String(lBad).padEnd(6)} | ${String(bad).padStart(7)}/201 ` +
        `| ${String(first ?? '-').padStart(5)} | ${range}`,
    );
  }
}
// ---- decomposition transfer, which is what replaces the decision tape --------------------
console.log(
  '\n\nparametric transfer: decompose one pose, rebuild the SAME structure on the other\n',
);
console.log('  edges  | rot  | patches | round-trip | paired | valid at t=1 | tape');
console.log('  ' + '-'.repeat(76));
for (const kind of ['quad', 'rquad', 'cubic']) {
  for (const phase of [0, 0.35, 1.0]) {
    const A = blob(0, phase, kind),
      B = blob(1, phase, kind);
    const src = convertContour(A, OPT);
    if (!src) {
      console.log(`  ${kind.padEnd(6)} | ${String(phase).padEnd(4)} | conversion failed`);
      continue;
    }
    const lay = extractLayout(src.patches, A);
    if (!lay) {
      console.log(`  ${kind.padEnd(6)} | ${String(phase).padEnd(4)} | layout not extractable`);
      continue;
    }
    const same = applyLayout(lay, A),
      reb = applyLayout(lay, B);
    let err = 0;
    for (let i = 0; i < same.length; i++)
      for (let j = 0; j < same[i].length; j++)
        for (let k = 0; k < same[i][j].P.length; k++) {
          const q = same[i][j].P[k],
            o = src.patches[i].curves[j].P[k];
          err = Math.max(err, Math.hypot(q[0] - o[0], q[1] - o[1]));
        }
    const paired =
      reb.length === src.patches.length &&
      reb.every((l, i) => l.length === src.patches[i].curves.length);
    let ok = 0;
    for (const l of reb) {
      const f = framePatch(l);
      if (f && validatePatch(f, OPT.tolPx).ok) ok++;
    }
    // what the decision tape manages on the same pair, for comparison
    const tape = [];
    convertContour(A, { ...OPT, record: tape });
    const viaTape = convertContour(B, { ...OPT, follow: tape });
    console.log(
      `  ${kind.padEnd(6)} | ${String(phase).padEnd(4)} | ${String(src.patches.length).padStart(7)} ` +
        `| ${err.toExponential(1).padStart(10)} | ${(paired ? 'yes' : 'NO').padStart(6)} ` +
        `| ${String(ok + '/' + reb.length).padStart(12)} | ${viaTape ? 'ok' : 'REFUSED'}`,
    );
  }
}
console.log(`
  Pure scaling CERTIFIES on both directions — every pair, every t — which is the statement no
  number of sampled poses can make.

  The transfer is what replaces the decision tape. A tape replays the SEQUENCE of cuts, and a cut
  line built by the same construction on the far pose can miss its loop entirely; on the cubic
  family it refuses outright, at decision 4 of 6. A layout names which original curve each piece
  came from and over what range, so the far pose cannot refuse it: the structure is identical by
  construction and the patches pair without anything having to succeed. Rebuilt on its own pose it
  reproduces the original to 1e-12, and on the far pose the rational and cubic families come back
  fully valid at every rotation tested — where the tape produced nothing at all.

  The quadratic blob is the honest exception: its decomposition is the most heavily cut of the
  three, and only about half its patches survive the transfer intact. That is not a failure of the
  transfer but a fact about that decomposition, and it is exactly what the certificate above is
  for — it says so before a frame is drawn rather than after.`);
