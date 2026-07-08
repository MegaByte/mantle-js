#version 300 es

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform sampler2D uLUT;       
out vec4 fragColor;

float lookup(int row, float x) {
  
  int i = clamp(int(x * 255.0 + 0.5), 0, 255);
  return texelFetch(uLUT, ivec2(i, row), 0).r;
}

void main() {
  vec4 srcPre = texture(uIn, vUV);
  vec3 srcRgb = srcPre.a > 0.0 ? srcPre.rgb / srcPre.a : srcPre.rgb;
  float r = lookup(0, srcRgb.r);
  float g = lookup(1, srcRgb.g);
  float b = lookup(2, srcRgb.b);
  float a = lookup(3, srcPre.a);
  fragColor = vec4(r * a, g * a, b * a, a);
}
