// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cubicLoopSplit — does the split cubicLoopParams documents actually work?
//
// Its docstring asserts: "Splitting the cubic at lo AND hi yields three simple
// (non-self-intersecting) pieces — the tails [0,lo], [hi,1] and the loop body
// [lo,hi] — each of which the ordinary klmn/Bezout crescent + CDT winding renders
// exactly." No renderer uses the split: the call sites use the function through
// `!!` / `.HasValue`, so {lo,hi} is computed on every cubic and never read.
//
// This verifies the claim:
//   1. the double point is real  — B(lo) == B(hi) to fp tolerance
//   2. each of the three pieces is loop-free (cubicLoopParams -> null)
//   3. each piece has a usable single-branch implicit (cubicKLMN -> non-null),
//      which is the property the renderers actually need
// IT DOES NOT WORK FOR GWN — the reason is the useful part.
//
// Splitting the GWN encoder's cubics at {lo,hi} (in textures.js) takes the
// winding-only arm from 0.559 to 18.446 mean error, max 255, on a loop fixture.
// The split itself is fine; the RENDERER is wrong for it.
//
// The docstring says the pieces render exactly under "klmn/Bezout crescent + CDT
// winding", and CDT is the operative word. GWN's winding is a ray-crossing count
// over a frontier polygon of piece CHORDS. The loop body [lo,hi] has B(lo)==B(hi)
// — that is what a double point IS — so its chord is a POINT, contributes no
// crossing, and its interior winding vanishes. Every fill inside the loop is lost.
//
// So the split belongs to a renderer whose winding comes from a triangulation, not
// from chords: LB, which today declines loops to Slug outright (lbFastMesh:178,
// lbPartition:135, and the C# mirrors). GWN must keep type-6 chord coverage and
// pay the ~2x AA error on this class.
//
// If a previous attempt "failed", a degenerate chord in a chord-winding kernel is
// the shape of failure to expect — silent, total, and only on shapes with loops.
import {
  cubicLoopParams,
  splitCubicMulti,
  cubicKLMN,
  cubicInflections,
} from '../src/geom/lbCubicMath.js';

const B = (P, t) => {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0],
    a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1],
  ];
};

// Loop cubics: control polygon crosses, plus a couple of near-cusp cases.
const CASES = {
  'classic loop': [
    [120, 260],
    [380, 80],
    [20, 80],
    [280, 260],
  ],
  'tight loop': [
    [100, 200],
    [300, 100],
    [100, 100],
    [300, 200],
  ],
  'wide loop': [
    [50, 300],
    [450, 60],
    [-50, 60],
    [350, 300],
  ],
  'asym loop': [
    [100, 250],
    [400, 90],
    [60, 120],
    [240, 270],
  ],
  'near cusp': [
    [120, 280],
    [340, 60],
    [120, 60],
    [200, 300],
  ],
  'tall loop': [
    [200, 320],
    [360, 40],
    [40, 40],
    [200, 320],
  ],
  'shallow loop': [
    [100, 200],
    [260, 140],
    [140, 140],
    [300, 200],
  ],
};

let pass = 0,
  fail = 0;
console.log('case             lo      hi    |B(lo)-B(hi)|   pieces  loop-free  klmn-ok');
for (const [name, P] of Object.entries(CASES)) {
  const lp = cubicLoopParams(P);
  if (!lp) {
    console.log(`${name.padEnd(15)}  (not detected as a loop)`);
    continue;
  }
  const { lo, hi } = lp;
  const dp = Math.hypot(B(P, lo)[0] - B(P, hi)[0], B(P, lo)[1] - B(P, hi)[1]);
  // Degenerate branch: discST<1e-6 returns lo==hi (a CUSP, not a loop). The middle
  // piece is then zero-length, so the three-way split does not apply.
  const degenerate = Math.abs(hi - lo) < 1e-9;
  const ts = degenerate ? [lo] : [lo, hi];
  const pieces = splitCubicMulti(P, ts);
  let loopFree = 0,
    klmnOk = 0;
  for (const q of pieces) {
    if (!cubicLoopParams(q)) loopFree++;
    if (cubicKLMN(q)) klmnOk++;
  }
  const ok = !degenerate && loopFree === pieces.length && klmnOk === pieces.length && dp < 1e-6;
  if (ok) pass++;
  else fail++;
  console.log(
    `${name.padEnd(15)} ${lo.toFixed(4)} ${hi.toFixed(4)} ${dp.toExponential(2).padStart(14)} ` +
      `${String(pieces.length).padStart(7)} ${String(loopFree + '/' + pieces.length).padStart(10)} ` +
      `${String(klmnOk + '/' + pieces.length).padStart(8)}${degenerate ? '  [cusp: lo==hi]' : ''}${ok ? '' : '   <-- FAIL'}`,
  );
}
console.log(`\n${pass} pass, ${fail} fail`);
console.log('loop-free = the split removed the self-intersection.');
console.log('klmn-ok   = each piece has the single-branch implicit the renderers need.');
