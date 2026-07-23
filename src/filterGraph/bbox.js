// bbox.js — bbox propagation for filter-graph DAGs.
//
// Given a graph (filterGraph.js schema) + the source shape's bbox,
// computes the output bbox for every node in topological order. The
// renderer sizes each node's RT to the propagated bbox rather than to
// the full canvas, reducing fillrate for small shapes on large canvases
// (e.g. 32px COLRv1 glyphs on 1024px canvases).
//
// Output: { bboxes: [{x,y,w,h}, ...], rootBbox }. Each bboxes[i]
// corresponds to graph.nodes[i].
//
// Bbox semantics:
//   - x, y, w, h in canvas pixels.
//   - The "output bbox" is the pixel region whose values can be
//     non-zero in the node's output RT. Pixels outside are guaranteed
//     transparent.
//   - All bboxes are CLAMPED to the canvas (no negative coords, no
//     overrun). Filters that conceptually extend past the canvas (a
//     100σ blur on a corner shape) get truncated to the canvas edge,
//     matching browser behavior.
//
// Per-node semantics:
//
//   PaintSolid / PaintLinearGradient / PaintRadialGradient /
//   PaintSweepGradient / feFlood / feTurbulence — generators with no
//     inputs. Bbox is the SOURCE bbox; they fill the output area
//     uniformly and the silhouette clip happens at composite time.
//
//   PaintMerge / feMerge — union of all input bboxes.
//
//   PaintComposite — union for every binary node. The over-
//     approximation is never incorrect, occasionally larger than
//     necessary (in/mask modes could intersect).
//
//   PaintGlyph — clip child by glyph alpha; bbox is the intersection
//     of child and glyph bbox. Without glyph metrics here, uses child
//     bbox conservatively.
//
//   PaintTransform — child bbox transformed by the affine matrix:
//     bounding rect of the 4 transformed corners, clamped to canvas.
//
//   feGaussianBlur — child bbox dilated by ceil(3σ) on each axis.
//
//   feMorphology dilate — child bbox dilated by radius.
//   feMorphology erode — child bbox UNCHANGED (alpha can only shrink).
//
//   feConvolveMatrix — child bbox dilated by floor(order/2).
//
//   feOffset — child bbox shifted by (dx, dy).
//
//   feTile — full canvas (tiles fill everywhere).
//
//   feDisplacementMap — child bbox dilated by scale/2 (worst-case
//     displacement amplitude).
//
//   feLighting (Diffuse / Specular) — child bbox dilated by 1 (Sobel
//     kernel reach).
//
//   feColorMatrix — child bbox unchanged (color-only). A matrix with a
//     non-zero offset column produces non-zero outside the silhouette,
//     but premultiplication handling produces α=0 there, so the bbox
//     stays valid.

/// Compute per-node output bboxes. Returns:
///   { bboxes: [{x,y,w,h}], rootBbox: {x,y,w,h} }
///
/// `graph` is the DAG (filterGraph.js schema).
/// `sourceBbox` is the source shape's bounding rect in canvas pixels.
///   For SVG filters: the shape's rendered bbox.
///   For COLRv1: the glyph's bbox after layout transformation.
/// `canvasW`, `canvasH` clamp the result so no bbox extends past
///   the framebuffer.
export function computeNodeBboxes(graph, sourceBbox, canvasW, canvasH) {
  const n = graph.nodes.length;
  const bboxes = new Array(n);
  for (let i = 0; i < n; i++) {
    bboxes[i] = nodeBbox(graph.nodes[i], i, bboxes, sourceBbox, canvasW, canvasH);
  }
  const rootBbox = bboxes[graph.rootOut] || sourceBbox;
  return { bboxes, rootBbox };
}

function clamp(r, w, h) {
  let x = Math.max(0, Math.floor(r.x));
  let y = Math.max(0, Math.floor(r.y));
  let x1 = Math.min(w, Math.ceil(r.x + r.w));
  let y1 = Math.min(h, Math.ceil(r.y + r.h));
  if (x1 <= x || y1 <= y) return { x, y, w: 0, h: 0 };
  return { x, y, w: x1 - x, h: y1 - y };
}

function unionBbox(a, b) {
  if (a.w === 0 || a.h === 0) return b;
  if (b.w === 0 || b.h === 0) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x1 - x, h: y1 - y };
}

function dilateBbox(b, dx, dy) {
  return { x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy };
}

function offsetBbox(b, dx, dy) {
  return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
}

function transformBbox(b, affine) {
  const [xx, yx, xy, yy, dx, dy] = affine;
  // Four corners of the input bbox.
  const corners = [
    [b.x,         b.y],
    [b.x + b.w,   b.y],
    [b.x,         b.y + b.h],
    [b.x + b.w,   b.y + b.h],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [cx, cy] of corners) {
    const tx = xx * cx + xy * cy + dx;
    const ty = yx * cx + yy * cy + dy;
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function resolveInputBbox(inputIdx, bboxes, sourceBbox) {
  if (inputIdx >= 0) return bboxes[inputIdx];
  // Source sentinels (-1..-6, see filterGraph.js). All resolve to
  // sourceBbox for bbox purposes — the actual sample values differ
  // (RGB vs alpha-only, source vs backdrop) but the bbox is the same.
  return sourceBbox;
}

function nodeBbox(node, idx, bboxes, sourceBbox, canvasW, canvasH) {
  const inputBbox = (i) => resolveInputBbox(node.inputs[i] | 0, bboxes, sourceBbox);
  let raw;
  switch (node.type) {
    // --- Generators (0 inputs) ---
    case 'PaintSolid':
    case 'PaintLinearGradient':
    case 'PaintRadialGradient':
    case 'PaintSweepGradient':
    case 'feFlood':
    case 'feTurbulence':
    case 'feImage':
      // feImage emits into the filter region; conservative = sourceBbox.
      raw = sourceBbox;
      break;

    // --- N-ary union ---
    case 'PaintMerge':
    case 'feMerge': {
      raw = { x: 0, y: 0, w: 0, h: 0 };
      for (let i = 0; i < node.inputs.length; i++) {
        raw = unionBbox(raw, inputBbox(i));
      }
      if (raw.w === 0) raw = sourceBbox;
      break;
    }

    case 'PaintComposite':
    case 'feComposite':
    case 'feBlend':
      // Conservative: union of both inputs. Some operators (in / mask)
      // could use intersection, but union is conservative and may over-allocate.
      raw = unionBbox(inputBbox(0), inputBbox(1));
      break;

    // --- 1-input passthrough / clip / color ---
    case 'PaintGlyph':
      // Conservative: child bbox. Refining with actual glyph bbox
      // requires a per-glyph lookup callback (TextRun integration).
      raw = inputBbox(0);
      break;

    case 'feColorMatrix':
      raw = inputBbox(0);
      break;

    case 'feTile':
      // Tile fills the entire canvas (post-spec subregions land later).
      raw = { x: 0, y: 0, w: canvasW, h: canvasH };
      break;

    // --- 1-input geometric transforms ---
    case 'PaintTransform': {
      const m = node.params && node.params.affine;
      raw = m ? transformBbox(inputBbox(0), m) : inputBbox(0);
      break;
    }

    case 'feOffset': {
      const p = node.params || {};
      raw = offsetBbox(inputBbox(0), p.dx || 0, p.dy || 0);
      break;
    }

    // --- 1-input spatial filters (dilate child bbox) ---
    case 'feGaussianBlur': {
      const p = node.params || {};
      // ±3σ kernel reach; round up.
      const dx = Math.ceil(3 * Math.max(0, p.sigmaX || 0));
      const dy = Math.ceil(3 * Math.max(0, p.sigmaY || 0));
      raw = dilateBbox(inputBbox(0), dx, dy);
      break;
    }

    case 'feMorphology': {
      const p = node.params || {};
      if ((p.operator | 0) === 1) {
        // dilate: bbox grows
        raw = dilateBbox(inputBbox(0),
                         Math.ceil(p.radiusX || 0),
                         Math.ceil(p.radiusY || 0));
      } else {
        // erode: bbox shrinks but never larger than input; for safety
        // we keep the input bbox (the erosion just clears some pixels
        // in-place).
        raw = inputBbox(0);
      }
      break;
    }

    case 'feConvolveMatrix': {
      const p = node.params || {};
      const ox = Math.floor((p.orderX || 3) / 2);
      const oy = Math.floor((p.orderY || 3) / 2);
      raw = dilateBbox(inputBbox(0), ox, oy);
      break;
    }

    case 'feDisplacementMap': {
      const p = node.params || {};
      const r = Math.ceil((p.scale || 0) / 2);
      raw = dilateBbox(inputBbox(0), r, r);
      break;
    }

    case 'feSpecularLighting':
    case 'feDiffuseLighting':
      // Sobel kernel reach = 1.
      raw = dilateBbox(inputBbox(0), 1, 1);
      break;

    default:
      // Unknown node type: pass through the first input's bbox if
      // present, else sourceBbox.
      raw = node.inputs.length > 0 ? inputBbox(0) : sourceBbox;
      break;
  }
  return clamp(raw, canvasW, canvasH);
}
