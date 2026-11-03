// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { GlyphOutlineError } from '../glyphReader.js';

/// Graph nodes one glyph may produce. PaintColrGlyph shares too: a cycle check does not stop glyphs that each paint the next many times.
const MAX_COLR_GRAPH_NODES = 1 << 17;
// colrPaintToGraph.js — convert a parsed COLR v1 paint tree (from
// ColrReader.getPaint) into a filter-graph DAG matching the schema
// in ../../filterGraph/filterGraph.js.
//
// This is the bridge between the two architectural threads:
//   1. ColrReader produces a tree of `{ format, ...fields, child? }`
//      JS objects.
//   2. filterGraph.evaluateGraph takes a flat `{ nodes, rootOut }`
//      DAG where each node references inputs by index.
//
// The conversion is mechanical for transforms / composites / layers
// (one paint = one graph node), with two special cases:
//   - PaintColrGlyph (11): the referenced glyph's paint tree is
//     inlined via a recursive call to the converter, so the
//     resulting DAG has no cross-glyph references. (Tracking the
//     cycle-prevention set guards against pathological recursive
//     COLR tables.)
//   - Affine transform variants (12, 14, 16, 18, 20, 22, 24, 26, 28)
//     all collapse to a single 'PaintTransform' node carrying the
//     final 2×3 affine matrix [xx, yx, xy, yy, dx, dy]. The reader
//     emits each variant verbatim; the converter normalizes them.
//
function normalizeAffine(node) {
  switch (node.format) {
    case 12:
      return node.affine.slice();
    case 14:
      return [1, 0, 0, 1, node.dx, node.dy];
    case 16:
      return [node.sx, 0, 0, node.sy, 0, 0];
    case 18: {
      // scale around center: T(c) · S · T(-c)
      const { sx, sy, cx, cy } = node;
      return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
    }
    case 20:
      return [node.s, 0, 0, node.s, 0, 0];
    case 22: {
      // uniform scale around center: T(c) · S · T(-c)
      const { s, cx, cy } = node;
      return [s, 0, 0, s, cx - s * cx, cy - s * cy];
    }
    case 24: {
      // pure rotation about origin
      const a = (node.angleDeg * Math.PI) / 180;
      const c = Math.cos(a),
        s = Math.sin(a);
      return [c, s, -s, c, 0, 0];
    }
    case 26: {
      // rotate around center: T(c) · R · T(-c)
      const { angleDeg, cx, cy } = node;
      const a = (angleDeg * Math.PI) / 180;
      const c = Math.cos(a),
        s = Math.sin(a);
      return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
    }
    case 28: {
      // COLRv1 skew angles are counter-clockwise in the font's y-up space (OpenType COLR spec; fontTools
      // Paint.getTransform uses skew(-xSkew, ySkew); FreeType and Chrome agree): x' = x - tan(xSkew)*y,
      // y' = y + tan(ySkew)*x. A positive xSkew therefore leans the glyph LEFT. (SVG's skewX(a) is the
      // opposite for x, in a y-down space, so the SVG convention must not be reused here.)
      const tx = -Math.tan((node.skewXDeg * Math.PI) / 180);
      const ty = Math.tan((node.skewYDeg * Math.PI) / 180);
      return [1, ty, tx, 1, 0, 0];
    }
    case 30: {
      const { skewXDeg, skewYDeg, cx, cy } = node;
      const tx = -Math.tan((skewXDeg * Math.PI) / 180);
      const ty = Math.tan((skewYDeg * Math.PI) / 180);
      // T(c) · Skew · T(-c) →
      //   xx=1, yx=ty, xy=tx, yy=1
      //   dx = -tx*cy, dy = -ty*cx
      return [1, ty, tx, 1, -tx * cy, -ty * cx];
    }
    default:
      throw new Error(`normalizeAffine: not a transform format (${node.format})`);
  }
}

const TRANSFORM_FORMATS = new Set([12, 14, 16, 18, 20, 22, 24, 26, 28, 30]);

/// Convert a COLR v1 paint tree (or null) into a filter-graph DAG.
///
/// Inputs:
///   - paintTree: result of ColrReader.getPaint(gid), or null
///   - colrReader: the reader instance (needed to resolve PaintColrGlyph
///                 references by recursing into the referenced glyph's tree)
///
/// Returns: { nodes: [...], rootOut: int } | null
///
/// Node types emitted (the graph dispatch needs corresponding handlers
/// in filterGraphSvg.js / a parallel filterGraphColr.js dispatch):
///   'PaintSolid'           { rgba }                 — 0 inputs
///   'PaintLinearGradient'  { stops, p0, p1, p2, extend } — 0 inputs
///   'PaintRadialGradient'  { stops, c0, r0, c1, r1, extend } — 0 inputs
///   'PaintSweepGradient'   { stops, center, startAngle, endAngle, extend } — 0 inputs
///   'PaintGlyph'           { glyphId } or { clipBox: [xMin, yMin, xMax, yMax] } (a ClipList box) — 1 input (child paint)
///   'PaintMerge'           {}                       — N inputs (layer over-stack)
///   'PaintTransform'       { affine: [6 floats] }   — 1 input
///   'PaintComposite'       { mode }                 — 2 inputs (src, dst)
///
/// A color line as the stop LUT holds it: offsets in [0, 1], which is all the LUT stores and the only period its extend modes repeat over.
/// OpenType COLR defines the gradation over the interval from the least stop offset to the greatest, any interval ([-2, 2) in the
/// font, beyond that with variation deltas), and the extend mode takes over outside THAT interval, so a line that is not [0, 1]
/// has to be renormalized, with the gradient's geometry moved to match. Returns { stops, lo, hi } with the offsets of the input's
/// interval as lo and hi (the geometry's new ends), or null where the spec has nothing rendered: no stops, or all stops at one offset
/// under repeat or reflect. All stops at one offset under pad is two colors with a hard edge there, so an arbitrary unit interval
/// starting at it. A line already on [0, 1] comes back with its own stops.
export function colorLineInterval(stops, extend) {
  if (!stops || !stops.length) return null;
  const sorted = stops
    .map((s, i) => [s, i])
    .sort((a, b) => a[0].offset - b[0].offset || a[1] - b[1])
    .map((e) => e[0]);
  const lo = sorted[0].offset,
    last = sorted[sorted.length - 1].offset;
  if (last === lo && extend !== 0) return null;
  if (lo === 0 && last === 1) return { stops, lo: 0, hi: 1 };
  const hi = last === lo ? lo + 1 : last;
  return { stops: sorted.map((s) => ({ ...s, offset: (s.offset - lo) / (hi - lo) })), lo, hi };
}

/// OpenType COLR: "If either point p1 or p2 is the same as point p0, the gradient is ill-formed and must not be rendered", and likewise if
/// line p0p2 is parallel (or near-parallel, implementation-determined) to line p0p1. The test is the sine of the angle between them, so it
/// means the same at any font unit scale, and it holds both zero lengths.
function linearIllFormed(p0, p1, p2) {
  const ax = p1[0] - p0[0],
    ay = p1[1] - p0[1],
    bx = p2[0] - p0[0],
    by = p2[1] - p0[1];
  return Math.abs(ax * by - ay * bx) <= 1e-6 * Math.hypot(ax, ay) * Math.hypot(bx, by);
}

/// Cycle prevention: PaintColrGlyph(gid=X) referenced while X is
/// already on the conversion stack returns a placeholder Solid(0,0,0,0)
/// to break the cycle. Spec-conformant fonts don't do this, but
/// malformed ones might.
export function colrPaintToGraph(paintTree, colrReader, coords = null, rootGlyphId = null) {
  if (!paintTree) return null;
  const nodes = [];
  const cycleStack = new Set();

  function emit(type, params, inputs) {
    const idx = nodes.length;
    if (idx >= MAX_COLR_GRAPH_NODES)
      throw new GlyphOutlineError(
        `COLR paint graph exceeds its budget (${MAX_COLR_GRAPH_NODES} nodes)`,
      );
    nodes.push({ type, inputs: inputs || [], params: params || {} });
    return idx;
  }

  /// A glyph's ClipList box clips that glyph's paint (the base glyph at the root, and a glyph reached through
  /// PaintColrGlyph, in the coordinate system the reference is painted in; nested boxes all apply, as HarfBuzz's
  /// paint callbacks push them). The box becomes a PaintGlyph over a rectangular silhouette ({ clipBox } instead of a
  /// glyphId); font/textColrEmit.js places and emits it like any other PaintGlyph outline. An empty box clips
  /// everything.
  function clipped(glyphId, idx) {
    const box =
      glyphId != null && colrReader.getClipBox ? colrReader.getClipBox(glyphId, coords) : null;
    if (!box) return idx;
    if (!(box[2] > box[0] && box[3] > box[1])) return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
    return emit('PaintGlyph', { clipBox: box }, [idx]);
  }

  function convert(p) {
    if (!p || p.unsupported) {
      // Unsupported format → transparent placeholder, so the rest of
      // the tree still renders.
      return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
    }
    switch (p.format) {
      case 1: {
        // PaintColrLayers — over-stack of N children, bottom-first.
        // Maps to a multi-input PaintMerge node.
        const childIdxs = p.layers.map(convert);
        return emit('PaintMerge', {}, childIdxs);
      }
      case 2: {
        // PaintSolid. rgba is null for the foreground-color sentinel;
        // pass that through so the renderer can substitute the run's
        // primary color.
        return emit('PaintSolid', {
          rgba: p.rgba,
          isForeground: p.paletteIndex === 0xffff,
        });
      }
      case 4: {
        const line = colorLineInterval(p.stops, p.extend);
        if (!line || linearIllFormed(p.p0, p.p1, p.p2))
          return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
        // Offsets t = lo and t = hi of the color line become 0 and 1; p2 only sets the gradient's direction, so it moves with p0.
        const dx = p.p1[0] - p.p0[0],
          dy = p.p1[1] - p.p0[1];
        const at = (t) => [p.p0[0] + t * dx, p.p0[1] + t * dy];
        return emit('PaintLinearGradient', {
          stops: line.stops,
          p0: at(line.lo),
          p1: at(line.hi),
          p2: [p.p2[0] + line.lo * dx, p.p2[1] + line.lo * dy],
          extend: p.extend,
        });
      }
      case 6: {
        const line = colorLineInterval(p.stops, p.extend);
        if (!line) return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
        // circle(t) is linear in t, so the interval's two ends are circles of the same family (a negative radius included: the
        // shader's r(t) >= 0 test keeps its meaning).
        const c = (t) => [p.c0[0] + t * (p.c1[0] - p.c0[0]), p.c0[1] + t * (p.c1[1] - p.c0[1])];
        const r = (t) => p.r0 + t * (p.r1 - p.r0);
        return emit('PaintRadialGradient', {
          stops: line.stops,
          c0: c(line.lo),
          r0: r(line.lo),
          c1: c(line.hi),
          r1: r(line.hi),
          extend: p.extend,
        });
      }
      case 8: {
        const line = colorLineInterval(p.stops, p.extend);
        // OpenType COLR: "If the color line's extend mode is reflect or repeat and start and end angle are equal, nothing shall be drawn."
        if (!line || (p.extend !== 0 && p.startAngle === p.endAngle))
          return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
        const a = (t) => p.startAngle + t * (p.endAngle - p.startAngle);
        return emit('PaintSweepGradient', {
          stops: line.stops,
          center: p.center,
          startAngle: a(line.lo),
          endAngle: a(line.hi),
          extend: p.extend,
        });
      }
      case 10: {
        // PaintGlyph — clip child to glyph silhouette.
        const childIdx = convert(p.child);
        return emit('PaintGlyph', { glyphId: p.glyphId }, [childIdx]);
      }
      case 11: {
        if (cycleStack.has(p.glyphId)) {
          return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
        }
        const subTree = colrReader.getPaint(p.glyphId, coords);
        if (!subTree) {
          // Missing target glyph → transparent.
          return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
        }
        cycleStack.add(p.glyphId);
        const idx = convert(subTree);
        cycleStack.delete(p.glyphId);
        return clipped(p.glyphId, idx);
      }
      case 32: {
        const srcIdx = convert(p.src);
        const dstIdx = convert(p.dst);
        return emit('PaintComposite', { mode: p.mode }, [srcIdx, dstIdx]);
      }
      default:
        if (TRANSFORM_FORMATS.has(p.format)) {
          const childIdx = convert(p.child);
          return emit('PaintTransform', { affine: normalizeAffine(p) }, [childIdx]);
        }
        // Unhandled format (variable-axis Var* variants, etc.) →
        // emit a transparent placeholder.
        return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
    }
  }

  const rootOut = clipped(rootGlyphId, convert(paintTree));
  return { nodes, rootOut };
}
