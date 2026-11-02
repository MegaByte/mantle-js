#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
precision highp float; precision highp int;
uniform sampler2D uIn;
uniform vec2 uAtlasSize;
uniform vec4 uAtlasRect;
uniform int  uPreserveAR;
uniform vec4 uRegionMap;

uniform int  uPlaced;
uniform vec4 uOutRect;
uniform vec4 uImgRect;
uniform vec4 uClipRect;
in vec2 vUV;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

void main() {
  if (uPlaced == 1) {
    vec2 p = uOutRect.xy + vUV * uOutRect.zw;
    vec2 c0 = uClipRect.xy, c1 = uClipRect.xy + uClipRect.zw;
    vec2 uvP = (p - uImgRect.xy) / max(uImgRect.zw, vec2(1e-6));
    bool inside = p.x >= c0.x && p.y >= c0.y && p.x <= c1.x && p.y <= c1.y
               && uvP.x >= 0.0 && uvP.y >= 0.0 && uvP.x <= 1.0 && uvP.y <= 1.0;

    vec2 q = clamp(uvP, 0.0, 1.0);
    float u = (q.x * uAtlasRect.y) / max(uAtlasSize.x, 1.0);
    float v = (uAtlasRect.x + (1.0 - q.y) * uAtlasRect.z) / max(uAtlasSize.y, 1.0);
    vec4 ci = texture(uIn, vec2(u, v));
    fragColor = inside ? ci : vec4(0.0);
    return;
  }

  vec2 uv = mapIn(vUV, uRegionMap);

  if (uPreserveAR == 1) {
    float srcAR = uAtlasRect.y / max(uAtlasRect.z, 1.0);

    float dstAR = 1.0;
    if (srcAR > dstAR) {

      float k = dstAR / srcAR;
      uv.y = (uv.y - 0.5) / k + 0.5;
    } else {
      float k = srcAR / dstAR;
      uv.x = (uv.x - 0.5) / k + 0.5;
    }
  }

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  float atlasU = (uv.x * uAtlasRect.y) / max(uAtlasSize.x, 1.0);
  float atlasV = (uAtlasRect.x + uv.y * uAtlasRect.z) / max(uAtlasSize.y, 1.0);
  vec4 c = texture(uIn, vec2(atlasU, atlasV));

  fragColor = c;   // (the atlas is premultiplied: this reference follows the shipped shader's correction, so it compares only the map composition)
}
