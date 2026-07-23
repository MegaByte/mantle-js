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
//     emits each variant verbatim; the converter normalises them.
//
// Source sentinels used by the SVG dispatch (-1..-6 for SourceGraphic
// etc.) are NOT used here — COLRv1 paint trees are self-contained
// from PaintGlyph leaves. The graph evaluator's `inputs` array uses
// only positive indices into earlier nodes.

/// Build a normalised 6-float affine matrix [xx, yx, xy, yy, dx, dy]
/// from a COLR transform paint node. Per the spec all variants
/// (Transform, Translate, Scale, ScaleUniform, ScaleAroundCenter,
/// Rotate, RotateAroundCenter, Skew, SkewAroundCenter) collapse to a
/// 2×3 affine; the converter normalises so the renderer only handles
/// one node type.
function normalizeAffine(node) {
  switch (node.format) {
    case 12: return node.affine.slice();
    case 14: return [1, 0, 0, 1, node.dx, node.dy];
    case 16: return [node.sx, 0, 0, node.sy, 0, 0];
    case 18: {
      // scale around center: T(c) · S · T(-c)
      const { sx, sy, cx, cy } = node;
      return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
    }
    case 20: return [node.s,  0, 0, node.s,  0, 0];
    case 22: {
      // uniform scale around center: T(c) · S · T(-c)
      const { s, cx, cy } = node;
      return [s, 0, 0, s, cx - s * cx, cy - s * cy];
    }
    case 24: {
      // pure rotation about origin
      const a = node.angleDeg * Math.PI / 180;
      const c = Math.cos(a), s = Math.sin(a);
      return [c, s, -s, c, 0, 0];
    }
    case 26: {
      // rotate around center: T(c) · R · T(-c)
      const { angleDeg, cx, cy } = node;
      const a = angleDeg * Math.PI / 180;
      const c = Math.cos(a), s = Math.sin(a);
      return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
    }
    case 28: {
      // skew about origin: [1, tan(yDeg), tan(xDeg), 1, 0, 0]
      // (note SVG's skew convention: skewXDeg shifts X by tan(deg)·y;
      // matrix column is [1, tan(yDeg); tan(xDeg), 1])
      const tx = Math.tan(node.skewXDeg * Math.PI / 180);
      const ty = Math.tan(node.skewYDeg * Math.PI / 180);
      return [1, ty, tx, 1, 0, 0];
    }
    case 30: {
      const { skewXDeg, skewYDeg, cx, cy } = node;
      const tx = Math.tan(skewXDeg * Math.PI / 180);
      const ty = Math.tan(skewYDeg * Math.PI / 180);
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
///   'PaintGlyph'           { glyphId }              — 1 input (child paint)
///   'PaintMerge'           {}                       — N inputs (layer over-stack)
///   'PaintTransform'       { affine: [6 floats] }   — 1 input
///   'PaintComposite'       { mode }                 — 2 inputs (src, dst)
///
/// Cycle prevention: PaintColrGlyph(gid=X) referenced while X is
/// already on the conversion stack returns a placeholder Solid(0,0,0,0)
/// to break the cycle. Spec-conformant fonts don't do this, but
/// malformed ones might.
export function colrPaintToGraph(paintTree, colrReader, coords = null) {
  if (!paintTree) return null;
  const nodes = [];
  const cycleStack = new Set();

  function emit(type, params, inputs) {
    const idx = nodes.length;
    nodes.push({ type, inputs: inputs || [], params: params || {} });
    return idx;
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
          isForeground: p.paletteIndex === 0xFFFF,
        });
      }
      case 4:
        return emit('PaintLinearGradient', {
          stops: p.stops, p0: p.p0, p1: p.p1, p2: p.p2, extend: p.extend,
        });
      case 6:
        return emit('PaintRadialGradient', {
          stops: p.stops,
          c0: p.c0, r0: p.r0, c1: p.c1, r1: p.r1, extend: p.extend,
        });
      case 8:
        return emit('PaintSweepGradient', {
          stops: p.stops,
          center: p.center, startAngle: p.startAngle, endAngle: p.endAngle,
          extend: p.extend,
        });
      case 10: {
        // PaintGlyph — clip child to glyph silhouette.
        const childIdx = convert(p.child);
        return emit('PaintGlyph', { glyphId: p.glyphId }, [childIdx]);
      }
      case 11: {
        // PaintColrGlyph — recurse into the referenced glyph's tree.
        // Cycle guard: if we're already converting this glyph upstream,
        // bail with a transparent placeholder.
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
        return idx;
      }
      case 32: {
        const srcIdx = convert(p.src);
        const dstIdx = convert(p.dst);
        return emit('PaintComposite', { mode: p.mode }, [srcIdx, dstIdx]);
      }
      default:
        if (TRANSFORM_FORMATS.has(p.format)) {
          const childIdx = convert(p.child);
          return emit('PaintTransform',
                      { affine: normalizeAffine(p) },
                      [childIdx]);
        }
        // Unhandled format (variable-axis Var* variants, etc.) →
        // emit a transparent placeholder.
        return emit('PaintSolid', { rgba: [0, 0, 0, 0] });
    }
  }

  const rootOut = convert(paintTree);
  return { nodes, rootOut };
}
