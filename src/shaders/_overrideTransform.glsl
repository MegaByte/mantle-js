// _overrideTransform.glsl — shared per-shape override transform for the
// fragment-side (sample-coordinate) path.
//
// Used by both mantle.frag (animated clip coverage) and maskBake.frag
// (animated <mask> child geometry) so the two cannot diverge — an animated
// mask child must transform identically to how the same override moves a
// clip child, or the mask edge would slide off the geometry it masks.
//
// The including shader must declare:
//   uniform sampler2D uOverrideTex;   // 6-texel-per-shape override plane
//   uniform int       uHasOverrides;  // 1 when an override table is bound
//
// Inverse-applies the per-row affine override to a world-space em coord,
// returning the shape's LOCAL frame so the curve raycast runs against the
// un-transformed geometry — the shape appears translated / scaled / rotated
// while its stored curves stay put. `row` is the shape's meta row (== its
// override-plane row).
vec2 transformClipCoord(vec2 emCoord, int row) {
// Only animated clip / mask geometry reads the override plane here. When the
// including fill variant omits both clip and mask, the body collapses to the
// identity so uOverrideTex/uHasOverrides can be dropped. maskBake defines
// neither macro → keeps the full transform.
#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return emCoord;
#else
  if (uHasOverrides != 1) return emCoord;
  vec4 ovAff = texelFetch(uOverrideTex, ivec2(OV_AFFINE, row), 0);
  vec4 ovP   = texelFetch(uOverrideTex, ivec2(OV_POS_VIS, row), 0);
  // M = ((ovAff.x, ovAff.y), (ovAff.z, ovAff.w)) row-major.
  // local = M^-1 * (world - t).
  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;
  if (abs(det) < 1e-12) return emCoord;  // degenerate → fall back
  float invDet = 1.0 / det;
  vec2 d = emCoord - ovP.xy;
  return vec2(invDet * ( ovAff.w * d.x - ovAff.y * d.y),
              invDet * (-ovAff.z * d.x + ovAff.x * d.y));
#endif
}
