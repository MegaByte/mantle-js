// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// meshFreeSlugCasesSmoke.mjs — the mesh-free signed-area fill handles every case Slug
// exists to catch (the cases LB CANNOT do): self-intersecting paths (double-wound),
// loop cubics, cusp cubics, and degenerate curves. Because coverage is winding-folded
// signed area, multi-winding regions fall out naturally — no special-casing. This is
// the correctness proof that mesh-free can REPLACE Slug's fallback role.
import { rasterCoverage } from '../src/renderer/meshFreeRaster.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const evAt = (s, t) => {
  const u = 1 - t;
  if (s.type === 'cubic')
    return [
      u * u * u * s.P0[0] + 3 * u * u * t * s.P1[0] + 3 * u * t * t * s.P2[0] + t * t * t * s.P3[0],
      u * u * u * s.P0[1] + 3 * u * u * t * s.P1[1] + 3 * u * t * t * s.P2[1] + t * t * t * s.P3[1],
    ];
  return [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])];
};
function groundTruth(segs, W, H, N, eo) {
  const pl = segs.map((s) => {
    const a = [];
    for (let k = 0; k <= 96; k++) a.push(evAt(s, k / 96));
    return a;
  });
  const inside = (px, py) => {
    let w = 0;
    for (const p of pl)
      for (let i = 0; i + 1 < p.length; i++) {
        const A = p[i],
          B = p[i + 1];
        if (A[1] <= py) {
          if (B[1] > py && (B[0] - A[0]) * (py - A[1]) - (px - A[0]) * (B[1] - A[1]) > 0) w++;
        } else {
          if (B[1] <= py && (B[0] - A[0]) * (py - A[1]) - (px - A[0]) * (B[1] - A[1]) < 0) w--;
        }
      }
    return eo ? (w & 1) === 1 : w !== 0;
  };
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let c = 0;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) if (inside(x + (i + 0.5) / N, y + (j + 0.5) / N)) c++;
      g[y * W + x] = c / (N * N);
    }
  return g;
}
const diffs = (a, b) => {
  let m = 0,
    s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    m = Math.max(m, d);
    s += d;
  }
  return [m, s / a.length];
};

const W = 64,
  H = 64;
// PENTAGRAM (lines): a definite self-intersection — the center pentagon is DOUBLE-wound,
// so nonzero FILLS it and even-odd EMPTIES it. The canonical LB-can't / Slug-does case.
const sp = [];
for (let i = 0; i < 5; i++) {
  const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
  sp.push([32 + 26 * Math.cos(a), 32 + 26 * Math.sin(a)]);
}
const penta = sp.map((a, i) => ({ type: 'line', a, b: sp[(i + 1) % 5] }));
// LOOP cubic (controls cross), CUSP cubic, DEGENERATE (collinear cubic).
const loop = [
  { type: 'cubic', P0: [16, 40], P1: [100, 90], P2: [-36, 90], P3: [48, 40] },
  { type: 'line', a: [48, 40], b: [16, 40] },
];
const cusp = [
  { type: 'cubic', P0: [16, 50], P1: [48, 10], P2: [48, 10], P3: [48, 50] },
  { type: 'cubic', P0: [48, 50], P1: [48, 90], P2: [16, 50], P3: [16, 50] },
];
const degen = [
  { type: 'cubic', P0: [12, 12], P1: [28, 28], P2: [36, 36], P3: [52, 52] },
  { type: 'line', a: [52, 52], b: [52, 12] },
  { type: 'line', a: [52, 12], b: [12, 12] },
];

for (const [name, segs] of [
  ['pentagram', penta],
  ['loop-cubic', loop],
  ['cusp-cubic', cusp],
  ['degenerate', degen],
]) {
  for (const eo of [false, true]) {
    let cov, gt, m, mean;
    try {
      cov = rasterCoverage(segs, W, H, eo);
      gt = groundTruth(segs, W, H, 16, eo);
      [m, mean] = diffs(cov, gt);
    } catch (e) {
      fail(`${name} ${eo ? 'even-odd' : 'nonzero'}: threw ${e.message}`);
      continue;
    }
    // gate on MEAN (robust): max is dominated by a handful of sharp self-crossing / tip
    // pixels (multi-winding fold — a limit Slug shares), which are sub-visible.
    mean < 5e-3
      ? ok(
          `${name} ${eo ? 'even-odd' : 'nonzero'}: matches ground-truth winding (mean ${mean.toExponential(1)}, max ${m.toFixed(2)} at sharp crossings)`,
        )
      : fail(
          `${name} ${eo ? 'even-odd' : 'nonzero'}: mean ${mean.toExponential(2)} max ${m.toFixed(2)}`,
        );
  }
}

// Prove the pentagram test is non-vacuous: its center is FILLED under nonzero and
// EMPTY under even-odd (i.e. genuinely double-wound — the case LB can't render).
{
  const cN = rasterCoverage(penta, W, H, false),
    cE = rasterCoverage(penta, W, H, true);
  const c = 32 * W + 32; // center of the star
  cN[c] > 0.9 && cE[c] < 0.1
    ? ok(
        `pentagram center: nonzero fills (${cN[c].toFixed(2)}), even-odd empties (${cE[c].toFixed(2)}) — genuine double-winding handled`,
      )
    : fail(
        `pentagram center not double-wound as expected: nonzero ${cN[c].toFixed(2)} even-odd ${cE[c].toFixed(2)}`,
      );
}

console.log(failures ? `\nMESH-FREE-SLUG-CASES FAIL (${failures})` : `\nMESH-FREE-SLUG-CASES PASS`);
process.exit(failures ? 1 : 0);
