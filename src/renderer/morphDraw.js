// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { unitCoverageShadow } from '../filterGraph/filterGraph.js';

import {
  deleteGlResource,
  deleteProgramWhenLinked,
  resourceGeneration,
  trackGlResource,
  createTrackedProgram,
} from './contextResources.js';
// morphDraw.js — Loop-Blinn morph, signed morph RT path, bundle LB routes.

import {
  canClaimFillMeshes,
  claimFillMeshes,
  releaseFillMeshes,
  MESH_OWNER,
} from './fillMeshOwner.js';
import { buildPrimMeshes } from './primBuild.js';
import { sdfPrimitivesDisabled } from '../geom/shapeRecognize.js';
import { requireRendererFeature } from './featureRegistry.js';
import {
  setPreferBezout,
  curveRangeToContours,
  LB_VERT_FLOATS,
  LB_MAX_VERTS_PER_MESH,
  LB_MAX_VERTS_PER_BUNDLE,
  setLbShapeMemoryBudget,
  getLbShapeMemoryBudget,
} from './loopBlinn.js';
import { lbShapePicks, lbBundleMayPick, lbBuildSkipMask } from './lbShapePolicy.js';
import { setLbPreparer, setLbBuilder, enqueueLbPrepare } from './bundle.js';
import { SEG_LINE, SEG_CUBIC, SEG_ARC } from '../primitives/seg.js';
import { FS_GROUP_BEGIN, FS_GROUP_END } from '../bundle/layout.js';
// The pure fill-route predicates + Slug sentinel live in lbBuildCore.js (the
// GL-free build core, also imported by the LB worker) so the static, morph, and
// worker build paths can't drift. Aliased to the historic underscore names.
import {
  SLUG as LB_SLUG,
  SLUG_WHY,
  slugFor,
  buildLbShape,
  foldStreamedBuild,
  contoursArePrimitive,
} from './lbBuildCore.js';
import { requestLbBuild, requestMorphBuild } from './lbWorkerPool.js';
import { ENGINES, ROUTES, DECLINE, engineOfBundle } from './engineLedger.js';
// The engine switches are read from their own module rather than through the renderer, because the
// builders below are registered in a module-level chain and run for bundles no renderer has drawn.
import { engineSelection, analyticAllowed } from './engineSwitch.js';
import { arcMorphNeedsCpuLerp } from './arcMorphGate.js';
/// May analytic meshes be BUILT at all right now? A build nobody may draw is pure cost, and on the
/// very run that is trying to measure the engine it excludes.
const _buildAllowed = (R) => analyticAllowed(engineSelection(R), 'build').allow;

/// Is the PER-SHAPE policy what decides which shapes draw their mesh, FOR THE LIFE OF this BUNDLE?
///
/// Not "is the mode 'auto'" -- the DEFAULT is 'auto' too, and a caller that never touched the
/// setter has made no commitment about what happens after a later pin. Only an explicit selection
/// (setLoopBlinnFill('auto') / setFillEngine({route:'auto'}), see the contract there) says the
/// policy decides; every other mode draws every mesh it is given.
const _policyDecides = (R) =>
  R._lbFillMode === 'auto' &&
  R._lbAutoExplicit === true &&
  R.opts.cpatchFill !== true &&
  R.opts.unifiedFill !== 'force';

/// The rows this build may skip, or null to build every row. Stamped on the bundle so the two build
/// paths agree and so the transport can carry it into the worker.
function lbBuildSkipFor(R, bundle) {
  if (!bundle || bundle._morphSrc || bundle._lbStream || !_policyDecides(R)) return null;
  return lbBuildSkipMask(bundle, R.opts && R.opts.cpatchAuto === true);
}
// A morph posed by CPatch keeps its meshes only while the renderer pins CPatch. Once the pin is
// gone they describe the last CPatch pose, not the requested engine, and while CPatch holds them
// no other engine can claim the bundle. Release them, drop the stream built from them, and give
// the raw curve plane back the current pose (CPatch may have stopped its uploads), so the morph
// rebuilds for the engine that was asked for. The plan is kept for a later pin.
function releaseUnwantedCPatchMorph(R, bundle) {
  if (bundle._fillMeshOwner !== MESH_OWNER.CPATCH || (R.opts && R.opts.cpatchFill === true))
    return false;
  const q = R._cpatchPending;
  if (q && bundle._cpatchBlend)
    for (let i = q.length - 1; i >= 0; i--) if (q[i].tgt === bundle._cpatchBlend) q.splice(i, 1);
  releaseFillMeshes(bundle, MESH_OWNER.CPATCH);
  bundle._cpatchMeshRef = null;
  bundle._cpatchMorphT = undefined;
  bundle._cpatchBlendKey = null;
  bundle._lbMeshesRaw = null;
  bundle._lbSlugWhy = null;
  bundle._lbHasSlug = undefined;
  bundle._lbKindMask = undefined;
  bundle._lbKindMaskGen = -1;
  bundle._lbAdoptKey = (bundle._lbAdoptKey | 0) + 1;
  const uf = bundle._unifiedFill;
  if (uf) {
    if (uf.glo) {
      deleteGlResource(R.gl, 'VertexArray', uf.glo.vao);
      deleteGlResource(R.gl, 'Buffer', uf.glo.buf);
    }
    if (uf.coef && uf.coef.tex) deleteGlResource(R.gl, 'Texture', uf.coef.tex);
    bundle._unifiedFill = null;
  }
  const ms = bundle._morphSrc,
    resume = ms.skipUploads || ms.skipCurveUploads;
  ms.skipUploads = false;
  ms.skipCurveUploads = false;
  if (resume && typeof ms.relerp === 'function') ms.relerp();
  return true;
}

// Transfer static mesh ownership when the selected engine needs a different build.
// An automatic CPatch decline keeps its LB fallback until geometry changes.
function syncFillMeshOwner(R, bundle) {
  if (!bundle || bundle._lbStream) return;
  if (bundle._morphSrc) {
    releaseUnwantedCPatchMorph(R, bundle);
    return;
  }
  const pin = !!(R.opts && R.opts.cpatchFill === true);
  const auto = !!(R.opts && R.opts.cpatchAuto === true && R._lbFillMode === 'auto' && !pin);
  const owner = bundle._fillMeshOwner;
  const untried = bundle._cpatchAutoTriedGen !== (bundle._geomGen | 0);
  // An automatic refusal can omit paints that an explicit pin must prepare.
  if (
    pin &&
    ((!owner &&
      bundle._lbGen === (bundle._geomGen | 0) &&
      bundle._cpPreparedTerminalAutoPolicy !== false) ||
      (bundle._cpPreparedTerminalAutoPolicy === true &&
        bundle._cpPreparedTerminalGen === (bundle._geomGen | 0)))
  ) {
    bundle._lbGen = -1;
    bundle._lbBuildGated = false;
    bundle._cpPreparedTerminalAutoPolicy = false;
  }
  if (
    (owner === MESH_OWNER.LB && (pin || (auto && untried && !((bundle._cpatchBuilt | 0) > 0)))) ||
    (owner === MESH_OWNER.CPATCH && ((!pin && !auto) || (pin && bundle._cpatchAutoBuilt === true)))
  ) {
    releaseFillMeshes(bundle, owner);
    bundle._lbGen = -1;
    bundle._lbMeshesRaw = null;
    bundle._lbBuildGated = false;
    bundle._lbAdoptKey = (bundle._lbAdoptKey | 0) + 1;
    bundle._lbKindMask = undefined;
    bundle._lbKindMaskGen = -1;
  }
}

/// Are these meshes a GATED build that the current selection would now draw more of? A gated bundle
/// holds fewer meshes than an ungated one, so a pin has to rebuild rather than quietly doing less
/// than it says -- and READINESS has to mean this too, because the gated meshes are real, non-Slug
/// and at the current generation throughout the rebuild.
function lbBuildStale(R, bundle) {
  if (!bundle || bundle._morphSrc || bundle._lbStream) return false;
  if (bundle._lbBuildGated && !_policyDecides(R)) return true;
  const cpAuto = !!(
    R.opts &&
    R.opts.cpatchAuto === true &&
    R._lbFillMode === 'auto' &&
    R.opts.cpatchFill !== true
  );
  const cpPin = !!(R.opts && R.opts.cpatchFill === true);
  if (bundle._fillMeshOwner === MESH_OWNER.LB && cpPin) return true;
  if (bundle._fillMeshOwner === MESH_OWNER.CPATCH && !cpPin && !cpAuto) return true;
  if (
    cpAuto &&
    !((bundle._cpatchBuilt | 0) > 0) &&
    bundle._cpatchAutoTriedGen !== (bundle._geomGen | 0)
  )
    return true;
  if (bundle._fillMeshOwner === MESH_OWNER.CPATCH && bundle._cpatchAutoBuilt === true && !cpAuto)
    return true;
  return false;
}

// Per-draw scratch (shaded LB path) — avoids 4–5 array literals per composed shape.
const _scFill = new Float32Array(4);
const _scBBox = new Float32Array(4);
const _scCover = new Float32Array(4);
const _scStroke = new Float32Array(4);
const _scImg = new Float32Array(4);
const _scAtlas = new Float32Array(4);

// GLOBAL mesh cache: the shape's curve span, exactly, plus every other input the build reads →
// {raw, pk} | null(=Slug); LRU ≤768. MUST live at MODULE level: declared any narrower it is
// recreated empty on every ensure, and per-frame gen bumps on morph/timeline bundles would then
// rebuild every shape from scratch each frame. (The worker path makes draw-time builds rare; this
// still serves the synchronous prewarm + morph endpoints.)
//
// Exact cache hits require identical curve float bits and build settings. The
// hash pair selects a bucket; stored bits verify the match at every scale.
// Similarity-derived entries describe transformed geometry, not the builder's
// triangulation, and are excluded when builderOnly is requested.
// Settings include fill rule, translucent-solid routing, Bezout preference,
// primitive recognition and forceCdt; both cache tiers use the same suffix.
const _lbMeshCache = new Map();
/// The bucket key for curve floats [begin, end) of `u32` (the curve table's bit view).
function _lbMcKey(u32, begin, end, suffix) {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = begin; i < end; i++) {
    const b = u32[i];
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 + b, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
  }
  return h1 + '_' + h2 + '_' + (end - begin) + suffix;
}
/// The cached value for these exact bits -- `{raw, pk}`, `null` (a Slug verdict) -- or undefined.
function _lbMcGet(key, u32, begin, end, builderOnly = false) {
  const e = _lbMeshCache.get(key);
  if (e === undefined || (builderOnly && e.derived)) return undefined;
  const src = e.src,
    n = end - begin;
  if (src.length !== n) return undefined;
  for (let i = 0; i < n; i++) if (src[i] !== u32[begin + i]) return undefined;
  _lbMeshCache.delete(key);
  _lbMeshCache.set(key, e); // LRU touch
  return e.v;
}
function _lbMcSet(key, u32, begin, end, v, derived = false) {
  if (!_lbMeshCache.has(key) && _lbMeshCache.size >= 768)
    _lbMeshCache.delete(_lbMeshCache.keys().next().value);
  _lbMeshCache.set(key, { src: u32.slice(begin, end), v, derived });
}
const SLUG = LB_SLUG;

/// PER-SHAPE ADOPTION, batched. The off-thread builder finishes shapes one at a time and the bundle
/// can draw each one as it lands, but every adoption REBUILDS the unified vertex stream — so
/// adopting one shape at a time would rebuild it once per shape, which on a heavy asset is hundreds
/// of rebuilds of a multi-megabyte buffer to show a few triangles sooner each time.
///
/// So a batch is published when EITHER threshold trips: `lbAdoptMs` since the last batch, or
/// `lbAdoptShapes` newly finished shapes. TIME IS THE GATE IN USE, and the count is off by
/// default, because the cost being bounded is proportional to BUILD TIME and not to shape count: a
/// count threshold fires once per N shapes however cheap they are, so a bundle of many small shapes
/// (text, an icon sheet) pays a rebuild per group for no latency it could not have had anyway.
///
/// The interval also grows with the elapsed build (the worker's `dueAt`: a third of elapsed, floored
/// at `lbAdoptMs`). A flat interval makes adoptions grow LINEARLY with build length, so a heavy
/// bundle would rebuild the stream dozens of times; growing it keeps the early meshes arriving just
/// as promptly and makes the total grow with the logarithm of build length instead.
///
/// The growing interval costs nothing on a normal build (slightly fewer rebuilds than a flat
/// interval, same first paint) and bounds a pathologically long build at a handful of rebuilds
/// where a flat interval takes dozens; per-shape adoption takes one per shape, and a count-only
/// rule delays first paint while rebuilding once per group of small shapes.

/// Override per renderer with `lbAdoptMs` / `lbAdoptShapes` (0 disables either); `lbAdopt: false`
/// turns adoption off entirely and restores the single whole-bundle result.
const LB_ADOPT_SHAPES = 0;
const LB_ADOPT_MS = 100;

/** Drop module-level LB mesh caches (call from renderer.dispose). */
export function clearLbMeshCaches() {
  _lbMeshCache.clear();
}

const _lbGlStates = new WeakMap();
const MAX_PACKED_GL = 2048;
const MAX_PRIM_GL = 512;

function acquireLbGlState(gl) {
  let state = _lbGlStates.get(gl);
  const generation = resourceGeneration(gl);
  if (!state || state.generation !== generation) {
    state = { generation, users: 0, packed: new Map(), prim: new Map() };
    _lbGlStates.set(gl, state);
  }
  state.users++;
  return state;
}

function releaseLbGlState(gl, state) {
  if (!state || --state.users > 0) return;
  for (const g of state.packed.values()) {
    deleteGlResource(gl, 'VertexArray', g.vao);
    deleteGlResource(gl, 'Buffer', g.buf);
  }
  for (const tex of state.prim.values()) deleteGlResource(gl, 'Texture', tex);
  state.packed.clear();
  state.prim.clear();
  if (_lbGlStates.get(gl) === state) _lbGlStates.delete(gl);
}

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachMorphDraw(R) {
  /// DOES CPATCH SERVE this BUNDLE? Under route:'cpatch', every bundle, morphs included; under
  /// cpatchAuto, only static bundles whose rows may pick in the 'auto' decision tree (never morphs).
  /** @type {(bundle?: object) => boolean} */
  const cpatchServes = () => R.opts.cpatchFill === true;
  /** @type {(bundle?: object) => boolean} */
  R._cpatchMorphWanted = (bundle) => R.opts.cpatchFill === true && !!bundle && !!bundle._morphSrc;
  /** @type {(bundle?: object) => boolean} */
  const cpatchStaticAutoServes = (bundle) =>
    R.opts.cpatchAuto === true &&
    R.opts.cpatchFill !== true &&
    R._lbFillMode === 'auto' &&
    !!bundle &&
    !bundle._morphSrc &&
    !bundle._lbStream;
  const _lbGlState = acquireLbGlState(R.gl);
  // Packed meshes are immutable, so keep one uploaded copy per WebGL context.
  // Re-upload if the CPU buffer grew (identity reuse / cache hits).
  /** Clamp a drawArrays count to what the VBO can feed at `floatsPerVert`.
   *  Pass `byteLength` from the CPU upload (or tracked GL cap) — do NOT rely
   *  on ARRAY_BUFFER_BINDING after bindVertexArray (that binding is not VAO
   *  state). Prevents `GL_INVALID_OPERATION: Vertex buffer is not big enough`. */
  function _lbClampDrawCount(want, floatsPerVert, byteLength) {
    const n = want | 0;
    if (n <= 0) return 0;
    const fpv = floatsPerVert | 0;
    if (fpv <= 0) return 0;
    const bytes = byteLength | 0;
    if (bytes <= 0) return 0;
    const maxN = (bytes / (fpv * 4)) | 0;
    if (maxN < n && typeof console !== 'undefined') {
      console.warn(
        '[mantle] LB draw clamped ' + n + ' → ' + maxN + ' verts (VBO too small for draw call)',
      );
    }
    return maxN < n ? maxN : n;
  }
  // GPU-resident morph-STROKE resources: program uniforms + a per-primitive
  // control-point data texture (RGBA32F, src texels then dst). Morph FILL
  // draws ride the unified stream's morph variant (MANTLE_LB_MORPH).
  // Incremental strokes composite analytic coverage from a pooled target.
  // These uniforms belong to the coverage compositor, independent of fill routing.
  R.lbcUCoverage = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uCoverage') : null;
  R.lbcUColor = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uColor') : null;
  // viewport / allocated-RT-size — the pooled coverage RT is quantized (>= viewport),
  // so the composite quad's UV must be scaled into the rendered region.
  R.lbcUCovScale = R.lbCompProg ? R.gl.getUniformLocation(R.lbCompProg, 'uCovScale') : null;
  R.splitStrokeU = R.splitStrokeProg
    ? {
        uPrim: R.gl.getUniformLocation(R.splitStrokeProg, 'uPrim'),
        uPrimW: R.gl.getUniformLocation(R.splitStrokeProg, 'uPrimW'),
        uHalfW: R.gl.getUniformLocation(R.splitStrokeProg, 'uHalfW'),
        uMiterLimit: R.gl.getUniformLocation(R.splitStrokeProg, 'uMiterLimit'),
        uCapStyle: R.gl.getUniformLocation(R.splitStrokeProg, 'uCapStyle'),
        uJoinStyle: R.gl.getUniformLocation(R.splitStrokeProg, 'uJoinStyle'),
        uDashId: R.gl.getUniformLocation(R.splitStrokeProg, 'uDashId'),
        uStrokeExactAa: R.gl.getUniformLocation(R.splitStrokeProg, 'uStrokeExactAa'),
        uDashTex: R.gl.getUniformLocation(R.splitStrokeProg, 'uDashTex'),
        uGBB: R.gl.getUniformLocation(R.splitStrokeProg, 'uGlobalBBox'),
        uCanvasAR: R.gl.getUniformLocation(R.splitStrokeProg, 'uCanvasAR'),
        uWorldM: R.gl.getUniformLocation(R.splitStrokeProg, 'uWorldM'),
        uHasWorldM: R.gl.getUniformLocation(R.splitStrokeProg, 'uHasWorldM'),
        uViewport: R.gl.getUniformLocation(R.splitStrokeProg, 'uViewportSize'),
      }
    : null;
  // ── PARTITION MORPH PAIR (one code path: the static builder/packer/frag serve
  // morphs; only the VS lerps). The pair VBO interleaves the two STATIC packs
  // per vertex ([src 24f | dst 24f], stride 192B); the MANTLE_LB_MORPH_PAIR
  // VS variant mixes each attribute by uMorphT and runs the static body.
  // COVERAGE pass for a pair mesh (composed/translucent morphs): same program,
  // uDirect=0 → the static frag emits raw coverage; MAX blend into a pooled RT;
  // the composite stage (lbCompProg) is shared with the static cov path.
  // Route VAO: the 24-float geometry + a per-vertex RGBA paint (loc 7) → the
  // whole bundle draws in ONE drawArrays (no per-shape uniform/draw overhead).
  function _specRouteAttribs() {
    const FS = 29 * 4; // 24 geometry + 4 color floats + shapeRow
    R.gl.enableVertexAttribArray(0);
    R.gl.vertexAttribPointer(0, 2, R.gl.FLOAT, false, FS, 0);
    R.gl.enableVertexAttribArray(1);
    R.gl.vertexAttribPointer(1, 3, R.gl.FLOAT, false, FS, 8); // aTC vec3
    R.gl.enableVertexAttribArray(2);
    R.gl.vertexAttribPointer(2, 2, R.gl.FLOAT, false, FS, 20); // aFlags
    R.gl.enableVertexAttribArray(3);
    R.gl.vertexAttribPointer(3, 4, R.gl.FLOAT, false, FS, 28);
    R.gl.enableVertexAttribArray(4);
    R.gl.vertexAttribPointer(4, 4, R.gl.FLOAT, false, FS, 44);
    R.gl.enableVertexAttribArray(5);
    R.gl.vertexAttribPointer(5, 4, R.gl.FLOAT, false, FS, 60);
    R.gl.enableVertexAttribArray(6);
    R.gl.vertexAttribPointer(6, 4, R.gl.FLOAT, false, FS, 76);
    R.gl.enableVertexAttribArray(7);
    R.gl.vertexAttribPointer(7, 4, R.gl.FLOAT, false, FS, 96);
    R.gl.enableVertexAttribArray(8);
    R.gl.vertexAttribPointer(8, 1, R.gl.FLOAT, false, FS, 92); // aSeamM (pad float): kind-5 rquad mean(R)
    R.gl.enableVertexAttribArray(9);
    R.gl.vertexAttribPointer(9, 1, R.gl.FLOAT, false, FS, 112); // aShapeRow (combined route only)
  }

  // GPU-resident Loop-Blinn morph draw. Same 2-pass coverage→composite as
  // drawLoopBlinnMesh, but the morph vertex shader lerps control points by `t`
  // and recomputes klmn/edge-normals — so an animated morph reuses ONE static
  // mesh with zero CPU rebuild. `morph` = R.buildLoopBlinnMorph(...) output; its
  // VBO + per-primitive control-point texture are uploaded once and cached on it.
  // Resolve a (possibly interval-split) morph FILL mesh + global t to the
  // concrete sub-segment and its LOCAL t. A classification-changing morph is
  // stored as { segments:[{tLo,tHi,tLoB,tHiB,...meshFields}] } (loopBlinnMorph
  // partitionMorph): pick the segment whose draw range [tLo,tHi] owns t, then
  // remap t into its BUILD range [tLoB,tHiB]. The segment's sign/topology is
  // baked from [tLoB,tHiB] (a MARGIN inside the interval, where the curve is
  // unambiguously convex/concave), but its geometry must span the FULL [tLo,
  // tHi]. Because the VS lerp mix(src,dst,uT) is LINEAR, localT is left
  // UNCLAMPED: for t in the margin seam it EXTRAPOLATES (uT<0 or >1) to the
  // exact shape at t — so the seam is exact, not a frozen near-straight frame.
  // (partitionMorph caps the margin at ¼ the interval → localT ∈ [-0.5,1.5],
  // a bounded extrapolation that never folds the reused triangulation.) A
  // stable morph (no .segments) passes straight through. Each segment is a full
  // mesh object (vbo/prim/vertexCount/_primTex), so the existing bind logic —
  // keyed on `_lbmResident !== mesh` — swaps VBOs only when t crosses a seam.

  let _lbcU = null;
  const FILL_UNIFORM_NAMES = [
    'uCurveData',
    'uBandData',
    'uMetaTex',
    'uDashTex',
    'uGlobalBBox',
    'uNumShapes',
    'uShapeIdxOverride',
    'uCanvasAR',
    'uViewportSize',
    'uGradientTex',
    'uGradientStops',
    'uGradientCount',
    'uImageTex',
    'uImageAtlasSize',
    'uSecondaryImageTex',
    'uSecondaryImageAtlasSize',
    'uFilterTex',
    'uOverrideTex',
    'uHasOverrides',
    'uHasEmCoord',
    'uDrawAlpha',
    'uWorldM',
    'uHasWorldM',
    'uMaskRTArray',
    'uMaskRowToLayerTex',
    'uHasOffscreenMask',
    'uHasOccupancy',
    'uColorMatrixEnabled',
    'uColorMatrix',
    'uColorMatrixOffset',
    'uPalette',
    'uPaletteEnabled',
    'uPaletteChannel',
    'uPaletteSize',
    'uChannelLerpEnabled',
    'uChannelLerpPrimary',
    'uChannelLerpContrast',
    'uChannelLerpHighlight',
    'uExtClipTex',
    'uExtClipMode',
    'uLBCovTex',

    'uStrokeGates',
    'uStrokeExactAa',
    'uCoverBBox',
    'uLBShapeBBox',
    'uLBFill',
    'uLBStroke',
    'uLBImageRect',
    'uLBCovTexSize',
  ];
  /// The composed per-shape program, one variant per (fill source, stroke
  /// source) pair rather than a single welded one.
  ///
  /// `lbFillCov` — take fCov from the LB coverage RT. False means the fill is
  ///   computed IN-SHADER by whichever engine R.opts.fillDefines selects, which
  ///   is what makes "Slug/AAC/hard fill + split stroke" expressible.
  /// (The split-stroke coverage RT is gone: the composed program computes its
  ///   in-shader band walk.
  ///
  /// For a MORPH, in-shader fill reads the bundle's curve texture, so it is
  /// only correct while the morph is still lerping curves into it — i.e. with
  /// _morphSrc.skipUploads false. skipUploads is set true only when the LB
  /// route owns the fill, so the two conditions line up by construction; the
  /// caller asserts it via _composedFillNeedsCurves below.
  const _composedProgs = new Map();
  /// `begin`: with KHR_parallel_shader_compile only start the compile and link (nothing is asked of the program);
  /// the first draw that needs it finishes it, by then usually complete. Without the extension it is made at once.
  function _ensureFillLBCovProg(lbFillCov = true, begin = false) {
    const useAac = R.opts.fillKernel === 'aac' || (!R.opts.fillKernel && R.opts.aacFill === true);
    const key = (lbFillCov ? 1 : 0) + (useAac ? 2 : 0);
    let have = _composedProgs.get(key);
    if (have && have.pending) {
      if (begin && R._khrParallel) return null;
      // Finished only once ready (complete, GPU thread clear: gpuGate.js). Null is the existing answer for "no composed program": the clip / mask /
      // filter morph falls back to the Slug route for the frames until it is.
      if (R._khrParallel && R._nbNow() && !R._forceLinks && !R._programReady(have.prog))
        return null;
      have = _finishFillLBCovProg(key, have, lbFillCov);
    }
    if (have) {
      _lbcU = have.u;
      return have.prog;
    }
    // Strip ext-clip (gated off in drawBundle's morph branch) + pattern (excluded
    // by eligibility). RECOLOR (palette/colorMatrix/channelLerp) is KEPT: per-draw
    // recolor composes over the analytic fill for static/streamed bundles (the
    // uniforms are coherent → disabled = free, so the morph route, which excludes
    // recolor, pays nothing). One palette sampler → 14 units, under the 16 ceiling.
    const defs = ['MANTLE_COMPOSED', 'MANTLE_NO_EXTCLIP', 'MANTLE_NO_PATTERN']
      .concat(lbFillCov ? ['MANTLE_LB_FILL_COV'] : [])
      .concat(R.opts.fillDefines || [], useAac ? ['MANTLE_AAC'] : []);
    // both stages get the defines: the VERT expands a static unit quad from
    // uCoverBBox (no per-frame quad upload); the FRAG sources paint from
    // uniforms (no per-frame meta upload) and takes each coverage from the RT
    // or from its own kernel according to the two flags.
    const _ps0 = R._pendingShaders.length,
      _pp0 = R._pendingPrograms.length;
    const vs = R.compile(R.withDefines(R.shaderSources.fillVert, defs), R.gl.VERTEX_SHADER);
    const fs = R.compile(R.withDefines(R.shaderSources.fillFrag, defs), R.gl.FRAGMENT_SHADER);
    const p = createTrackedProgram(R.gl);
    R.gl.attachShader(p, vs);
    R.gl.attachShader(p, fs);
    R.gl.linkProgram(p);
    R._pendingShaders.length = _ps0;
    R._pendingPrograms.length = _pp0; // validated at the first draw (ours only)
    deleteGlResource(R.gl, 'Shader', vs);
    deleteGlResource(R.gl, 'Shader', fs);
    const rec = { pending: true, prog: p, u: null };
    _composedProgs.set(key, rec);
    if (R._gpuLabel) R._gpuLabel(p, 'lbCov:' + key);
    if (begin && R._khrParallel) return null;
    if (R._khrParallel && R._nbNow() && !R._forceLinks) return null; // started; the next ask finishes it once it is ready
    const done = _finishFillLBCovProg(key, rec, lbFillCov);
    if (done) _lbcU = done.u;
    return done ? done.prog : null;
  }
  function _finishFillLBCovProg(key, rec, lbFillCov) {
    const p = rec.prog;
    if (!R.gl.getProgramParameter(p, R.gl.LINK_STATUS)) {
      const logs = [R.gl.getProgramInfoLog(p)];
      for (const sh of (R.gl.getAttachedShaders && R.gl.getAttachedShaders(p)) || [])
        logs.push(R.gl.getShaderInfoLog(sh));
      R.mantleWarn(
        `[Mantle] composed fill variant (lbFillCov=${lbFillCov}) failed` +
          ' to build; clip/mask/filter morphs fall back to Slug.',
        ...logs,
      );
      deleteGlResource(R.gl, 'Program', p);
      const failed = { prog: null, u: null };
      _composedProgs.set(key, failed);
      return failed;
    }
    const U = {};
    for (const n of FILL_UNIFORM_NAMES) U[n] = R.gl.getUniformLocation(p, n);
    const done = { prog: p, u: U };
    _composedProgs.set(key, done);
    return done;
  }
  /// The composed programs the loading call started, finished when ready; answers how many still link.
  R._finishLbCovPrograms = (soft) => {
    let pending = 0;
    for (const [key, rec] of [..._composedProgs]) {
      if (!rec || !rec.pending) continue;
      if (soft && R._khrParallel && !R._programReady(rec.prog)) {
        pending++;
        continue;
      }
      _finishFillLBCovProg(key, rec, (key & 1) === 1);
    }
    return pending;
  };
  let _lbGlStateReleased = false;
  R._disposeLbCovPrograms = () => {
    for (const e of _composedProgs.values()) if (e.prog) deleteProgramWhenLinked(R.gl, e.prog);
    _composedProgs.clear();
    if (!_lbGlStateReleased) {
      _lbGlStateReleased = true;
      releaseLbGlState(R.gl, _lbGlState);
    }
    _lbcU = null;
  };

  // Offscreen FILTER for a morph shape: render the morphed SourceGraphic into
  // R.shapeFbo via `renderSource` (the composed draw), then run the same machinery
  // render() uses — a multi-primitive filterGraph (R.evaluateGraph) or a
  // single-kind blur/morphology/convolve — and composite the result over the
  // destination (fixed-function src-over). No cache: a morph is dynamic, so the key
  // would miss every frame anyway.
  /// `cacheId` OPTS INTO the tier-2b result cache. Omitted (the morph caller), this
  /// re-runs the kernel every frame, which is right there — a morph is dynamic, so
  /// the key would miss every time and only cost a copy. Passed (the unified route's
  /// static bundles), a redrawn STATIC filtered shape skips the source render and
  /// the kernel entirely, which is what renderer.js's drawList loop has always done.

  function _morphShapeFilter(bundle, s, filterId, graph, renderSource, cacheId) {
    // A shape that crosses the canvas edge filters in a FRAME (renderer/filterFrame.js): the body below runs unchanged with the
    // frame as its canvas, and its composites hand the result back shifted by the margin.
    const [vw, vh] = R.viewportSize();
    if (vw >= 1 && vh >= 1 && R._filterFrameFor && R._handle && R._handle.bundle === bundle) {
      const isG = !!(graph && graph.nodes && graph.nodes.length);
      const rec = isG ? null : R.filterRecord ? R.filterRecord(filterId) : null;
      const fr =
        isG || (rec && rec.kind >= 1)
          ? R._filterFrameFor(s | 0, vw, vh, isG ? graph : null, rec)
          : null;
      if (fr) {
        R._enterFilterFrame(fr);
        try {
          return _morphShapeFilterIn(bundle, s, filterId, graph, renderSource, cacheId);
        } finally {
          R._exitFilterFrame(fr);
        }
      }
    }
    return _morphShapeFilterIn(bundle, s, filterId, graph, renderSource, cacheId);
  }
  function _morphShapeFilterIn(bundle, s, filterId, graph, renderSource, cacheId) {
    const [cw, ch] = R.viewportSize();
    if (cw < 1 || ch < 1) return false;
    const framed = !!(R._filterFrameTop && R._filterFrameTop());
    // The <filter> region clips every composite below, hit or miss, as in renderer.js. It resolves against R._handle's
    // bundle, which is this one whenever the unified route draws it; any other caller gets no clip, not another's.
    const regionPx =
      R._handle && R._handle.bundle === bundle ? R._filterRegionRectPx(s | 0, cw, ch) : null;
    const isGraph = !!(graph && graph.nodes && graph.nodes.length);
    const outputOpacity = isGraph ? R._filterOutputOpacity(s, filterId) : 1;
    if (!(outputOpacity > 0)) return true;
    // Group SourceGraphic uses a separate depth/stencil target. Composite its
    // filtered result into the group accumulator and preserve the group's backdrop.
    // Outside a group, composite onto the canvas using the normal source target.
    const dst = R._groupTarget ? R._groupTarget() : null;
    const inGroup = dst !== null;
    let src;
    if (inGroup || framed) {
      const sRT = R._acquireShapeRT(cw, ch);
      src = { fbo: sRT.fbo, tex: sRT.tex };
    } else {
      R.ensureShapeFbo();
      src = { fbo: R.shapeFbo, tex: R.shapeFboTex };
    }
    // The kernels' in-place target: the default (shapeFbo + pingFbo) outside a group, the
    // source RT and a same-sized scratch inside one. Built only when a kernel runs.
    const kernelTarget = (lin) => {
      if (!inGroup && !framed) return undefined;
      const pRT = R._acquirePingRT(cw, ch, lin);
      return {
        fbo: src.fbo,
        tex: src.tex,
        pingFbo: pRT.fbo,
        pingTex: pRT.tex,
        pingLin: !!pRT.lin,
        w: cw,
        h: ch,
      };
    };
    // THE BACKDROP, only FOR A GRAPH THAT READS IT. BackgroundImage / BackgroundAlpha sample it as
    // a graph input; nothing else does -- every composite below is fixed-function src-over, which
    // reads the destination itself. Taken unconditionally, this would be a full-canvas copy of the
    // bound framebuffer per filtered shape per frame, hit or miss, with no reader.
    // In a group the backdrop is the accumulator so far, snapshotted into groupBackdropTex exactly
    // as the classic loop does -- never into mainCopyTex, which groupEnd still needs.
    const readsBackdrop = isGraph && !!R._graphReadsBackdrop && R._graphReadsBackdrop(graph);
    let bdTex = null;
    if (readsBackdrop) {
      if (inGroup) {
        R.ensureGroupBackdropTex();
        bdTex = R.groupBackdropTex;
        R.bindFb(R.gl.FRAMEBUFFER, dst);
      } else {
        R.ensureMainCopyTex();
        bdTex = R.mainCopyTex;
      }
      R._parkFillActiveUnit();
      R.gl.bindTexture(R.gl.TEXTURE_2D, bdTex);
      R.gl.copyTexSubImage2D(R.gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
    }
    // Cache only inputs represented by fKey. Backdrops, external clip textures,
    // palette LUTs, sprite subsets and mask meshes require the shared predicate.
    const cacheable = R._filterCacheable ? R._filterCacheable(bundle, graph) : !readsBackdrop;
    const ovr = R.draw.overrides;
    const fKey =
      cacheId && cacheable
        ? {
            geomGen: bundle._geomGen | 0,
            morphT: bundle._morphSrc ? bundle._morphSrc.t : 0,
            cw,
            ch,
            wmHash: R._wmHash ? R._wmHash(R.draw.worldM) : 0,
            shapeGen: R._rowFeedKey ? R._rowFeedKey(ovr, s | 0) : 0,
            recolor: R._recolorHash ? R._recolorHash() : 0,
            // Filter parameters invalidate each bundle independently, even when graph
            // nodes are shared with the source bundle until their first edit.
            paramGen: bundle._filterParamGen | 0,
            // Warm-up and final programs can produce different filtered pixels.
            variant: R._lastFillVariantKey || '',
            frameKey: framed ? R._filterFrameTop().key : '',
          }
        : null;
    let fEntry = cacheId ? R._getFilterCache(cacheId) : null;
    const singleKind =
      !graph || !graph.nodes || !graph.nodes.length
        ? R.filterRecord
          ? R.filterRecord(filterId)
          : null
        : null;
    // A cropped filter texture uses its root rectangle's dimensions. Canvas
    // resize is already represented by cw/ch in fKey.
    const eRect = fEntry && fEntry.rect;
    const eW = eRect ? eRect[2] : cw,
      eH = eRect ? eRect[3] : ch;
    if (
      fKey &&
      fEntry &&
      R._filterKeyMatches(fEntry, fKey) &&
      fEntry.shapeTex &&
      fEntry.w === eW &&
      fEntry.h === eH
    ) {
      // HIT: composite the stored FILTERED texture exactly the way the miss path
      // below composites its fresh one, so the two cannot drift.
      if (singleKind && singleKind.kind >= 1) {
        // Composite the cached texture directly; shapeFbo holds SourceGraphic.
        R._filterSingleKindComposite(singleKind, cw, ch, fEntry.shapeTex, dst, null, regionPx);
      } else {
        // Preserve the cropped root rectangle when placing the cached texture.
        R._compositeFilteredTex(
          fEntry.shapeTex,
          cw,
          ch,
          dst,
          eRect || null,
          regionPx,
          outputOpacity,
        );
      }
      if (R._handle) R._handle.fillPassAssetDirty = true;
      R._forgetFillUnits();
      R._uniFilterCacheHits = (R._uniFilterCacheHits | 0) + 1;
      return true;
    }
    /// MISS: keep the filtered texture for the next identical frame. Sized to the ROOT RECT
    /// when the graph produced one (so a small filtered shape does not hold a canvas-sized
    /// texture, and the byte budget is charged for what it actually uses), canvas-sized
    /// otherwise. `rect` rides on the entry so the hit path puts it back where it belongs.
    const storeFilterResult = (tex, rect, cs = 0) => {
      if (!fKey || !tex || srcDrew === false) return;

      if (!((R._unifiedFillDraws | 0) > 0)) return;

      if (R._psoWarming) return;
      const pl = R._resultPlacement(fEntry && fEntry.shapeTex ? fEntry : null, rect, cw, ch),
        sw = pl.w,
        sh = pl.h;
      if (R._filterStoreFits && !R._filterStoreFits(cacheId, sw * sh * 4)) {
        fEntry = null;
        return;
      }
      if (!fEntry) {
        fEntry = { w: 0, h: 0, key: null };
        R._setFilterCache(cacheId, fEntry);
      }
      // The rect has to be written BEFORE _ensureCacheTex, which reallocates on a size change
      // and reads entry.w/h to decide; and the two must not disagree afterwards, since the hit
      // path derives its size guard from the rect.
      fEntry.rect = pl.rect;
      R._ensureCacheTex(fEntry, 'shapeTex', sw, sh);
      fEntry.w = sw;
      fEntry.h = sh;
      // Read the SOURCE before touching any binding — the kernels leave their
      // target bound, so this samples it in situ and cannot perturb what follows.
      const probe = !!R.opts.unifiedFilterCacheProbe,
        ppx = probe ? new Uint8Array(4) : null;
      if (probe) R._uniFilterBlitProg = !!R.cacheBlitProg;
      // The probe samples the CENTER OF WHAT IS BEING COPIED, which is the rect when there is
      // one — (cw/2, ch/2) is outside a bbox-sized target and reads nothing.
      if (probe) {
        R.gl.readPixels((sw / 2) | 0, (sh / 2) | 0, 1, 1, R.gl.RGBA, R.gl.UNSIGNED_BYTE, ppx);
        R._uniFilterSrcPx = Array.from(ppx);
      }
      R._blitResult(tex, fEntry.shapeTexFbo, pl, cs);
      if (probe) {
        // _blitTexToFbo left the cache FBO bound, so this reads what it wrote.
        R.gl.readPixels((sw / 2) | 0, (sh / 2) | 0, 1, 1, R.gl.RGBA, R.gl.UNSIGNED_BYTE, ppx);
        R._uniFilterStorePx = Array.from(ppx);
      }
      if (R._noteResultStored) R._noteResultStored(fEntry, pl);
      fEntry.key = fKey;
      // Cache allocation binds its framebuffer directly. Restore the tracked
      // binding before compositing so bindFb cannot reuse a stale cached binding.
      R.bindFb(R.gl.FRAMEBUFFER, null);
    };
    // Render the morphed shape alone into the SourceGraphic target.
    R.bindFb(R.gl.FRAMEBUFFER, src.fbo);
    R.glViewport(0, 0, cw, ch);
    R.glDepthMask(true);
    R.gl.stencilMask(0xff);
    R.gl.clearColor(0, 0, 0, 0);
    R.gl.clearStencil(0);
    R.gl.clearDepth(1.0);
    R.gl.clear(R.gl.COLOR_BUFFER_BIT | R.gl.STENCIL_BUFFER_BIT | R.gl.DEPTH_BUFFER_BIT);
    R.glDepthMask(false);

    let srcDrew;
    const unitPaint =
      isGraph && unitCoverageShadow(graph) ? R._filterSourceMaterial(s, 1 / outputOpacity) : null;
    const proposedOpacity = unitPaint?.materialHi[3];
    const unitOpacity =
      proposedOpacity > 0 &&
      proposedOpacity <= 1 &&
      Number.isFinite(1 / (outputOpacity * proposedOpacity))
        ? proposedOpacity
        : 1;
    const previousInputScale = R._filterInputScale,
      previousCoverageScale = R._filterCoverageScale;
    R._filterInputScale = 1 / outputOpacity;
    R._filterCoverageScale = 1 / unitOpacity;
    try {
      srcDrew = renderSource();
    } finally {
      R._filterInputScale = previousInputScale;
      R._filterCoverageScale = previousCoverageScale;
    }
    if (isGraph) {
      const px = R._filterPxPerEm(cw, ch, s);
      const ctx = R._buildFilterCtx(
        cw,
        ch,
        px,
        { fbo: src.fbo, tex: src.tex, size: [cw, ch] },
        bdTex ? { fbo: null, tex: bdTex, size: [cw, ch] } : null,
        s,
        bundle,
        1 / outputOpacity,
      );
      ctx.unitCoverageOpacity = unitOpacity;
      const unitGraph =
        unitOpacity === 1
          ? graph
          : {
              ...graph,
              nodes: graph.nodes.map((n, i) =>
                i !== 2
                  ? n
                  : {
                      ...n,
                      params: {
                        ...n.params,
                        rgba: n.params.rgba.map((v, j) => (j === 3 ? v * unitOpacity : v)),
                      },
                    },
              ),
            };
      const ctLUTs = [];
      for (const n of graph.nodes) {
        if (n.type !== 'feComponentTransfer') {
          ctLUTs.push(null);
          continue;
        }
        const bytes = n.params && n.params.lutBytes;
        if (!bytes) {
          ctLUTs.push(null);
          continue;
        }
        const tex = trackGlResource(R.gl, R.gl.createTexture(), 'filterScratch');
        R._parkFillActiveUnit();
        R.gl.bindTexture(R.gl.TEXTURE_2D, tex);
        R.gl.texImage2D(
          R.gl.TEXTURE_2D,
          0,
          R.gl.RGBA8,
          256,
          4,
          0,
          R.gl.RGBA,
          R.gl.UNSIGNED_BYTE,
          ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes),
        );
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MIN_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_MAG_FILTER, R.gl.NEAREST);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_S, R.gl.CLAMP_TO_EDGE);
        R.gl.texParameteri(R.gl.TEXTURE_2D, R.gl.TEXTURE_WRAP_T, R.gl.CLAMP_TO_EDGE);
        n.params.lutIndex = ctLUTs.length;
        ctLUTs.push(tex);
      }
      ctx.componentTransferLUTs = ctLUTs;
      ctx.feImagePlacements = R._feImagePlacements(graph, s, cw, ch);
      // The graph binds offscreen RTs raw, so apply THEIR scissor rule -- off, or a pipeline warm's
      // pixel -- not the canvas's.
      if (R._applyTargetScissor) R._applyTargetScissor(src.fbo);
      // The morph route keeps the canvas-sized SourceGraphic (its shape FBO is shared
      // with the morph passes), so it takes the node rects only.
      const fInfo = R._filterNodeRects(graph, s, cw, ch);
      const rootRT = R.evaluateGraph(
        R.gl,
        unitGraph,
        R._rtPool,
        R._svgDispatch,
        ctx,
        cw,
        ch,
        fInfo ? fInfo.rects : null,
      );
      R._filterEvalCount++;
      for (const tex of ctLUTs) if (tex) deleteGlResource(R.gl, 'Texture', tex);
      // Store before compositing: the root is handed back to the pool right after. A
      // partial-canvas root (rootRT.rect) is cached AT ITS RECT and composited back through
      // it, exactly as the classic drawList loop's `_storeFilteredTex` has always done.
      // Refusing it here is what left a static graph-filtered shape with a filter bbox
      // smaller than the canvas re-evaluating its entire graph every frame for the life of
      // the page — and the smaller the shape, the more certain the refusal.
      if (fKey) storeFilterResult(rootRT.tex, rootRT.rect || null, rootRT.cs | 0);
      R._compositeFilteredTex(
        rootRT.tex,
        cw,
        ch,
        dst,
        rootRT.rect || null,
        regionPx,
        outputOpacity,
        -1,
        false,
        rootRT.cs | 0,
      );
      R.releaseRoot(R._rtPool, rootRT); // hand the root back — see renderer.js
    } else {
      const f = R.filterRecord(filterId);
      if (f && f.kind >= 1) {
        const px = R._filterPxPerEm(cw, ch, s);
        const kt = kernelTarget(f.linear);
        if (f.kind === 1) R.blurShapeFbo(f.sigmaX * px[0], f.sigmaY * px[1], kt, f.linear);
        else if (f.kind === 5) R.morphShapeFbo(f.tintR | 0, f.sigmaX * px[0], f.sigmaY * px[1], kt);
        else if (f.kind === 6) R.convolveShapeFbo(f, kt);
        R._filterEvalCount++;
        // The kernels filter the source IN PLACE, so its texture IS the filtered
        // result — the same thing renderer.js stores for its single-kind entry.
        if (fKey) storeFilterResult(src.tex, null); // filtered IN PLACE: canvas-sized
        R._filterSingleKindComposite(f, cw, ch, src.tex, dst, null, regionPx);
      } else {
        // kind 0 (color matrix) is applied inline by the composed draw; a plain
        // composite of the source over the destination suffices.
        R._compositeFilteredTex(src.tex, cw, ch, dst, null, regionPx);
      }
    }
    if (R._handle) R._handle.fillPassAssetDirty = true;
    R._forgetFillUnits();
    return true;
  }

  // ---- Loop-Blinn drawBundle routing (opt-in whole-bundle fast path) -------
  let _lbLastUploaded = null; // combined VBO currently resident in _lbBuf

  // ── GPU-resident LB morph route (opt-in via setLoopBlinnMorphFill) ─────────
  // Routes a MORPH handle (dynamic geometry, the OPPOSITE of the static route)
  // whose shapes are all solid-fill + GPU-morphable: build per-shape morph meshes
  // ONCE from the static endpoints (bundle._morphSrc, set by createShapeMorph)
  // and draw each through the unified stream, lerping geometry + recomputing the
  // implicit on the GPU. This both replaces Slug's per-fragment ray-cast AND
  // lets the morph's setT skip its per-frame CPU lerp + texture uploads. Mode:
  // 'off' · 'auto' (DEFAULT — route when morphable + perf says go) · 'on' (route
  // whenever morphable, ignore the perf estimate). Auto by default: any solid-
  // fill geometric morph transparently gets the GPU-resident path; morphs that
  // aren't morphable / not solid-fill fall through to Slug. Set 'off' to force
  // the Slug morph path. The mode is the SHARED R._lbFillMode (one toggle for
  // static + streamed + morph); the morph counters are R._lbMorphRouteCount /
  // R._lbMorphComposedCount.
  // SIMILARITY-invariant mesh cache: canonical-form key -> { raw, frame }.
  // Serves any translate/rotate/uniform-scale instance of a shape by transforming the full cached
  // assembly (transformLoopBlinnRaw) + repacking -- nothing is rebuilt.
  const _lbSimCache = new Map(); // LRU <= 512
  const _lbSimPut = (k, v) => {
    if (k === null) return;
    if (_lbSimCache.size >= 512) _lbSimCache.delete(_lbSimCache.keys().next().value);
    _lbSimCache.set(k, v);
  };
  let _bpFrame = -1,
    _bpSpent = 0; // global per-frame build pool (ms)
  let _bpLast = 0;
  const _bpTick = () => {
    const fr9 = R._frameSerial | 0,
      now9 = Date.now();
    if (_bpFrame !== fr9 || now9 - _bpLast > 16) {
      _bpFrame = fr9;
      _bpSpent = 0;
    } // 16ms gap = a new frame even without beginFrame
    _bpLast = now9;
  };
  R._clearLbCaches = () => {
    clearLbMeshCaches();
    _lbSimCache.clear();
  };
  // Adopt the worker's (or deferred-sync's) morph-pair build. `src` is the
  // _morphSrc captured at kickoff — if it no longer matches, the bundle was
  // re-targeted or disposed while the build was in flight, so drop the result.
  R._morphChainStats = { built: 0, lb: 0, gated: 0, gatedAfterLoad: 0 };
  const _morphAutoDeclines = (bundle) => R._lbFillMode === 'auto' && !bundle._lbRequested;
  // A morph 'auto' declined, asked for by a pin or awaitEngine afterwards: build it for them.
  R._morphChainRelease = (bundle) => {
    if (!bundle._morphChainGated || _morphAutoDeclines(bundle) || R._lbFillMode === 'off') return;
    bundle._morphChainGated = false;
    bundle._morphMeshesBuilt = false;
    bundle._morphWorkerSrc = null;
  };
  function _applyMorphResult(bundle, res, src) {
    if (!bundle || bundle._disposed || bundle._morphSrc !== src) return;
    bundle._morphWorkerSrc = src;
    bundle._morphMeshesBuilt = true;
    bundle._morphMeshesPartial = null;
    // WHY each shape has no morph mesh, and a declined shape's own cause, from the build that decided
    // it (lbMorphCensus reads them). Kept for a whole-bundle Slug too: that is the answer that needs one.
    bundle._morphSlugWhy =
      res && res.why && res.why.length === (bundle.numShapes | 0) ? res.why : null;
    bundle._morphPairWhy = (res && res.pairWhy) || null;
    // THE BUILD'S own CERTIFICATE: a face that exceeds its two chains paints what they miss as solid and can read a chain backwards, whole pixels of over-coverage and holes that
    // Slug does not have (on morphing text, many pixels far from the Chrome 8x reference where Slug has almost none). 'auto' draws Slug; the worker stops at the first such shape when it knows the mode.
    // A pin or awaitEngine rebuilds and draws the LB it asked for (_morphChainRelease). Known here, ahead of the loading call's warm: that call waits for this build.
    const chainGate =
      _morphAutoDeclines(bundle) &&
      !!res &&
      !res.err &&
      ((res.hasSlug && Array.isArray(res.pairWhy) && res.pairWhy.includes('chain-incomplete')) ||
        (!!res.meshes && res.meshes.some((m) => m && m.chainIncomplete9)));
    const mc = R._morphChainStats;
    mc.built++;
    if (chainGate) {
      mc.gated++;
      if (R._loadStats && R._loadStats.phase === 'done') mc.gatedAfterLoad++;
      if (res.meshes) {
        const nS = bundle.numShapes | 0,
          why = new Uint8Array(nS),
          pw = new Array(nS).fill(null);
        for (let s = 0; s < nS; s++) {
          const m = res.meshes[s];
          if (m && m.chainIncomplete9) {
            why[s] = SLUG_WHY.DECLINED;
            pw[s] = 'chain-incomplete';
          } else why[s] = SLUG_WHY.REAL;
        }
        bundle._morphSlugWhy = why;
        bundle._morphPairWhy = pw;
      }
      bundle._morphMeshes = null;
      bundle._morphChainGated = true;
      return;
    }
    if (!res || res.err || res.hasSlug || !res.meshes) {
      bundle._morphMeshes = null;
      return;
    } // whole-bundle Slug
    mc.lb++;
    // A morph whose arcs rotate or change radius scale lerps control points differently from SVG's arc interpolation: the CPU-lerp (Slug) route is exact
    if (arcMorphNeedsCpuLerp(src)) {
      bundle._morphMeshes = null;
      bundle._morphArcGated = true;
      return;
    }
    // Worker results arrive after preparation admission; budgets may have changed.
    if (_lbMemAccount(bundle, res.meshes, true)) bundle._morphMeshes = res.meshes;
  }
  function _ensureBundleMorphMeshes(bundle) {
    R._morphChainRelease(bundle);
    // Meshes built while LB was asked for (a pin, or a CPatch pin's fallback), now drawn under 'auto': the same decline as at adoption.
    if (
      bundle._morphMeshesBuilt &&
      bundle._morphMeshes &&
      _morphAutoDeclines(bundle) &&
      bundle._morphMeshes.some((m) => m && m.chainIncomplete9)
    ) {
      R._lbMemUsed -= bundle._lbMemBytes || 0;
      bundle._lbMemBytes = 0;
      bundle._morphMeshes = null;
      bundle._morphChainGated = true;
      R._morphChainStats.gated++;
    }
    if (bundle._morphMeshesBuilt) return bundle._morphMeshes;
    const src = bundle._morphSrc;
    const ranges = src && src.curveRanges,
      n = bundle.numShapes | 0;
    // latch the failure + fall back (null → the route Slugs the bundle)
    const _mmFail = () => {
      bundle._morphMeshesBuilt = true;
      bundle._morphMeshesPartial = null;
      return null;
    };
    if (!src || !src.matchedAll || !ranges || n < 1) return _mmFail();
    if (!R._lbMemAdmit(bundle, 2)) return _mmFail();
    if (bundle._morphWorkerSrc === src) return null; // worker in flight → Slug this frame
    try {
      requestMorphBuild(bundle, (res) => _applyMorphResult(bundle, res, src), {
        declineIncomplete: _morphAutoDeclines(bundle),
      });
    } catch {
      return _mmFail();
    }
    bundle._morphWorkerSrc = src;
    return null;
  }
  // 'auto' chooses the static analytic route SHAPE BY SHAPE (lbShapePolicy). The unified draw carries mesh entries and cover
  // quads in one stream through one program, so a bundle takes the route when any of its shapes should draw its mesh, and
  // entriesFor gives every other shape its cover quad.
  function _lbAutoPicks(bundle) {
    return lbShapePicks(R, bundle, bundle && bundle._lbMeshes);
  }

  function _drawBundleMorphRoute(bundle) {
    let cpatchFrameReady = false;
    //
    // Pending plans decline immediately. Coefficient posing can re-enter
    // the renderer through blend passes, so prevent recursive posing.
    if (R._cpatchMorphWanted(bundle) && R._cpatchMorphFrame && !bundle._cpatchPosing) {
      bundle._cpatchPosing = true;
      try {
        cpatchFrameReady = R._cpatchMorphFrame(bundle);
      } catch (ex) {
        R._cpatchMorphError = {
          msg: String((ex && ex.message) || ex),
          stack: (ex && ex.stack) || null,
        };
      } finally {
        bundle._cpatchPosing = false;
      }
    }
    // CPatch meshes already contain the current pose. Draw their unified
    // geometry directly instead of building an LB endpoint pair pack.
    if (
      cpatchFrameReady &&
      R._cpatchMorphWanted(bundle) &&
      bundle._cpatchMorphPlan &&
      (bundle._cpatchBuilt | 0) > 0 &&
      bundle._lbMeshes &&
      _drawBundleLB(bundle)
    )
      return true;
    // A pinned CPatch decline falls back to Slug, without building LB meshes.
    if (R._cpatchMorphWanted(bundle)) return false;
    syncFillMeshOwner(R, bundle);
    const meshes = _ensureBundleMorphMeshes(bundle);
    if (!meshes) return false;
    // Gradient fills compose with the LB direct path, so allow them when the
    // bundle carries a gradient texture (Slug otherwise).
    const allowGrad = !!bundle.gradientTex,
      allowImage = !!(bundle.imageAtlasTex || bundle.secondaryImageAtlasTex);
    // A clip/mask shape composes via the LB-coverage → ubershader path, but
    // only if the MANTLE_LB_COV variant builds AND the unified route can serve
    // its mesh (fast → 1-pass MAX coverage; signed → 2-pass |Σ| coverage).
    // Probe up front so the whole bundle cleanly falls to Slug when a composed
    // shape can't be served — never a half-drawn morph.
    // Composed strokes use the band walker and need no prepared stroke mesh.
    const meta0 = bundle.metaFloats,
      st0 = bundle.metaFloatsPerShape | 0,
      n0 = bundle.numShapes | 0;
    const dmeta0 = (bundle._morphSrc && bundle._morphSrc.dstMetaF32) || meta0;
    let allowComposed = true;
    // Does any composed shape have to compute its fill IN-SHADER — i.e. it has
    // a visible fill but no usable LB coverage mesh? Such a shape reads the
    // bundle's curve texture, which for a morph is only correct while setT is
    // still lerping into it. That decides skipUploads below.
    let needsInShaderFill = false;
    // Band-walk strokes read curve data, so they require setT uploads.
    let needsInShaderStroke = false;
    for (let s = 0; s < n0; s++) {
      const b0 = s * st0;
      // A filter that only the destination has (or only the source) composes the row from the middle of the morph on.
      if (
        !_morphShapeComposed(meta0, b0, st0) &&
        !(st0 >= 33 && dmeta0 !== meta0 && Math.floor(dmeta0[b0 + 32] + 0.5) !== 0)
      )
        continue;
      const stroked = meta0[b0 + 11] > 0 && meta0[b0 + 12] > 0;
      const hasFillMesh = !!meshes[s];
      // No coverage at all (fill=none and no stroke) → invisible; skip, don't fail the bundle.
      // Otherwise a fill shape needs a servable fill mesh; a stroke-only shape needs nothing,
      // because the band walk draws its stroke from the curve data every other route uses.
      if (!hasFillMesh && !stroked) continue;
      const mode = meshes[s] && meshes[s].mode;
      const fillOk = !hasFillMesh || mode === 'partitionPair';
      if (!fillOk || !_ensureFillLBCovProg()) {
        allowComposed = false;
        break;
      }
      // Visible fill at EITHER endpoint (the lerp can only stay inside that
      // range) with no mesh to cover it ⇒ the in-shader kernel will run.
      const m = meshes[s];
      const usableFillMesh = !!(m && !m.slug && m.vertexCount);
      if (!usableFillMesh && (meta0[b0 + 7] > 0.004 || dmeta0[b0 + 7] > 0.004))
        needsInShaderFill = true;
      if (stroked) needsInShaderStroke = true;
    }
    if (
      !_loopBlinnEligible(
        bundle,
        allowGrad,
        /* allowTrans */ true,
        allowImage,
        allowComposed,
        undefined,
        /* allowPrim */ true,
      )
    )
      return false;
    const src = bundle._morphSrc;
    // Composition for morphs. The zero-upload fast path holds only while every
    // composed fill comes from an LB coverage RT — the LB vertex shader lerps
    // control points itself, so the curve texture may go stale. The moment one
    // shape's fill must be computed in-shader (Slug/AAC/hard reading
    // uCurveData), that texture has to keep tracking t, so setT's lerp stays
    // on. Split strokes are unaffected either way: their VS lerps the segment
    // control points from the mesh, so the stroke needs no upload at any t.
    // This is what lets a morph mix an in-shader fill with a split stroke.
    // Unified route for morphs. The pair packs ride one vertex stream and the
    // ubershader mixes them by uMorphT, so the whole bundle — LB triangles and
    // cover quads alike — is one drawArrays with no per-shape coverage RT, the
    // same as the static route.

    let uniMorphReady = !!(
      R._unifiedMorphEligible &&
      R._unifiedMorphEligible(bundle) &&
      R._unifiedFillReady &&
      R._unifiedFillReady(bundle)
    );
    if (
      !uniMorphReady &&
      R._unifiedMorphEligible &&
      R._unifiedMorphEligible(bundle) &&
      R._unifiedFillGate === 'variant-warming'
    ) {
      try {
        if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
        if (R._precompileNow) R._precompileNow({ draw: false }); // inside a draw: no warm pixel, and no wait
        uniMorphReady = !!(R._unifiedFillReady && R._unifiedFillReady(bundle));
      } catch {
        /* fall through to the per-shape route */
      }
    }
    if (uniMorphReady && R._drawBundleUnifiedFill && R._drawBundleUnifiedFill(bundle, src.t)) {
      // A prepared fill draws its geometry from the pair's own endpoint streams and its color on the GPU, so its
      // raw curve plane may stay at an earlier pose (skipCurveUploads). Metadata and paint still advance in setT
      // whenever they move with t: a top-level <image> keeps its RECT in the meta row, which the GPU does not
      // lerp, and freezing it mapped the image onto the wrong rectangle. Which slots move is decided once, at
      // createShapeMorph, from the interpolated slots themselves (shapeMorph.js). A consumer that reads the curve
      // plane (cover quads, in-shader fill or stroke, mask regions) keeps it current; the renderer's fallback
      // restores it with relerp() before such a draw.
      src.skipCurveUploads =
        !R._unifiedFillUsedCover &&
        src.preparedCurveIndependent &&
        !needsInShaderFill &&
        !needsInShaderStroke &&
        !(R._handle && R._handle.bundle === bundle && R._handle.maskRegions.length);
      src.skipUploads = src.skipCurveUploads && !src.metaMovesWithT && !src.paintMovesWithT;
      R._lbMorphRouteCount++;
      return true;
    }
    // Unserved analytic morphs use the ordinary fill pass and its selected engine.
    return false;
  }

  // A shape carries a CLIP, MASK, inline FILTER (feColorMatrix), or visible STROKE
  // → it composes in the ubershader, inside the one unified draw,
  // NOT the direct draw (which would silently skip clip/mask/filter). Clip/mask/
  // filter run below the fCov seam over the LB fill (clip = inline coverage union;
  // mask = inline luminance/alpha walk; filter = applyFilterPre via the static
  // uFilterTex), so feeding LB coverage in composes them.
  // A per-shape override carries a non-identity 2×2 affine basis (texel 0) or
  // translate (texel 1.xy)? Such a row takes its cover quad, which samples it in its
  // own frame and reads its pixel footprint from the derivatives of that frame;
  // a Loop-Blinn mesh's footprint inputs (vEmPerPx, the chain cell map, the ring
  // reaches) come from the draw's world matrix, not the row's override, and the LB
  // coverage RT is sampled in screen space. The rest of the bundle stays analytic.
  // exact, as the vertex stage's own test (mantle.vert.glsl, vOverrideMask 0x8): a
  // tolerance of 1e-4 em is a scale -- 1e-4 em is a hundred pixels of a drawing made
  // 2^-20 small -- and a row moved by less kept its unmoved mesh.
  function _ovHasXform(ovP, s) {
    const ob = s * 24;
    return (
      ovP[ob] !== 1 ||
      ovP[ob + 1] !== 0 ||
      ovP[ob + 2] !== 0 ||
      ovP[ob + 3] !== 1 ||
      ovP[ob + 4] !== 0 ||
      ovP[ob + 5] !== 0
    );
  }
  // The unified fill route asks the same test (entriesFor, _unifiedCoverRows), for
  // the footprint reason above: a transformed row takes its cover quad there too.
  R._ovHasXform = _ovHasXform;
  function _morphShapeComposed(meta, b, st) {
    return (
      Math.floor(meta[b + 30] + 0.5) !== 0 || // clipId (texel 7.z)
      Math.floor(meta[b + 31] + 0.5) !== 0 || // maskId (texel 7.w)
      (st >= 33 && Math.floor(meta[b + 32] + 0.5) !== 0) || // filterId (texel 8.x, inline only)
      (meta[b + 11] > 0 && meta[b + 12] > 0)
    ); // visible stroke
  }
  function _lbShapeEligible(
    meta,
    b,
    st,
    allowGrad,
    allowTrans,
    allowImage,
    allowComposed,
    allowPrim,
  ) {
    // Opaque fill only for the additive fast path: overlapping additive coverage
    // composes to the same color under OVER (exact at alpha=1). allowTrans callers
    // (the morph route) instead build the CDT partition mesh, whose non-overlapping
    // 1-pass-direct composite is exact at any α, so translucent fills are eligible.
    // A composed shape (clip/mask/filter/stroke) renders coverage to an RT then
    // a SINGLE composite — which handles any alpha (incl. a fill=none stroke-only
    // shape, alpha 0) — so the opacity gate doesn't apply to it.
    const composed = allowComposed && _morphShapeComposed(meta, b, st);
    if (!allowTrans && !composed && meta[b + 7] < 0.996) return false; // fill alpha (opaque)
    if (!allowGrad && Math.floor(meta[b + 28] + 0.5) !== 0) return false; // fillGradId
    // visible stroke: ineligible UNLESS composed (the composed path renders a
    // GPU-resident stroke-coverage RT the MANTLE_LB_COV variant samples as strokeCov).
    if (!allowComposed && meta[b + 11] > 0 && meta[b + 12] > 0) return false;
    // clip/mask: ineligible UNLESS the caller can run the composed path, which
    // feeds the LB fill coverage into the ubershader where the clip union / mask
    // walk still run inline over the LB fill.
    if (!allowComposed && Math.floor(meta[b + 30] + 0.5) !== 0) return false; // clipId
    if (!allowComposed && Math.floor(meta[b + 31] + 0.5) !== 0) return false; // maskId
    if (!allowImage && st >= 36 && Math.floor(meta[b + 35] + 0.5) !== 0) return false; // imageId
    if (st >= 44 && Math.floor(meta[b + 43] + 0.5) === 2) return false; // pattern carrier
    // Closed-form prim: exclude only the kinds Slug's primFast SDF handles
    // (rect=2, roundRect=3, or a SQUARE-bbox circle=1) — those beat LB. But a
    // NON-square circle (primKind 1 baked to an ellipse bbox) has no SDF and
    // would otherwise fall to the per-fragment ray-cast, so let LB serve it
    // (it still carries the arc curve geometry the ray-cast fallback uses).
    // allowPrim (the MORPH route): primFast SDF params don't lerp on the Slug
    // morph path — its per-frame CPU curve lerp + upload is the cost the
    // GPU-resident pair removes — so a morphing prim IS worth the analytic
    // route (a circle pairs as kind-7/crescents whose params lerp in the VS).
    if (st >= 45 && !allowPrim) {
      const pk = Math.floor(meta[b + 44] + 0.5); // meta texel 11.x
      if (pk === 2 || pk === 3) return false;
      if (pk === 1) {
        const w = meta[b + 2] - meta[b],
          h = meta[b + 3] - meta[b + 1]; // texel 0 = (x0,y0,x1,y1)
        if (Math.abs(w - h) <= 1e-3 * Math.max(w, 1e-6)) return false; // square → SDF
      }
    }
    return true;
  }
  // allowGrad: the caller's direct (1-pass) path can paint a gradient, so
  // gradient-fill shapes are eligible. The static combined route leaves it false
  // (it bakes one per-vertex solid color); the per-shape morph route passes true.
  function _loopBlinnEligible(
    bundle,
    allowGrad,
    allowTrans,
    allowImage,
    allowComposed,
    allowSlugFallback,
    allowPrim,
  ) {
    // Unified fill readiness owns program selection for this route.
    if (!bundle) return false;
    // Pure function of (geometry gen, flags) — cache per bundle. The
    // O(numShapes) meta sweep ran per draw per frame for static
    // LB-routed bundles.
    const gen9 = bundle._geomGen | 0;
    const fk9 =
      (allowGrad ? 1 : 0) |
      (allowTrans ? 2 : 0) |
      (allowImage ? 4 : 0) |
      (allowComposed ? 8 : 0) |
      (allowSlugFallback ? 16 : 0) |
      (allowPrim ? 32 : 0);
    const ec9 = bundle._lbEligCache;
    if (ec9 && ec9.gen === gen9 && ec9.fk === fk9) return ec9.ok;
    const ok9 = _loopBlinnEligibleUncached(
      bundle,
      allowGrad,
      allowTrans,
      allowImage,
      allowComposed,
      allowSlugFallback,
      allowPrim,
    );
    bundle._lbEligCache = { gen: gen9, fk: fk9, ok: ok9 };
    return ok9;
  }
  function _loopBlinnEligibleUncached(
    bundle,
    allowGrad,
    allowTrans,
    allowImage,
    allowComposed,
    allowSlugFallback,
    allowPrim,
  ) {
    if (bundle._nineSliceActive) return false;

    if (!allowComposed && bundle.filterGraphs && bundle.filterGraphs.some((g) => g)) return false;
    const dl = bundle.drawList;
    // A lightweight (analytic-only) streamed bundle is built WITHOUT Slug
    // cover-quads, so its drawList — derived from those quads — is empty.
    // That's expected here (it's solid-fill by construction, with pre-built
    // analytic meshes); the per-shape meta check below still gates it. Any
    // other empty/absent drawList is ineligible.
    if (!dl) return false;
    if (!dl.length && !bundle._lbStream) return false;
    for (const op of dl) {
      // The unified span walk owns group isolation/compositing. These brackets
      // carry no painted geometry, so admit them only with that machinery.
      if (op.kind === 'groupBegin' || op.kind === 'groupEnd') {
        if (!allowComposed || !R._groupBegin || !R._groupEnd) return false;
        continue;
      }
      if (op.kind !== 'fillShape') return false;
      // Blend modes (need a backdrop) + COLR paint graphs aren't served by the
      // analytic fill. With allowSlugFallback (the static path keeps Slug
      // geometry) those shapes fall back to Slug per-shape; otherwise the whole
      // bundle goes to Slug.
      if (!allowSlugFallback && (op.colrGraphId || op.blendMode)) return false;
      // filterId (inline color matrix OR single-kind blur/morph/convolve) and
      // filterGraphId (multi-primitive) both compose via the composed path.
      if (!allowComposed && (op.filterId || op.filterGraphId)) return false;
    }
    if (!bundle.curveFloats || !bundle.curveRangesByShape) return false;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0,
      n = bundle.numShapes | 0;
    if (!meta || n < 1) return false;
    for (let s = 0; s < n; s++) {
      // Group opacity occupies the alpha slot but is not a fill.
      if (Math.floor(meta[s * st + 27] + 0.5) & (FS_GROUP_BEGIN | FS_GROUP_END)) continue;
      if (
        !_lbShapeEligible(
          meta,
          s * st,
          st,
          allowGrad,
          allowTrans,
          allowImage,
          allowComposed,
          allowPrim,
        )
      )
        return false;
    }
    return true;
  }
  // Lazily decode + build + pack one LB mesh per shape; cached on the bundle,
  // keyed on bundle._geomGen (bumped by markGeometryDirty + morph setT). When a
  // prior build exists at an older gen, the per-shape mesh is REFRESHED
  // (buildLbShape's `prev` reuses the cached earcut topology, skipping the
  // O(n log n) triangulation) instead of fully rebuilt — the fixed-topology
  // streaming win for morphs / updateBundleGeometry.
  //
  // A shape Loop-Blinn can't serve (arc, loop/cusp, degenerate) becomes a
  // {slug:true} SENTINEL rather than failing the whole bundle: the per-shape
  // static path renders THOSE shapes through Slug (in painter order) while the
  // rest stay analytic (per-shape fallback). `bundle._lbHasSlug` records whether
  // any sentinel is present — the all-solid COMBINED route (one draw, can't mix
  // engines) bails to the per-shape path when it is. Returns null only when the
  // bundle has no usable geometry at all.
  function _lbFail(bundle, gen) {
    bundle._lbMeshes = null;
    bundle._lbMeshesRaw = null;
    bundle._lbSlugWhy = null;
    bundle._lbGen = gen;
    bundle._lbHasSlug = true;
    return null;
  }
  /// Record that the per-shape MEMORY budget turned a shape away, and how much it wanted.
  ///
  /// A budget that declines silently is the failure mode this repo keeps hitting -- the bundle
  /// simply draws Slug and nothing anywhere says a limit did it, which is how a memory figure
  /// that changed with a flush boundary went unexplained for a week. `bundle._lbMemWants` is the
  /// list, `debugStats.lbShapeMemDeclined` / `lbShapeMemWantedBytes` the readable form.
  function _lbNoteMemWant(bundle, shape, bytes) {
    if (!bundle) return;
    const list = bundle._lbMemWants || (bundle._lbMemWants = []);
    list.push({ shape: shape | 0, bytes: bytes | 0 });
    R._lbShapeMemDeclined = (R._lbShapeMemDeclined | 0) + 1;
    if ((bytes | 0) > (R._lbShapeMemWantedBytes | 0)) R._lbShapeMemWantedBytes = bytes | 0;
  }
  function _ensureLbMeshes(bundle, budgeted) {
    syncFillMeshOwner(R, bundle);
    const gen = bundle._geomGen | 0;
    if (bundle._lbMeshes !== undefined && bundle._lbGen === gen && !lbBuildStale(R, bundle))
      return bundle._lbMeshes;
    // Rows the per-shape policy can never give their mesh to, when the app has committed to that
    // policy (see setLoopBlinnFill). Under it a mesh for one of these is built, paid for, and
    // passed over on every draw for the life of the bundle: the shape draws its cover quad either
    // way, so a Slug sentinel is the same picture at none of the cost.
    const skip = lbBuildSkipFor(R, bundle);
    // A REBUILD CHANGES THE MESH SET WITHOUT CHANGING THE GEOMETRY, which is the same signal a
    // partial adoption raises and needs the same key: every cache stamped on the geometry
    // generation alone -- the kind mask (which decides WHICH lbCoverage blocks the variant
    // compiles) and the unified vertex stream -- would otherwise answer from the set it was built
    // for, and a mesh whose kind was compiled out paints nothing.
    if (bundle._lbBuildGated !== undefined && bundle._lbBuildGated !== !!skip) {
      bundle._lbAdoptKey = (bundle._lbAdoptKey | 0) + 1;
    }
    bundle._lbBuildGated = !!skip;
    // Second build path. The worker's buildLbBundle sets the Bezout preference from its
    // input; this main-thread ensure calls the builders DIRECTLY and would otherwise
    // ignore it — the flag then reads as a clean no-op on any bundle that lands here
    // instead of in the worker, which is exactly what it did.
    setPreferBezout(!!bundle._preferBezout);
    if (!R._lbMemAdmit(bundle, 1)) return _lbFail(bundle, gen);
    // GLOBAL per-frame build pool: a PER-BUNDLE budget stacks (an event that
    // dirties two dozen bundles at once turns into two dozen budgets in one
    // frame). All budgeted ensures draw from ONE pool per frame; when it
    // runs dry the remaining bundles render Slug this frame and resume next.
    if (budgeted) _bpTick();
    const tEns0 = budgeted ? Date.now() : 0;
    let partial = false;
    // Non-blocking draw policy: draw-time builds get a TIME BUDGET (8ms). Shapes
    // beyond it render SLUG this frame (reference-exact) and the ensure re-runs
    // next call — finished shapes come back free from the mesh cache, so the
    // build AMORTIZES across frames instead of freezing one (a heavy morph
    // set can take seconds to build). Small bundles finish inside the budget and are
    // LB on their very first draw; streams never hit this (their gen moves with
    // their meshes).
    const ranges = bundle.curveRangesByShape,
      cf = bundle.curveFloats,
      n = bundle.numShapes | 0;
    if (!ranges || !cf || n < 1) return _lbFail(bundle, gen);
    const meta = bundle.metaFloats,
      mst = bundle.metaFloatsPerShape | 0;

    const builderOnly = gen === 0 && !bundle._morphSrc;
    /// The curve table's BITS, for the mesh cache's exact key. A Float32Array always has a 4-aligned offset.
    const cfBits = new Uint32Array(cf.buffer, cf.byteOffset, cf.length);
    /// Every build input the curve bytes do not carry (see _lbMeshCache).
    const mcSettings =
      (bundle._preferBezout ? '_b' : '') +
      (sdfPrimitivesDisabled() ? '_np' : '') +
      (R._lbForceCdt ? '_fc' : '') +
      (globalThis.__LB_BAND_FOOTPRINT === 'tight' ? '_bt' : ''); // the packed band footprint (lbPack)
    const prevRaw = bundle._lbMeshesRaw;
    const prevPacked = bundle._lbMeshes;
    // Resumable sliced build. Shapes finalized (built or permanently-Slug) on a
    // prior attempt AT this generation are carried forward VERBATIM below, so the
    // slice is spent entirely on new shapes. Without this the loop re-walked from
    // shape 0 every attempt and paid the SELF-cache repack (transformLoopBlinnRaw
    // + packLoopBlinnMesh) for the already-built prefix — which grows until it
    // eats the whole slice and no new shape ever builds, so a heavy multi-shape
    // bundle (dozens of detailed pose-frame SVGs) plateaus and never latches,
    // spinning the idle drain forever. `_lbBuildS` is the resume index; guarded by
    // `_lbRawGen` so a re-dirtied (new-generation) prefix is rebuilt, not reused.
    const resumeS = bundle._lbRawGen === gen ? bundle._lbBuildS | 0 : 0;
    let partialAtS = n;
    // This path's sentinels carry their own cause, so the parallel array a worker result leaves
    // behind would only be a second, staler answer to the same question.
    bundle._lbSlugWhy = null;
    // ...and the budget refusals belong to this pass. Kept, they would report a shape that fits
    // under the budget the caller has since raised.
    if (resumeS === 0) bundle._lbMemWants = null;
    const raw = [],
      packed = [];
    let hasSlug = false,
      hasReal = false;
    /// Push a Slug sentinel that says WHY. A shape nobody attempted is not a shape the builder
    /// gave up on, and a single anonymous sentinel makes every count of them report the second.
    const pushSlug = (w) => {
      const g = slugFor(w);
      raw.push(g);
      packed.push(g);
      hasSlug = true;
    };
    /// The caller's per-shape MEMORY budget, asked on every path that yields a pack -- including
    /// the two mesh caches and the similarity orbit.
    ///
    /// A cached pack was built under whatever budget was in force when it was built, so asking
    /// only where a mesh is BUILT lets a cached monster straight through the moment the caller
    /// lowers the limit: a budget that holds until it matters. By here the stream exists, so
    /// `verts.byteLength` is the exact figure on every path; a pack the packer already refused
    /// carries the figure it wanted instead.
    const memAdmit = (s, pk) => {
      const cap = getLbShapeMemoryBudget();
      const over = !!(pk && pk.overMemory);
      if (cap >= Infinity && !over) return true;
      const bytes = over ? pk.wantBytes | 0 : pk && pk.verts ? pk.verts.byteLength : 0;
      if (!over && bytes <= cap) return true;
      _lbNoteMemWant(bundle, s, bytes);
      pushSlug(SLUG_WHY.OVER_MEMORY);
      return false;
    };

    for (let s = 0; s < n; s++) {
      if (s < resumeS && prevRaw && prevRaw[s] !== undefined) {
        const pr = prevRaw[s];
        raw.push(pr);
        packed.push(prevPacked ? prevPacked[s] : pr);
        if (pr && pr.slug) hasSlug = true;
        else hasReal = true;
        continue;
      }
      let _mcKey = null,
        _simKey = null,
        _simFrame = null;
      const _mcPut = (v) => {
        if (_mcKey === null) return;
        _lbMcSet(_mcKey, cfBits, ranges[s].begin, ranges[s].end, v);
        // Slug verdicts and built meshes are similarity-invariant facts --
        // publish to the orbit cache too (frame captured at lookup time).
        if (_simKey) _lbSimPut(_simKey, v === null ? null : { raw: v.raw, frame: _simFrame });
        if (_simKey)
          (bundle._lbShapeSim || (bundle._lbShapeSim = []))[s] =
            v === null
              ? { key: _simKey, slug: true }
              : { key: _simKey, frame0: _simFrame, raw0: v.raw };
      };
      if (budgeted && !partial && Date.now() - tEns0 > 8) {
        partial = true;
        partialAtS = s;
      } // own slice; the POOL gates entry (storm cap ~2 bundles/frame)
      if (partial) {
        // over budget: Slug this FRAME only — not cached, gen left unset below so
        // the next ensure resumes (built shapes return from the mesh cache). NOT a decline:
        // nothing has been attempted for this shape yet.
        pushSlug(SLUG_WHY.NOT_BUILT);
        continue;
      }
      const r = ranges[s];
      if (skip && skip[s]) {
        // ...but not the recognizers: the policy takes a PRIMITIVE whatever it says about curve
        // types, so a skipped row that is one still builds, through the ordinary path below.
        let c0 = null;
        try {
          c0 = r ? R.curveRangeToContours(cf, r.begin, r.end) : null;
        } catch {
          c0 = null;
        }
        if (!contoursArePrimitive(c0, !!(meta && meta[s * mst + 13] > 0.5))) {
          pushSlug(SLUG_WHY.NOT_BUILT);
          continue;
        }
      }
      // No complexity gate by curve-float count: as a proxy for build TIME it is poor in both
      // directions (a shape several times larger can build as fast, and two shapes of the same
      // size can pack to very different byte counts), and the progressive build answers time
      // directly (the worker ships each shape as it finishes and the bundle adopts it). The bound
      // is a caller-set MEMORY budget, asked in the builder and the packer where the bytes are
      // actually spent (lbPack).

      const contours = r ? R.curveRangeToContours(cf, r.begin, r.end) : null;
      let mesh = null,
        _pk9 = null;
      // A translucent solid fill (no gradient/image) must be a non-overlapping
      // PARTITION so the combined route's direct OVER composites it exactly at
      // α<1 (the additive earcut crescents self-conflate) — build it as CDT, the
      // same partition the translucent MORPH path uses. Opaque fills keep the
      // cheaper earcut (crescents union correctly at α=1). Lets translucent
      // solids BATCH into the one-draw combined route instead of N composite RTs.
      const bb = meta && mst ? s * mst : -1;
      const transSolid =
        bb >= 0 &&
        meta[bb + 7] < 0.996 &&
        Math.floor(meta[bb + 28] + 0.5) === 0 &&
        (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0);
      if (contours) {
        // Curved / multi-contour / translucent → CDT; single-contour opaque
        // straight polygons keep earcut (streaming). Exact FNV cache, then
        // similarity orbit (canonical frame + near-tie axes).
        if (r && contours) {
          _simFrame = R.lbCanonicalFrame(contours);
          const _rb9 =
            (transSolid ? '_t' : '') + (meta && meta[s * mst + 13] > 0.5 ? '_e' : '') + mcSettings;
          if (_simFrame) {
            // One contour walk for primary + near-tie candidate axes.
            const frames = _simFrame.cands ? [_simFrame, ..._simFrame.cands] : [_simFrame];
            const keys = R.lbCanonicalHashes(contours, frames);
            _simKey = keys[0] + _rb9;
            const selfS = !builderOnly && bundle._lbShapeSim && bundle._lbShapeSim[s];
            if (selfS && !selfS.slug && selfS.key !== _simKey && frames.length > 1) {
              for (let ci = 1; ci < frames.length; ci++) {
                const k9 = keys[ci] + _rb9;
                if (k9 === selfS.key) {
                  _simKey = k9;
                  _simFrame = frames[ci];
                  break;
                }
              }
            }
            if (_simKey && selfS && selfS.key === _simKey) {
              if (selfS.slug) {
                pushSlug(SLUG_WHY.DECLINED);
                continue;
              }
              const eF = selfS.frame0,
                qF = _simFrame;
              const sc9 = qF.scale / eF.scale;
              const co9 = qF.cos * eF.cos + qF.sin * eF.sin;
              const si9 = qF.sin * eF.cos - qF.cos * eF.sin;
              const tRaw = R.transformLoopBlinnRaw(selfS.raw0, {
                s: sc9,
                cos: co9,
                sin: si9,
                dx: qF.cx - sc9 * (co9 * eF.cx - si9 * eF.cy),
                dy: qF.cy - sc9 * (si9 * eF.cx + co9 * eF.cy),
              });
              const tPk0 = R.packLoopBlinnMesh(tRaw);
              if (!memAdmit(s, tPk0)) continue;
              raw.push(tRaw);
              packed.push(tPk0);
              hasReal = true;
              continue;
            }
          } else {
            _simKey = null;
          }
        }
        if (r) {
          _mcKey = _lbMcKey(
            cfBits,
            r.begin,
            r.end,
            (transSolid ? '_t' : '') + (meta && meta[s * mst + 13] > 0.5 ? '_e' : '') + mcSettings,
          );
          const hit = _lbMcGet(_mcKey, cfBits, r.begin, r.end, builderOnly);
          if (hit !== undefined) {
            if (hit === null) {
              pushSlug(SLUG_WHY.DECLINED);
              continue;
            }
            if (!memAdmit(s, hit.pk)) continue;
            raw.push(hit.raw);
            packed.push(hit.pk);
            hasReal = true;
            continue;
          }
          // SIMILARITY tier: exact key missed (moved/rotated/scaled instance).
          // Canonicalize and look for the same shape anywhere in its orbit; a
          // hit transforms the cached assembly to this instance's frame and
          // repacks -- ~0.1ms vs a full build. The transformed result is ALSO
          // put under the exact key, so the next frame is an exact hit.
          if (contours && !builderOnly) {
            const sHit = _simKey ? _lbSimCache.get(_simKey) : undefined;
            if (sHit !== undefined) {
              _lbSimCache.delete(_simKey);
              _lbSimCache.set(_simKey, sHit);
              if (sHit === null) {
                _lbMcSet(_mcKey, cfBits, r.begin, r.end, null, true);
                pushSlug(SLUG_WHY.DECLINED);
                continue;
              }
              const eF = sHit.frame,
                qF = _simFrame;
              const sc9 = qF.scale / eF.scale;
              // R = rot(query) * rot(entry)^-1
              const co9 = qF.cos * eF.cos + qF.sin * eF.sin;
              const si9 = qF.sin * eF.cos - qF.cos * eF.sin;
              const M9 = {
                s: sc9,
                cos: co9,
                sin: si9,
                dx: qF.cx - sc9 * (co9 * eF.cx - si9 * eF.cy),
                dy: qF.cy - sc9 * (si9 * eF.cx + co9 * eF.cy),
              };
              const tRaw = R.transformLoopBlinnRaw(sHit.raw, M9);
              const tPk = R.packLoopBlinnMesh(tRaw);
              (bundle._lbShapeSim || (bundle._lbShapeSim = []))[s] = {
                key: _simKey,
                frame0: sHit.frame,
                raw0: sHit.raw,
              };
              _lbMcSet(_mcKey, cfBits, r.begin, r.end, { raw: tRaw, pk: tPk }, true);
              if (!memAdmit(s, tPk)) continue;
              raw.push(tRaw);
              packed.push(tPk);
              hasReal = true;
              continue;
            }
          }
          // POOL (draw-time only): a cache MISS costs a real build — when this frame's
          // global pool is dry (pose-switch storms dirty ~24 bundles at once), this
          // shape renders Slug this frame and the build resumes next frame / in idle.
          // Cache HITS above are never blocked (they cost ~nothing).
          if (budgeted === true && !partial && _bpSpent + (Date.now() - tEns0) > 9) {
            partial = true;
            partialAtS = s;
          }
          if (partial) {
            pushSlug(SLUG_WHY.NOT_BUILT);
            continue;
          }
        }
        // ONE ROUTE DECISION, and it is `buildLbShape`'s.
        //
        // The two knobs this path has and the worker does not are passed in rather than
        // reimplemented: `forceCdt` (setLoopBlinnMeshOpts) and `prev`, the previous raw mesh
        // whose triangulation the fixed-topology refresh reuses.
        let built9 = null;
        try {
          built9 = buildLbShape(contours, transSolid, meta && meta[s * mst + 13] > 0.5, {
            forceCdt: !!R._lbForceCdt,
            prev:
              !builderOnly && prevRaw && prevRaw[s] && !prevRaw[s].slug && !prevRaw[s].mode
                ? prevRaw[s]
                : null,
          });
        } catch {
          built9 = null;
        }
        mesh = built9 ? built9.raw : null;
        _pk9 = built9 ? built9.pk : null;
      }
      // The builder had no answer: a loop/cusp cubic, a degenerate outline, a partition that
      // could not cover its shape. ...and a shape with no curve range never had geometry to
      // decline in the first place.
      if (!mesh) {
        if (typeof _mcPut === 'function') _mcPut(null);
        pushSlug(r ? SLUG_WHY.DECLINED : SLUG_WHY.NO_GEOMETRY);
        continue;
      }
      {
        // THE PER-MESH CAP, ON every ROUTE that reaches here, so a huge partition is capped no
        // matter which build path produced it.
        const pk = _pk9 || R.packLoopBlinnMesh(mesh);
        // ...and the caller's per-shape MEMORY budget, on the pack this path is about to keep.
        // `buildLbShape` already asked it against the raw mesh, so this catches the answer it
        // gave; the cache paths above have no builder behind them and this is their only ask.
        if (!memAdmit(s, pk)) continue;
        if (
          !pk ||
          pk.overBudget ||
          !(pk.vertexCount > 0) ||
          pk.vertexCount > LB_MAX_VERTS_PER_MESH
        ) {
          if (typeof _mcPut === 'function') _mcPut(null);
          // The partition produced a mesh and a CAP refused it. Calling that a decline blames the
          // builder for a budget.
          pushSlug(SLUG_WHY.OVER_BUDGET);
          continue;
        }
        // A refreshed mesh reuses a previous triangulation, so it must not be published under a
        // CONTENT key — the next shape with the same bytes would inherit another shape's topology.
        // Every other route may cache (a test on `!prevRaw` would also decline to cache a freshly
        // built curved mesh on any rebuild).
        if (typeof _mcPut === 'function' && !mesh._lbRefreshed) _mcPut({ raw: mesh, pk });
        raw.push(mesh);
        packed.push(pk);
        hasReal = true;
      }
    }
    if (!hasReal && hasSlug && !partial) return _lbFail(bundle, gen); // nothing analytic to do → whole-bundle Slug
    // Whole-bundle vert cap (many mid-size shapes).
    if (!partial && hasReal) {
      let nV = 0;
      for (const pk of packed) if (pk && pk.vertexCount) nV += pk.vertexCount;
      if (nV > LB_MAX_VERTS_PER_BUNDLE) {
        if (typeof console !== 'undefined') {
          console.warn(
            '[mantle] LB mesh budget: bundle has ' +
              nV +
              ' verts (cap ' +
              LB_MAX_VERTS_PER_BUNDLE +
              ') — rendering via Slug.',
          );
        }
        return _lbFail(bundle, gen);
      }
    }
    if (budgeted) _bpSpent += Date.now() - tEns0;
    if (partial) {
      bundle._lbMeshesRaw = raw;
      bundle._lbGen = null; // NOT gen: re-ensure resumes next draw
      bundle._lbHasSlug = true;
      bundle._lbBuildS = partialAtS; // resume point: shapes < this are finalized
      bundle._lbRawGen = gen; // guards the resumed prefix against a stale generation
      try {
        enqueueLbPrepare(R.gl, bundle);
      } catch {} // idle finishes it even without draws
      if (!_lbMemAccount(bundle, packed)) return null;
      return claimFillMeshes(bundle, MESH_OWNER.LB, packed) ? packed : null;
    }
    bundle._lbMeshesRaw = raw;
    bundle._lbGen = gen;
    bundle._lbHasSlug = hasSlug;
    bundle._lbBuildS = 0; // fully built → no resume prefix
    bundle._lbRawGen = gen;
    // A complete build is not a partial adoption. The worker may still be streaming batches for
    // this same generation; leaving the partial mark set would let the next one replace this whole
    // mesh set with the few shapes it carries, un-routing all the rest.
    bundle._lbPartialGen = null;
    bundle._lbFullGen = gen; // ...and this build IS full quality (see _applyLbResult)
    if (!_lbMemAccount(bundle, packed)) return null;
    if (!claimFillMeshes(bundle, MESH_OWNER.LB, packed)) return null;
    // A complete builder-only set is what the off-thread build of this generation will return, so
    // that build is not published over it (_applyLbResult): the frame keeps this set, with the
    // CPU-side fields the wire form drops, and pays no second adoption for identical bytes.
    if (builderOnly) bundle._lbPreparedGen = gen;
    return packed;
  }
  // One contiguous 28-float VBO (24 geometry + per-vertex RGBA) for the whole
  // bundle in painter order → a single drawArrays. Cached; rebuilt only when
  // geometry changes. Per-shape fill color is baked per vertex (the draw-time
  // global alpha stays a uniform so it doesn't force a rebuild).
  // The imported stride is available before renderer members are published.
  const _RVF = LB_VERT_FLOATS + 5; // route vertex floats (29: 24 geom + 4 color + shapeRow)
  // Draw-path readiness gate — never builds. Returns the worker-delivered packed
  // meshes when they're current (or `null` = whole-bundle Slug, also "ready"), or
  // `undefined` while the build is pending so the caller falls back to Slug
  // (LB > Slug > nothing). All LB construction happens off-thread at load; a draw
  // must not stall to triangulate. Mirrors _ensureLbMeshes's cache-hit gate.
  function _lbReadyMeshes(bundle) {
    const gen = bundle._geomGen | 0;
    return bundle._lbMeshes !== undefined && bundle._lbGen === gen ? bundle._lbMeshes : undefined;
  }
  // Compute (and cache) the bundle's painter-order shape iteration. Extracted so the
  // combined route and the split route derive the same order.
  function _ensureLbOrder(bundle, meshes) {
    const gen = bundle._geomGen | 0;
    let order = bundle._lbOrder;
    const cullG = bundle._cullGen | 0;
    const drawList = bundle.drawList;
    if (drawList && drawList.length) {
      if (
        !order ||
        bundle._lbOrderGen !== gen ||
        bundle._lbOrderCull !== cullG ||
        bundle._lbOrderDrawList !== drawList ||
        order.length !== drawList.length
      ) {
        order = bundle._lbOrder = drawList.map((op) => op.shapeIdx | 0);
        bundle._lbOrderGen = gen;
        bundle._lbOrderCull = cullG;
        bundle._lbOrderDrawList = drawList;
      }
    } else if (
      !order ||
      bundle._lbOrderGen !== gen ||
      bundle._lbOrderCull !== cullG ||
      bundle._lbOrderDrawList !== drawList ||
      order.length !== meshes.length
    ) {
      order = bundle._lbOrder = meshes.map((_, i) => i);
      bundle._lbOrderGen = gen;
      bundle._lbOrderCull = cullG;
      bundle._lbOrderDrawList = drawList;
    }
    return order;
  }

  // Analytic-fill entry. ONE route serves every feature — paint, stroke, clip, mask, filter —
  // and it is the unified draw: the whole bundle, cover quads and analytic geometry alike, in one
  // painter-sorted buffer and one drawArrays through the ubershader. A bundle it cannot serve
  // takes the ordinary fill pass, which picks its engine properly (preferNoAa / preferNoAaMixed /
  // preferAac) rather than dropping into a per-shape path.
  //
  // Draw painter-ordered cover quads and analytic meshes through the unified program.
  function _drawBundleLB(bundle) {
    // A nine-sliced bundle draws its re-gridded cover quads: the analytic meshes are built from the NATIVE curves and know
    // nothing of the cut table, so they are never drawn for it, whenever they were built (before applyNineSlice, or by a
    // prepareBundle on the instance).
    if (bundle._nineSliceActive) return false;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0,
      n = bundle.numShapes | 0;
    if (!meta || n < 1) return false;
    // Streamed geometry requires meshes before checking unified-route readiness.
    // Mesh construction is cached by geometry generation.
    if (bundle._lbStream) {
      try {
        _ensureLbMeshes(bundle);
      } catch {
        /* draw-time fallback */
      }
    }
    // Captured rather than re-read off R._unifiedFillGate below: that field is
    // global and would still hold the PREVIOUS bundle's reason if the readiness
    // check never ran for this one.
    let uniReady = !!(R._unifiedFillReady && R._unifiedFillReady(bundle));
    // A streamed bundle cannot WAIT for the variant. It has no Slug geometry, so
    // every frame spent on the warm-up fallback is a BLANK frame — there is no
    // second-best engine to fall to. Force the link now and re-ask: it is a
    // one-time cost when the streamed content first appears, against dropped
    // frames of nothing. Same machinery awaitLbReady drives.
    // A cpatch bundle cannot wait either, for a different reason than a streamed one:
    // its meshes are the only geometry built for it, so every frame spent on the
    // warm-up fallback is a frame drawn by an engine that ignores them — which reads
    // as "CPatch matches Slug exactly", the silent-fallback signature. Force the link
    // and re-ask, exactly as the streamed case does.
    if (
      !uniReady &&
      (R.opts.cpatchFill === true || cpatchStaticAutoServes(bundle)) &&
      bundle._cpatchBuilt &&
      R._unifiedFillGate === 'variant-warming'
    ) {
      try {
        if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
        if (R._precompileNow) R._precompileNow({ draw: false }); // inside a draw: no warm pixel, and no wait
        uniReady = !!(R._unifiedFillReady && R._unifiedFillReady(bundle));
      } catch {
        /* fall through */
      }
    }
    if (!uniReady && bundle._lbStream && R._unifiedFillGate === 'variant-warming') {
      try {
        if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
        if (R._readyBundleVariant)
          R._readyBundleVariant(bundle); // this bundle's own program only; precompileFills would promote every pending one
        else if (R._precompileNow) R._precompileNow({ draw: false }); // inside a draw: no warm pixel, and no wait
        uniReady = !!(R._unifiedFillReady && R._unifiedFillReady(bundle));
      } catch {
        /* fall through to the classic routes below */
      }
    }
    if (uniReady && R._drawBundleUnifiedFill && R._drawBundleUnifiedFill(bundle)) {
      R._lbRouteCount++;
      return true;
    }
    // WARM-UP FALLS TO THE BEST NON-LB ENGINE, not to the classic LB routes.
    //
    // A variant that has not linked (or whose Metal pipeline is not warm) cannot
    // host LB coverage, so for the handful of frames until it does, SOME fallback
    // is physics. The question is which. Dropping into the per-shape coverage-RT
    // routes below means paying LB's mesh + an RT composite per shape on exactly
    // the frames the machine is already busy compiling — and those routes are the
    // ones this refactor exists to retire.
    //
    // Returning false hands the bundle to the ordinary fill pass, which runs
    // selectFillVariant → preferNoAa / preferNoAaMixed / preferAac. That is the
    // same selection, minus LB: the second-best engine per bundle, decided by the
    // same gates rather than by a fixed ranking.
    //
    // It has to be a re-run rather than a hardcoded runner-up because the no-AA
    // engine is only admissible where a STROKE covers the fill edge and hides the
    // missing AA — preferNoAa's own proof, and the per-row MANTLE_HARD_MIXED
    // mechanism. _balanceBench's "hard wins real assets over slug for initial
    // paints" holds on STROKED content and says nothing about the unstroked case,
    // so a fixed second choice would be wrong in both directions.

    if (!uniReady && R._unifiedFillGate === 'variant-warming' && !R.opts.disableFillVariants) {
      R._uniWarmFallbacks = (R._uniWarmFallbacks | 0) + 1;
      // Name the engine that lost the draw. Without this the frame is attributed entirely to
      // whichever engine the ordinary fill pass then picks, and a bundle that never warms looks
      // exactly like one that was never asked for.
      if (R._engines) R._engines.declined(engineOfBundle(bundle), DECLINE.NOT_WARM);
      return false;
    }
    // Unserved analytic bundles use the ordinary fill pass and its selected engine.
    return false;
  }

  R._ensureFillLBCovProg = _ensureFillLBCovProg;

  R._morphShapeFilter = _morphShapeFilter;
  R._ensureBundleMorphMeshes = _ensureBundleMorphMeshes;
  R._drawBundleMorphRoute = _drawBundleMorphRoute;
  R._lbOvrColorOnly = (ovr) => {
    const p9 = ovr && ovr.packedBuffer;
    if (!p9) return false;
    const n9 =
      ovr.numShapes >= 0 ? Math.min(ovr.numShapes, (p9.length / 24) | 0) : (p9.length / 24) | 0; // drawn rows
    for (let s9 = 0; s9 < n9; s9++) if (_ovHasXform(p9, s9)) return false;
    return true;
  };
  R._morphShapeComposed = _morphShapeComposed;
  R._lbShapeEligible = _lbShapeEligible;
  R._loopBlinnEligible = _loopBlinnEligible;
  R._lbFail = _lbFail;
  R._ensureLbMeshes = _ensureLbMeshes;
  R._drawBundleLB = _drawBundleLB;

  R.warmCPatchPool = () => {
    R._cpatchPoolWarmed = true;
    return requireRendererFeature('cpatch', 'warmCPatchPool()').warmCpatchPool();
  };
  R.prepareBundle = (bundle) => {
    if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
    if (R._lbSlugOnly) return false;
    // Nine-sliced: the cover quads are the only geometry drawn (see _drawBundleLB), so there is nothing to prepare, and a
    // native-curve mesh built here would be dead weight. False is the honest answer.
    if (bundle && bundle._nineSliceActive) return false;
    // forceSlug declines here for the same reason the builders do: preparing is the third build
    // path, and a switch honored on two of three is a switch that changes nothing except when the
    // app happens not to call this. False is the honest answer — no analytic geometry was prepared.
    if (!_buildAllowed(R)) return false;
    // ROUTE CLASS (fillRouteClass.js): a static bundle under 'auto' draws on the cover pass; nothing analytic is prepared for it (the variant warm above is the cover family).
    if (R._fillRouteReason && R._fillRouteReason(bundle) === 'static-cover') return false;
    // Prepare CPatch before LB; both use the unified mesh stream.
    // Morphs reuse a conversion plan and pose its coefficients at the current t.
    // Pose even when geometry generation is unchanged: LB preparation and variant
    // warming can replace the shared curve texture between draws.
    if (R._cpatchMorphWanted(bundle) && R._cpatchMorphFrame) {
      try {
        if (R._cpatchMorphFrame(bundle)) {
          if (R.prewarmFillVariant) R.prewarmFillVariant(bundle);
          return true;
        }
      } catch (ex) {
        R._cpatchMorphError = {
          msg: String((ex && ex.message) || ex),
          stack: (ex && ex.stack) || null,
        };
      }
    }
    syncFillMeshOwner(R, bundle);
    // _cpatchRetry: a POOLED conversion just landed. The LB fallback that ran while it was in
    // flight already stamped _lbGen, so the generation gate alone would never ask CPatch again.
    const cpAuto = cpatchStaticAutoServes(bundle);
    if (
      (cpatchServes(bundle) || cpAuto) &&
      bundle &&
      (bundle._lbGen !== (bundle._geomGen | 0) ||
        bundle._cpatchRetry === true ||
        (cpAuto &&
          !((bundle._cpatchBuilt | 0) > 0) &&
          bundle._cpatchAutoTriedGen !== (bundle._geomGen | 0)))
    ) {
      try {
        if (!bundle._morphSrc && R._buildCPatchBundle) {
          if (cpAuto && bundle._fillMeshOwner === MESH_OWNER.LB)
            releaseFillMeshes(bundle, MESH_OWNER.LB);
          const cpOpts = cpAuto ? { autoPolicy: true, skip: lbBuildSkipMask(bundle, true) } : null;
          if (R._buildCPatchBundle(bundle, cpOpts)) {
            if (R.prewarmFillVariant) R.prewarmFillVariant(bundle); // kind 14 needs its own variant
            return true;
          }
        }
      } catch {
        /* decline → Slug, below */
      }
    }
    // Pending CPatch conversion uses the existing cover kernel, avoiding a
    // competing LB worker build whose meshes would be replaced on completion.
    if ((cpatchServes(bundle) || cpAuto) && bundle && bundle._cpatchConv === 'pending')
      return false;
    // A pinned CPatch decline uses the cover kernel; it does not prepare LB.
    if (cpatchServes(bundle)) return false;
    // SYNCHRONOUS AND UNCONDITIONAL, and both halves are load-bearing contracts.
    //
    // UNCONDITIONAL: the off-thread builder carries an 'auto' gate (lbBundleMayPick) that declines
    // any bundle the PER-SHAPE policy would not give a mesh to — a line-only outline, or one whose
    // every row is a stroke, clip, mask or filter row. Routing prepareBundle through that gate left
    // such bundles with no mesh at all, so they could never route and drew their cover quads for
    // good, at pixels identical to Slug. Fifteen parity smokes read exactly that as lbRouted 0.
    //
    // SYNCHRONOUS: what this builds is the MAIN-THREAD pack, which keeps the CPU-side fields
    // (a partition's `cubics`, for one) that the worker's wire form deliberately drops. A caller
    // that prepares and then INSPECTS the meshes only finds those if they are built by the time it
    // looks — deferring to the worker left it reading the stripped form.
    //
    // `lbPrepareAsync: true` opts out, for an app that would rather not pay a build in front of a
    // frame and only needs the drawn result. The meshes then arrive from the worker (already
    // running for this bundle, and adopted per shape as they land), and awaitLbReady waits for them.
    try {
      if (R.opts.lbPrepareAsync === true) {
        if (R._lbBuilderFn) R._lbBuilderFn(bundle, true);
        return bundle._lbMeshes != null && bundle._lbGen === (bundle._geomGen | 0);
      }
      return _ensureLbMeshes(bundle) !== null;
    } catch {
      return false;
    }
  };
  // Apply an off-thread build result: store the packed meshes so the next draw
  // upgrades this bundle from Slug to LB. `wire[s] === null` ⇒ that shape is Slug.
  // Discards a result whose generation no longer matches (bundle re-dirtied while
  // the worker ran) — a stale prefix must never render.
  // Memory-projected slug gate: packed LB meshes measure ~120 bytes per curve
  // byte under kind-12 bands (conservative). When the
  // projected total across live bundles would exceed the budget, the bundle
  // routes Slug instead — reference-exact from the curve buffer it already owns.
  // Hard vert caps (LB_MAX_VERTS_*) are a second line of defense after build.
  // Budget via R.setLoopBlinnMemoryBudget(bytes); default scales with deviceMemory.
  const LB_BYTES_PER_CURVE_BYTE = 120;
  R._lbMemUsed = 0;
  R._lbMemCap = (() => {
    try {
      // navigator.deviceMemory is the non-standard Device Memory API (absent from
      // TS's lib.dom); cast through any.
      const gb =
        (typeof navigator !== 'undefined' && /** @type {any} */ (navigator).deviceMemory) || 8;
      return gb <= 4 ? 96 * 1024 * 1024 : 192 * 1024 * 1024;
    } catch {
      return 192 * 1024 * 1024;
    }
  })();
  // A number of bytes >= 0 (Infinity = no limit). Not `bytes | 0`, which would send NaN, Infinity and anything past 2^31 - 1 to 0 or a
  // negative cap: every bundle would then route Slug with a "budget" warning.
  R.setLoopBlinnMemoryBudget = (bytes) => {
    if (typeof bytes !== 'number' || !(bytes >= 0))
      throw new Error(
        'setLoopBlinnMemoryBudget: bytes must be a number >= 0 (Infinity is no limit), got ' +
          (typeof bytes === 'number' ? String(bytes) : typeof bytes),
      );
    R._lbMemCap = Math.floor(bytes);
  };
  /// PER-SHAPE memory budget, in bytes of packed vertex stream. The budget above is a whole-BUNDLE
  /// projection asked at adoption time; this one is asked in the builder and the packer, where the
  /// bytes are actually spent, so a shape that cannot fit is never allocated. Build TIME is not
  /// limited by a complexity proxy: the progressive build bounds it directly by posting each shape
  /// as it becomes ready.
  ///
  /// DEFAULT: NO LIMIT. The built-in caps already bound a shape's stream (LB_MAX_VERTS_PER_MESH is
  /// 200,000 vertices, which is 19.2 MB at this stride), so no further default is needed; a caller
  /// with a tighter ceiling sets one. Refusals are
  /// reported, not silent: `debugStats.lbShapeMemDeclined` and `lbShapeMemWantedBytes`, and
  /// `bundle._lbMemWants` names the shapes.
  R.setLoopBlinnShapeMemoryBudget = (bytes) => {
    setLbShapeMemoryBudget(bytes);
    R._lbShapeMemCap = getLbShapeMemoryBudget();
  };
  /** Mesh-build policy for Loop-Blinn. Extensible opts object.
   *  `forceCdt`: skip the convex fast-mesh path; always CDT (or Slug if CDT fails). */
  R.setLoopBlinnMeshOpts = (opts = {}) => {
    if (opts && opts.forceCdt !== undefined) R._lbForceCdt = !!opts.forceCdt;
  };
  function _lbMemAdmit(bundle, scale) {
    if (bundle._lbMemBytes) return true; // already accounted (rebuild)
    const projected =
      ((bundle.curveFloats && bundle.curveFloats.byteLength) || 0) *
      LB_BYTES_PER_CURVE_BYTE *
      (scale || 1);
    if (R._lbMemUsed + projected > R._lbMemCap) {
      if (!bundle._lbMemDenied && typeof console !== 'undefined') {
        console.warn(
          '[mantle] LB mesh budget: bundle projected ' +
            (projected / 1048576).toFixed(0) +
            'MB over the ' +
            (R._lbMemCap / 1048576).toFixed(0) +
            'MB budget (' +
            (R._lbMemUsed / 1048576).toFixed(0) +
            'MB in use) — rendering via Slug.',
        );
      }
      bundle._lbMemDenied = true;
      return false;
    }
    // The scene memory budget (getMemoryStats): an optional mesh set that would pass it is refused and the bundle keeps the cover route.
    if (R._memAdmit && !R._memAdmit(projected, 'loopBlinn mesh')) {
      bundle._lbMemDenied = true;
      return false;
    }
    return true;
  }
  function _lbMemAccount(bundle, packed, morph = false) {
    let bytes = 0,
      nV = 0;
    if (packed)
      for (const pk of packed) {
        if (!pk || pk.slug) continue;
        if (pk.segments) {
          for (const sg of pk.segments)
            if (sg) {
              bytes += sg.vbo ? sg.vbo.byteLength : 0;
              nV += sg.vertexCount | 0;
            }
        } else {
          const vertices = pk.verts || pk.vbo;
          if (vertices) bytes += vertices.byteLength;
          nV += pk.vertexCount | 0;
        }
      }
    // Post-build revoke: projection can under-estimate; if the real mesh blows
    // the budget, drop to Slug rather than uploading an oversized VBO.
    // A worker can finish after the application sets a scene budget. Check at
    // publication too, before its partial or final mesh can replace the fallback.
    // _lbMemBytes counts CPU-staged vertices, not resident GPU allocation.
    // Admit the complete prospective set; prior partials may never have drawn.
    const sceneDenied = R._memAdmit && !R._memAdmit(bytes, 'loopBlinn mesh');
    if (sceneDenied || bytes > R._lbMemCap || nV > LB_MAX_VERTS_PER_BUNDLE) {
      if (!sceneDenied && typeof console !== 'undefined') {
        console.warn(
          '[mantle] LB mesh budget: built ' +
            (bytes / 1048576).toFixed(1) +
            'MB / ' +
            nV +
            ' verts exceeds cap — rendering via Slug.',
        );
      }
      R._lbMemUsed -= bundle._lbMemBytes || 0;
      bundle._lbMemBytes = 0;
      if (morph) bundle._morphMeshes = null;
      else {
        releaseFillMeshes(bundle, MESH_OWNER.LB);
        bundle._lbMeshesRaw = null;
        bundle._lbHasSlug = true;
      }
      bundle._lbMemDenied = true;
      return false;
    }
    R._lbMemUsed += bytes - (bundle._lbMemBytes || 0);
    bundle._lbMemBytes = bytes;
    if (!bundle._lbMemReleased9) {
      bundle._lbMemReleased9 = true;
      const prevDispose = bundle.dispose;
      bundle.dispose = function () {
        R._lbMemUsed -= bundle._lbMemBytes || 0;
        bundle._lbMemBytes = 0;
        return prevDispose.apply(this, arguments);
      };
    }
    return true;
  }
  R._lbMemAdmit = _lbMemAdmit;
  /// Adopt a batch of finished shapes while the rest of the bundle is still building.
  ///
  /// The unified stream already mixes engines shape by shape — one with no usable mesh draws its
  /// cover quad through the Slug kernel, in the same buffer and the same draw — so a HALF-BUILT
  /// bundle is a correct picture, not a half-drawn one. It is simply a picture in which some shapes
  /// have not reached their best engine yet. What it needs from this side is a reason to rebuild the
  /// vertex stream, and the geometry generation cannot be that reason: the geometry has not changed.
  /// `_lbAdoptKey` is, and it rides the stream cache key beside the pick key.
  ///
  /// A FRESH ARRAY PER BATCH, never a mutation of the live one. lbShapePicks caches on the mesh
  /// array's IDENTITY, so mutating in place would leave the pick cache convinced it had already
  /// answered for this set, and every shape adopted after the first batch would keep its cover quad
  /// for good under 'auto' — the meshes built, paid for, and never drawn.
  function _applyLbPartial(bundle, msg, reqGen) {
    if (bundle._disposed || (bundle._geomGen | 0) !== reqGen) return;
    const shapes = msg && msg.shapes,
      meshes = msg && msg.meshes;
    if (!shapes || !shapes.length) return;
    const n = bundle.numShapes | 0;
    // Each worker shape crosses the wire once, in a partial batch or final tail.
    // Retain every batch even when another mesh owner prevents publication.
    const staged = bundle._lbAdoptWire || (bundle._lbAdoptWire = new Array(n));
    for (let i = 0; i < shapes.length; i++) staged[shapes[i]] = meshes[i];
    if (!canClaimFillMeshes(bundle, MESH_OWNER.LB)) return;
    // ...but do not PUBLISH over a set that is already complete. prepareBundle can finish the whole
    // bundle on the main thread while the worker is still streaming the same generation, and
    // replacing that with the handful of shapes a batch carries would un-route all the rest. The
    // staged meshes are not wasted: _applyLbResult folds them in when the build finishes.
    // A bundle whose current meshes ARE a partial adoption is the case this is meant to extend, and
    // a NULL mesh set (the main-thread build declined every shape) is not a complete set to protect.
    if (
      bundle._lbMeshes != null &&
      (bundle._lbGen | 0) === reqGen &&
      bundle._lbPartialGen !== reqGen
    )
      return;
    const packed = new Array(n);
    let hasReal = false;
    for (let s = 0; s < n; s++) {
      const pk = staged[s];
      if (pk === undefined) continue; // still building → no mesh → its cover quad
      // The cause array arrives with the FINAL message, so a batch cannot say why. The anonymous
      // sentinel is the honest answer here, and lbMeshCensus counts it as unknown rather than
      // guessing -- a half-built bundle has no decline statistic worth reading anyway.
      if (pk === null || pk.overBudget) {
        packed[s] = SLUG;
        continue;
      }
      packed[s] = pk;
      hasReal = hasReal || (pk.vertexCount | 0) > 0;
    }
    // Nothing analytic yet. Publishing a set of pure Slug sentinels would rebuild the stream to draw
    // the very cover quads it is already drawing.
    if (!hasReal) return;
    if (!_lbMemAccount(bundle, packed)) return; // post-build revoke → already Slugged
    if (!claimFillMeshes(bundle, MESH_OWNER.LB, packed)) return;
    bundle._lbMeshesRaw = undefined; // worker returns no CPU raw (static → no refresh/resume)
    bundle._lbGen = reqGen;
    bundle._lbPartialGen = reqGen; // ...but awaitLbReady still means FULL quality
    bundle._lbHasSlug = true; // by construction: the unbuilt shapes draw Slug
    bundle._lbBuildS = 0;
    bundle._lbRawGen = reqGen;
    bundle._lbAdoptKey = (bundle._lbAdoptKey | 0) + 1;
  }
  function _applyLbResult(bundle, res, reqGen) {
    if (bundle._disposed || (bundle._geomGen | 0) !== reqGen) return;
    // A later engine selection owns these meshes. Declines must not clear it.
    if (!canClaimFillMeshes(bundle, MESH_OWNER.LB)) {
      bundle._lbAdoptWire = null;
      return false;
    }
    // One authoritative set per generation. prepareBundle's synchronous build of a
    // static bundle is complete and is the builder's answer shape for shape -- the same buildLbShape
    // this result came from -- so publishing this one would re-claim, re-account and re-adopt
    // identical meshes, and swap the main-thread pack for the stripped wire form. Keep the prepared
    // set; drop whatever the stream staged. (Returns false, so the caller does not restamp the build
    // gate from a result it did not use.)
    // ...unless the prepared set was built GATED and the selection now wants more of it
    // (lbBuildStale): then this is the rebuild that answers that, and it publishes.
    if (
      bundle._lbPreparedGen === reqGen &&
      bundle._lbGen === reqGen &&
      Array.isArray(bundle._lbMeshes) &&
      !lbBuildStale(R, bundle)
    ) {
      bundle._lbAdoptWire = null;
      return false;
    }
    // A streamed build posted its finished shapes as they landed and kept only the remainder for
    // here; fold the two back together so everything below sees one whole-bundle array, and the
    // fully built result is the same as an unstreamed build's.
    let wire = res && res.packed;
    if (res && res.streamed) {
      const folded = foldStreamedBuild(bundle._lbAdoptWire, res.tail, bundle.numShapes | 0);
      // Shapes that NO half of the stream ever reported. Zero on a healthy build; anything else means
      // a batch was dropped on this side and those meshes are gone for good, which the fold can only
      // render as Slug sentinels. Counted rather than inferred, because the result is a correct
      // picture drawn by a smaller and smaller analytic route — the failure mode that reads as a
      // memory figure changing from run to run instead of as a defect.
      if (folded.missing) R._uniAdoptLost = (R._uniAdoptLost | 0) + folded.missing;
      wire = folded.wire;
    }
    bundle._lbAdoptWire = null;
    bundle._lbPartialGen = null; // finished: not a partial adoption any more
    bundle._lbAdoptKey = (bundle._lbAdoptKey | 0) + 1;
    // WHY each shape has no mesh, from the build that produced them. The wire flattens every
    // sentinel to `null`, so this is the only thing that can tell a decline from a shape the build
    // never attempted -- and a count of sentinels reports the first for both.
    bundle._lbSlugWhy =
      res && res.why && res.why.length === (bundle.numShapes | 0) ? res.why : null;
    // ...and, for the shapes the caller's MEMORY budget refused, how much each one wanted. Same
    // argument as `why`: the wire cannot carry it on the mesh, and without it a budget refusal
    // reaches the app as an anonymous Slug row.
    bundle._lbMemWants = res && res.memWants && res.memWants.length ? res.memWants : null;
    if (bundle._lbMemWants) {
      R._lbShapeMemDeclined = (R._lbShapeMemDeclined | 0) + bundle._lbMemWants.length;
      for (const w of bundle._lbMemWants) {
        if ((w.bytes | 0) > (R._lbShapeMemWantedBytes | 0)) R._lbShapeMemWantedBytes = w.bytes | 0;
      }
    }
    if (!wire || !wire.length || res.overBudget) {
      // nothing analytic / over budget → whole-bundle Slug
      bundle._lbMeshes = null;
      bundle._lbMeshesRaw = null;
      bundle._lbGen = reqGen;
      bundle._lbHasSlug = true;
      if (res && res.overBudget) bundle._lbMemDenied = true;
      return;
    }
    const packed = new Array(wire.length);
    let hasReal = false;
    for (let s = 0; s < wire.length; s++) {
      const pk = wire[s];
      if (pk === null || (pk && pk.overBudget))
        packed[s] = slugFor(bundle._lbSlugWhy ? bundle._lbSlugWhy[s] : SLUG_WHY.DECLINED);
      else {
        packed[s] = pk;
        hasReal = hasReal || !!(pk && (pk.vertexCount | 0) > 0);
      }
    }
    // Match the synchronous builder: an all-sentinel result has no analytic work.
    // Publishing it as ready only replays Slug through slower shape-range draws.
    if (!hasReal) {
      bundle._lbMeshes = null;
      bundle._lbMeshesRaw = null;
      bundle._lbGen = reqGen;
      bundle._lbHasSlug = true;
      return;
    }
    bundle._lbMeshesRaw = undefined; // worker returns no CPU raw (static → no refresh/resume)
    if (!_lbMemAccount(bundle, packed)) return; // post-build revoke → already Slugged
    claimFillMeshes(bundle, MESH_OWNER.LB, packed);
    bundle._lbGen = reqGen;
    bundle._lbHasSlug = !!res.hasSlug || packed.some((p) => p && p.slug);
    bundle._lbBuildS = 0;
    bundle._lbRawGen = reqGen;
    // FULL QUALITY, the one transition that ends adoption for this generation. Undefined until it
    // happens and constant afterwards, so a consumer that must act ONCE when the bundle stops
    // upgrading (a cached raster, which cannot re-bake per batch) has an exact edge to follow
    // instead of a timer.
    bundle._lbFullGen = reqGen;
  }
  /// Build this bundle's split-stroke geometry now, off the draw path.
  ///
  /// Deliberately NOT called from bundle creation: that would move the cost into
  /// createBundle/importSvg, which is a stall in a different place rather than
  /// one less stall.

  // AUTO-BUILD: hand each newly-created bundle's Loop-Blinn triangulation to the
  // worker at load time. The heavy build runs OFF the main thread; the draw path
  // never builds (it uses ready LB, else Slug). Morph bundles still prepare on the
  // main thread (their build is a different, resumable path).
  try {
    R._lbBuilderFn = (b, force = false) => {
      try {
        if (!b || b._disposed) return true;
        // forceSlug DECLINES THE BUILD, not just the draw. The route check alone would leave the worker
        // building meshes nobody could draw — cost on the very run that is trying to price Slug,
        // and the meshes would then exist, letting a recognized primitive route anyway. Like
        // the Slug-only branch below this declines (false) rather than claiming the bundle: the flag
        // is process-wide and a later build, once it is cleared, must still be able to run.
        // (It cannot reach the worker on its own: the input's flag forwarder carries `__LB_*` only.)
        if (!_buildAllowed(R)) return false;
        // DECLINE, explicitly (false) — do not just return. Every renderer registers a builder, so
        // "I am Slug-only" must not be mistaken for "handled": another renderer may still want these
        // meshes, and the bundle is shared.
        if (R._lbSlugOnly) {
          // EXCEPT FOR PRIMITIVES, which are not Loop-Blinn. Slug-only mode is a statement about
          // how CURVES are drawn, and a recognized circle has no curves to draw — it is one
          // analytic distance with no mesh and no fetches, well under half Slug's cost on the same
          // shape. Declining outright would leave routing the whole bundle to Loop-Blinn as the only
          // way to reach the primitive.
          //
          // Everything unrecognized keeps the Slug sentinel and is drawn by the Slug kernel from
          // its cover quad, in the same stream and the same pass. If nothing is recognized this
          // builds nothing and declines.
          if (!b._morphSrc && b._lbMeshes === undefined) {
            const pm = buildPrimMeshes(b, SLUG);
            if (pm && claimFillMeshes(b, MESH_OWNER.LB, pm)) {
              b._lbGen = b._geomGen | 0;
              b._lbHasSlug = pm.some((p) => p && p.slug);
              return true;
            }
          }
          return false;
        }
        //
        // "Handled" is the honest answer: this renderer wants CPatch, so there is nothing for the
        // LB builder to do and nothing for a later builder to do on its behalf. A renderer that
        // genuinely wants LB still gets it -- its own draw path builds on demand.
        syncFillMeshOwner(R, b);
        // ROUTE CLASS (fillRouteClass.js): a static bundle under 'auto' draws on the cover pass, so no Loop-Blinn mesh is built for it (a pin, a morph or a stream
        // changes its class and asks again: awaitLbReady, the draw path and updateBundleGeometry all re-enter here).
        if (!force && R._fillRouteReason && R._fillRouteReason(b) === 'static-cover') return false;
        if (cpatchServes(b)) return true;
        if (cpatchStaticAutoServes(b)) {
          const reqGen = b._geomGen | 0;
          if (!force && !lbBundleMayPick(b, true)) return false;
          if (
            b._lbMeshes !== undefined &&
            (b._lbGen | 0) === reqGen &&
            !lbBuildStale(R, b) &&
            !b._cpatchRetry
          )
            return true;
          if (b._cpatchConv === 'pending') return true;
          if (R.prepareBundle) {
            try {
              R.prepareBundle(b);
            } catch {
              /* fallback */
            }
          }
          return true;
        }
        if (!b._geomGen && !b._morphSrc) {
          // static bundle → off-thread whole-bundle build
          const reqGen = b._geomGen | 0;
          if (b._lbMeshes !== undefined && (b._lbGen | 0) === reqGen && !lbBuildStale(R, b))
            return true;
          // A build ALREADY IN FLIGHT is not re-issued; the selection may have moved since it
          // started, and the callback re-asks once it lands. (A pin between createBundle and the
          // result is exactly the window awaitLbReady has to survive.)
          if (b._lbWorkerPendingGen === reqGen) return true;
          if (!force && R._lbFillMode === 'auto' && !lbBundleMayPick(b)) return false;
          if (!_lbMemAdmit(b, 1)) {
            releaseFillMeshes(b, MESH_OWNER.LB);
            b._lbGen = b._geomGen | 0;
            b._lbHasSlug = true;
            return;
          }
          // ...and WHICH of its rows are worth building at all. The whole-bundle admission above
          // asks whether ANY row qualifies; this says which, and the difference is most of the build
          // on art whose curved shapes sit among strokes, clips and straight-edged rows.
          const skipNow = force ? null : lbBuildSkipFor(R, b);
          b._lbBuildSkip = skipNow;
          // STAMPED WHEN THE RESULT LANDS, not now. The previous meshes stay resident while the
          // build runs, and a reader that only asks "are there real meshes" would call the bundle
          // ready and draw the set being replaced -- awaitLbReady asks exactly that.
          b._lbWorkerPendingGen = reqGen;
          requestLbBuild(
            b,
            (res) => {
              if (b._lbWorkerPendingGen === reqGen) b._lbWorkerPendingGen = undefined;
              // (asked before this bundle became a morph, under a route that builds at creation: one still pose's meshes, a recognized primitive's among them, would draw at every t)
              if (b._morphSrc) return;
              if (_applyLbResult(b, res, reqGen) !== false) b._lbBuildGated = !!skipNow;
              // The selection can move WHILE the build runs. Re-ask once; the rebuild is ungated, so
              // the next result agrees with the selection and this terminates.
              if (
                !b._disposed &&
                canClaimFillMeshes(b, MESH_OWNER.LB) &&
                lbBuildStale(R, b) &&
                R._requestLbBuild
              )
                R._requestLbBuild(b);
            },
            R.opts.lbAdopt === false
              ? null
              : {
                  ms: R.opts.lbAdoptMs === undefined ? LB_ADOPT_MS : R.opts.lbAdoptMs,
                  shapes:
                    R.opts.lbAdoptShapes === undefined ? LB_ADOPT_SHAPES : R.opts.lbAdoptShapes,
                  onPartial: (msg) => {
                    if (!b._morphSrc) _applyLbPartial(b, msg, reqGen);
                  },
                },
          );
        }
        if (b._morphSrc) R._morphChainRelease(b);
        if (b._morphSrc && !b._morphMeshesBuilt) {
          if (!_lbMemAdmit(b, 2)) {
            b._morphMeshesBuilt = true;
            b._morphMeshesPartial = null;
            return true;
          } // pair VBOs are dual-stream (2×)
          enqueueLbPrepare(R.gl, b); // _lbPreparerFn builds the split strokes with the meshes
        }
        return true;
      } catch {
        /* leave on Slug */
      }
      return true;
    };
    setLbBuilder(R.gl, R._lbBuilderFn);
    R._requestLbBuild = (b) => R._lbBuilderFn(b, R._lbFillMode === 'on');
    /// The recognition pass ALONE, for when the analytic route is off. A primitive is not
    /// Loop-Blinn, so "no Loop-Blinn" should not mean "no primitives" — but the build that finds
    /// them is gated on the analytic route, and the route is gated on there being meshes. This
    /// breaks that circle: it is cheap (a circle fit per shape), it returns false when nothing is
    /// recognized, and it never builds analytic geometry for curves the route did not ask for.
    R._requestPrimBuild = (b) => {
      if (!b || b._disposed || b._morphSrc || b._lbMeshes !== undefined) return false;
      // One scan per geometry. Without a record, a bundle with nothing to recognize would be scanned again on every draw
      // (buildPrimMeshes returns null), a noticeable CPU cost per drawBundle on a large bundle with the analytic route off.
      // Like a recognized mesh, the
      // answer holds until the geometry changes; setSdfPrimitives() applies to bundles prepared after it, as documented.
      const gen = b._geomGen | 0;
      if (b._primScanGen === gen) return false;
      const pm = buildPrimMeshes(b, SLUG);
      if (!pm || !claimFillMeshes(b, MESH_OWNER.LB, pm)) {
        b._primScanGen = gen;
        return false;
      }
      b._lbGen = b._geomGen | 0;
      b._lbHasSlug = pm.some((p) => p && p.slug);
      return true;
    };
    // Keep the idle-drain preparer registered as the no-builder fallback + the
    // morph prepare target (setLbBuilder above routes morph bundles here).
    //
    // DECLINE WITH `false`, LIKE THE BUILDER. Preparers are a chain over the renderers sharing this
    // canvas, and the queue entry is consumed before the chain runs — so a preparer that returns
    // without building and without saying so is the end of that bundle's idle build, not a pass.
    R._lbPreparerFn = (b) => {
      // Idle work cannot change another renderer's live engine selection.
      // Explicit preparation and draw requests transfer ownership separately.
      if (!canClaimFillMeshes(b, MESH_OWNER.LB)) return false;
      // CPatch preparation falls back to cover rendering, never to an idle LB build.
      if (cpatchServes(b) || cpatchStaticAutoServes(b)) return false;
      // Nor when forceSlug is set. The idle drain is a second build path, so the flag has to hold
      // here too or the meshes simply arrive a little later and the run measures them after all.
      if (!_buildAllowed(R)) return false;
      try {
        if (b._morphSrc && !b._morphMeshesBuilt) {
          _ensureBundleMorphMeshes(b);
          return true;
        }
        const gen9 = b._geomGen | 0;
        if (b._lbMeshes === undefined || b._lbGen !== gen9 || lbBuildStale(R, b))
          _ensureLbMeshes(b, 2);
      } catch {
        /* draw-time fallback */
      }
      return true;
    };
    setLbPreparer(R.gl, R._lbPreparerFn);
  } catch {}

  // The morph route reads the SHARED analytic fill mode; it has no default of its
  // own. _lbFillMode / _lbSlugFallback / _lbSlugOnly are initialized once in
  // renderer.js, and setLoopBlinnFill('off'|'auto'|'on'|'only') is what pins them.
  R._lbForceCdt = false; // setLoopBlinnMeshOpts({ forceCdt }) — skip convex fast mesh
  // Does this bundle have a ready analytic mesh set (real LB, current generation)?
  // Used by the LB-only draw + static-cache "don't bake nothing" guards.
  R._lbBundleReady = (bundle) =>
    !!bundle && bundle._lbMeshes != null && bundle._lbGen === (bundle._geomGen | 0);
  /// Is this bundle's mesh set a GATED build that the current selection would now draw more of?
  /// Published because READINESS has to mean it too: the gated meshes are real and current
  /// throughout the rebuild, so every other test of readiness says yes to the set being replaced.
  R._lbBuildStale = (bundle) => !!bundle && lbBuildStale(R, bundle);
  R._lbAutoPicks = _lbAutoPicks;
  R._lbRouteCount = 0;
  R._lbMorphRouteCount = 0;
  R._lbMorphComposedCount = 0;
  R._composedFillFromRT = 0;
  R._composedFillInShader = 0;
  R._composedStrokeFromRT = 0;
}
