// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
  vec4 ovAff = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  vec4 ovP   = texelFetch(uOverrideTex, ovAt(OV_POS_VIS, row), 0);
  // M = ((ovAff.x, ovAff.y), (ovAff.z, ovAff.w)) row-major.
  // local = M^-1 * (world - t).
  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;

  if (!(abs(det) > 2.384185791015625e-7 * (abs(ovAff.x * ovAff.w) + abs(ovAff.y * ovAff.z)))) return emCoord;
  float invDet = 1.0 / det;
  vec2 d = emCoord - ovP.xy;
  return vec2(invDet * ( ovAff.w * d.x - ovAff.y * d.y),
              invDet * (-ovAff.z * d.x + ovAff.x * d.y));
#endif
}
// ONE DEVICE PIXEL IN THE ROW'S LOCAL FRAME, as the reciprocal the fill kernels take (invPx). The curve walk runs in that frame, where an
// override's scale makes a pixel a different size: a quarter of the world pixel under scale(4). The world's reciprocal there made an animated
// clip's or mask's AA ramp 4 px wide, and under a shrink narrower than a pixel. The footprint is the local map's own box,
// |M^-1| ePx, as fwidth forms it; an override that does not scale or turn it leaves invPx bit for bit.
vec2 transformClipPx(vec2 invPx, int row) {
#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return invPx;
#else
  if (uHasOverrides != 1) return invPx;
  vec4 ovAff = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  if (ovAff == vec4(1.0, 0.0, 0.0, 1.0)) return invPx;
  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;
  if (!(abs(det) > 2.384185791015625e-7 * (abs(ovAff.x * ovAff.w) + abs(ovAff.y * ovAff.z)))) return invPx;   // as transformClipCoord
  vec2 e = 1.0 / invPx;
  vec2 local = vec2(abs(ovAff.w) * e.x + abs(ovAff.y) * e.y, abs(ovAff.z) * e.x + abs(ovAff.x) * e.y) / abs(det);
  return 1.0 / max(local, vec2(1e-30));
#endif
}
// transformClipCoord's LINEAR part: carries a screen derivative of emCoord into the same local
// frame (the translation drops out), with the same fall-backs.
vec2 transformClipDir(vec2 dEm, int row) {
#if defined(MANTLE_NO_CLIP) && defined(MANTLE_NO_MASK)
  return dEm;
#else
  if (uHasOverrides != 1) return dEm;
  vec4 ovAff = texelFetch(uOverrideTex, ovAt(OV_AFFINE, row), 0);
  float det = ovAff.x * ovAff.w - ovAff.y * ovAff.z;
  if (!(abs(det) > 2.384185791015625e-7 * (abs(ovAff.x * ovAff.w) + abs(ovAff.y * ovAff.z)))) return dEm;   // as above
  float invDet = 1.0 / det;
  return vec2(invDet * ( ovAff.w * dEm.x - ovAff.y * dEm.y),
              invDet * (-ovAff.z * dEm.x + ovAff.x * dEm.y));
#endif
}
// That pixel as the footprint the stroke walks take, from the screen derivatives. With no override transformClipDir hands them back, so this is
// abs(dx) + abs(dy), which is what ePx is.
vec2 transformClipEPx(vec2 dx, vec2 dy, int row) { return abs(transformClipDir(dx, row)) + abs(transformClipDir(dy, row)); }
