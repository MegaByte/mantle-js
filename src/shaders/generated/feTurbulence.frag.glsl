#version 300 es

precision highp float;
precision highp int;
uniform highp sampler2D uLattice;
uniform vec2  uBaseFreq;
uniform int   uNumOctaves;
uniform int   uKind;
uniform vec2  uTilePos;
uniform vec2  uTileSize;
uniform vec4  uUserMap;
uniform int   uUserAff;
uniform vec4  uUserM;
uniform vec2  uUserT;
uniform int   uStitch;
uniform vec2  uStitchPos;
uniform vec2  uStitchSize;
in vec2 vUV;
out vec4 fragColor;

void latticeCoord(float v, out int cell, out float frac) {
  float f = floor(v);
  if (v < -4096.0 && f != v) f += 1.0;
  cell = int(f);
  frac = v - f;
}

vec4 noise2(vec2 v, bool stitching, ivec4 stitch) {
  int bx0, by0;
  float rx0, ry0;
  latticeCoord(v.x, bx0, rx0);
  latticeCoord(v.y, by0, ry0);
  int bx1 = bx0 + 1, by1 = by0 + 1;
  if (stitching) {
    if (bx0 >= stitch.x) bx0 -= stitch.z;
    if (bx1 >= stitch.x) bx1 -= stitch.z;
    if (by0 >= stitch.y) by0 -= stitch.w;
    if (by1 >= stitch.y) by1 -= stitch.w;
  }
  bx0 &= 255; bx1 &= 255; by0 &= 255; by1 &= 255;
  int i = int(texelFetch(uLattice, ivec2(bx0, 0), 0).r);
  int j = int(texelFetch(uLattice, ivec2(bx1, 0), 0).r);
  int b00 = (i + by0) & 255, b10 = (j + by0) & 255;
  int b01 = (i + by1) & 255, b11 = (j + by1) & 255;
  float rx1 = rx0 - 1.0, ry1 = ry0 - 1.0;
  float sx = rx0 * rx0 * (3.0 - 2.0 * rx0);
  float sy = ry0 * ry0 * (3.0 - 2.0 * ry0);
  vec4 u = rx0 * texelFetch(uLattice, ivec2(b00, 1), 0) + ry0 * texelFetch(uLattice, ivec2(b00, 2), 0);
  vec4 w = rx1 * texelFetch(uLattice, ivec2(b10, 1), 0) + ry0 * texelFetch(uLattice, ivec2(b10, 2), 0);
  vec4 a = u + sx * (w - u);
  u = rx0 * texelFetch(uLattice, ivec2(b01, 1), 0) + ry1 * texelFetch(uLattice, ivec2(b01, 2), 0);
  w = rx1 * texelFetch(uLattice, ivec2(b11, 1), 0) + ry1 * texelFetch(uLattice, ivec2(b11, 2), 0);
  vec4 b = u + sx * (w - u);
  return a + sy * (b - a);
}

void main() {

  vec2 px = uTilePos + vUV * uTileSize;
  vec2 point = vec2(px.x, uUserMap.z - px.y) * uUserMap.xy;
  if (uUserAff != 0) point = vec2(uUserM.x * point.x + uUserM.z * point.y + uUserT.x, uUserM.y * point.x + uUserM.w * point.y + uUserT.y);

  bool stitching = uStitch != 0;
  ivec4 stitch = ivec4(ivec2(uStitchPos), ivec2(uStitchSize));
  vec2 v = point * uBaseFreq;
  vec4 sum = vec4(0.0);
  float ratio = 1.0;

  for (int o = 0; o < 6; o++) {
    if (o >= uNumOctaves) break;
    vec4 n = noise2(v, stitching, stitch);
    sum += (uKind == 0 ? abs(n) : n) / ratio;
    v *= 2.0;
    ratio *= 2.0;

    stitch *= 2;
  }
  vec4 c = clamp(uKind == 0 ? sum : (sum + 1.0) * 0.5, 0.0, 1.0);
  fragColor = vec4(c.rgb * c.a, c.a);
}
