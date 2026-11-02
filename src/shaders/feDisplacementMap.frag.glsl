#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feDisplacementMap — sample uIn1 at coords offset by selected channels
// of uIn2. Spec (SVG Filter Effects §16):
//
//   P' = P + scale · (chSelect(in2[P]) - 0.5)
//   out = in1[P']
//
// P is in SVG space (y DOWN); the filter RTs are GL space (v runs UP the canvas), so the Y offset is
// negated on its way into uv: a Y channel above 0.5 reads in1 from lower on the picture, as Chrome's
// does. X needs no flip.
//
// uXSel / uYSel select which RGBA channel of in2 drives X / Y offset: a one-hot
// vec4 (R = (1,0,0,0) ... A = (0,0,0,1)) set on the CPU, so the pick is one dot
// product, exact for finite channels, instead of a uniform if-chain.
//
// uScale is in user-space pixels. The channel value is on [0,1]; the
// -0.5 shift centers it so 0.5 (mid-gray) is zero displacement.
//
// uIn2 is sampled as UNpremultiplied. The spec's intent is that
// displacement maps are typically authored with straight colors
// (a gradient ramp, a turbulence pattern, an image). Premultiplied
// alpha would warp the displacement away from author intent.
precision highp float;
uniform sampler2D uIn1;     // displaced source
uniform sampler2D uIn2;     // displacement map (drives offset)
uniform float uScale;       // pixels
uniform vec2  uTexel;       // 1 / uIn1 rect size (converts a pixel displacement → uIn1 uv)
uniform int   uDispUseM;    // 1: the element's transform carries the displacement vector (uDispM); 0 (unset): (dx, dy) unmapped
uniform vec4  uDispM;       // for uDispUseM: the 2 x 2 map of the displacement vector (dx, dy) to GL pixels / world scale, column-major (m00, m10, m01, m11)
uniform vec4  uIn1Map;      // vUV → uIn1 uv (see @@FILTER_RECT@@)
uniform vec4  uIn2Map;      // vUV → uIn2 uv — a DIFFERENT rect
uniform vec4  uXSel;       // one-hot: the channel that drives X
uniform vec4  uYSel;       // one-hot: the channel that drives Y
uniform int   uCsIn2;      // color-space conversion of the displacement map (csConvert); uIn1 stays in the space it is in
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  vec4 mPre = csConvert(sampleIn(uIn2, mapIn(vUV, uIn2Map)), uCsIn2);
  // Unpremultiply for channel selection per spec.
  vec3 mRgb = mPre.a > 0.0 ? mPre.rgb / mPre.a : mPre.rgb;
  vec4 m = vec4(mRgb, mPre.a);
  float dx = (dot(m, uXSel) - 0.5) * uScale;
  float dy = (dot(m, uYSel) - 0.5) * uScale;
  vec2 disp = (uDispUseM != 0 ? vec2(uDispM.x * dx + uDispM.z * dy, uDispM.y * dx + uDispM.w * dy) : vec2(dx, -dy)) * uTexel;
  // Displace in uIn1's own uv space — uIn1 and uIn2 may occupy different
  // canvas rects, so vUV maps into each differently.
  vec2 sUV = mapIn(vUV, uIn1Map) + disp;
  fragColor = sampleIn(uIn1, sUV);
}
