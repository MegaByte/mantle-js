#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
//
// cacheBlit.vert, once per INSTANCE: N rects of one texture composited in a single drawArraysInstanced. A run of group composites
// (the group atlas, a merged run) is a row of quads that differ only in their destination rect, source map and tint; this stamps them
// all from one draw. The fragment stage is cacheBlit.frag compiled with CB_INSTANCED (the tint arrives as a flat varying).
//
// Per-VERTEX (divisor 0): aPos, the unit quad corner in [0,1]^2 (a triangle strip).
// Per-INSTANCE (divisor 1):
//   aRect (loc 1) -- the destination rect in canvas pixels, GL origin (x, y, w, h): what the one-quad composite sets as its viewport.
//   aMap  (loc 2) -- the cacheBlit uInMap of that quad (scale xy, offset zw).
//   aTint (loc 3) -- the cacheBlit uTint of that quad.
// vUV is cacheBlit.vert's own formula on the same corner, so a fragment of an instance reads the texel the one-quad draw read.
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aMap;
layout(location=3) in vec4 aTint;
uniform vec2 uViewport;
out vec2 vUV;
flat out vec4 vTint;
void main() {
  vUV = aPos * aMap.xy + aMap.zw;
  vTint = aTint;
  vec2 px = aRect.xy + aPos * aRect.zw;
  gl_Position = vec4(px / uViewport * 2.0 - 1.0, 0.0, 1.0);
}
