#version 300 es
precision highp float;
uniform sampler2D uShapeTex;  // shape's output (premultiplied RGBA)
uniform sampler2D uDstTex;    // main framebuffer copy (premultiplied RGBA)
uniform int uBlendMode;
uniform float uOpacity;       // multiplier on src alpha (group opacity)
in vec2 vUV;
out vec4 fragColor;

// CSS blend math (16 modes) + `unpre` from the shared helper concatenated
// by src/shaders/index.js.
@@BLEND_HELPERS@@

void main() {
  vec4 srcPre = texture(uShapeTex, vUV);
  vec4 dstPre = texture(uDstTex,   vUV);
  // Apply group opacity: scale the source's premultiplied (rgb, a) by
  // uOpacity. Multiplying both rgb and alpha keeps the premultiplied
  // invariant. uOpacity defaults to 1 when not set by the caller.
  float opacity = max(uOpacity, 0.0);
  srcPre = srcPre * opacity;
  // Flash AS3 BlendMode.ALPHA (20) and BlendMode.ERASE (21): the source
  // contributes its alpha channel only and modulates the destination's
  // alpha. RGB of the source is ignored. These are coverage operators,
  // not blend math, so they can't share the unpre→blend→over path.
  //   alpha: out.a = src.a * dst.a, out.rgb = dst.rgb (so the dst is
  //          masked by the source's silhouette).
  //   erase: out.a = (1-src.a) * dst.a, out.rgb = dst.rgb (source
  //          "punches a hole" through the dst's alpha).
  // Output stays premultiplied for the gl.ONE,ZERO replace blit.
  if (uBlendMode == 20) {
    float outA = srcPre.a * dstPre.a;
    fragColor = vec4(unpre(dstPre) * outA, outA);
    return;
  }
  if (uBlendMode == 21) {
    float outA = (1.0 - srcPre.a) * dstPre.a;
    fragColor = vec4(unpre(dstPre) * outA, outA);
    return;
  }
  // Compositing math runs on UNpremultiplied RGB; alpha is composited
  // separately. (Per CSS Compositing & Blending § 7.)
  vec3 src = unpre(srcPre);
  vec3 dst = unpre(dstPre);
  float as = srcPre.a, ad = dstPre.a;
  vec3 b = blendDispatch(uBlendMode, src, dst);
  // Final composite = src-over with the blended foreground.
  vec3 outRgb = (1.0 - ad) * src + ad * b;
  // src-over of the blended foreground over the backdrop, premultiplied:
  // co = as·outRgb + ad·(1-as)·dst, ao = as + ad - as·ad (CSS C&B L1 §7).
  vec3 co = as * outRgb + ad * (1.0 - as) * dst;
  float finalA = as + ad - as * ad;
  fragColor = vec4(co, finalA);
}
