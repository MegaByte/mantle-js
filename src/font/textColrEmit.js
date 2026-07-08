// textColrEmit.js — COLR/CBDT/sbix glyph raster emit.

import { emitShape } from '../svg/buildContext.js';
import { mkLine, mkQuad, mkCubic, SEG_LINE, SEG_QUAD, SEG_CUBIC } from '../svg/importer.js';

/// Per-run COLR emit accumulators shared across glyphs in one bundle.
export function createColrEmitState() {
  return { colrGraphs: [], gradientStopsBytes: [] };
}

// Pack a gradient node's stops into the shared LUT and rewrite the
// node's params to carry (stopsOffset, stopsCount) instead of the raw
// `stops` array. Straight color, sentinel-padded, 32-stop cap.
function packAndRewriteStops(node, gradientStopsBytes) {
  const p = node.params || {};
  let stops = p.stops;
  if (!stops || !stops.length) return;
  // Sentinel pad to [0,1] and sort.
  stops = stops.slice().sort((a, b) => a.offset - b.offset);
  if (stops[0].offset > 0) stops = [{ offset: 0, color: stops[0].color }].concat(stops);
  if (stops[stops.length - 1].offset < 1) {
    stops.push({ offset: 1, color: stops[stops.length - 1].color });
  }
  if (stops.length > 32) stops = stops.slice(0, 32);
  // Matches packGradientStops + sampleStopsRaw. All-opaque stops take the
  // 1-texel/stop fast path (R,G,B,offset); otherwise 2 texels/stop (straight
  // RGBA + offset). stopsOffset is the TEXEL offset; stopsCount is signed
  // (negative = 1-texel).
  const q = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const opaque = stops.every((s) => Math.round((s.color[3] ?? 1) * 255) === 255);
  let buf;
  if (opaque) {
    buf = new Uint8Array(stops.length * 4);
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i]; const c = i * 4;
      buf[c + 0] = q(s.color[0]); buf[c + 1] = q(s.color[1]);
      buf[c + 2] = q(s.color[2]); buf[c + 3] = q(s.offset);
    }
  } else {
    buf = new Uint8Array(stops.length * 8);
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i]; const c = i * 8;
      buf[c + 0] = q(s.color[0]); buf[c + 1] = q(s.color[1]);
      buf[c + 2] = q(s.color[2]); buf[c + 3] = q(s.color[3]); buf[c + 4] = q(s.offset);
    }
  }
  // stopsOffset is the TEXEL offset (4 bytes/texel — works for either stride).
  let offset = 0;
  for (const b of gradientStopsBytes) offset += b.length >>> 2;
  gradientStopsBytes.push(buf);
  p.stopsOffset = offset;
  p.stopsCount = opaque ? -stops.length : stops.length;
  // Drop the raw `stops` array — the renderer reads from the bundle's
  // shared texture via (stopsOffset, stopsCount). Keeping it would
  // mislead the dispatch's fallback lazy-texture path.
  delete p.stops;
}

// Walk a COLR graph and pack every gradient node's stops into the
// shared LUT. Mutates node.params in place.
function bakeColrGradients(graph, gradientStopsBytes) {
  if (!graph || !graph.nodes) return;
  for (const n of graph.nodes) {
    if (n.type === 'PaintLinearGradient'
     || n.type === 'PaintRadialGradient'
     || n.type === 'PaintSweepGradient') {
      packAndRewriteStops(n, gradientStopsBytes);
    }
  }
}

// The COLR reader emits geometric coordinates (gradient points,
// transform translations, radii, sweep centres) in FONT UNITS, but the
// bbox-aware shaders sample in EM space (q = uBboxOrigin + vUV*uBboxSize).
// Scale every coordinate field by 1/unitsPerEm for consistency.
//
// The affine basis (xx, yx, xy, yy) is unitless (COLRv1 spec: F2DOT14)
// so it stays; only translations (dx, dy) scale. Angles (PaintRotate
// angleDeg, PaintSweep start/endAngle) are left alone.
export function normaliseColrCoords(graph, invUpem) {
  if (!graph || !graph.nodes || !invUpem) return;
  for (const n of graph.nodes) {
    const p = n.params || {};
    switch (n.type) {
      case 'PaintLinearGradient':
        if (p.p0) { p.p0 = [p.p0[0] * invUpem, p.p0[1] * invUpem]; }
        if (p.p1) { p.p1 = [p.p1[0] * invUpem, p.p1[1] * invUpem]; }
        if (p.p2) { p.p2 = [p.p2[0] * invUpem, p.p2[1] * invUpem]; }
        break;
      case 'PaintRadialGradient':
        if (p.c0) { p.c0 = [p.c0[0] * invUpem, p.c0[1] * invUpem]; }
        if (p.c1) { p.c1 = [p.c1[0] * invUpem, p.c1[1] * invUpem]; }
        if (typeof p.r0 === 'number') p.r0 *= invUpem;
        if (typeof p.r1 === 'number') p.r1 *= invUpem;
        break;
      case 'PaintSweepGradient':
        if (p.center) { p.center = [p.center[0] * invUpem, p.center[1] * invUpem]; }
        // startAngle / endAngle stay in degrees.
        break;
      case 'PaintTransform': {
        // affine = [xx, yx, xy, yy, dx, dy]
        if (p.affine && p.affine.length >= 6) {
          const a = p.affine.slice();
          a[4] *= invUpem;
          a[5] *= invUpem;
          p.affine = a;
        }
        break;
      }
      // PaintSolid / PaintMerge / PaintGlyph / PaintComposite carry no
      // geometric coords — pass through.
    }
  }
}

export function transformAndFlip(src, offX, offY, sx, sy, rotDeg, shearTan = 0) {
  const rad = (rotDeg || 0) * Math.PI / 180;
  const c = Math.cos(rad), si = Math.sin(rad);
  const X = (p) => {
    let x = p[0] * sx, y = p[1] * sy;
    // Synthetic-italic shear: x' = x + y * tan(angle). Source coords are
    // OpenType +Y-up, so shearing before the Y-flip leans the glyph right.
    if (shearTan) x += y * shearTan;
    if (rotDeg) {
      const xr = c * x - si * y;
      const yr = si * x + c * y;
      x = xr; y = yr;
    }
    return [offX + x, offY - y];
  };
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if      (s.type === SEG_LINE)  out[i] = mkLine (X(s.p1), X(s.p2));
    else if (s.type === SEG_QUAD)  out[i] = mkQuad (X(s.p1), X(s.p2), X(s.p3));
    else if (s.type === SEG_CUBIC) out[i] = mkCubic(X(s.p1), X(s.p2), X(s.p3), X(s.p4));
  }
  return out;
}

/// Concatenate all per-gradient stop buffers into a single
/// ArrayBuffer + count. Returns
/// `{ gradientStops, gradientStopsCount }` matching the SVG bundle's
/// optional sections. Empty values when no gradients packed.
export function buildColrGradientStopsSection(perGradient) {
  if (!perGradient.length) {
    return { gradientStops: null, gradientStopsCount: 0 };
  }
  let total = 0;
  for (const b of perGradient) total += b.length;
  const flat = new Uint8Array(total);
  let off = 0;
  for (const b of perGradient) { flat.set(b, off); off += b.length; }
  return {
    gradientStops: flat.buffer.slice(flat.byteOffset, flat.byteOffset + flat.byteLength),
    gradientStopsCount: total >>> 2,   // total TEXELS (mixed 1-/2-texel strides)
  };
}

function pushShape(ctx, gidBox, bboxBox, segs, color, shapeId, colrGraphId = 0, colrMaskOnly = false,
                   strokeWidthEm = 0) {
  const opts = {
    fillRgba: color,
    shapeId,
    colrGraphId,
    flagsShape: colrMaskOnly ? 256 : 0,
  };
  if (strokeWidthEm > 0) {
    // Synthetic-bold: paint stroke + fill in the run's color. The stroke
    // renderer paints outward from the path, so visible weight is
    // fill + 2×halfwidth.
    opts.strokeRgba = color;
    opts.strokeWidth = strokeWidthEm;
  }
  emitShape(ctx, segs, opts, gidBox, bboxBox);
}

/// COLRv1 emit. Returns true when a v1 paint tree was emitted.
export function emitColrV1GlyphIfPresent(slot, slotFont, varCoords, ctx, gidBox, bboxBox, colrState,
                                         ox, oy, sx, sy, rotDeg, idx, cpHex) {
  if (!slotFont.hasColrV1) return false;
  const v1 = slotFont.getColrV1GraphByGid(slot.glyphId, varCoords);
  if (!v1 || !v1.glyphSegs || v1.glyphSegs.length === 0) return false;
  const slotInvUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;
  const segs = transformAndFlip(v1.glyphSegs, ox, oy, sx, sy, rotDeg);
  // Normalise graph coordinates from font units to em-space so the
  // bbox-aware shaders see consistent units. Runs before
  // bakeColrGradients (which reads stops only; coordinates are
  // independent).
  normaliseColrCoords(v1.graph, slotInvUpem);
  // Bake gradient stops into the run-wide LUT before pushing the graph
  // entry — mutates node.params to carry (stopsOffset, stopsCount) and
  // drops the raw stops array. The COLR dispatch then reads from the
  // shared bundle texture (same as SVG gradients).
  bakeColrGradients(v1.graph, colrState.gradientStopsBytes);
  const graphEntry = { graph: v1.graph, masks: {} };
  colrState.colrGraphs.push(graphEntry);
  const graphId = colrState.colrGraphs.length;
  // Primary shape carries the colored render op AND is mask 0 (used
  // when a PaintGlyph references the primary gid — the common
  // single-PaintGlyph case).
  const primaryShapeIdx = ctx.metas.length;
  graphEntry.masks[slot.glyphId] = primaryShapeIdx;
  pushShape(ctx, gidBox, bboxBox, segs, slot.style.color, `glyph_${idx}_u${cpHex}_colrv1`,
            graphId);
  // Mask-only shapes for OTHER PaintGlyph-referenced gids: emit each
  // (excluding the primary) as a flagsShape=256 shape so the draw-list
  // builder skips its color op. The renderer collects them via the
  // same colrGraphId and per-shape gid lookup.
  if (v1.glyphSegsByGid) {
    for (const [maskGid, maskSegs] of v1.glyphSegsByGid) {
      if (maskGid === slot.glyphId) continue;
      if (!maskSegs || maskSegs.length === 0) continue;
      const xfSegs = transformAndFlip(maskSegs, ox, oy, sx, sy, rotDeg);
      const maskShapeIdx = ctx.metas.length;
      graphEntry.masks[maskGid] = maskShapeIdx;
      pushShape(ctx, gidBox, bboxBox, xfSegs, [0, 0, 0, 1],
                `glyph_${idx}_u${cpHex}_mask_g${maskGid}`,
                graphId, /*colrMaskOnly=*/true);
    }
  }
  return true;
}

/// COLRv0 emit. Returns true when color layers were emitted.
export function emitColrV0GlyphIfPresent(slot, slotFont, ctx, gidBox, bboxBox,
                                         ox, oy, sx, sy, rotDeg, idx, cpHex) {
  const layers = slotFont.hasColor
    ? slotFont.getColoredGlyphByGid(slot.glyphId)
    : null;
  if (!layers || layers.length === 0) return false;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    if (!layer.segs || layer.segs.length === 0) continue;
    const segs = transformAndFlip(layer.segs, ox, oy, sx, sy, rotDeg);
    const color = layer.isForeground ? slot.style.color : layer.rgba;
    pushShape(ctx, gidBox, bboxBox, segs, color, `glyph_${idx}_u${cpHex}_layer${li}`);
  }
  return true;
}

/// Monochrome / synthetic-bold outline emit helper.
export function emitOutlineGlyph(ctx, gidBox, bboxBox, segs, color, shapeId, synthBoldSwEm = 0) {
  pushShape(ctx, gidBox, bboxBox, segs, color, shapeId,
            0 /* colrGraphId */, false /* colrMaskOnly */,
            synthBoldSwEm /* strokeWidthEm for synthetic bold */);
}
