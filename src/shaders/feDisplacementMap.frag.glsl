#version 300 es
// feDisplacementMap — sample uIn1 at coords offset by selected channels
// of uIn2. Spec (SVG Filter Effects §16):
//
//   P' = P + scale · (chSelect(in2[P]) - 0.5)
//   out = in1[P']
//
// uXChan / uYChan select which RGBA channel of in2 drives X / Y offset:
//   0 = R, 1 = G, 2 = B, 3 = A
//
// uScale is in user-space pixels. The channel value is on [0,1]; the
// -0.5 shift centers it so 0.5 (mid-gray) is zero displacement.
//
// uIn2 is sampled as UNpremultiplied. The spec's intent is that
// displacement maps are typically authored with straight colors
// (a gradient ramp, a turbulence pattern, an image). Premultiplied
// alpha would warp the displacement away from author intent.
precision highp float;
uniform sampler2D uIn1;     // displaced source
uniform sampler2D uIn2;     // displacement map (drives offset)
uniform float uScale;       // pixels
uniform vec2  uTexel;       // 1 / texture size (for converting pixel scale → uv)
uniform int   uXChan;
uniform int   uYChan;
in vec2 vUV;
out vec4 fragColor;

float chSelect(vec4 c, int ch) {
  if (ch == 0) return c.r;
  if (ch == 1) return c.g;
  if (ch == 2) return c.b;
  return c.a;
}

void main() {
  vec4 mPre = texture(uIn2, vUV);
  // Unpremultiply for channel selection per spec.
  vec3 mRgb = mPre.a > 0.0 ? mPre.rgb / mPre.a : mPre.rgb;
  vec4 m = vec4(mRgb, mPre.a);
  float dx = (chSelect(m, uXChan) - 0.5) * uScale;
  float dy = (chSelect(m, uYChan) - 0.5) * uScale;
  vec2 disp = vec2(dx, dy) * uTexel;
  vec2 sUV = vUV + disp;
  // Clamp to keep us inside the source RT — feDisplacementMap is
  // expected to use the source's clamp/wrap behavior; CLAMP_TO_EDGE
  // is what every pool RT is configured for already.
  fragColor = texture(uIn1, sUV);
}
