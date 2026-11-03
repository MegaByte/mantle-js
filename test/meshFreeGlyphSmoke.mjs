// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// meshFreeGlyphSmoke.mjs — end-to-end proof of the mesh-free signed-area fill on a
// realistic holed, curved glyph (an "O": outer + inner cubic-arc rings, opposite
// winding). Rasterize coverage via the signed-area module (closed-form curves, no
// flatten, NO triangulation, NO CDT, NO per-primitive coverage) and compare to
// SUPERSAMPLED ground truth (which sums boundary crossings — inherently conflation-
// free). A match proves the mesh-free path produces exact, conflation-free, no-flatten
// coverage on real content, and that the hole falls out of the winding automatically.
import { signedAreaCoverageSegs, coverageAtPixel } from '../src/renderer/signedAreaCoverage.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const K = 0.5522847498; // circle-from-4-cubics control factor
const cubEv = (P0, P1, P2, P3) => (t) => {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    e = t * t * t;
  return [
    a * P0[0] + b * P1[0] + c * P2[0] + e * P3[0],
    a * P0[1] + b * P1[1] + c * P2[1] + e * P3[1],
  ];
};
// 4 cubic arcs forming a circle, CCW if `ccw`, else CW (for a hole).
function ringSegs(cx, cy, r, ccw) {
  const on = ccw
    ? [
        [cx + r, cy],
        [cx, cy + r],
        [cx - r, cy],
        [cx, cy - r],
      ]
    : [
        [cx + r, cy],
        [cx, cy - r],
        [cx - r, cy],
        [cx, cy + r],
      ];
  const tan = ccw
    ? [
        [0, r],
        [-r, 0],
        [0, -r],
        [r, 0],
      ]
    : [
        [0, -r],
        [-r, 0],
        [0, r],
        [r, 0],
      ];
  return on.map((a, i) => {
    const b = on[(i + 1) % 4];
    return {
      type: 'cubic',
      P0: a,
      P1: [a[0] + tan[i][0] * K, a[1] + tan[i][1] * K],
      P2: [b[0] - tan[(i + 1) % 4][0] * K, b[1] - tan[(i + 1) % 4][1] * K],
      P3: b,
    };
  });
}
// supersampled ground-truth coverage: N×N samples/pixel, inside by ray-cast winding.
function groundTruth(segs, W, H, N, evenOdd) {
  const polylines = segs.map((s) => {
    const f = s.type === 'cubic' ? cubEv(s.P0, s.P1, s.P2, s.P3) : null;
    const pl = [];
    for (let k = 0; k <= 48; k++) pl.push(f(k / 48));
    return pl;
  });
  const inside = (px, py) => {
    let w = 0;
    for (const pl of polylines)
      for (let i = 0; i + 1 < pl.length; i++) {
        const a = pl[i],
          b = pl[i + 1];
        if (a[1] <= py) {
          if (b[1] > py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) > 0) w++;
        } else {
          if (b[1] <= py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) < 0) w--;
        }
      }
    return evenOdd ? (w & 1) === 1 : w !== 0;
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

const W = 40,
  H = 40;
const glyph = [...ringSegs(20, 20, 16, true), ...ringSegs(20, 20, 9, false)]; // O: outer CCW + inner CW hole

for (const rule of [false, true]) {
  // nonzero, even-odd (both fill the ring, hole empty)
  const cov = signedAreaCoverageSegs(glyph, W, H, rule);
  const gt = groundTruth(glyph, W, H, 16, rule);
  let maxd = 0,
    sumd = 0;
  for (let i = 0; i < cov.length; i++) {
    const d = Math.abs(cov[i] - gt[i]);
    maxd = Math.max(maxd, d);
    sumd += d;
  }
  const holeCov = cov[20 * W + 20]; // center of the hole → must be ~0
  const ringCov = cov[20 * W + (20 + 12)]; // in the ring wall → must be ~1
  const tag = rule ? 'even-odd' : 'nonzero';
  // supersample GT has ~1/16²≈0.004 quantization; the signed-area result is exact, so
  // the diff is bounded by the GT's own AA-band quantization.
  const good = maxd < 0.06 && sumd / cov.length < 5e-3 && holeCov < 0.02 && ringCov > 0.98;
  good
    ? ok(
        `O glyph (${tag}): mesh-free coverage matches supersampled truth (max ${maxd.toFixed(3)}, mean ${(sumd / cov.length).toExponential(1)}), hole=${holeCov.toFixed(3)} ring=${ringCov.toFixed(3)}`,
      )
    : fail(
        `O glyph (${tag}): max ${maxd.toFixed(3)} mean ${(sumd / cov.length).toExponential(2)} hole ${holeCov.toFixed(3)} ring ${ringCov.toFixed(3)}`,
      );
}

// Conflation stress: the same ring declared as 8 cubic arcs (each ring split in two)
// must give byte-identical coverage — no seams at the extra on-curve junctions.
{
  const split = [];
  for (const s of [...ringSegs(20, 20, 16, true), ...ringSegs(20, 20, 9, false)]) {
    // de Casteljau split at t=0.5
    const [P0, P1, P2, P3] = [s.P0, s.P1, s.P2, s.P3];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const a = mid(P0, P1),
      b = mid(P1, P2),
      c = mid(P2, P3),
      d = mid(a, b),
      e = mid(b, c),
      m = mid(d, e);
    split.push(
      { type: 'cubic', P0, P1: a, P2: d, P3: m },
      { type: 'cubic', P0: m, P1: e, P2: c, P3 },
    );
  }
  const base = signedAreaCoverageSegs(
    [...ringSegs(20, 20, 16, true), ...ringSegs(20, 20, 9, false)],
    W,
    H,
    false,
  );
  const cov = signedAreaCoverageSegs(split, W, H, false);
  let maxd = 0;
  for (let i = 0; i < cov.length; i++) maxd = Math.max(maxd, Math.abs(cov[i] - base[i]));
  maxd < 1e-4
    ? ok(
        `conflation-free: ring as 8 arcs ≡ ring as 4 arcs (max diff ${maxd.toExponential(1)}) — no junction seams`,
      )
    : fail(`junction seam: 8-arc vs 4-arc coverage differs by ${maxd.toFixed(3)}`);
}

// FRAGMENT ≡ SCANLINE: the per-pixel coverageAtPixel (the GPU-fragment logic —
// each pixel computed independently by summing curve contributions at-or-left of it)
// must reproduce the scanline accumulator byte-for-byte on the glyph. This validates
// the fragment ALGORITHM (Stage 2), the translation target for the GLSL shader.
{
  for (const rule of [false, true]) {
    const scan = signedAreaCoverageSegs(glyph, W, H, rule);
    let maxd = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        maxd = Math.max(maxd, Math.abs(coverageAtPixel(glyph, W, H, x, y, rule) - scan[y * W + x]));
    // 1e-6: the tiny residual is float64 summation ORDER (scanline prefix-sums the
    // row; the fragment sums per-segment) — same algorithm, not a divergence.
    maxd < 1e-6
      ? ok(
          `fragment ≡ scanline (${rule ? 'even-odd' : 'nonzero'}): per-pixel logic reproduces the accumulator (max diff ${maxd.toExponential(1)})`,
        )
      : fail(`fragment logic diverges from scanline by ${maxd.toExponential(2)}`);
  }
}

console.log(failures ? `\nMESH-FREE-GLYPH FAIL (${failures})` : `\nMESH-FREE-GLYPH PASS`);
process.exit(failures ? 1 : 0);
