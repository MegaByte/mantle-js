#version 300 es

precision highp float;
uniform sampler2D uCacheTex;
uniform vec4 uTint;
uniform vec4 uInMap;
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

  vec4 c = texture(uCacheTex, mapIn(vUV, uInMap));
  fragColor = c * uTint;
}
