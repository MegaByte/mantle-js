// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { sampleMorphGradientParams } from '../core/morphImageFrames.js';
import { sampleMorphPose as morphHitPose } from '../core/morphPose.js';
import { unwrapBundle } from '../core/unwrapBundle.js';
import { paintHitBits } from '../svg/hitBits.js';
import { nineSliceNativePoint } from '../renderer/nineSlice.js';
import { checkedSpriteBounds, ownSpriteRange } from '../core/spriteRange.js';
// hitTest.js — point-in-shape queries against a Mantle bundle.

// Coverage / Outline test the bundle's native curve geometry analytically —
// no flattening/tessellation, matching the renderer's contract (ray-cast the
// true quad/cubic/arc; arcs preserved end-to-end). Fill = exact signed
// ray-crossings (roots of curve_y = ray_y); stroke = exact min point→curve
// distance (critical points = roots of d/dt|curve−P|²). Root-finding reuses
// the path-boolean solvers.

import {
  curveView,
  curveRangesOf,
  decodeSegs,
  dashView,
  emPerPxOf,
  pointOnStroke,
  closest,
  strokeFrameSegs,
} from './curveGeom.js';
import {
  FS_STROKE_LOCAL,
  FS_GROUP_BEGIN,
  FS_GROUP_END,
  FS_LAYER,
  FS_HIDDEN,
  FS_MASK_BEGIN,
  FS_MASK_END,
  META_SOLID_START,
  META_CLIP_ID,
  META_MASK_ID,
  META_ISOLATION,
  META_IMAGE_ID,
  META_IMAGE_RECT_X,
  META_ATLAS_Y,
  META_FILL_R,
  META_STROKE_R,
  META_FILL_GRAD,
  META_STROKE_GRAD,
} from '../bundle/layout.js';
import { metaStrokeReachFactor } from '../bundle/strokeReach.js';
import { pointInFill, pointInPrim, buildFillTree, boxCoverage } from './fillCoverage.js';
import { treeCollectNear } from '../geom/windingTree.js';
import {
  gradientData,
  imageData,
  sampleGradientAt,
  sampleImageAt,
  compositePaint,
} from './paintSample.js';

export const HitMode = Object.freeze({
  /** AABB only. Cheap. */
  Bbox: 'bbox',
  /** RENDERED PIXEL COVERAGE (opt-in, not the SVG model): where a row's fill is drawn, the fill's exact coverage of the
   *  pixel box at the point reaches one half (a point test without a `worldMatrix`); where its stroke is drawn, the
   *  point is in the stroke band; with opacity, mask and `minAlpha` applied. Ignores `pointer-events` and hits nothing
   *  that draws nothing. */
  Coverage: 'coverage',
  /** Stroke band: within strokeWidth/2 of the shape's curves, every row with a width, whatever its paint or
   *  `pointer-events`. */
  Outline: 'outline',
  /** THE SVG MODEL (the default): `pointer-events` (SVG 2 interact.html) over the exact fill interior (fill rule) and the
   *  exact stroked outline, clipped by clip-path, with no alpha or coverage threshold. Paint `none` is the only way a paint
   *  stops being a target; opacity, fill-opacity, stroke-opacity, mask, filter and blend never matter. Falls back to Bbox
   *  when the bundle carries no curve geometry. */
  Auto: 'auto',
});

const META_BBOX_XMIN = 0;
const META_BBOX_YMIN = 1;
const META_BBOX_XMAX = 2;
const META_BBOX_YMAX = 3;
const META_FILL_A = 7;
const META_STROKE_A = 11; // t2.w

const META_STROKE_W = 12; // t3.x
const META_FILL_RULE = 13; // t3.y: 1 = even-odd, else nonzero
const META_DASH_ID = 15; // t3.w: 0 = no dashes, else dash-table row+1
const META_CAP_STYLE = 24; // t6.x: 0 butt / 1 round / 2 square
const META_PRIM_KIND = 44; // t11.x: 3 = rounded rect (slot 46 is its rx, not a cap)
const META_END_CAP_OR_RX = 46; // t11.z: (endCap + 1) on a stroke row, 0 = same as the start cap
const META_JOIN_STYLE = 25; // t6.y: 0 miter / 1 round / 2 bevel
const META_MITER_LIMIT = 26; // t6.z
const META_FLAGS_SHAPE = 27; // t6.w: shape flag bits
const FS_NON_SCALING_STROKE = 1 << 0; // vector-effect: non-scaling-stroke
// A multi-row clipPath's union is bracketed by these on its first and last layer rows (bundleFinalize.js); on a
// layer row they are not the vector-effect bits they alias.
const FS_CLIP_BEGIN = 1 << 11;
const FS_CLIP_END = 1 << 12;

/**
 * Get a Float32Array view of the bundle's per-shape meta rows.
 * Handles both:
 *   • `sections`-shape (meta is an ArrayBuffer with 32-byte header)
 *   • bundle-shape (createBundle output — exposes metaFloats directly)
 *   • textRun output (metaFloats Float32Array, no header)
 */
/// The meta box is stored in float32 and rounded to nearest, so it can stop half a float32 step short of the curve's own extreme, whose control
/// points are stored exactly: a point inside the fill just under a curve's apex can lie outside its row's box and miss.
const metaBoxRounding = (x0, y0, x1, y1) =>
  2 ** -24 * Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1));

function metaView(bundle) {
  if (!bundle) return null;
  if (bundle.metaFloats instanceof Float32Array) return bundle.metaFloats;
  if (bundle.meta && bundle.meta.byteLength != null) {
    // sections-shape — 32-byte header, then per-shape floats. A bundle with no shapes carries an empty meta
    // (no header): it has nothing to test.
    if (bundle.meta.byteLength < 32) return null;
    return new Float32Array(bundle.meta, 32);
  }
  return null;
}

// Mask-paint queries reconstruct gradient planes only when sampled. The same
// prepared slot plans drive CPU uploads and GPU interpolation; no readback is needed.
function morphGradientData(bundle, pose) {
  const ms = pose && pose.source;
  if (!ms || !(pose.t > 0) || !ms.gradientParams || !ms.gradientStops) return gradientData(bundle);
  if (pose.gradientPaint) return pose.gradientPaint;
  const scratch = pose.gradientScratch || (pose.gradientScratch = {});
  const t = pose.t,
    ti = 1 - t;
  let g = ms.gradientParams,
    stops = ms.gradientStops;
  if (ms.gradientParamPlan?.length) {
    if (!scratch.params || scratch.params.length !== g.length)
      scratch.params = new Float32Array(g.length);
    sampleMorphGradientParams(scratch.params, g, ms.targetGradientParams, ms.gradientParamPlan, t);
    g = scratch.params;
  }
  if (ms.gradientStopPlan?.length) {
    if (!scratch.stops || scratch.stops.length !== stops.length)
      scratch.stops = new Uint8Array(stops.length);
    scratch.stops.set(stops);
    for (const row of ms.gradientStopPlan)
      for (let k = 0; k < row.byteLength; k++) {
        const at = row.srcByteOffset + k;
        scratch.stops[at] =
          (stops[at] * ti + ms.targetGradientStops[row.dstByteOffset + k] * t + 0.5) | 0;
      }
    stops = scratch.stops;
  }
  return (pose.gradientPaint = { g, s: stops });
}

function shapeCount(bundle) {
  if (bundle == null) return 0;
  if (typeof bundle.numShapes === 'number') return bundle.numShapes;
  return 0;
}

function strideOf(bundle) {
  if (typeof bundle.metaFloatsPerShape === 'number' && bundle.metaFloatsPerShape > 0)
    return bundle.metaFloatsPerShape;
  return 48; // v3 default
}

/** Per-bundle geometry cache. The decoded-seg cache + curve view +
 *  ranges are pure functions of the bundle's geometry, keyed on
 *  `_geomGen` (bumped by every streaming/nine-slice rewrite) — without
 *  it, pointer-move hit testing re-decoded every shape's segments (and,
 *  for sections bundles, re-copied the whole curve plane) per event.
 *  Morph pose adds `morphT` so setT invalidates without a geom bump. */
const _geomCache = new WeakMap();

// Screen-pixel differentials in row coordinates, matching shader fwidth.
function inversePixelBasis(world) {
  if (!world) return [1, 0, 0, 1];
  const a = world[0],
    b = world[1],
    c = world[3],
    d = world[4],
    det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return [1, 0, 0, 1];
  return [d / det, -c / det, -b / det, a / det];
}
function rowPixelBasis(geom, ov, b) {
  const p = geom ? geom.pixelBasis : [1, 0, 0, 1];
  if (!ov || b + 5 >= ov.length) return p;
  const a = ov[b],
    c = ov[b + 1],
    d = ov[b + 3],
    z = ov[b + 2],
    det = a * d - c * z;
  if (!Number.isFinite(det) || det === 0) return p;
  return [
    (d * p[0] - c * p[2]) / det,
    (d * p[1] - c * p[3]) / det,
    (a * p[2] - z * p[0]) / det,
    (a * p[3] - z * p[1]) / det,
  ];
}
/// The length a non-scaling stroke's dash pattern is measured in, in the row's frame: the shader's strokeDashScale, 0.5 * (ePx.x + ePx.y).
const nonScalingDashScale = (p) =>
  0.5 * (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) + Math.abs(p[3]));
function strokeWidthScale(meta, off, p) {
  const flags = Math.round(meta[off + META_FLAGS_SHAPE]),
    x = Math.abs(p[0]) + Math.abs(p[1]),
    y = Math.abs(p[2]) + Math.abs(p[3]);
  const h = (flags & (1 << 13)) !== 0,
    v = (flags & (1 << 14)) !== 0;
  return h && !v ? x : v && !h ? y : flags & (1 | (1 << 13) | (1 << 14)) ? (x + y) * 0.5 : 1;
}

/** Build (or reuse) the geometry context per query (null ⇒ bbox-only path). */
function buildGeom(bundle, meta, n, stride, opts, morphPose) {
  if (opts.mode === HitMode.Bbox) return null;
  const gen = bundle._geomGen | 0;
  const morphT = morphPose ? morphPose.t : -1;
  let c = _geomCache.get(bundle);
  if (!c || c.gen !== gen || c.n !== n || c.morphT !== morphT || c.pose !== morphPose) {
    const cv = morphPose ? morphPose.curve : curveView(bundle);
    if (!cv) return null;
    c = {
      gen,
      n,
      morphT,
      pose: morphPose,
      curveF32: cv,
      ranges: morphPose ? morphPose.ranges : curveRangesOf(bundle, meta, n, stride, cv.length),
      cache: new Array(n),
      framed: new Array(n), // a stroke-space row's segments mapped through its frame
      trees: new Array(n),
      memo: new Array(n),
      boxed: !morphPose || morphT === 0,
      dashF: dashView(bundle),
      paint: { grad: gradientData(bundle), image: imageData(bundle) }, // mask children's paint
    };
    if (
      morphPose &&
      (morphPose.source.gradientParamPlan?.length || morphPose.source.gradientStopPlan?.length)
    ) {
      Object.defineProperty(c.paint, 'grad', { get: () => morphGradientData(bundle, morphPose) });
    }
    _geomCache.set(bundle, c);
  }
  return {
    curveF32: c.curveF32,
    ranges: c.ranges,
    cache: c.cache,
    framed: c.framed,
    trees: c.trees,
    memo: c.memo,
    boxed: c.boxed,
    dashF: c.dashF,
    paint: c.paint,
    emPerPx: emPerPxOf(opts.worldMatrix),
    // A fill is tested against the pixel box only when the caller says what a pixel is; the 1 em of emPerPx with no
    // worldMatrix is the non-scaling stroke's unit, not a pixel.
    fillBox: !!opts.worldMatrix && opts.mode !== HitMode.Auto,
    pixelBasis: inversePixelBasis(opts.worldMatrix),
  };
}

// A row's segments and winding tree, decoded lazily and cached with the geometry. A pure-fill simple-shape
// primitive (circle / rect / roundRect) answers the fill test from the analytic SDF and never touches the curve
// buffer. The tree turns the O(N)-per-query fill walk / stroke closest-point scan into O(log N + near) on
// segment-heavy shapes with IDENTICAL results (buildFillTree returns null below its cutoff -- the plain loop wins
// there). `null` is cached too, so the cutoff decision runs once.
function segsOf(meta, off, i, geom) {
  let segs = geom.cache[i];
  if (segs === undefined)
    segs = geom.cache[i] = decodeSegs(
      geom.curveF32,
      geom.ranges[i].begin,
      geom.ranges[i].end,
      meta[off + META_JOIN_STYLE] | 0,
    );
  return segs;
}
function treeOf(meta, off, i, geom) {
  let t = geom.trees[i];
  if (t === undefined) t = geom.trees[i] = buildFillTree(segsOf(meta, off, i, geom));
  return t;
}

// TIE POLICY (fill). A query exactly on a fill edge is a HIT, from every side: a pixel-box coverage reaches the edge
// midline within COVERAGE_TIE of 0.5 (the f64 noise of the exact box walk is ~1e-14), and a point query within TIE_REL of
// the shape's extent of a boundary that has fill beside it (a probe a few TIE_REL away along an axis is inside) is on that
// edge. Two shapes abutting on an edge both answer there, so an edge never leaves a gap; a boundary with no area beside
// it (a degenerate fill) answers nothing. Strokes are inclusive (distance <= half width), simple-shape primitives too (d <= 0).
const COVERAGE_TIE = 1e-9;
const TIE_REL = 1e-6;

/// Row i's FILL covers (px, py) as the render draws it: the band walk's coverage reaches the edge midline.
/// With a worldMatrix the test is the exact coverage of the pixel box; without one (em space, a pixel of no size)
/// it is the point-in-fill test, which is the same midline at ANY scale -- no pixel size is invented, so a glyph
/// 1 em across and a shape 2^20 across answer alike.
///
/// `pixelBox` is the pixel's [width, height] in the row's own frame, where that is not the world's (rowPixelBox).
function fillCovers(meta, off, i, px, py, geom, tie = 0, pixelBox = null) {
  const prim = pointInPrim(meta, off, px, py, tie); // 1 in / 0 out / -1 n.a.
  if (prim >= 0) return prim === 1;
  const emPerPx = geom.emPerPx;
  const evenOdd = (meta[off + META_FILL_RULE] | 0) === 1;
  // Reuse an answer only for the same pixel footprint and while the whole
  // pixel box stays clear of every boundary. Point containment alone does
  // not prove constant box coverage near a narrow feature or corner.
  const boxed = geom.boxed && geom.fillBox && emPerPx > 0;
  const boxW = boxed ? (pixelBox ? pixelBox[0] : emPerPx) : 0,
    boxH = boxed ? (pixelBox ? pixelBox[1] : emPerPx) : 0;
  const memo = geom.memo[i];
  if (
    memo &&
    memo.boxW === boxW &&
    memo.boxH === boxH &&
    (px - memo.x) * (px - memo.x) + (py - memo.y) * (py - memo.y) < memo.r * memo.r
  )
    return memo.hit;
  // The render's answer: the fill kernel draws the exact coverage of the pixel box (renderFill is the exact walk),
  // so a point is hit when that coverage reaches the edge midline -- computed from the bundle's own decoded
  // curve data (boxCoverage, f64). A morph pose, and a pixel of no size, take the point-in-fill test: the same midline
  // for a pixel that is small against the shape.
  const segs = segsOf(meta, off, i, geom);
  let fillHit,
    tieR = 0;
  if (boxW > 0) {
    fillHit = boxCoverage(segs, px, py, boxW, boxH, evenOdd) >= 0.5 - COVERAGE_TIE;
  } else {
    fillHit = pointInFill(segs, px, py, evenOdd, treeOf(meta, off, i, geom));
    if (!fillHit) {
      // A point within TIE_REL of the extent of a boundary is a tie, and it hits when fill lies beside it.
      const ext = Math.max(
        meta[off + META_BBOX_XMAX] - meta[off + META_BBOX_XMIN],
        meta[off + META_BBOX_YMAX] - meta[off + META_BBOX_YMIN],
      );
      const near = TIE_REL * ext;
      if (near > 0 && Number.isFinite(near)) {
        tieR = 3 * near; // a miss remembered below must stop short of the tie band, and of the probes
        if (nearBoundary(meta, off, i, px, py, geom, segs, near)) {
          const tree = treeOf(meta, off, i, geom),
            d = 2 * near;
          fillHit =
            pointInFill(segs, px + d, py, evenOdd, tree) ||
            pointInFill(segs, px - d, py, evenOdd, tree) ||
            pointInFill(segs, px, py + d, evenOdd, tree) ||
            pointInFill(segs, px, py - d, evenOdd, tree);
        }
      }
    }
  }
  // clear radius from the winding tree (big shapes only — where queries cost):
  // segments beyond the collect radius are farther than the cap by construction.
  const tree = treeOf(meta, off, i, geom);
  if (tree) {
    const cap = 6 * Math.max(emPerPx, boxW, boxH);
    const near = treeCollectNear(tree, px, py, cap, []);
    let rMin = cap;
    for (const k of near) {
      const cc = closest(segs[k], px, py);
      const dd = Math.sqrt(cc.d2);
      if (dd < rMin) rMin = dd;
    }
    // The whole pixel box must stay inside one boundary-free region; a point query's tie box too.
    const r = Math.max(0, rMin - Math.hypot(boxW, boxH) / 2 - tieR) * 0.98;
    geom.memo[i] = { x: px, y: py, hit: fillHit, r, boxW, boxH };
  }
  return fillHit;
}

/// Whether any boundary segment of row i passes within r of (px, py).
function nearBoundary(meta, off, i, px, py, geom, segs, r) {
  const tree = treeOf(meta, off, i, geom);
  const ks = tree ? treeCollectNear(tree, px, py, r, []) : null;
  const n = ks ? ks.length : segs.length;
  for (let j = 0; j < n; j++) {
    const c = closest(segs[ks ? ks[j] : j], px, py);
    if (c.d2 <= r * r) return true;
  }
  return false;
}

/// Row i's STROKE band covers (px, py); halfW is the band's em half-width (non-scaling already applied), and `pixelBasis` the row's
/// screen-pixel differentials, which scale a non-scaling stroke's dashes as they scale its width.
function strokeCovers(meta, off, i, px, py, geom, halfW, pixelBasis) {
  const cap = meta[off + META_CAP_STYLE] | 0;
  // The END cap, which the renderer reads and this did not: mantle.frag.glsl decodes slot 46
  // as (endCap + 1) with 0 meaning "same as the start cap", and the slot holds a rect's corner
  // radius instead on a primKind-3 row. Reading the start cap for both ends made the hit test
  // disagree with the render on every asymmetric pair.
  const endEnc =
    (meta[off + META_PRIM_KIND] | 0) === 3 ? 0 : Math.round(meta[off + META_END_CAP_OR_RX]) | 0;
  const endCap = endEnc === 0 ? cap : endEnc - 1;
  const join = meta[off + META_JOIN_STYLE] | 0;
  const miter = meta[off + META_MITER_LIMIT] || 4;
  const dashId = Math.round(meta[off + META_DASH_ID]) | 0;
  const dashScale =
    (Math.round(meta[off + META_FLAGS_SHAPE]) & FS_NON_SCALING_STROKE) !== 0
      ? nonScalingDashScale(pixelBasis)
      : 1;
  // Tree-pruned stroke test on big shapes: only segments whose bounding circle comes
  // within the band's worst reach (bundle/strokeReach.js: a miter's tip, a clipped miter's
  // corners) can answer.
  let strokeSegs = segsOf(meta, off, i, geom);
  const tree = treeOf(meta, off, i, geom);
  // A row drawn in STROKE SPACE: the renderer measures its stroke through the frame N in meta texel 5, and
  // so does this -- the segments and the point both mapped. The prune below stays in document space: halfW is the
  // stroke-space half-width, which bounds the document one in every direction (bundle/strokeFrame.js).
  const framed = (Math.round(meta[off + META_FLAGS_SHAPE]) & FS_STROKE_LOCAL) !== 0;
  const N = framed
    ? [
        meta[off + META_SOLID_START],
        meta[off + META_SOLID_START + 1],
        meta[off + META_SOLID_START + 2],
        meta[off + META_SOLID_START + 3],
      ]
    : null;
  let mapped = null;
  if (framed) {
    mapped = geom.framed[i];
    if (mapped === undefined) mapped = geom.framed[i] = strokeFrameSegs(strokeSegs, N);
  }
  let pick = null;
  if (tree) {
    const reach = halfW * Math.max(2, metaStrokeReachFactor(meta, off));
    pick = treeCollectNear(tree, px, py, reach, []);
  }
  if (framed) {
    const segsS = pick ? pick.map((k) => mapped[k]) : mapped;
    const qx = N[0] * px + N[2] * py,
      qy = N[1] * px + N[3] * py;
    return pointOnStroke(
      segsS,
      qx,
      qy,
      halfW,
      cap,
      join,
      miter,
      geom.dashF,
      dashId,
      endCap,
      dashScale,
    );
  }
  if (pick) strokeSegs = pick.map((k) => strokeSegs[k]);
  return pointOnStroke(
    strokeSegs,
    px,
    py,
    halfW,
    cap,
    join,
    miter,
    geom.dashF,
    dashId,
    endCap,
    dashScale,
  );
}

/// The stroke half-width row `off` draws, in em: a non-scaling stroke's band is a constant SCREEN width.
function strokeHalfW(meta, off, pixelBasis) {
  const hw = meta[off + META_STROKE_W] * 0.5;
  return hw * strokeWidthScale(meta, off, pixelBasis);
}

/// A paint row: one the renderer can draw (bundle.js buildDrawList). Group boundaries are scaffolding, and FS_LAYER
/// rows are clip, mask and pattern CONTENT -- sampled by the rows that reference them, never drawn -- so the hit test
/// reported them as the topmost hits: they are appended after every drawn shape.
function isPaintRow(meta, stride, off) {
  if (stride <= META_FLAGS_SHAPE) return true;
  return (
    (Math.round(meta[off + META_FLAGS_SHAPE]) & (FS_GROUP_BEGIN | FS_GROUP_END | FS_LAYER)) === 0
  );
}

/// A row kept hidden (FS_HIDDEN: importSvg keepHidden) answers a point only while an override reveals it (`reveal`, overrides.js).
function hiddenRowUnrevealed(meta, stride, off, ov, ob) {
  if (stride <= META_FLAGS_SHAPE || (Math.round(meta[off + META_FLAGS_SHAPE]) & FS_HIDDEN) === 0)
    return false;
  return !(ov && ob + 7 < ov.length && (Math.round(ov[ob + 7]) & 16) !== 0);
}

/// (px, py) in row r's LOCAL frame: an animated clipper or mask child is moved by its override affine, and the
/// render samples it through the inverse (_overrideTransform.glsl transformClipCoord). A singular affine has no
/// inverse and samples at the point itself, as there -- singular by the shader's own test, relative to the terms
/// (2^-22 of |ad| + |bc|), so the two agree at any scale.
function layerLocal(ov, r, px, py) {
  const b = r * 24;
  if (!ov || b + 5 >= ov.length) return [px, py];
  const m00 = ov[b],
    m01 = ov[b + 1],
    m10 = ov[b + 2],
    m11 = ov[b + 3];
  const det = m00 * m11 - m01 * m10;
  if (!(
    Math.abs(det) > 2 ** -22 * (Math.abs(m00 * m11) + Math.abs(m01 * m10)) && Number.isFinite(det)
  ))
    return [px, py];
  const dx = px - ov[b + 4],
    dy = py - ov[b + 5];
  return [(m11 * dx - m01 * dy) / det, (-m10 * dx + m00 * dy) / det];
}

/// One device pixel in row r's LOCAL frame, the box its fill's coverage is of. An override's scale makes a pixel another size there. A clip child takes the
/// local map's own box, |M^-1| e (_overrideTransform.glsl transformClipPx). `turned` is for a row a rotating override sends through the local map itself, a drawn row
/// or a mask child: that pixel is a turned square, and boxCoverage's box is axis-aligned, so it gets a box of the same area. null where the world's pixel
/// stands: no override row, an affine that leaves the basis alone, and a singular one, by layerLocal's test.
function rowPixelBox(ov, r, e, turned = false) {
  const b = r * 24;
  if (!ov || b + 5 >= ov.length) return null;
  const m00 = ov[b],
    m01 = ov[b + 1],
    m10 = ov[b + 2],
    m11 = ov[b + 3];
  if (m00 === 1 && m01 === 0 && m10 === 0 && m11 === 1) return null;
  const det = m00 * m11 - m01 * m10;
  if (!(
    Math.abs(det) > 2 ** -22 * (Math.abs(m00 * m11) + Math.abs(m01 * m10)) && Number.isFinite(det)
  ))
    return null;
  const a = Math.abs(det);
  if (turned && (m01 !== 0 || m10 !== 0)) {
    const s = e / Math.sqrt(a);
    return [s, s];
  }
  return [(Math.abs(m11) * e + Math.abs(m01) * e) / a, (Math.abs(m10) * e + Math.abs(m00) * e) / a];
}

/// Whether the clip whose first layer row is `first` (0-based) covers (px, py): SVG's union of its children, each
/// child intersected with its own clip-path (mantle.frag.glsl's clip walk; the importer folds deeper nesting into
/// these two levels, and this follows any it did not). Clip content winds by clip-rule, carried in the row's fill
/// rule. `seen` holds the clips on the current path, so a cyclic reference ends rather than recursing.
function clipCovers(meta, stride, first, px, py, geom, ov, n, seen) {
  if (first < 0 || first >= n || seen.includes(first)) return true;
  const multi = (Math.round(meta[first * stride + META_FLAGS_SHAPE]) & FS_CLIP_BEGIN) !== 0;
  for (let r = first; r < n; r++) {
    const off = r * stride;
    const f = Math.round(meta[off + META_FLAGS_SHAPE]);
    if (multi && (f & FS_LAYER) === 0) break;
    const [lx, ly] = layerLocal(ov, r, px, py);
    if (
      geom.ranges[r] &&
      fillCovers(meta, off, r, lx, ly, geom, 0, rowPixelBox(ov, r, geom.emPerPx))
    ) {
      const inner = Math.round(meta[off + META_CLIP_ID]);
      if (!(inner > 0)) return true;
      seen.push(first);
      const ok = clipCovers(meta, stride, inner - 1, px, py, geom, ov, n, seen);
      seen.pop();
      if (ok) return true;
    }
    if (!multi || (f & FS_CLIP_END) !== 0) break;
  }
  return false;
}

/// The value in [0, 1] of the mask whose first layer row is `first` at (px, py): its children composited
/// source-over, each weighted by its paint's luminance (or alpha, for mask-type="alpha") where its fill or stroke
/// covers the point -- maskBake.frag.glsl and mantle.frag.glsl's inline walk. A child is intersected with its own
/// clip-path, and with its own mask when it carries one (every child of this mask carries this mask's row, which
/// is not a reference). The paint is the render's gradient and image, sampled at the point (paintSample.js).
function layerPaint(meta, stride, first, last, px, py, geom, ov, n, paint, seen) {
  if (first < 0 || first >= n) return [0, 0, 0, 0];
  const multi =
    last >= 0 || (Math.round(meta[first * stride + META_FLAGS_SHAPE]) & FS_MASK_BEGIN) !== 0;
  let acc = [0, 0, 0, 0];
  const groups = [];
  for (let r = first; r < n; r++) {
    const off = r * stride;
    const f = Math.round(meta[off + META_FLAGS_SHAPE]);
    if ((f & FS_LAYER) === 0) break;
    const end = !multi || (last < 0 && (f & FS_MASK_END) !== 0) || r === last;
    if (f & 64) {
      groups.push({ acc, opacity: meta[off + META_FILL_A], mode: Math.round(meta[off + 33]) });
      acc = [0, 0, 0, 0];
      if (end) break;
      continue;
    }
    if (f & 128) {
      const group = groups.pop();
      if (group)
        acc = compositePaint(
          acc.map((v) => v * group.opacity),
          group.acc,
          group.mode,
        );
      if (end) break;
      continue;
    }
    const [lx, ly] = layerLocal(ov, r, px, py);
    const strokeGrad = Math.round(meta[off + META_STROKE_GRAD]);
    const isStroke =
      meta[off + META_STROKE_W] > 0 && (meta[off + META_STROKE_A] > 0 || strokeGrad > 0);
    const rowBasis = isStroke ? rowPixelBasis(geom, ov, r * 24) : null;
    let covers =
      !!geom.ranges[r] &&
      (isStroke
        ? strokeCovers(meta, off, r, lx, ly, geom, strokeHalfW(meta, off, rowBasis), rowBasis)
        : fillCovers(meta, off, r, lx, ly, geom, 0, rowPixelBox(ov, r, geom.emPerPx, true)));
    if (covers) {
      const innerClip = Math.round(meta[off + META_CLIP_ID]);
      if (innerClip > 0 && !clipCovers(meta, stride, innerClip - 1, px, py, geom, ov, n, []))
        covers = false;
    }
    if (covers) {
      const bb = [
        meta[off + META_BBOX_XMIN],
        meta[off + META_BBOX_YMIN],
        meta[off + META_BBOX_XMAX],
        meta[off + META_BBOX_YMAX],
      ];
      const base = isStroke ? META_STROKE_R : META_FILL_R;
      let p = [meta[off + base], meta[off + base + 1], meta[off + base + 2], meta[off + base + 3]];
      const gid = isStroke ? strokeGrad : Math.round(meta[off + META_FILL_GRAD]);
      const img = isStroke ? 0 : Math.round(meta[off + META_IMAGE_ID]);
      let s = null;
      if (stride >= 44 && Math.round(meta[off + 43]) === 2) {
        const key = -r - 1;
        s = [0, 0, 0, 0];
        const width = meta[off + META_IMAGE_RECT_X + 2],
          height = meta[off + META_IMAGE_RECT_X + 3];
        if (width > 0 && height > 0 && !seen.includes(key)) {
          const wrap = (value, period) => value - Math.floor(value / period) * period;
          const x = wrap(
            meta[off + 20] * lx + meta[off + 22] * ly - meta[off + META_IMAGE_RECT_X],
            width,
          );
          const y = wrap(
            meta[off + 21] * lx + meta[off + 23] * ly - meta[off + META_IMAGE_RECT_X + 1],
            height,
          );
          const start = Math.round(meta[off + META_ATLAS_Y]) - 1,
            stop = Math.round(meta[off + META_ATLAS_Y + 1]) - 1;
          seen.push(key);
          const color = layerPaint(meta, stride, start, stop, x, y, geom, ov, n, paint, seen);
          seen.pop();
          if (color[3] > 0)
            s = [color[0] / color[3], color[1] / color[3], color[2] / color[3], color[3]];
        }
      } else if (img > 0) {
        let imageX = lx,
          imageY = ly;
        if (gid > 0 && paint.grad.g && gid * 16 <= paint.grad.g.length) {
          const g = paint.grad.g,
            base = (gid - 1) * 16;
          imageX = g[base + 4] * lx + g[base + 6] * ly + g[base + 8];
          imageY = g[base + 5] * lx + g[base + 7] * ly + g[base + 9];
        }
        s = sampleImageAt(
          paint.image,
          imageX,
          imageY,
          [
            meta[off + META_IMAGE_RECT_X],
            meta[off + META_IMAGE_RECT_X + 1],
            meta[off + META_IMAGE_RECT_X + 2],
            meta[off + META_IMAGE_RECT_X + 3],
          ],
          [
            meta[off + META_ATLAS_Y],
            meta[off + META_ATLAS_Y + 1],
            meta[off + META_ATLAS_Y + 2],
            meta[off + META_ATLAS_Y + 3],
          ],
        );
      } else if (gid > 0) {
        s = sampleGradientAt(paint.grad, gid, lx, ly, bb);
      }
      if (s) p = [p[0] * s[0], p[1] * s[1], p[2] * s[2], p[3] * s[3]];
      // THE MASK IMAGE IS THE CHILDREN COMPOSITED SOURCE-OVER, and its value that image's luminance or alpha (CSS
      // Masking 1 §7.1): each child's premultiplied luminance lum * a goes over the rest by its ALPHA a -- so a
      // black child over a white one hides what it covers. (The render composited lum * a as if it were the alpha, and
      // this followed it.)
      let a = p[3];
      const innerMask = Math.round(meta[off + META_MASK_ID]);
      if (a > 0 && innerMask > 0 && innerMask !== first + 1) {
        seen.push(first);
        a *= maskValue(meta, stride, innerMask - 1, px, py, geom, ov, n, paint, seen);
        seen.pop();
      }
      acc = compositePaint([p[0] * a, p[1] * a, p[2] * a, a], acc, Math.round(meta[off + 33]));
    }
    if (end) break;
  }
  return acc;
}

function maskValue(meta, stride, first, px, py, geom, ov, n, paint, seen) {
  if (first < 0 || first >= n || seen.includes(first)) return 1;
  const color = layerPaint(meta, stride, first, -1, px, py, geom, ov, n, paint, seen);
  const luminance = Math.round(meta[first * stride + META_ISOLATION]) !== 0;
  const value = luminance ? 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] : color[3];
  return Math.min(Math.max(value, 0), 1);
}

/// The mask rows of the groups that enclose each row, for rows under a masked group (a container whose mask applies to its
/// composited content, as its filter does). null when no group in the bundle carries a mask. Cached per meta array.
const _groupMasks = new WeakMap();
function groupMasksOf(meta, stride, n) {
  let c = _groupMasks.get(meta);
  if (c && c.n === n && c.stride === stride) return c.lists;
  let lists = null;
  if (stride > META_MASK_ID) {
    const stack = [],
      inside = new Array(n).fill(null);
    let masked = 0;
    for (let r = 0; r < n; r++) {
      const off = r * stride,
        f = Math.round(meta[off + META_FLAGS_SHAPE]);
      if (f & FS_LAYER) continue;
      if (f & 64) {
        const m = Math.round(meta[off + META_MASK_ID]);
        stack.push(m > 0 ? m : 0);
        if (m > 0) masked++;
        continue;
      }
      if (f & 128) {
        if (stack.pop() > 0) masked--;
        continue;
      }
      if (masked > 0) inside[r] = stack.filter((m) => m > 0);
    }
    if (inside.some((x) => x)) lists = inside;
  }
  _groupMasks.set(meta, { n, stride, lists });
  return lists;
}

// Group opacity follows the current paint order and is sampled once per query.
function groupOpacitiesOf(meta, stride, n, order) {
  const stack = [];
  let product = 1,
    scales = null;
  for (let at = 0; at < n; at++) {
    const row = order ? order[at] : at,
      off = row * stride;
    const flags = Math.round(meta[off + META_FLAGS_SHAPE]);
    if (flags & FS_LAYER) continue;
    if (flags & FS_GROUP_BEGIN) {
      const alpha = meta[off + META_FILL_A];
      stack.push(product);
      product *= Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;
    } else if (flags & FS_GROUP_END) product = stack.pop() ?? 1;
    else if (product !== 1) {
      if (!scales) scales = new Float64Array(n).fill(1);
      scales[row] = product;
    }
  }
  return scales;
}

function hits(meta, stride, i, qx, qy, opts, geom, n, colr = null, groupOpacities = null) {
  const off = i * stride;
  if (colr && colr.exclude.has(i)) return false;
  if (!(colr && colr.owner.has(i)) && !isPaintRow(meta, stride, off)) return false;
  if (
    colr &&
    colr.clips &&
    colr.clips.has(i) &&
    !colr.clips
      .get(i)
      .some((set) => set.every((c) => hits(meta, stride, c, qx, qy, opts, geom, n, colr.clipTest)))
  )
    return false;
  if (hiddenRowUnrevealed(meta, stride, off, opts.overridesPacked, i * 24)) return false;
  const mode = opts.mode,
    minAlpha = opts.minAlpha;
  const pixelBasis = rowPixelBasis(geom, opts.overridesPacked, i * 24);
  const widthScale = strokeWidthScale(meta, off, pixelBasis);
  // Override visibility / tint alpha (morph fade-in/out, runtime hide).
  let alphaScale = 1;
  const ov = opts.overridesPacked;
  // THE ROW'S own FRAME, and its absolute paint. The render draws a row where its override affine puts
  // it and samples it in its own frame (mantle.vert.glsl), so its geometry, stroke, clip-path and mask all move with
  // it; the point is taken back through the inverse, exactly, and a row collapsed to a line or a point draws nothing.
  // An absolute fill or stroke color replaces the row's paint, its alpha too, and an absolute stroke width its width.
  let px = qx,
    py = qy,
    fillA0 = meta[off + META_FILL_A],
    strokeA0 = meta[off + META_STROKE_A],
    sw0 = meta[off + META_STROKE_W];
  if (ov) {
    const ob = i * 24;
    if (ob + 11 < ov.length) {
      alphaScale = ov[ob + 6] * ov[ob + 11]; // visibility × tint.a
      if (alphaScale <= 0.004) return false;
      const m00 = ov[ob],
        m01 = ov[ob + 1],
        m10 = ov[ob + 2],
        m11 = ov[ob + 3],
        tx = ov[ob + 4],
        ty = ov[ob + 5];
      if (m00 !== 1 || m01 !== 0 || m10 !== 0 || m11 !== 1 || tx !== 0 || ty !== 0) {
        const det = m00 * m11 - m01 * m10;
        if (!(
          Math.abs(det) > 2 ** -22 * (Math.abs(m00 * m11) + Math.abs(m01 * m10)) &&
          Number.isFinite(det)
        ))
          return false;
        const dx = qx - tx,
          dy = qy - ty;
        const i00 = m11 / det,
          i01 = -m01 / det,
          i10 = -m10 / det,
          i11 = m00 / det;
        px = i00 * dx + i01 * dy;
        py = i10 * dx + i11 * dy;
        // em per pixel in the row's frame as the render's fwidth reads it there (non-scaling strokes)
      }
      const bits = Math.round(ov[ob + 7]);
      if (ob + 23 < ov.length) {
        if (bits & 1) fillA0 = ov[ob + 15];
        if (bits & 2) strokeA0 = ov[ob + 19];
        if (bits & 4) sw0 = ov[ob + 20];
      }
    }
  }
  // Bbox cull (cheap reject). A miter join can extend up to halfW·miterLimit
  // past a vertex — beyond the round meta-bbox — so widen the cull there;
  // the miter test itself then decides the exact spike region. For
  // non-scaling-stroke the em-space band is halfW·emPerPx, so it can also
  // exceed the baked (nominal) bbox on zoom-out — widen by that excess too.
  // An override's stroke width can exceed the baked one the box was padded by: widen by all of it.
  let mx = 0;
  if (mode === HitMode.Outline || mode === HitMode.Coverage) {
    if (sw0 > 0) {
      const hw = sw0 * 0.5 * widthScale;
      // miter, miter-clip and arcs (SVG 2 sends arcs to miter-clip on straight segments) and a
      // square cap's corners reach past the halfW pad; bundle/strokeReach.js has the bound
      const reachF = metaStrokeReachFactor(meta, off);
      if (reachF > 1) mx = hw * reachF;
      if (widthScale > 1) mx = Math.max(mx, hw);
      if (sw0 !== meta[off + META_STROKE_W]) mx = Math.max(mx, hw * Math.max(reachF, 1));
    }
  }
  mx += metaBoxRounding(
    meta[off + META_BBOX_XMIN],
    meta[off + META_BBOX_YMIN],
    meta[off + META_BBOX_XMAX],
    meta[off + META_BBOX_YMAX],
  );
  if (
    px < meta[off + META_BBOX_XMIN] - mx ||
    px > meta[off + META_BBOX_XMAX] + mx ||
    py < meta[off + META_BBOX_YMIN] - mx ||
    py > meta[off + META_BBOX_YMAX] + mx
  )
    return false;

  if (groupOpacities) alphaScale *= groupOpacities[i];
  // Bbox mode, or geometry unavailable → legacy bbox + flat-alpha behavior.
  if (mode === HitMode.Bbox || !geom || !geom.ranges[i]) {
    if (minAlpha > 0 && fillA0 * alphaScale < minAlpha) return false;
    return true;
  }

  // The shape's mask scales what it paints at this point, fill and stroke alike: where the mask is 0
  // nothing is drawn, and a partial mask is a partial alpha for minAlpha.
  const maskId = stride > META_MASK_ID ? Math.round(meta[off + META_MASK_ID]) : 0;
  if (maskId > 0) {
    alphaScale *= maskValue(meta, stride, maskId - 1, px, py, geom, ov, n, geom.paint, []);
    if (!(alphaScale > 0)) return false;
  }
  // ...and so do the masks of the groups it is inside: the group's mask multiplies what the group composites.
  const enclosing = groupMasksOf(meta, stride, n);
  if (enclosing && enclosing[i]) {
    for (const gm of enclosing[i]) {
      alphaScale *= maskValue(meta, stride, gm - 1, qx, qy, geom, ov, n, geom.paint, []);
      if (!(alphaScale > 0)) return false;
    }
  }
  const fillA = fillA0 * alphaScale;
  const strokeA = strokeA0 * alphaScale;
  const halfW = sw0 * 0.5 * widthScale;

  let hit = false;
  // Fill winding, where the row is filled.
  if (mode === HitMode.Coverage && fillA > 0) {
    if (minAlpha <= 0 || fillA >= minAlpha)
      hit = fillCovers(meta, off, i, px, py, geom, 0, rowPixelBox(ov, i, geom.emPerPx, true));
  }
  // Stroke band, where the row is stroked.
  if (!hit && (mode === HitMode.Outline || (mode === HitMode.Coverage && strokeA > 0))) {
    if (halfW > 0 && (minAlpha <= 0 || strokeA >= minAlpha))
      hit = strokeCovers(meta, off, i, px, py, geom, halfW, pixelBasis);
  }
  // ...and ITS CLIP-PATH removes what lies outside the clip (SVG 1.1 §14.3.5: no pointer events on the
  // clipped regions).
  const clipId = stride > META_CLIP_ID ? Math.round(meta[off + META_CLIP_ID]) : 0;
  if (hit && clipId > 0) hit = clipCovers(meta, stride, clipId - 1, px, py, geom, ov, n, []);
  return hit;
}

// ── THE SVG MODEL (HitMode.Auto) ───────────────────────────────────────────────────────────────────────────
// A row answers a point where its HIT BITS (svg/hitBits.js, resolved at import from pointer-events, visibility and
// paint `none`) name a region the point is in: the fill interior by the fill rule, the exact stroked outline, or the
// geometry bounding box. No alpha, opacity, mask or coverage enters; clip-path cuts the answer. The geometry is the
// bundle's native curve data, tested exactly and at any scale (no worldMatrix needed).

const HIT_FILL = 1,
  HIT_STROKE = 2;
const HIT_BBOX = 4;

const rowBitsOf = (meta, off) => paintHitBits(meta, off);

/// The hit-only table's rows as a bundle the geometry code reads (views over the retained buffers), cached per table.
const _layerBundles = new WeakMap();
function hitOnlyBundle(ho) {
  let b = _layerBundles.get(ho);
  if (!b) {
    b = {
      metaFloats:
        ho.meta && ho.meta.byteLength >= 32 ? new Float32Array(ho.meta, 32) : new Float32Array(0),
      curveFloats: new Float32Array(ho.curves),
      dashFloats: ho.dashes ? new Float32Array(ho.dashes) : null,
      numShapes: ho.numShapes,
      metaFloatsPerShape: ho.metaFloatsPerShape || 48,
      curveRangesByShape: ho.curveRangesByShape,
      _geomGen: 0,
    };
    _layerBundles.set(ho, b);
  }
  return b;
}

/// The hit-only table in force: a morph carries its source's until it passes halfway, then its destination's.
function hitOnlyOf(bundle) {
  const ms = bundle._morphSrc;
  return ms && (+ms.t || 0) >= 0.5 && bundle.hitOnlyTo ? bundle.hitOnlyTo : bundle.hitOnly || null;
}

/// A text bundle's COLRv1 glyphs (font/textRun.js colrHitSection): the paint graph draws through mask-only rows (resource
/// rows, which are not hit-eligible by default) and never draws the glyph's own base outline. The pointer answers for the
/// masks, as the glyph's primary row, and not for a base outline nothing draws. Cached per table.
const _colrHitMaps = new WeakMap();
function colrHitMaps(ch) {
  let m = _colrHitMaps.get(ch);
  if (!m) {
    m = { owner: new Map(), exclude: new Set(ch.exclude), clips: null, clipTest: null };
    for (let k = 0; k < ch.rows.length; k++) m.owner.set(ch.rows[k], ch.owner[k]);
    // Rows cut by ClipList boxes answer only inside the boxes of one use. A box row draws nothing and is no target, so the test of
    // a box treats it as one (clipTest) while the rows it cuts are asked as usual.
    if (ch.clips && ch.clips.length) {
      m.clips = new Map();
      m.clipTest = { owner: new Map(m.owner), exclude: new Set(), clips: null, clipTest: null };
      for (let k = 0; k + 1 < ch.clips.length; k += 2) {
        m.clips.set(ch.clips[k], ch.clips[k + 1]);
        for (const set of ch.clips[k + 1]) for (const r of set) m.clipTest.owner.set(r, r);
      }
    }
    _colrHitMaps.set(ch, m);
  }
  return m;
}

function specRowHits(L, i, qx, qy, opts, ovRow, ob) {
  const { meta, stride, geom } = L,
    off = i * stride;
  if (L.colr && L.colr.exclude.has(i)) return false;
  if (!(L.colr && L.colr.owner.has(i)) && !isPaintRow(meta, stride, off)) return false;
  if (L.colr && L.colr.clips && L.colr.clips.has(i)) {
    const LC = { ...L, colr: L.colr.clipTest };
    if (
      !L.colr.clips
        .get(i)
        .some((set) => set.every((c) => specRowHits(LC, c, qx, qy, opts, ovRow, c * 24)))
    )
      return false;
  }
  // A bundle with no curve geometry answers by its boxes, as Bbox does.
  const noGeom = !geom || !geom.ranges[i];
  if (hiddenRowUnrevealed(meta, stride, off, ovRow, ob)) return false;
  // (0x80: HIT_HIDDEN, svg/hitBits.js. A row kept hidden carries the bits it answers with once revealed.)
  if (
    L.bits &&
    ((L.bits[i] | 0) & 0x80) !== 0 &&
    !(ovRow && ob + 7 < ovRow.length && (Math.round(ovRow[ob + 7]) & 16) !== 0)
  )
    return false;
  const bits = L.bits ? (L.bits[i] | 0) & 0x7f : noGeom ? 1 : rowBitsOf(meta, off, stride);
  if (!bits) return false;
  let px = qx,
    py = qy,
    sw0 = meta[off + META_STROKE_W],
    moved = false;
  const ov = ovRow;
  // A runtime override moves the row (its geometry, clip-path and stroke with it), hides it, or sets its stroke width.
  // Its tint, opacity and absolute colors are paint, which never decides a pointer event.
  if (ov) {
    if (ob + 11 < ov.length) {
      if (ov[ob + 6] <= 0.004) return false;
      const m00 = ov[ob],
        m01 = ov[ob + 1],
        m10 = ov[ob + 2],
        m11 = ov[ob + 3],
        tx = ov[ob + 4],
        ty = ov[ob + 5];
      if (m00 !== 1 || m01 !== 0 || m10 !== 0 || m11 !== 1 || tx !== 0 || ty !== 0) {
        const det = m00 * m11 - m01 * m10;
        if (!(
          Math.abs(det) > 2 ** -22 * (Math.abs(m00 * m11) + Math.abs(m01 * m10)) &&
          Number.isFinite(det)
        ))
          return false;
        const dx = qx - tx,
          dy = qy - ty;
        px = (m11 * dx - m01 * dy) / det;
        py = (-m10 * dx + m00 * dy) / det;
        moved = true;
      }
      if (ob + 23 < ov.length && Math.round(ov[ob + 7]) & 4) sw0 = ov[ob + 20];
    }
  }
  const x0 = meta[off + META_BBOX_XMIN],
    y0 = meta[off + META_BBOX_YMIN],
    x1 = meta[off + META_BBOX_XMAX],
    y1 = meta[off + META_BBOX_YMAX];
  // The set is closed: a point on the edge of a moved row maps back to within rounding of that edge (cos(pi/2) is 6e-17), so a moved
  // row's box is widened by the tie tolerance of the geometry test (TIE_REL of its extent).
  const slack = moved ? TIE_REL * Math.max(x1 - x0, y1 - y0) : metaBoxRounding(x0, y0, x1, y1);
  const inBox = px >= x0 - slack && px <= x1 + slack && py >= y0 - slack && py <= y1 + slack;
  if (noGeom) {
    // ...including the flat alpha floor `minAlpha` sets there (the row's fill alpha is all the paint it has).
    const a = meta[off + META_FILL_A] * (ov && ob + 11 < ov.length ? ov[ob + 11] : 1);
    return inBox && !(opts.minAlpha > 0 && a < opts.minAlpha);
  }
  let hit = false;
  if (bits & HIT_BBOX && inBox) hit = true;
  if (!hit && bits & HIT_FILL && inBox)
    hit = fillCovers(meta, off, i, px, py, geom, slack, rowPixelBox(ov, i, geom.emPerPx, true));
  if (!hit && bits & HIT_STROKE && sw0 > 0) {
    // The band reaches past the baked box by the miter / cap reach, and a non-scaling stroke by its screen width.
    const pixelBasis = rowPixelBasis(geom, ov, ob),
      widthScale = strokeWidthScale(meta, off, pixelBasis);
    const hw = sw0 * 0.5 * widthScale,
      reach = hw * Math.max(1, metaStrokeReachFactor(meta, off), widthScale);
    if (px >= x0 - reach && px <= x1 + reach && py >= y0 - reach && py <= y1 + reach)
      hit = strokeCovers(meta, off, i, px, py, geom, hw, pixelBasis);
  }
  const clipId = stride > META_CLIP_ID ? Math.round(meta[off + META_CLIP_ID]) : 0;
  if (hit && clipId > 0) hit = clipCovers(meta, stride, clipId - 1, px, py, geom, L.ov, L.n, []);
  return hit;
}

/// Every hit of the SVG model, front to back (`all`), or the first. A hit-only region sits in paint order among the
/// drawn rows (`before`: the paint position it precedes) and answers as index numShapes + its position in the table.
function specQuery(bundle, qx, qy, opts, all) {
  if (!bundle) return all ? [] : -1;
  const morphPose = morphHitPose(bundle);
  const meta = (morphPose && morphPose.meta) || metaView(bundle);
  const n = meta ? shapeCount(bundle) : 0;
  const ho = hitOnlyOf(bundle);
  const out = all ? [] : null;
  if (n === 0 && !ho) return all ? out : -1;
  opts.overridesPacked = resolveOverridesPacked(bundle, opts);
  const emPt0 = applyInverseWorld(opts.worldMatrix, qx, qy);
  if (!emPt0) return all ? out : -1;
  const emPt = throughNineSlice(bundle, emPt0);
  const stride = strideOf(bundle);
  const main =
    n > 0
      ? {
          meta,
          stride,
          n,
          geom: buildGeom(bundle, meta, n, stride, opts, morphPose),
          bits: bundle.hitBits || null,
          ov: opts.overridesPacked,
          colr: bundle.colrHit ? colrHitMaps(bundle.colrHit) : null,
        }
      : null;
  let only = null;
  if (ho && ho.rows.length) {
    const hb = hitOnlyBundle(ho);
    const hm = metaView(hb);
    if (hm)
      only = {
        meta: hm,
        stride: hb.metaFloatsPerShape,
        n: hb.numShapes,
        geom: buildGeom(hb, hm, hb.numShapes, hb.metaFloatsPerShape, opts, null),
        bits: ho.hitBits,
        ov: null,
      };
  }
  // The override table's hit-only rows follow its drawn rows (overrides.js): row numShapes + k is hit-only row k. A table built
  // for another bundle (a morph's) carries none, and the hit-only shapes stay where they were authored.
  const ovP = opts.overridesPacked;
  const onlyOv = only && ovP && !morphPose && ovP.length === (n + ho.rows.length) * 24 ? ovP : null;
  const paintOrder = bundle._drawOrder;
  let h = only ? ho.rows.length - 1 : -1;
  const [ex, ey] = emPt;
  const hitOnlyUpTo = (i) => {
    // the hit-only regions that sit at or above main row i, top first
    while (h >= 0 && ho.before[h] >= i) {
      const k = h--;
      const owner = ho.hiddenOwner && ho.hiddenOwner[k];
      if (main && Number.isInteger(owner) && owner >= 0 && owner < main.n) {
        const hidden = main.bits && main.bits[owner] & 128;
        const revealed = main.ov && Math.round(main.ov[owner * 24 + 7]) & 16;
        const region = ho.hitBits && ho.hitBits[ho.rows[k]] & 7;
        if (main.bits && main.bits[owner] & region && (!hidden || revealed)) continue;
      }
      if (specRowHits(only, ho.rows[k], ex, ey, opts, onlyOv, (n + k) * 24)) {
        if (!all) return (main ? main.n : 0) + k;
        out.push((main ? main.n : 0) + k);
      }
    }
    return -1;
  };
  for (let i = main ? main.n : 0; i >= 0; i--) {
    const r = hitOnlyUpTo(i);
    if (r >= 0) return r;
    const row = i > 0 ? (paintOrder ? paintOrder[i - 1] : i - 1) : -1;
    if (row >= 0 && specRowHits(main, row, ex, ey, opts, main.ov, row * 24)) {
      const who = main.colr && main.colr.owner.has(row) ? main.colr.owner.get(row) : row; // a COLR mask answers as its glyph
      if (!all) return who;
      if (out[out.length - 1] !== who) out.push(who);
    }
  }
  return all ? out : -1;
}

/**
 * Resolve the (mode, minAlpha, worldMatrix, overrides) tuple from either form:
 *   - Legacy: fillHitShape(bundle, px, py, mode, minAlpha)
 *   - New: fillHitShape(bundle, px, py, { mode, minAlpha, worldMatrix, overrides })
 * @param {string|object|undefined} a4
 * @param {number|undefined} a5
 */
/// The `sprite` option of a hit query: a sprite id or an explicit [first, last] shape range restricts the answer to those drawn rows.
/// undefined = no option, null = an unknown id or a bad range (nothing answers), [first, last] = the window.
/// A sprite timeline's held frame is a view of its sheet: hit-test the sheet restricted to the view's sprite (an explicit `{ sprite }` wins). null when not a view.
function viewArgs(bundle, a4, a5) {
  const t =
    bundle != null && typeof bundle === 'object' && bundle.bundle !== undefined
      ? bundle.bundle
      : bundle;
  const v = t != null && typeof t === 'object' ? t._spriteOf : null;
  if (!v) return null;
  const o =
    a4 != null && typeof a4 === 'object'
      ? { ...a4 }
      : a4 != null
        ? { mode: a4, ...(a5 !== undefined ? { minAlpha: a5 } : {}) }
        : a5 !== undefined
          ? { minAlpha: a5 }
          : {};
  if (o.sprite == null) o.sprite = v.sprite;
  return [v.sheet, o];
}

function spriteWindow(bundle, a4) {
  if (a4 == null || typeof a4 !== 'object' || a4.sprite === undefined || a4.sprite === null)
    return undefined;
  const sp = a4.sprite;
  if (Array.isArray(sp) && sp.length === 2) return checkedSpriteBounds(sp, shapeCount(bundle));
  if (typeof sp !== 'string') return null;
  const r = ownSpriteRange(bundle, sp);
  return r ? [r[0], r[1]] : null;
}

function parseOpts(a4, a5) {
  if (a4 != null && typeof a4 === 'object') {
    return {
      mode: a4.mode || HitMode.Auto,
      minAlpha: typeof a4.minAlpha === 'number' ? a4.minAlpha : 0,
      worldMatrix: a4.worldMatrix || null,
      overrides: a4.overrides || null,
    };
  }
  return {
    mode: a4 == null ? HitMode.Auto : a4,
    minAlpha: typeof a5 === 'number' ? a5 : 0,
    worldMatrix: null,
    overrides: null,
  };
}

function resolveOverridesPacked(bundle, opts) {
  const table = opts.overrides || bundle._morphOverrides || null;
  if (!table) return null;
  if (table.packedBuffer instanceof Float32Array) return table.packedBuffer;
  if (table instanceof Float32Array) return table;
  // The native-SVG fallback's table has no texture or buffer: it packs the same rows for the hit test.
  if (table.isNative === true && typeof table.packedForHit === 'function')
    return table.packedForHit();
  return null;
}

/**
 * Invert a column-major 3×3 affine and apply it to (px, py, 1).
 * Returns [emX, emY] (the canvas-pixel point translated back into
 * the bundle's em-space). Used so a single bundle can be hit-tested
 * at any world transform.
 *
 * The matrix layout matches drawBundle's `worldMatrix`:
 *   m[0]=m00 m[1]=m10 m[2]=m20  (column 0)
 *   m[3]=m01 m[4]=m11 m[5]=m21  (column 1)
 *   m[6]=m02 m[7]=m12 m[8]=m22  (column 2)
 *
 * For 2D affines m20 = m21 = 0, m22 = 1 — handled inline.
 */
function applyInverseWorld(world, px, py) {
  if (!world) return [px, py];
  const a = world[0],
    b = world[1]; // m00, m10
  const c = world[3],
    d = world[4]; // m01, m11
  const tx = world[6],
    ty = world[7]; // m02, m12
  const det = a * d - b * c;
  // Singular relative to the matrix's own entries. An absolute 1e-12 is a world scale of 1e-6: a
  // bundle drawn any smaller answered no hit at all.
  if (!(Math.abs(det) > 1e-12 * (Math.abs(a * d) + Math.abs(b * c)))) return null;
  const inv = 1.0 / det;
  const ix = d * inv,
    iy = -b * inv;
  const jx = -c * inv,
    jy = a * inv;
  const xt = px - tx;
  const yt = py - ty;
  return [xt * ix + yt * jx, xt * iy + yt * jy];
}

/// A nine-sliced bundle draws its fills through a 3x3 cut table (target rect -> native rect, corners pinned), while the hit
/// geometry is the native curves: the point maps through the table's inverse first. `emPt` is in the bundle's drawn (target) units.
function throughNineSlice(bundle, emPt) {
  const g = bundle && bundle._nineSliceActive ? bundle._nineSliceGeom : null;
  return g ? nineSliceNativePoint(g, emPt[0], emPt[1]) : emPt;
}

/**
 * Topmost (front-most) shape index whose hit test passes for (px, py), or -1.
 *
 * THE DEFAULT MODEL IS SVG'S (`HitMode.Auto`; SVG 1.1 §16.4, SVG 2 interact.html `pointer-events`, CSS Masking). A point
 * hits a shape's FILL when it is inside the interior by the fill rule (nonzero / evenodd), and its STROKE when it is inside
 * the exact stroked outline (width, caps, joins, miter limit, dashes, non-scaling-stroke). The geometry is the bundle's
 * native curve data, tested exactly: there is no coverage, alpha or pixel threshold, and no `worldMatrix` is needed (a point is
 * in the bundle's own units, at any scale from 2^-20 to 2^20). Which regions answer is the shape's `pointer-events`,
 * resolved at import through the cascade (an inherited property; presentation attribute, style, stylesheet; `<use>`
 * instances included): visiblePainted (the default, also `auto`), visibleFill, visibleStroke, visible, painted, fill, stroke,
 * all, none, and `bounding-box` (the geometry box). `visibility` matters only to the `visible*` values; `display:none`
 * never hits. PAINTED MEANS PAINT != none, not alpha > 0: `fill="transparent"`, `fill-opacity:0`, `opacity:0` and a gradient
 * or pattern fill (its whole interior) are painted. opacity, fill-opacity, stroke-opacity, MASK, filter and blend modes never
 * change a result (SVG 2: pointer events are captured where a mask goes to zero); clip-path does (clipped areas receive no
 * pointer events). Shapes that draw nothing but can be targets live in the bundle's hit-only table (`bundle.hitOnly`) and answer
 * as index `numShapes + k`, in document order among the drawn rows. A marker is not a separate target, a text glyph answers by
 * its outline (not its character cell), and a sprite of a sheet answers at its authored position. `{ sprite }` (a sprite id or a
 * `[first, last]` shape range, as `drawSprite` takes) restricts the answer to the drawn rows of that sprite: a sprite under another one is
 * reachable, hit-only rows are not answered, and an unknown id or a bad range misses.
 *
 * TIES ARE INCLUSIVE. A point exactly on a fill edge hits, from every side (a point within 1e-6 of the shape's extent of a
 * boundary that has fill beside it), so shapes that abut on an edge both answer and the edge leaves no gap; a stroke
 * (distance at most half the width) and recognized circle / rect primitives are inclusive too.
 *
 * Other modes: `HitMode.Bbox` (the meta box), `HitMode.Coverage` (opt-in: RENDERED pixel coverage, as drawn: where a row's fill
 * is drawn, its exact coverage of the pixel box centered on the point reaches one half when a `worldMatrix` says what a pixel
 * is; where its stroke is drawn, the point is in the stroke band; opacity, mask and `minAlpha` apply and `pointer-events` is
 * ignored; nothing that draws nothing can hit), `HitMode.Outline` (the stroke band of every row with a width, whatever its
 * paint). `minAlpha` applies to those and is ignored by `Auto`.
 *
 * `bundle` is a bundle or an animation / text handle that owns one (its `.bundle` is tested). A non-finite `px` or `py`
 * misses, and so does a bundle with no shapes and no hit-only table. A morph is tested at its current pose with its
 * visibility table (or an explicit `overrides`); its hit-only table is the source bundle's until t = 0.5, then the
 * destination's. An override moves, rotates, scales, hides (visibility 0) or restrokes (absolute stroke width) the row it
 * addresses, its clip-path with it; its tint and absolute colors are paint and change nothing. A hit-only shape follows an
 * override table made for the bundle (its rows come after the drawn rows in `packedBuffer`) by id, by index and through the
 * group it sits in; a morph pose and a streaming update do not move it.
 *
 * A nine-sliced bundle (`applyNineSlice` / `nineSliceInstance`) is tested as it is drawn: the point is in the sliced (target) units and
 * is mapped back through the cut table to the native curves, outside the target rect by the pinned corner offset.
 *
 * `worldMatrix` (`renderer.bundleDrawMatrix(...)`) maps bundle units to pixels: `(px, py)` is then a pixel point. In `Auto` it
 * does not change a result except for `vector-effect: non-scaling-stroke`, whose band is a constant number of pixels wide.
 *
 * @param {object} bundle    createBundle output / sections / textRun output
 * @param {number} px
 * @param {number} py
 * @param {string|Object} [modeOrOpts]  HitMode string OR
 *   { mode, minAlpha, worldMatrix, overrides, sprite } opts bag (sprite: a sprite id or a [first, last] shape range restricts the answer to those drawn rows)
 * @param {number} [minAlpha]
 * @returns {number} shape index, or -1 on miss
 */
export function fillHitShape(bundle, px, py, modeOrOpts, minAlpha) {
  {
    const va = viewArgs(bundle, modeOrOpts, minAlpha);
    if (va) return fillHitShape(va[0], px, py, va[1]);
  }
  bundle = unwrapBundle(bundle);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return -1;
  if (spriteWindow(bundle, modeOrOpts) !== undefined) {
    const h = fillHits(bundle, px, py, modeOrOpts, minAlpha);
    return h.length ? h[0] : -1;
  }
  const opts = parseOpts(modeOrOpts, minAlpha);
  if (opts.mode === HitMode.Auto) return specQuery(bundle, px, py, opts, false);
  const morphPose = morphHitPose(bundle);
  const meta = (morphPose && morphPose.meta) || metaView(bundle);
  const n = shapeCount(bundle);
  if (!meta || n === 0) return -1;
  opts.overridesPacked = resolveOverridesPacked(bundle, opts);
  const stride = strideOf(bundle);
  const emPt0 = applyInverseWorld(opts.worldMatrix, px, py);
  if (!emPt0) return -1;
  const emPt = throughNineSlice(bundle, emPt0);
  const [emX, emY] = emPt;
  const geom = buildGeom(bundle, meta, n, stride, opts, morphPose);
  const colr = bundle.colrHit ? colrHitMaps(bundle.colrHit) : null;
  const paintOrder = bundle._drawOrder;
  const groupOpacities =
    opts.mode === HitMode.Coverage || (opts.mode === HitMode.Bbox && opts.minAlpha > 0)
      ? groupOpacitiesOf(meta, stride, n, paintOrder)
      : null;
  for (let i = n - 1; i >= 0; i--) {
    const row = paintOrder ? paintOrder[i] : i;
    if (hits(meta, stride, row, emX, emY, opts, geom, n, colr, groupOpacities))
      return colr && colr.owner.has(row) ? colr.owner.get(row) : row;
  }
  return -1;
}

/**
 * All hits in front-to-back paint order. Empty array on miss. Takes the arguments of `fillHitShape`.
 *
 * @param {object} bundle
 * @param {number} px
 * @param {number} py
 * @param {string|Object} [modeOrOpts]
 * @param {number} [minAlpha]
 * @returns {number[]}
 */
export function fillHits(bundle, px, py, modeOrOpts, minAlpha) {
  {
    const va = viewArgs(bundle, modeOrOpts, minAlpha);
    if (va) return fillHits(va[0], px, py, va[1]);
  }
  bundle = unwrapBundle(bundle);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return [];
  const win = spriteWindow(bundle, modeOrOpts);
  if (win !== undefined) {
    if (win === null) return [];
    const { sprite, ...rest } = modeOrOpts;
    return fillHits(bundle, px, py, rest, minAlpha).filter((i) => i >= win[0] && i <= win[1]);
  }
  const opts = parseOpts(modeOrOpts, minAlpha);
  if (opts.mode === HitMode.Auto) return specQuery(bundle, px, py, opts, true);
  const morphPose = morphHitPose(bundle);
  const meta = (morphPose && morphPose.meta) || metaView(bundle);
  const n = shapeCount(bundle);
  if (!meta || n === 0) return [];
  opts.overridesPacked = resolveOverridesPacked(bundle, opts);
  const stride = strideOf(bundle);
  const emPt0 = applyInverseWorld(opts.worldMatrix, px, py);
  if (!emPt0) return [];
  const emPt = throughNineSlice(bundle, emPt0);
  const [emX, emY] = emPt;
  const geom = buildGeom(bundle, meta, n, stride, opts, morphPose);
  const out = [];
  const colr = bundle.colrHit ? colrHitMaps(bundle.colrHit) : null;
  const paintOrder = bundle._drawOrder;
  const groupOpacities =
    opts.mode === HitMode.Coverage || (opts.mode === HitMode.Bbox && opts.minAlpha > 0)
      ? groupOpacitiesOf(meta, stride, n, paintOrder)
      : null;
  for (let i = n - 1; i >= 0; i--) {
    const row = paintOrder ? paintOrder[i] : i;
    if (hits(meta, stride, row, emX, emY, opts, geom, n, colr, groupOpacities)) {
      const who = colr && colr.owner.has(row) ? colr.owner.get(row) : row;
      if (out[out.length - 1] !== who) out.push(who);
    }
  }
  return out;
}

/**
 * Topmost hit's shape id, or null on miss. Useful for SVG-imported
 * bundles whose author tagged elements with id="…". Takes the arguments of `fillHitShape`.
 *
 * @param {object} bundle
 * @param {number} px
 * @param {number} py
 * @param {string|Object} [modeOrOpts]
 * @param {number} [minAlpha]
 * @returns {string|null}
 */
export function fillHitId(bundle, px, py, modeOrOpts, minAlpha) {
  {
    const va = viewArgs(bundle, modeOrOpts, minAlpha);
    if (va) return fillHitId(va[0], px, py, va[1]);
  }
  const idx = fillHitShape(bundle, px, py, modeOrOpts, minAlpha);
  if (idx < 0) return null;
  const b = unwrapBundle(bundle),
    ids = b?.shapeIds;
  if (b && idx >= shapeCount(b)) {
    // a hit-only region
    const ho = hitOnlyOf(b),
      row = ho && ho.rows[idx - shapeCount(b)];
    return row != null ? ho.shapeIds[row] || null : null;
  }
  return ids && idx < ids.length ? ids[idx] : null;
}

/**
 * The `<a href>` of the topmost hit: the href of the innermost `<a>` enclosing
 * the shape under (px, py) (`xlink:href` when `href` is absent), exactly as
 * authored. Takes the same arguments as `fillHitShape`, so the same
 * `worldMatrix` / mode / morph pose apply, and it is the TOPMOST shape that
 * answers: an unlinked shape painted over a link answers `''`.
 *
 * @param {object} bundle    createBundle output / importSvg sections
 * @param {number} px
 * @param {number} py
 * @param {string|Object} [modeOrOpts]  HitMode string OR
 *   { mode, minAlpha, worldMatrix, overrides, sprite } opts bag (sprite: a sprite id or a [first, last] shape range restricts the answer to those drawn rows)
 * @param {number} [minAlpha]
 * @returns {string|null} the href; `''` when the hit shape is in no anchor
 *   (or the bundle carries no `shapeHrefs`); `null` on a miss
 */
export function fillHitHref(bundle, px, py, modeOrOpts, minAlpha) {
  {
    const va = viewArgs(bundle, modeOrOpts, minAlpha);
    if (va) return fillHitHref(va[0], px, py, va[1]);
  }
  const idx = fillHitShape(bundle, px, py, modeOrOpts, minAlpha);
  if (idx < 0) return null;
  const b = unwrapBundle(bundle),
    hrefs = b?.shapeHrefs;
  if (b && idx >= shapeCount(b)) {
    const ho = hitOnlyOf(b),
      row = ho && ho.rows[idx - shapeCount(b)];
    return (row != null && ho.shapeHrefs && ho.shapeHrefs[row]) || '';
  }
  return hrefs && idx < hrefs.length && hrefs[idx] ? hrefs[idx] : '';
}
