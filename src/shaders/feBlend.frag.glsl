#version 300 es
// feBlend — combine two filter-graph inputs via a CSS blend mode.
// SVG Filter Effects 1 (Compositing & Blending Level 1 integration)
// supports all 16 CSS blend modes.
//
// Spec: out = (1 - aSrc)·dst + aSrc·blend(src, dst) for separable modes,
// blend operates on unpremultiplied RGB. Alpha follows Porter-Duff over:
//   aOut = aSrc + aDst·(1 - aSrc).
// Output is premultiplied (filter-graph invariant). uMode = 0..15. Blend
// math is shared via _blendHelpers.glsl.

precision highp float;
uniform sampler2D uIn1;   // src
uniform sampler2D uIn2;   // dst
uniform int uMode;
in vec2 vUV;
out vec4 fragColor;

@@BLEND_HELPERS@@

void main() {
  vec4 srcPre = texture(uIn1, vUV);
  vec4 dstPre = texture(uIn2, vUV);
  vec3 src = unpre(srcPre);
  vec3 dst = unpre(dstPre);
  float as = srcPre.a, ad = dstPre.a;
  vec3 b = blendDispatch(uMode, src, dst);
  vec3 outRgb = (1.0 - ad) * src + ad * b;
  // src-over of the blended foreground over the backdrop, premultiplied:
  // co = as·outRgb + ad·(1-as)·dst, ao = as + ad - as·ad (CSS C&B L1 §7).
  vec3 co = as * outRgb + ad * (1.0 - as) * dst;
  float finalA = as + ad - as * ad;
  fragColor = vec4(co, finalA);
}
