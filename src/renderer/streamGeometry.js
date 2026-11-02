// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, resourceGeneration } from './contextResources.js';
import { uploadTableRows } from './tableLayout.js';
import { noteExternalGlWrite } from '../core/glEpoch.js';
import { unwrapBundle } from '../core/unwrapBundle.js';
import { warnHitOnlyStatic } from '../core/diagnostics.js';
// In-place geometry updates with fixed shape count and stable shape IDs.
// Full updates rebuild curve/band/meta planes and cover geometry. Lightweight
// updates rebuild packed LB meshes; CPU curve mirrors remain at the last full
// update, so CPU hit tests require the full path. Auxiliary geometry outside
// the supported scope returns a refusal. Geometry changes retire occupancy
// grids and occlusion results.
/** @typedef {{type:number,p1:number[],p2?:number[],p3?:number[],p4?:number[]}} Seg */

import { claimFillMeshes, releaseFillMeshes, MESH_OWNER } from './fillMeshOwner.js';
import { makeTexelBuffer, texelAppend, buildTexturesShape, texelToBytes } from '../svg/textures.js';
import { pathBbox } from '../svg/bbox.js';
import { transformSegInto } from '../svg/transform.js';
import { pickBandsXY, makeBuildContext, emitShape } from '../svg/buildContext.js';
import { packMetaBody } from '../svg/meta.js';
import {
  META_CLIP_ID,
  META_DASH_ID,
  META_FILTER_ID,
  META_MASK_ID,
  META_STROKE_A,
  META_STROKE_GRAD,
  META_STROKE_IMAGE_ID,
  META_STROKE_W,
  META_PRIM_KIND,
  META_END_CAP_OR_RX,
  FS_DASH_SEAM,
  stampMetaHeader,
} from '../bundle/layout.js';

/// WHAT v1 CANNOT STREAM, asked of the meta rows.

/// The row is the truth: a stroke that will be drawn has width AND alpha, and a clip, mask, filter
/// or dash is an id. Returns a reason string, or null when the bundle is in scope.
function outOfStreamScope(bundle) {
  const meta = bundle.metaFloats,
    st = bundle.metaFloatsPerShape | 0,
    n = bundle.numShapes | 0;
  if (!meta || !st) return null;
  for (let s = 0; s < n; s++) {
    const o = s * st;
    if (meta[o + META_STROKE_W] > 0 && meta[o + META_STROKE_A] > 0) return 'a shape is stroked';
    if (meta[o + META_STROKE_GRAD] > 0 || meta[o + META_STROKE_IMAGE_ID] > 0)
      return 'a shape has a painted stroke';
    if (meta[o + META_CLIP_ID] > 0) return 'a shape is clipped';
    if (meta[o + META_MASK_ID] > 0) return 'a shape is masked';
    if (meta[o + META_DASH_ID] > 0) return 'a shape is dashed';
    if (meta[o + META_FILTER_ID] > 0) return 'a shape is filtered';
  }
  return null;
}
import { metaStrokeReachFactor } from '../bundle/strokeReach.js';
const DRIVEN_GEOMETRY = Symbol('driven geometry');
export function updateDrivenGeometry(gl, bundle, perShapeSegs) {
  const frame = bundle.globalBBox && bundle.globalBBox.slice();
  const result = updateBundleGeometry(
    gl,
    bundle,
    perShapeSegs,
    Object.assign({ lightweight: false }, { [DRIVEN_GEOMETRY]: true }),
  );
  if (frame) bundle.globalBBox = frame;
  return result;
}

import { getCoverQuadMesh } from '../svg/mesh.js';
import { makeTex, buildDrawList } from './bundle.js';
import {
  parseCoverQuadChunks,
  buildShapeIdxFloats,
  buildStrippedCoverQuad,
} from './coverQuadChunks.js';
import { buildLbShape } from './lbBuildCore.js';
import { contoursFromSegs } from '../geom/lbContour.js';
import { segsToPathD } from '../svg/segment.js';

// Synthesize an SVG source for a streamable bundle (one <path> per shape, in
// shape-index order) so the no-WebGL native scene (createNativeScene) — which
// renders by cloning a bundle's svgSource — can draw it. Programmatic
// streamable bundles otherwise carry no markup and the native path throws
// ("bundle has no svgSource"). Per-frame geometry then streams in via
// updateNativeBundleGeometry (per-shape pathD overrides). Order matches shape
// index so the native scene's positional addressing lines up on id-less art.
function rgbaCss(c) {
  if (!c) return 'none';
  const r = Math.round((c[0] || 0) * 255),
    g = Math.round((c[1] || 0) * 255),
    b = Math.round((c[2] || 0) * 255);
  const a = c[3] == null ? 1 : c[3];
  return `rgba(${r},${g},${b},${a})`;
}
function xmlEscapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function synthStreamSvgSource(shapes, fixedBBox, shapeIds) {
  const bb = fixedBBox && fixedBBox.length === 4 ? fixedBBox : [0, 0, 1, 1];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb[0]} ${bb[1]} ${bb[2]} ${bb[3]}">`;
  for (let i = 0; i < shapes.length; i++) {
    let d = '';
    try {
      d = segsToPathD(shapes[i].segs) || '';
    } catch {
      d = '';
    }
    const id = shapeIds && shapeIds[i] ? xmlEscapeAttr(shapeIds[i]) : 's' + i;
    out += `<path id="${id}" d="${xmlEscapeAttr(d)}" fill="${rgbaCss(shapes[i].fill)}"/>`;
  }
  return out + '</svg>';
}

// Shared sentinel for a stream section the analytic fill can't serve (arc /
// loop / cusp / degenerate) — read-only marker (checked via `.slug`), so one
// frozen singleton is reused across all shapes + bundles (no per-frame alloc).
const STREAM_SLUG = Object.freeze({ slug: true });

const TEX_W = 4096; // curve/band texture row width (mirror bundle.js)
const FULL_META_W = 12; // texels per shape in the meta texture (v3+)
const META_STRIDE = FULL_META_W * 4; // 48 floats per shape
const META_TEXEL_4 = 16; // float offset of texel 4 (glyphLoc.x) in a row
const COVER_QUAD_STRIDE = 12; // floats per cover-quad vertex (mirror buildContext)

/// Downcast a Float64-backed texel buffer to a row-padded Float32 plane
/// (TEX_W texels wide, height rounded up to a full row) exactly as
/// createBundle uploads it. `unpadded` is the unpadded float count.
function toPaddedPlane(buf) {
  const unpadded = buf.count * 4;
  const h = Math.max(1, Math.ceil(unpadded / (4 * TEX_W)));
  const padded = new Float32Array(h * 4 * TEX_W);
  padded.set(buf.floats.subarray(0, unpadded)); // Float64 → Float32 narrow
  return { padded, height: h, unpadded };
}

/// Allocated row height of a plane whose UNPADDED float count is `n`.
function planeRows(n) {
  return Math.max(1, Math.ceil(n / (4 * TEX_W)));
}

/**
 * Stream new geometry into an existing bundle in place.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} bundle  a createBundle() output (mutated in place)
 * @param {Array<Array<Seg>>} perShapeSegs  one segment list per shape,
 *        length === bundle.numShapes; each shape's segments in the same
 *        importer-native form pathBbox/buildTexturesShape consume.
 * @returns {{ok:boolean, reason?:string, reallocated?:boolean}}
 *   ok:false → caller should fall back to a full importSvg→createBundle.
 *   reallocated:true → a plane grew past its texture and the bundle's
 *   curveTex/bandTex handle was swapped (the renderer re-reads the
 *   handle from the bundle each pass, so no rebind is needed).
 */
/**
 * Build a `createBundle`-ready sections dict from raw per-shape segment
 * lists — the companion to `updateBundleGeometry`. A bundle built this way
 * uses the exact chunked-hybrid-mesh layout the in-place streamer
 * regenerates. Imported bundles can also stream when their metadata and
 * features pass `updateBundleGeometry`'s scope checks.
 *
 * @param {Array<{segs: Array<Seg>, fill: [number,number,number,number]}>} shapes
 *        one solid-fill shape per entry. `segs` is the importer-native
 *        segment list (mkLine/mkQuad/mkCubic); keep the count/types stable
 *        across the matching `updateBundleGeometry` calls.
 * @param {[number,number,number,number]} [fixedBBox]  pin the bundle's
 *        global bbox to `[x,y,w,h]` (e.g. a viewport) instead of deriving it
 *        tight from the shapes — keeps mount placement stable for screen-
 *        space scenes. `updateBundleGeometry` keeps a pinned box; without
 *        one it moves globalBBox to the streamed content bounds.
 * @returns {object} a sections dict for `createBundle(gl, sections)`.
 */
export function buildStreamableSections(shapes, fixedBBox, opts = {}) {
  const ctx = makeBuildContext({ curve64: false });
  // opts.origin ([x, y]): store the shapes relative to it, as the importer does for far art (bundle/layout.js). `shapes` and
  // `fixedBBox` stay in document coordinates; updateBundleGeometry takes document coordinates too and moves them by the bundle's origin.
  const origin =
    opts.origin && (opts.origin[0] !== 0 || opts.origin[1] !== 0)
      ? [+opts.origin[0], +opts.origin[1]]
      : null;
  const shapesDoc = shapes;
  if (origin)
    shapes = segsInBundleFrame(
      shapes.map((sh) => sh.segs),
      origin,
    ).map((segs, i) => ({ ...shapesDoc[i], segs }));
  const gidBox = { next: 1 };
  const bb = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  // lightweight: build for the GPU-resident analytic fill — skip the Slug
  // cover-quad mesh entirely (the analytic stream builds its own). The
  // resulting bundle carries no fill cover-quads, so a handle never uploads a
  // Slug VBO that could go stale; it MUST be streamed via
  // updateBundleGeometry(…, { lightweight:true }) and rendered through the
  // analytic route.
  const skipCoverQuad = !!opts.lightweight;
  for (let i = 0; i < shapes.length; i++) {
    emitShape(ctx, shapes[i].segs, { fillRgba: shapes[i].fill, skipCoverQuad }, gidBox, bb);
  }
  const body = packMetaBody(ctx.metas);
  const meta = new ArrayBuffer(32 + body.byteLength);
  const dv = new DataView(meta);
  dv.setUint32(0, ctx.metas.length, true);
  stampMetaHeader(dv, origin);
  const bx = fixedBBox ? fixedBBox[0] - (origin ? origin[0] : 0) : bb.xmin;
  const by = fixedBBox ? fixedBBox[1] - (origin ? origin[1] : 0) : bb.ymin;
  const bw = fixedBBox ? fixedBBox[2] : bb.xmax - bb.xmin;
  const bh = fixedBBox ? fixedBBox[3] : bb.ymax - bb.ymin;
  dv.setFloat32(4, bx, true);
  dv.setFloat32(8, by, true);
  dv.setFloat32(12, bw, true);
  dv.setFloat32(16, bh, true);
  new Uint8Array(meta, 32).set(body);
  // each SHAPE'S CURVE RANGE, from the write heads emitShape stamped -- the rule updateBundleGeometry's
  // full rebuild applies (each range ends where the next begins). Without it createBundle inferred the
  // ranges from meta texel 4, a BAND index, so until the first full update every CPU reader of the
  // curve table -- the static Loop-Blinn build, hit testing, a morph -- read shape 0 from the sentinel
  // texel and every other shape from the wrong offset.
  const curveTotal = ctx.curveBuf.count * 4;
  const curveRangesByShape = ctx.metas.map((m, i) => ({
    begin: m._curveStartF | 0,
    end: (i + 1 < ctx.metas.length ? ctx.metas[i + 1]._curveStartF : curveTotal) | 0,
  }));
  return {
    flags: 7, // HYBRID_MESH_IN_CGEOM | HYBRID_MESH_CHUNKED | WIDE_BAND_HEADERS
    ...(origin ? { origin } : {}),
    streamable: true, // skip creation-time LB auto-prepare: the stream path owns builds
    frameFixed: !!fixedBBox, // an update keeps this globalBBox
    curveRangesByShape,
    numShapes: ctx.metas.length,
    metaFloatsPerShape: 48,
    meta,
    curves: texelToBytes(ctx.curveBuf).buffer,
    bands: texelToBytes(ctx.bandBuf).buffer,
    curveGeom: new Float32Array(ctx.hybridFloats).buffer,
    shapeIds: ctx.shapeIds.slice(),
    // the import's own per-bundle counts, which createBundle derives segTypeMask and meanSegsPerShape from: a
    // streamable bundle read "every type" and 0 segments a shape, so typeOmit kept every kernel and the LB size gate
    // saw no segments; updateBundleGeometry keeps both current (refreshDerivedStats), the mask as a union
    segTypeMask: ctx.segTypeMask | 0,
    totalSegments: ctx.totalSegments | 0,
    // Native (no-WebGL) fallback render source — one <path> per shape at the
    // initial geometry. createBundle copies this to bundle.svgSource; the
    // native scene clones it and updateNativeBundleGeometry streams per-frame
    // pathD into it. (The WebGL path ignores svgSource.)
    svgSource: synthStreamSvgSource(shapesDoc, fixedBBox, ctx.shapeIds),
  };
}

/// The caller's segments are in DOCUMENT coordinates; a bundle with an ORIGIN stores them relative to it (bundle/layout.js), so each
/// is moved by -origin in float64 before anything reads a point. The identity (a bundle at the origin) returns the lists as given.
function segsInBundleFrame(perShapeSegs, origin) {
  if (!origin || (origin[0] === 0 && origin[1] === 0)) return perShapeSegs;
  const m = [1, 0, 0, 1, -origin[0], -origin[1]];
  return perShapeSegs.map((segs) => {
    if (!Array.isArray(segs)) return segs;
    const out = [];
    for (const sg of segs) transformSegInto(sg, m, out);
    return out;
  });
}

/// Is `segs` the same as last frame's copy `prev`, value for value (type, weight, every point)?
function sameSegs(prev, segs) {
  if (!prev || prev.n !== segs.length) return false;
  const v = prev.v;
  let k = 0;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    if (v[k++] !== sg.type || v[k++] !== (sg.w || 0) || v[k++] !== (sg.subStart ? 1 : 0))
      return false;
    for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
      if (!P) {
        if (v[k++] !== -1) return false;
        continue;
      }
      if (v[k++] !== 1 || v[k++] !== P[0] || v[k++] !== P[1]) return false;
    }
    // An arc's shape is not in its end points: the same two points carry any radius and either sweep.
    if (sg.type === 3) for (const K of SEG_ARC_KEYS) if (v[k++] !== sg[K]) return false;
  }
  return k === v.length;
}
/// Copy `segs`' values for the next frame's comparison, into `prev`'s buffer when it is the right size.
function copySegs(prev, segs) {
  let len = 0;
  for (const sg of segs) {
    len += 3 + (sg.type === 3 ? SEG_ARC_KEYS.length : 0);
    for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) len += P ? 3 : 1;
  }
  const v = prev && prev.v.length === len ? prev.v : new Float64Array(len);
  let k = 0;
  for (const sg of segs) {
    v[k++] = sg.type;
    v[k++] = sg.w || 0;
    v[k++] = sg.subStart ? 1 : 0;
    for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
      if (!P) {
        v[k++] = -1;
        continue;
      }
      v[k++] = 1;
      v[k++] = P[0];
      v[k++] = P[1];
    }
    if (sg.type === 3) for (const K of SEG_ARC_KEYS) v[k++] = sg[K];
  }
  return { n: segs.length, v };
}

// Lightweight (GPU-resident) streaming update — the allocation-light path
// used by updateBundleGeometry(gl, …, { lightweight:true }). Instead of
// re-running the Slug pipeline (buildTexturesShape + cover-quad mesh +
// curve/band/meta GL texture uploads — the dominant per-frame garbage), it
// rebuilds only the per-shape analytic fill meshes of the shapes that moved,
// through the static build's own route with its correct fast build enabled
// (buildLbShape `fastCorrect`: a curved, concave, disjoint or multi-contour
// shape takes the correct fast builder; a straight outline reuses last frame's
// triangulation while its rim structure is unchanged; a cubic or translucent
// shape, and anything the fast build declines, takes the CDT partition), and
// refills the per-shape + combined vertex buffers in place.
// The bundle then renders through the renderer's GPU-resident analytic fill
// (build-once-draw-many), whose vertex shader bakes the implicit curve
// coords from the new control points — no CPU re-mesh, no re-texture.
//
// gl-FREE. The renderer uploads the refreshed combined VBO on the next draw
// (keyed on the bumped _geomGen). Returns { ok:false, reason } when any
// shape can't be served this way (arc geometry, or a loop/cusp cubic) — the
// caller (updateBundleGeometry) then falls back to the full Slug rebuild for
// that frame. On success the bundle is flagged `_lbStream`, which makes the
// main draw route render it through the analytic GPU fill automatically — even
// under setLoopBlinnFill('off'): a lightweight stream has no Slug cover-quads,
// so routing LB is the only way to draw it (its Slug fallback is the full
// rebuild ABOVE, which clears `_lbStream`, not a draw-time choice).
//
// NOTE: this path does NOT refresh bundle.curveFloats or the curve/band GL
// textures (the analytic fill samples neither). CPU consumers that read a
// streamed bundle's curve buffer (hit-test) would see the geometry from the
// last full (non-lightweight) update. Pass { lightweight:false } when you
// need the curve buffer live. Call it each frame BEFORE drawing the bundle.
/// The bundle's derived stats follow the streamed geometry. createBundle derives four numbers from the
/// import (renderer/bundle.js) that the engine selectors read every draw: meanFillShapeArea and numFillShapes
/// (aacFill: 'auto', the AAC/Slug size gate), meanSegsPerShape (the LB size gate, the no-AA segment cap) and
/// segTypeMask (typeOmit compiles out the kernels of segment types the bundle has none of). Kept from a streamed bundle's
/// FIRST frame, a shape that grew or shrank would be priced at its old size, and under typeOmit a segment type that first
/// appeared mid-stream would be drawn by a program without its kernel. Recomputed here, after the meta rows hold the new
/// boxes, by bundle.js's own rules; the type mask is a UNION with the old one, so a kernel a program already has is
/// never dropped (a later frame that brings the type back would otherwise switch the variant back and forth).
function refreshDerivedStats(bundle, perShapeSegs) {
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0,
    n = bundle.numShapes | 0;
  let mask = 0,
    segsTotal = 0;
  for (let i = 0; i < n; i++) {
    const segs = perShapeSegs[i];
    if (!Array.isArray(segs)) continue;
    segsTotal += segs.length;
    for (let k = 0; k < segs.length; k++) mask |= 1 << ((segs[k].type | 0) & 3);
  }
  bundle.segTypeMask = (bundle.segTypeMask | 0 || 0xf) | mask;
  bundle.meanSegsPerShape = n ? segsTotal / n : 0;
  if (meta && stride) {
    let area = 0,
      fills = 0;
    for (let i = 0; i < n; i++) {
      const b = i * stride;
      if (!(meta[b + 7] > 0)) continue; // MT_FILL.a, the shader's own doFill (bundle.js)
      fills++;
      const w = meta[b + 2] - meta[b + 0],
        h = meta[b + 3] - meta[b + 1];
      if (w > 0 && h > 0) area += w * h;
    }
    bundle.meanFillShapeArea = fills ? area / fills : 0;
    bundle.numFillShapes = fills;
  }
}

/// True when a segment list encloses no area: every control point lies on one line (or is one point). An arc with radii and a sweep encloses area. Relative to the shape's own extent, so a shape of any scale reads the same.
function isZeroAreaSegs(segs) {
  let ax = 0,
    ay = 0,
    have = false,
    bx = 0,
    by = 0,
    far = 0,
    arc = false;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const take = (p) => {
    if (!p) return;
    const x = p[0],
      y = p[1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (!have) {
      ax = x;
      ay = y;
      have = true;
      return;
    }
    const d = Math.abs(x - ax) + Math.abs(y - ay);
    if (d > far) {
      far = d;
      bx = x;
      by = y;
    }
  };
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    // An arc with radii and a sweep bulges off its chord, so it (with the chord back) encloses area; a zero-radius arc is its chord.
    if (g.type === 3 && g.rx > 0 && g.ry > 0 && g.theta_end !== g.theta_start) return false;
    if (g.type === 3) arc = true;
    take(g.p1);
    take(g.p2);
    take(g.p3);
    take(g.p4);
  }
  if (!have) return false;
  if (arc) return x1 === x0 || y1 === y0;
  if (far === 0) return true;
  const ux = bx - ax,
    uy = by - ay,
    len = Math.hypot(ux, uy);
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    for (const k of SEG_POINT_KEYS) {
      const p = g[k];
      if (!p) continue;
      if (Math.abs(ux * (p[1] - ay) - uy * (p[0] - ax)) > 1e-9 * len * len) return false;
    }
  }
  return true;
}

function streamGeometryLightweight(bundle, perShapeSegs, unchangedAlpha) {
  // CPatch needs updated curve planes before it can prepare the new geometry.
  if (bundle._fillMeshOwner === MESH_OWNER.CPATCH && (bundle._cpatchBuilt | 0) > 0)
    return { ok: false, reason: 'CPatch preparation requires a full geometry update' };
  const n = bundle.numShapes | 0;

  const prevRaw = bundle._lbMeshesRaw;
  const prevPacked = bundle._lbMeshes; // reuse last frame's per-shape VBOs
  // Full ramp construction heals every interior-to-curve T-junction. That is
  // required for general/translucent streams, but known opaque convex bands
  // can opt out at bundle creation: their interior is overlap-idempotent and
  // paying the generic crack healer every frame defeats streaming entirely.
  // (The one way a streamed mesh may differ from the static build: by request.)
  const ramp = bundle._lbStreamRamp !== false;
  // Reuse the prior frame's wrapper arrays in place (fixed n; each slot is
  // overwritten below, and a same-index read-then-write per iteration is safe)
  // — no per-frame Array(n) garbage. They become _lbMeshesRaw/_lbMeshes again.
  const raw = prevRaw && prevRaw.length === n ? prevRaw : new Array(n);
  const packed = prevPacked && prevPacked.length === n ? prevPacked : new Array(n);
  const meta = bundle.metaFloats,
    stride = bundle.metaFloatsPerShape | 0;
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity,
    inkShapes = 0,
    hasSlug = false;
  // Track whether any RENDERED shape has a translucent fill. An all-opaque
  // solid bundle can take the one-draw combined route (opaque OVER is overlap-
  // idempotent); a translucent solid must compose via the coverage→composite
  // path (combined OVER would conflate self-overlap). The `_lbSolidOnly`
  // fast-path in _drawBundleLB gates on the resulting `_lbOpaque`.
  let anyTrans = false;
  const SLUG = STREAM_SLUG;
  let allReused =
    unchangedAlpha &&
    bundle._fillMeshOwner === MESH_OWNER.STREAM &&
    bundle._lbStream &&
    bundle._lbGen === bundle._geomGen &&
    !bundle._culledShapes &&
    !bundle.hasOccupancy;

  for (let i = 0; i < n; i++) {
    const segs = perShapeSegs[i];
    // A section the analytic fill can't serve (arc / loop / cusp / degenerate)
    // becomes a SLUG SENTINEL — skipped — rather than failing the whole stream.
    // The combined route then draws the servable sections in ONE seamless pass;
    // failing the whole bundle would blank (or AA-fragment) the entire road when
    // a single transient section turns unservable mid-scroll.
    // Per-shape unchanged skip: apps stream whole bundles when only a few
    // shapes moved (a scrolling track streamed every frame while most of it
    // is static; far waves that sit still between cycles). An unchanged shape keeps
    // last frame's mesh + packed VBO outright — the rebuild runs only for
    // shapes whose segments actually changed.
    //
    // exact, against a copy of last frame's values, not a fingerprint. The
    // fingerprint hashed coordinates at an absolute 1/4096 unit, so at 2^-20 of
    // a drawing every coordinate hashed to 0 and a shape that MOVED kept last
    // frame's mesh -- the same absolute-quantum defect as the mesh cache.
    const sgPrev = bundle._lbSegPrev || (bundle._lbSegPrev = []);
    const b9 = stride && meta ? i * stride : -1;
    const evenodd = b9 >= 0 && meta[b9 + 13] > 0.5;
    const transSolid =
      b9 >= 0 &&
      meta[b9 + 7] < 0.996 &&
      Math.floor(meta[b9 + 28] + 0.5) === 0 &&
      (stride < 36 || Math.floor(meta[b9 + 35] + 0.5) === 0);
    const meshKey = (evenodd ? 1 : 0) | (transSolid ? 2 : 0) | (ramp ? 4 : 0);
    const unchanged = sameSegs(sgPrev[i], segs) && sgPrev[i].meshKey === meshKey;
    if (!unchanged) {
      sgPrev[i] = copySegs(sgPrev[i], segs);
      sgPrev[i].meshKey = meshKey;
    }
    if (unchanged && prevRaw && prevRaw[i] && prevPacked && prevPacked[i]) {
      raw[i] = prevRaw[i];
      packed[i] = prevPacked[i];
      if (prevRaw[i].slug) {
        hasSlug = true;
        continue;
      }
      const bbP = pathBbox(segs);
      if (stride && meta) {
        const bP = i * stride;
        meta[bP] = bbP[0];
        meta[bP + 1] = bbP[1];
        meta[bP + 2] = bbP[2];
        meta[bP + 3] = bbP[3];
      }
      if (packed[i].vertexCount) {
        if (bbP[0] < bx0) bx0 = bbP[0];
        if (bbP[1] < by0) by0 = bbP[1];
        if (bbP[2] > bx1) bx1 = bbP[2];
        if (bbP[3] > by1) by1 = bbP[3];
        inkShapes++;
        if (stride && meta) {
          const a = meta[i * stride + 7];
          if (a > 0.004 && a < 0.996) anyTrans = true;
        }
      }
      continue;
    }

    allReused = false;
    // A shape with no area (every point on one line) fills nothing, as the full path and a literal import draw it; handed to
    // the analytic build its degenerate triangles took the edge-widening ramp and drew a hairline.
    const contours = isZeroAreaSegs(segs) ? null : contoursFromSegs(segs);
    let mesh = null,
      pk = null;
    if (contours) {
      const prevMesh = prevRaw && prevRaw[i] && !prevRaw[i].slug ? prevRaw[i] : null;
      let built = null;
      try {
        built = buildLbShape(contours, transSolid, evenodd, {
          prev: prevMesh,
          ramp,
          fastCorrect: true,
          reusePk: prevPacked && prevPacked[i] && !prevPacked[i].slug ? prevPacked[i] : undefined,
        });
      } catch {
        built = null;
      }
      if (built) {
        mesh = built.raw;
        pk = built.pk;
      }
    }
    // Per-shape bbox → meta texel 0 (drives the shape's em→NDC + LB eligibility).
    const bb = pathBbox(segs);
    if (stride && meta) {
      const b = i * stride;
      meta[b] = bb[0];
      meta[b + 1] = bb[1];
      meta[b + 2] = bb[2];
      meta[b + 3] = bb[3];
    }
    if (!mesh) {
      raw[i] = SLUG;
      packed[i] = SLUG;
      hasSlug = true;
      continue;
    }
    raw[i] = mesh;
    packed[i] = pk;
    if (!packed[i] || packed[i].overBudget || packed[i].slug || !(packed[i].vertexCount > 0)) {
      raw[i] = SLUG;
      packed[i] = SLUG;
      hasSlug = true;
      continue;
    }
    // Global bbox from the RENDERED shapes only (the original behavior) — drives
    // the bundle's em→NDC mapping.
    if (packed[i].vertexCount) {
      if (bb[0] < bx0) bx0 = bb[0];
      if (bb[1] < by0) by0 = bb[1];
      if (bb[2] > bx1) bx1 = bb[2];
      if (bb[3] > by1) by1 = bb[3];
      inkShapes++;
      if (stride && meta) {
        const a = meta[i * stride + 7];
        if (a > 0.004 && a < 0.996) anyTrans = true;
      }
    }
  }
  // Every section unservable → nothing analytic to stream; let the caller fall
  // back (a full Slug rebuild) rather than publish an all-sentinel bundle.
  if (inkShapes === 0) return { ok: false, reason: 'no analytic-servable shapes' };

  // Publish the directly-built meshes so the renderer's _ensureLbMeshes
  // returns them as-is (cached at the new gen) — no curveFloats decode.
  const gen = (bundle._geomGen | 0) + (allReused && !hasSlug ? 0 : 1);
  bundle._lbMeshesRaw = raw;
  if (bundle._fillMeshOwner === MESH_OWNER.LB) releaseFillMeshes(bundle, MESH_OWNER.LB);
  if (!claimFillMeshes(bundle, MESH_OWNER.STREAM, packed))
    return { ok: false, reason: 'stream mesh ownership was refused' };
  bundle._lbGen = gen;
  bundle._lbHasSlug = hasSlug; // this stream left loop/cusp sections as Slug sentinels
  bundle._geomGen = gen;
  bundle._lbStream = true; // route LB despite geomGen>0
  // The occlusion cull (occlusionCull.js) is computed ONCE at import against the
  // geometry as authored. Streaming moves the shapes, so a shape that was hidden
  // then need not be hidden now — bands that overlap at load can separate as
  // they scroll, and keeping the cull would drop whole bands mid-scroll. This path does
  // not rebuild the drawList (a lightweight stream has no cover quads), so retire
  // the cull explicitly the first time geometry moves. The full Slug rebuild and
  // applyNineSlice already rebuild the list without it.
  if (bundle._culledShapes) {
    bundle._culledShapes = null;
    if (Array.isArray(bundle.drawList) && bundle.drawListUnculled)
      bundle.drawList = bundle.drawListUnculled;
    // Anything caching a DRAW-LIST derivative has to rebuild — the instanced fast path
    // compacts its cover-quad VBO from this list, and it keys that cache on _cullGen.
    bundle._cullGen = (bundle._cullGen | 0) + 1;
  }

  bundle._lbSolidOnly = true;
  bundle._lbOpaque = !anyTrans; // gates the all-opaque combined-route fast path
  if (inkShapes > 0 && !bundle.frameFixed) bundle.globalBBox = [bx0, by0, bx1 - bx0, by1 - by0];
  refreshDerivedStats(bundle, perShapeSegs);
  // Shapes moved: imported occupancy cells are no longer valid for the new
  // positions. Retire the acceleration (correct-but-unaccelerated) rather than
  // skipping interiors against a stale grid.
  clearStreamedOccupancy(bundle, meta, n, stride);
  return { ok: true };
}

/// The first non-finite number among a segment list's coordinates, as a short description, or null. Points are [x, y]; an arc
/// also carries its center, radii and angles.
function nonFiniteInSegs(segs) {
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (!g) return 'segment ' + i + ' is missing';
    for (const k of SEG_POINT_KEYS) {
      const p = g[k];
      if (p && !(Number.isFinite(p[0]) && Number.isFinite(p[1])))
        return 'segment ' + i + ' ' + k + ' [' + p[0] + ', ' + p[1] + ']';
    }
    if (g.type === 3) {
      for (const k of SEG_ARC_KEYS)
        if (g[k] !== undefined && !Number.isFinite(g[k]))
          return 'segment ' + i + ' arc ' + k + ' ' + g[k];
    }
  }
  return null;
}
const SEG_POINT_KEYS = ['p1', 'p2', 'p3', 'p4'];
const SEG_ARC_KEYS = ['cx', 'cy', 'rx', 'ry', 'theta_start', 'theta_end', 'phi'];

/**
 * Stream new geometry into an existing bundle in place (fixed topology,
 * solid fill). The main per-frame streaming entry point.
 *
 * By default this does the full in-place rebuild (re-encodes the curve/band
 * textures + cover-quad mesh and re-uploads them). Pass `{ lightweight: true }`
 * to take the allocation-light GPU-resident path instead: it rebuilds only
 * the analytic fill meshes (reusing the cached triangulation, refilling the
 * vertex buffers in place) and skips the per-frame CPU re-mesh + re-texture
 * — the bundle then renders through the renderer's GPU-resident analytic fill
 * automatically on the next draw. Unsupported geometry falls back to a full
 * update. This requires the analytic-fill shaders supplied by loadShaders.
 *
 * Lightweight updates construct analytic meshes on the CPU. Full updates
 * maintain curve/band tables and let the renderer choose its draw route.
 * Compare preparation and GPU costs at the target scales before opting in,
 * especially when curved geometry changes every frame. Explicit false forces
 * full updates even on a bundle previously built or updated as lightweight;
 * an omitted option preserves an existing lightweight bundle's update mode.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} bundle  a createBundle() output (mutated in place)
 * @param {Array<Array<object>>} perShapeSegs  one segment list per shape
 * @param {object} [opts]
 * @param {boolean} [opts.lightweight]  true rebuilds analytic meshes; false forces full tables; omitted preserves lightweight mode
 * @param {Array<Array<number>>} [opts.fills]  optional straight-RGBA fill per shape
 * @returns {{ok:boolean, reason?:string, reallocated?:boolean}}
 *   ok:false → caller should fall back to a full importSvg→createBundle.
 */
export function updateBundleGeometry(gl, bundle, perShapeSegs, opts = {}) {
  bundle = unwrapBundle(bundle);
  // A disposed bundle has no textures to write into: say so instead of reporting {ok:true}.
  if (!bundle) return { ok: false, reason: 'no bundle' };
  if (bundle._disposed) return { ok: false, reason: 'the bundle is disposed' };
  warnHitOnlyStatic(
    bundle.hitOnly,
    'updateBundleGeometry',
    'Streamed geometry does not move the hit-only shapes.',
  );
  const n = bundle.numShapes | 0;
  if (!Array.isArray(perShapeSegs) || perShapeSegs.length !== n)
    return { ok: false, reason: 'perShapeSegs length must equal bundle.numShapes' };
  // (a DRIVEN update re-adopts segments read from the bundle's own planes: already in the stored frame)
  if (!opts[DRIVEN_GEOMETRY]) perShapeSegs = segsInBundleFrame(perShapeSegs, bundle.origin);
  const stride = bundle.metaFloatsPerShape | 0;
  if (stride !== META_STRIDE)
    return { ok: false, reason: 'in-place streaming requires v3 meta stride (48)' };
  // Position-dependent auxiliary geometry can't be streamed by a fill-
  // only update — bail so the caller does a full rebuild instead.
  {
    const why = outOfStreamScope(bundle);
    if (why && !opts[DRIVEN_GEOMETRY])
      return { ok: false, reason: `${why} — out of streaming v1's scope` };
  }

  for (let i = 0; i < n; i++) {
    if (!Array.isArray(perShapeSegs[i]))
      return { ok: false, reason: 'perShapeSegs[' + i + '] is not a segment array' };
    // A NaN or Infinity would be written into the curve tables and the row's box, and draws stray ink (or takes the bundle's
    // bounds with it). Refuse before anything is mutated, like the checks above.
    const bad = nonFiniteInSegs(perShapeSegs[i]);
    if (bad)
      return {
        ok: false,
        reason: 'perShapeSegs[' + i + '] has a non-finite coordinate (' + bad + ')',
      };
    // ...and a fill that is not four finite numbers would go into the row's color as NaN.
    const f = opts.fills && opts.fills[i];
    if (
      f &&
      !(
        f.length === 4 &&
        Number.isFinite(f[0]) &&
        Number.isFinite(f[1]) &&
        Number.isFinite(f[2]) &&
        Number.isFinite(f[3])
      )
    )
      return {
        ok: false,
        reason: 'opts.fills[' + i + '] must be four finite numbers (straight RGBA)',
      };
  }

  if (n === 0) return { ok: true, reallocated: false };
  // From here the call writes to the GPU. A lost context, or a bundle whose textures died in an earlier loss, cannot take the write:
  // reporting {ok:true} while texSubImage2D failed would leave GL error 1282 on the host's context.
  if (typeof gl.isContextLost === 'function' && gl.isContextLost())
    return { ok: false, reason: 'the WebGL context is lost' };
  if (bundle._resourceGeneration != null && bundle._resourceGeneration !== resourceGeneration(gl))
    return {
      ok: false,
      reason:
        'the bundle was created before a WebGL context loss; its textures are gone, create a new bundle',
    };

  const pairBands = !!(bundle && bundle.pairBands);
  // Lightweight mesh construction reads fill alpha to select its coverage path.
  // Apply paint only after the shared input and scope checks have passed.
  let firstMeta = n,
    lastMeta = -1,
    unchangedAlpha = true;
  // Imported primitive hints describe the source geometry. Fixed segment types
  // do not guarantee that a deformed shape is still the same primitive.
  for (let i = 0; i < n; i++) {
    const b = i * stride,
      kind = bundle.metaFloats[b + META_PRIM_KIND];
    if (!kind) continue;
    bundle.metaFloats[b + META_PRIM_KIND] = 0;
    // This slot holds a radius only for rounded rectangles; other rows use it
    // for the independent stroke end cap.
    if (kind === 3) bundle.metaFloats[b + META_END_CAP_OR_RX] = 0;
    firstMeta = Math.min(firstMeta, i);
    lastMeta = i;
  }
  if (opts.fills && bundle.metaFloats) {
    const meta = bundle.metaFloats;
    for (let i = 0; i < n; i++) {
      const f = opts.fills[i];
      if (!f) continue;
      const b = i * stride;
      const r = meta[b + 4],
        g = meta[b + 5],
        blue = meta[b + 6],
        a = meta[b + 7];
      meta[b + 4] = f[0];
      meta[b + 5] = f[1];
      meta[b + 6] = f[2];
      meta[b + 7] = f[3];
      if (a !== meta[b + 7]) unchangedAlpha = false;
      if (r !== meta[b + 4] || g !== meta[b + 5] || blue !== meta[b + 6] || a !== meta[b + 7]) {
        firstMeta = Math.min(firstMeta, i);
        lastMeta = Math.max(lastMeta, i);
      }
    }
  }
  // Use the GPU-resident path when explicitly requested, OR AUTOMATICALLY when
  // the bundle is already on it (_lbStream) or was built without Slug cover-
  // quads (buildStreamableSections({lightweight:true})). The auto-detect
  // matters: a lightweight bundle has no cover-quads, so a full Slug rebuild
  // would re-create the very geometry it deliberately omits (and reintroduce
  // the stale-VBO footgun). Pass { lightweight:false } to force the full
  // rebuild (which regenerates cover-quads and clears _lbStream).
  const noCoverQuads = !bundle.coverQuadFloats || bundle.coverQuadFloats.length === 0;
  const useLight =
    opts.lightweight === true || (opts.lightweight !== false && (bundle._lbStream || noCoverQuads));
  if (useLight) {
    const r = streamGeometryLightweight(bundle, perShapeSegs, unchangedAlpha);
    if (r.ok) {
      if (lastMeta >= firstMeta) {
        // Use fillPass's scratch unit and invalidate its shared texture bindings.
        // Upload the changed row span directly from the existing metadata plane.
        gl.activeTexture(gl.TEXTURE11);
        gl.bindTexture(gl.TEXTURE_2D, bundle.metaTex);
        uploadTableRows(
          gl,
          FULL_META_W,
          firstMeta,
          lastMeta,
          bundle.metaFloats.subarray(firstMeta * stride, (lastMeta + 1) * stride),
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
        noteExternalGlWrite();
      }
      return r;
    }
    // A shape wasn't analytic-serveable (arc / loop-cusp) → fall through to the
    // full rebuild, which regenerates cover-quads + makes it Slug-renderable.
  }

  const meta = bundle.metaFloats; // CPU mirror; mutated in place

  // Fresh geometry accumulators. Sentinel zero-texel at curve index 0
  // matches the importer (meta uses curve index 0 = "no segment").
  const curveBuf = makeTexelBuffer();
  if (bundle.origin && (bundle.origin[0] !== 0 || bundle.origin[1] !== 0))
    curveBuf.docOrigin = bundle.origin; // joints are judged at document precision (svg/segment.js pointsMeet)
  texelAppend(curveBuf, 0, 0, 0, 0);
  const bandBuf = makeTexelBuffer(Float32Array); // write-only until toPaddedPlane narrows it to float32

  const hybridFloats = [];
  const curveEnds = new Array(n);
  const curveBegins = new Array(n); // per-shape curve write head (float units)
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  let inkShapes = 0;

  // Structural rows have no curves. Keep their content bounds current for
  // container filter regions, including when a driver changes the child pose.
  const groups = [];
  for (let i = 0; i < n; i++) {
    const base = i * stride,
      flags = meta[base + 27] | 0;
    if (flags & 64) {
      groups.push({ row: i, box: [Infinity, Infinity, -Infinity, -Infinity] });
      continue;
    }
    if (flags & 128) {
      const group = groups.pop();
      if (group)
        meta.set(Number.isFinite(group.box[0]) ? group.box : [0, 0, 0, 0], group.row * stride);
      continue;
    }
    if (flags & 256 || !perShapeSegs[i]?.length) continue;
    const b = pathBbox(perShapeSegs[i]);
    for (const group of groups) {
      group.box[0] = Math.min(group.box[0], b[0]);
      group.box[1] = Math.min(group.box[1], b[1]);
      group.box[2] = Math.max(group.box[2], b[2]);
      group.box[3] = Math.max(group.box[3], b[3]);
    }
  }

  for (let i = 0; i < n; i++) {
    const segs = perShapeSegs[i];
    const base = i * stride;
    if (meta[base + 27] & (64 | 128)) {
      curveBegins[i] = curveEnds[i] = curveBuf.count * 4;
      continue;
    }
    const pathBox = pathBbox(segs);
    const flags = meta[base + 27] | 0,
      sw = Math.abs(meta[base + 12]);
    const stroked = sw > 0 && meta[base + 11] > 0;
    const halfWidth = stroked && !(flags & 1) ? sw * 0.5 : 0;
    const pad = halfWidth * metaStrokeReachFactor(meta, base);
    const bb = stroked
      ? [
          pathBox[0] - halfWidth,
          pathBox[1] - halfWidth,
          pathBox[2] + halfWidth,
          pathBox[3] + halfWidth,
        ]
      : pathBox;
    const { bandsX, bandsY } = pickBandsXY(segs, bb);

    curveBegins[i] = curveBuf.count * 4;
    // This path already bailed on any stroke geometry above, so every shape's
    // curve buffer is fill-only → skip the stroke metadata (pairing/tangents/
    // arc-length) for a cheaper rebuild on complex shapes.
    // Rebuilt bands MUST match the layout the bundle was emitted with, or the
    // AAC walker's stride (b += 2 for pair bands) reads the wrong stripes.
    // AAC levels ride with the pair layout, as they do at import; a shape without them still draws correctly.
    // Lanes ON whatever the bundle was imported with: they are rebuilt from THESE segments with the bands,
    // so they are never stale, and every header says which layout it holds. A stroked row that slips
    // through the scope guard (note 0 above) reads a lane structure with its far gate off, as the shader does.
    // A DASHED stroke row (a dash-table id) re-derives the seam lengths of its closed contours with the rest of its stroke fields (svg/textures.js dashSeam),
    // and its flagsShape keeps FS_DASH_SEAM exactly when it has any, as at import.
    const dashed =
      stroked && meta[base + META_DASH_ID] > 0 ? (flags & FS_DASH_SEAM ? 'merge' : 'free') : false; // (the row's own import mode: only a compat 'chrome' row ever carries the bit)
    const info = buildTexturesShape(
      segs,
      bandsX,
      bandsY,
      bb,
      curveBuf,
      bandBuf,
      pad,
      !stroked,
      meta[base + 25] === 4,
      pairBands,
      !!(bundle.gwnTree || bundle.noAaTree),
      null,
      meta[base + 13] > 0.5,
      pairBands,
      !stroked,
      flags & 4 ? meta.subarray(base + 20, base + 24) : null,
      null,
      dashed,
    );
    if (dashed === 'merge')
      meta[base + 27] = info.dashSeam ? flags | FS_DASH_SEAM : flags & ~FS_DASH_SEAM;
    curveEnds[i] = info.curveEndF ?? curveBuf.count * 4;

    // Patch meta texel 0 (per-shape bbox) + texel 4 (glyphLoc + bandMax).
    // Everything else in the row (fill / stroke / gradient ids / clip /
    // mask / filter / flags) is left exactly as the original import set
    // it — this is a geometry-only update.
    meta[base + 0] = info.bbox[0];
    meta[base + 1] = info.bbox[1];
    meta[base + 2] = info.bbox[2];
    meta[base + 3] = info.bbox[3];
    meta[base + META_TEXEL_4] = info.glyphLoc[0];
    meta[base + META_TEXEL_4 + 1] = info.glyphLoc[1];
    meta[base + META_TEXEL_4 + 2] = info.bandMaxX;
    meta[base + META_TEXEL_4 + 3] = info.bandMaxY;

    // Cover quad — geometry from segs only; gid + fill rgba carried from
    // the original meta so the chunk→shape mapping and header stay
    // byte-identical. getCoverQuadMesh ignores fillRgba/fillRule for the
    // quad geometry (they only stamp the chunk header), so the quad
    // tracks the new positions exactly.
    const gid = Math.floor(meta[base + 14] + 0.5);
    const fr = meta[base + 4],
      fg = meta[base + 5],
      fb = meta[base + 6],
      fa = meta[base + 7];
    const mesh =
      flags & (64 | 128) ? [] : getCoverQuadMesh(segs, gid, [fr, fg, fb, fa], 'nonzero', pad);
    if (mesh.length) {
      const nv = mesh.length / COVER_QUAD_STRIDE;
      hybridFloats.push(nv, gid, fr, fg, fb, fa, 0, 0, 0, 0, -1, 1);
      for (const f of mesh) hybridFloats.push(f);
      inkShapes++;
    }
    if (bb[0] < bx0) bx0 = bb[0];
    if (bb[1] < by0) by0 = bb[1];
    if (bb[2] > bx1) bx1 = bb[2];
    if (bb[3] > by1) by1 = bb[3];
  }

  // --- Resolve plane sizes vs. the bundle's allocated texture rows ---
  const curve = toPaddedPlane(curveBuf);
  const band = toPaddedPlane(bandBuf);
  const allocCurveRows = planeRows(bundle.curveFloats ? bundle.curveFloats.length : curve.unpadded);
  const allocBandRows = planeRows(bundle.bandFloats ? bundle.bandFloats.length : band.unpadded);
  let reallocated = false;

  // --- Curve texture ---
  if (curve.height > allocCurveRows) {
    deleteGlResource(gl, 'Texture', bundle.curveTex);
    bundle.curveTex = makeTex(gl, curve.padded, TEX_W, curve.height, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    reallocated = true;
  } else {
    gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, curve.height, gl.RGBA, gl.FLOAT, curve.padded);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // --- Band texture ---
  if (band.height > allocBandRows) {
    deleteGlResource(gl, 'Texture', bundle.bandTex);
    bundle.bandTex = makeTex(gl, band.padded, TEX_W, band.height, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    reallocated = true;
  } else {
    gl.bindTexture(gl.TEXTURE_2D, bundle.bandTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, band.height, gl.RGBA, gl.FLOAT, band.padded);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // --- Meta texture (shape count unchanged → same dims, full re-upload).
  // For v3 stride the meta plane IS metaFloats (no repack).
  gl.bindTexture(gl.TEXTURE_2D, bundle.metaTex);
  uploadTableRows(gl, FULL_META_W, 0, Math.max(1, n) - 1, meta);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // --- CPU mirrors the renderer / morph / hit-test read from ---
  // Imported bundles retain authored precision for later analytic rebuilds.
  // Replace that plane along with the float32 upload so it cannot serve old geometry.
  if (bundle.curveFloats64) bundle.curveFloats64 = curveBuf.floats.slice(0, curve.unpadded);
  bundle.curveFloats = curve.padded.subarray(0, curve.unpadded);
  bundle.bandFloats = band.padded.subarray(0, band.unpadded);
  // Per-shape curve ranges, rebuilt from the captured write heads so
  // morph / hit-test consumers reading bundle.curveRangesByShape stay
  // correct even if a shape's curve-buffer offset shifted.
  const ranges = new Array(n);
  for (let i = 0; i < n; i++) {
    ranges[i] = {
      begin: curveBegins[i] | 0,
      end: (curveEnds[i] ?? curveBegins[i]) | 0,
    };
  }
  bundle.curveRangesByShape = ranges;

  // Global bbox (xywh) drives the em→NDC mapping + band-coord transform. A frame the author fixed (fixedBBox, preserveViewport) stays.
  refreshDerivedStats(bundle, perShapeSegs);
  if (inkShapes > 0 && !bundle.frameFixed) {
    bundle.globalBBox = [bx0, by0, bx1 - bx0, by1 - by0];
  }

  // Cover-quad VBO is owned by the renderer handle, not the bundle —
  // publish the new floats + chunk metadata and let the caller mark the
  // handle dirty (renderer.markGeometryDirty / handle.invalidate) so the
  // VBO re-uploads on the next draw. The chunk structure is re-derived
  // (not assumed stable) so a shape deforming to/from degenerate — which
  // adds or drops its quad — can't leave a stale chunk range behind.
  // gidToShapeIdx is unchanged (same gids, same shape indices), so reuse
  // the bundle's map.
  const cqf = hybridFloats.length ? new Float32Array(hybridFloats) : null;
  bundle.coverQuadFloats = cqf;
  bundle.coverQuadChunks = parseCoverQuadChunks(cqf, bundle.flags);
  bundle.hybridShapeIdxFloats = cqf
    ? buildShapeIdxFloats(cqf, bundle.coverQuadChunks, bundle.gidToShapeIdx)
    : null;
  // Repack the header-free VBO planes + restamp vboStart for the new mesh.
  const strip = cqf
    ? buildStrippedCoverQuad(cqf, bundle.coverQuadChunks, bundle.hybridShapeIdxFloats)
    : null;
  bundle.coverQuadVboFloats = strip ? strip.verts : null;
  bundle.hybridShapeIdxVboFloats = strip ? strip.shapeIdx : null;
  const chunkByShape = new Array(n);
  for (const c of bundle.coverQuadChunks) {
    const si = bundle.gidToShapeIdx.get(c.gid);
    if (si !== undefined) chunkByShape[si] = c;
  }
  bundle.chunkByShape = chunkByShape;
  // drawList ops reference chunk OBJECTS ({start, count}); after a re-derive
  // every later chunk's start can shift (a shape's quad appearing/dropping),
  // so the ops must be rebuilt too or gl.drawArrays reads stale vertex
  // ranges (applyNineSlice already does this).
  bundle.drawList = buildDrawList(
    bundle.metaFloats,
    n,
    bundle.metaFloatsPerShape | 0,
    chunkByShape,
    bundle.filterGraphs,
    null,
    bundle._drawOrder,
    bundle._drawAltMeta,
  );
  // The uncut list and the retired cull's list reference the previous chunk objects: this list is the only current one.
  bundle.drawListUnculled = bundle.drawList;
  bundle._drawListCulled = null;

  // This is the full (Slug) rebuild — the curve/band textures + cover-quad
  // mesh are now live. Clear any `_lbStream` flag left by a prior lightweight
  // update so the draw route renders from this fresh data instead of the now-
  // stale analytic meshes.
  bundle._lbStream = false;
  bundle._lbSolidOnly = false;
  // ...and the lightweight path's record of last frame's segments: the meshes it would keep for an
  // unchanged shape are no longer the ones this rebuild leaves behind.
  bundle._lbSegPrev = null;
  // Its meshes go too. Left claimed, they refused the analytic builder's claim on the new geometry, whose
  // generation stamp then made them read as current: the shape drew where the last lightweight update left it.
  if (bundle._fillMeshOwner === MESH_OWNER.STREAM) {
    releaseFillMeshes(bundle, MESH_OWNER.STREAM);
    bundle._lbMeshesRaw = null;
  }

  // Occupancy grids / cull sets were computed against the previous curve layout.
  // The new curve plane has no reserved occupancy slots, but meta texel 5 may
  // still advertise (base, G) — zero those descriptors and retire hasOccupancy
  // so a late worker callback (guarded by _geomGen / plane identity) cannot
  // patch bits into live curve texels, and the shader cannot skip on stale G.
  clearStreamedOccupancy(bundle, meta, n, stride);
  if (bundle._culledShapes) {
    bundle._culledShapes = null;
    bundle._cullGen = (bundle._cullGen | 0) + 1;
  }
  bundle._geomGen = (bundle._geomGen | 0) + 1;

  noteExternalGlWrite();
  return { ok: true, reallocated };
}

/** Drop occupancy descriptors after a geometry stream (meta + flag only). */
function clearStreamedOccupancy(bundle, meta, n, stride) {
  bundle.hasOccupancy = false;
  if (!meta || !stride) return;
  const ATLAS_W = 43; // meta texel 10.w — pattern carriers reuse texel 5
  for (let i = 0; i < n; i++) {
    const b = i * stride;
    const atlasW = meta[b + ATLAS_W];
    if (atlasW >= 1.5) continue; // pattern: texel 5 holds patInvLinear
    if ((Math.round(meta[b + 27]) & 4) !== 0) continue; // FS_STROKE_LOCAL: texel 5 holds the stroke frame
    const g = meta[b + 21];
    if (!(g > 0)) continue;
    meta[b + 20] = 0;
    meta[b + 21] = 0;
  }
}
