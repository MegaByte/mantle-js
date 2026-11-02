#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// drawImage — place a textured unit quad in the viewport.
//
layout(location = 0) in vec2 aPos;   // unit quad corner in [0,1]²

uniform vec4 uDstRect;    // (x, y, w, h) in viewport pixels, y-down
uniform vec4 uSrcRect;    // (u, v, w, h) in [0,1] texture coords
uniform vec2 uViewport;   // (width, height) in pixels
uniform mat3 uWorldM;     // column-major; identity = no extra transform

out vec2 vUV;

void main() {
  // Unit quad → destination pixel rect.
  vec2 px = uDstRect.xy + aPos * uDstRect.zw;
  // Optional world transform (rotation/skew/translate) in pixel space.
  vec3 wp = uWorldM * vec3(px, 1.0);
  px = wp.xy / wp.z;
  // Pixel → NDC. y-flip: pixel y grows downward, clip y grows upward.
  vec2 ndc = vec2(
    (px.x / max(uViewport.x, 1.0)) * 2.0 - 1.0,
    1.0 - (px.y / max(uViewport.y, 1.0)) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  // Source sub-rect.
  vUV = uSrcRect.xy + aPos * uSrcRect.zw;
}
