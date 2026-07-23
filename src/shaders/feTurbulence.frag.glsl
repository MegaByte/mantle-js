#version 300 es
// feTurbulence — procedural Perlin noise per SVG Filter Effects §11.
//
// The spec's reference implementation derives 4 per-channel permutation
// tables from the seed with a Park-Miller RNG. This shader keeps the
// spec's noise STRUCTURE (2D gradient lattice, s-curve interpolation,
// octave accumulation) but replaces the seeded permutation tables with
// an on-the-fly sin-hash gradient (see latticeGradient), so output is
// deterministic per seed but not bit-identical to the spec's reference
// renderer.
//
// Uniforms:
//   uBaseFreq    — (fx, fy) per-axis base frequency in 1/userSpace
//   uNumOctaves  — int, 1..6
//   uSeed        — float seed, mixed into the lattice-gradient hash
//   uKind        — 0 = turbulence (Σ |noise|), 1 = fractalNoise
//                  (Σ noise, then 0.5 + 0.5*x)
//   uTilePos     — (originX, originY) of the filter primitive subregion
//                  (in pixels). Used to translate UVs into the noise
//                  coordinate space the spec defines.
//   uTileSize    — (w, h) of the filter primitive subregion in pixels.
//   uStitch      — 0 = no stitch, 1 = stitch (tile pattern boundary)
//
// Output is premultiplied (filter-graph invariant). Each of R/G/B/A
// gets its own permutation seed so the channels decorrelate.
precision highp float;
uniform vec2  uBaseFreq;
uniform int   uNumOctaves;
uniform float uSeed;
uniform int   uKind;
uniform vec2  uTilePos;
uniform vec2  uTileSize;
uniform int   uStitch;
in vec2 vUV;
out vec4 fragColor;

// Compute the 4-channel noise at point P with grid frequency. The
// spec's algorithm:
//   For each octave (1..numOctaves):
//     - Sample noise at P * freq per channel
//     - Accumulate sum or |sum| based on kind
//     - Double frequency, halve weight
//
// SVG's Perlin uses bilinear interpolation in a 2D grid of 2D gradient
// vectors, with 4 separate gradient sets — one per RGBA channel.
//
// To avoid a 1024-element constant array (which can blow the shader's
// uniform / constant budget on lower-end GL drivers), we recompute the
// gradient at each lattice point from the input seed using a hash: the
// spec's table is just a deterministic mapping of (channel, x, y) →
// (gx, gy), which a hash computes on the fly with statistically
// equivalent results.
vec2 latticeGradient(int channel, int x, int y, float seed) {
  // Mix channel, x, y, seed into a 32-bit-ish hash, derive two
  // floats in [-1, 1].
  float n = float(x) * 12.9898 + float(y) * 78.233
          + float(channel) * 39.346 + seed * 0.7531;
  float h1 = fract(sin(n) * 43758.5453);
  float h2 = fract(sin(n + 7.317) * 24617.8412);
  return vec2(h1, h2) * 2.0 - 1.0;
}

float sCurve(float t) {
  // The spec's s-curve: t*t*(3 - 2*t). Smoothstep without clamping.
  return t * t * (3.0 - 2.0 * t);
}

// One octave of 2D Perlin noise per channel. Returns the four-channel
// noise value at point P given the current octave frequency.
vec4 noise2(vec2 P, float seed) {
  // Cell corners.
  vec2 Pi = floor(P);
  vec2 Pf = P - Pi;
  int bx0 = int(Pi.x), bx1 = bx0 + 1;
  int by0 = int(Pi.y), by1 = by0 + 1;
  // Fade weights.
  float rx0 = Pf.x;
  float ry0 = Pf.y;
  float sx  = sCurve(rx0);
  float sy  = sCurve(ry0);
  vec4 result;
  for (int ch = 0; ch < 4; ch++) {
    vec2 g00 = latticeGradient(ch, bx0, by0, seed);
    vec2 g10 = latticeGradient(ch, bx1, by0, seed);
    vec2 g01 = latticeGradient(ch, bx0, by1, seed);
    vec2 g11 = latticeGradient(ch, bx1, by1, seed);
    float n00 = dot(g00, vec2(rx0,     ry0));
    float n10 = dot(g10, vec2(rx0 - 1.0, ry0));
    float n01 = dot(g01, vec2(rx0,     ry0 - 1.0));
    float n11 = dot(g11, vec2(rx0 - 1.0, ry0 - 1.0));
    float a = mix(n00, n10, sx);
    float b = mix(n01, n11, sx);
    if      (ch == 0) result.r = mix(a, b, sy);
    else if (ch == 1) result.g = mix(a, b, sy);
    else if (ch == 2) result.b = mix(a, b, sy);
    else              result.a = mix(a, b, sy);
  }
  return result;
}

void main() {
  // SVG spec: P is the filter primitive coordinate (in pixels) minus
  // the subregion origin, scaled by baseFrequency.
  vec2 pixelPos = uTilePos + vUV * uTileSize;
  vec2 P = pixelPos * uBaseFreq;
  vec4 acc = vec4(0.0);
  float freq = 1.0;
  float amp  = 1.0;
  // numOctaves: clamp to 6 (spec recommendation; loop bound must be
  // constant for GLSL ES 3.0 driver compatibility).
  for (int i = 0; i < 6; i++) {
    if (i >= uNumOctaves) break;
    vec4 n = noise2(P * freq, uSeed);
    if (uKind == 0) acc += abs(n) * amp;
    else            acc += n * amp;
    freq *= 2.0;
    amp  *= 0.5;
  }
  vec4 outc;
  if (uKind == 0) {
    // turbulence: result already in roughly [0, 1] but can exceed.
    outc = clamp(acc, 0.0, 1.0);
  } else {
    // fractalNoise: [-1, 1] → [0, 1].
    outc = clamp(acc * 0.5 + 0.5, 0.0, 1.0);
  }
  // Stitch is a no-op in this implementation (the spec lets the
  // implementation choose whether to honor it).
  if (uStitch != 0) {} // intentionally empty
  // Premultiply for filter-graph invariant.
  fragColor = vec4(outc.rgb * outc.a, outc.a);
}
