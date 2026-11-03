#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// PaintGlyph — clip input by a glyph alpha silhouette.

// When TextRun supplies no mask the dispatch attaches a placeholder mask
// of α=1 so the node behaves as a passthrough.

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform sampler2D uMask;
uniform vec4 uInMap;     // vUV -> uIn uv: the child covers its own rect (see @@FILTER_RECT@@)
uniform vec4 uMaskMap;   // vUV -> uMask uv: the silhouettes are canvas-sized
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  vec4 c = sampleIn(uIn, mapIn(vUV, uInMap));
  float m = sampleIn(uMask, mapIn(vUV, uMaskMap)).a;
  fragColor = c * m;
}
