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
  curveView, curveRangesOf, decodeSegs, dashView, emPerPxOf, pointOnStroke,
  JOIN_MITER, JOIN_MITER_CLIP,
} from './curveGeom.js';
import { pointInFill, pointInPrim } from './fillCoverage.js';

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
const META_STROKE_W  = 12;   // t3.x
const META_FILL_RULE = 13;   // t3.y: 1 = even-odd, else nonzero
const META_DASH_ID     = 15; // t3.w: 0 = no dashes, else dash-table row+1
const META_CAP_STYLE   = 24; // t6.x: 0 butt / 1 round / 2 square
const META_JOIN_STYLE  = 25; // t6.y: 0 miter / 1 round / 2 bevel
const META_MITER_LIMIT = 26; // t6.z
const META_FLAGS_SHAPE = 27; // t6.w: shape flag bits
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

/** Build the geometry context once per query (null ⇒ bbox-only path). */
function buildGeom(bundle, meta, n, stride, opts) {
  if (opts.mode === HitMode.Bbox) return null;
  const cv = curveView(bundle);
  if (!cv) return null;
  return {
    curveF32: cv,
    ranges: curveRangesOf(bundle, meta, n, stride, cv.length),
    cache: new Array(n),
    dashF: dashView(bundle),
    emPerPx: emPerPxOf(opts.worldMatrix),
  };
}

function hits(meta, stride, i, px, py, opts, geom) {
  const off = i * stride;
  const mode = opts.mode, minAlpha = opts.minAlpha;
  const emPerPx = geom ? geom.emPerPx : 1;
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
    if (minAlpha > 0 && meta[off + META_FILL_A] < minAlpha) return false;
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

  const fillA   = meta[off + META_FILL_A];
  const strokeA = meta[off + META_STROKE_A];
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
      if (prim < 0 && pointInFill(getSegs(), px, py, evenOdd)) return true;
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
      if (pointOnStroke(getSegs(), px, py, halfW, cap, join, miter, geom.dashF, dashId)) return true;
    }
  }
  return false;
}

/**
 * Resolve the (mode, minAlpha, worldMatrix) tuple from either form:
 *   - Legacy: fillHitShape(bundle, px, py, mode, minAlpha)
 *   - New: fillHitShape(bundle, px, py, { mode, minAlpha, worldMatrix })
 * @param {string|object|undefined} a4
 * @param {number|undefined} a5
 */
function parseOpts(a4, a5) {
  if (a4 != null && typeof a4 === 'object') {
    return {
      mode:        a4.mode || HitMode.Auto,
      minAlpha:    typeof a4.minAlpha === 'number' ? a4.minAlpha : 0,
      worldMatrix: a4.worldMatrix || null,
    };
  }
  return {
    mode:     a4 == null ? HitMode.Auto : a4,
    minAlpha: typeof a5 === 'number' ? a5 : 0,
    worldMatrix: null,
  };
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
 * @param {object} bundle    createBundle output / sections / textRun output
 * @param {number} px
 * @param {number} py
 * @param {string|Object} [modeOrOpts]  HitMode string OR
 *   { mode, minAlpha, worldMatrix } opts bag
 * @param {number} [minAlpha]
 * @returns {number} shape index, or -1 on miss
 */
export function fillHitShape(bundle, px, py, modeOrOpts, minAlpha) {
  const meta = metaView(bundle);
  const n = shapeCount(bundle);
  if (!meta || n === 0) return -1;
  const opts = parseOpts(modeOrOpts, minAlpha);
  const stride = strideOf(bundle);
  const emPt = applyInverseWorld(opts.worldMatrix, px, py);
  if (!emPt) return -1;
  const [emX, emY] = emPt;
  const geom = buildGeom(bundle, meta, n, stride, opts);
  for (let i = n - 1; i >= 0; i--) {
    if (hits(meta, stride, i, emX, emY, opts, geom)) return i;
  }
  return -1;
}

/**
 * All hits in front-to-back paint order. Empty array on miss.
 */
export function fillHits(bundle, px, py, modeOrOpts, minAlpha) {
  const meta = metaView(bundle);
  const n = shapeCount(bundle);
  if (!meta || n === 0) return [];
  const opts = parseOpts(modeOrOpts, minAlpha);
  const stride = strideOf(bundle);
  const emPt = applyInverseWorld(opts.worldMatrix, px, py);
  if (!emPt) return [];
  const [emX, emY] = emPt;
  const geom = buildGeom(bundle, meta, n, stride, opts);
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
