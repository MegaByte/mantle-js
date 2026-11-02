#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Box-blur kernel — one pass of the box approximation to a Gaussian that
// blurs too wide for the Gaussian's tap table (Wells 1986, "Efficient
// Generation of Gaussian Masks"). n ≥ 3 centered boxes whose variances,
// r(r+1)/3 each, sum to σ²; the radii are chosen CPU-side
// (filterGraph/blurKernel.js boxRadii) and this shader samples one
// [-r, +r] box.
//
// Exploits hardware bilinear filtering: a single sample at offset
// (k + 0.5) averages texels k and k+1 in one fetch — halves the
// fetch count, to about r + 1 per pass. Three passes (r ≈ σ) fetch
// about 3σ per pixel, the same as the paired Gaussian's ONE pass, so
// the box is used only where the Gaussian's table cannot reach.

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;     // 1 / inRect.size — one CANVAS pixel, in input uv
uniform vec4  uInMap;     // vUV → input uv (see @@FILTER_RECT@@)
uniform vec2  uDir;
uniform int   uRadius;     // box radius in pixels (blurKernel.js boxRadii)
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

// A target can be larger than its pixels (filterGraph.js applyKeepScissor). `uInPast` is how much of the input's uv lies past them, 0 when none does. These taps sit between texels, so
// the input's edge is the pixels' edge: a tap off it reads 0, and one in its last half texel reads the last texel.
uniform vec2 uInPast;
vec4 sampleKept(vec2 uv) {
  vec2 e = vec2(1.0) - uInPast, s = step(vec2(0.0), uv) * step(uv, e);
  return texture(uTex, min(uv, e - 0.5 * uTexel)) * (s.x * s.y);
}

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  if (uRadius <= 0) { fragColor = sampleKept(uv); return; }
  vec4 acc = sampleKept(uv);
  // Pair fetches: sample at (k + 0.5) averages texels k and k+1.
  // Cover offsets 1..radius via pair fetches at 1.5, 3.5, ..., (k+0.5): radius / 2 full pairs,
  // then -- when the radius is odd -- a single texel at offset `radius`. The pairing is decided
  // once, not re-tested every iteration; same fetches, same order of accumulation.
  // 128-fetch cap → radius up to 256 (blurKernel.js BOX_MAX_RADIUS, which
  // never asks for more: a wider blur takes more passes instead).
  // (Past radius 256 the cap holds 128 pairs and no tail, as the loop always did.)
  int pairs = min(uRadius / 2, 128);
  bool tail = uRadius <= 256 && uRadius - 2 * pairs == 1;
  for (int k = 0; k < 128; ++k) {
    if (k >= pairs) break;
    // Bilinear midpoint of texels (2k+1, 2k+2): the fetch averages the two, so weight it 2.
    vec2 d = uDir * uTexel * (float(2 * k + 1) + 0.5);
    acc += sampleKept(uv + d) * 2.0;
    acc += sampleKept(uv - d) * 2.0;
  }
  if (tail) {
    // Odd radius: the right-edge texel alone, at integer offset `radius`.
    vec2 d = uDir * uTexel * float(uRadius);
    acc += sampleKept(uv + d) * 1.0;
    acc += sampleKept(uv - d) * 1.0;
  }
  // Every texel reached counted once: the center, two per side per pair, one per side for the tail.
  fragColor = acc / float(1 + 4 * pairs + (tail ? 2 : 0));
}
