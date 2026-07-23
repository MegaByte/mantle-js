// feImage.frag — Source primitive that samples a rectangular region of
// the bundle's image atlas and emits it scaled to the filter region.
//
// uIn:           the source atlas texture (RGBA8, the bundle's main
//                image atlas).
// uAtlasSize:    pixel dims of the atlas texture (w, h).
// uAtlasRect:    (atlasY, atlasW, atlasH, kind) — same packing the fill
//                shader uses for atlasSlot. Only .xyz are consumed here.
//                The image lives at atlas pixel rows [atlasY, atlasY+atlasH)
//                and columns [0, atlasW).
// uFilterRect:   destination rectangle in NDC-derived [0,1]² space — we
//                emit unscaled (the host sets viewport to the filter
//                region's RT). preserveAspectRatio defaults to
//                'xMidYMid meet'; we honour 'none' via uPreserveAR=0.
// Output: premultiplied RGBA per CSS Filter Effects §11.
#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn;
uniform vec2 uAtlasSize;
uniform vec4 uAtlasRect;     // (atlasY, atlasW, atlasH, kind)
uniform int  uPreserveAR;    // 1 = preserve (default), 0 = none
uniform vec4 uRegionMap;     // vUV → filter-region uv (see @@FILTER_RECT@@)
in vec2 vUV;                 // fullscreen-quad varying in [0,1]² (matches composite.vert)
out vec4 fragColor;

@@FILTER_RECT@@
void main() {
  // The image is placed across the filter REGION, not across this pass's
  // output rect — they are the same only when the output covers the canvas.
  vec2 uv = mapIn(vUV, uRegionMap);
  // Optional preserveAspectRatio: 'none' stretches u/v 1:1 across the
  // filter region; 'meet' (default) preserves source AR and centers.
  if (uPreserveAR == 1) {
    float srcAR = uAtlasRect.y / max(uAtlasRect.z, 1.0);   // w/h
    // Filter region AR is 1 because we render into a square RT sized
    // to the filter region.
    float dstAR = 1.0;
    if (srcAR > dstAR) {
      // Source wider than dest: full width, letterbox vertically.
      float k = dstAR / srcAR;
      uv.y = (uv.y - 0.5) / k + 0.5;
    } else {
      float k = srcAR / dstAR;
      uv.x = (uv.x - 0.5) / k + 0.5;
    }
  }
  // Clamp outside [0,1] to transparent (so letterbox margins are clear).
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  float atlasU = (uv.x * uAtlasRect.y) / max(uAtlasSize.x, 1.0);
  float atlasV = (uAtlasRect.x + uv.y * uAtlasRect.z) / max(uAtlasSize.y, 1.0);
  vec4 c = texture(uIn, vec2(atlasU, atlasV));
  // The atlas stores unpremultiplied RGBA; premultiply for the graph.
  fragColor = vec4(c.rgb * c.a, c.a);
}
