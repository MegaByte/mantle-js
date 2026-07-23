// shapeScale — how big is an average shape of this bundle, in PIXELS, for this draw?
//
// Both engine selectors need this and they must agree, so it lives in one place:
//   * fillPass `aacFill:'auto'`  → AAC vs Slug, keyed on px² per SHAPE
//   * the LB route `'auto'` gate → LB vs (AAC|Slug), keyed on px² per SEGMENT
//
// The two axes differ because the two engines pay in different currencies. AAC's
// cost is a big fragment kernel (register pressure), paid once per FRAGMENT, so
// what has to be large is fragments-per-shape. LB's cost is a triangle mesh, paid
// once per TRIANGLE (≈ per segment) in the vertex stage, while its fragment work is
// a single implicit-function test — so what has to be large is fragments-per-segment.
// Dividing by segments is right for LB and actively wrong for AAC (it is
// non-monotone for arcs there; see fillPass).
//
// Scale chain, matching mantle.vert.glsl: a bundle's globalBBox is fitted to the
// viewport under an aspect-preserving scale, then the per-draw world matrix applies.
//     d(px.x)/d(unit.x) = arScale.x * canvasW / gbb.w
// and area scales by the product, times |det| of the world matrix's 2×2 linear part.

/// px² covered by an average shape of `bundle` under the CURRENT draw state.
/// Returns 0 when unknown (no bbox, no area) so callers fall back to their
/// conservative engine.
export function meanShapePx2(R, bundle) {
  if (!bundle || !bundle.meanShapeArea) return 0;
  const gbb = bundle.globalBBox;
  if (!gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) return 0;
  const [cw, ch] = R.viewportSize();
  const [sx, sy] = R.arScale(gbb, cw, ch);
  const unitPx2 = (sx * cw / gbb[2]) * (sy * ch / gbb[3]);   // px² per bundle-unit²
  const m = R.draw && R.draw.worldM;
  // column-major mat3 ⇒ 2×2 linear part is [[m0, m3], [m1, m4]]
  const det = m ? Math.abs(m[0] * m[4] - m[3] * m[1]) : 1;
  return Number.isFinite(det) ? bundle.meanShapeArea * unitPx2 * det : 0;
}

/// Smallest device-pixel scale of any local-space direction. Unlike the
/// area-derived scale, this remains conservative under anisotropic scale and
/// shear, which matters when proving that a stroke hides a fill's AA fringe.
export function minLinearScalePx(R, bundle) {
  if (!bundle) return 0;
  const gbb = bundle.globalBBox;
  if (!gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) return 0;
  const [cw, ch] = R.viewportSize();
  const [sx, sy] = R.arScale(gbb, cw, ch);
  const px = sx * cw / gbb[2], py = sy * ch / gbb[3];
  const m = R.draw && R.draw.worldM;
  const a = px * (m ? m[0] : 1), b = py * (m ? m[1] : 0);
  const c = px * (m ? m[3] : 0), d = py * (m ? m[4] : 1);
  const sum = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  const disc = Math.max(0, sum * sum - 4 * det * det);
  const sigma2 = 0.5 * (sum - Math.sqrt(disc));
  return Number.isFinite(sigma2) && sigma2 > 0 ? Math.sqrt(sigma2) : 0;
}

/// px² per SEGMENT of an average shape — the axis LB is selected on.
/// Falls back to px²/shape when the segment count is unknown (older bundles),
/// which is the conservative direction for LB only if callers also gate on
/// eligibility; see `_lbSizeOk`.
export function meanShapePx2PerSeg(R, bundle) {
  const px2 = meanShapePx2(R, bundle);
  const segs = (bundle && bundle.meanSegsPerShape) || 0;
  return segs > 0 ? px2 / segs : px2;
}
