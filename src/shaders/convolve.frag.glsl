#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feConvolveMatrix — general 2D convolution. Single-pass (kernel is not
// guaranteed separable, unlike Gaussian blur and feMorphology). Capped
// at 5×5 = 25 taps so the shader can unroll cleanly. Larger kernels
// from the importer are truncated; arbitrary kernel sizes need a
// dynamic loop in WebGL2 ES 3.00, which can't be unrolled.

// uOrder.xy = (orderX, orderY) — kernel width / height (1..5).
// uTarget.xy = (targetX, targetY) — kernel center within (orderX,orderY).
//   Default is floor((order-1)/2) but the spec allows arbitrary
//   targets — must match the importer's computation.
// uDivisor, uBias = post-multiply / add as per spec.
// uEdgeMode: 0 = duplicate (CLAMP_TO_EDGE), 1 = wrap (REPEAT),
//            2 = none (transparent black past edge).
// uPreserveAlpha: 1 → only RGB is convolved; A passes through.
precision highp float;
uniform sampler2D uTex;
uniform float uKernel[25];
uniform vec2  uTexel;     // kernel sample spacing in input uv (world-scaled)
uniform vec4  uInMap;     // vUV → input uv (see @@FILTER_RECT@@)
uniform vec2  uOrder;     // (orderX, orderY)
uniform vec2  uTarget;    // (targetX, targetY)
uniform float uDivisor;
uniform float uBias;
uniform int   uEdgeMode;
uniform int   uPreserveAlpha;
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@


vec4 sampleEdge(vec2 uv) {
  if (uEdgeMode == 1) {
    return texture(uTex, fract(uv));
  }
  if (uEdgeMode == 2) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
      return vec4(0.0);
    return texture(uTex, uv);
  }
  // duplicate (default) — texture is created with CLAMP_TO_EDGE so a
  // plain sample suffices.
  return texture(uTex, clamp(uv, vec2(0.0), vec2(1.0)));
}

void main() {
  vec2 uv0 = mapIn(vUV, uInMap);
  int orderX = int(uOrder.x + 0.5);
  int orderY = int(uOrder.y + 0.5);
  int targetX = int(uTarget.x + 0.5);
  int targetY = int(uTarget.y + 0.5);
  // Taps step in SVG space (y DOWN); uv runs UP the canvas, so the j offset is negated.
  // Spec: out[x,y] += kernelMatrix[orderY-j-1, orderX-i-1] * in[x + i - targetX, y + j - targetY]
  // (the kernel is flipped -- a true convolution, not a correlation); uKernel holds it flipped.
  // Bounded loops (max 5, break on the order) so the compiler unrolls them. uPreserveAlpha picks
  // ONE accumulator, so the branch sits outside the loops: the default path does not pay an
  // unpremultiply divide per tap for an accumulator it never reads. Same taps, same
  // weights, same order of accumulation either way.
  vec4 outc;
  if (uPreserveAlpha == 1) {
    // Per SVG spec: with preserveAlpha, the kernel applies to UN-premultiplied color and the
    // source alpha is preserved. Convolve straight RGB, keep the center alpha, then
    // re-premultiply for the premultiplied filter pipeline.
    vec3 accStraight = vec3(0.0);
    for (int j = 0; j < 5; j++) {
      if (j >= orderY) break;
      for (int i = 0; i < 5; i++) {
        if (i >= orderX) break;
        vec4 s = sampleEdge(uv0 + vec2(float(i - targetX), -float(j - targetY)) * uTexel);
        accStraight += uKernel[j * 5 + i] * (s.a > 0.0 ? s.rgb / s.a : s.rgb);
      }
    }
    float a = sampleEdge(uv0).a;
    // A straight color is clamped as one, before alpha goes in: past 1, its product with alpha would exceed alpha.
    vec3 rgb = clamp(accStraight / max(uDivisor, 1e-6) + vec3(uBias), 0.0, 1.0);
    outc = vec4(rgb * a, a);
  } else {
    // Default: convolve premultiplied RGBA directly (stays premultiplied
    // if the kernel sums to 1; a non-1 kernel warps the alpha:rgb ratio).
    vec4 acc = vec4(0.0);
    for (int j = 0; j < 5; j++) {
      if (j >= orderY) break;
      for (int i = 0; i < 5; i++) {
        if (i >= orderX) break;
        acc += uKernel[j * 5 + i] * sampleEdge(uv0 + vec2(float(i - targetX), -float(j - targetY)) * uTexel);
      }
    }
    outc = acc / max(uDivisor, 1e-6) + vec4(uBias);
  }
  // Filter Effects 1 clamps a primitive's result "into the allowable ranges for colors and opacity values", and a premultiplied color's
  // range ends at its alpha. A kernel with negative weights leaves color past alpha wherever color varies under a partial alpha, and
  // source-over then adds light: a sharpen's seam read 255 at alpha 128.
  outc = clamp(outc, vec4(0.0), vec4(1.0));
  fragColor = vec4(min(outc.rgb, vec3(outc.a)), outc.a);
}
