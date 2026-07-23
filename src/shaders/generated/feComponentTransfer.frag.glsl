#version 300 es

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform vec4 uInMap;
uniform sampler2D uLUT;
out vec4 fragColor;

vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

float lookup(int row, float x) {

  int i = clamp(int(x * 255.0 + 0.5), 0, 255);
  return texelFetch(uLUT, ivec2(i, row), 0).r;
}

void main() {
  vec4 srcPre = sampleIn(uIn, mapIn(vUV, uInMap));
  vec3 srcRgb = srcPre.a > 0.0 ? srcPre.rgb / srcPre.a : srcPre.rgb;
  float r = lookup(0, srcRgb.r);
  float g = lookup(1, srcRgb.g);
  float b = lookup(2, srcRgb.b);
  float a = lookup(3, srcPre.a);
  fragColor = vec4(r * a, g * a, b * a, a);
}
