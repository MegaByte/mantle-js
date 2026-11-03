// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Compute per-shape device-pixel dimensions for a draw.
//
// Both engine selectors need the draw's device scale and they must agree, so it lives in one place:
//   * fillPass `aacFill:'auto'`  → AAC vs Slug, keyed on px² per SHAPE (meanShapePx2)
//   * lbShapePolicy under `'auto'` → LB vs the cover kernel, per shape, keyed on px² per SEGMENT (unitPx2)
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

/// px² covered by an average FILL-BEARING shape of `bundle` under the current
/// draw state. Returns 0 when unknown (no bbox, no area) so callers fall back to
/// their conservative engine — and also when the bundle has no fill at all,
/// which is correct: there is no fill work for an engine choice to act on.
export function meanShapePx2(R, bundle) {
  const area = bundle && bundle.meanFillShapeArea;
  if (!bundle || !area) return 0;
  return area * unitPx2(R, bundle);
}

/// Device px² per bundle-unit² under the current draw state: the viewport fit times |det| of the
/// world matrix. 0 when the bundle has no usable bbox.
export function unitPx2(R, bundle) {
  const gbb = bundle && bundle.globalBBox;
  if (!gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) return 0;
  const [cw, ch] = R.viewportSize();
  const [sx, sy] = R.arScale(gbb, cw, ch);
  const fit = ((sx * cw) / gbb[2]) * ((sy * ch) / gbb[3]);
  const m = R.draw && R.draw.worldM;
  // column-major mat3 ⇒ 2×2 linear part is [[m0, m3], [m1, m4]]
  const det = m ? Math.abs(m[0] * m[4] - m[3] * m[1]) : 1;
  return Number.isFinite(det) ? fit * det : 0;
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
  const px = (sx * cw) / gbb[2],
    py = (sy * ch) / gbb[3];
  const m = R.draw && R.draw.worldM;
  const a = px * (m ? m[0] : 1),
    b = py * (m ? m[1] : 0);
  const c = px * (m ? m[3] : 0),
    d = py * (m ? m[4] : 1);
  const sum = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  const disc = Math.max(0, sum * sum - 4 * det * det);
  const sigma2 = 0.5 * (sum - Math.sqrt(disc));
  return Number.isFinite(sigma2) && sigma2 > 0 ? Math.sqrt(sigma2) : 0;
}

/// Does this draw's em -> device-pixel map keep the axes (a scale and a translation, a mirror allowed)? `m` is a
/// column-major mat3 world matrix, null for the identity; the bundle fit and the viewport around it only scale and
/// translate. Its off-diagonal terms (m[1], m[3]) rotate or skew, and a projective row (m[2], m[5]) varies the map per
/// pixel. The fill's rotated footprint is compiled only into programs for draws where
/// this is false (MANTLE_ROTATED_MAP): an axis-aligned draw never runs it.
export function worldMapAxisAligned(m) {
  if (!m) return true;
  return m[1] === 0 && m[3] === 0 && !m[2] && !m[5];
}

/// ...and do this draw's per-shape OVERRIDES keep the axes? A row's override basis (texel 0: m00, m01, m10, m11) is
/// composed in em space before the draw's map (mantle.vert.glsl), and the fragment reads the row's pixel footprint in
/// its own frame, so a rotated or skewed row needs the rotated footprint as a rotated world matrix does. `ov` is
/// an override table (its packedBuffer) or the packed rows themselves; null for none. Exact zeros, as above: the
/// footprint is a map, and an axis-aligned one is exactly axis-aligned.
export function overridesAxisAligned(ov) {
  const p =
    ov &&
    (ov.packedBuffer instanceof Float32Array
      ? ov.packedBuffer
      : ov instanceof Float32Array
        ? ov
        : null);
  if (!p) return true;
  // The drawn rows only: the hit-only rows that follow them in the buffer are never drawn.
  const end = ov.numShapes >= 0 ? Math.min(p.length, ov.numShapes * 24) : p.length;
  for (let b = 0; b + 3 < end; b += 24) if (p[b + 1] !== 0 || p[b + 2] !== 0) return false;
  return true;
}

/// Does an override table give some DRAWN row an absolute stroke width above zero? Such a row paints a stroke the bundle's own meta
/// does not carry, so a fill program that compiled the stroke walk out (MANTLE_NO_STROKE, chosen from the bundle's baked rows) would
/// silently drop it. Texel 1.w holds the mask (0x4 = absolute stroke width), texel 5.x the width.
export function overridesRaiseStroke(ov) {
  const p =
    ov &&
    (ov.packedBuffer instanceof Float32Array
      ? ov.packedBuffer
      : ov instanceof Float32Array
        ? ov
        : null);
  if (!p) return false;
  const end = ov.numShapes >= 0 ? Math.min(p.length, ov.numShapes * 24) : p.length;
  for (let b = 0; b + 20 < end; b += 24)
    if (((p[b + 7] + 0.5) | 0) & 4 && p[b + 20] > 0) return true;
  return false;
}

const patternMapCache = new WeakMap();

// Only inline visible patterns need the main program's rotated footprint.
// Cached resources compute their own maps during the bake.
export function patternMapAxisAligned(bundle) {
  if (!bundle) return true;
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0;
  if (!meta || stride < 44) return true;
  const generation = bundle._geomGen | 0,
    previous = patternMapCache.get(bundle);
  if (previous && previous.meta === meta && previous.generation === generation)
    return previous.aligned;
  let aligned = true;
  for (let row = 0; row < bundle.numShapes; row++) {
    const o = row * stride;
    if (
      (Math.round(meta[o + 27]) & 256) !== 0 ||
      Math.round(meta[o + 43]) !== 2 ||
      (meta[o + 21] === 0 && meta[o + 22] === 0)
    )
      continue;
    const first = Math.round(meta[o + 40]) - 1,
      last = Math.round(meta[o + 41]) - 1;
    let cached = false;
    for (let child = first; child >= 0 && child <= last && child < bundle.numShapes; child++) {
      const c = child * stride;
      if (
        (Math.round(meta[c + 27]) & (64 | 128)) !== 0 ||
        meta[c + 33] > 0 ||
        Math.round(meta[c + 43]) === 2
      ) {
        cached = true;
        break;
      }
    }
    if (!cached) {
      aligned = false;
      break;
    }
  }
  patternMapCache.set(bundle, { meta, generation, aligned });
  return aligned;
}

const patternTileCache = new WeakMap();

/// Does any inline vector pattern of `bundle` have a tile that may be finer than a device pixel under the current draw? Such a
/// draw needs the program with MANTLE_PATTERN_MEAN (mantle.frag.glsl: the pixel is the tile's mean), which a pattern drawn at a
/// pixel or more per tile never pays for. The fragment decides exactly (cEPx > tileSize, per axis); this is its conservative
/// bound: a pixel is at most 2 * s * sigma of a pattern-space unit on an axis, s the largest em per device pixel of the draw (the
/// smallest device scale of any direction) and sigma the largest singular value of the pattern's em -> pattern-space map. A bound
/// that is too wide only adds the define to a tile of up to ~2 px; one that is too narrow would leave the fade.
export function patternHasFineTile(R, bundle) {
  const bar = patternFineBar(bundle);
  if (!(bar > 0)) return false;
  const px = minLinearScalePx(R, bundle); // device px per em, smallest over directions
  return !(px >= bar); // (an unknown scale keeps the correct program)
}

/// The bar of patternHasFineTile: the device px per em below which some tile of the bundle counts as fine (t.tile < 2 * s * t.sigma, with s = 1 / px), 0 for a bundle with no inline vector pattern.
export function patternFineBar(bundle) {
  if (!bundle) return 0;
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0;
  if (!meta || stride < 44) return 0;
  const generation = bundle._geomGen | 0;
  let entry = patternTileCache.get(bundle);
  if (!entry || entry.meta !== meta || entry.generation !== generation) {
    const tiles = [];
    for (let row = 0; row < bundle.numShapes; row++) {
      const o = row * stride;
      if ((Math.round(meta[o + 27]) & 256) !== 0 || Math.round(meta[o + 43]) !== 2) continue; // not an inline vector pattern
      const w = meta[o + 38],
        h = meta[o + 39];
      if (!(w > 0) || !(h > 0)) continue;
      // texel 5 (solid slots) carries the pattern's em -> pattern-space linear part (a, b, c, d) when the pattern has a transform
      let a = meta[o + 20],
        b = meta[o + 21],
        c = meta[o + 22],
        d = meta[o + 23];
      if (a === 0 && b === 0 && c === 0 && d === 0) {
        a = 1;
        d = 1;
      }
      const sum = a * a + b * b + c * c + d * d,
        det = a * d - b * c;
      const sigma = Math.sqrt(0.5 * (sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))));
      tiles.push({ tile: Math.min(w, h), sigma: Number.isFinite(sigma) && sigma > 0 ? sigma : 1 });
    }
    entry = { meta, generation, tiles };
    patternTileCache.set(bundle, entry);
  }
  let bar = 0;
  for (const t of entry.tiles) bar = Math.max(bar, (2 * t.sigma) / t.tile);
  return bar;
}
