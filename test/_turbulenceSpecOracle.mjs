// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _turbulenceSpecOracle.mjs — the Filter Effects 1 feTurbulence reference implementation (the C code in the spec's
// feTurbulence section), transcribed to JavaScript in float64, line for line: setup_seed, random, init, noise2 with
// its 2 * BSize + 2 tables and uLatticeSelector[i + by0] indexing, turbulence with stitching. C's (int) casts are
// Math.trunc, and its % and / on longs are JS's truncating % and Math.trunc(a / b). Written independently of
// src/filterGraph/turbulenceLattice.js, which it is the oracle for (test/turbulenceSpecSmoke.mjs,
// test/turbulenceChromeSmoke.mjs). A zero-length gradient divides by zero here, as it does in the C.
const BSize = 0x100,
  BM = 0xff,
  PerlinN = 0x1000;
const RAND_m = 2147483647,
  RAND_a = 16807,
  RAND_q = 127773,
  RAND_r = 2836;
export function setup_seed(lSeed) {
  if (lSeed <= 0) lSeed = -(lSeed % (RAND_m - 1)) + 1;
  if (lSeed > RAND_m - 1) lSeed = RAND_m - 1;
  return lSeed;
}
export function random(lSeed) {
  let result = RAND_a * (lSeed % RAND_q) - RAND_r * Math.trunc(lSeed / RAND_q);
  if (result <= 0) result += RAND_m;
  return result;
}
export function specInit(lSeed) {
  const uLatticeSelector = new Int32Array(BSize + BSize + 2);
  const fGradient = [0, 1, 2, 3].map(() => Array.from({ length: BSize + BSize + 2 }, () => [0, 0]));
  let s, i, j, k;
  lSeed = setup_seed(lSeed);
  for (k = 0; k < 4; k++) {
    for (i = 0; i < BSize; i++) {
      uLatticeSelector[i] = i;
      for (j = 0; j < 2; j++)
        fGradient[k][i][j] = (((lSeed = random(lSeed)) % (BSize + BSize)) - BSize) / BSize;
      s = Math.sqrt(
        fGradient[k][i][0] * fGradient[k][i][0] + fGradient[k][i][1] * fGradient[k][i][1],
      );
      fGradient[k][i][0] /= s;
      fGradient[k][i][1] /= s;
    }
  }
  while (--i) {
    k = uLatticeSelector[i];
    uLatticeSelector[i] = uLatticeSelector[(j = (lSeed = random(lSeed)) % BSize)];
    uLatticeSelector[j] = k;
  }
  for (i = 0; i < BSize + 2; i++) {
    uLatticeSelector[BSize + i] = uLatticeSelector[i];
    for (k = 0; k < 4; k++) for (j = 0; j < 2; j++) fGradient[k][BSize + i][j] = fGradient[k][i][j];
  }
  return { uLatticeSelector, fGradient };
}
const s_curve = (t) => t * t * (3 - 2 * t);
const lerp = (t, a, b) => a + t * (b - a);
export function specNoise2(T, nColorChannel, vec, pStitchInfo) {
  const { uLatticeSelector, fGradient } = T;
  let t = vec[0] + PerlinN;
  let bx0 = Math.trunc(t),
    bx1 = bx0 + 1;
  const rx0 = t - Math.trunc(t),
    rx1 = rx0 - 1.0;
  t = vec[1] + PerlinN;
  let by0 = Math.trunc(t),
    by1 = by0 + 1;
  const ry0 = t - Math.trunc(t),
    ry1 = ry0 - 1.0;
  if (pStitchInfo != null) {
    if (bx0 >= pStitchInfo.nWrapX) bx0 -= pStitchInfo.nWidth;
    if (bx1 >= pStitchInfo.nWrapX) bx1 -= pStitchInfo.nWidth;
    if (by0 >= pStitchInfo.nWrapY) by0 -= pStitchInfo.nHeight;
    if (by1 >= pStitchInfo.nWrapY) by1 -= pStitchInfo.nHeight;
  }
  bx0 &= BM;
  bx1 &= BM;
  by0 &= BM;
  by1 &= BM;
  const i = uLatticeSelector[bx0],
    j = uLatticeSelector[bx1];
  const b00 = uLatticeSelector[i + by0],
    b10 = uLatticeSelector[j + by0];
  const b01 = uLatticeSelector[i + by1],
    b11 = uLatticeSelector[j + by1];
  const sx = s_curve(rx0),
    sy = s_curve(ry0);
  let q = fGradient[nColorChannel][b00];
  let u = rx0 * q[0] + ry0 * q[1];
  q = fGradient[nColorChannel][b10];
  let v = rx1 * q[0] + ry0 * q[1];
  const a = lerp(sx, u, v);
  q = fGradient[nColorChannel][b01];
  u = rx0 * q[0] + ry1 * q[1];
  q = fGradient[nColorChannel][b11];
  v = rx1 * q[0] + ry1 * q[1];
  const b = lerp(sx, u, v);
  return lerp(sy, a, b);
}
export function specTurbulence(
  T,
  nColorChannel,
  point,
  fBaseFreqX,
  fBaseFreqY,
  nNumOctaves,
  bFractalSum,
  bDoStitching,
  fTileX,
  fTileY,
  fTileWidth,
  fTileHeight,
) {
  let pStitchInfo = null;
  if (bDoStitching) {
    if (fBaseFreqX !== 0.0) {
      const fLoFreq = Math.floor(fTileWidth * fBaseFreqX) / fTileWidth;
      const fHiFreq = Math.ceil(fTileWidth * fBaseFreqX) / fTileWidth;
      if (fBaseFreqX / fLoFreq < fHiFreq / fBaseFreqX) fBaseFreqX = fLoFreq;
      else fBaseFreqX = fHiFreq;
    }
    if (fBaseFreqY !== 0.0) {
      const fLoFreq = Math.floor(fTileHeight * fBaseFreqY) / fTileHeight;
      const fHiFreq = Math.ceil(fTileHeight * fBaseFreqY) / fTileHeight;
      if (fBaseFreqY / fLoFreq < fHiFreq / fBaseFreqY) fBaseFreqY = fLoFreq;
      else fBaseFreqY = fHiFreq;
    }
    pStitchInfo = {};
    pStitchInfo.nWidth = Math.trunc(fTileWidth * fBaseFreqX + 0.5);
    pStitchInfo.nWrapX = Math.trunc(fTileX * fBaseFreqX + PerlinN + pStitchInfo.nWidth);
    pStitchInfo.nHeight = Math.trunc(fTileHeight * fBaseFreqY + 0.5);
    pStitchInfo.nWrapY = Math.trunc(fTileY * fBaseFreqY + PerlinN + pStitchInfo.nHeight);
  }
  let fSum = 0.0;
  const vec = [point[0] * fBaseFreqX, point[1] * fBaseFreqY];
  let ratio = 1;
  for (let nOctave = 0; nOctave < nNumOctaves; nOctave++) {
    if (bFractalSum) fSum += specNoise2(T, nColorChannel, vec, pStitchInfo) / ratio;
    else fSum += Math.abs(specNoise2(T, nColorChannel, vec, pStitchInfo)) / ratio;
    vec[0] *= 2;
    vec[1] *= 2;
    ratio *= 2;
    if (pStitchInfo != null) {
      pStitchInfo.nWidth *= 2;
      pStitchInfo.nWrapX = 2 * pStitchInfo.nWrapX - PerlinN;
      pStitchInfo.nHeight *= 2;
      pStitchInfo.nWrapY = 2 * pStitchInfo.nWrapY - PerlinN;
    }
  }
  return fSum;
}
// The spec's color: fractalNoise (sum * 255 + 255) / 2, turbulence sum * 255, each clamped to [0, 255].
export const specColor = (sum, fractal) =>
  Math.max(0, Math.min(255, fractal ? (sum * 255 + 255) / 2 : sum * 255));
