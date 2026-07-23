#version 300 es

precision highp float;
uniform sampler2D uTex;
uniform vec4 uInMap;
uniform vec4 uM0;
uniform vec4 uM1;
uniform vec4 uM2;
uniform vec4 uM3;
uniform vec4 uMOff;
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
  vec4 src = sampleIn(uTex, mapIn(vUV, uInMap));

  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  vec4 c = vec4(rgb, src.a);
  vec4 o;
  o.r = dot(uM0, c) + uMOff.x;
  o.g = dot(uM1, c) + uMOff.y;
  o.b = dot(uM2, c) + uMOff.z;
  o.a = dot(uM3, c) + uMOff.w;
  o = clamp(o, 0.0, 1.0);
  fragColor = vec4(o.rgb * o.a, o.a);
}
