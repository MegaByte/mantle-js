// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, trackGlResource } from './contextResources.js';
// unifiedFillDraw.js — draw a bundle's cover quads AND Loop-Blinn triangles in
// ONE call through the fill ubershader.

// Ordering comes free: within a single draw call, fragments hitting the same
// pixel blend in PRIMITIVE order. Depth is NOT what orders them — it could not
// be, since AA makes every shape partially transparent for a pixel or two all
// the way around its edge and depth rejection there would drop the blend. Depth
// is used for one much narrower job, described at the draw: stopping a single
// shape from painting one pixel twice where two of its own pieces meet.
//
// The whole uniform/texture bind is reused from beginFillPass(); only the vertex
// array differs. That is deliberate — a second copy of that binding is exactly
// how the two paths would drift.

import { peekLedger } from './memoryLedger.js';
import { mantleDebugHook, mantleDebugFlag } from '../core/diagnostics.js';
import { getRendererFeature, requireRendererFeature } from './featureRegistry.js';
import { checkPlaneFits } from './tableLayout.js';
import {
  buildUnifiedFillVerts,
  UNIFIED_ATTRIBS,
  UNIFIED_STRIDE_BYTES,
  UNIFIED_STRIDE,
  UNIFIED_MORPH_ATTRIBS,
  UNIFIED_MORPH_STRIDE_BYTES,
  UNIFIED_MORPH_STRIDE,
  buildCurveTexStream,
  buildUnifiedFillVertsNarrow,
  UC_ATTRIBS,
  UC_MORPH_ATTRIBS,
  UC_STRIDE_BYTES,
  UC_MORPH_STRIDE_BYTES,
  UC_STRIDE,
  UC_MORPH_STRIDE,
  UC32_ATTRIBS,
  UC32_MORPH_ATTRIBS,
  UC32_STRIDE_BYTES,
  UC32_MORPH_STRIDE_BYTES,
  UC32_STRIDE,
  UC32_MORPH_STRIDE,
} from './unifiedFillVerts.js';
import { visibleTrimSpan } from './viewCull.js';
import { unitPx2 } from './shapeScale.js';
/// the per-row strip policy's one threshold, device pixels the strip saves per strip vertex it adds (option strokeStripMinSavedPx).
const STRIP_MIN_SAVED_PX = 64;
/// THE STRIP GATE AS DATA: a row takes its strip in 'auto' iff the device px it saves per strip vertex reaches T, i.e. (quadArea - stripArea) * k2 / count >= T
/// (k2 = unit px2, unquantized). `stripTake` is the gate (applyStripMode) and `stripBar` the unit px2 at which it flips: one definition.
export const stripTake = (st, k2, T) =>
  k2 > 0 && st.count > 0 && ((st.quadArea - st.stripArea) * k2) / st.count >= T;
export const stripBar = (st, T) =>
  st.count > 0 && st.quadArea - st.stripArea > 0
    ? (T * st.count) / (st.quadArea - st.stripArea)
    : Number.POSITIVE_INFINITY;
/// The unit px2 values inside (k2Lo, k2Hi) at which the SET of rows on a bundle's strips changes in a way the draw can see (any strip on, any overlapping strip on, any
/// row off), for the 'auto' policy at threshold T. `rowsEligible(i)` is the scale-free part of the row's gate (mode and the row's flag bits).
export function stripBreaks(chunks, T, rowsEligible, k2Lo, k2Hi) {
  const bars = [];
  chunks.forEach((c, i) => {
    if (rowsEligible(c, i)) bars.push({ bar: stripBar(c._strip, T), overlap: !!c._strip.overlap });
  });
  const cuts = [
    ...new Set(bars.map((b) => b.bar).filter((x) => x > k2Lo && x < k2Hi && Number.isFinite(x))),
  ].sort((a, b) => a - b);
  const census = (k2) => {
    let on = 0,
      ovl = 0,
      off = 0;
    for (const b of bars) {
      if (k2 >= b.bar) {
        on = 1;
        if (b.overlap) ovl = 1;
      } else off = 1;
    }
    return on | (ovl << 1) | (off << 2);
  };
  const bounds = [k2Lo, ...cuts, k2Hi],
    out = [];
  let prev = null;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const c = census(Math.sqrt(bounds[i] * bounds[i + 1]));
    if (prev !== null && c !== prev) out.push({ k2: bounds[i], census: c });
    prev = c;
  }
  return out;
}
import { META_FLAGS_SHAPE, META_FILL_A } from '../bundle/layout.js';
import {
  ENGINES,
  ROUTES,
  DECLINE,
  enginesOfUnifiedDraw,
  isStrokeRow as _isStrokeRow,
} from './engineLedger.js';
import { ROW_COVER_AA, ROW_COVER_HARD, ROW_MESH, ROW_OTHER_QUAD } from './coverKernelPolicy.js';
import { engineSelection, analyticAllowed } from './engineSwitch.js';
import { bundleHasNestedMask } from './nestedMask.js';
import { fillRouteReason, fillRouteUnified } from './fillRouteClass.js';

// A morph with CPatch meshes posed at the current t. Its unified stream is static: the
// posed meshes plus a cover quad for every row CPatch did not plan.
function cpatchPosedMorph(bundle) {
  return !!bundle && !!bundle._cpatchMorphPlan && (bundle._cpatchBuilt | 0) > 0;
}

// A morph can retain a static fallback mesh and interval meshes. Shader
// specialization must cover both, including kinds used only by later poses.
const specializationMeshCache = new WeakMap();
function specializationMeshes(bundle) {
  if (!bundle) return null;
  const a = bundle._lbMeshes,
    b = bundle._morphMeshes;
  if (!a || !b || a === b) return a || b;
  const hit = specializationMeshCache.get(bundle);
  if (hit && hit.a === a && hit.b === b) return hit.meshes;
  const meshes = a.concat(b);
  specializationMeshCache.set(bundle, { a, b, meshes });
  return meshes;
}

/// Meta slot 15 = MT_STROKE_PARAMS.w = the stroke's dash id (0 = no dash). Named
/// here rather than inlined so the layout dependency is greppable.
const MT_DASH_ID = 15;
// Cache the route classification as one byte per entry.
const SPAN_CP = 1,
  SPAN_LB = 2,
  SPAN_SDF = 4,
  SPAN_STROKE = 8,
  SPAN_COVER = 16;

/// The isolation job for one drawList OP, or null when the op needs no offscreen pass.
///
/// Dispatches on the OP FIELDS, exactly as renderer.js's drawList loop does — `op.filterGraphId`
/// indexes bundle.filterGraphs, `op.filterId` resolves a filterRecord. The meta row's filter slot
/// is a different index space, and using it to pick a graph would pick the wrong one.
///
/// Module-level and exported so a GPU-free smoke can drive the real thing: what it returns rides
/// a per-bundle cache for many frames. `filterRecordOf` is R.filterRecord, passed in so this stays a pure function
/// of the bundle.
export function entryFilterOf(bundle, op, filterRecordOf) {
  const gid = op.filterGraphId | 0;
  if (gid && bundle.filterGraphs) {
    const g = bundle.filterGraphs[gid - 1];
    // The id is gid. buildDrawList sets filterGraphId INSTEAD of filterId, so a graph op has no filterId; reading
    // it would give id 0, the split below keeps only entries with a truthy id, and every graph-filtered shape on this
    // route would draw UNFILTERED (filterRegionSmoke checks a blur + offset square).
    // THE ID TRAVELS, NOT THE OBJECT. The isolation job ends up in `cache.filters`, which is
    // per-bundle state that survives frame after frame — it is rebuilt only when the
    // GEOMETRY generation (or the pick/adopt/xform key) moves. A filter's NUMBERS move on
    // none of those: `createFilterParams` bumps `_filterParamGen`, which every filter-result
    // cache key carries, so the result cache correctly misses and re-evaluates — and against a
    // graph object captured here, that would be the one the write is NOT in. The write takes a
    // private copy of the graph and the touched node first (filterParams.js `ownNode`,
    // copy-on-write, because claimFilter shares one graph across every use of a <filter> id
    // and a morph shares its source's), and replaces `bundle.filterGraphs[gid-1]` with it.
    // A captured graph object would make a post-import tween of a GRAPH node move nothing while
    // its packed-float twin moves. renderer.js's drawList loop looks the graph up live, every
    // frame, and this asks the same question at the same time.
    if (g && g.nodes && g.nodes.length) return { filterId: gid, graphId: gid, graph: g };
  }
  const fid = op.filterId | 0;
  if (fid) {
    // kind 0 is a color matrix, which the ubershader applies inline — no
    // isolation needed, and it has always worked on this route.
    const rec = filterRecordOf ? filterRecordOf(fid) : null;
    // No graphId: filterRecord re-reads `bundle.lastFilterFloats` every frame, which is why
    // the packed-float route has always tweened.
    if (rec && rec.kind >= 1) return { filterId: fid, graphId: 0, graph: null };
  }
  return null;
}

/// The graph an isolation job names, resolved AGAINST THE BUNDLE now rather than when the job
/// was made. Callers must go through this: the job outlives a filter-parameter write, and
/// createFilterParams REPLACES the graph object (copy-on-write) instead of mutating it.
export function entryFilterGraph(bundle, f) {
  if (!f) return null;
  return (
    (f.graphId && bundle && bundle.filterGraphs && bundle.filterGraphs[f.graphId - 1]) ||
    f.graph ||
    null
  );
}

export function attachUnifiedFillDraw(R) {
  const gl = R.gl;
  /// After a RAW activeTexture (the coefficient texture's unit 12), leave the fill pass's scratch unit active and tell
  /// its shadow. Restoring TEXTURE0 would leave uCurveData under the next bare bindTexture: a group's backdrop snapshot
  /// would then replace it, and every cover quad inside the group would draw nothing.
  const parkActiveUnit = () => {
    if (R._parkFillActiveUnit) R._parkFillActiveUnit();
    else gl.activeTexture(gl.TEXTURE0);
  };

  // Analytic streams require a program compiled with Loop-Blinn coverage attributes.
  // unifiedFill: false selects the ordinary fill pass instead.

  // The rest of such a bundle is unaffected: its shapes carry the Slug sentinel and are drawn by
  // the Slug kernel from their cover quads, in the same stream and the same pass as the primitive.
  const _hasPrim = (bundle) => {
    const ms = specializationMeshes(bundle);
    if (!ms) return false;
    for (const m of ms) if (m && m.prim) return true;
    return false;
  };
  /// The per-shape engine answer for 'auto' (lbShapePolicy via morphDraw), or null where it does not apply: another mode, a
  /// morph or streamed bundle (every shape is its mesh), a CPatch build (CPatch's own gate chose it) or the forced route.
  const autoPicksFor = (bundle, morph) => {
    if (morph || bundle._lbStream || !R._lbAutoPicks) return null;
    return R._lbFillMode === 'auto' && !_forceUnified() ? R._lbAutoPicks(bundle) : null;
  };
  // unifiedFill: 'force' -- MEASUREMENT: send a bundle down the unified route even with no analytic mesh, every shape a cover
  // quad in the unified program. It is the only way to price the unified route against the plain fill pass at the same
  // kernel and content; without it the two paths are only ever seen on different bundles.
  const _forceUnified = () => R.opts.unifiedFill === 'force';
  /// The route class's reason for this bundle (fillRouteClass.js); also what debugStats reports as the gate when the class declines.
  R._fillRouteReason = (bundle) => fillRouteReason(R, bundle);
  R._unifiedFillEligible = (bundle) =>
    R.opts.unifiedFill !== false &&
    fillRouteUnified(R, bundle) &&
    ((_forceUnified() && !!(bundle && bundle.drawList && bundle.drawList.length)) ||
      (!!(bundle && (bundle._lbMeshes || (R.opts.unifiedMorph !== false && bundle._morphMeshes))) &&
        (R._lbFillMode !== 'off' ||
          !!bundle._lbStream ||
          // A MORPH bundle's primitive is its static pose: the unified draw can follow t only through the morph pair
          // attributes (R._unifiedMorphEligible, off in 'off' mode), so with them off the primitive would draw the t=0
          // shape for every t once its lean program was warm.
          (_hasPrim(bundle) &&
            !bundle._morphMeshes &&
            analyticAllowed(engineSelection(R), 'prim').allow))));
  /// The union of every drawn mesh's KIND MASK — which blocks of lbCoverage() this
  /// bundle can actually reach. lbCoverage is one big per-kind dispatch and a
  /// typical mesh uses a handful of kinds, so the unused blocks compile out. Kind
  /// 10 alone is the largest single block in the file.
  ///
  /// Cached per geometry generation: it is read on every draw to pick the variant.
  R._lbKindMask = (bundle) => {
    if (!bundle) return -1;
    // ...and on the ADOPTION COUNTER with it. Shapes join the mesh set while the build runs, and a
    // kind that arrives with one of them still has to reach the variant. Stamped on the generation
    // alone, this answered from the first batch for the bundle's whole life and the program compiled
    // out every kind the later shapes needed.
    const gen = bundle._geomGen | 0,
      adopt = bundle._lbAdoptKey | 0;
    const meshes = specializationMeshes(bundle);
    if (
      bundle._lbKindMaskGen === gen &&
      bundle._lbKindMaskAdopt === adopt &&
      bundle._lbKindMaskMeshes === meshes
    )
      return bundle._lbKindMask;
    if (!meshes) return _forceUnified() ? 0 : -1; // forced cover-only: no analytic kind; otherwise unknown → every kind
    let mask = 0;
    for (const m of meshes) {
      if (!m) continue;
      // A morph mesh is a container; its segments carry the masks.
      if (m.segments) {
        for (const sg of m.segments)
          if (sg) {
            // Older interval packs omit this metadata. A known static fallback
            // cannot prove which kernels those intervals need.
            if (!(sg.kindMask | 0) && (sg.vertexCount | 0) > 0) return -1;
            mask |= sg.kindMask | 0;
          }
      } else mask |= m.kindMask | 0;
      // A mesh packed before this existed reports 0, which would wrongly omit
      // every kind. Treat a zero mask on a non-empty mesh as "unknown".
      if (!(m.kindMask | 0) && !m.segments && (m.vertexCount | 0) > 0) return -1;
    }
    bundle._lbKindMaskMeshes = meshes;
    bundle._lbKindMaskGen = gen;
    bundle._lbKindMaskAdopt = adopt;
    return (bundle._lbKindMask = mask || -1);
  };
  /// Does NO mesh in this bundle carry Bezout-tier data? — the presence question
  /// `MANTLE_NO_BEZOUT` asks, answered from the flag the PACKER already computes.
  ///
  /// `hasBezout` is on every packed mesh ("any CUBIC_BEZ piece → needs the full program",
  /// lbPack), it rides the worker wire, and it already ORs `interiorHasChain2` — because chain 2
  /// lives in aC1/aC2, "which only the FULL program binds". Without this answer every bundle would
  /// compile the 3×3 Bezout determinant, its cofactor gradient, the kind-12 band block and the
  /// chain-2 intersection whether or not one vertex in it could reach them.
  ///
  /// THE FLAG IS THE whole TEST, and it has to be, because `MANTLE_NO_BEZOUT` does not merely
  /// empty a body: it drops aC1/aC2 from `lbVertexSetup`'s signature, so vLB1/vLB2 are never
  /// assigned. Every name that views them — cM01/cM02 (kind 4), vCh2A/vCh2B (chain 2), the
  /// kind-12 band's end normals in aC2.xy, and CPatch's own OBB (cBoxA/cBoxU/cBoxV) — must be
  /// unreachable. The packer's flag covers the first three by construction; CPatch is excluded
  /// where the define is pushed, since it shares this stream and reads those same slots.
  ///
  /// Unknown is not absent. A mesh that predates the flag, a CPatch pack, or a morph segment
  /// that does not carry one all report `undefined`, and each one keeps the full program —
  /// same rule `_lbKindMask` uses for a zero mask.
  R._lbNoBezout = (bundle) => {
    if (!bundle) return false;
    const gen = bundle._geomGen | 0,
      adopt = bundle._lbAdoptKey | 0;
    const meshes = specializationMeshes(bundle);
    if (
      bundle._lbNoBezGen === gen &&
      bundle._lbNoBezAdopt === adopt &&
      bundle._lbNoBezMeshes === meshes
    )
      return bundle._lbNoBez;
    let ans = false;
    if (meshes) {
      ans = true;
      for (const m of meshes) {
        if (!m || m.slug) continue;
        if (m.segments) {
          for (const sg of m.segments) {
            if (sg && sg.hasBezout !== false) {
              ans = false;
              break;
            }
          }
          if (!ans) break;
          continue;
        }
        if (!(m.vertexCount | 0)) continue;
        if (m.hasBezout !== false) {
          ans = false;
          break;
        } // true OR undefined ⇒ full program
      }
    }
    bundle._lbNoBezMeshes = meshes;
    bundle._lbNoBezGen = gen;
    bundle._lbNoBezAdopt = adopt;
    return (bundle._lbNoBez = ans);
  };
  /// ...and the CUBIC chain kernel (`cubicChainBoxCov`), on the same rule: a kind-0 face whose aTC.x
  /// carries sentinel 4 or 5, or whose aSeamM flags chain 2 as a cubic. The builder emits them wherever a face's chain
  /// runs along a concave cubic piece, so art without one keeps the kernel out of its program. Saying "no cubic" when
  /// one exists would read the arc's control points as straight chain vertices -- a wrong outline -- so the flag is
  /// set where the pack writes the sentinel, and UNKNOWN keeps the kernel.
  R._lbNoCubicChain = (bundle) => {
    if (!bundle) return false;
    const gen = bundle._geomGen | 0,
      adopt = bundle._lbAdoptKey | 0;
    const meshes = specializationMeshes(bundle);
    if (
      bundle._lbNoCubicGen === gen &&
      bundle._lbNoCubicAdopt === adopt &&
      bundle._lbNoCubicMeshes === meshes
    )
      return bundle._lbNoCubic;
    let ans = false;
    if (meshes) {
      ans = true;
      for (const m of meshes) {
        if (!m || m.slug) continue;
        if (m.segments) {
          for (const sg of m.segments) {
            if (sg && sg.hasCubicChain !== false) {
              ans = false;
              break;
            }
          }
          if (!ans) break;
          continue;
        }
        if (!(m.vertexCount | 0)) continue;
        if (m.hasCubicChain !== false) {
          ans = false;
          break;
        }
      }
    }
    bundle._lbNoCubicMeshes = meshes;
    bundle._lbNoCubicGen = gen;
    bundle._lbNoCubicAdopt = adopt;
    return (bundle._lbNoCubic = ans);
  };
  /// Did any CPatch pack write a SEAM COMPANION? The kernel compiles the companion's code -- a second whole
  /// arc-distance solver inlined into the composition loop -- only for a bundle that has one (MANTLE_CPATCH_COMP,
  ///). The companion is off by default, so a default build answers no and its programs leave the
  /// code out; saying no when a seam carries one would drop that seam's bound, so the pack counts what it wrote.
  R._cpatchHasComp = (bundle) => {
    if (!bundle) return false;
    const gen = bundle._geomGen | 0,
      adopt = bundle._lbAdoptKey | 0;
    const meshes = specializationMeshes(bundle);
    if (
      bundle._cpCompGen === gen &&
      bundle._cpCompAdopt === adopt &&
      bundle._cpCompMeshes === meshes
    )
      return bundle._cpComp;
    let ans = false;
    if (meshes)
      for (const m of meshes)
        if (m && m.cpatch && m.comp) {
          ans = true;
          break;
        }
    bundle._cpCompMeshes = meshes;
    bundle._cpCompGen = gen;
    bundle._cpCompAdopt = adopt;
    return (bundle._cpComp = ans);
  };
  // Unknown geometry retains the helper. Static packs declare their use;
  // existing morph tapes never carry this static whole-loop certificate.
  R._cpatchHasQuadraticArea = (bundle) => {
    if (!bundle) return true;
    const gen = bundle._geomGen | 0,
      adopt = bundle._lbAdoptKey | 0;
    const meshes = specializationMeshes(bundle);
    if (
      bundle._cpAreaGen === gen &&
      bundle._cpAreaAdopt === adopt &&
      bundle._cpAreaMeshes === meshes
    )
      return bundle._cpArea;
    let ans = !meshes;
    if (meshes)
      for (const m of meshes) {
        if (m && m.cpatch && m.vertexCount | 0 && m.hasQuadraticArea !== false) {
          ans = true;
          break;
        }
      }
    bundle._cpAreaMeshes = meshes;
    bundle._cpAreaGen = gen;
    bundle._cpAreaAdopt = adopt;
    return (bundle._cpArea = ans);
  };
  // Whether any static area paint carries a native cubic span. Unknown geometry and a mesh that does not say keep the
  // helper (a morph's meshes say false: its tapes never carry the static certificate).
  R._cpatchHasCubicArea = (bundle) => {
    if (!bundle) return true;
    const gen = bundle._geomGen | 0,
      adopt = bundle._lbAdoptKey | 0;
    const meshes = specializationMeshes(bundle);
    if (
      bundle._cpCubicAreaGen === gen &&
      bundle._cpCubicAreaAdopt === adopt &&
      bundle._cpCubicAreaMeshes === meshes
    )
      return bundle._cpCubicArea;
    let ans = !meshes;
    if (meshes)
      for (const m of meshes) {
        if (m && m.cpatch && m.vertexCount | 0 && m.hasCubicArea !== false) {
          ans = true;
          break;
        }
      }
    bundle._cpCubicAreaMeshes = meshes;
    bundle._cpCubicAreaGen = gen;
    bundle._cpCubicAreaAdopt = adopt;
    return (bundle._cpCubicArea = ans);
  };
  R._cpatchOnlyQuadraticArea = (bundle) => {
    const meshes = specializationMeshes(bundle);
    if (!meshes) return false;
    let found = false;
    for (const m of meshes) {
      if (!m || m.slug || !(m.vertexCount | 0)) continue;
      if (m.prim) continue;
      if (
        !m.cpatch ||
        (m.cpatchAreaOnly !== undefined ? !m.cpatchAreaOnly : m.hasQuadraticArea !== true)
      )
        return false;
      found = true;
    }
    return found;
  };
  /// A morph bundle additionally needs the pair attributes and the uMorphT mix,
  /// which is a different variant — so the eligibility is separate from the fill
  /// one even though the route is the same.
  ///
  /// A morph whose CPatch meshes are posed at the current t draws a static stream (see
  /// cpatchPosedMorph), so it is not eligible even when Loop-Blinn pair meshes were also built
  /// for it (awaitLbReady builds them). Reading those pair meshes, the row census would find a mesh
  /// on every row and drop the cover kernel, while the stream draws the rows CPatch did not plan
  /// as cover quads: those rows would paint nothing.
  R._unifiedMorphEligible = (bundle) =>
    R.opts.unifiedMorph !== false &&
    R.opts.unifiedFill !== false &&
    !!(bundle && bundle._morphMeshes) &&
    R._lbFillMode !== 'off' &&
    !cpatchPosedMorph(bundle);
  ///
  /// The same rules entriesFor applies when it builds the stream, asked row by row without building
  /// it: a fill row takes its cover quad when a per-shape transform override is bound for it, when
  /// 'auto''s per-shape policy passed its mesh over, or when it has no usable mesh. A morph mesh
  /// counts only when every one of its segments is usable, since which one draws depends on t.
  ///
  /// Returns a mask: 1 = some cover fill row is shaded by the AA kernel, 2 = some cover fill row
  /// carries a hard per-row id (flagsShape bits 15-16 = 2 or 3), 0 = no fill row draws a cover quad,
  /// -1 = cannot tell (no meta or no meshes) -- which keeps every kernel.
  const _meshServes = (m, morph, primitivesAllowed) => {
    if (!m || m.slug || (m.prim && !primitivesAllowed)) return false;
    if (morph && m.segments && m.segments.length) {
      for (const sg of m.segments)
        if (!sg || sg.slug || !(sg.vbo || sg.verts) || !((sg.vertexCount | 0) > 0)) return false;
      return true;
    }
    return !!(m.verts || m.vbo) && (m.vertexCount | 0) > 0;
  };
  /// ...and the same census PER ROW, for the cost model that chooses the kernel (coverKernelPolicy): a
  /// Uint8Array over the bundle's rows (coverKernelPolicy's ROW_* classes), or null where the mask above is
  /// -1. A row the drawList never paints stays ROW_NONE.
  R._unifiedRowClasses = (bundle) => {
    if (!bundle) return null;
    R._applyPreparedCPatchDrawState(bundle);
    const admission = !bundle._morphSrc && R._preparedCPatchState(bundle);
    const admissionToken = admission && admission.token;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0;
    if (!meta || !st) return null;
    const morph = !!(R._unifiedMorphEligible && R._unifiedMorphEligible(bundle));
    const meshes =
      (morph ? bundle._morphMeshes : bundle._lbMeshes) || (!morph && _forceUnified() ? [] : null);
    if (!meshes) return null;
    // ...AND only FOR A DRAW THE UNIFIED ROUTE WILL TAKE. A built mesh set makes a bundle ELIGIBLE, which is not the
    // route's decision: 'auto' declines a bundle whose per-shape policy gave no row its mesh (a stroke-covered bundle
    // whose rows all floor out onto the no-AA kernel is exactly that), and a pinned mode declines a covered bundle with
    // no primitive. That draw goes to the classic pass, every fill row a cover quad, and a census that read the declined
    // meshes as served would drop its kernel and hand it the base program (MANTLE_NO_COVER_FILL): such a bundle
    // would choose the no-AA kernel and never draw it. Ask the route's own gate, and answer "cannot tell" (every kernel).
    // (A morph routes through its own branch, a stream always routes, and 'force' is the route by fiat.)
    if (
      !morph &&
      !bundle._lbStream &&
      !_forceUnified() &&
      R._lbWouldServe &&
      !R._lbWouldServe(bundle)
    )
      return null;
    const n = bundle.numShapes | 0;
    // A streamed bundle is mesh-only by construction (entriesFor emits no cover quad for it).
    if (!bundle.drawList || (!bundle.drawList.length && bundle._lbStream)) {
      if (!bundle._lbStream) return null;
      const cls = new Uint8Array(n);
      for (let s = 0; s < n; s++) if (meshes[s]) cls[s] = ROW_MESH;
      return cls;
    }
    // A COLRv1 glyph's silhouette is drawn as its row's cover quad by R._colrLeaf (and its per-glyph masks
    // off the bundle's cover chunks), through the fill pass, whatever the stream holds: unknown.
    if (bundle.colrGraphs && bundle.colrGraphs.length) return null;
    const picks = autoPicksFor(bundle, morph);
    const ovPacked = (R.draw.overrides && R.draw.overrides.packedBuffer) || null;
    const ovXform = ovPacked && R._ovHasXform ? (s) => R._ovHasXform(ovPacked, s) : null;
    // A fill override can give a row fill the meta row says it lacks -- a fade in from alpha 0, a fill
    // set on a stroke row -- and the shader's doFill reads the overridden color. Such a row counts.
    const ovFill = ovPacked
      ? (s) => ((Math.floor(ovPacked[s * 24 + 7] + 0.5) | 0) & 1) !== 0
      : null;

    const cm = R.draw.colorMatrix,
      cmOffset = R.draw.colorMatrixOffset;
    // Multiplying alpha alone preserves zero alpha. Only RGB-to-alpha terms or
    // an alpha offset can make an empty stroke fill reach the cover kernel.
    const alphaMayRise = !!(
      (cm && (cm[3] !== 0 || cm[7] !== 0 || cm[11] !== 0)) ||
      (cmOffset && cmOffset[3] !== 0)
    );
    // Cached on everything the answer reads, except the per-draw state above, which makes the scan run each
    // time (the classic route already pays that same scan).
    const perDraw = !!ovPacked || alphaMayRise;
    const primitivesAllowed = analyticAllowed(engineSelection(R), 'prim').allow;
    const c = bundle._uniRowClasses;
    if (
      !perDraw &&
      c &&
      c.gen === (bundle._geomGen | 0) &&
      c.adopt === (bundle._lbAdoptKey | 0) &&
      c.picks === picks &&
      c.meshes === meshes &&
      c.dl === bundle.drawList &&
      c.morph === morph &&
      c.admissionToken === admissionToken &&
      c.primitivesAllowed === primitivesAllowed
    )
      return c.cls;
    const cls = new Uint8Array(n);
    for (const op of bundle.drawList) {
      if (op.kind !== 'fillShape') continue;
      const s = op.shapeIdx | 0;
      if (s < 0 || s >= n) continue;
      const strokeRow = _isStrokeRow(meta, st, s);
      const m =
        strokeRow ||
        (ovXform && ovXform(s)) ||
        (picks && !picks[s]) ||
        (admission && !admission.mask[s])
          ? null
          : meshes[s];
      if (_meshServes(m, morph, primitivesAllowed)) {
        cls[s] = ROW_MESH;
        continue;
      }
      // no fill kernel runs on a stroke row or on a row with no fill (unless an override or a matrix gives it one)
      if (
        (strokeRow || !(meta[s * st + META_FILL_A] > 0)) &&
        !alphaMayRise &&
        !(ovFill && ovFill(s))
      ) {
        cls[s] = ROW_OTHER_QUAD;
        continue;
      }
      cls[s] =
        (((meta[s * st + META_FLAGS_SHAPE] | 0) >> 15) & 3) >= 2 ? ROW_COVER_HARD : ROW_COVER_AA;
    }
    if (!perDraw)
      bundle._uniRowClasses = {
        gen: bundle._geomGen | 0,
        adopt: bundle._lbAdoptKey | 0,
        picks,
        meshes,
        dl: bundle.drawList,
        morph,
        cls,
        admissionToken,
        primitivesAllowed,
      };
    return cls;
  };
  // Optional descriptor bits: 4 = an active mesh row; 8 = known presence.
  // Existing callers still receive only cover-AA/hard bits 1/2. The variant
  // selector can obtain mesh presence without evaluating the census twice.
  R._unifiedCoverRows = (bundle, withMeshPresence = false) => {
    const cls = R._unifiedRowClasses(bundle);
    if (!cls) return -1;
    // (the census is a pass over every row and is asked once per run; the class array is cached per generation, so the answer rides on it)
    const slot = withMeshPresence ? '_covMaskP' : '_covMask';
    if (cls[slot] !== undefined) return cls[slot];
    let mask = withMeshPresence ? 8 | (cls.includes(ROW_MESH) ? 4 : 0) : 0;
    for (let s = 0; s < cls.length && (mask & 3) !== 3; s++) {
      if (cls[s] === ROW_COVER_AA) mask |= 1;
      else if (cls[s] === ROW_COVER_HARD) mask |= 2;
    }
    cls[slot] = mask;
    return mask;
  };
  /// A variant that is still LINKING draws with its base, which has no LB
  /// attributes at all — the buffer would be read as cover quads and the LB
  /// triangles would paint garbage. So the route waits for the real program and
  /// falls through to the classic route until then, which is only ever a few
  /// frames and never a stall.
  ///
  /// Records WHY it declined in `debugStats.unifiedFillGate`. Every wrong turn on
  /// this route so far came from not being able to see which path drew, so the
  /// reason is part of the route, not a debugging aid bolted on afterwards.
  R._unifiedFillReady = (bundle) => {
    if (R.opts.unifiedFill === false) {
      R._unifiedFillGate = 'opt-off';
      return false;
    }
    // A mask whose children carry masks of their own needs the cover pass's per-level bake (nestedMask.js).
    if (bundleHasNestedMask(bundle)) {
      R._unifiedFillGate = 'nested-mask';
      return false;
    }
    if ((R.opts.fillDefines || []).includes('MANTLE_LB_FILL')) {
      R._unifiedFillGate = 'forced';
      return true;
    }
    if (!R._unifiedFillEligible(bundle)) {
      R._unifiedFillGate = !fillRouteUnified(R, bundle)
        ? R._fillRouteReason(bundle)
        : R._lbFillMode === 'off'
          ? 'lb-off'
          : bundle && bundle._lbMeshes
            ? 'ineligible'
            : 'no-meshes';
      return false;
    }
    if (!R._fillVariantHasLbFill || !R._fillVariantHasLbFill(bundle)) {
      R._unifiedFillGate = 'variant-warming';
      // This falls to the BEST NON-LB ENGINE, not to literal Slug: _drawBundleLB returns
      // false on 'variant-warming' and the ordinary fill pass re-runs the selection, minus
      // LB, i.e. second best per bundle. A program that has not linked cannot draw, so
      // some fallback is physics — the CHOICE is what matters.
      //
      // NOT a fixed ranking, and hard is NOT a general runner-up: the no-AA engine is
      // only admissible where a STROKE covers the fill edge and hides the missing AA
      // (the per-row MANTLE_HARD_MIXED mechanism). That hard beats Slug on STROKED
      // content says nothing about the unstroked case, which is why this has to re-run
      // the selection rather than hardcode a second choice.
      //
      return false;
    }
    R._unifiedFillGate = 'on';
    return true;
  };
  /// Does any drawn shape have PARTIAL alpha? Two of one shape's pieces can both
  /// cover a pixel where they share a chord (the two copies of that edge are only
  /// fp-equal, so the rasterizer hands the tie to both). Painted twice at alpha 1
  /// that is invisible; at alpha 0.5 it reads 0.75. So the depth claim that fixes
  /// it is needed only where the paint is translucent.
  ///
  /// Cached per geometry generation — it is read on every draw.
  R._bundleNeedsDepthClaim = (b) => bundleNeedsDepthClaim(b);
  function bundleNeedsDepthClaim(bundle) {
    const gen = bundle._geomGen | 0;
    if (bundle._lbDepthClaimGen === gen) return bundle._lbDepthClaim;
    // A CPATCH BUNDLE'S PIECES GENUINELY OVERLAP, as a morph's do: a morph's mesh is a lerp of two
    // partitions and the lerp of two partitions is not one; a CPatch cover is a cell polygon DILATED
    // 1.5px so its AA ramp has somewhere to live, so neighboring patches overlap by ~3px by
    // construction. Under OVER, two pieces each carrying half a pixel of coverage composite to three
    // quarters instead of a half, and the error lands exactly on the seams — which is every boundary
    // pixel of a decomposed shape.
    //
    // That error only appears where alpha < 1, so CPatch takes the ordinary translucency test below,
    // which asks exactly that of the meta rows. Morphs are decided further down.
    void 0;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0,
      n = bundle.numShapes | 0;
    let need = false;
    if (!meta || !st)
      need = true; // unknown → claim
    else
      for (let s = 0; s < n; s++) {
        const a = meta[s * st + 7]; // MT_FILL.a
        // Every partial paint needs single ownership; RGBA8 rounding does not
        // make nearly opaque or sub-byte alpha safe to paint twice.
        if (a > 0 && a < 1) {
          need = true;
          break;
        }
      }
    // A per-draw alpha or a fill override can make an authored-opaque shape
    // translucent at draw time, and neither is visible from the meta row.
    bundle._lbDepthClaimGen = gen;
    return (bundle._lbDepthClaim = need);
  }

  /// Which stroked rows have split-stroke geometry, and where each one's prim rows
  /// land in the bundle's shared atlas.
  ///

  /// Static and morph streams get SEPARATE VAOs and buffers. They differ in
  /// stride and in six extra attributes, and a VAO is where that layout lives —
  /// re-pointing one per draw would respecify ten attribute pointers every time
  /// a scene mixed the two.
  // (No shared vertex arrays: every stream cache owns its own -- see vaoOf.)

  /// MEASUREMENT only (`unifiedFillPadFloats: N`, default 0). Widens the vertex
  /// stride by N unused floats, drawing pixel-identical output from a proportionally
  /// larger buffer. Padding goes at the END of each vertex, so every attribute offset
  /// is untouched and only fetch/upload bandwidth changes.
  ///
  /// Why this exists: 28.8% of the stream is per-curve data repeated across a
  /// triangle's three vertices, and the proposed fix
  /// is a per-curve texture plus an index attribute — a real change to the builder,
  /// the VAO and the vertex shader, against a codebase precedent of a vertex texture
  /// fetch LOSING to a plain attribute. Inflating the stride measures the SENSITIVITY
  /// first: if +N% costs nothing then -29% saves nothing, and the optimization is
  /// dead before being written. Cheap to add, decisive either way.
  const padFloats = Math.max(0, R.opts.unifiedFillPadFloats | 0);

  const curveTex = R.opts.unifiedFillCurveTex !== false;
  function inflateStream(built, morph) {
    // Must follow the layout actually in use, or a pad measurement silently measures
    // a different stream than the one being drawn.
    const base = built.narrow
      ? built.idx32
        ? morph
          ? UC32_MORPH_STRIDE
          : UC32_STRIDE
        : morph
          ? UC_MORPH_STRIDE
          : UC_STRIDE
      : morph
        ? UNIFIED_MORPH_STRIDE
        : UNIFIED_STRIDE;
    const wide = base + padFloats,
      n = built.vertexCount;
    const out = new Float32Array(wide * n);
    for (let i = 0; i < n; i++) out.set(built.verts.subarray(i * base, i * base + base), i * wide);
    built.verts = out;
  }

  /// Keyed by LAYOUT, not just by morph-ness. The narrow (curve-texture) and wide
  /// layouts can both occur in one renderer — the builder refuses the narrow one when
  /// an index would not fit an unsigned short — and a VAO caches its attribute
  /// pointers, so sharing one between them would read the wide stream through narrow
  /// offsets. That is silent corruption, not a visible failure.
  /// The vao a BUILT cache draws through: ITS own. A private pair makes a bundle
  /// switch a bind without forcing a static bundle (which drops its CPU copy after upload) to rebuild its stream.
  const vaoOf = (c) => (c ? c.glo || null : null);

  /// A vertex array + buffer for ONE stream, with the layout's attribute pointers. Never shared between layouts: a VAO caches
  /// its pointers, so reading a wide stream through narrow offsets would be silent corruption.
  function makeVao(morph, narrow, idx32) {
    // + the measurement pad, which sits after every attribute so the offsets hold.
    const stride =
      (narrow
        ? idx32
          ? morph
            ? UC32_MORPH_STRIDE_BYTES
            : UC32_STRIDE_BYTES
          : morph
            ? UC_MORPH_STRIDE_BYTES
            : UC_STRIDE_BYTES
        : morph
          ? UNIFIED_MORPH_STRIDE_BYTES
          : UNIFIED_STRIDE_BYTES) +
      padFloats * 4;
    const attribs = narrow
      ? idx32
        ? morph
          ? UC32_ATTRIBS.concat(UC32_MORPH_ATTRIBS)
          : UC32_ATTRIBS
        : morph
          ? UC_ATTRIBS.concat(UC_MORPH_ATTRIBS)
          : UC_ATTRIBS
      : morph
        ? UNIFIED_ATTRIBS.concat(UNIFIED_MORPH_ATTRIBS)
        : UNIFIED_ATTRIBS;
    const v = {
      vao: trackGlResource(gl, gl.createVertexArray()),
      buf: trackGlResource(gl, gl.createBuffer(), 'fillStream'),
      owner: null,
    };
    R.glBindVertexArray(v.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, v.buf);
    for (const [loc, size, off, type] of attribs) {
      gl.enableVertexAttribArray(loc);
      // UNNORMALIZED unsigned short (or unsigned int, the 32-bit layout): the integer arrives in the shader's float as-is,
      // which is what the packed (shapeIdx, coefBlock) pair needs. normalized=true
      // would divide by the type's maximum and silently turn both indices into fractions.
      gl.vertexAttribPointer(
        loc,
        size,
        type === 'ushort' ? gl.UNSIGNED_SHORT : type === 'uint' ? gl.UNSIGNED_INT : gl.FLOAT,
        false,
        stride,
        off,
      );
    }
    R.glBindVertexArray(null);
    return v;
  }

  /// The id a filtered shape's cached result is stored under. ONE definition, used by the draw and
  /// published for tests, so what the cache is keyed on cannot drift from what a test believes.
  const filterCacheId = (owner, gen, adoptKey, filterId, shapeIdx) =>
    'u' + owner + '_' + gen + '_' + adoptKey + '_' + filterId + '_' + (shapeIdx | 0);
  R._unifiedFilterCacheId = (bundle, filterId, shapeIdx, owner) =>
    filterCacheId(
      owner || 'b' + (bundle && bundle.uid),
      bundle ? bundle._geomGen | 0 : 0,
      bundle ? bundle._lbAdoptKey | 0 : 0,
      filterId,
      shapeIdx,
    );

  /// Painter-ordered entries for `bundle`: each shape contributes either its LB
  /// triangles (when it has a usable mesh) or its cover quad (when it doesn't),
  /// never both — the cover quad IS the Slug fallback for that shape, and
  /// emitting both would double-paint.
  /// A morph mesh is a container of t-SEGMENTS: each holds one pair pack valid
  /// over a sub-range of t, and _morphFillSeg picks by t and rescales t into that
  /// segment's blend range. Only ONE is ever active, so the stream carries only
  /// that one and is rebuilt when the active segment changes — a handful of
  /// rebuilds across a whole morph sweep, not one per frame. That keeps the
  /// vertex layout and the shader identical to the static route: no per-vertex
  /// t-range, no culling, no extra attributes (and there are none free — the
  /// pair already fills all 16 locations).
  ///
  /// The local t is a UNIFORM, so every shape's active segment must rescale t the
  /// same way. Shapes of one morph share their segmentation in practice; when they
  /// do not, this returns null and the bundle falls through to the per-shape route.
  let segLocalT = 0;
  let segLoB = 0,
    segHiB = 1; // the active segment's blend range, per morphSeg call
  let hasCoverQuads = true;
  function morphSeg(mesh, t) {
    const segs = mesh && mesh.segments;
    if (!segs || !segs.length) {
      segLocalT = t;
      segLoB = 0;
      segHiB = 1; // the whole morph IS this mesh's range
      return mesh;
    }
    let seg = segs[segs.length - 1];
    for (let i = 0; i < segs.length; i++)
      if (t <= segs[i].tHi) {
        seg = segs[i];
        break;
      }
    const span = seg.tHiB - seg.tLoB;
    const lt = span > 1e-9 ? (t - seg.tLoB) / span : 0;
    segLocalT = lt;
    segLoB = seg.tLoB;
    segHiB = seg.tHiB;
    return seg;
  }

  /// Which segment is active at `t`, as an index — the cache key for the vertex
  /// stream, which is rebuilt when the active segment changes.
  ///
  /// The first shape that HAS segments answers for the bundle. That is a cache key,
  /// not a claim that the shapes agree: they measurably do not, which is why each
  /// entry carries its own segment's blend range and the draw sets uMorphT per run.
  function activeSegIndex(bundle, t) {
    const meshes = bundle && bundle._morphMeshes;
    if (!meshes) return -1;
    for (const m of meshes) {
      const segs = m && m.segments;
      if (!segs || !segs.length) continue;
      for (let i = 0; i < segs.length; i++) if (t <= segs[i].tHi) return i;
      return segs.length - 1;
    }
    return -1;
  }

  /// THE STRIP COVER, svg/strokeStrip.js). 0 = every stroke row draws its
  /// single cover quad; 1 = a row whose strip cannot overlap itself draws the strip; 2 = every strip row does, which needs
  /// the depth claim to stop a crossing painting a pixel twice, so it asks for a depth attachment (DEPTH_BITS > 0) and
  /// bundleNeedsDepthClaim answers for it. A strip is built once for the AUTHORED width of the static geometry, so a stream
  /// of any other state draws the quads: a draw whose width override makes a strip row wider than authored (the strip would
  /// clip the stroke), a cover mesh replaced since the import (a nine-slice, a streamed rebuild), a stream, a morph, an incremental stroke, a morph, a
  /// renderer that turned it off (opts.strokeStrip === false).
  R._stripModeFor = (b, m) => stripModeFor(b, m);
  /// Point each stroke row's cover chunk at its strip (mode 2: every strip; mode 1: the strips that cannot overlap themselves) or
  /// back at its quad (mode 0). The chunk's own start and count are never edited: renderer._coverChunkStart / _coverChunkCount
  /// read the flag, so only the two cover draws that go through them see the strip.
  function applyStripMode(bundle, mode) {
    const cs = bundle._stripChunks;
    if (!cs) return mode;

    const auto = R.opts.strokeStrip !== 'on' && R.opts.strokeStrip !== true;
    const T = auto
      ? R.opts.strokeStripMinSavedPx != null
        ? +R.opts.strokeStripMinSavedPx
        : STRIP_MIN_SAVED_PX
      : 0;
    const pinned = auto && (R._forcedCover || R._forcedKernel || !!R.opts.fillKernel);
    const px2 = auto ? unitPx2(R, bundle) : 0;
    let on = 0,
      ovl = 0,
      sig = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i],
        st = c._strip;
      let take = mode === 2 || (mode === 1 && !st.overlap);
      if (
        take &&
        Math.round(bundle.metaFloats[st.row * bundle.metaFloatsPerShape + 27]) & (1 | 8192 | 16384)
      )
        take = false;
      if (take && auto) take = !pinned && stripTake(st, px2, T);
      c._stripOn = take;
      if (take) {
        on++;
        if (st.overlap) ovl++;
        sig = (sig * 31 + st.row + 1) | 0;
      }
    }
    // what the draw really uses: 2 only when an overlapping strip is on (the depth claim follows it), 1 when only clean ones are, else 0
    const eff = ovl ? 2 : on ? 1 : 0;
    bundle._stripModeNow = eff;
    bundle._stripKey = eff + '|' + on + '|' + sig;
    R._stripStats = {
      rowsOn: on,
      rowsTotal: cs.length,
      mode: eff,
      minSavedPx: T,
      policy: auto ? 'auto' : 'on',
      pinned,
    };
    return eff;
  }
  R._applyStripMode = (b, morph) => applyStripMode(b, stripModeFor(b, morph));
  /// The strip policy's breaks for a bundle inside (k2Lo, k2Hi) (stripBreaks above): none under the 'on' policy (no size term), a pin, or when the bundle takes no strips.
  R._stripBreaksFor = (bundle, k2Lo, k2Hi) => {
    const cs = bundle && bundle._stripChunks;
    if (!cs || !cs.length) return [];
    const mode = stripModeFor(bundle, false);
    const auto = R.opts.strokeStrip !== 'on' && R.opts.strokeStrip !== true;
    if (!mode || !auto || R._forcedCover || R._forcedKernel || R.opts.fillKernel) return [];
    const T =
      R.opts.strokeStripMinSavedPx != null ? +R.opts.strokeStripMinSavedPx : STRIP_MIN_SAVED_PX;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0;
    return stripBreaks(
      cs,
      T,
      (c) =>
        (mode === 2 || (mode === 1 && !c._strip.overlap)) &&
        !(Math.round(meta[c._strip.row * st + 27]) & (1 | 8192 | 16384)),
      k2Lo,
      k2Hi,
    );
  };
  if (typeof globalThis !== 'undefined' && globalThis.__MANTLE_DEBUG__)
    R._stripKeyAt = (b, w, h) => {
      const sv = R._warmViewport;
      R._warmViewport = [w, h];
      try {
        R._applyStripMode(b, false);
        return b._stripKey;
      } finally {
        R._warmViewport = sv;
      }
    };
  function stripModeFor(bundle, morph) {
    const rows = bundle.stripRows;
    if (
      !rows ||
      morph ||
      R.opts.strokeStrip === false ||
      bundle.coverQuadFloats !== bundle._stripCoverRef ||
      bundle._lbStream ||
      bundle._incStroke
    )
      return 0;
    const ov = (R.draw.overrides && R.draw.overrides.packedBuffer) || null;
    if (ov) {
      for (let s = 0; s < rows.length; s++) {
        const r = rows[s];
        if (!r) continue;
        // packed override row s: mask at +3 of texel 1 (OV_POS_VIS .w), absolute width at texel 5 .x
        const base = s * 24,
          mask = Math.floor(ov[base + 7] + 0.5) | 0;
        if ((mask & 4) !== 0 && ov[base + 20] > r.authoredW * 1.0001) return 0;
      }
    }
    if (!bundle.stripOverlap || R.opts.strokeStripMode === 1) return 1; // strokeStripMode: 1 never takes the overlapping strips (measurement, or an app that cannot afford the depth claim)
    if (R._depthBits === undefined) R._depthBits = R.gl.getParameter(R.gl.DEPTH_BITS) | 0;
    return R._depthBits > 0 ? 2 : 1;
  }
  function entriesFor(bundle, morph = false, morphT = 0, candidateMeshes = null) {
    const admission = !morph && !candidateMeshes && R._preparedCPatchState(bundle);
    // A morph's meshes are PAIR packs ([A 24f | B 24f] per vertex) built by
    // _ensureBundleMorphMeshes; the static ones are single packs. Same shape
    // indexing, different stride, so the only thing that changes here is which
    // list to read.
    const meshes =
      candidateMeshes ||
      (morph ? bundle._morphMeshes : bundle._lbMeshes) ||
      (!morph && _forceUnified() ? [] : null);
    if (!meshes) return null;
    // Streamed bundles have no drawList to walk — they are solid-fill by
    // construction with a mesh per shape, so mesh order IS paint order (the same
    // fallback _ensureLbOrder uses when the drawList is empty). Emitting them here
    // is what lets the road take this route at all.
    if (!bundle.drawList || (!bundle.drawList.length && bundle._lbStream)) {
      if (!bundle._lbStream) return null;
      const out2 = [];
      for (let s = 0; s < meshes.length; s++) {
        const m = meshes[s];
        const mv = m && (m.verts || m.vbo);
        if (!m || m.slug || !mv || !(m.vertexCount > 0)) continue;
        out2.push({
          kind: 'lb',
          verts: mv,
          vertexCount: m.vertexCount,
          shapeIdx: s,
          morphLoB: 0,
          morphHiB: 1,
        });
      }
      hasCoverQuads = false;
      return out2.length ? out2 : null;
    }
    if (bundleHasNestedMask(bundle)) {
      R._unifiedFillGate = 'nested-mask';
      return null;
    }
    const primitivesAllowed = analyticAllowed(engineSelection(R), 'prim').allow;
    const meta = bundle.metaFloats,
      st = bundle.metaFloatsPerShape | 0;
    /// 'auto' picks the engine PER SHAPE: a shape whose mesh the policy passes over draws its cover quad in this same stream.
    const picks = autoPicksFor(bundle, morph);
    const stripMode = applyStripMode(bundle, stripModeFor(bundle, morph));

    const isStrokeRow = (s) => _isStrokeRow(meta, st, s);
    // Cover-kernel IDs come from the metadata stroke-coverage proof.
    // Programs without MANTLE_COVER_KERNEL ignore this entry slot.
    const coverKidOf = (s) => ((meta[s * st + META_FLAGS_SHAPE] | 0) >> 15) & 3;
    // A transform override can change mesh eligibility. Share the morph-route
    // predicate and avoid scanning rows when no override buffer is bound.
    const ovPacked = (R.draw.overrides && R.draw.overrides.packedBuffer) || null;
    const ovXform = ovPacked && R._ovHasXform ? (s) => R._ovHasXform(ovPacked, s) : null;
    // Filtered entries retain their isolation job and vertex range in the shared
    // stream. Dispatch uses draw-op filter IDs, whose index space differs from
    // the metadata filter slot. A disagreement with metadata declines the route.
    const offscreenFilterOf = (op) =>
      entryFilterOf(bundle, op, R.filterRecord ? (id) => R.filterRecord(id) : null);
    // Metadata filtering is a cross-check, not a second dispatch source.
    const metaSaysOffscreen = (s) => {
      if (!meta || st < 33) return false;
      const filterId = Math.floor(meta[s * st + 32] + 0.5);
      if (!filterId) return false;
      const graph = bundle.filterGraphs ? bundle.filterGraphs[filterId - 1] : null;
      if (graph && graph.nodes && graph.nodes.length) return true;
      const rec = R.filterRecord ? R.filterRecord(filterId) : null;
      return !!(rec && rec.kind >= 1);
    };
    const out = [];
    // Does the stream contain any COVER QUAD? Only those are served by the
    // ubershader's Slug/stroke kernels, which read uCurveData — so only they force
    // a morph to keep lerping the curve texture per frame. An all-LB stream lets
    // setT stay skipped, which is worth two GL draws a frame.
    hasCoverQuads = false;
    /// A group's CHILD ops, for bounding its accumulator to what it actually paints
    /// (R._contentRectPx). renderer.js's loop walks this itself because it knows its
    /// own position in the list; here the same walk is done on demand, and only for
    /// a bundle that actually carries groups.
    let _gOpsCache = null;
    const gOpsFor = (beginOp) => {
      if (!_gOpsCache) {
        _gOpsCache = new Map();
        const dl = bundle.drawList;
        for (let i = 0; i < dl.length; i++) {
          if (dl[i].kind !== 'groupBegin') continue;
          let depth = 1;
          const kids = [];
          for (let j = i + 1; j < dl.length; j++) {
            const o = dl[j];
            if (o.kind === 'groupBegin') {
              depth++;
              if (o.filterId) kids.push(o);
              continue;
            } // (a nested filter paints past its leaves: the rect must see it)
            if (o.kind === 'groupEnd') {
              if (--depth === 0) break;
              continue;
            }
            kids.push(o);
          }
          _gOpsCache.set(dl[i], kids.length ? kids : null);
        }
      }
      return _gOpsCache.get(beginOp) || null;
    };
    /// Tags the entry being emitted with this op's isolation job, if it has one.
    /// One op emits at most ONE entry, so a per-op variable is enough — and each of
    /// the three push sites below returns straight to the loop head.
    let pendingFilter = null;
    let pendingBlend = null;
    let pendingColr = null;
    let pendingLoB = 0,
      pendingHiB = 1;
    const emit = (e) => {
      if (pendingColr) e.colrOp = pendingColr;
      e.morphLoB = pendingLoB;
      e.morphHiB = pendingHiB;
      if (pendingFilter) {
        e.filterId = pendingFilter.filterId;
        e.filterGraphId = pendingFilter.graphId | 0;
        e.filterGraph = pendingFilter.graph;
      }
      if (pendingBlend) e.blendOp = pendingBlend;
      out.push(e);
    };
    for (const op of bundle.drawList) {
      if (op.kind === 'groupBegin' || op.kind === 'groupEnd') {
        if (!R._groupBegin || !R._groupEnd) {
          R._unifiedFillGate = 'group-op';
          return null;
        }
        emit({ kind: op.kind, op, gOps: op.kind === 'groupBegin' ? gOpsFor(op) : null });
        continue;
      }
      if (op.kind !== 'fillShape') {
        R._unifiedFillGate = 'group-op';
        return null;
      }
      const s = op.shapeIdx | 0;
      // A per-leaf mix-blend-mode needs the shape isolated and composited with a
      // blend equation the fill pass does not have — the same shape as an offscreen
      // filter, so the same interruption serves it. renderer.js's branch is
      // shared (R._blendLeaf, taking a renderSource callback) rather than copied.
      //
      // Taken without that, the blend simply never applied: 5336 px off Slug at
      // worst 192/255 on a multiply leaf.
      const blendOp = op.blendMode ? op : null;
      if (blendOp && !R._blendLeaf) {
        R._unifiedFillGate = 'blend-mode';
        return null;
      }
      // A COLRv1 paint graph re-renders the glyph through its own dispatch, so a
      // cover quad or LB mesh emitted here would paint the silhouette WITHOUT its
      // color layers. Served like a blend leaf or a filter: the span walk
      // interrupts and hands the op to R._colrLeaf, extracted from renderer.js's
      // drawList loop so both routes run the same code.

      const colrOp = op.colrGraphId ? op : null;
      if (colrOp && !R._colrLeaf) {
        R._uniColrDeclines = (R._uniColrDeclines | 0) + 1;
        R._unifiedFillGate = 'colr-graph';
        return null;
      }
      pendingBlend = blendOp;
      pendingColr = colrOp;
      pendingLoB = 0;
      pendingHiB = 1;
      pendingFilter = offscreenFilterOf(op);
      if (!pendingFilter && metaSaysOffscreen(s)) {
        R._unifiedFillGate = 'filter-meta-mismatch';
        return null;
      }

      if (pendingFilter) {
        // `unifiedFillFilters: false` declines the whole bundle instead. Debug
        // only — for bisecting a filter difference to this split rather than to the
        // filter kernels — and NOT a supported route: it is a fallback to classic.
        if (R.opts.unifiedFillFilters === false) {
          R._unifiedFillGate = 'offscreen-filter';
          return null;
        }
        // Nothing to isolate WITH. morphDraw attaches the isolation machinery; without
        // it the shape would draw UNFILTERED, which is the 9680px defect above — so
        // declining is the only safe answer.
        if (!R._morphShapeFilter) {
          R._unifiedFillGate = 'offscreen-filter-no-isolator';
          return null;
        }
      }
      //
      // The cover quad is the answer rather than a decline — Slug's kernel draws it
      // with the transform applied, so only the transformed shapes leave the
      // analytic path and the rest of the bundle stays in the one draw.
      const strokeRow = isStrokeRow(s);
      let m =
        strokeRow ||
        (ovXform && ovXform(s)) ||
        (picks && !picks[s]) ||
        (admission && !admission.mask[s])
          ? null
          : meshes[s];
      if (m && m.prim && !primitivesAllowed) m = null;

      if (morph && m) {
        segLocalT = null;
        m = morphSeg(m, morphT);
        pendingLoB = segLoB;
        pendingHiB = segHiB;
      }
      // A static pack calls its interleaved array `verts`; a morph segment calls
      // the same thing `vbo`. Reading only `verts` made every morph shape look
      // mesh-less, so each fell back to its cover quad and the frame came out
      // byte-identical to the Slug morph — a silent loss of Loop-Blinn that no
      // pixel test could flag, because Slug is a CORRECT picture.
      const mv = m && (m.verts || m.vbo);
      if (m && !m.slug && mv && m.vertexCount > 0) {
        emit({ kind: 'lb', verts: mv, vertexCount: m.vertexCount, shapeIdx: s });
        continue;
      }
      // A drawList op carries `chunk`, never start/count — reading op.count would make
      // this branch dead (`undefined > 0`), so no cover quad would be emitted and any
      // shape without an LB mesh would silently vanish from the unified draw.
      const c = op.chunk;
      const start = c ? R._coverChunkStart(c) : -1;
      const ccount = R._coverChunkCount ? R._coverChunkCount(c) : c.count | 0;
      if (start >= 0 && ccount > 0) {
        // A cover quad is always the sole painter for its row.
        // shapeIdx is carried for the ISOLATION call, which needs the meta row this
        // quad belongs to; the vertex builder reads its own from shapeIdxFloats.
        emit({
          kind: 'cover',
          srcVert: start,
          count: ccount,
          shapeIdx: s,
          coverKid: coverKidOf(s),
        });
        hasCoverQuads = true;
      } else if (!m) {
        return null; // can't serve this shape at all — fall through, never half-draw
      } else if (pendingFilter) {
        // A mesh exists but is unusable (a Slug sentinel, or zero vertices) and there
        // is no cover quad either, so this op contributes NO geometry — and therefore
        // no range for the isolation step to render. The shape would simply vanish,
        // taking its filter with it. Decline instead: silently dropping a filtered
        // shape is the same class of failure as drawing it unfiltered.
        R._unifiedFillGate = 'offscreen-filter-no-geometry';
        return null;
      }
    }
    return out.length ? out : null;
  }

  /// Returns false when the bundle can't be served this way, so the caller falls
  /// through to its existing route rather than drawing nothing.
  R._drawBundleUnifiedFill = function drawBundleUnifiedFill(bundle, morphT) {
    if (!bundle || bundle._disposed || !R.shaderSources.fillFrag) return false;
    R._applyPreparedCPatchDrawState(bundle);
    if (R._preparedCPatchRequested(bundle) && !R._preparedCPatchWanted(bundle)) return false;
    if (bundle._morphSrc && R._preparedCPatchWanted(bundle) && !R._preparedNativeMorphReady(bundle))
      return false;
    const cover = bundle.coverQuadVboFloats || bundle.coverQuadFloats;
    // Stream-only bundles have meshes instead of cover geometry. Other bundles
    // require cover quads for fallback entries.
    if (!cover && !bundle._lbStream) {
      R._unifiedFillGate = 'no-cover-quads';
      return false;
    }
    // LB morph vertices carry endpoint pairs, rebuilt at segment boundaries.
    // Posed CPatch meshes already describe the current t and use static vertices.
    const cpatchPosed = cpatchPosedMorph(bundle);
    const isMorph = morphT != null && !cpatchPosed;
    const seg = isMorph ? activeSegIndex(bundle, morphT) : -1;
    const gen = bundle._geomGen | 0;
    // Key the stream on the identities of transformed rows, since each can
    // switch between mesh and cover geometry. Scan only with bound overrides.
    let xformKey = 0;
    const ovP0 = (R.draw.overrides && R.draw.overrides.packedBuffer) || null;
    if (ovP0 && R._ovHasXform) {
      const nS = bundle.numShapes | 0;
      for (let s = 0; s < nS; s++)
        if (R._ovHasXform(ovP0, s)) xformKey = (xformKey * 31 + s + 1) | 0;
    }
    // Automatic mesh selection is scale-dependent and has its own revision.
    const pickKey = !isMorph && autoPicksFor(bundle, false) ? bundle._lbPickKey | 0 : 0;
    // Worker adoption changes mesh availability without changing geometry.
    const adoptKey = bundle._lbAdoptKey | 0;
    // Stroke strip selection also changes the stream.
    applyStripMode(bundle, stripModeFor(bundle, isMorph));
    const stripKey = bundle._stripKey || 0;
    const admission = !isMorph && R._preparedCPatchState(bundle);
    const admissionToken = admission && admission.token;
    const primitivesAllowed = analyticAllowed(engineSelection(R), 'prim').allow;
    let cache = bundle._unifiedFill;
    // Posed CPatch streams retain their structure within a morph segment.
    const genKey = cpatchPosed ? bundle._cpatchStructGen | 0 : gen;
    // A shared VBO can contain another cache's stream. Reupload the retained
    // CPU vertices, or rebuild when that copy has been released.
    const lost = !!cache && vaoOf(cache) != null && vaoOf(cache).owner !== cache;
    // TEST-only MUTATION (under __MANTLE_DEBUG__): `globalThis.__MANTLE_MUTATE = 'streamKey'` folds a per-draw counter into the stream cache identity, so every draw misses
    // (instancedCompactCacheNodeSmoke proves the retention guard fails under it).
    if (cache && mantleDebugHook('__MANTLE_MUTATE') === 'streamKey')
      cache.gen = -1 - (R._mutSerial = (R._mutSerial | 0) + 1);
    if (
      !cache ||
      cache.gen !== genKey ||
      cache.morph !== isMorph ||
      cache.seg !== seg ||
      cache.xformKey !== xformKey ||
      cache.pickKey !== pickKey ||
      cache.adoptKey !== adoptKey ||
      cache.stripKey !== stripKey ||
      cache.admissionToken !== admissionToken ||
      cache.primitivesAllowed !== primitivesAllowed ||
      (lost && !cache.verts)
    ) {
      segLocalT = isMorph ? null : 0;
      const entries = entriesFor(bundle, isMorph, morphT);
      // entriesFor already recorded WHY it gave up; only stamp the generic reason
      // when it did not.
      if (!entries) {
        if (R._unifiedFillGate === 'on') R._unifiedFillGate = 'no-entries';
        return false;
      }
      const sidx = bundle.hybridShapeIdxVboFloats || bundle.hybridShapeIdxFloats;
      // Streamed bundles retain separate wide scratch and narrow upload buffers.
      // The builders reuse them only when sizes match.
      const isStream = !!bundle._lbStream;
      const pooledWide = isStream && cache && cache.wide ? cache.wide : null;
      // Build nonstreamed narrow vertices directly to avoid a complete wide copy.
      const direct = !!(curveTex && !bundle._noCurveTex && !isStream);
      const built = direct
        ? buildUnifiedFillVertsNarrow(entries, cover, sidx, isMorph, null)
        : buildUnifiedFillVerts(entries, cover, sidx, isMorph, pooledWide);
      const wideBuf = isStream ? built.verts : null;
      if (!built.vertexCount && !built.overflow) {
        R._unifiedFillGate = 'empty-verts';
        return false;
      }

      let coef = null;

      if (curveTex && !bundle._noCurveTex) {
        // Returns null when a packed index would not fit an unsigned short. Falling
        // back to the WIDE float layout is correct and already a supported path — the
        // alternative would be a third vertex layout for a case that needs >65535
        // coefficient blocks.
        const nar = direct
          ? built.overflow
            ? null
            : {
                verts: built.verts,
                coefData: built.coefData,
                coefW: built.coefW,
                coefH: built.coefH,
                blocks: built.blocks,
                idx32: built.idx32,
              }
          : buildCurveTexStream(
              built.verts,
              built.vertexCount,
              isMorph,
              isStream && cache ? cache.verts : null,
            );
        if (nar) {
          built.verts = nar.verts;
          built.narrow = true; // inflateStream and the VAO must follow this
          built.idx32 = !!nar.idx32; // ...and the index width
          if (nar.idx32) R._uniCurveTexIdx32 = (R._uniCurveTexIdx32 | 0) + 1;
          coef = {
            data: nar.coefData,
            w: nar.coefW,
            h: nar.coefH,
            blocks: nar.blocks,
            tex: null,
            idx32: !!nar.idx32,
          };
        } else {
          R._uniCurveTexOverflow = (R._uniCurveTexOverflow | 0) + 1;
          // Coefficient-index overflow requires the wide layout and its shader.
          // Decline this draw and invalidate texture-layout selection for the next.
          bundle._noCurveTex = true;
          R._unifiedFillGate = 'curvetex-overflow';
          return false;
        }
      }
      if (padFloats > 0) inflateStream(built, isMorph);
      // The previous texture belongs to the previous generation.
      if ((bundle._cpatchBuilt | 0) > 0) {
        const ledger = peekLedger(gl);
        if (ledger && ledger.budget() < Infinity) {
          const prospective = staticStreamGrowth(
            ledger,
            bundle._unifiedFill,
            built.verts.byteLength,
            isMorph,
            coef,
            0,
          );
          if (!ledger.admit(prospective, 'CPatch static stream')) {
            R._unifiedFillGate = 'cpatch-stream-budget';
            return false;
          }
        }
      }
      const prevCache = bundle._unifiedFill;
      if (prevCache && prevCache.coef && prevCache.coef.tex) {
        deleteGlResource(gl, 'Texture', prevCache.coef.tex);
        prevCache.coef.tex = null;
      }
      // PER-ENTRY VERTEX RANGES, always. Two consumers need them and neither is
      // knowable when the stream is built: an offscreen filter isolates ONE entry
      // into its own target, and drawSprite restricts the draw to a row range that
      // varies per draw. Typed arrays rather than an array of objects — a bundle
      // holds this for its whole life and games hold bundles in the hundreds. The
      // entries themselves are NOT cached: each holds a reference to its mesh's
      // vertex array, which the stream has already absorbed.
      const nE = built.entries.length;
      const spanV = new Int32Array(nE),
        spanN = new Int32Array(nE),
        spanS = new Int32Array(nE);
      const spanArea = new Uint8Array(nE),
        spanEngine = new Uint8Array(nE);
      // Per-entry morph t. A morph's shapes do NOT share their segmentation — a
      // plain two-shape morph disagreed on 16 of 21 frames — so one uMorphT for the
      // whole stream cannot serve them. Each entry carries the local t its own
      // segment rescaled to, and the draw walk breaks its run whenever that value
      // changes, setting the uniform per run. Shapes that agree still batch.
      const spanLo = new Float32Array(nE),
        spanHi = new Float32Array(nE);
      let filters = null; // sparse: entry index -> isolation job
      let groups = null; // sparse: entry index -> group bracket
      let blends = null; // sparse: entry index -> blend-leaf op
      let colrs = null; // sparse: entry index -> COLRv1 glyph op
      for (let i = 0; i < nE; i++) {
        const e = built.entries[i];
        spanV[i] = e.vStart | 0;
        spanN[i] = e.vCount | 0;
        spanS[i] = e.shapeIdx | 0;
        const sm = !isMorph && bundle._lbMeshes && bundle._lbMeshes[e.shapeIdx];
        spanArea[i] = e.kind === 'lb' && sm && sm.cpatch && sm.hasQuadraticArea === true ? 1 : 0;
        spanEngine[i] =
          e.kind === 'lb'
            ? sm && sm.prim
              ? SPAN_SDF
              : sm && sm.cpatch
                ? SPAN_CP
                : SPAN_LB
            : e.kind === 'cover'
              ? _isStrokeRow(bundle.metaFloats, bundle.metaFloatsPerShape | 0, e.shapeIdx)
                ? SPAN_STROKE
                : SPAN_COVER
              : 0;
        spanLo[i] = +e.morphLoB || 0;
        spanHi[i] = e.morphHiB === undefined ? 1 : +e.morphHiB;
        if (e.filterId) {
          (filters || (filters = new Map()))
            // `graphId` is what the draw resolves; `graph` is the build-time object, kept only
            // as the last resort below so a bundle that somehow loses its filterGraphs array
            // degrades to the picture it had rather than to the single-kind branch.
            .set(i, {
              filterId: e.filterId,
              graphId: e.filterGraphId | 0,
              graph: e.filterGraph || null,
            });
        }
        if (e.blendOp) {
          (blends || (blends = new Map())).set(i, e.blendOp);
        }
        if (e.colrOp) {
          (colrs || (colrs = new Map())).set(i, e.colrOp);
        }
        if (e.kind === 'groupBegin' || e.kind === 'groupEnd') {
          (groups || (groups = new Map())).set(i, {
            begin: e.kind === 'groupBegin',
            op: e.op,
            gOps: e.gOps || null,
          });
        }
      }
      cache = bundle._unifiedFill = {
        gen: genKey,
        morph: isMorph,
        seg,
        localT: segLocalT || 0,
        // Reused across frames rather than rebuilt: a posed CPatch morph keys on its structure,
        // which stands for a whole plan segment while its coefficients move underneath it. It is
        // the only cache that survives a frame boundary, and the only one that needs its CPU
        // stream kept so it can put it back into the shared buffer.
        reusable: cpatchPosed,
        cover: hasCoverQuads,
        coef,
        xformKey,
        pickKey,
        adoptKey,
        stripKey,
        admissionToken,
        primitivesAllowed,
        groups,
        blends,
        colrs,
        spanLo,
        spanHi,
        wide: wideBuf,
        spanV,
        spanN,
        spanS,
        spanArea,
        spanEngine,
        engineMask: spanEngine.reduce((mask, engine) => mask | engine, 0),
        filters,
        verts: built.verts,
        vertexCount: built.vertexCount,
        uploaded: false,
        glo: null,
      };
      // The previous generation's vertex array + buffer: kept when the layout is unchanged (a streamed bundle rebuilds every
      // frame, a morph at every segment), freed when it is not.
      if (prevCache && prevCache.glo) {
        if (
          prevCache.morph === isMorph &&
          !!prevCache.coef === !!coef &&
          !!(prevCache.coef && prevCache.coef.idx32) === !!(coef && coef.idx32)
        )
          cache.glo = prevCache.glo;
        else {
          deleteGlResource(gl, 'VertexArray', prevCache.glo.vao);
          deleteGlResource(gl, 'Buffer', prevCache.glo.buf);
        }
        prevCache.glo = null;
      }
    } else if (isMorph) {
      // Same segment, new t: no rebuild, just rescale into the segment's range.
      segLocalT = null;
      const meshes = bundle._morphMeshes;
      for (let i = 0; i < meshes.length && segLocalT === null; i++) {
        if (meshes[i]) morphSeg(meshes[i], morphT);
      }
      cache.localT = segLocalT || 0;
    }
    // Per-curve coefficients: one RGBA32F texture per geometry generation, built with
    // the vertex cache and re-used until that generation changes.
    // Fatal state check: no texture AND no data to build one from. The sampler would
    // then read whatever else is on unit 12 — a constant, t-independent wrong result,
    // which is exactly the clipped-morph signature (t=0.5 and t=1 came out IDENTICAL).
    if (cache.coef && !cache.coef.tex && !cache.coef.data) {
      R._uniCoefLost = (R._uniCoefLost | 0) + 1;
    }
    if ((bundle._cpatchBuilt | 0) > 0) {
      const ledger = peekLedger(gl);
      if (ledger && ledger.budget() < Infinity) {
        const coefficientBytes =
          cache.coef && !cache.coef.tex && cache.coef.data ? cache.coef.data.byteLength : 0;
        const priorBufferBytes = ledger.bytesOf(cache.glo && cache.glo.buf);
        const vertexGrowth = cache.verts
          ? Math.max(0, cache.verts.byteLength - priorBufferBytes)
          : 0;
        const prospective = coefficientBytes + vertexGrowth;
        if (!ledger.admit(prospective, 'CPatch static stream')) {
          R._unifiedFillGate = 'cpatch-stream-budget';
          return false;
        }
      }
    }
    if (cache.coef && !cache.coef.tex && cache.coef.data) {
      const c = cache.coef;
      // Structurally unreachable (the builder widens the texture until its rows fit 4096 and refuses the stream past that),
      // but a texel-count plane gets the same check as every other: name it and throw before allocating.
      checkPlaneFits(gl, 'unified coefficient texture', c.w, c.h, 'unified fill');
      const t = trackGlResource(
        gl,
        gl.createTexture(),
        'fillStream',
        R._handle ? R._handle.bundle : null,
      );

      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (R._fpU) R._fpU[12] = t;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, c.w, c.h, 0, gl.RGBA, gl.FLOAT, c.data);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      parkActiveUnit();
      c.tex = t;
      // The CPU block data is dead once uploaded, like the vertex stream itself.
      R._uniCoefBytes = (R._uniCoefBytes | 0) + c.data.byteLength;
      c.data = null;
    }
    if (
      R._handle &&
      R._handle.maskRegions.some(
        (reg) => reg.hasGroups || reg.kind === 'effectClip' || reg.kind === 'effectMask',
      ) &&
      R._ensureMaskBake
    )
      R._ensureMaskBake();
    const v =
      cache.glo || (cache.glo = makeVao(isMorph, !!cache.coef, !!(cache.coef && cache.coef.idx32)));
    R.glBindVertexArray(v.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, v.buf);

    if (v.owner !== cache) cache.uploaded = false;
    if (!cache.uploaded) {
      gl.bufferData(gl.ARRAY_BUFFER, cache.verts, gl.STATIC_DRAW);
      cache.uploaded = true;
      v.owner = cache;
      {
        const L = peekLedger(gl);
        if (L && R._handle) L.tag(v.buf, 'fillStream', R._handle.bundle);
      } // the stream's bytes are charged to the bundle that last filled it

      cache.vertBytes = cache.verts.byteLength;
      R._uniStreamBytes = (R._uniStreamBytes | 0) + cache.vertBytes;
      // A streamed bundle keeps its CPU stream: it is the pool the next frame
      // refills, so dropping it would reallocate every frame — the opposite of the
      // reason the classic route pooled its combined VBO.
      // A reusable cache keeps its copy: it outlives the frame that built it, so it will have to
      // put its stream back the next time the shared buffer changes hands, and rebuilding it
      // instead would mean re-deriving a whole segment every frame.
      if (R.opts.unifiedFillKeepVerts !== true && !bundle._lbStream && !cache.reusable)
        cache.verts = null;
    }
    // Everything below draws ONE SPAN of the stream. With no isolated shape that
    // span is the whole thing and this is one drawArrays, exactly as before; with
    // one it runs per run and once per isolated shape, into whichever framebuffer
    // the caller has bound.
    let bailReason = null,
      drewAny = false,
      splitDepthCleared = false;
    const drawSpan = (
      first,
      count,
      localT,
      areaMode = null,
      pinnedVariant = null,
      reuseDepth = false,
      spanEngines = null,
    ) => {
      if (count <= 0) return true;
      // every DEFERRED COEFFICIENT PASS, HERE, before the frame's first fill reads any of them.
      // One write-to-read transition for the whole frame instead of one per morph.
      const cpf = getRendererFeature('cpatch');
      if (cpf) cpf.flushCPatchBlends(R, gl);
      // beginFillPass binds every texture + uniform and then binds the cover-quad
      // VAO; rebind ours after it, so the state it sets up is shared verbatim.
      // In the UNIFIED scope, so it binds the program this stream was keyed for (fillPass
      // variantDefinesFor: a key that may leave out a cover kernel no row here reaches).
      R._uniScope = true;
      const savedAreaMode = R._uniCpAreaPass,
        savedVariant = R._uniCpAreaVariant;
      R._uniCpAreaPass = areaMode;
      R._uniCpAreaVariant = pinnedVariant;
      if (areaMode)
        R._lastFillVariantKey = pinnedVariant
          ? pinnedVariant.key
          : R._variantDefinesNow(bundle).sort().join('|');
      try {
        R.beginFillPass();
      } finally {
        R._uniScope = false;
        R._uniCpAreaPass = savedAreaMode;
        R._uniCpAreaVariant = savedVariant;
      }
      if (R._fillDeclined) {
        bailReason = 'variant-deferred';
        R.endFillPass();
        return false;
      }
      R.glBindVertexArray(v.vao);
      // The program must match the stream's layout in both directions. The checks below catch a stream with a
      // curve texture bound to a program without one; this catches the reverse, which draws silently wrong: a
      // curve-texture program (it declares uCurveCoefTex) over a WIDE stream reads a curve index that is not there.
      {
        const u0 = R._lastFillVariant && R._lastFillVariant.u;
        if (u0 && u0.uFillCurveCoef && !(cache.coef && cache.coef.tex)) {
          R._uniCurveTexBail = (R._uniCurveTexBail | 0) + 1;
          bailReason = 'curvetex-program-wide-stream';
          R.endFillPass();
          return false;
        }
      }
      if (cache.coef && cache.coef.tex) {
        const u = R._lastFillVariant && R._lastFillVariant.u;
        // No uCurveCoefTex means the bound program is NOT the curve-tex variant (still
        // linking, or a mismatch). Its vertices carry a curve INDEX where that program
        // expects coefficients, so drawing would read index floats as klmn — bail and
        // let the caller fall through, exactly as the morph check below does.
        if (!u || !u.uFillCurveCoef) {
          R._uniCurveTexBail = (R._uniCurveTexBail | 0) + 1;
          bailReason = 'no-curvetex-uniform';
          R.endFillPass();
          return false;
        }
        gl.activeTexture(gl.TEXTURE12);
        gl.bindTexture(gl.TEXTURE_2D, cache.coef.tex);
        if (R._fpU) R._fpU[12] = cache.coef.tex;
        gl.uniform1i(u.uFillCurveCoef, 12);
        gl.uniform1i(u.uFillCurveCoefW, cache.coef.w);
        parkActiveUnit();
      }
      if (isMorph) {
        const u = R._lastFillVariant && R._lastFillVariant.u;
        // No uMorphT means the bound program is NOT the morph variant (it is still
        // linking, or this bundle was misrouted). Drawing anyway would render the
        // t=0 endpoint every frame — a morph that silently does not move. Bail so
        // the caller falls through to the route that does.
        if (!u || !u.uFillMorphT) {
          bailReason = 'no-morph-uniform';
          R.endFillPass();
          return false;
        }
        // The segment's LOCAL t, not the global one: each segment blends across its
        // own sub-range, so feeding it the global t would run the whole morph inside
        // every segment.
        // The RUN's local t, not the bundle's: shapes disagree on segmentation, so
        // each run of agreeing shapes gets its own uniform. Falls back to the
        // cache-wide value for the whole-stream draw.
        const lt = localT === undefined ? cache.localT : localT;
        gl.uniform1f(u.uFillMorphT, lt);
        R._uniMorphTLast = lt; // what the shader actually got, per draw
      }
      // Depth ownership prevents overlapping pieces of one translucent shape
      // from compositing twice. Painter order still follows primitive order; later
      // shapes have nearer depth. Cap the depth range below the clear value.
      // Opaque draws skip the depth clear/test unless recoloring or overrides
      // can reduce alpha.
      const cm = R.draw.colorMatrix,
        co = R.draw.colorMatrixOffset;
      const alphaRecolor =
        !!(cm && (cm[3] !== 0 || cm[7] !== 0 || cm[11] !== 0 || cm[15] !== 1)) ||
        !!(co && co[3] !== 0);
      const drawTranslucent =
        (R.draw.alpha != null && R.draw.alpha > 0 && R.draw.alpha < 1) ||
        alphaRecolor ||
        !!(R.draw.overrides && R.draw.overrides.packedBuffer);

      const claim =
        R.opts.unifiedFillDepthClaim !== false &&
        (isMorph || drawTranslucent || bundleNeedsDepthClaim(bundle) || bundle._stripModeNow === 2);
      if (claim) {
        gl.depthRange(0.0, 0.99);
        // Consecutive split runs contain whole paints in the original order.
        // Shape depth strictly decreases across runs, so one claim buffer serves
        // the entire unchanged draw; it must not be reused across isolation/frames.
        if (!reuseDepth || !splitDepthCleared) {
          gl.clearDepth(1.0);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          if (reuseDepth) splitDepthCleared = true;
        }
        R.glEnable(gl.DEPTH_TEST);
        R.glDepthFunc(gl.LESS);
        R.glDepthMask(true);
      }
      gl.drawArrays(gl.TRIANGLES, first, count);
      if (areaMode && R._psoWarming && R._lastFillVariant) R._lastFillVariant.psoReady = true;
      if (areaMode && !R._psoWarming) {
        R._cpAreaSplitDraws = (R._cpAreaSplitDraws | 0) + 1;
        if (areaMode === 'area') R._cpAreaSplitAreaDraws = (R._cpAreaSplitAreaDraws | 0) + 1;
      }
      if (claim) {
        R.glDisable(gl.DEPTH_TEST);
        R.glDepthMask(false);
        gl.depthRange(0.0, 1.0);
      }
      // Not during a pipeline warm — that draw is 1px of scissor, not a frame, and
      // counting it would make the stat say the route ran when nothing was painted.
      if (!R._psoWarming) {
        R._unifiedFillDraws = (R._unifiedFillDraws | 0) + 1;
        if (R._engines) {
          if (spanEngines === null && (admissionToken || !primitivesAllowed)) {
            spanEngines = 0;
            if (first === 0 && count === cache.vertexCount) spanEngines = cache.engineMask;
            else {
              const end = first + count;
              let lo = 0,
                hi = cache.spanV.length;
              while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (cache.spanV[mid] + cache.spanN[mid] <= first) lo = mid + 1;
                else hi = mid;
              }
              for (let i = lo; i < cache.spanV.length && cache.spanV[i] < end; i++)
                spanEngines |= cache.spanEngine[i];
            }
            const cr = R._unifiedCoverRows(bundle);
            if (cr === 0) spanEngines &= ~SPAN_COVER;
            else if (spanEngines & SPAN_STROKE) {
              // Recoloring can give a stroke row a fill absent from its cached geometry mask.
              const rowClasses = R._unifiedRowClasses(bundle);
              const end = first + count;
              let lo = 0,
                hi = cache.spanV.length;
              while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (cache.spanV[mid] + cache.spanN[mid] <= first) lo = mid + 1;
                else hi = mid;
              }
              for (let i = lo; i < cache.spanV.length && cache.spanV[i] < end; i++) {
                if (!(cache.spanEngine[i] & SPAN_STROKE)) continue;
                const cls = rowClasses && rowClasses[cache.spanS[i]];
                if (!rowClasses || cls === ROW_COVER_AA || cls === ROW_COVER_HARD) {
                  spanEngines |= SPAN_COVER;
                  break;
                }
              }
            }
          }
          if (spanEngines !== null) {
            // This run carries only the entries accumulated by the split walk.
            // An area-only run cannot credit a later stroke/cover/SDF run.
            if (spanEngines & SPAN_CP) R._engines.drew(ENGINES.CPATCH, ROUTES.UNIFIED);
            if (spanEngines & SPAN_LB) R._engines.drew(ENGINES.LB, ROUTES.UNIFIED);
            if (spanEngines & SPAN_SDF) R._engines.drew(ENGINES.SDF, ROUTES.UNIFIED);
            if (spanEngines & SPAN_STROKE) R._engines.drew(ENGINES.STROKE, ROUTES.UNIFIED);
            if (spanEngines & SPAN_COVER)
              R._engines.drew(R._lastDrawnCoverKernel || ENGINES.SLUG, ROUTES.UNIFIED);
          } else {
            const cr = R._unifiedCoverRows(bundle);
            for (const e of enginesOfUnifiedDraw(
              bundle,
              R._lastDrawnCoverKernel || ENGINES.SLUG,
              cr < 0 ? undefined : cr > 0,
            ))
              R._engines.drew(e, ROUTES.UNIFIED);
          }
        }
      }
      R.endFillPass();
      drewAny = true;
      if (R._noteRowDraw && !R._psoWarming) R._noteRowDraw(bundle, 'unified');
      // The pin asked for CPatch and a row of this draw has no CPatch geometry, so it took its cover quad: the draw says so.
      // Where the row census cannot tell (-1, a posed CPatch morph), the stream it drew answers: a fill row's cover entry.
      if (R._engines && !R._psoWarming && R.opts.cpatchFill === true && bundle._cpatchBuilt) {
        const cr = R._unifiedCoverRows(bundle);
        if (cr < 0 ? cache.engineMask & SPAN_COVER : cr & 3)
          R._engines.declined(ENGINES.CPATCH, DECLINE.UNSUPPORTED);
      }
      return true;
    };

    const areaFlags = cache.spanArea;
    const splitEligible =
      R.opts.cpatchAreaSplit !== false &&
      mantleDebugHook('__CP_AREA_SPLIT') !== false &&
      !isMorph &&
      !cpatchPosed &&
      morphT == null &&
      !!areaFlags &&
      R._cpatchAreaSplitReady &&
      areaFlags.some((x, i) => x === 1 && cache.spanN[i] > 0) &&
      areaFlags.some((x, i) => x === 0 && cache.spanN[i] > 0);
    const splitVariants = splitEligible && !R._psoWarming ? R._cpatchAreaSplitReady(bundle) : null;
    const split = splitEligible && (R._psoWarming || !!splitVariants);
    const drawAreaSplit = (first, count, localT) => {
      if (!split || count <= 0) return drawSpan(first, count, localT);
      // A new epoch per range: the programs' bound uniforms are only reused inside ONE unbroken range (an isolation or a
      // group composite between ranges rebinds units under them), and one depth claim serves the runs of a range.
      R._cpAreaSplitEpoch = (R._cpAreaSplitEpoch || 0) + 1;
      splitDepthCleared = false;
      const end = first + count,
        spanV = cache.spanV,
        spanN = cache.spanN,
        spanS = cache.spanS;
      const rowClasses = R._unifiedRowClasses(bundle);
      // The entries are in vertex order: find the first one reaching the range.
      let lo0 = 0,
        hi0 = spanV.length;
      while (lo0 < hi0) {
        const m = (lo0 + hi0) >> 1;
        if (spanV[m] + spanN[m] <= first) lo0 = m + 1;
        else hi0 = m;
      }
      let rFirst = -1,
        rCount = 0,
        mode = null,
        spanEngines = 0;
      const flush = () =>
        rCount <= 0 ||
        drawSpan(
          rFirst,
          rCount,
          localT,
          mode,
          splitVariants ? splitVariants[mode] : null,
          true,
          spanEngines,
        );
      for (let i = lo0; i < spanN.length; i++) {
        if (spanV[i] >= end) break;
        const lo = Math.max(first, spanV[i]),
          hi = Math.min(end, spanV[i] + spanN[i]);
        if (hi <= lo) continue;
        const next = areaFlags[i] ? 'area' : 'seam';
        if (rCount && next !== mode) {
          if (!flush()) return false;
          rCount = 0;
        }
        if (!rCount) {
          rFirst = lo;
          mode = next;
          spanEngines = 0;
        }
        const geometry = cache.spanEngine[i];
        spanEngines |= geometry & ~SPAN_COVER;
        if (geometry & (SPAN_COVER | SPAN_STROKE)) {
          const cls = rowClasses && rowClasses[spanS[i]];
          if (!rowClasses || cls === ROW_COVER_AA || cls === ROW_COVER_HARD)
            spanEngines |= SPAN_COVER;
        }
        rCount += hi - lo;
      }
      return flush();
    };

    const drawSplit = (first, count, localT) => {
      if (!bundle._drawOrder || count <= 0) return drawAreaSplit(first, count, localT);
      // Stable resource addresses can differ from scene painter order. A depth
      // claim uses the row index, so restart it whenever that index decreases.
      const end = first + count;
      let start = first,
        previous = -1;
      for (let i = 0; i < cache.spanN.length; i++) {
        const lo = Math.max(first, cache.spanV[i]),
          hi = Math.min(end, cache.spanV[i] + cache.spanN[i]);
        if (hi <= lo) continue;
        const row = cache.spanS[i];
        if (row < previous) {
          if (!drawAreaSplit(start, lo - start, localT)) return false;
          start = lo;
        }
        previous = row;
      }
      return drawAreaSplit(start, end - start, localT);
    };

    // Tells the morph caller whether setT still has to lerp the curve texture.
    R._unifiedFillUsedCover = !!cache.cover;

    const sr = R.draw.shapeRange;
    const rLo = sr ? sr[0] | 0 : 0,
      rHi = sr ? sr[1] | 0 : 0;
    // The common path is unchanged: nothing isolated and no subset, so the span is
    // the whole stream and this is the same single drawArrays it has always been.
    // A morph whose entries disagree on local t cannot take the single-draw fast
    // path: one uniform cannot serve two values. Cheap check, cached shape.
    // The local t for entry i, derived from its segment's blend RANGE and the
    // current global t. The range is static for the cached segment set; the t is
    // not, so resolving it at draw time is what keeps a reused cache from freezing
    // the morph (baking the resolved t is exactly what did freeze it).
    const localTOf = (i) => {
      if (!cache.spanLo) return cache.localT;
      const lo = cache.spanLo[i],
        span = cache.spanHi[i] - lo;
      return span > 1e-9 ? (morphT - lo) / span : 0;
    };
    let uniformT = true;
    if (isMorph && cache.spanLo) {
      for (let i = 1; i < cache.spanLo.length; i++) {
        if (cache.spanLo[i] !== cache.spanLo[0] || cache.spanHi[i] !== cache.spanHi[0]) {
          uniformT = false;
          break;
        }
      }
      if (uniformT && cache.spanLo.length) cache.localT = localTOf(0);
    }
    if (!cache.filters && !cache.groups && !cache.blends && !cache.colrs && !sr && uniformT) {
      const trim = visibleTrimSpan(R, bundle, cache, isMorph);
      const tFirst = trim ? trim.first : 0;
      const tCount = trim ? trim.count : cache.vertexCount;
      if (trim) R._viewCullTrimmed = (R._viewCullTrimmed | 0) + (cache.vertexCount - tCount);
      if (drawSplit(tFirst, tCount, undefined)) return true;
      R._unifiedFillGate = bailReason || 'span-bail';
      return false;
    }

    // Walk the entries in painter order, batching every run of consecutive
    // drawable ones into a single draw and breaking the run for anything that
    // cannot join it — a shape outside the sprite range (skipped), or a shape that
    // needs its own isolation target (drawn there).
    //
    // The interruption is what Slug's drawList loop already does: renderer.js
    // flushes its pending batch, renders the one shape into an FBO, filters it and
    // composites it back. The only difference here is that the isolated render is a
    // RANGE of this same buffer instead of a cover chunk.
    //
    const spanV = cache.spanV,
      spanN = cache.spanN,
      spanS = cache.spanS;
    let runStart = -1,
      runCount = 0,
      runT = 0,
      ok = true;
    // The group depth this walk started at: a bail below closes every group the walk opened.
    // Normally 0 -- groups are per bundle -- but recorded, not assumed.
    const groupDepth0 = R._groupDepth ? R._groupDepth() : 0;
    const flushRun = () => {
      if (runCount <= 0) return true;
      const drew = drawSplit(runStart, runCount, runT);
      runCount = 0;
      return drew;
    };
    for (let i = 0; i < spanN.length; i++) {
      //
      // Group brackets are NOT subject to the sprite-range filter, for the same
      // reason renderer.js keeps them ahead of its own range check: a sprite that
      // contains a nested group still has to composite it. A filtered group with nothing of the sprite in it is stepped over, as there.
      const g = cache.groups && cache.groups.get(i);
      if (g && g.begin && sr && R._groupOutsideDraw(bundle, g.op)) {
        for (let gd = 1, gi = i + 1; gi < spanN.length; gi++) {
          const h = cache.groups.get(gi);
          if (!h) continue;
          if (h.begin) gd++;
          else if (--gd === 0) {
            i = gi;
            break;
          }
        }
        continue;
      }
      if (g) {
        if (R._mergeSkip && R._mergeSkip()) {
          R._uniGroupBrackets = (R._uniGroupBrackets | 0) + 1;
          continue;
        } // inside a merged run: one draw for every group's leaves
        if (!flushRun()) {
          ok = false;
          break;
        }
        R.endFillPass(); // the helpers own the framebuffer across the bracket
        if (g.begin) {
          if (R._groupBegin(g.op, g.gOps)) {
            // the group's cached filter result stands in for its children: step to its end bracket
            for (let gd = 1, gi = i + 1; gi < spanN.length; gi++) {
              const h = cache.groups.get(gi);
              if (!h) continue;
              if (h.begin) gd++;
              else if (--gd === 0) {
                i = gi - 1;
                break;
              }
            }
          }
        } else {
          // A filtered group is a filtered draw of this route: its graph (or the cached result of it) is composited here.
          R._groupEndUnified = true;
          try {
            R._groupEnd();
          } finally {
            R._groupEndUnified = false;
          }
          if (R._groupEndFiltered) R._uniFilterDraws = (R._uniFilterDraws | 0) + 1;
        }
        R._uniGroupBrackets = (R._uniGroupBrackets | 0) + 1;
        continue;
      }
      if (spanN[i] <= 0) continue;
      // Out of the sprite subset: break the run, because the ranges either side of
      // a skipped entry no longer abut.
      if (sr && (spanS[i] < rLo || spanS[i] > rHi)) {
        if (!flushRun()) {
          ok = false;
          break;
        }
        continue;
      }
      // A COLRv1 GLYPH. Its paint graph renders the silhouette and composites the
      // color layers itself, so the walk simply steps aside for it.
      const cl = cache.colrs && cache.colrs.get(i);
      if (cl) {
        if (!flushRun()) {
          ok = false;
          break;
        }
        R.endFillPass();
        R._colrLeaf(cl);
        R._uniColrLeaves = (R._uniColrLeaves | 0) + 1;
        continue;
      }
      // A blend leaf. Same interruption as a filter: isolate, render this one
      // shape's range into the isolated target, composite back with the blend
      // equation. Checked before the filter so a shape carrying both takes the
      // blend path, which is the order renderer.js's loop uses.
      const bl = cache.blends && cache.blends.get(i);
      if (bl) {
        if (!flushRun()) {
          ok = false;
          break;
        }
        const iv = spanV[i],
          ic = spanN[i];
        const it = isMorph ? localTOf(i) : undefined;
        R._blendLeaf(bl, () => drawSplit(iv, ic, it));
        R._uniBlendLeaves = (R._uniBlendLeaves | 0) + 1;
        // A bail INSIDE the leaf's source render is a bail like any other: the program cannot draw
        // this stream. Ignored, it left a leaf-only (or leaf-last) group reporting success with
        // nothing painted and no fallback to paint it.
        if (bailReason) {
          ok = false;
          break;
        }
        continue;
      }
      const f = cache.filters && cache.filters.get(i);
      if (!f) {
        // Break the run when the morph t changes — one uniform, one value.
        const t = isMorph ? localTOf(i) : 0;
        if (runCount > 0 && t !== runT) {
          if (!flushRun()) {
            ok = false;
            break;
          }
        }
        if (runCount === 0) {
          runStart = spanV[i];
          runT = t;
        }
        runCount += spanN[i]; // consecutive spans abut: one range
        continue;
      }
      if (!flushRun()) {
        ok = false;
        break;
      }
      // Render filtered sources through their selected geometry route. Static
      // filter results can reuse the existing filter cache; morphs remain uncached.
      // Store only after an actual unified draw, since an asynchronously linking
      // program can report route success before it paints. Disable result reuse
      // with unifiedFilterCache:false.
      const fOwner =
        (R._handle && R._handle.bundle === bundle && R._handle._filterCacheOwner) ||
        'b' + bundle.uid;
      // Filter results also depend on mesh adoption and the selected engine.
      const cacheId =
        isMorph || R.opts.unifiedFilterCache === false
          ? null
          : filterCacheId(fOwner, gen, adoptKey, f.filterId, spanS[i]);
      // Resolve the current graph at draw time: parameter writes replace graph
      // objects without changing geometry.
      const fGraph = entryFilterGraph(bundle, f);
      const done = R._morphShapeFilter(
        bundle,
        spanS[i],
        f.filterId,
        fGraph,
        () => drawSplit(spanV[i], spanN[i], isMorph ? localTOf(i) : undefined),
        cacheId,
      );
      if (!done) {
        // The isolation step itself failed (a zero-sized viewport is the only way
        // it reports this). Drawing the shape unfiltered here would be silently
        // wrong, so leave it unpainted rather than wrong, and say so.
        R._uniFilterIsolateFail = (R._uniFilterIsolateFail | 0) + 1;
      }
      R._uniFilterDraws = (R._uniFilterDraws | 0) + 1;
      if (bailReason) {
        ok = false;
        break;
      } // the source render bailed: as for a blend leaf
    }
    if (ok && !flushRun()) ok = false;
    // the walk's last slot-group composites (a run of plain groups defers them to here, renderer.js R._atlasFlush)
    if (R._atlasFlush) R._atlasFlush();
    if (ok) return true;
    // A span bail is a property of the BOUND PROGRAM, not of the span, so it can
    // only fire on the first one — before anything is painted. If it somehow fires
    // later the frame is already half-drawn, and returning false would make the
    // caller paint the whole bundle again through the classic route, on top. Report
    // success in that case and count it: a double-paint is far worse than the one
    // missing shape, and the counter is how this gets noticed rather than guessed.
    R._unifiedFillGate = bailReason || 'span-bail';

    if (!drewAny) {
      if (R._groupUnwind) R._groupUnwind(groupDepth0, false);
      return false;
    }
    if (R._groupUnwind) R._groupUnwind(groupDepth0, true);
    R._uniPartialSpanBail = (R._uniPartialSpanBail | 0) + 1;
    return true;
  };

  function staticStreamGrowth(ledger, prior, vertexBytes, morph, coef, planeGrowth) {
    const reuse =
      prior &&
      prior.morph === morph &&
      !!prior.coef === !!coef &&
      !!(prior.coef && prior.coef.idx32) === !!(coef && coef.idx32);
    const priorBufferBytes = ledger.bytesOf(prior && prior.glo && prior.glo.buf);
    const releasedTextureBytes = ledger.bytesOf(prior && prior.coef && prior.coef.tex);
    const releasedBufferBytes = reuse ? 0 : priorBufferBytes;
    const vertexDelta = vertexBytes - (reuse ? priorBufferBytes : 0);
    const coefficientBytes = coef && coef.data ? coef.data.byteLength : 0;
    // Plane growth precedes release; texture upload precedes VBO replacement.
    const afterRelease = planeGrowth - releasedTextureBytes - releasedBufferBytes;
    return Math.max(
      0,
      planeGrowth,
      afterRelease + coefficientBytes,
      afterRelease + coefficientBytes + vertexDelta,
    );
  }
  function admitStaticCPatchStream(bundle, meshes, planeGrowth) {
    const ledger = peekLedger(gl);
    if (!ledger || !(ledger.budget() < Infinity)) return true;
    const entries = entriesFor(bundle, false, 0, meshes);
    if (!entries) return ledger.admit(planeGrowth, 'CPatch plane');
    const cover = bundle.coverQuadVboFloats || bundle.coverQuadFloats;
    const indices = bundle.hybridShapeIdxVboFloats || bundle.hybridShapeIdxFloats;
    let narrow = curveTex && !bundle._noCurveTex;
    let built = narrow
      ? buildUnifiedFillVertsNarrow(entries, cover, indices, false)
      : buildUnifiedFillVerts(entries, cover, indices, false);
    if (built.overflow) {
      narrow = false;
      built = buildUnifiedFillVerts(entries, cover, indices, false);
    }
    if (padFloats > 0) inflateStream(built, false);
    const coef = narrow ? { data: built.coefData, idx32: built.idx32 } : null;
    const prospective = staticStreamGrowth(
      ledger,
      bundle._unifiedFill,
      built.verts.byteLength,
      false,
      coef,
      planeGrowth,
    );
    return ledger.admit(prospective, 'CPatch plane');
  }
  /// CPatch build, published here so morphDraw's prepareBundle can reach it
  /// without importing the converter into the draw path.
  const customCoverage = /^MANTLE_(?:AAC|HARD(?:_.*)?|GWN)$/;
  R._preparedCPatchRequested = (bundle) =>
    !!bundle &&
    (R.opts.cpatchFill === true ||
      (R.opts.cpatchAuto === true && R._lbFillMode === 'auto' && !bundle._morphSrc)) &&
    !engineSelection(R).forceSlug &&
    !bundle._lbStream;
  const preparedRefusal = () => {
    if (R.opts.fillDefines && R.opts.fillDefines.some((define) => customCoverage.test(define)))
      return 'custom-coverage-defines';
    const settings = R.opts.cpatchOpts || {};
    if (
      (mantleDebugHook('__CP_GRID') ?? settings.grid ?? 1) !== 1 ||
      mantleDebugHook('__CP_NO_AREA') === 1 ||
      mantleDebugHook('__CP_NO_CYCLE_AREA')
    )
      return 'requested-cpatch-layout';
    if (settings.record || settings.follow || settings.traces || settings.traceOut)
      return 'requested-cpatch-tape';
    return null;
  };
  R._preparedCPatchWanted = (bundle) => R._preparedCPatchRequested(bundle) && !preparedRefusal();
  R._buildCPatchBundle = (bundle, extraOpts) => {
    if (R._preparedCPatchRequested(bundle) && !R._preparedCPatchWanted(bundle)) {
      bundle._cpPreparedRefusal = preparedRefusal();
      return false;
    }
    const prepared = R._preparedCPatchWanted(bundle);
    if (prepared && bundle._morphSrc) {
      bundle._cpPreparedRefusal = 'moving-interval-uncertified';
      return false;
    }
    const settings = R.opts.cpatchOpts || {};
    // Auto preparation may skip paints that an explicit CPatch pin must build.
    const key = [
      extraOpts?.autoPolicy === true,
      !!settings.record,
      !!settings.follow,
      !!settings.traces,
      !!settings.traceOut,
      !!bundle._cpatchTraces,
    ].join('|');
    if (
      prepared &&
      bundle._cpPreparedTerminalGen === (bundle._geomGen | 0) &&
      bundle._cpPreparedTerminalKey === key
    )
      return false;
    return requireRendererFeature('cpatch', 'the CPatch fill').buildCPatchBundle(gl, bundle, {
      ...(R.opts.cpatchOpts || {}),
      ...extraOpts,
      admitStaticStream: admitStaticCPatchStream,
      ...(prepared ? { _preparedStaticProgram: true, _preparedStaticKey: key, pool: false } : {}),
    });
  };
  const preparedDrawStates = new WeakMap();
  R._preparedCPatchState = (bundle) => {
    const state = preparedDrawStates.get(bundle);
    return state &&
      !state.none &&
      state.meshes === bundle._lbMeshes &&
      state.gen === (bundle._geomGen | 0)
      ? state
      : null;
  };
  R._applyPreparedCPatchDrawState = (bundle) => {
    const meshes = bundle._lbMeshes;
    if (!bundle._cpPreparedHasCandidate || !meshes || bundle._morphSrc) {
      preparedDrawStates.delete(bundle);
      return;
    }
    let state = preparedDrawStates.get(bundle);
    if (!state || state.meshes !== meshes || state.gen !== (bundle._geomGen | 0)) {
      // A shared bundle may change mesh owner. Cache an ordinary LB/primitive
      // list once; its existing picks and transform rules remain authoritative.
      if (!meshes.some((mesh) => mesh?.cpatch)) {
        preparedDrawStates.set(bundle, { meshes, gen: bundle._geomGen | 0, none: true });
        return;
      }
    } else if (state.none) {
      return;
    }
    if (
      !state ||
      state.meshes !== meshes ||
      state.gen !== (bundle._geomGen | 0) ||
      state.drawList !== bundle.drawList ||
      state.filterGraphs !== bundle.filterGraphs
    ) {
      state = {
        meshes,
        gen: bundle._geomGen | 0,
        mask: new Uint8Array(meshes.length),
        token: {},
        support: [Infinity, Infinity],
      };
      state.inputKey = new Float64Array(15);
      state.hasKey = false;
      state.matrixOptions = { worldMatrix: null };
      state.hasSpatial = meshes.some(
        (mesh) => mesh?._cpAdmission?.kind === 'spatial-static-polynomial',
      );
      state.drawList = bundle.drawList;
      state.filterGraphs = bundle.filterGraphs;
      state.hasIsolatedFilters =
        !!bundle.filterGraphs?.length ||
        !!bundle.drawList?.some((op) => op.filterId || op.filterGraphId);
      preparedDrawStates.set(bundle, state);
    }
    const wanted = R._preparedCPatchWanted(bundle);
    const captureUncertified =
      state.hasIsolatedFilters || !!(R._filterFrameTop && R._filterFrameTop());
    const viewport = R.viewportSize(),
      box = bundle.globalBBox,
      world = R.draw.worldM;
    const hasWorld = !!(world && world.length >= 9);
    let same =
      state.hasKey &&
      state.wanted === wanted &&
      state.captureUncertified === captureUncertified &&
      state.hasWorld === hasWorld;
    if (same)
      for (let i = 0; i < 2; i++)
        if (!Object.is(viewport[i], state.inputKey[i])) {
          same = false;
          break;
        }
    if (same)
      for (let i = 0; i < 4; i++)
        if (!Object.is(box?.[i] ?? NaN, state.inputKey[i + 2])) {
          same = false;
          break;
        }
    if (same && hasWorld)
      for (let i = 0; i < 9; i++)
        if (!Object.is(world[i], state.inputKey[i + 6])) {
          same = false;
          break;
        }
    if (same) return;
    state.hasKey = true;
    state.wanted = wanted;
    state.captureUncertified = captureUncertified;
    state.hasWorld = hasWorld;
    for (let i = 0; i < 2; i++) state.inputKey[i] = viewport[i];
    for (let i = 0; i < 4; i++) state.inputKey[i + 2] = box?.[i] ?? NaN;
    if (hasWorld) for (let i = 0; i < 9; i++) state.inputKey[i + 6] = world[i];
    state.matrixOptions.worldMatrix = world;
    const matrix =
      !wanted || captureUncertified || !state.hasSpatial
        ? null
        : R.bundleDrawMatrix(bundle, state.matrixOptions);
    let supportX = Infinity,
      supportY = Infinity;
    if (
      matrix &&
      matrix[2] === 0 &&
      matrix[5] === 0 &&
      matrix[8] === 1 &&
      matrix.every(Number.isFinite)
    ) {
      const determinant = matrix[0] * matrix[4] - matrix[1] * matrix[3];
      if (Number.isFinite(determinant) && determinant !== 0) {
        supportX = (Math.abs(matrix[4]) + Math.abs(matrix[3])) / Math.abs(determinant);
        supportY = (Math.abs(matrix[1]) + Math.abs(matrix[0])) / Math.abs(determinant);
      }
    }
    let changed = false;
    for (let row = 0; row < meshes.length; row++) {
      const mesh = meshes[row],
        admission = mesh?._cpAdmission;
      // Only CPatch geometry needs this certificate. Ordinary analytic meshes
      // retain the existing primitive, per-shape policy and override gates.
      const accepted =
        !mesh?.cpatch ||
        !!(
          wanted &&
          admission &&
          (admission.kind === 'native-whole-area' ||
            (!captureUncertified &&
              supportX <= admission.support[0] &&
              supportY <= admission.support[1]))
        );
      if (state.mask[row] !== +accepted) {
        state.mask[row] = +accepted;
        changed = true;
      }
    }
    if (changed) state.token = {};
    state.support[0] = supportX;
    state.support[1] = supportY;
  };
  // A morph cannot use the static builder: that converts, and a conversion per frame is
  // milliseconds to seconds. This plans once and rewrites the coefficients for the current t.
  const nativeMorphFrames = new WeakMap();
  R._preparedNativeMorphReady = (bundle) => {
    const state = nativeMorphFrames.get(bundle);
    return !!(
      state &&
      state.accepted &&
      state.plan === bundle._cpatchMorphPlan &&
      state.t === (bundle._morphSrc.t || 0) &&
      state.gen === (bundle._geomGen | 0) &&
      state.meshes === bundle._lbMeshes &&
      state.meshes === bundle._cpatchMeshRef &&
      bundle._fillMeshOwner === 'cpatch' &&
      (bundle._cpatchBuilt | 0) > 0
    );
  };
  R._cpatchMorphFrame = (bundle) => {
    if (R._preparedCPatchRequested(bundle) && !R._preparedCPatchWanted(bundle)) {
      bundle._cpPreparedRefusal = preparedRefusal();
      const ms = bundle._morphSrc,
        resume = ms.skipUploads || ms.skipCurveUploads;
      ms.skipUploads = false;
      ms.skipCurveUploads = false;
      if (resume && typeof ms.relerp === 'function') ms.relerp();
      return false;
    }
    const prepared = R._preparedCPatchWanted(bundle);
    if (prepared && bundle._morphSrc.skipUploads) {
      bundle._morphSrc.skipUploads = false;
      if (typeof bundle._morphSrc.relerp === 'function') bundle._morphSrc.relerp();
    }
    const accepted = requireRendererFeature('cpatch', 'the CPatch morph').applyCPatchMorphFrame(
      gl,
      bundle,
      { ...(R.opts.cpatchOpts || {}), ...(prepared ? { nativeAreaOnly: true } : {}) },
      R,
    );
    if (prepared) {
      let state = nativeMorphFrames.get(bundle);
      if (!state) {
        state = {};
        nativeMorphFrames.set(bundle, state);
      }
      state.accepted = accepted;
      state.meshes = bundle._lbMeshes;
      state.gen = bundle._geomGen | 0;
      state.plan = bundle._cpatchMorphPlan;
      state.t = bundle._morphSrc.t || 0;
      if (!accepted) {
        bundle._cpPreparedRefusal = 'moving-interval-uncertified';
        const ms = bundle._morphSrc,
          resume = ms.skipUploads || ms.skipCurveUploads;
        ms.skipUploads = false;
        ms.skipCurveUploads = false;
        if (resume && typeof ms.relerp === 'function') ms.relerp();
      } else bundle._cpPreparedRefusal = null;
    }
    return accepted;
  };

  // Expose the actual painter-ordered entries for route diagnostics.
  R._unifiedFillEntriesFor = (bundle, morph = false, morphT = 0) =>
    entriesFor(bundle, morph, morphT);

  // Nothing renderer-wide to free: each stream's vertex array, buffer and coefficient texture live on its bundle's cache and
  // go with bundle.dispose(). Kept so existing callers need no change.
  R._disposeUnifiedFill = () => {};
}
