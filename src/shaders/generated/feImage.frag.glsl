#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn;
uniform vec2 uAtlasSize;
uniform vec4 uAtlasRect;

uniform int  uPlaced;
uniform vec4 uOutRect;
uniform vec4 uImgRect;
uniform vec4 uClipRect;

uniform vec4 uImgMap;
uniform vec4 uAtlasMap;
in vec2 vUV;
out vec4 fragColor;

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

  vec2 uv = vUV * uImgMap.xy + uImgMap.zw;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = texture(uIn, uv * uAtlasMap.xy + uAtlasMap.zw);
}
