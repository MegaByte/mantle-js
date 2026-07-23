// streamGeometry.js — in-place fixed-topology geometry streaming.
/** @typedef {{type:number,p1:number[],p2?:number[],p3?:number[],p4?:number[]}} Seg */
//
// updateBundleGeometry(gl, bundle, perShapeSegs) rebuilds ONLY the
// geometry planes (curve / band / per-shape bbox + glyphLoc / cover
// quads) from a fresh set of per-shape segment lists and uploads them
// over the bundle's existing GL textures via texSubImage2D — WITHOUT
// the SVG parse / style resolution / gradient-graph / clip-mask work
// that importSvg→createBundle does every frame. That parse-skip is a large
// CPU win for assets that rebuild the SAME topology each frame.
//
// Correctness model: the bands are recomputed from the NEW segment
// positions every call, so they are NEVER stale (unlike the morph
// setT path, which uploads curves-only and tolerates stale bands only
// because a morph is a small bounded deform). The render is therefore
// byte-identical to a full importSvg(frame)→createBundle of the same geometry.
//
// Scope (v1): SOLID-FILL bundles with FIXED topology — same shape
// count, and each shape keeps its segment count/types so its curve
// layout and gid are stable. Stroke meshes, clip/mask geometry, dashes
// and per-vertex pattern geometry are out of scope; a bundle carrying
// those returns { ok:false, reason } so the caller falls back to a full
// rebuild rather than render something subtly wrong.

import { makeTexelBuffer, texelAppend, buildTexturesShape, texelToBytes } from '../svg/textures.js';
import { pathBbox } from '../svg/bbox.js';
import { pickBandsXY, makeBuildContext, emitShape } from '../svg/buildContext.js';
import { packMetaBody } from '../svg/meta.js';
import { getCoverQuadMesh } from '../svg/mesh.js';
import { makeTex, buildDrawList } from './bundle.js';
import { parseCoverQuadChunks, buildShapeIdxFloats, buildStrippedCoverQuad } from './coverQuadChunks.js';
import { refreshLoopBlinnMesh, buildLoopBlinnMesh, packLoopBlinnMesh } from './loopBlinn.js';
import { SEG_LINE, SEG_QUAD, SEG_ARC } from '../primitives/seg.js';
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
  const r = Math.round((c[0] || 0) * 255), g = Math.round((c[1] || 0) * 255), b = Math.round((c[2] || 0) * 255);
  const a = c[3] == null ? 1 : c[3];
  return `rgba(${r},${g},${b},${a})`;
}
function xmlEscapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function synthStreamSvgSource(shapes, fixedBBox, shapeIds) {
  const bb = fixedBBox && fixedBBox.length === 4 ? fixedBBox : [0, 0, 1, 1];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb[0]} ${bb[1]} ${bb[2]} ${bb[3]}">`;
  for (let i = 0; i < shapes.length; i++) {
    let d = '';
    try { d = segsToPathD(shapes[i].segs) || ''; } catch { d = ''; }
    const id = (shapeIds && shapeIds[i]) ? xmlEscapeAttr(shapeIds[i]) : ('s' + i);
    out += `<path id="${id}" d="${xmlEscapeAttr(d)}" fill="${rgbaCss(shapes[i].fill)}"/>`;
  }
  return out + '</svg>';
}

// Shared sentinel for a stream section the analytic fill can't serve (arc /
// loop / cusp / degenerate) — read-only marker (checked via `.slug`), so one
// frozen singleton is reused across all shapes + bundles (no per-frame alloc).
const STREAM_SLUG = Object.freeze({ slug: true });

const TEX_W = 4096;            // curve/band texture row width (mirror bundle.js)
const FULL_META_W = 12;        // texels per shape in the meta texture (v3+)
const META_STRIDE = FULL_META_W * 4;   // 48 floats per shape
const META_TEXEL_4 = 16;       // float offset of texel 4 (glyphLoc.x) in a row
const COVER_QUAD_STRIDE = 12;  // floats per cover-quad vertex (mirror buildContext)

/// Downcast a Float64-backed texel buffer to a row-padded Float32 plane
/// (TEX_W texels wide, height rounded up to a full row) exactly as
/// createBundle uploads it. `unpadded` is the unpadded float count.
function toPaddedPlane(buf) {
  const unpadded = buf.count * 4;
  const h = Math.max(1, Math.ceil(unpadded / (4 * TEX_W)));
  const padded = new Float32Array(h * 4 * TEX_W);
  padded.set(buf.floats.subarray(0, unpadded));   // Float64 → Float32 narrow
  return { padded, height: h, unpadded };
}

/// Allocated row height of a plane whose UNPADDED float count is `n`.
function planeRows(n) { return Math.max(1, Math.ceil(n / (4 * TEX_W))); }

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
 * regenerates, so the first (and every) `updateBundleGeometry` call renders
 * correctly. Build a bundle via `importSvg`/`sceneToSvg` instead and the
 * layouts won't match — the streamed geometry renders wrong.
 *
 * @param {Array<{segs: Array<Seg>, fill: [number,number,number,number]}>} shapes
 *        one solid-fill shape per entry. `segs` is the importer-native
 *        segment list (mkLine/mkQuad/mkCubic); keep the count/types stable
 *        across the matching `updateBundleGeometry` calls.
 * @param {[number,number,number,number]} [fixedBBox]  pin the bundle's
 *        global bbox to `[x,y,w,h]` (e.g. a viewport) instead of deriving it
 *        tight from the shapes — keeps mount placement stable for screen-
 *        space scenes. (Note: `updateBundleGeometry` overwrites globalBBox
 *        with the streamed content bounds; callers that need the pinned box
 *        should restore it after each stream.)
 * @returns {object} a sections dict for `createBundle(gl, sections)`.
 */
export function buildStreamableSections(shapes, fixedBBox, opts = {}) {
  const ctx = makeBuildContext();
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
  const bx = fixedBBox ? fixedBBox[0] : bb.xmin;
  const by = fixedBBox ? fixedBBox[1] : bb.ymin;
  const bw = fixedBBox ? fixedBBox[2] : (bb.xmax - bb.xmin);
  const bh = fixedBBox ? fixedBBox[3] : (bb.ymax - bb.ymin);
  dv.setFloat32(4, bx, true);
  dv.setFloat32(8, by, true);
  dv.setFloat32(12, bw, true);
  dv.setFloat32(16, bh, true);
  new Uint8Array(meta, 32).set(body);
  return {
    flags: 7, // HYBRID_MESH_IN_CGEOM | HYBRID_MESH_CHUNKED | WIDE_BAND_HEADERS
    streamable: true,   // skip creation-time LB auto-prepare: the stream path owns builds
    numShapes: ctx.metas.length,
    metaFloatsPerShape: 48,
    meta,
    curves: texelToBytes(ctx.curveBuf).buffer,
    bands: texelToBytes(ctx.bandBuf).buffer,
    curveGeom: new Float32Array(ctx.hybridFloats).buffer,
    shapeIds: ctx.shapeIds.slice(),
    // Native (no-WebGL) fallback render source — one <path> per shape at the
    // initial geometry. createBundle copies this to bundle.svgSource; the
    // native scene clones it and updateNativeBundleGeometry streams per-frame
    // pathD into it. (The WebGL path ignores svgSource.)
    svgSource: synthStreamSvgSource(shapes, fixedBBox, ctx.shapeIds),
  };
}

// Seg end point (start is always s.p1). Used to thread subpaths into
// contours for the LB mesh builder.
function _segEndPt(s) {
  if (s.type === SEG_LINE) return s.p2;
  if (s.type === SEG_QUAD) return s.p3;
  return s.p4;   // SEG_CUBIC
}

// Group a shape's flat segment list into subpath contours (the shape the LB
// mesh builder wants): a new contour starts whenever a segment's start (p1)
// doesn't continue the previous segment's end. Returns null if the shape
// carries an arc — the fast LB path takes lines/quads/cubics only; an arc
// makes the caller fall back to the Slug rebuild (which arc-tessellates).
const _LB_CONT_EPS = 1e-5;
function segsToContours(segs) {
  const contours = []; let cur = null; let px = NaN, py = NaN;
  for (const s of segs) {
    if (s.type === SEG_ARC) return null;
    const a = s.p1;
    if (cur === null || Math.abs(a[0] - px) > _LB_CONT_EPS || Math.abs(a[1] - py) > _LB_CONT_EPS) {
      cur = []; contours.push(cur);
    }
    cur.push(s);
    const e = _segEndPt(s); px = e[0]; py = e[1];
  }
  return contours.length ? contours : null;
}

// Lightweight (GPU-resident) streaming update — the allocation-light path
// used by updateBundleGeometry(gl, …, { lightweight:true }). Instead of
// re-running the Slug pipeline (buildTexturesShape + cover-quad mesh +
// curve/band/meta GL texture uploads — the dominant per-frame garbage), it
// rebuilds ONLY the per-shape analytic fill meshes, reusing the cached
// earcut topology (O(n), no re-triangulation when the rim structure is
// unchanged) and refilling the per-shape + combined vertex buffers in place.
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
function streamGeometryLightweight(bundle, perShapeSegs) {
  const n = bundle.numShapes | 0;
  if (!Array.isArray(perShapeSegs) || perShapeSegs.length !== n)
    return { ok: false, reason: 'perShapeSegs length must equal bundle.numShapes' };
  if ((bundle.strokeMesh && bundle.strokeMesh.byteLength) ||
      (bundle.clipMesh && bundle.clipMesh.byteLength) ||
      (bundle.maskMesh && bundle.maskMesh.byteLength) ||
      (bundle.dashFloats && bundle.dashFloats.length))
    return { ok: false, reason: 'bundle has stroke/clip/mask/dash geometry (LB-fast unsupported)' };

  const prevRaw = bundle._lbMeshesRaw;
  const prevPacked = bundle._lbMeshes;   // reuse last frame's per-shape VBOs
  // Full ramp construction heals every interior-to-curve T-junction. That is
  // required for general/translucent streams, but known opaque convex bands
  // can opt out at bundle creation: their interior is overlap-idempotent and
  // paying the generic crack healer every frame defeats streaming entirely.
  const ramp = bundle._lbStreamRamp !== false;
  // Reuse the prior frame's wrapper arrays in place (fixed n; each slot is
  // overwritten below, and a same-index read-then-write per iteration is safe)
  // — no per-frame Array(n) garbage. They become _lbMeshesRaw/_lbMeshes again.
  const raw = (prevRaw && prevRaw.length === n) ? prevRaw : new Array(n);
  const packed = (prevPacked && prevPacked.length === n) ? prevPacked : new Array(n);
  const meta = bundle.metaFloats, stride = bundle.metaFloatsPerShape | 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, inkShapes = 0, hasSlug = false;
  // Track whether any RENDERED shape has a translucent fill. An all-opaque
  // solid bundle can take the one-draw combined route (opaque OVER is overlap-
  // idempotent); a translucent solid must compose via the coverage→composite
  // path (combined OVER would conflate self-overlap). The `_lbSolidOnly`
  // fast-path in _drawBundleLB gates on the resulting `_lbOpaque`.
  let anyTrans = false;
  const SLUG = STREAM_SLUG;

  for (let i = 0; i < n; i++) {
    const segs = perShapeSegs[i];
    if (!Array.isArray(segs))
      return { ok: false, reason: 'perShapeSegs[' + i + '] is not a segment array' };
    // A section the analytic fill can't serve (arc / loop / cusp / degenerate)
    // becomes a SLUG SENTINEL — skipped — rather than failing the WHOLE stream.
    // The combined route then draws the servable sections in ONE seamless pass;
    // failing the whole bundle would blank (or AA-fragment) the entire road when
    // a single transient section turns unservable mid-scroll.
    // PER-SHAPE FINGERPRINT SKIP: games stream whole bundles when only a few
    // shapes moved (a road game streams a STATIC track every frame; a wave
    // game's far waves sit still between cycles). An unchanged shape keeps
    // last frame's mesh + packed VBO outright — the refresh/rebuild (and its
    // healer/split work) runs only for shapes whose coordinates actually moved.
    let fp = 0x811c9dc5;
    for (let si9 = 0; si9 < segs.length; si9++) {
      const sg9 = segs[si9];
      fp = ((fp ^ sg9.type) * 0x01000193) >>> 0;
      const w9 = sg9.w ? (sg9.w * 4096) | 0 : 1;
      fp = ((fp ^ w9) * 0x01000193) >>> 0;
      for (const P9 of [sg9.p1, sg9.p2, sg9.p3, sg9.p4]) {
        if (!P9) continue;
        fp = ((fp ^ ((P9[0] * 4096) | 0)) * 0x01000193) >>> 0;
        fp = ((fp ^ ((P9[1] * 4096) | 0)) * 0x01000193) >>> 0;
      }
    }
    fp = (fp ^ segs.length) >>> 0;
    const fps = bundle._lbSegFp || (bundle._lbSegFp = []);
    if (fps[i] === fp && prevRaw && prevRaw[i] && prevPacked && prevPacked[i]) {
      raw[i] = prevRaw[i]; packed[i] = prevPacked[i];
      if (prevRaw[i].slug) { hasSlug = true; continue; }
      const bbP = pathBbox(segs);
      if (stride && meta) {
        const bP = i * stride;
        meta[bP] = bbP[0]; meta[bP + 1] = bbP[1]; meta[bP + 2] = bbP[2]; meta[bP + 3] = bbP[3];
      }
      if (packed[i].vertexCount) {
        if (bbP[0] < bx0) bx0 = bbP[0];
        if (bbP[1] < by0) by0 = bbP[1];
        if (bbP[2] > bx1) bx1 = bbP[2];
        if (bbP[3] > by1) by1 = bbP[3];
        inkShapes++;
        if (stride && meta) { const a = meta[i * stride + 7]; if (a > 0.004 && a < 0.996) anyTrans = true; }
      }
      continue;
    }
    fps[i] = fp;
    const contours = segsToContours(segs);
    let mesh = null;
    if (contours) {
      try {
        mesh = (prevRaw && prevRaw[i] && !prevRaw[i].slug) ? refreshLoopBlinnMesh(prevRaw[i], contours)
                                                          : buildLoopBlinnMesh(contours, ramp);
      } catch { mesh = null; }
      if (mesh && mesh.fallback.length) mesh = null;   // loop/cusp
    }
    // Per-shape bbox → meta texel 0 (drives the shape's em→NDC + LB eligibility).
    const bb = pathBbox(segs);
    if (stride && meta) {
      const b = i * stride;
      meta[b] = bb[0]; meta[b + 1] = bb[1]; meta[b + 2] = bb[2]; meta[b + 3] = bb[3];
    }
    if (!mesh) { raw[i] = SLUG; packed[i] = SLUG; hasSlug = true; continue; }
    raw[i] = mesh;
    // Reuse the prior frame's packed VBO for this shape (fixed topology →
    // same vertex count → refilled in place, no allocation). Don't reuse a
    // sentinel slot from a frame where this shape was unservable.
    packed[i] = packLoopBlinnMesh(mesh, prevPacked && prevPacked[i] && !prevPacked[i].slug ? prevPacked[i] : undefined);
    if (!packed[i] || packed[i].overBudget || packed[i].slug) {
      raw[i] = SLUG; packed[i] = SLUG; hasSlug = true; continue;
    }
    // Global bbox from the RENDERED shapes only (the original behavior) — drives
    // the bundle's em→NDC mapping.
    if (packed[i].vertexCount) {
      if (bb[0] < bx0) bx0 = bb[0];
      if (bb[1] < by0) by0 = bb[1];
      if (bb[2] > bx1) bx1 = bb[2];
      if (bb[3] > by1) by1 = bb[3];
      inkShapes++;
      if (stride && meta) { const a = meta[i * stride + 7]; if (a > 0.004 && a < 0.996) anyTrans = true; }
    }
  }
  // Every section unservable → nothing analytic to stream; let the caller fall
  // back (a full Slug rebuild) rather than publish an all-sentinel bundle.
  if (inkShapes === 0) return { ok: false, reason: 'no analytic-servable shapes' };

  // Publish the directly-built meshes so the renderer's _ensureLbMeshes
  // returns them as-is (cached at the new gen) — no curveFloats decode.
  const gen = (bundle._geomGen | 0) + 1;
  bundle._lbMeshesRaw = raw;
  bundle._lbMeshes = packed;
  bundle._lbGen = gen;
  bundle._lbHasSlug = hasSlug;   // combined route skips sentinel sections (renderer reads this)
  // Leave bundle._lbCombined in place (don't null it): the bumped _geomGen
  // already makes _ensureLbCombined rebuild, and keeping the prior wrapper
  // lets it refill that combined VBO in place (fixed topology). It returns a
  // fresh wrapper object, so the GPU re-upload still fires.
  bundle._geomGen = gen;
  bundle._lbStream = true;          // route LB despite geomGen>0
  // The occlusion cull (occlusionCull.js) is computed ONCE at import against the
  // geometry as authored. Streaming moves the shapes, so a shape that was hidden
  // then need not be hidden now — the road's bands overlap at load and separate as
  // they scroll, and keeping the cull dropped whole bands mid-road. This path does
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
  // A lightweight stream bundle is solid-fill by construction (it rejected
  // stroke/clip/mask/dash above, and buildStreamableSections only carries
  // {segs, fill} — no gradient/image). Flag it so the draw route skips the
  // per-frame O(numShapes) feature-classification + eligibility sweeps and
  // goes straight to the one-draw combined route (see _drawBundleLB).
  bundle._lbSolidOnly = true;
  bundle._lbOpaque = !anyTrans;     // gates the all-opaque combined-route fast path
  if (inkShapes > 0) bundle.globalBBox = [bx0, by0, bx1 - bx0, by1 - by0];
  // Shapes moved: imported occupancy cells are no longer valid for the new
  // positions. Retire the acceleration (correct-but-unaccelerated) rather than
  // skipping interiors against a stale grid.
  clearStreamedOccupancy(bundle, meta, n, stride);
  return { ok: true };
}

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
 * automatically on the next draw. The lightweight path falls back to the full
 * rebuild for any shape it can't serve (arc / loop-cusp geometry), so it is
 * always safe to request. (It requires the analytic-fill shaders, which
 * loadShaders includes by default.)
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} bundle  a createBundle() output (mutated in place)
 * @param {Array<Array<object>>} perShapeSegs  one segment list per shape
 * @param {object} [opts]
 * @param {boolean} [opts.lightweight=false]  use the GPU-resident fast path
 * @param {Array<Array<number>>} [opts.fills]  optional straight-RGBA fill per shape
 * @returns {{ok:boolean, reason?:string, reallocated?:boolean}}
 *   ok:false → caller should fall back to a full importSvg→createBundle.
 */
export function updateBundleGeometry(gl, bundle, perShapeSegs, opts = {}) {
  const pairBands = !!(bundle && bundle.pairBands);
  // Per-shape fills (opts.fills: one straight-alpha rgba per shape) → write
  // straight to the meta fill texel so BOTH the analytic LB combine and the
  // Slug cover-quad path pick them up. This lets a streamed bundle recolor
  // per frame (e.g. depth-fogging road bands) WITHOUT a per-draw override —
  // overrides exclude the bundle from the allocation-light LB route.
  if (opts.fills) {
    const fmeta = bundle.metaFloats, fstride = bundle.metaFloatsPerShape | 0, fn = bundle.numShapes | 0;
    if (fmeta && fstride) {
      for (let i = 0; i < fn; i++) {
        const f = opts.fills[i];
        if (!f) continue;
        const b = i * fstride;
        fmeta[b + 4] = f[0]; fmeta[b + 5] = f[1]; fmeta[b + 6] = f[2]; fmeta[b + 7] = f[3];
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
  const useLight = opts.lightweight === true
    || (opts.lightweight !== false && (bundle._lbStream || noCoverQuads));
  if (useLight) {
    const r = streamGeometryLightweight(bundle, perShapeSegs);
    if (r.ok) return r;
    // A shape wasn't analytic-serveable (arc / loop-cusp) → fall through to the
    // full rebuild, which regenerates cover-quads + makes it Slug-renderable.
  }
  const n = bundle.numShapes | 0;
  if (!Array.isArray(perShapeSegs) || perShapeSegs.length !== n)
    return { ok: false, reason: 'perShapeSegs length must equal bundle.numShapes' };
  const stride = bundle.metaFloatsPerShape | 0;
  if (stride !== META_STRIDE)
    return { ok: false, reason: 'in-place streaming requires v3 meta stride (48)' };
  // Position-dependent auxiliary geometry can't be streamed by a fill-
  // only update — bail so the caller does a full rebuild instead.
  if ((bundle.strokeMesh && bundle.strokeMesh.byteLength) ||
      (bundle.clipMesh && bundle.clipMesh.byteLength) ||
      (bundle.maskMesh && bundle.maskMesh.byteLength) ||
      (bundle.dashFloats && bundle.dashFloats.length))
    return { ok: false, reason: 'bundle has stroke/clip/mask/dash geometry (unsupported in v1)' };

  const meta = bundle.metaFloats;   // CPU mirror; mutated in place

  // Fresh geometry accumulators. Sentinel zero-texel at curve index 0
  // matches the importer (meta uses curve index 0 = "no segment").
  const curveBuf = makeTexelBuffer();
  texelAppend(curveBuf, 0, 0, 0, 0);
  const bandBuf = makeTexelBuffer();

  const hybridFloats = [];
  const curveBegins = new Array(n);   // per-shape curve write head (float units)
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  let inkShapes = 0;

  for (let i = 0; i < n; i++) {
    const segs = perShapeSegs[i];
    if (!Array.isArray(segs))
      return { ok: false, reason: 'perShapeSegs[' + i + '] is not a segment array' };
    const base = i * stride;
    const bb = pathBbox(segs);
    const { bandsX, bandsY } = pickBandsXY(segs, bb);
    // Curve write head BEFORE this shape's curves are appended (float
    // units) — the authoritative per-shape curve range start, same as
    // emitShape's _curveStartF.
    curveBegins[i] = curveBuf.count * 4;
    // This path already bailed on any stroke geometry above, so every shape's
    // curve buffer is fill-only → skip the stroke metadata (pairing/tangents/
    // arc-length) for a cheaper rebuild on complex shapes.
    // Rebuilt bands MUST match the layout the bundle was emitted with, or the
    // AAC walker's stride (b += 2 for pair bands) reads the wrong stripes.
    const info = buildTexturesShape(segs, bandsX, bandsY, bb, curveBuf, bandBuf, 0, true, false, pairBands);

    // Patch meta texel 0 (per-shape bbox) + texel 4 (glyphLoc + bandMax).
    // Everything else in the row (fill / stroke / gradient ids / clip /
    // mask / filter / flags) is left exactly as the original import set
    // it — this is a geometry-only update.
    meta[base + 0] = info.bbox[0];
    meta[base + 1] = info.bbox[1];
    meta[base + 2] = info.bbox[2];
    meta[base + 3] = info.bbox[3];
    meta[base + META_TEXEL_4]     = info.glyphLoc[0];
    meta[base + META_TEXEL_4 + 1] = info.glyphLoc[1];
    meta[base + META_TEXEL_4 + 2] = info.bandMaxX;
    meta[base + META_TEXEL_4 + 3] = info.bandMaxY;

    // Cover quad — geometry from segs only; gid + fill rgba carried from
    // the original meta so the chunk→shape mapping and header stay
    // byte-identical. getCoverQuadMesh ignores fillRgba/fillRule for the
    // quad geometry (they only stamp the chunk header), so the quad
    // tracks the new positions exactly.
    const gid = Math.floor(meta[base + 14] + 0.5);
    const fr = meta[base + 4], fg = meta[base + 5], fb = meta[base + 6], fa = meta[base + 7];
    const mesh = getCoverQuadMesh(segs, gid, [fr, fg, fb, fa], 'nonzero');
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
  const band  = toPaddedPlane(bandBuf);
  const allocCurveRows = planeRows(bundle.curveFloats ? bundle.curveFloats.length : curve.unpadded);
  const allocBandRows  = planeRows(bundle.bandFloats  ? bundle.bandFloats.length  : band.unpadded);
  let reallocated = false;

  // --- Curve texture ---
  if (curve.height > allocCurveRows) {
    gl.deleteTexture(bundle.curveTex);
    bundle.curveTex = makeTex(gl, curve.padded, TEX_W, curve.height,
                              gl.RGBA32F, gl.RGBA, gl.FLOAT);
    reallocated = true;
  } else {
    gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, curve.height,
                     gl.RGBA, gl.FLOAT, curve.padded);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // --- Band texture ---
  if (band.height > allocBandRows) {
    gl.deleteTexture(bundle.bandTex);
    bundle.bandTex = makeTex(gl, band.padded, TEX_W, band.height,
                             gl.RGBA32F, gl.RGBA, gl.FLOAT);
    reallocated = true;
  } else {
    gl.bindTexture(gl.TEXTURE_2D, bundle.bandTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, band.height,
                     gl.RGBA, gl.FLOAT, band.padded);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // --- Meta texture (shape count unchanged → same dims, full re-upload).
  // For v3 stride the meta plane IS metaFloats (no repack).
  gl.bindTexture(gl.TEXTURE_2D, bundle.metaTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FULL_META_W, Math.max(1, n),
                   gl.RGBA, gl.FLOAT, meta);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // --- CPU mirrors the renderer / morph / hit-test read from ---
  bundle.curveFloats = curve.padded.subarray(0, curve.unpadded);
  bundle.bandFloats  = band.padded.subarray(0, band.unpadded);
  // Per-shape curve ranges, rebuilt from the captured write heads so
  // morph / hit-test consumers reading bundle.curveRangesByShape stay
  // correct even if a shape's curve-buffer offset shifted.
  const ranges = new Array(n);
  for (let i = 0; i < n; i++) {
    ranges[i] = {
      begin: curveBegins[i] | 0,
      end: (i + 1 < n ? curveBegins[i + 1] : curve.unpadded) | 0,
    };
  }
  bundle.curveRangesByShape = ranges;

  // Global bbox (xywh) drives the em→NDC mapping + band-coord transform.
  if (inkShapes > 0) {
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
    ? buildShapeIdxFloats(cqf, bundle.coverQuadChunks, bundle.gidToShapeIdx) : null;
  // Repack the header-free VBO planes + restamp vboStart for the new mesh.
  const strip = cqf
    ? buildStrippedCoverQuad(cqf, bundle.coverQuadChunks, bundle.hybridShapeIdxFloats) : null;
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
    bundle.metaFloats, n, bundle.metaFloatsPerShape | 0,
    chunkByShape, bundle.filterGraphs);

  // This is the full (Slug) rebuild — the curve/band textures + cover-quad
  // mesh are now live. Clear any `_lbStream` flag left by a prior lightweight
  // update so the draw route renders from this fresh data instead of the now-
  // stale analytic meshes.
  bundle._lbStream = false;
  bundle._lbSolidOnly = false;

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
    const g = meta[b + 21];
    if (!(g > 0)) continue;
    meta[b + 20] = 0;
    meta[b + 21] = 0;
  }
}
