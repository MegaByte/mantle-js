#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Owner paint server (Filter Effects 1: the FillPaint and StrokePaint inputs) -- a gradient painted over a render target of the
// filter's canvas pixels. The input has conceptually infinite extent, so the target need only cover what the graph reads; each
// fragment is mapped to the owner's user space (em) and the gradient is sampled by the same code the fill shader runs
// (sampleGradient, _paintSample.glsl): the same focal and cone geometry, spread, stop search and seam filter, at any scale.
//
// The gradient record (uGradId, 1-based row of the bundle's gradient table) was placed at import (svg/filterOwnerPaint.js): its
// matrix carries the owner's CTM, the objectBoundingBox box and gradientTransform, so em is the only input it needs.
//
// Output is premultiplied RGBA, the filter-graph invariant.
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 fragColor;

uniform sampler2D uGradientTex;
uniform sampler2D uGradientStops;
@@BUNDLE_LAYOUT@@
@@GRADIENT_HELPERS@@
int gradientSpreadToExtend(int spread) {
  // spread: 0=pad, 1=reflect, 2=repeat -> mode: 0=pad, 1=repeat, 2=reflect
  if (spread == 1) return 2;
  if (spread == 2) return 1;
  return 0;
}
@@PAINT_SAMPLE@@

uniform int  uGradId;     // 1-based gradient table row
uniform vec3 uEmX;        // canvas px (origin top left, y down) -> em: em.x = dot(uEmX, vec3(px, 1))
uniform vec3 uEmY;
uniform vec3 uRect;       // the target's canvas rect: (x, y, canvas height) in GL pixels (origin bottom left)

void main() {
  // The center of this fragment in canvas pixels: gl_FragCoord is the target's own pixel, uRect puts it on the canvas.
  vec2 px = vec2(gl_FragCoord.x + uRect.x, uRect.z - (gl_FragCoord.y + uRect.y));
  vec2 em = vec2(dot(uEmX, vec3(px, 1.0)), dot(uEmY, vec3(px, 1.0)));
  // One pixel step along each canvas axis in em: the gradient's seam and cone filters read these.
  vec2 emDx = vec2(uEmX.x, uEmY.x), emDy = vec2(uEmX.y, uEmY.y);
  vec4 c = sampleGradient(uGradId, em, vec4(0.0), emDx, emDy);
  fragColor = vec4(c.rgb * c.a, c.a);
}
