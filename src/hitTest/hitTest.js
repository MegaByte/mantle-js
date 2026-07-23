// hitTest.js — point-in-shape queries against a Mantle bundle.
//
// Bundle input shape: same `sections` dict createBundle takes, OR
// the bundle object createBundle returns (we read .numShapes,
// .metaFloatsPerShape, and a Float32Array view over meta).
//
// Coverage / Outline test the bundle's native curve geometry analytically —
// no flattening/tessellation, matching the renderer's contract (ray-cast the
// true quad/cubic/arc; arcs preserved end-to-end). Fill = exact signed
// ray-crossings (roots of curve_y = ray_y); stroke = exact min point→curve
// distance (critical points = roots of d/dt|curve−P|²). Root-finding reuses
// the path-boolean solvers.

import {
  curveView, bandView, curveRangesOf, decodeSegs, dashView, emPerPxOf, pointOnStroke, closest,
  JOIN_MITER, JOIN_MITER_CLIP,
} from './curveGeom.js';
import { pointInFill, pointInPrim, buildFillTree } from './fillCoverage.js';
import { treeCollectNear } from '../renderer/windingTree.js';
import { bandFillCoverage } from './bandWinding.js';
import { arcRecordToCenter, rebuildJoinTangents } from '../core/morphCore.js';

export const HitMode = Object.freeze({
  /** AABB only. Cheap. */
  Bbox:     'bbox',
  /** Winding ray-cast on the shape's fill curves. */
  Coverage: 'coverage',
  /** Stroke band: within strokeWidth/2 of the shape's curves. */
  Outline:  'outline',
  /** Bbox cull, then fill-if-filled OR stroke-if-stroked (per the shape).
   *  The "just works" mode for mixed fill / outline scenes. Falls back to
   *  Bbox when the bundle carries no curve geometry. */
  Auto:     'auto',
});

const META_BBOX_XMIN = 0;
const META_BBOX_YMIN = 1;
const META_BBOX_XMAX = 2;
const META_BBOX_YMAX = 3;
const META_FILL_A    = 7;
const META_STROKE_A  = 11;   // t2.w

// Meta slots createShapeMorph lerps (must match shapeMorph.MORPH_LERP_SLOTS).
const MORPH_LERP_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 36, 37, 38, 39];
const _morphHitCache = new WeakMap(); // bundle → { t, curve, meta, ranges }
const META_STROKE_W  = 12;   // t3.x
const META_FILL_RULE = 13;   // t3.y: 1 = even-odd, else nonzero
const META_DASH_ID     = 15; // t3.w: 0 = no dashes, else dash-table row+1
const META_CAP_STYLE   = 24; // t6.x: 0 butt / 1 round / 2 square
const META_JOIN_STYLE  = 25; // t6.y: 0 miter / 1 round / 2 bevel
const META_MITER_LIMIT = 26; // t6.z
const META_FLAGS_SHAPE = 27; // t6.w: shape flag bits
const META_GLYPH_BAND  = 16; // t4: (glyphLoc.x, glyphLoc.y, bandMaxX, bandMaxY)
const FS_NON_SCALING_STROKE = 1 << 0; // vector-effect: non-scaling-stroke

/**
 * Get a Float32Array view of the bundle's per-shape meta rows.
 * Handles both:
 *   • `sections`-shape (meta is an ArrayBuffer with 32-byte header)
 *   • bundle-shape (createBundle output — exposes metaFloats directly)
 *   • textRun output (metaFloats Float32Array, no header)
 */
function metaView(bundle) {
  if (!bundle) return null;
  if (bundle.metaFloats instanceof Float32Array) return bundle.metaFloats;
  if (bundle.meta && bundle.meta.byteLength != null) {
    // sections-shape — 32-byte header, then per-shape floats.
    return new Float32Array(bundle.meta, 32);
  }
  return null;
}

/**
 * CPU pose for hit-testing a morphing bundle at its current `t`.
 * createShapeMorph updates GPU textures (and may skip CPU uploads entirely
 * on the LB route); hit tests read CPU curve/meta planes, so without this
 * they always evaluate the t=0 pose.
 */
function morphHitPose(bundle) {
  const ms = bundle && bundle._morphSrc;
  if (!ms || !ms.mergedCurveF32 || !ms.dstCurveF32) return null;
  const t = +ms.t || 0;
  if (!(t > 0)) return null; // t=0 → authored src planes already on the bundle
  let c = _morphHitCache.get(bundle);
  if (c && c.t === t) return c;

  const srcC = (ms.srcEpCurveF32 && ms.arcOffsets && ms.arcOffsets.length)
    ? ms.srcEpCurveF32 : ms.mergedCurveF32;
  const dstC = (ms.dstEpCurveF32 && ms.arcOffsets && ms.arcOffsets.length)
    ? ms.dstEpCurveF32 : ms.dstCurveF32;
  const curve = (c && c.curve && c.curve.length === srcC.length)
    ? c.curve : new Float32Array(srcC.length);
  curve.set(srcC);
  if (t >= 1) {
    curve.set(dstC);
  } else {
    const ti = 1 - t;
    // Matched spans only — unmatched regions stay at src (fade handles visibility).
    const ranges = ms.curveRanges || [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (!r) continue;
      for (let j = r.begin; j < r.end; j++)
        curve[j] = srcC[j] * ti + dstC[j] * t;
    }
  }
  if (ms.arcOffsets && ms.arcOffsets.length) {
    for (let i = 0; i < ms.arcOffsets.length; i++) arcRecordToCenter(curve, ms.arcOffsets[i]);
  }
  if (ms.joinTable && ms.joinTable.length) rebuildJoinTangents(curve, ms.joinTable);

  const srcM = ms.mergedMetaF32;
  const dstM = ms.dstMetaF32;
  const stride = ms.metaStride | 0;
  let meta = null;
  if (srcM && dstM && stride) {
    meta = (c && c.meta && c.meta.length === srcM.length) ? c.meta : new Float32Array(srcM.length);
    meta.set(srcM);
    if (t >= 1) {
      meta.set(dstM);
    } else {
      const ti = 1 - t;
      const idxs = ms.matchedSrcIdxs;
      if (idxs && idxs.length) {
        for (let k = 0; k < idxs.length; k++) {
          const base = idxs[k] * stride;
          for (let s = 0; s < MORPH_LERP_SLOTS.length; s++) {
            const o = base + MORPH_LERP_SLOTS[s];
            meta[o] = srcM[o] * ti + dstM[o] * t;
          }
        }
      } else {
        for (let o = 0; o < meta.length; o++) meta[o] = srcM[o] * ti + dstM[o] * t;
      }
    }
  }

  const pose = {
    t,
    curve,
    meta,
    ranges: ms.curveRanges || null,
  };
  _morphHitCache.set(bundle, pose);
  return pose;
}

function shapeCount(bundle) {
  if (bundle == null) return 0;
  if (typeof bundle.numShapes === 'number') return bundle.numShapes;
  return 0;
}

function strideOf(bundle) {
  if (typeof bundle.metaFloatsPerShape === 'number' && bundle.metaFloatsPerShape > 0)
    return bundle.metaFloatsPerShape;
  return 48;  // v3 default
}

/** Per-bundle geometry cache. The decoded-seg cache + curve view +
 *  ranges are pure functions of the bundle's geometry, keyed on
 *  `_geomGen` (bumped by every streaming/nine-slice rewrite) — without
 *  it, pointer-move hit testing re-decoded every shape's segments (and,
 *  for sections bundles, re-copied the whole curve plane) per event.
 *  Morph pose adds `morphT` so setT invalidates without a geom bump. */
const _geomCache = new WeakMap();

/** Build (or reuse) the geometry context per query (null ⇒ bbox-only path). */
function buildGeom(bundle, meta, n, stride, opts, morphPose) {
  if (opts.mode === HitMode.Bbox) return null;
  const gen = bundle._geomGen | 0;
  const morphT = morphPose ? morphPose.t : -1;
  let c = _geomCache.get(bundle);
  if (!c || c.gen !== gen || c.n !== n || c.morphT !== morphT) {
    const cv = morphPose ? morphPose.curve : curveView(bundle);
    if (!cv) return null;
    c = {
      gen, n, morphT,
      curveF32: cv,
      ranges: curveRangesOf(bundle, meta, n, stride, cv.length),
      cache: new Array(n),
      trees: new Array(n),
      memo: new Array(n),
      bandF: morphPose ? null : bandView(bundle), // bands are not morphed; fall back to seg walk
      dashF: dashView(bundle),
    };
    _geomCache.set(bundle, c);
  }
  return {
    curveF32: c.curveF32,
    ranges: c.ranges,
    cache: c.cache,
    trees: c.trees,
    memo: c.memo,
    bandF: c.bandF,
    dashF: c.dashF,
    emPerPx: emPerPxOf(opts.worldMatrix),
  };
}

function hits(meta, stride, i, px, py, opts, geom) {
  const off = i * stride;
  const mode = opts.mode, minAlpha = opts.minAlpha;
  const emPerPx = geom ? geom.emPerPx : 1;
  // Override visibility / tint alpha (morph fade-in/out, runtime hide).
  let alphaScale = 1;
  const ov = opts.overridesPacked;
  if (ov) {
    const ob = i * 24;
    if (ob + 11 < ov.length) {
      alphaScale = ov[ob + 6] * ov[ob + 11]; // visibility × tint.a
      if (alphaScale <= 0.004) return false;
    }
  }
  // Bbox cull (cheap reject). A miter join can extend up to halfW·miterLimit
  // past a vertex — beyond the round meta-bbox — so widen the cull there;
  // the miter test itself then decides the exact spike region. For
  // non-scaling-stroke the em-space band is halfW·emPerPx, so it can also
  // exceed the baked (nominal) bbox on zoom-out — widen by that excess too.
  let mx = 0;
  if (mode === HitMode.Outline || mode === HitMode.Auto) {
    const sw = meta[off + META_STROKE_W];
    if (sw > 0) {
      const nonScaling = (Math.round(meta[off + META_FLAGS_SHAPE]) & FS_NON_SCALING_STROKE) !== 0;
      const hw = sw * 0.5 * (nonScaling ? emPerPx : 1);
      if ((meta[off + META_JOIN_STYLE] | 0) === JOIN_MITER
          || (meta[off + META_JOIN_STYLE] | 0) === JOIN_MITER_CLIP)
        mx = hw * Math.max(1, meta[off + META_MITER_LIMIT] || 4);
      if (nonScaling && emPerPx > 1) mx = Math.max(mx, hw);
    }
  }
  if (px < meta[off + META_BBOX_XMIN] - mx || px > meta[off + META_BBOX_XMAX] + mx ||
      py < meta[off + META_BBOX_YMIN] - mx || py > meta[off + META_BBOX_YMAX] + mx) return false;

  // Bbox mode, or geometry unavailable → legacy bbox + flat-alpha behavior.
  if (mode === HitMode.Bbox || !geom || !geom.ranges[i]) {
    if (minAlpha > 0 && meta[off + META_FILL_A] * alphaScale < minAlpha) return false;
    return true;
  }

  // Decode the native segs lazily — a pure-fill simple-shape primitive
  // (circle / rect / roundRect) answers the fill test from the analytic SDF
  // and never touches the curve buffer.
  let segs;
  const getSegs = () => {
    if (segs !== undefined) return segs;
    segs = geom.cache[i];
    if (segs === undefined)
      segs = geom.cache[i] = decodeSegs(geom.curveF32, geom.ranges[i].begin, geom.ranges[i].end,
                                        meta[off + META_JOIN_STYLE] | 0);
    return segs;
  };
  // Winding tree, lazily built and cached with the decoded segs: turns the O(N)-per-query
  // fill walk / stroke closest-point scan into O(log N + near) on segment-heavy shapes with
  // IDENTICAL results (buildFillTree returns null below its cutoff — the plain loop wins
  // there). `null` is cached too, so the cutoff decision runs once.
  const getTree = () => {
    let t = geom.trees[i];
    if (t === undefined) t = geom.trees[i] = buildFillTree(getSegs());
    return t;
  };

  const fillA   = meta[off + META_FILL_A] * alphaScale;
  const strokeA = meta[off + META_STROKE_A] * alphaScale;
  let   halfW   = meta[off + META_STROKE_W] * 0.5;
  // Non-scaling-stroke: the rendered band is a constant SCREEN width, so in
  // em-space it is halfW·emPerPx.
  if ((Math.round(meta[off + META_FLAGS_SHAPE]) & FS_NON_SCALING_STROKE) !== 0)
    halfW *= emPerPx;
  const evenOdd = (meta[off + META_FILL_RULE] | 0) === 1;

  // Fill winding — Coverage always; Auto only when the shape is filled.
  if (mode === HitMode.Coverage || (mode === HitMode.Auto && fillA > 0)) {
    if (minAlpha <= 0 || fillA >= minAlpha) {
      const prim = pointInPrim(meta, off, px, py);   // 1 in / 0 out / -1 n.a.
      if (prim === 1) return true;
      if (prim < 0) {
        // POINTER-COHERENCE MEMO: the last real query cached its answer with a clear
        // radius (the distance to the nearest boundary) — any query inside that disc has
        // the same fill answer with zero geometry work. Pointer streams move a few px per
        // event, so interior/exterior glides cost one real query per boundary crossing.
        const memo = geom.memo[i];
        let fillHit;
        if (memo && (px - memo.x) * (px - memo.x) + (py - memo.y) * (py - memo.y) < memo.r * memo.r) {
          fillHit = memo.hit;
        } else {
          // THE RENDER'S ANSWER: walk the bundle's own band + curve tables exactly like
          // the shader's fill walk (bandWinding.js) — a point is hit when the drawn
          // coverage reaches the edge midline. Falls back to the f64 segment walk only
          // when the bundle carries no band data.
          if (geom.bandF) {
            const ppe = 1 / Math.max(emPerPx, 1e-12);
            const cov = bandFillCoverage(geom.bandF, geom.curveF32,
              [meta[off + META_GLYPH_BAND], meta[off + META_GLYPH_BAND + 1],
               meta[off + META_GLYPH_BAND + 2], meta[off + META_GLYPH_BAND + 3]],
              [meta[off + META_BBOX_XMIN], meta[off + META_BBOX_YMIN],
               meta[off + META_BBOX_XMAX], meta[off + META_BBOX_YMAX]],
              px, py, ppe, ppe, evenOdd);
            fillHit = cov >= 0.5;
          } else {
            fillHit = pointInFill(getSegs(), px, py, evenOdd, getTree());
          }
          // clear radius from the winding tree (big shapes only — where queries cost):
          // segments beyond the collect radius are farther than the cap by construction.
          const tree = getTree();
          if (tree) {
            const cap = 6 * emPerPx;
            const near = treeCollectNear(tree, px, py, cap, []);
            let rMin = cap;
            const ss = getSegs();
            for (const k of near) {
              const cc = closest(ss[k], px, py);
              const dd = Math.sqrt(cc.d2);
              if (dd < rMin) rMin = dd;
            }
            geom.memo[i] = { x: px, y: py, hit: fillHit, r: Math.max(0, rMin * 0.98) };
          }
        }
        if (fillHit) return true;
      }
      // prim === 0: analytically outside the fill; fall through to stroke.
    }
  }
  // Stroke band — Outline always; Auto only when the shape is stroked.
  if (mode === HitMode.Outline || (mode === HitMode.Auto && strokeA > 0)) {
    if (halfW > 0 && (minAlpha <= 0 || strokeA >= minAlpha)) {
      const cap = meta[off + META_CAP_STYLE] | 0;
      const join = meta[off + META_JOIN_STYLE] | 0;
      const miter = meta[off + META_MITER_LIMIT] || 4;
      const dashId = Math.round(meta[off + META_DASH_ID]) | 0;
      // Tree-pruned stroke test on big shapes: only segments whose bounding circle comes
      // within the band's worst reach (miter joins extend to halfW * miterLimit) can answer.
      let strokeSegs = getSegs();
      const tree = getTree();
      if (tree) {
        const reach = halfW * Math.max(2, miter);
        const near = treeCollectNear(tree, px, py, reach, []);
        strokeSegs = near.map((k) => strokeSegs[k]);
      }
      if (pointOnStroke(strokeSegs, px, py, halfW, cap, join, miter, geom.dashF, dashId)) return true;
    }
  }
  return false;
}

/**
 * Resolve the (mode, minAlpha, worldMatrix, overrides) tuple from either form:
 *   - Legacy: fillHitShape(bundle, px, py, mode, minAlpha)
 *   - New: fillHitShape(bundle, px, py, { mode, minAlpha, worldMatrix, overrides })
 * @param {string|object|undefined} a4
 * @param {number|undefined} a5
 */
function parseOpts(a4, a5) {
  if (a4 != null && typeof a4 === 'object') {
    return {
      mode:        a4.mode || HitMode.Auto,
      minAlpha:    typeof a4.minAlpha === 'number' ? a4.minAlpha : 0,
      worldMatrix: a4.worldMatrix || null,
      overrides:   a4.overrides || null,
    };
  }
  return {
    mode:     a4 == null ? HitMode.Auto : a4,
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
  const a = world[0], b = world[1];   // m00, m10
  const c = world[3], d = world[4];   // m01, m11
  const tx = world[6], ty = world[7]; // m02, m12
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1.0 / det;
  const ix =  d * inv, iy = -b * inv;
  const jx = -c * inv, jy =  a * inv;
  const xt = px - tx;
  const yt = py - ty;
  return [xt * ix + yt * jx, xt * iy + yt * jy];
}

/**
 * Topmost (front-most) shape index whose hit test passes for
 * (px, py). When `opts.worldMatrix` is provided the point is first
 * inverse-transformed back into em-space; otherwise
 * the point is treated as em-space.
 *
 * Morphing bundles (`createShapeMorph`) are tested at the current morph `t`.
 * Pass `overrides` (or rely on the morph's table) so fade visibility is honored.
 *
 * @param {object} bundle    createBundle output / sections / textRun output
 * @param {number} px
 * @param {number} py
 * @param {string|Object} [modeOrOpts]  HitMode string OR
 *   { mode, minAlpha, worldMatrix, overrides } opts bag
 * @param {number} [minAlpha]
 * @returns {number} shape index, or -1 on miss
 */
export function fillHitShape(bundle, px, py, modeOrOpts, minAlpha) {
  const morphPose = morphHitPose(bundle);
  const meta = (morphPose && morphPose.meta) || metaView(bundle);
  const n = shapeCount(bundle);
  if (!meta || n === 0) return -1;
  const opts = parseOpts(modeOrOpts, minAlpha);
  opts.overridesPacked = resolveOverridesPacked(bundle, opts);
  const stride = strideOf(bundle);
  const emPt = applyInverseWorld(opts.worldMatrix, px, py);
  if (!emPt) return -1;
  const [emX, emY] = emPt;
  const geom = buildGeom(bundle, meta, n, stride, opts, morphPose);
  for (let i = n - 1; i >= 0; i--) {
    if (hits(meta, stride, i, emX, emY, opts, geom)) return i;
  }
  return -1;
}

/**
 * All hits in front-to-back paint order. Empty array on miss.
 */
export function fillHits(bundle, px, py, modeOrOpts, minAlpha) {
  const morphPose = morphHitPose(bundle);
  const meta = (morphPose && morphPose.meta) || metaView(bundle);
  const n = shapeCount(bundle);
  if (!meta || n === 0) return [];
  const opts = parseOpts(modeOrOpts, minAlpha);
  opts.overridesPacked = resolveOverridesPacked(bundle, opts);
  const stride = strideOf(bundle);
  const emPt = applyInverseWorld(opts.worldMatrix, px, py);
  if (!emPt) return [];
  const [emX, emY] = emPt;
  const geom = buildGeom(bundle, meta, n, stride, opts, morphPose);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    if (hits(meta, stride, i, emX, emY, opts, geom)) out.push(i);
  }
  return out;
}

/**
 * Topmost hit's shape id, or null on miss. Useful for SVG-imported
 * bundles whose author tagged elements with id="…".
 */
export function fillHitId(bundle, px, py, modeOrOpts, minAlpha) {
  const idx = fillHitShape(bundle, px, py, modeOrOpts, minAlpha);
  if (idx < 0) return null;
  const ids = bundle && bundle.shapeIds;
  return (ids && idx < ids.length) ? ids[idx] : null;
}
