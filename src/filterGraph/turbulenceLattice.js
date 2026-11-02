// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// turbulenceLattice.js — feTurbulence's seeded tables and stitch setup, per the Filter Effects 1 reference
// implementation (the C code in the feTurbulence section), computed on the CPU. No GL.
//
// init(seed) fills a lattice selector (a permutation of 0..255, shuffled by the spec's Park-Miller random())
// and four channels of 256 unit gradients; noise2 reads gradient[selector[selector[bx] + by]]. The shader takes
// the tables as one 256x3 RGBA32F texture (packLatticeTexels), built once per seed by the feTurbulence handler
// and only when a turbulence is drawn.
//
// The packed gradients are PRE-PERMUTED: texel m of rows 1-2 holds gradient[selector[m]], so the shader's
// b00 = (selector[bx0] + by0) & 255 indexes it directly. The spec extends both tables to 2 * 256 + 2 entries
// with selector[256 + k] = selector[k], so selector[i + by0] is selector[(i + by0) & 255] and
// gradient[selector[(i + by0) & 255]] is this texel -- the same value, one fetch fewer. (Skia does the same.)

export const BSIZE = 0x100;
export const BM = 0xff;
export const PERLIN_N = 0x1000;
const RAND_M = 2147483647; // 2**31 - 1
const RAND_A = 16807; // 7**5; primitive root of m
const RAND_Q = 127773; // m / a
const RAND_R = 2836; // m % a

/// The spec's setup_seed. `seed` is already an integer (see latticeSeed).
export function setupSeed(seed) {
  let s = seed;
  if (s <= 0) s = -(s % (RAND_M - 1)) + 1;
  if (s > RAND_M - 1) s = RAND_M - 1;
  return s;
}

/// The spec's random(): Park-Miller "minimal standard", Schrage's method. C's `/` and `%` on positive longs.
export function random(s) {
  let r = RAND_A * (s % RAND_Q) - RAND_R * Math.trunc(s / RAND_Q);
  if (r <= 0) r += RAND_M;
  return r;
}

/// The seed attribute as the algorithm takes it: "truncated, i.e. rounded to the closest integer value towards
/// zero" (Filter Effects 1, feTurbulence `seed`). Skia truncates too.
export function latticeSeed(seed) {
  const s = Math.trunc(Number(seed) || 0);
  return Number.isFinite(s) ? s : 0;
}

/// The spec's init(lSeed): `{ selector: Int32Array(256), gradient: Float64Array(4 * 256 * 2) }`, gradient
/// channel-major, (x, y) per entry. A zero-length gradient -- both random components landing on 0, about one
/// seed in 250 -- is left (0, 0): the spec's C divides by zero there, and Skia keeps the zero vector.
export function turbulenceLattice(seed) {
  let s = setupSeed(latticeSeed(seed));
  const selector = new Int32Array(BSIZE);
  const gradient = new Float64Array(4 * BSIZE * 2);
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < BSIZE; i++) {
      selector[i] = i;
      const o = (k * BSIZE + i) * 2;
      for (let j = 0; j < 2; j++)
        gradient[o + j] = (((s = random(s)) % (BSIZE + BSIZE)) - BSIZE) / BSIZE;
      const n = Math.sqrt(gradient[o] * gradient[o] + gradient[o + 1] * gradient[o + 1]);
      if (n > 0) {
        gradient[o] /= n;
        gradient[o + 1] /= n;
      }
    }
  }
  for (let i = BSIZE - 1; i > 0; i--) {
    // the spec's while(--i), i from BSize
    const k = selector[i];
    const j = (s = random(s)) % BSIZE;
    selector[i] = selector[j];
    selector[j] = k;
  }
  return { selector, gradient };
}

/// The texture feTurbulence.frag.glsl reads (256 x 3 RGBA32F, row-major, row 0 first):
///   row 0: .r = selector[m]
///   row 1: gradient[c][selector[m]].x for channels c = 0..3 (R, G, B, A)
///   row 2: gradient[c][selector[m]].y
export function packLatticeTexels({ selector, gradient }) {
  const out = new Float32Array(BSIZE * 3 * 4);
  for (let m = 0; m < BSIZE; m++) {
    out[m * 4] = selector[m];
    const g = selector[m];
    for (let c = 0; c < 4; c++) {
      out[(BSIZE + m) * 4 + c] = gradient[(c * BSIZE + g) * 2];
      out[(2 * BSIZE + m) * 4 + c] = gradient[(c * BSIZE + g) * 2 + 1];
    }
  }
  return out;
}

/// The spec's stitch setup, in float64 as the spec computes it: the base frequency snapped to whichever of the two
/// nearest values fits a whole number of lattice cells across the tile, and the lattice period and wrap point in
/// cells. `tile` is (x, y, width, height) in the same user space as the noise's point. Returns the frequencies the
/// noise uses, and -- when stitching -- `size` (the spec's nWidth, nHeight) and `wrap` (nWrapX, nWrapY WITHOUT the
/// PerlinN offset the C code carries to keep its truncation positive: the shader floors instead).
export function turbulenceSetup(baseFreqX, baseFreqY, stitch, tile) {
  let fx = baseFreqX,
    fy = baseFreqY;
  if (!stitch) return { fx, fy, size: null, wrap: null };
  const [tx, ty, tw, th] = tile;
  if (fx !== 0) {
    const lo = Math.floor(tw * fx) / tw,
      hi = Math.ceil(tw * fx) / tw;
    fx = fx / lo < hi / fx ? lo : hi;
  }
  if (fy !== 0) {
    const lo = Math.floor(th * fy) / th,
      hi = Math.ceil(th * fy) / th;
    fy = fy / lo < hi / fy ? lo : hi;
  }
  const nW = Math.trunc(tw * fx + 0.5),
    nH = Math.trunc(th * fy + 0.5);
  // C assigns the double to an int: truncation toward zero.
  const wX = Math.trunc(tx * fx + PERLIN_N + nW) - PERLIN_N;
  const wY = Math.trunc(ty * fy + PERLIN_N + nH) - PERLIN_N;
  return { fx, fy, size: [nW, nH], wrap: [wX, wY] };
}
