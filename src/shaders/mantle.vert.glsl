#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;  // uMetaTex/uOverrideTex are RGBA32F em-space data (lowp default crushes them)

// Per-shape OBB cover quad with full Lengyel "A Decade of Slug"
// dynamic dilation. Each cover-quad corner is pushed outward along
// its outward bisector normal by EXACTLY half a pixel in viewport
// space.
//
// Inputs (per vertex, from importer.js getCoverQuadMesh cover-
// quad chunks):
//   aPos      : em-space vertex position (one of 6 OBB-quad corners)
//   aNormal   : un-normalized outward bisector at this vertex
//               (OBB: ±uHat ± vHat per quadrant; AABB: ±1, ±1)
//   aShapeIdx : per-vert meta-row index. Reading shapeIdx from the
//               vert lets a SINGLE drawArrays cover the whole
//               cover-quad set.
// Per-draw uniforms:
//   uMetaTex      : per-shape meta; texel 0 = em-space bbox (used
//                   only by the fragment shader, not here)
//   uGlobalBBox   : (minX, minY, w, h) em-space; em → NDC mapping
//   uCanvasAR     : aspect-preserving NDC scale
//   uViewportSize : canvas pixels (w, h)
//   uNumShapes    : for per-shape z = 1 - shapeIdx/N painter ordering
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aNormal;
// Optional per-vert native-em sample coord. Stored in the buffer slot
// reserved for curve control point v1 (offset 16 / floats 4-5). For
// non-9-slice bundles this slot is unused by the cover-quad path;
// nineSlice.applyNineSlice() rewrites it to hold the native em coord so
// the fragment's coverage sampler sees undeformed curves in stretched
// cells. uHasEmCoord = 1 selects this attribute over aPos for vEmCoord;
// default (0) keeps "aPos IS emPos".
layout(location=2) in vec2 aEmCoord;
layout(location=7) in float aShapeIdx;
out vec2 vEmCoord;
out vec4 vOverrideTint;     // multiplied into the fill+stroke colour in mantle.frag
#ifdef MANTLE_INSTANCED
out vec4 vInstBias;         // ADDED to the fill+stroke colour after the tint (fog)
#endif
// Absolute attribute overrides. Driven by the override table's
// per-attribute mask (texel 1.w); the fragment shader gates the
// replacement at draw time so unmasked attributes pass through.
flat out int vOverrideMask; // 0 when none; 0x1=fill, 0x2=stroke, 0x4=strokeWidth
out vec4 vOverrideFill;     // absolute fill colour when (mask & 1)
out vec4 vOverrideStroke;   // absolute stroke colour when (mask & 2)
out float vOverrideStrokeWidth;  // absolute em-space width when (mask & 4)
flat out int vInst;
uniform sampler2D uMetaTex;
@@BUNDLE_LAYOUT@@
uniform vec4 uGlobalBBox;
uniform vec2 uCanvasAR;
uniform vec2 uViewportSize;
uniform float uNumShapes;
// -1 = use aShapeIdx (main path, single-drawcall fills).
// >=0 = override (mask render binds a separate VBO without an
// aShapeIdx column, so it forces shapeIdx via uniform).
uniform int uShapeIdxOverride;
// 1 → read native em-coord from aEmCoord (set by nineSlice rewrite);
// 0 → fall back to aPos (every non-9-slice bundle).
uniform int uHasEmCoord;

// Per-shape override texture (animation extensions).
// 6 RGBA32F texels per shape, row = shapeIdx, columns:
//   0 : (m00, m01, m10, m11) — 2×2 affine
//   1 : (tx, ty, visibility, overrideMask)
//   2 : (tint.r, tint.g, tint.b, tint.a) — multiplicative
//   3 : (fill.r, fill.g, fill.b, fill.a)  — abs fill   when mask & 1
//   4 : (stroke.r, stroke.g, stroke.b, stroke.a) — abs stroke when mask & 2
//   5 : (strokeWidth, _, _, _) — abs strokeWidth when mask & 4
// Bound when uHasOverrides == 1; otherwise the shape draws as-is
// and the override varyings carry inert defaults.
uniform sampler2D uOverrideTex;
uniform int uHasOverrides;
// Per-draw alpha multiplier. Set from drawBundle/drawInstance's
// opts.alpha; defaults to 1.0 when omitted. Folded into the per-shape
// tint alpha here so callers get a universal opacity multiplier
// whether or not an override table is bound (works on bare bundles too).
uniform float uDrawAlpha;
// World-space 3×3 affine applied to em-space verts after dilation.
// Identity when no per-draw transform is provided. Stored as 3 vec3
// columns: uWorldM[0]=col0 (m00, m10, 0), uWorldM[1]=col1 (m01, m11, 0),
// uWorldM[2]=col2 (tx, ty, 1).
uniform mat3 uWorldM;
uniform int uHasWorldM;
#ifdef MANTLE_LB_COV
// Composed morph cover quad: the static unit-quad corner aPos (0/1) is expanded
// to this morphed AABB (em-space), eliminating the per-frame quad upload.
uniform vec4 uCoverBBox;
#endif

// Instanced fill variant (drawBundleInstanced fast path). The per-draw
// world matrix + alpha come from per-instance vertex attributes (divisor
// 1) instead of the uWorldM/uDrawAlpha uniforms, so one drawArraysInstanced
// paints N transformed copies of a fill-only bundle. Everything else
// (curve/band/meta textures, shared override table, recolor) is identical
// to the non-instanced program — only these inputs differ, so the
// fragment shader is shared verbatim. Locations 8–11 are free (the fill
// vertex shader uses 0,1,2,7; the cover-quad mesh fills 3–6 unused here).
#ifdef MANTLE_INSTANCED
layout(location=8)  in vec3 aInstW0;   // uWorldM col0 (m00, m10, 0)
layout(location=9)  in vec3 aInstW1;   // uWorldM col1 (m01, m11, 0)
layout(location=10) in vec3 aInstW2;   // uWorldM col2 (tx,  ty,  1)
layout(location=11) in float aInstAlpha;
// Per-instance rgba tint (multiplicative; white = none). Folded into the
// override tint below, so it multiplies fill + stroke exactly like a
// diagonal colorMatrix would (the shared uColorMatrix, if enabled, applies
// AFTER it in mantle.frag — matching the per-instance loop's composed-
// matrix fallback semantics).
layout(location=12) in vec4 aInstTint;
// Per-instance additive BIAS, applied after the tint: out = clamp(in*tint + bias).
//
// A tint alone is a diagonal colour matrix — a pure multiply. It cannot express a FOG:
//   out.rgb = in.rgb*fog + fogColor*(1 - fog)
// which is a diagonal scale PLUS an offset. Without a bias slot, any instance carrying an
// offset fell off the instanced fast path entirely and the whole draw collapsed to one
// draw call PER INSTANCE. The offset is one vec4; the draw calls were the expensive part.
layout(location=13) in vec4 aInstBias;
#endif

// Compose rows 0/1/3 of the em→clip matrix. The em→NDC pipeline is:
//   uv      = (em - bb.xy) / bb.zw
//   plane   = (uv*2 - 1) * canvasAR        // sign-flip y at the
//                                          // gl_Position assignment
//   gl_Pos  = (plane.x, -plane.y, z, 1)
// ⇒ x_clip = canvasAR.x * 2 / bb.z * em.x + (-canvasAR.x - 2*bb.x*canvasAR.x/bb.z)
//   y_clip = -canvasAR.y * 2 / bb.w * em.y + ( canvasAR.y + 2*bb.y*canvasAR.y/bb.w)
//   w_clip = 1
// Lengyel's MantleCoverQuadDilate needs (m0, m1, m3) = rows 0, 1, 3 of
// this matrix as float4 (xy, z, w with z unused for 2D). We populate
// only .xy and .w (z stays 0).
vec4 emRow0() {
  float sx = uCanvasAR.x * 2.0 / uGlobalBBox.z;
  return vec4(sx, 0.0, 0.0, -uCanvasAR.x - 2.0 * uGlobalBBox.x * uCanvasAR.x / uGlobalBBox.z);
}
vec4 emRow1() {
  float sy = -uCanvasAR.y * 2.0 / uGlobalBBox.w;
  return vec4(0.0, sy, 0.0, uCanvasAR.y + 2.0 * uGlobalBBox.y * uCanvasAR.y / uGlobalBBox.w);
}
vec4 emRow3() {
  // 2D ortho: w = 1. m3 = (0, 0, 0, 1).
  return vec4(0.0, 0.0, 0.0, 1.0);
}

// Lengyel "A Decade of Slug" dynamic dilation. Pushes the cover-quad
// vertex outward along `normal` so the corner moves by half a pixel
// in viewport space.
//   s  = clip-w at vertex
//   t  = clip-w derivative along normal
//   uv = squared per-axis viewport-shift-per-unit-normal
//   d  = s²(st + √uv) / (uv − s²t²)
// Returns the em-space displacement Δem; caller adds to em-pos for
// rasterization AND to the sample coord (emPos == sample coord in
// Mantle's design, so the inverse Jacobian is identity → Δem = d·n).
vec2 coverQuadDilate(vec2 emPos, vec2 normal,
                vec4 m0, vec4 m1, vec4 m3,
                vec2 viewportPx) {
  if (dot(normal, normal) < 1e-12) return vec2(0.0);
  vec2 nHat = normalize(normal);
  float s = dot(m3.xy, emPos) + m3.w;
  float t = dot(m3.xy, nHat);
  float u = (s * dot(m0.xy, nHat) - t * (dot(m0.xy, emPos) + m0.w)) * viewportPx.x;
  float v = (s * dot(m1.xy, nHat) - t * (dot(m1.xy, emPos) + m1.w)) * viewportPx.y;
  float s2 = s * s;
  float st = s * t;
  float uv = u * u + v * v;
  float denom = uv - st * st;
  if (abs(denom) < 1e-12) return vec2(0.0);
  return normal * (s2 * (st + sqrt(uv)) / denom);
}

void main() {
  int shapeIdx = (uShapeIdxOverride >= 0) ? uShapeIdxOverride : int(aShapeIdx + 0.5);
  vInst = shapeIdx;

  // World transform + draw-alpha source: per-instance attributes in the
  // instanced variant, the per-draw uniforms otherwise. The rest of main()
  // reads wWorldM / wHasWorldM / wDrawAlpha so the two paths share code.
#ifdef MANTLE_INSTANCED
  mat3  wWorldM    = mat3(aInstW0, aInstW1, aInstW2);
  int   wHasWorldM = 1;
  float wDrawAlpha = aInstAlpha;
  vec4  wDrawTint  = aInstTint;
  vInstBias        = aInstBias;
#else
  mat3  wWorldM    = uWorldM;
  int   wHasWorldM = uHasWorldM;
  float wDrawAlpha = uDrawAlpha;
  vec4  wDrawTint  = vec4(1.0);   // compile-time white → multiply folds away
#endif

  // Per-shape override read. The shader-side default is identity +
  // white tint + full visibility so uniformly-unset shapes are
  // indistinguishable from a no-override draw.
  vec2 ovPos = vec2(0.0);
  mat2 ovBasis = mat2(1.0, 0.0, 0.0, 1.0);
  float ovVis = 1.0;
  vec4 ovTint = vec4(1.0);
  int ovMask = 0;
  vec4 ovFill = vec4(0.0);
  vec4 ovStrk = vec4(0.0);
  float ovStrkW = 0.0;
  if (uHasOverrides == 1) {
    vec4 ovAff  = texelFetch(uOverrideTex, ivec2(OV_AFFINE, shapeIdx), 0); // m00,m01,m10,m11
    vec4 ovP    = texelFetch(uOverrideTex, ivec2(OV_POS_VIS, shapeIdx), 0); // tx,ty,vis,mask
    ovTint      = texelFetch(uOverrideTex, ivec2(OV_TINT, shapeIdx), 0);
    // Pack basis column-major into mat2 (GLSL is column-major).
    ovBasis = mat2(ovAff.x, ovAff.z,
                   ovAff.y, ovAff.w);
    ovPos = ovP.xy;
    ovVis = clamp(ovP.z, 0.0, 1.0);
    ovMask = int(ovP.w + 0.5);
    // Conditional fetches: a shape with no absolute-override bits set
    // doesn't pay for the three trailing texel reads. Branch-coherent
    // within a draw (one shape per fragment quad) so the cost is
    // bounded by the actual overridden-shape count.
    if ((ovMask & 1) != 0) ovFill   = texelFetch(uOverrideTex, ivec2(OV_FILL, shapeIdx), 0);
    if ((ovMask & 2) != 0) ovStrk   = texelFetch(uOverrideTex, ivec2(OV_STROKE, shapeIdx), 0);
    if ((ovMask & 4) != 0) ovStrkW  = texelFetch(uOverrideTex, ivec2(OV_STROKE_W, shapeIdx), 0).x;
  }
  // Fold the per-draw alpha multiplier AND the per-shape visibility into the
  // override tint alpha (mantle.frag multiplies vFill/vStroke by vOverrideTint),
  // giving a uniform fade whether or not an override table is bound. uDrawAlpha
  // defaults to 1.0. Visibility is a CONTINUOUS [0,1] fade (0.5 ⇒ half-opacity),
  // not binary — the ovVis<=0 collapse below is just the fully-transparent fast
  // path.
  ovTint *= wDrawTint;   // per-instance rgba tint (instanced variant; 1 otherwise)
  ovTint.a *= wDrawAlpha * ovVis;
  vOverrideTint = ovTint;
  vOverrideMask = ovMask;
  vOverrideFill = ovFill;
  vOverrideStroke = ovStrk;
  vOverrideStrokeWidth = ovStrkW;

  // Visibility = 0 → collapse vert behind the near plane. The
  // rasterizer drops the degenerate triangle.
  if (ovVis <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vEmCoord = vec2(0.0);
    return;
  }

  // Cover-quad dilation Jacobian (em → clip). emRow0/1 give the em→clip
  // affine for an IDENTITY worldMatrix (clip = (plane.x, -plane.y, 1)).
  // When a worldMatrix is active we MUST compose it in: the dilation
  // moves the vertex half a pixel in VIEWPORT space, and a bundle drawn
  // small via worldMatrix (e.g. an em→pixel placement at 8% scale) has a
  // real on-screen scale that the pre-worldM rows don't see. Without this
  // the AA band is ~1/worldScale too THIN — the cover quad barely exceeds
  // the glyph OBB, starving the half-pixel guard and dropping tiny text on
  // some drivers (ANGLE/Metal) near a viewport edge. Compose worldM into
  // the affine rows so the half pixel is half a pixel at the ACTUAL scale:
  //   clip.x = m00·plane.x + m01·(−plane.y) + tx  ⇒ row = m00·e0 + m01·e1
  // (uWorldM is column-major: uWorldM[c][r]; col2 = (tx, ty, w).)
  vec4 e0 = emRow0(), e1 = emRow1();
  vec4 m0, m1, m3;
  if (wHasWorldM == 1) {
    m0 = wWorldM[0][0] * e0 + wWorldM[1][0] * e1;  m0.w += wWorldM[2][0];
    m1 = wWorldM[0][1] * e0 + wWorldM[1][1] * e1;  m1.w += wWorldM[2][1];
    m3 = wWorldM[0][2] * e0 + wWorldM[1][2] * e1;  m3.w += wWorldM[2][2];
  } else {
    m0 = e0; m1 = e1; m3 = emRow3();
  }
  // Fold the per-shape override basis into the dilation Jacobian. The override
  // (applied below as ovBasis*emDilated + ovPos) changes the shape's ACTUAL
  // on-screen scale, and the half-pixel guard must be half a pixel at THAT
  // scale — otherwise an override-scaled/rotated shape gets a band off by
  // 1/scale (the same class as the worldMatrix dilation composition above).
  // Right-multiply the linear rows by ovBasis (em→clip · ovBasis); the
  // perspective row m3 is untouched (m3.xy=0 in 2D ortho, so ovPos / translation
  // never enter the dilation). For an identity basis this is a no-op.
  if (uHasOverrides == 1) {
    m0.xy = m0.xy * ovBasis;
    m1.xy = m1.xy * ovBasis;
  }
  // Composed morph draw: aPos is a UNIT-quad corner (0/1); expand it to the
  // morphed AABB (uCoverBBox) here so the cover quad needs NO per-frame vertex
  // upload — only the uCoverBBox uniform changes. The default program
  // (no MANTLE_LB_COV) reads aPos as the em corner verbatim.
  vec2 lbPos = aPos;
#ifdef MANTLE_LB_COV
  lbPos = mix(uCoverBBox.xy, uCoverBBox.zw, aPos);
#endif
  vec2 dEm = coverQuadDilate(lbPos, aNormal, m0, m1, m3, uViewportSize);
  vec2 emDilated = lbPos + dEm;
  // Apply per-shape local affine in em-space BEFORE the global
  // em→NDC projection.
  vec2 emTransformed = (uHasOverrides == 1)
    ? ovBasis * emDilated + ovPos
    : emDilated;
  // Mantle convention: emPos == sample coord. Default: aPos drives both
  // the rasterizer (via emTransformed → NDC below) and the fragment's
  // ray-cast (via vEmCoord). In 9-slice mode, aEmCoord supplies
  // the NATIVE em coord (clamped to the corner cells) so the fragment
  // sampler reads undeformed curves while the rasterizer stretches
  // verts into the target rect. Override basis+pos applies to the
  // sampling frame (a shape rotated via override rotates its silhouette
  // as a rigid body regardless of 9-slice).
  if (uHasEmCoord == 1) {
    vec2 emSampled = (uHasOverrides == 1)
      ? ovBasis * aEmCoord + ovPos
      : aEmCoord;
    vEmCoord = emSampled;
  } else {
    vEmCoord = emTransformed;
  }

  vec2 uv = (emTransformed - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  float z = (uNumShapes > 0.0) ? (1.0 - float(shapeIdx) / uNumShapes) : 0.0;
  // Per-draw world transform. 3×3 mat applied to
  // (plane.x, -plane.y, 1.0). Identity by default — non-COLR
  // paths leave this off and pay nothing.
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (wHasWorldM == 1) {
    // SVG 2 vector-effect: selectively cancel parts of uWorldM (the
    // supplemental transform applied at draw time) per flagsShape.
    //   bit 10 = non-scaling-size — undo uniform scale
    //   bit 11 = non-rotation     — undo rotation
    //   bit 12 = fixed-position   — undo translation
    // Decomposition assumes a similarity uWorldM (rotation + uniform
    // scale + translation), the common case for SVG/CSS transforms.
    // For an arbitrary affine, only the translation cancellation is
    // exact; the rotation/scale cancellation degrades gracefully
    // (the polar decomposition extracts the closest rotation).
    //
    // Anchoring: scale/rotation cancellation pivots around the shape's
    // bbox-center projected through the em→NDC pipeline (so the shape
    // stays put while only the supplemental scale/rot is removed).
    vec4 cj = texelFetch(uMetaTex, ivec2(MT_CAP_JOIN, shapeIdx), 0);
    int flagsShape = int(cj.w + 0.5);
    bool nonScalingSize = (flagsShape & 1024) != 0;
    bool nonRotation    = (flagsShape & 2048) != 0;
    bool fixedPosition  = (flagsShape & 4096) != 0;
    if (nonScalingSize || nonRotation || fixedPosition) {
      // Project the shape's bbox center through the same em→NDC chain
      // so the anchor lives in clip space (where uWorldM applies).
      vec4 bb = texelFetch(uMetaTex, ivec2(MT_BBOX, shapeIdx), 0);
      vec2 anchorEm = vec2((bb.x + bb.z) * 0.5, (bb.y + bb.w) * 0.5);
      vec2 anchorUV = (anchorEm - uGlobalBBox.xy) / uGlobalBBox.zw;
      vec2 anchorPlane = (anchorUV * 2.0 - 1.0) * uCanvasAR;
      vec2 anchorClip = vec2(anchorPlane.x, -anchorPlane.y);

      // Decompose uWorldM linear part (column-major in mat3):
      //   col0 = (m00, m10, 0), col1 = (m01, m11, 0), col2 = (tx, ty, 1)
      float m00 = wWorldM[0][0], m10 = wWorldM[0][1];
      float m01 = wWorldM[1][0], m11 = wWorldM[1][1];
      vec2 t    = wWorldM[2].xy;
      // Polar decomposition (similarity assumption): scale = column-0
      // length; rotation = arg(col0). For skewed matrices this is the
      // best-fit rotation.
      float scale = max(sqrt(m00 * m00 + m10 * m10), 1e-6);
      float cR = m00 / scale, sR = m10 / scale;
      // Reconstructed scale matrix S, rotation matrix R, translation t
      // such that uWorldM ≈ T * R * S * (vertex - origin) + origin.
      // Build the EFFECTIVE world matrix by zeroing out the cancelled
      // parts.
      vec2 effScale = nonScalingSize ? vec2(1.0) : vec2(scale);
      mat2 effR = nonRotation
        ? mat2(1.0, 0.0, 0.0, 1.0)
        : mat2(cR, sR, -sR, cR);  // GLSL column-major
      vec2 effT = fixedPosition ? vec2(0.0) : t;

      // Apply: effClip = effT + effR * (effScale * (vertexClip - anchor)) + anchor
      vec2 d = clip3.xy - anchorClip;
      d *= effScale;
      d = effR * d;
      clip3.xy = d + anchorClip + effT;
    } else {
      clip3 = wWorldM * clip3;
    }
  }
  gl_Position = vec4(clip3.xy, z, clip3.z);
}
