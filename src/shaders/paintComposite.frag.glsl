#version 300 es
// PaintComposite — COLRv1 binary composite with 28 modes. Per the
// OpenType spec, PaintCompositeMode enumerates the 12 Porter-Duff
// modes (0..11), additive Plus (12), then the 15 CSS blend modes
// (13..27). This shader dispatches to the shared Porter-Duff /
// blend-mode helpers and rewrites both halves of the COLR enum into
// the helper's internal numbering.
//
// PD half (modes 0..12) writes the answer directly from `porterDuff`.
// Blend half (modes 13..27) follows CSS Compositing & Blending Level 1
// rules: blend(src, dst) in unpremultiplied RGB, then composite the
// result over the destination using src-over. The same pattern as
// feBlend.frag.glsl.
//
// COLR mode → blend-helper mode (13..27 → 1..15, plus 0 for Normal):
//   13 Screen        →  2
//   14 Overlay       →  3
//   15 Darken        →  4
//   16 Lighten       →  5
//   17 ColorDodge    →  6
//   18 ColorBurn     →  7
//   19 HardLight     →  8
//   20 SoftLight     →  9
//   21 Difference    → 10
//   22 Exclusion     → 11
//   23 Multiply      →  1
//   24 HslHue        → 12
//   25 HslSaturation → 13
//   26 HslColor      → 14
//   27 HslLuminosity → 15

precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform sampler2D uDst;
uniform int uMode;       // 0..27 COLR PaintCompositeMode
out vec4 fragColor;

@@PORTER_DUFF_HELPERS@@
@@BLEND_HELPERS@@

int colrModeToBlend(int m) {
  // 13..22 → 2..11 (Screen..Exclusion), 23 → 1 (Multiply),
  // 24..27 → 12..15 (HSL).
  if (m == 23) return 1;
  if (m >= 13 && m <= 22) return m - 11;
  if (m >= 24 && m <= 27) return m - 12;
  return 0;  // Normal — should never reach this in the blend branch.
}

void main() {
  vec4 src = texture(uSrc, vUV);
  vec4 dst = texture(uDst, vUV);
  if (uMode <= 12) {
    fragColor = porterDuff(uMode, src, dst);
    return;
  }
  // Blend modes 13..27 — unpremultiply, blend in straight RGB, then
  // src-over composite. Matches feBlend.
  int bm = colrModeToBlend(uMode);
  vec3 sRgb = unpre(src);
  vec3 dRgb = unpre(dst);
  float as = src.a, ad = dst.a;
  vec3 b = blendDispatch(bm, sRgb, dRgb);
  // CSS C&B Level 1 §7: blended foreground = (1-ad)·src + ad·b.
  vec3 outRgb = (1.0 - ad) * sRgb + ad * b;
  // src-over of the blended foreground over the backdrop, premultiplied:
  // co = as·outRgb + ad·(1-as)·dst, ao = as + ad - as·ad (CSS C&B L1 §7).
  vec3 co = as * outRgb + ad * (1.0 - as) * dRgb;
  float finalA = as + ad - as * ad;
  fragColor = vec4(co, finalA);
}
