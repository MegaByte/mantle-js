#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feMorphology — separable per-channel max (dilate) / min (erode) over
// a rectangular kernel of pixel radius uRadius along uDir. Two-pass:
// horizontal then vertical. Premultiplied RGBA is preserved.
//
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;     // 1 / inRect.size — one CANVAS pixel, in input uv
uniform vec4  uInMap;     // vUV → input uv (see @@FILTER_RECT@@)
uniform vec2  uDir;       // (1,0) horizontal pass, (0,1) vertical pass
uniform float uRadius;    // pixels along the current axis; <0.5 → identity
uniform int   uOperator;  // 0 = erode (min), 1 = dilate (max)
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  if (uRadius < 0.5) { fragColor = sampleIn(uTex, uv); return; }
  // One pass reaches 64 px; filterGraph/primitives/morphology.js runs a wider radius as several passes.
  int r = int(min(ceil(uRadius), 64.0));

  vec4 acc = sampleIn(uTex, uv);
  if (uOperator == 1) {
    for (int i = 1; i <= 64; ++i) {
      if (i > r) break;
      vec2 d = uDir * uTexel * float(i);
      acc = max(acc, max(sampleIn(uTex, uv + d), sampleIn(uTex, uv - d)));   // dilate
    }
  } else {
    for (int i = 1; i <= 64; ++i) {
      if (i > r) break;
      vec2 d = uDir * uTexel * float(i);
      acc = min(acc, min(sampleIn(uTex, uv + d), sampleIn(uTex, uv - d)));   // erode
    }
  }
  fragColor = acc;
}
