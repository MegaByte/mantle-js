#version 300 es
// feComponentTransfer — per-channel 1D LUT remap. SVG Filter Effects §16.
//
// Each of R, G, B, A is independently remapped via a transfer function
// (identity / table / discrete / linear / gamma). The importer bakes
// each channel's function into a 256-entry float ramp; we pack all
// four ramps into a single 256×4 RGBA8 LUT texture:
//   row 0 (v=0.5/4) → R LUT
//   row 1 (v=1.5/4) → G LUT
//   row 2 (v=2.5/4) → B LUT
//   row 3 (v=3.5/4) → A LUT
// Each LUT row has all four channels filled with the same value so the
// shader's texelFetch can read any channel; we standardize on .r.
//
// Operates on UNPREMULTIPLIED RGB (per spec §16); input arrives
// premultiplied so we unpremultiply, look up, then re-premultiply
// (using the NEW alpha from the A LUT, per spec).

precision highp float;
in vec2 vUV;
uniform sampler2D uIn;
uniform vec4 uInMap;          // vUV → uIn uv (see @@FILTER_RECT@@)
uniform sampler2D uLUT;       // 256×4 RGBA8
out vec4 fragColor;

@@FILTER_RECT@@

float lookup(int row, float x) {
  // Clamp + scale to texel coordinate.
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
