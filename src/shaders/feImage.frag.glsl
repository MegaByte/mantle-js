// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImage.frag — Source primitive that samples a rectangular region of
// the bundle's image atlas and emits it scaled to the filter region.
//
// uIn:           the source atlas texture (RGBA8, the bundle's main
//                image atlas).
// uAtlasSize, uAtlasRect: the atlas dims and the slot (atlasY, atlasW, atlasH),
//                read by the PLACED path (an external image).
// uImgMap:       the REGION fit: vUV → the image's own [0,1]² placed in the filter region: the
//                region map, then preserveAspectRatio's letterbox ('xMidYMid
//                meet' by default, 'none' stretches) against the region's own
//                aspect -- one affine map per axis, composed on the CPU
//                (filterGraph/primitives/image.js).
// uAtlasMap:     the image's [0,1]² → atlas uv: its slot at atlas rows
//                [atlasY, atlasY + atlasH), columns [0, atlasW), top row first,
//                so uv.y (which runs up the region) maps to the rows reversed.
// Both maps depend on the pass alone, so the pixel pays two multiply-adds
// each instead of recomputing the aspect and atlas mapping.
// The atlas holds PREMULTIPLIED texels (renderer/bundle.js premultiplies at upload), so the filtered texel is already the graph's
// premultiplied RGBA. Multiplying by alpha again darkened every partly transparent pixel: a half-transparent red came out (64, 0, 0, 128).
#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn;
uniform vec2 uAtlasSize;     // (the placed path's slot mapping)
uniform vec4 uAtlasRect;     // (atlasY, atlasW, atlasH, kind)
// PLACED (an external image, filterGraph/feImagePlace.js): every rect in GL canvas px, [x, y, w, h].
uniform int  uPlaced;        // 1 = draw the image at uImgRect, clipped to uClipRect
uniform vec4 uOutRect;       // this pass's output rect (vUV spans it)
uniform vec4 uImgRect;       // the image, fitted by preserveAspectRatio
uniform vec4 uClipRect;      // the primitive subregion
// The REGION fit (an image referenced by id, or one the renderer could not place): two maps
// composed on the CPU (filterGraph/primitives/image.js feImageMaps).
uniform vec4 uImgMap;        // uv = vUV * uImgMap.xy + uImgMap.zw
uniform vec4 uAtlasMap;      // atlas uv = uv * uAtlasMap.xy + uAtlasMap.zw
in vec2 vUV;                 // fullscreen-quad varying in [0,1]² (matches composite.vert)
out vec4 fragColor;

void main() {
  if (uPlaced == 1) {
    vec2 p = uOutRect.xy + vUV * uOutRect.zw;              // this fragment's canvas px (its center)
    vec2 c0 = uClipRect.xy, c1 = uClipRect.xy + uClipRect.zw;
    vec2 uvP = (p - uImgRect.xy) / max(uImgRect.zw, vec2(1e-6));
    bool inside = p.x >= c0.x && p.y >= c0.y && p.x <= c1.x && p.y <= c1.y
               && uvP.x >= 0.0 && uvP.y >= 0.0 && uvP.x <= 1.0 && uvP.y <= 1.0;
    // Sampled on every fragment, so the implicit derivatives that pick the mip level are defined
    // across the quad; the fragments outside take zero after. Canvas y runs up and the image's first
    // row is its TOP.
    vec2 q = clamp(uvP, 0.0, 1.0);
    float u = (q.x * uAtlasRect.y) / max(uAtlasSize.x, 1.0);
    float v = (uAtlasRect.x + (1.0 - q.y) * uAtlasRect.z) / max(uAtlasSize.y, 1.0);
    vec4 ci = texture(uIn, vec2(u, v));
    fragColor = inside ? ci : vec4(0.0);
    return;
  }
  // The image is placed across the filter REGION, not across this pass's
  // output rect — they are the same only when the output covers the canvas.
  vec2 uv = vUV * uImgMap.xy + uImgMap.zw;
  // Outside the image (the letterbox margins, or past the region) is transparent.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = texture(uIn, uv * uAtlasMap.xy + uAtlasMap.zw);
}
