#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// drawImageInstanced — draw N transformed copies of a unit quad sampling
// one shared texture, in a single drawArraysInstanced call. The instanced
// form of drawImage: bake/upload an asset once, then stamp it at many
// transforms.
//
// Per-VERTEX  (divisor 0): aPos — unit quad corner in [0,1]² (loc 0).
// Per-INSTANCE (divisor 1):
//   aDst   (loc 1)  — vec4 (x, y, w, h) dest rect in viewport px, y-down.
//   aWM0   (loc 2)  — vec3 column 0 of the per-instance mat3.
//   aWM1   (loc 3)  — vec3 column 1.
//   aWM2   (loc 4)  — vec3 column 2 (translate). Identity = (0,0,1) etc.
//   aTint  (loc 5)  — vec4 straight-alpha tint*alpha-folded (see frag).
// uViewport (w,h) maps pixel → clip space with the y-flip.
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aDst;
layout(location = 2) in vec3 aWM0;
layout(location = 3) in vec3 aWM1;
layout(location = 4) in vec3 aWM2;
layout(location = 5) in vec4 aTint;

uniform vec2 uViewport;
uniform vec4 uSrcRect;   // (u, v, w, h) shared source sub-rect in [0,1]

out vec2 vUV;
out vec4 vTint;

void main() {
  vec2 px = aDst.xy + aPos * aDst.zw;          // unit quad → dest pixel rect
  mat3 wm = mat3(aWM0, aWM1, aWM2);            // per-instance transform
  vec3 wp = wm * vec3(px, 1.0);
  px = wp.xy / wp.z;
  vec2 ndc = vec2(
    (px.x / max(uViewport.x, 1.0)) * 2.0 - 1.0,
    1.0 - (px.y / max(uViewport.y, 1.0)) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV   = uSrcRect.xy + aPos * uSrcRect.zw;
  vTint = aTint;
}
