// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
//     inputs. Bbox is the SOURCE bbox (for an SVG generator, the filter
//     region when the caller gives one); they fill the output area
//     uniformly and the silhouette clip happens at composite time.
//
//   PaintMerge / feMerge — union of all input bboxes.
//
//   PaintComposite — union for every binary node. The over-
//     approximation is never incorrect, occasionally larger than
//     necessary (in/mask modes could intersect).
//
//   feComposite — by operator: `in` the intersection of its inputs (when the caller gave the
//     filter region), `out` its first, `atop` its second, the rest their union; an arithmetic
//     k4 > 0 paints everywhere.
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
//   feConvolveMatrix — child bbox dilated by the kernel's reach, which is
//     asymmetric when targetX/targetY move the kernel off center; see
//     convolveReach. Equals floor(order/2) for a centerd kernel.
//
//   feOffset — child bbox shifted by (dx, dy).
//
//   feTile — full canvas (tiles fill everywhere).
//
//   feDisplacementMap — child bbox dilated by scale/2 (worst-case
//     displacement amplitude).
//
//   feLighting (Diffuse / Specular) — full canvas (the lit surface is
//     painted over the whole subregion; the region bounds it).
//
//   feColorMatrix — child bbox unchanged (color-only). A matrix with a
//     non-zero offset column produces non-zero outside the silhouette,
//     but premultiplication handling produces α=0 there, so the bbox
//     stays valid.

import { affInv, affBox } from './affine2d.js';

/// Compute per-node output bboxes. Returns:
///   { bboxes: [{x,y,w,h}], rootBbox: {x,y,w,h} }
///
/// `graph` is the DAG (filterGraph.js schema).
/// `sourceBbox` is the source shape's bounding rect in canvas pixels.
///   For SVG filters: the shape's rendered bbox.
///   For COLRv1: the glyph's bbox after layout transformation.
/// `canvasW`, `canvasH` clamp the result so no bbox extends past
///   the framebuffer.
/// `generatorBbox` (optional) is where an SVG generator with no stated subregion (feFlood, feTurbulence, feImage) paints: the filter
///   region in canvas pixels (Filter Effects 1 §15.3). Without one it is the source's box.
export function computeNodeBboxes(graph, sourceBbox, canvasW, canvasH, generatorBbox = null) {
  const n = graph.nodes.length;
  const bboxes = new Array(n);
  for (let i = 0; i < n; i++) {
    bboxes[i] = nodeBbox(graph.nodes[i], i, bboxes, sourceBbox, canvasW, canvasH, generatorBbox);
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

/// How far an feConvolveMatrix output reaches past its input, on one axis.
///
/// The shader samples in[x + i - target] for i in 0..order-1 (SVG 1.1
/// §15.10, and convolve.frag.glsl), so an input pixel affects outputs from
/// (order-1-target) below it to (target) above it. The reach is therefore
/// ASYMMETRIC whenever target is not the center, and dilating by a symmetric
/// floor(order/2) would undersize the RT and truncate the output at its edge.
///
/// The larger of the two sides is used for both, which costs at most a few
/// pixels (order is capped at 5) and cannot be wrong in either direction.
/// For the default target of floor(order/2) this is exactly floor(order/2),
/// so centered kernels — every kernel that does not set targetX/targetY —
/// allocate precisely the symmetric reach.
export function convolveReach(order, target) {
  const n = Math.max(1, order | 0);
  // Out-of-range targets are an error in the spec; clamp so a malformed
  // filter allocates a sane RT rather than one scaled by a garbage index.
  const t = Math.min(n - 1, Math.max(0, target == null ? Math.floor(n / 2) : target | 0));
  return Math.max(t, n - 1 - t);
}

function offsetBbox(b, dx, dy) {
  return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
}

function transformBbox(b, affine) {
  const [xx, yx, xy, yy, dx, dy] = affine;
  // Four corners of the input bbox.
  const corners = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
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

function resolveInputBbox(inputIdx, bboxes, sourceBbox, canvasW, canvasH) {
  if (inputIdx === -5 || inputIdx === -6) return { x: 0, y: 0, w: canvasW, h: canvasH };
  if (inputIdx >= 0) return bboxes[inputIdx];
  // Source sentinels (-1..-6, see filterGraph.js). All resolve to
  // sourceBbox for bbox purposes — the actual sample values differ
  // (RGB vs alpha-only, source vs backdrop) but the bbox is the same.
  return sourceBbox;
}

/// Where an feComposite can be non-zero, from where its two inputs can. `in` needs both, and only when a generator's box is the real one
/// (`bounded`: the filter region) may the intersection stand: otherwise the source's box stands in for a flood and would cut what it floods.
function compositeBbox(p, a, b, bounded, canvasW, canvasH) {
  switch (p ? p.op | 0 : 0) {
    case 1: {
      // in: a * alpha(b)
      if (!bounded) return unionBbox(a, b);
      const x = Math.max(a.x, b.x),
        y = Math.max(a.y, b.y);
      return {
        x,
        y,
        w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
        h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
      };
    }
    case 2:
      return a; // out: a * (1 - alpha(b))
    case 3:
      return b; // atop: a * alpha(b) + b * (1 - alpha(a))
    case 5: // arithmetic: k4 is added to transparent input too, so it paints throughout the primitive's region
      if (p.k && p.k[3] > 0) return { x: 0, y: 0, w: canvasW, h: canvasH };
      return unionBbox(a, b);
    default:
      return unionBbox(a, b);
  }
}

function nodeBbox(node, idx, bboxes, sourceBbox, canvasW, canvasH, generatorBbox) {
  const inputBbox = (i) =>
    resolveInputBbox(node.inputs[i] | 0, bboxes, sourceBbox, canvasW, canvasH);
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
      // A generator is bounded by the source box -- except an external feImage placed in a subregion
      // the renderer resolved (params.subregionPx, filterDraw.js _feImagePlacements), which is where it
      // paints, however far from the shape that is.
      raw =
        (node.type === 'feImage' && node.params && node.params.subregionPx) ||
        (node.type.startsWith('fe') && generatorBbox) ||
        sourceBbox;
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

    case 'feComposite':
      raw = compositeBbox(
        node.params,
        inputBbox(0),
        inputBbox(1),
        !!generatorBbox,
        canvasW,
        canvasH,
      );
      break;

    case 'PaintComposite':
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
      // A positive alpha offset paints transparent input throughout the
      // primitive's region, including beyond SourceGraphic's geometry.
      raw = node.params?.matrix?.[19] > 0 ? { x: 0, y: 0, w: canvasW, h: canvasH } : inputBbox(0);
      break;

    case 'feComponentTransfer': {
      // An alpha function with f(0) > 0 (a one-value table is the constant that makes it so) paints
      // transparent input throughout the primitive's region, like a positive alpha offset.
      const lut = node.params && node.params.lutBytes;
      raw =
        lut && lut.length >= 4 * 256 * 4 && lut[3 * 256 * 4] > 0
          ? { x: 0, y: 0, w: canvasW, h: canvasH }
          : inputBbox(0);
      break;
    }

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
      raw =
        node.inputs[0] === -5 || node.inputs[0] === -6
          ? { x: 0, y: 0, w: canvasW, h: canvasH }
          : offsetBbox(inputBbox(0), p.dx || 0, p.dy || 0);
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
        raw = dilateBbox(inputBbox(0), Math.ceil(p.radiusX || 0), Math.ceil(p.radiusY || 0));
      } else {
        raw = inputBbox(0);
      }
      break;
    }

    case 'feConvolveMatrix': {
      const p = node.params || {};
      raw = dilateBbox(
        inputBbox(0),
        convolveReach(p.orderX, p.targetX),
        convolveReach(p.orderY, p.targetY),
      );
      break;
    }

    case 'feDisplacementMap': {
      const p = node.params || {};
      // A negative scale displaces the other way, just as far.
      const r = Math.ceil(Math.abs(p.scale || 0) / 2);
      raw = dilateBbox(inputBbox(0), r, r);
      break;
    }

    case 'feSpecularLighting':
    case 'feDiffuseLighting':
      // The lit surface is painted over the whole primitive subregion, wherever the input is transparent: a diffuse result is opaque (Filter
      // Effects 1: alpha 1), and a specular highlight (alpha = its largest channel) lies wherever the light puts it. The filter region (or a
      // stated subregion) bounds it, as it bounds a flood.
      raw = { x: 0, y: 0, w: canvasW, h: canvasH };
      break;

    default:
      // Unknown node type: pass through the first input's bbox if
      // present, else sourceBbox.
      raw = node.inputs.length > 0 ? inputBbox(0) : sourceBbox;
      break;
  }
  // A primitive subregion the renderer resolved (filterDraw.js _primSubs, params.subregionPx, top-left px): nothing is painted outside it.
  // A generator (feFlood, feTurbulence) and feTile fill it, however far from the shape it lies; any other primitive can only be
  // narrowed by it. (An external feImage took its subregion above.)
  const sp = node.params && node.params.subregionPx;
  if (sp && node.type !== 'feImage') {
    if (node.inputs.length === 0 || node.type === 'feTile') raw = sp;
    else {
      const x0 = Math.max(raw.x, sp.x),
        y0 = Math.max(raw.y, sp.y);
      const x1 = Math.min(raw.x + raw.w, sp.x + sp.w),
        y1 = Math.min(raw.y + raw.h, sp.y + sp.h);
      raw =
        x1 > x0 && y1 > y0
          ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
          : { x: x0, y: y0, w: 0, h: 0 };
    }
  }
  return clamp(raw, canvasW, canvasH);
}

/// The canvas box each node of a COLRv1 PAINT graph must cover when every node renders into a target of
/// its own (top-left canvas px, float; {w: 0} = nothing needed). The renderer's COLR leaf sizes the
/// node targets to these, so a glyph's graph shades the glyph's pixels rather than the canvas.
///
/// computeNodeBboxes is the wrong bound here, twice over. It bounds a generator (a solid or a gradient)
/// by the SOURCE box, but a generator is unbounded, and what it must cover is whatever its consumers read
/// -- for a PaintTransform, the PREIMAGE of the transform's region, which a rotation or a translation
/// moves off the source box. And it bounds a PaintGlyph by its child, where the true bound is the glyph
/// it clips by, which need not be the primary glyph the source box describes.
///
/// So two passes. Bottom-up, where each node's output CAN be non-zero (null = anywhere):
///   generators            -> anywhere
///   PaintGlyph            -> its glyph's box (grown 1 px for the silhouette's AA), within its child's
///   PaintTransform        -> its child's bound, mapped
///   PaintMerge/Composite  -> the union of its inputs' (anywhere if any is)
/// Top-down, which pixels each node's consumers READ: the root's is its bound within the canvas; a
/// pointwise consumer reads its own region, a PaintTransform reads the preimage of its region (grown 1
/// px for the bilinear tap). A node's box is the second within the first.
///
/// A node that no consumer reads comes back empty. Everything a consumer samples outside its input's
/// box reads transparent (sampleIn), and inside the region it NEEDS the box covers it, so the answer is
/// the canvas-sized graph's there.
///
///   opts.canvasW, opts.canvasH  the canvas
///   opts.affineOf(i)            node i's PaintTransform affine IN CANVAS PX (the renderer conjugates it)
///   opts.glyphBoxOf(gid)        the canvas box of the silhouette PaintGlyph(gid) clips by, or null
export function colrNodeBoxes(graph, opts) {
  const { canvasW, canvasH } = opts;
  const nodes = graph.nodes,
    n = nodes.length;
  const EMPTY = { x: 0, y: 0, w: 0, h: 0 };
  const isEmpty = (b) => !b || !(b.w > 0) || !(b.h > 0);
  const inter = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const x = Math.max(a.x, b.x),
      y = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w),
      y1 = Math.min(a.y + a.h, b.y + b.h);
    return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : EMPTY;
  };
  const union = (a, b) => (isEmpty(a) ? b : isEmpty(b) ? a : unionBbox(a, b));
  const grow = (b, d) => (isEmpty(b) ? b : dilateBbox(b, d, d));
  const affine = (i) =>
    (opts.affineOf && opts.affineOf(i)) || (nodes[i].params && nodes[i].params.affine) || null;
  // Bottom-up: where the output can be non-zero.
  const can = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    const inp = (k) => {
      const j = nd.inputs[k];
      return j >= 0 && j < i ? can[j] : null;
    };
    switch (nd.type) {
      case 'PaintSolid':
      case 'PaintLinearGradient':
      case 'PaintRadialGradient':
      case 'PaintSweepGradient':
        can[i] = null;
        break;
      case 'PaintGlyph': {
        const g = opts.glyphBoxOf
          ? opts.glyphBoxOf(
              nd.params && (nd.params.maskKey != null ? nd.params.maskKey : nd.params.glyphId),
            )
          : null;
        can[i] = inter(g ? grow(g, 1) : null, nd.inputs.length ? inp(0) : null);
        break;
      }
      case 'PaintTransform': {
        const c = nd.inputs.length ? inp(0) : null,
          m = affine(i);
        can[i] = c && m ? (isEmpty(c) ? EMPTY : affBox(m, c)) : c;
        break;
      }
      case 'PaintMerge':
      case 'PaintComposite': {
        let u = EMPTY;
        for (let k = 0; k < nd.inputs.length; k++) {
          const c = inp(k);
          if (!c) {
            u = null;
            break;
          }
          u = union(u, c);
        }
        can[i] = u;
        break;
      }
      default:
        can[i] = nd.inputs.length ? inp(0) : null;
    }
  }
  // Top-down: what each node's consumers read.
  const canvas = { x: 0, y: 0, w: canvasW, h: canvasH };
  const need = new Array(n).fill(EMPTY);
  const root = graph.rootOut;
  if (root >= 0 && root < n) need[root] = inter(canvas, can[root]);
  for (let i = n - 1; i >= 0; i--) {
    const N = need[i];
    if (isEmpty(N)) continue;
    const nd = nodes[i];
    let read = N;
    if (nd.type === 'PaintTransform') {
      const m = affine(i),
        mi = m && affInv(m);
      // A singular transform draws nothing (the shader returns transparent); it reads nothing.
      read = mi ? grow(affBox(mi, N), 1) : EMPTY;
    }
    for (const j of nd.inputs) if (j >= 0 && j < i) need[j] = union(need[j], read);
  }
  return nodes.map((_, i) => {
    const b = inter(inter(need[i], can[i]), canvas);
    return isEmpty(b) ? EMPTY : b;
  });
}
