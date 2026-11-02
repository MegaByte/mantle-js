// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { transformSegInto } from '../svg/transform.js';
// textColrEmit.js — COLR/CBDT/sbix glyph raster emit.

import { emitShape } from '../svg/buildContext.js';
import { mkLine, mkQuad, mkCubic, SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC } from '../svg/segment.js';
import { packStopList } from '../core/gradientStops.js';

/// Per-run COLR emit accumulators shared across glyphs in one bundle.
export function createColrEmitState() {
  return { colrGraphs: [], gradientStopsBytes: [], hit: { include: [], exclude: [], clips: [] } };
}

// Pack a gradient node's stops into the shared LUT and rewrite the
// node's params to carry (stopsOffset, stopsCount) instead of the raw
// `stops` array. The SVG packer's layout and cap (core/gradientStops.js):
// straight color, sentinel-padded, one texel per stop for a short opaque
// list, two with a fine offset otherwise. A ColorLine had a 32-stop cap here.
function packAndRewriteStops(node, gradientStopsBytes, fg) {
  const p = node.params || {};
  const stops =
    p.stops &&
    p.stops.map((s) => (s.color ? s : { offset: s.offset, color: colrStopColor(s, fg) }));
  if (!stops || !stops.length) return;
  const { bytes: buf, count } = packStopList(stops);
  // stopsOffset is the TEXEL offset (4 bytes/texel — works for either stride).
  let offset = 0;
  for (const b of gradientStopsBytes) offset += b.length >>> 2;
  gradientStopsBytes.push(buf);
  p.stopsOffset = offset;
  p.stopsCount = count;
  // Drop the raw `stops` array — the renderer reads from the bundle's
  // shared texture via (stopsOffset, stopsCount). Keeping it would
  // mislead the dispatch's fallback lazy-texture path.
  delete p.stops;
}

function colrStopColor(s, fg) {
  if (s.rgba) return s.rgba;
  const c = fg || [0, 0, 0, 1];
  return [c[0], c[1], c[2], (c[3] ?? 1) * (s.alpha ?? 1)];
}

// Walk a COLR graph and pack every gradient node's stops into the
// shared LUT. Mutates node.params in place. `fg` is the run's color, for a
// stop that names the foreground.
function bakeColrGradients(graph, gradientStopsBytes, fg) {
  if (!graph || !graph.nodes) return;
  for (const n of graph.nodes) {
    if (
      n.type === 'PaintLinearGradient' ||
      n.type === 'PaintRadialGradient' ||
      n.type === 'PaintSweepGradient'
    ) {
      packAndRewriteStops(n, gradientStopsBytes, fg);
    }
  }
}

// The COLR reader emits geometric coordinates (gradient points,
// transform translations, radii, sweep centers) in FONT UNITS. Scale every
// coordinate field by 1/unitsPerEm: the graph lives in the glyph's
// NORMALIZED design grid (y up), and the entry's `placement` maps that onto
// the bundle (emitColrV1GlyphIfPresent).
//
// The affine basis (xx, yx, xy, yy) is unitless (COLRv1 spec: F2DOT14)
// so it stays; only translations (dx, dy) scale. Angles (PaintRotate
// angleDeg, PaintSweep start/endAngle) are left alone.
export function normalizeColrCoords(graph, invUpem) {
  if (!graph || !graph.nodes || !invUpem) return;
  for (const n of graph.nodes) {
    const p = n.params || {};
    switch (n.type) {
      case 'PaintLinearGradient':
        if (p.p0) {
          p.p0 = [p.p0[0] * invUpem, p.p0[1] * invUpem];
        }
        if (p.p1) {
          p.p1 = [p.p1[0] * invUpem, p.p1[1] * invUpem];
        }
        if (p.p2) {
          p.p2 = [p.p2[0] * invUpem, p.p2[1] * invUpem];
        }
        break;
      case 'PaintRadialGradient':
        if (p.c0) {
          p.c0 = [p.c0[0] * invUpem, p.c0[1] * invUpem];
        }
        if (p.c1) {
          p.c1 = [p.c1[0] * invUpem, p.c1[1] * invUpem];
        }
        if (typeof p.r0 === 'number') p.r0 *= invUpem;
        if (typeof p.r1 === 'number') p.r1 *= invUpem;
        break;
      case 'PaintSweepGradient':
        if (p.center) {
          p.center = [p.center[0] * invUpem, p.center[1] * invUpem];
        }
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

const AFF_IDENTITY = [1, 0, 0, 1, 0, 0];
const isIdentityAffine = (m) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
// a ∘ b in the COLRv1 order [xx, yx, xy, yy, dx, dy]: apply b, then a.
const affCompose = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/// Push every PaintTransform of a COLR paint graph down to its leaves.
///
/// An affine commutes with everything between it and the paint it places: a PaintGlyph clips by an outline (the
/// transformed outline clips the transformed paint), a PaintColrLayers / PaintComposite combine per pixel (the same
/// pixel of each transformed input), and a gradient is an analytic function of position. So
/// `Transform(M, Glyph(g, paint))` is `Glyph(M g, Transform(M, paint))` exactly, and the glyph can be rasterized at its
/// final device transform instead of being drawn into an intermediate target and resampled through M (which softened
/// every edge to 51-77/255 against <= 7 for plain text). It also puts the placed outline in the bundle's own geometry,
/// where the hit test and globalBBox can see it.
///
/// Returns { graph, masks }. `graph` has PaintTransform nodes only directly above generators (PaintSolid and the three
/// gradients), where the renderer evaluates them analytically; a graph with no PaintTransform comes back as is.
/// `masks` lists, in node order, the PaintGlyph silhouettes the graph clips by: { key, glyphId, affine } with
/// `affine` null for an unplaced outline (key = the glyph id, as before) or the accumulated map in font units
/// (key = "gid#n"). A ClipList box (a PaintGlyph with `params.clipBox`) is a rectangular silhouette: { key = "clip#n",
/// glyphId: null, clip: [xMin, yMin, xMax, yMax], affine }. Every PaintGlyph node of the returned graph carries its `params.maskKey`.
export function placeColrTransforms(graph) {
  const nodes = graph.nodes;
  const masks = [];
  const seen = new Map();
  let placedCount = 0,
    clipCount = 0;
  // `clip` ([xMin, yMin, xMax, yMax], a ClipList box) names a rectangular silhouette instead of a glyph outline.
  const maskFor = (glyphId, affine, clip = null) => {
    const place = affine && !isIdentityAffine(affine) ? affine : null;
    const sig =
      (clip ? 'c' + clip.join(',') + ':' : '') +
      (place ? glyphId + ':' + place.join(',') : String(glyphId));
    let m = seen.get(sig);
    if (!m) {
      m = {
        key: clip ? 'clip#' + clipCount++ : place ? glyphId + '#' + placedCount++ : glyphId,
        glyphId,
        affine: place,
      };
      if (clip) m.clip = clip;
      seen.set(sig, m);
      masks.push(m);
    }
    return m;
  };
  if (!nodes.some((n) => n.type === 'PaintTransform')) {
    for (const n of nodes) {
      if (n.type !== 'PaintGlyph' || !n.params) continue;
      if (n.params.clipBox) n.params.maskKey = maskFor(null, null, n.params.clipBox).key;
      else if (typeof n.params.glyphId === 'number') maskFor(n.params.glyphId, null);
    }
    return { graph, masks };
  }
  const out = [];
  const emit = (type, params, inputs) => {
    out.push({ type, inputs: inputs || [], params: params || {} });
    return out.length - 1;
  };
  const visit = (i, A) => {
    const n = nodes[i];
    switch (n.type) {
      case 'PaintTransform':
        return visit(n.inputs[0], affCompose(A, n.params.affine || AFF_IDENTITY));
      case 'PaintGlyph': {
        const child = visit(n.inputs[0], A);
        const m = n.params.clipBox
          ? maskFor(null, A, n.params.clipBox)
          : maskFor(n.params.glyphId, A);
        return emit('PaintGlyph', { ...n.params, maskKey: m.key }, [child]);
      }
      case 'PaintMerge':
      case 'PaintComposite':
        return emit(
          n.type,
          { ...n.params },
          n.inputs.map((j) => visit(j, A)),
        );
      default: {
        // A generator (or an unknown leaf): placed by the accumulated map, evaluated analytically.
        const leaf = emit(
          n.type,
          { ...n.params },
          n.inputs.map((j) => visit(j, AFF_IDENTITY)),
        );
        return isIdentityAffine(A) ? leaf : emit('PaintTransform', { affine: A.slice() }, [leaf]);
      }
    }
  };
  const rootOut = visit(graph.rootOut, AFF_IDENTITY);
  return { graph: { nodes: out, rootOut }, masks };
}

/// For each PaintGlyph silhouette (by mask key), the ways the graph paints it as the ClipList boxes above it: one list of clip mask keys
/// per node that uses the silhouette (an empty list when some use has no box above it). A pointer on the silhouette answers only where
/// the boxes of at least one use all contain it.
function clipAlternatives(graph) {
  const nodes = graph.nodes,
    alts = new Map(),
    seen = new Set();
  const visit = (i, clips) => {
    const n = nodes[i],
      key = i + '|' + clips.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    if (n.type === 'PaintGlyph' && n.params) {
      // (an unplaced silhouette is keyed by its glyph id, as its mask row is)
      const mk = n.params.maskKey !== undefined ? n.params.maskKey : n.params.glyphId;
      if (n.params.clipBox) {
        for (const j of n.inputs) visit(j, clips.concat(mk));
        return;
      }
      if (mk !== undefined) {
        const list = alts.get(mk) || [];
        list.push(clips);
        alts.set(mk, list);
      }
    }
    for (const j of n.inputs) visit(j, clips);
  };
  visit(graph.rootOut, []);
  return alts;
}

// A ClipList box as a closed rectangle in font units, wound like a TrueType outer contour (clockwise, y up).
function clipBoxSegs([x0, y0, x1, y1]) {
  return [
    mkLine([x0, y0], [x0, y1]),
    mkLine([x0, y1], [x1, y1]),
    mkLine([x1, y1], [x1, y0]),
    mkLine([x1, y0], [x0, y0]),
  ];
}

function transformFontSegs(segs, m) {
  const P = (p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  return segs.map((s) => {
    let o;
    if (s.type === SEG_LINE) o = mkLine(P(s.p1), P(s.p2));
    else if (s.type === SEG_QUAD) o = mkQuad(P(s.p1), P(s.p2), P(s.p3));
    else if (s.type === SEG_CUBIC) o = mkCubic(P(s.p1), P(s.p2), P(s.p3), P(s.p4));
    else throw new TypeError('Unsupported glyph segment type: ' + s.type);
    if (s.subStart) o.subStart = true;
    if (s.openEnd) o.openEnd = true;
    return o;
  });
}

export function transformAndFlip(src, offX, offY, sx, sy, rotDeg, shearTan = 0) {
  const rad = ((rotDeg || 0) * Math.PI) / 180;
  const c = Math.cos(rad),
    si = Math.sin(rad);
  const X = (p) => {
    let x = p[0] * sx,
      y = p[1] * sy;
    // Synthetic-italic shear: x' = x + y * tan(angle). Source coords are
    // OpenType +Y-up, so shearing before the Y-flip leans the glyph right.
    if (shearTan) x += y * shearTan;
    if (rotDeg) {
      const xr = c * x - si * y;
      const yr = si * x + c * y;
      x = xr;
      y = yr;
    }
    return [offX + x, offY - y];
  };
  const out = new Array(src.length);
  let write = 0,
    arcMatrix = null;
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    const first = write;
    if (s.type === SEG_LINE) out[write++] = mkLine(X(s.p1), X(s.p2));
    else if (s.type === SEG_QUAD) out[write++] = mkQuad(X(s.p1), X(s.p2), X(s.p3));
    else if (s.type === SEG_CUBIC) out[write++] = mkCubic(X(s.p1), X(s.p2), X(s.p3), X(s.p4));
    else if (s.type === SEG_ARC) {
      if (!arcMatrix)
        arcMatrix = [
          c * sx,
          -si * sx,
          (c * shearTan - si) * sy,
          -(si * shearTan + c) * sy,
          offX,
          offY,
        ];
      const pieces = [];
      transformSegInto(s, arcMatrix, pieces);
      for (const piece of pieces) out[write++] = piece;
    } else throw new TypeError('Unsupported glyph segment type: ' + s.type);
    if (s.subStart) out[first].subStart = true;
    if (s.openEnd) out[write - 1].openEnd = true;
    if (s.is_fill_only) for (let j = first; j < write; j++) out[j].is_fill_only = true;
  }
  out.length = write;
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
  for (const b of perGradient) {
    flat.set(b, off);
    off += b.length;
  }
  return {
    gradientStops: flat.buffer.slice(flat.byteOffset, flat.byteOffset + flat.byteLength),
    gradientStopsCount: total >>> 2, // total TEXELS (mixed 1-/2-texel strides)
  };
}

// Font outlines close geometrically; the fill normalizer needs explicit contour delimiters.
// These zero-length markers belong only to coverage preparation, never authored curves.
function markedFontFillSegments(segs) {
  const out = [];
  let start = null,
    previous = null;
  for (const seg of segs) {
    const end = seg.type === 0 ? seg.p2 : seg.type === 1 ? seg.p3 : seg.p4;
    if (!end) return null;
    if (seg.type === 0 && seg.p1[0] === end[0] && seg.p1[1] === end[1]) continue;
    if (start === null) start = seg.p1;
    else if (previous[0] !== seg.p1[0] || previous[1] !== seg.p1[1]) return null;
    out.push(seg);
    if (end[0] === start[0] && end[1] === start[1]) {
      out.push({ type: 0, p1: end, p2: end, is_fill_only: true });
      start = null;
    }
    previous = end;
  }
  return start === null && out.length ? out : null;
}

// `noopStatus` maps a glyph id of one font and variation instance to the fill-normalization status found when the
// glyph's outline needed no rewrite. An affine placement keeps contour topology, so every later placement of that
// glyph skips the certificate.
function pushShape(
  ctx,
  gidBox,
  bboxBox,
  segs,
  color,
  shapeId,
  colrGraphId = 0,
  colrMaskOnly = false,
  strokeWidthEm = 0,
  noopStatus = null,
  glyphId = 0,
) {
  const known = noopStatus ? noopStatus.get(glyphId) : undefined;
  const probe = noopStatus && known === undefined ? { status: undefined } : null;
  const opts = {
    fillRgba: color,
    shapeId,
    colrGraphId,
    normalizeFill: true,
    fillSegments: known === undefined ? markedFontFillSegments(segs) : null,
    fillNormNoop: known,
    fillNormProbe: probe,
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
  if (probe && probe.status !== undefined) noopStatus.set(glyphId, probe.status);
}

/// COLRv1 emit. Returns true when a v1 paint tree was emitted.
export function emitColrV1GlyphIfPresent(
  slot,
  slotFont,
  varCoords,
  ctx,
  gidBox,
  bboxBox,
  colrState,
  ox,
  oy,
  sx,
  sy,
  rotDeg,
  idx,
  cpHex,
) {
  if (!slotFont.hasColrV1) return false;
  const normalized =
    varCoords != null && slotFont.isVariable ? slotFont._normCoords(varCoords) : null;
  const v1 = slotFont.getColrV1GraphByGid(slot.glyphId, normalized);
  if (!v1 || !v1.glyphSegs || v1.glyphSegs.length === 0) return false;
  const slotInvUpem = slotFont.unitsPerEm > 0 ? 1 / slotFont.unitsPerEm : 0;
  const segs = transformAndFlip(v1.glyphSegs, ox, oy, sx, sy, rotDeg);
  // Paint transforms go to the leaves (see placeColrTransforms): the silhouettes below are emitted already placed.
  const placed = placeColrTransforms(v1.graph);
  v1.graph = placed.graph;
  // Normalize graph coordinates from font units to em-space so the
  // bbox-aware shaders see consistent units. Runs before
  // bakeColrGradients (which reads stops only; coordinates are
  // independent).
  normalizeColrCoords(v1.graph, slotInvUpem);
  // Bake gradient stops into the run-wide LUT before pushing the graph
  // entry — mutates node.params to carry (stopsOffset, stopsCount) and
  // drops the raw stops array. The COLR dispatch then reads from the
  // shared bundle texture (same as SVG gradients).
  bakeColrGradients(v1.graph, colrState.gradientStopsBytes, slot.style.color);
  // WHERE the graph is. Its coordinates stay in the glyph's design grid (normalized, y up); the glyph's
  // outline and masks went through transformAndFlip, and `placement` is that same map for the graph --
  // design grid -> bundle em, [xx, yx, xy, yy, dx, dy] -- so the renderer can put a gradient where the
  // glyph is. Without it the gradient's points would be read as bundle em, off the glyph and upside down.
  const upem = slotInvUpem > 0 ? 1 / slotInvUpem : 0;
  const rad = ((rotDeg || 0) * Math.PI) / 180,
    cr = Math.cos(rad),
    sr = Math.sin(rad);
  const placement = [cr * sx * upem, -sr * sx * upem, -sr * sy * upem, -cr * sy * upem, ox, oy];
  const graphEntry = { graph: v1.graph, masks: {}, placement };
  colrState.colrGraphs.push(graphEntry);
  const graphId = colrState.colrGraphs.length;
  // Primary shape carries the colored render op AND is mask 0 (used
  // when a PaintGlyph references the primary gid — the common
  // single-PaintGlyph case).
  const primaryShapeIdx = ctx.metas.length;
  graphEntry.masks[slot.glyphId] = primaryShapeIdx;
  pushShape(ctx, gidBox, bboxBox, segs, slot.style.color, `glyph_${idx}_u${cpHex}_colrv1`, graphId);
  // Mask-only shapes for the PaintGlyph silhouettes other than the primary
  // outline: each is emitted as a flagsShape=256 shape so the draw-list
  // builder skips its color op. The renderer collects them via the same
  // colrGraphId and the per-node mask key. A silhouette under a paint transform is emitted already
  // transformed, so it is also what the hit test and the bundle's bbox see.
  const maskRows = [];
  let primaryUsed = false;
  for (const m of placed.masks) {
    const base = m.clip
      ? clipBoxSegs(m.clip)
      : v1.glyphSegsByGid && v1.glyphSegsByGid.get(m.glyphId);
    if (!m.clip && !m.affine && m.glyphId === slot.glyphId) {
      primaryUsed = true;
      continue;
    }
    if (!base || base.length === 0) continue;
    const maskSegs = transformAndFlip(
      m.affine ? transformFontSegs(base, m.affine) : base,
      ox,
      oy,
      sx,
      sy,
      rotDeg,
    );
    const maskShapeIdx = ctx.metas.length;
    graphEntry.masks[m.key] = maskShapeIdx;
    // A clip box only limits the paint: it adds no ink to the bundle's bbox and answers no hit.
    if (!m.clip) maskRows.push(maskShapeIdx);
    pushShape(
      ctx,
      gidBox,
      m.clip ? null : bboxBox,
      maskSegs,
      [0, 0, 0, 1],
      `glyph_${idx}_u${cpHex}_mask_g${String(m.key).replace('#', 'x')}`,
      graphId,
      /*colrMaskOnly=*/ true,
    );
  }
  // What a pointer can hit: the silhouettes the paint graph clips by. The primary outline is the base glyph's own
  // (often a fallback box COLRv1 never draws), so it answers only when a PaintGlyph really uses it unplaced.
  if (colrState.hit) {
    for (const r of maskRows) colrState.hit.include.push(r, primaryShapeIdx);
    if (!primaryUsed) colrState.hit.exclude.push(primaryShapeIdx);
    // The ClipList boxes that cut a silhouette's paint cut its hits too: rows that answer only inside them, as alternatives.
    const alts = clipAlternatives(placed.graph);
    const rowOf = (key) => graphEntry.masks[key];
    const add = (row, key) => {
      const list = alts.get(key);
      if (row === undefined || !list || list.some((c) => c.length === 0)) return;
      const sets = [];
      for (const c of list) {
        const rows = c.map(rowOf);
        if (rows.some((r) => r === undefined)) return;
        sets.push(rows);
      }
      colrState.hit.clips.push(row, sets);
    };
    for (const m of placed.masks) if (!m.clip) add(rowOf(m.key), m.key);
  }
  return true;
}

/// COLRv0 emit. Returns true when color layers were emitted.
export function emitColrV0GlyphIfPresent(
  slot,
  slotFont,
  ctx,
  gidBox,
  bboxBox,
  ox,
  oy,
  sx,
  sy,
  rotDeg,
  idx,
  cpHex,
  varCoords = null,
) {
  const layers = slotFont.hasColor ? slotFont.getColoredGlyphByGid(slot.glyphId, varCoords) : null;
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
export function emitOutlineGlyph(
  ctx,
  gidBox,
  bboxBox,
  segs,
  color,
  shapeId,
  synthBoldSwEm = 0,
  noopStatus = null,
  glyphId = 0,
) {
  pushShape(
    ctx,
    gidBox,
    bboxBox,
    segs,
    color,
    shapeId,
    0 /* colrGraphId */,
    false /* colrMaskOnly */,
    synthBoldSwEm /* strokeWidthEm for synthetic bold */,
    noopStatus,
    glyphId,
  );
}
