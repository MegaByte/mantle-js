#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Emits a 4-vertex quad covering the mask region's em-bbox, mapped into
// canvas-NDC using the same em→NDC transform as the main vertex shader
// (uGlobalBBox + uCanvasAR). The bake layer is allocated canvas-sized,
// so sampling in the fragment shader uses gl_FragCoord.xy / uViewportSize
// and the result lines up 1:1 with the main draw's fragment positions.
precision highp float;
precision highp int;
precision highp sampler2D;   // uMetaTex is RGBA32F em-space data (lowp would crush it); matches maskBake.frag

layout(location=0) in vec2 aUV;          // (0,0)..(1,1) — local corner of region quad
uniform mat3 uMaskWorld;
uniform int uResourcePatternRow;
uniform vec4 uMaskEmBBox;                // (xmin, ymin, xmax, ymax) — region em-bbox
uniform vec4 uGlobalBBox;                // canvas em-bbox (xmin, ymin, w, h)
uniform vec2 uCanvasAR;                  // aspect-preserving scale (matches main vertex shader)
uniform vec2 uViewportSize;
out vec2 vEmCoord;
flat out vec4 vMaskPixelBasis;


uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
uniform int uMaskChildRow1Based;         // 1-based meta row of this child (the fragment discards <= 0)
flat out vec4 vBB, vFill, vStroke, vGlyph, vStrokePad, vCapJoin, vGrad7, vImgRect, vAtlas, vFrame;

void main() {
  vMaskPixelBasis=vec4(0.0);
  if(uMaskWorld[0].z==0.0&&uMaskWorld[1].z==0.0&&uMaskWorld[2].z!=0.0){
    vec2 r0=vec2(uMaskWorld[0].x,uMaskWorld[1].x),r1=vec2(uMaskWorld[0].y,uMaskWorld[1].y);
    float s0=max(abs(r0.x),abs(r0.y)),s1=max(abs(r1.x),abs(r1.y));
    vec2 n0=s0>0.0?r0/s0:vec2(0.0),n1=s1>0.0?r1/s1:vec2(0.0);
    float d=n0.x*n1.y-n0.y*n1.x;
    if(d!=0.0){
      vec2 frame=uGlobalBBox.zw/uCanvasAR*uMaskWorld[2].z;
      vec2 dx=vec2(n1.y*frame.x,n1.x*frame.y)/(d*s0*uViewportSize.x);
      vec2 dy=vec2(-n0.y*frame.x,-n0.x*frame.y)/(d*s1*uViewportSize.y);
      vMaskPixelBasis=vec4(dx,dy);
    }
  }
  int row = max(uMaskChildRow1Based - 1, 0);
  vBB        = texelFetch(uMetaTex, metaAt(MT_BBOX, row), 0);
  vFill      = texelFetch(uMetaTex, metaAt(MT_FILL, row), 0);
  vStroke    = texelFetch(uMetaTex, metaAt(MT_STROKE, row), 0);
  vGlyph     = texelFetch(uMetaTex, metaAt(MT_GLYPH_BAND, row), 0);
  vStrokePad = texelFetch(uMetaTex, metaAt(MT_STROKE_PARAMS, row), 0);
  vec4 cj    = texelFetch(uMetaTex, metaAt(MT_CAP_JOIN, row), 0);
  vCapJoin   = vec4(cj.xyz, texelFetch(uMetaTex, metaAt(MT_PRIM, row), 0).z);
  vFrame     = (int(cj.w + 0.5) & FS_STROKE_LOCAL) != 0 ? texelFetch(uMetaTex, metaAt(MT_SOLID, row), 0) : vec4(0.0);
  vec4 g7    = texelFetch(uMetaTex, metaAt(MT_PAINT_ID, row), 0);
  vGrad7     = vec4(g7.xy, texelFetch(uMetaTex, metaAt(MT_FILTER_BLEND, row), 0).w, g7.w);
  vImgRect   = texelFetch(uMetaTex, metaAt(MT_IMAGE_RECT, row), 0);
  vAtlas     = texelFetch(uMetaTex, metaAt(MT_ATLAS, row), 0);
  if (uResourcePatternRow > 0) {
    // A pattern carrier can move independently of its source bbox. Bake its
    // paint across the canvas; coverage is applied by the referencing draw.
    vec2 ndc = aUV * 2.0 - 1.0;
    vec3 unworld = inverse(uMaskWorld) * vec3(ndc, 1.0);
    vec2 plane = unworld.xy / unworld.z;
    vEmCoord = uGlobalBBox.xy + (vec2(plane.x, -plane.y) / uCanvasAR + 1.0) * .5 * uGlobalBBox.zw;
    gl_Position = vec4(ndc, 0.0, 1.0);
    return;
  }
  // Region bounds are cached on the CPU; the live child can move in a morph.
  vec4 bakeBBox = uResourcePatternRow > 0 ? uMaskEmBBox : vec4(min(uMaskEmBBox.xy, vBB.xy), max(uMaskEmBBox.zw, vBB.zw));
  // Rasterize the antialias footprint beyond the mathematical boundary.
  vec2 bakePixel = uGlobalBBox.zw / (uCanvasAR * max(uViewportSize, vec2(1.0)));
  mat2 world = mat2(uMaskWorld);
  if (determinant(world) != 0.0) {
    mat2 invWorld = inverse(world);
    bakePixel = vec2(abs(invWorld[0].x) / uViewportSize.x + abs(invWorld[1].x) / uViewportSize.y,
      abs(invWorld[0].y) / uViewportSize.x + abs(invWorld[1].y) / uViewportSize.y) * uGlobalBBox.zw / uCanvasAR;
  }
  // Child bounds contain the authored stroke width. Screen-width strokes
  // can extend beyond that envelope after the bake projection changes.
  int strokeFlags = int(cj.w + 0.5);
  float extra = max(0.0, 0.5*vStrokePad.x*(strokeWidthMultiplier(strokeFlags,bakePixel)-1.0));
  int join = int(cj.y + 0.5), cap = int(cj.x + 0.5);
  float ml=max(1.0,cj.z), reach=join==0?ml:(join==3||join==4)?sqrt(ml*ml+1.0):1.0;
  if(cap==2 || int(vCapJoin.w+0.5)==3) reach=max(reach,1.41421356);
  float ramp = 0.0;
  if (vStrokePad.x > 0.0) {
    float halfPixelMean = 0.25 * (bakePixel.x + bakePixel.y);
    float effectiveHalfWidth = 0.5 * vStrokePad.x * strokeWidthMultiplier(strokeFlags, bakePixel);
    ramp = halfPixelMean + max(halfPixelMean - effectiveHalfWidth, 0.0);
  }
  vec2 padding = max(bakePixel, vec2(ramp)) + vec2(extra * reach);
  bakeBBox += vec4(-padding,padding);
  vec2 emPos = mix(bakeBBox.xy, bakeBBox.zw, aUV);
  vEmCoord = emPos;
  vec2 uv    = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  // Y-flip matches the main vertex shader (SVG y-down → GL bottom-up).
  vec3 mapped = uMaskWorld * vec3(plane.x, -plane.y, 1.0);
  gl_Position = vec4(mapped.xy, 0.0, mapped.z);
}
