#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// PaintTransform — affine UV warp of an input texture.
//
//
// Out-of-bounds → transparent (clamp-to-edge would smear the silhouette).

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform vec2 uBboxOutOrigin;
uniform vec2 uBboxOutSize;
uniform vec2 uBboxInOrigin;
uniform vec2 uBboxInSize;
uniform vec4 uMRow0;  // (xx, xy, dx, _)
uniform vec4 uMRow1;  // (yx, yy, dy, _)
out vec4 fragColor;

void main() {
  vec2 qOut = uBboxOutOrigin + vUV * uBboxOutSize;
  // Solve M · qIn = qOut - t. det = xx*yy - xy*yx.
  float xx = uMRow0.x, xy = uMRow0.y, dx = uMRow0.z;
  float yx = uMRow1.x, yy = uMRow1.y, dy = uMRow1.z;
  vec2 r = qOut - vec2(dx, dy);
  float det = xx * yy - xy * yx;
  if (abs(det) < 1e-12) { fragColor = vec4(0.0); return; }
  float inv = 1.0 / det;
  vec2 qIn = vec2(
    ( yy * r.x - xy * r.y) * inv,
    (-yx * r.x + xx * r.y) * inv
  );
  vec2 uvIn = (qIn - uBboxInOrigin) / uBboxInSize;
  if (uvIn.x < 0.0 || uvIn.x > 1.0 || uvIn.y < 0.0 || uvIn.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = texture(uIn, uvIn);
}
