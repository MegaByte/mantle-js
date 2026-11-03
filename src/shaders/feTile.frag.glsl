#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feTile — repeat-tile the input across the filter region.
// Per Filter Effects 1 §15 the tile is the INPUT's primitive subregion, placed in user space: its origin and
// size are the subregion's, not those of the render target that happens to hold the input (a target is an
// allocation decision: padded, rounded to a quantum, clipped to the canvas or to a filter frame). The CPU hands
// two affine maps, both exact in double precision:
//   uTileA  vUV -> tile coordinate:  t  = fract(vUV * A.xy + A.zw)      (A.zw is already reduced to [0,1))
//   uTileB  tile coordinate -> the input texture's uv:  uv = t * B.xy + B.zw
// A tile coordinate outside the input's rect (a subregion larger than the texture holding it) reads transparent.
precision highp float;
uniform sampler2D uTex;
uniform vec4 uTileA;
uniform vec4 uTileB;
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@
void main() {
  // fract() is never negative, so there is nothing to wrap back.
  vec2 t = fract(vUV * uTileA.xy + uTileA.zw);
  fragColor = sampleIn(uTex, t * uTileB.xy + uTileB.zw);
}
