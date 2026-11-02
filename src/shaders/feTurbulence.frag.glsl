#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feTurbulence — Perlin turbulence / fractal noise, the Filter Effects 1
// reference algorithm (the C code in the spec's feTurbulence section).
//
// The seeded tables — the lattice selector and four channels of unit
// gradients, from the spec's init(seed) and its Park-Miller random() — are
// built on the CPU (filterGraph/turbulenceLattice.js) and read here from one
// 256×3 RGBA32F texture by texelFetch:
//   row 0: .r   = selector[m]
//   row 1: rgba = gradient[R,G,B,A][selector[m]].x   (pre-permuted, see
//   row 2: rgba = gradient[R,G,B,A][selector[m]].y    turbulenceLattice.js)
// so noise2 is the spec's, all four channels at once: 2 selector fetches and
// 8 gradient fetches per octave. It replaces a sin() hash that kept the
// spec's structure but not its tables, so no seed matched any browser.
//
//
// Output is premultiplied (filter-graph invariant).
precision highp float;
precision highp int;
uniform highp sampler2D uLattice;
uniform vec2  uBaseFreq;
uniform int   uNumOctaves;
uniform int   uKind;
uniform vec2  uTilePos;
uniform vec2  uTileSize;
uniform vec4  uUserMap;
uniform int   uUserAff;    // 1: the referencing element has a transform (uUserM, uUserT); 0 (unset): the field is of root user space
uniform vec4  uUserM;      // a, b, c, d: root user space -> the referencing element's user space
uniform vec2  uUserT;      // e, f of the same map
uniform int   uStitch;
uniform vec2  uStitchPos;
uniform vec2  uStitchSize;
in vec2 vUV;
out vec4 fragColor;

// The spec's lattice coordinate: t = v + PerlinN, cell (int)t, fraction t - (int)t.
// C truncates toward zero; for t >= 0 (v >= -4096) that is floor(v) + PerlinN, and
// the offset is a multiple of 256, so it vanishes under & 255 and from the stitch
// compare (which drops it too). Below -4096 truncation is ceil.
void latticeCoord(float v, out int cell, out float frac) {
  float f = floor(v);
  if (v < -4096.0 && f != v) f += 1.0;
  cell = int(f);
  frac = v - f;
}

// The spec's noise2 for all four channels. stitch.xy = wrap, stitch.zw = period.
vec4 noise2(vec2 v, bool stitching, ivec4 stitch) {
  int bx0, by0;
  float rx0, ry0;
  latticeCoord(v.x, bx0, rx0);
  latticeCoord(v.y, by0, ry0);
  int bx1 = bx0 + 1, by1 = by0 + 1;
  if (stitching) {
    if (bx0 >= stitch.x) bx0 -= stitch.z;
    if (bx1 >= stitch.x) bx1 -= stitch.z;
    if (by0 >= stitch.y) by0 -= stitch.w;
    if (by1 >= stitch.y) by1 -= stitch.w;
  }
  bx0 &= 255; bx1 &= 255; by0 &= 255; by1 &= 255;
  int i = int(texelFetch(uLattice, ivec2(bx0, 0), 0).r);
  int j = int(texelFetch(uLattice, ivec2(bx1, 0), 0).r);
  int b00 = (i + by0) & 255, b10 = (j + by0) & 255;
  int b01 = (i + by1) & 255, b11 = (j + by1) & 255;
  float rx1 = rx0 - 1.0, ry1 = ry0 - 1.0;
  float sx = rx0 * rx0 * (3.0 - 2.0 * rx0);
  float sy = ry0 * ry0 * (3.0 - 2.0 * ry0);
  vec4 u = rx0 * texelFetch(uLattice, ivec2(b00, 1), 0) + ry0 * texelFetch(uLattice, ivec2(b00, 2), 0);
  vec4 w = rx1 * texelFetch(uLattice, ivec2(b10, 1), 0) + ry0 * texelFetch(uLattice, ivec2(b10, 2), 0);
  vec4 a = u + sx * (w - u);
  u = rx0 * texelFetch(uLattice, ivec2(b01, 1), 0) + ry1 * texelFetch(uLattice, ivec2(b01, 2), 0);
  w = rx1 * texelFetch(uLattice, ivec2(b11, 1), 0) + ry1 * texelFetch(uLattice, ivec2(b11, 2), 0);
  vec4 b = u + sx * (w - u);
  return a + sy * (b - a);
}

void main() {
  // The pixel's canvas center in GL px (y up), then in user space (y down).
  vec2 px = uTilePos + vUV * uTileSize;
  vec2 point = vec2(px.x, uUserMap.z - px.y) * uUserMap.xy;
  if (uUserAff != 0) point = vec2(uUserM.x * point.x + uUserM.z * point.y + uUserT.x, uUserM.y * point.x + uUserM.w * point.y + uUserT.y);
  // The spec's turbulence().
  bool stitching = uStitch != 0;
  ivec4 stitch = ivec4(ivec2(uStitchPos), ivec2(uStitchSize));
  vec2 v = point * uBaseFreq;
  vec4 sum = vec4(0.0);
  float ratio = 1.0;
  // numOctaves is clamped to 6 at import; the loop bound must be constant.
  for (int o = 0; o < 6; o++) {
    if (o >= uNumOctaves) break;
    vec4 n = noise2(v, stitching, stitch);
    sum += (uKind == 0 ? abs(n) : n) / ratio;
    v *= 2.0;
    ratio *= 2.0;
    // The spec: nWidth *= 2, nWrapX = 2 * nWrapX - PerlinN; without the offset, 2 * wrap.
    stitch *= 2;
  }
  vec4 c = clamp(uKind == 0 ? sum : (sum + 1.0) * 0.5, 0.0, 1.0);
  fragColor = vec4(c.rgb * c.a, c.a);
}
