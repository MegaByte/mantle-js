#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// runRenderSmokes.mjs — the RENDER gate. Curated puppeteer smokes that exercise
// the renderer modules at runtime (shaderPrograms, drawImages, instancedFill,
// morphDraw, drawSprites, cacheDraw, staticCache).
//
// Catches silent wrong-pixel defects that the static contract smoke in
// runSmokes can't. Needs a browser (puppeteer + chrome) → run it in the
// browser-capable CI stage, not the fast unit lane.
//
// Each entry is chosen to touch a distinct module; keep it small so it stays
// runnable. Add coverage as modules grow.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { snapshot as gitSnapshot, newlyDirty, reportLeaks } from './trackedClean.mjs';
import { startSharedBrowsers } from './sharedBrowsers.mjs';
import {
  PROFILE_ROOT_ENV,
  createLaneRoot,
  orphanBrowserPids,
  removeAbandonedLaneRoots,
} from './laneProfiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Validation reads committed fixtures; generation is an explicit maintenance step.
const GIT_BEFORE = gitSnapshot(ROOT);

const SMOKES = [
  'test/primDeepZoomRenderSmoke.mjs', // a tagged circle or round rect stays filled past the arc walk's float32 bound, under it the default draws the walk, and a pin keeps the walk; an untagged native arc stays filled at deep zoom under the walk (ellipse, path of arcs, gradient circle, rotated map, pinned kernels)
  'test/pinnedEngineDeclineRenderSmoke.mjs', // a pinned engine draws, or the ledger says why not: CPatch's cost gate past the canvas, hard-tree without its tree
  'test/spriteOtherGroupRenderSmoke.mjs', // a sprite draw paints that sprite and no filtered group of another one: each draw entry, opaque and faded, cover and unified route
  'test/spriteFilterAlphaRenderSmoke.mjs', // a faded sprite, timeline frame or instance batch that paints through a filtered group is not cut at its leaves; a sprite with no filter keeps its bound
  'test/groupFilterRectRenderSmoke.mjs', // a static cache of a bundle holding a filtered group draws what the live draw does: a blur, a flood, an image past the children; the blit is sized to the filter region
  'test/memoryBudgetRenderSmoke.mjs', // memory budget on a real GL context: ledger == page-level spy; a budget that refuses the atlas and evicts caches renders the unbudgeted pixels
  // Curved strokes must not crack open at their joins: the two segments' join
  // half-planes tile the plane only when the tangents are parallel, so any tangent
  // break leaves an unclaimed wedge. An LB-vs-Slug comparison cannot see it when both engines share it.
  'test/pageReadySmoke.mjs', // _pageReady: late flag waited for; a never-ready page fails with a diagnostic
  'test/strokeJoinHairlineRenderSmoke.mjs',
  'test/bundleDisposeReleasesHandleRenderSmoke.mjs', // renderer: bundle.dispose() frees the transient handle's buffers, filter results and the bundle itself
  'test/lifecycleRealContextRenderSmoke.mjs', // renderer: a real WEBGL_lose_context loss + restore fails loudly and a recreate draws; native fallback on a lost context; disposed owners; loss-window noise; sticky getError; resolution scale; after dispose() a late frame, prepare and createImage allocate nothing and createBundleHandle refuses
  'test/scaleRangeRenderSmoke.mjs', // bbox gradient, blur, radial, filter region, huge miterlimit, sub-pixel pattern tile and sub-ulp gradient vector at 2^-36..2^28 vs the scale-1 control
  // test/originRenderSmoke.mjs in thirteen parts, each in its own browser so they spread across the workers: a bundle ORIGIN
  // (coordinates stored relative to it). Every corpus SVG under a forced origin equals the origin-free picture (ten parts of
  // 100 assets); far cells (1e4..1e7, 2^-10..2^10) equal offset 0 and Chrome 8x (one part per engine: slug, aac, lb).
  'test/originRenderCorpus1Smoke.mjs',
  'test/originRenderCorpus2Smoke.mjs',
  'test/originRenderCorpus3Smoke.mjs',
  'test/originRenderCorpus4Smoke.mjs',
  'test/originRenderCorpus5Smoke.mjs',
  'test/originRenderCorpus6Smoke.mjs',
  'test/originRenderCorpus7Smoke.mjs',
  'test/originRenderCorpus8Smoke.mjs',
  'test/originRenderCorpus9Smoke.mjs',
  'test/originRenderCorpus10Smoke.mjs',
  'test/originRenderCells1Smoke.mjs',
  'test/originRenderCells2Smoke.mjs',
  'test/originRenderCells3Smoke.mjs',
  'test/obbGradientRowsRenderSmoke.mjs', // objectBoundingBox gradients on turned/skewed squares render as their chunked controls past 2048 gradient rows
  'test/deviceLimitPlanesRenderSmoke.mjs', // mask layer array, incremental stroke prim texture and CPatch plane vs a simulated small device
  'test/textureRowLimitsRenderSmoke.mjs', // renderer: per-item tables (meta, gradient, dash, filter, override, mask row) wrap in 4096-row bands; simulated 4096/8192 devices; over-capacity throws
  'test/filterResultRecycleRenderSmoke.mjs', // renderer: a cached result that outgrew its texture leaves no deleted pair on the free list: no GL error, the next entry of that size draws
  'test/filterPoolTrimRenderSmoke.mjs', // renderer: alternating filtered scenes never lose scratch; an idle renderer frees it one target per frame; pixels unchanged
  'test/staticCacheDepthReleaseRenderSmoke.mjs', // cacheDraw: a baked static cache frees its depth/stencil renderbuffer, a rebake re-attaches one, pixels unchanged
  'test/strokeInkFitRenderSmoke.mjs', // a fit-to-content view does not crop a miter tip or a diagonal square cap corner
  'test/lbStreamOvershootRenderSmoke.mjs', // streamGeometry: a road band whose edge curve overshoots its far cap draws, against the exact kernel, at the road's scale and past it
  'test/arcsJoinRenderSmoke.mjs', // stroke: SVG2 arcs line join (curved vs round/miter)
  'test/dashStrokeParitySmoke.mjs', // stroke: DASHED strokes vs Slug on the analytic route (deleting the stroke coverage RT left this path untested)
  'test/loopBlinnRenderDiffSmoke.mjs', // morphDraw: LB direct + route, and LB vs Slug per feature: blend, filter, text, stroke, recolor, mask, clip, transform override, image and gradient batches, compose order, per-shape fallback, loops
  'test/leanShaderRenderDiffSmoke.mjs', // shaderPrograms: lean fill variants
  'test/variantFirstDefaultSmoke.mjs', // variantFirst is the default -- the first frame of every engine/route class (and later-appearing features, morphs, streams, sprites, instances) equals the settled picture, with an A/A control
  'test/instancedLeanFirstSmoke.mjs', // the first instanced draw uses the bundle's lean program (default), the opt-out the general one
  'test/instancedAsyncPixelGpuSmoke.mjs', // the frame drawn while the instanced specialization links equals the specialized frame (A/A control)
  'test/maskCodeSolidParityRenderSmoke.mjs', // carrying the optional mask code leaves solid pixels byte-identical (every program compiled fresh in both arms)
  'test/fillNormalizePolynomialGpuSmoke.mjs', // coverage-only fill normalization vs exact area: raw AAC and Slug, and the aac@points route
  'test/cpatchCubicAreaGpuSmoke.mjs',
  // The ordered area/seam split draws every scope of the unified stream and is the combined program's picture.
  'test/cpatchSplitScopesGpuSmoke.mjs', // ...and its actual area/primitive/stroke run attribution and warming parity
  'test/fillNormalizeArcsGpuSmoke.mjs', // native-arc coverage normalization: raw AAC and Slug vs the exact area, physical GPU
  'test/fillNormalizeArcsPointsGpuSmoke.mjs',
  'test/aacFillParitySmoke.mjs', // AAC: analytic-area fill vs Slug (line/quad/cubic/arc)
  'test/rowEnginesGpuSmoke.mjs', // per-row engines in debugStats.rowEngines; same hash and pixels on any page and scale history
  'test/aacCoverRunGpuSmoke.mjs', // the row gate's cover run draws the AAC cover pass in painter order and matches its pinned twin
  'test/aacPointsRowGateDefaultSmoke.mjs', // default-on: the row gate takes dens-like content in a default renderer; options and pins override
  'test/aacPointsColorMatrixGpuSmoke.mjs', // a draw's colorMatrix is painted by the point route; a growing sprite (bucketed lists) matches its cover twin
  'test/aacPointsRouteSmoke.mjs', // AAC: small shapes take the vertex-stage point route and match the cover quads
  'test/aacPointsGenGpuSmoke.mjs', // the generated points (an entry table, the default) paint the uploaded lists' pixels byte for byte
  'test/aacPointsWarmGpuSmoke.mjs', // loading: actual point program warms before its first visible draw
  'test/aacPointsSubbyteGpuSmoke.mjs', // faint point paints accumulate at RGBA8 precision for every curve type
  'test/aacCoverSubbyteGpuSmoke.mjs', // raw fallback: faint ordered paints and translucent changing morphs
  'test/drawImageSmoke.mjs', // drawImages: createImage/drawImage opts
  'test/nestedClipIntersectSmoke.mjs', // nested clip-path intersects (SVG 1.1 §14.3)
  'test/groupAtlasRenderSmoke.mjs', // the group atlas draws the byte-identical picture of the per-group accumulators (9 cells x four engines) and matches Chrome 8x
  'test/groupFilterSkipRenderSmoke.mjs', // a filtered group served from its cached result without repainting its children draws what the repainting group draws (balanced OFF/ON arms with an A/A floor)
  'test/alphaSlotRenderSmoke.mjs', // faded instances that touch, each in a slot of the atlas and drawn together, paint what the layered accumulators paint (balanced OFF/ON arms with an A/A floor)
  'test/morphInvisibleOverrideRenderSmoke.mjs', // revealed invisible fills follow prepared morph geometry
  'test/groupAlphaRenderSmoke.mjs', // a draw's alpha is GROUP opacity: svg/control/old cells under four engines vs Chrome 8x box; instanced, loop, submit, handle and morph vs a hand fade; one paint-only leaf identical
  'test/zOrderSubmitSmoke.mjs', // frameLoop: submitBundle zOrder stacking + tiebreak
  'test/fillRouteParityGpuSmoke.mjs', // fill route class: static art on the cover pass == unifiedFill:false pixel for pixel; a morph keeps the unified GPU-lerp route and equals the forced unified render; the static source pose stays on the cover pass
  'test/coverQuadBatchSmoke.mjs', // renderer: header-free VBO batches multi-shape draws into one drawArrays
  'test/opaquePrepassSmoke.mjs', // renderer: opaque overlap HSR keeps analytic AA pixels identical
  'test/opaquePrepassShapeCountSmoke.mjs', // renderer: prepass vs ordinary fill byte-identical for every shape count 6..48 (a hollow flipbook frame: prepass/fill depth ulp mismatch)
  'test/bundleInstancedSmoke.mjs', // instancedFill: drawBundleInstanced; fast path == loop byte for byte, per-instance tint and fog, flat-tint alpha
  'test/forcedPinNoPrimitiveGpuSmoke.mjs', // engine pins: physical GPU, never a Node-lane check
  'test/instancedFillPinnedDefinesSmoke.mjs', // pinned LB defines must link and actually draw instances
  'test/spriteSheetSmoke.mjs', // drawSprites: drawSprite; sprite morph, a morph's forwarded clip, sprite timeline; a sprite SUBSET paints one sprite on the LB route too, not the whole sheet
  'test/staticCacheSmoke.mjs', // cacheDraw/staticCache: whole-asset + viewport-window bake/reuse and pan parity, per-handle and shared-group caches, demotion, filtered and LB bakes
  'test/glStateAuditSmoke.mjs', // glState: pipeline-state shadow never diverges from the driver
  'test/annulusStrokeSmoke.mjs', // stroked circle -> closed-form annulus, identical to the band walk
  'test/filterVisualSmoke.mjs', // shaderPrograms: fe* filter programs; filtered artwork never vanishes, shifts or escapes its group
  'test/filterOwnerPaintRenderSmoke.mjs', // static solid FillPaint/StrokePaint inputs: 304 states within 1 byte of an independently authored rectangle
  'test/filterCompositeBackdropSmoke.mjs', // a filtered shape composites once, and stays inside its (nested / blend) group on both routes, against Chrome
  'test/filterPixelFixRenderSmoke.mjs', // the audited filter primitives match Chrome: cells, blurs of sigma 12-100 on both routes, premultiplied feComposite arithmetic, cone-less feSpotLight
  'test/filterScaleRenderSmoke.mjs', // every filter length follows the referencing element's transform (group, element, <use>, CSS, override) at Chrome (8x)
  'test/fillCancelledWindingRenderSmoke.mjs', // paths whose winding cancels or whose hulls hold another subpath's fill, pinned Loop-Blinn and CPatch at Chrome (8x)
  'test/basicShapeClipRenderSmoke.mjs', // CSS basic-shape clip-path and nested-<svg> clip-path at Chrome (8x), both routes
  'test/filterSubregionRenderSmoke.mjs', // primitive subregions, primitiveUnits objectBoundingBox and CSS filter functions / lists at Chrome (8x), both routes
  'test/filterLinearRenderSmoke.mjs', // color-interpolation-filters (the linearRGB default, per-primitive spaces, mixed chains, sRGB CSS functions) at Chrome (8x), both routes
  'test/filterLinearBlurRenderSmoke.mjs', // a lone linearRGB blur is the in-place kind-7 record: byte-equal to the graph it replaced, within bounds of Chrome (8x), both routes
  'test/filterLinearPrecisionRenderSmoke.mjs', // linearRGB shadows and blurs of dark content keep the levels, steps and values of the sRGB picture (a dark ramp keeps 49 levels, not 9)
  'test/filterOwnerGradientRenderSmoke.mjs', // gradient FillPaint / StrokePaint (linear, radial, spreads, obb/user units, transforms) vs Chrome (the element itself, or an feImage of the paint), both routes, and at 2^-20 / 2^20 times the size
  'test/feImageOrientationRenderSmoke.mjs', // an id-referenced feImage draws the right way up (square and 2:1) and its meet fit uses the region's own aspect (2:1 and 1:2), both routes; an external feImage is fitted into its subregion and clipped to it; against Chrome
  'test/zeroValuedAttributeRenderSmoke.mjs', // zero opacity / stroke-width / lighting constants render as zero, both routes, against Chrome
  'test/inheritedChannelOpacityRenderSmoke.mjs', // inherited fill-/stroke-opacity (group, style, class, nested, use, symbol, marker, text) at Chrome, both routes
  'test/svgStructureRenderSmoke.mjs', // <use opacity> group, CSS transform-origin, marker gradient fill at Chrome
  'test/inheritanceRenderSmoke.mjs', // <use> inheritance, marker / pattern / mask paint from their definitions, child gradients' opacity, at Chrome, both routes
  'test/shaderReviewGpuSmoke.mjs', // convolve stays premultiplied, morphology past one pass, an override-scaled clip's or mask's AA pixel, COLR premultiplied stops
  'test/colrInterpolationRenderSmoke.mjs', // COLR color lines: linear-light and premultiplied against OpenType's arithmetic, compat 'chrome' against Chrome at 8x, no bands, no link
  'test/colrGradientPlacementRenderSmoke.mjs', // COLRv1 gradients' color POSITIONS inside glyphs: the GPU probe's square and a COLRv1 font, against the exact CPU answer and Chrome, both routes
  'test/groupTargetsRenderSmoke.mjs', // group targets and rects in pixels: a filter frame inside a group, a faded instance under w, a faded morph's pose, a stroke-width override
  'test/filterPastCanvasRenderSmoke.mjs', // a shape's filter targets cut at what can reach the canvas: the picture of canvas-sized targets, at zooms where uncut targets fit and where they do not
  'test/filterOffCanvasRenderSmoke.mjs', // a filter sees the shape beyond the canvas edge: every primitive family at worldMatrix zoom == the same art in a bigger canvas, cropped
  'test/groupOverBlitRenderSmoke.mjs', // a normal group's src-over blit is within 1 LSB of the copy path it replaced and at Chrome, both routes and the static cache
  'test/groupLeafDepthSmoke.mjs', // a depth-claimed (translucent, blended) leaf renders the same in a group as out of one, both routes, against Chrome
  'test/turbulenceChromeSmoke.mjs', // feTurbulence is the spec at pixel centers, and no further from Chrome than Chrome is from it; stitchTiles joins the tile to itself
  'test/cdnBrowserSmoke.mjs', // import-map CDN recipe in Chrome: shared registries across scripts, cross-origin worker blob recipe, shader asset URLs
  'test/vertexOnPixelCenterRenderSmoke.mjs', // fill: a pixel whose center is a vertex (rect corner, shared arc extremum) reads its exact area on the GPU
  'test/morphFullTurnReanchorRenderSmoke.mjs',
  'test/morphArcDirectionRenderSmoke.mjs',
  'test/morphArcSpecRenderSmoke.mjs', // arc morphs against Chrome animating d, 8x box-averaged, on every route
  'test/morphGradientSolidRenderSmoke.mjs', // a gradient morphing to a solid and back lands on each pose, against Chrome at 8x
  'test/filterRegionTurnedRenderSmoke.mjs', // a filter region under a turn or a skew is the turned rect, at any scale, against Chrome at 8x
  'test/morphRecordCompatibilityGpuSmoke.mjs',
  'test/aacPointsDisposeGpuSmoke.mjs',
  'test/colorMatrixSmoke.mjs', // shaderPrograms: colorMatrix program
  'test/morphCoverPoseGpuSmoke.mjs', // current raw curves on prepared-morph fallback
  'test/morphRouteSmoke.mjs', // morphDraw: GPU-resident morph route
  'test/morphIntervalSplitSmoke.mjs', // morphDraw: classification-changing morphs route via interval-split (no Slug)
  'test/lbMemBudgetSmoke.mjs', // morphDraw: projected-memory Slug gate (deny → Slug render; account; release on dispose)
  'test/lbMorphChainGateRenderSmoke.mjs', // 'auto' takes a morph whose interior faces its chains cannot serve to Slug; a pin keeps LB
  'test/lbMorphCornerNormalRenderSmoke.mjs', // an LB image morph's kind-10 corner normals are renormalized after the vertex lerp
  'test/morphGradientStopLayoutRenderSmoke.mjs', // a gradient pair packed one texel / two texels per stop tweens its stop colors on the GPU
  'test/isolationSmoke.mjs', // blend/composite
  'test/clipCoverageSmoke.mjs', // drawImages: deleteClipTexture / clip path
  'test/lbStreamGeometrySmoke.mjs', // streamGeometry: lightweight LB stream + handle/instanced; road rings, curved bands, sentinels, curve flips and slot teleports vs Slug
  // ── no-WebGL native fallback ────────────────────────────────────────
  // The fallback is the path that runs where WebGL doesn't, so it is the
  // LEAST likely to be caught by hand. Keep these gated.
  'test/nativeFallbackSmoke.mjs', // the broad one: retain, overrides, clip, morph, raster, sprites, text, timeline; raster images, recolor, blend, viewport space, defs ids, clip defs, mask indexing, text clips, streaming, gradient/id-less/dst-only/group morphs, full-sweep arcs
  'test/nativeDstRectRasterSmoke.mjs', // native dstRect vs the WebGL renderer's pixels, bundle and viewport spaces
  'test/incrementalStrokeSmoke.mjs', // incrementalStroke: dynamic paint stroke — O(1) appends, parity vs loaded-whole, dot/alpha, perf; native line/quad/cubic/arc segments, a miter at a native arc, the exact-area AA edge on the toggle, lines solved as lines
  // Static/morph analytic-fill feature parity — each renders a feature through
  // the LB route and asserts it matches Slug (the full unified feature set).
  'test/lbHoleParitySmoke.mjs', // LB topology routing (earcut mesh / CDT / annulus SDF) vs Slug: curved hole, concave cubics, cusp hole, concave fill, elliptical ring, diagonal frame, lens, convex fast path
  'test/lbAnnulusSdfSmoke.mjs', // circles and rings → exact circle/annulus SDF (kind 7), seam- and wedge-free at small scale; even-odd rings static and morphed keep the hole
  'test/lbRibbonGateRenderSmoke.mjs', // ...and keeps its outer AA near the ring's extreme points: no px lighter than exact by >32 at 5 t
  'test/lbReadyPendingSmoke.mjs', // awaitLbReady waits for the off-thread build it started, not the meshes already resident
  'test/cpatchMorphServeSmoke.mjs', // route:'cpatch' draws a morph with CPatch, GPU blend and CPU pack, within 4 px of the exact pose; the GPU blend equals the CPU pack
  'test/cpatchMorphMixedRowsGpuSmoke.mjs', // a CPatch morph with a mask, a group opacity, a gradient or a stroke draws the Slug morph's pose
  'test/cpatchMorphUnplannedRowsRenderSmoke.mjs', // a CPatch morph draws the glyphs CPatch leaves off its plan (counters, second pieces), after awaitLbReady too, and records their decline
  'test/cpatchMorphSwitchBackRenderSmoke.mjs', // a morph switched off a CPatch pin to the default route or to LB draws what a fresh renderer with that setting draws
  // These five launch Chrome too, so they gate here rather than in the fast Node lane.
  'test/cpatchArcScaleRenderSmoke.mjs', // CPatch draws the same arcs at any size of the art
  'test/enginePeerSmoke.mjs', // every engine draws the same shape; the peers must agree on ink
  'test/lbHoleOrientScaleRenderSmoke.mjs', // a same-wound even-odd ring draws the same picture at every size
  'test/lbDegenerateCubicDropSmoke.mjs', // near-degenerate cubic pieces leave the mesh without a collapsed survivor
  'test/lbApexClipSmoke.mjs', // tiger declines (almost) nothing to Slug, and every shape is built
  'test/lbQuadSeamSmoke.mjs', // non-circular ellipses, quad (kind 1) and rational-quad (kind 5) crescents: seams bounded without over-covering the curve
  'test/worldMatrixPositionRenderSmoke.mjs', // a vertex lands where its em says under a world matrix of scale 2^20: every engine, a fresh compile and a program-cache hit
  'test/lbChainWorldMatrixSmoke.mjs', // LB chain coverage under a world matrix is translation-invariant and mirror-exact
  'test/unifiedNestedMaskRenderSmoke.mjs', // a mask nested in a mask draws at Chrome 8x on the cover pass, and the forced unified route equals it (nested cells are declined)
  'test/unifiedFillCurveTexWideIndexSmoke.mjs', // >65,535 coefficient blocks stay on the narrow layout; a morph past 16 bits draws from 32 bits; past 32 bits the wide layout and program
  'test/unifiedFillDrawSmoke.mjs', // cover quads + LB triangles in ONE drawArrays, matching Slug; the ubershader hosts lbCoverage (MANTLE_LB_FILL links; cover quads unchanged)
  'test/lbSeamPartitionSmoke.mjs', // unified route is rim-accurate (AA-union does not double-count)
  'test/unifiedFillFeatureSmoke.mjs', // the unified draw across the feature matrix: no RT, fewer draws, no worse than the RT route
  'test/engineDeclineIsolationSmoke.mjs', // CPatch and LB decline to SLUG, never into each other — the coupling that filed LB's timings under CPatch's name
  'test/cpatchTextSmoke.mjs', // CPatch renders TEXT through the ordinary draw path — the retry, the builder chain and the scale-relative validity bar
  'test/strokeAttributionSmoke.mjs', // a stroke row is reported as the STROKE path, not as the fill kernel that never ran on it
  'test/entryPointRouteSmoke.mjs', // drawBundle, handle.draw and drawBundleInstanced route a bundle to the same engine; static LB on handles and instances; a cached handle stays on its cache
  'test/unifiedMorphSmoke.mjs', // ...and for MORPHS: 0 coverage RTs across t, no worse than the RT route
  'test/unifiedFilterSplitSmoke.mjs', // an offscreen filter SPLITS the draw into runs instead of declining the bundle
  'test/lbKindOmitSmoke.mjs', // LB coverage componentized BY KIND (MANTLE_LB_NO_K7/10/13), output-identical
  'test/unifiedStrokeSmoke.mjs', // a STROKED bundle in one draw, no coverage RT
  'test/strokePartitionSmoke.mjs', // bisector ownership == MAX-union (so OVER can replace the stroke RT)
  'test/overrideMoveRenderSmoke.mjs', // an override-moved/rotated/scaled row, its clip and mask, on every route vs Chrome 8x
  'test/optParitySmoke.mjs', // every optimization must be output-identical to the plain path
  'test/resolutionScaleSmoke.mjs', // setResolutionScale: fewer pixels, same screen, no stranded RTs
  'test/groupRectSmoke.mjs', // a group bounded to its content rect paints what the full-canvas one did
  'test/engineSwitchIndependenceSmoke.mjs', // an engine must draw the same regardless of what ran before it; a 2nd (Slug-only) renderer must not disarm LB's builder
  'test/aaMonotonicSmoke.mjs', // AA must fall monotonically across an edge; aacFill must engage
  'test/lbSalientAaSmoke.mjs', // LB vs SS: no neighbor spikes / non-monotone / bad outliers (not MSE)
  'test/cuspFillSmoke.mjs', // a cubic's cusp fills solid to the tip (path.js splits it)
  'test/gwnEngineSmoke.mjs', // GWN+SDF renders + matches Slug; a GWN kernel with no run tree is EMPTY; a curve range ends at its curves, not the GWN tree
  'test/debugOverlaySmoke.mjs', // showTriOutline draws on both routes, and shows the mesh actually submitted
  'test/occlusionCullSmoke.mjs', // bundle: a shape a later OPAQUE shape fully covers must not bleed through the AA edge (conflation), on every path; stroke rows; morphs cull only what is hidden for every t; overrides retire the cull
  'test/lbCubicOverfillSmoke.mjs',
  'test/lbQuadStripCoverageSmoke.mjs',
  'test/lbBand2Smoke.mjs', // unified curve band (kind 12): emission + quad-corner quality + no new artifacts; tips and shallow joints vs 4x AAC
  'test/hitRenderAgreementSmoke.mjs', // hit testing answers from WHAT IS DRAWN: band-walk fill decision == rendered pixels (all seg types, both fill rules) + memo consistency
  'test/lbInteriorBudgetSmoke.mjs', // convex cubic rings: OVER over-fills overlapping hulls → partition
  'test/lbTranslucentSolidSmoke.mjs', // translucent solids on LB composite alpha exactly vs Slug: forced LB, curve strips, overlaps, the composite path
  'test/paintDerivUniformFlowSmoke.mjs', // pattern images, image children and gradient children match Chrome at seams: derivatives from uniform flow
  'test/gradientSeamBoxFilterSmoke.mjs', // REPEAT gradient seams box-filtered on both sides, exact while t is linear across the pixel
  'test/radialConeSmoke.mjs', // a radial whose focus is outside its circle draws the SVG 2 cone, edge box-filtered
  'test/importSpecChromeRenderSmoke.mjs', // a zero viewBox, a gradient on a shape with no box, a group's mask over a leaf's, an even-odd contour drawn twice (no ring) and clip-path on a <mask> (spec default, compat chrome), against Chrome at 8x
  'test/objectBoundingBoxStrokeGradientRenderSmoke.mjs', // objectBoundingBox stroke gradients bind to the path-tight box on the GPU
  'test/strokeLocalFrameRenderSmoke.mjs', // a stroke under a non-conformal CTM is the image of its local stroke on the GPU
  'test/markerTransformRenderSmoke.mjs', // markers are placed in their path's space and transformed with it; viewBoxes fitted by preserveAspectRatio; content clipped to its viewport unless overflow is visible; the path's clip-path and mask; against Chrome
  'test/maskRegionRenderSmoke.mjs', // a <mask>'s region (maskUnits x/y/width/height) cuts what it masks, vs Chrome 8x
  'test/importerSemanticsRenderSmoke.mjs', // importer-semantics, geometry, compositing, filter-leaf, paint/image/mask, color and morph-pose cases render as their controls and differ from the uncorrected picture
  'test/svgTextImportRenderSmoke.mjs', // SVG <text> import: font-family lists, letter-spacing, underline metrics and trailing-space anchor render as their controls
  'test/spriteMorphApiRenderSmoke.mjs', // sprite/morph cases render as their literal controls and differ from the uncorrected picture
  'test/strokeDashCapsRenderSmoke.mjs', // dash/cap shader cases render as their controls and differ from the uncorrected picture; square caps and miter joins on the demo page
  'test/strokeEndCandidateGpuSmoke.mjs', // the end-candidate gate (round/bevel/butt ends skipped) is byte-identical to evaluating every end: 8 path kinds x caps x joins x dash
  'test/strokeDashSeamRenderSmoke.mjs', // a closed dashed contour's seam renders as its already-correct control (one dash through it, caps where only one side is on) and differs from the uncorrected picture; a morph of it draws the seam like a static import of each pose, CPU and GPU lerp
  'test/strokeDashSeamChromeRenderSmoke.mjs', // dashed glyph outlines (O, B, 8) agree with Chrome 8x at stable interiors
  'test/paintRowsRenderSmoke.mjs', // paint rows (radial fr, singular paint transforms, pattern strokes), a 600-stop gradient, SVG <image> documents and <switch> systemLanguage, against Chrome
  'test/groupIdRenderSmoke.mjs', // a group override on a bundle with NO hit-only rows equals the literal <g transform> control and Chrome 8x; a drawn child and a hit-only sibling move together under it and the hit tracks the drawn pixel
  'test/droppedContentRenderSmoke.mjs', // a morph from or to an alpha-0 fill or stroke draws the authored picture at t (all kernels), and an override that gives an alpha-0 row a color draws it
  'test/keepHiddenRenderSmoke.mjs', // keepHidden: display:none / visibility cells against Chrome 8x, override reveal, width from zero, morphs from and to a hidden pose (all kernels)
  'test/morphGroupOpacityRenderSmoke.mjs', // a fill+stroke leaf morphs as one group (opacity .5->1, .5->.8, 1->.5, named and unnamed), equal to the authored pose and to Chrome 8x
  'test/maskGroupCostRenderSmoke.mjs', // a masked group's passes scissored to its rect draw the merged picture byte for byte
  'test/slugExactEdgeAASmoke.mjs', // opt-in exact half-plane coverage for Slug's straight edges
  'test/slugQuadScaleSmoke.mjs', // stable quad-root pair: wide symmetric quads at large viewports (white-slit class)
  'test/noAaStrokeCoverSmoke.mjs', // hard-fill gate: only closed, later-stroked shapes may skip fill AA
  'test/nineSliceInstanceSmoke.mjs', // bundle.nineSliceInstance: per-DRAW nine-slice — two sizes of ONE bundle, undistorted corners, base unmutated, re-slice via same handle
  'test/textBundleIdentitySmoke.mjs', // textBundle: identity-stable setText/setStyle — same bundle object, bound handles re-upload via _geomGen, matches a fresh-bundle render; setText's spent bundle shell must not reach the pipeline warmer
  // ── general browser-lane smokes ─────────────────────────────────────
  // The morph route smokes are gated in the composed-morph section below.
  'test/aacBandSeamSmoke.mjs',
  'test/arcNonZeroSmoke.mjs',
  'test/bundleHandleSmoke.mjs', // two persistent handles in one frame: resident VBOs, no aspect-ratio bleed
  'test/clipperAnimVisualSmoke.mjs',
  'test/dashCurveArcLenSmoke.mjs',
  'test/ellipseHairlineSweepSmoke.mjs',
  'test/exportFrameSvgSmoke.mjs',
  'test/filterCacheSmoke.mjs',
  'test/filterWorldScaleSmoke.mjs',
  'test/font/visualBreadth.mjs',
  'test/lbGpuMorphSmoke.mjs',
  'test/maskAnimSmoke.mjs',
  'test/maskCacheSmoke.mjs', // a mask bakes once and is reused while geometry and canvas are unchanged; two masked handles drawn per frame keep their own layers: 0 re-bakes, not 2 a frame
  'test/morphGpuCurveLerpSmoke.mjs',
  'test/occupancyRenderDiffSmoke.mjs', // the occupancy interior skip is pixel-identical to the walk, before and after the async grid lands
  'test/overrideVisibilityFadeSmoke.mjs',
  'test/pathBooleanSilhouetteVisualSmoke.mjs',
  'test/patternUnitsRenderSmoke.mjs', // pattern units against Chrome's native SVG rendering; a rotated patternTransform lattice; gradient and image pattern children
  'test/patternShareRenderSmoke.mjs', // a shared (canonical-space) pattern paints what the per-size baked one did: alignments, slice/none, strokes, transform, nested, stroke paint, sub-pixel tile, morph, nine-slice
  'test/rendererReadyBaseline.mjs',
  'test/sceneToSectionsSmoke.mjs',
  'test/scissorRectSmoke.mjs',
  'test/shaderBuildSmoke.mjs',
  'test/shapeAnimationVisualSmoke.mjs',
  'test/streamGeometryRenderDiffSmoke.mjs',
  // Fat miter joins on a densely tessellated curve must not turn a round outline spiky.
  'test/strokeCubicOvershootSmoke.mjs',
  'test/strokeReachGateSmoke.mjs', // the cubic and arc reach gates and uStrokeGates (saturation depth, AA reach of the reject/far/break) change no pixel: gates on == off, byte for byte
  'test/depthBitsQueryPerDrawSmoke.mjs', // the draw never queries DEPTH_BITS per draw: a synchronous GPU round trip
  'test/evictedHookDedupeSmoke.mjs', // one eviction hook per bundle, not one per eviction
  'test/strokeStripSmoke.mjs', // the strip cover (opt-in) loses no ink and never clips a stroke: width overrides, crossings, depth, morph, moved geometry
  // Opt-in exact-area AA on straight stroke edges (strokeExactAa).
  'test/strokeExactAaSmoke.mjs',
  'test/strokeBigCircleGpuSmoke.mjs', // physical GPU vs reference
  'test/strokeTypeOmitGpuSmoke.mjs', // specialized stroke kernels retain all curve types and morph poses
  'test/curveAngleSignedZeroGpuSmoke.mjs', // real axis, sector and winding expressions on GPU
  'test/strokeFootSignedZeroGpuSmoke.mjs', // a foot on the minor axis from the negative side keeps its coverage
  'test/textSmallScaleDilationSmoke.mjs',
  'test/viewBoxOverhangSiblingSmoke.mjs',
  'test/lbChainBorderGpuSmoke.mjs',
  'test/lbZeroRadiusArcGpuSmoke.mjs',
  'test/lbTranslucentGroupMorphGpuSmoke.mjs',
  'test/morphFilterCarryRenderSmoke.mjs',
  'test/morphGroupOpacityGpuSmoke.mjs', // the same morph on LB / CPatch / Slug / AAC, GPU and CPU lerp, against the authored pose and analytic samples
  'test/aacRotatedCoverReachGpuSmoke.mjs',
  'test/aacAffineCoverReachGpuSmoke.mjs', // a thin affine or axis-aligned anisotropic map's cover reaches every pixel its box touches
  'test/slugRotatedColdGpuSmoke.mjs', // a COLD default Slug fill under a rotated/sheared map draws the rotated program, exact to the area
  'test/lbJointPixelGpuSmoke.mjs', // Loop-Blinn's joint pixel is ramped by the arc that cuts it
  'test/lbBandHookGpuSmoke.mjs', // the curve band on a rational quad that turns past a right angle: the 80:1 sliver pinned to Loop-Blinn against Chrome 8x and Slug
  'test/lbStaticFanGpuSmoke.mjs', // a simple convex translucent contour's interior is a fan: LB within 4 bytes of raw AAC
  'test/aacMorphGroupBoundsGpuSmoke.mjs',
  'test/cpatchMorphReadinessGpuSmoke.mjs', // CPatch morph preparation: readiness of a morph handle, rational refusal, certified fallback to raw AAC
  'test/coverProjectionScaleGpuSmoke.mjs', // scale-invariant actual cover support
  'test/linkRetryRenderSmoke.mjs', // on the GPU: a real link failure is not linked again in play, the next loading call links it, and the bundle draws what a healthy renderer draws
  'test/cacheBlendBackdropRenderSmoke.mjs', // a bundle with a row that blends with what lies under it draws live under every cache strategy; a blend in an isolating group still caches
  'test/streamWarmRenderSmoke.mjs', // on the GPU: a declared stream, or a lightweight stream updated once before the loading call, links and builds nothing in play and draws its last update
  'test/monotoneCubicStatesRenderSmoke.mjs', // an external clip, a sprite range and a zero-scale row draw the plain picture of certified-monotone art, at several scales
  'test/instancedRaisedStrokeRenderSmoke.mjs', // an instanced draw under a table that raises a stroke paints the stroke drawBundle paints
  'test/standInsReuseGpuSmoke.mjs', // previous-variant reuse (standIns:false): the reused frame vs the needed engine's frame within tolerance at 256/1024/2048, no hole, no pop at the switch
  'test/psoWarmQueueGpuSmoke.mjs', // actual warm/first draw programs and budget continuation
  'test/auxWarmSamplerGpuSmoke.mjs', // the loading call's filter-helper warm draws are valid GL draws (no sampler-unit clash) and every helper is warmed
  'test/aacColdKernelGpuSmoke.mjs', // cold runtime AAC request retains kernel/affine footprint

  'test/splitStrokeRouteSmoke.mjs',
  // An ungated test is silent, not red: every browser smoke in test/ belongs in
  // a runner list.
  'test/circleObbAxisAlignedSmoke.mjs',
  // A stroked shape's FILL row must keep the path-tight bbox: the tagged-
  // primitive SDF reads the shape out of it, so a stroke-padded one would make a
  // stroked circle flood its cover quad with fill.
  'test/primStrokedBboxSmoke.mjs',
  // objectBoundingBox units resolve against the GEOMETRY box (SVG 1.1 §7.11),
  // not the stroke-padded coverage box.
  'test/objectBboxStrokeSmoke.mjs',
  // COLRv1 transforms, skew, conical radial gradients, hit table, edge softness -- fontTools fonts against
  // Chrome-rasterized outlines and the analytic cone rule; the COLRv1 ClipList (base glyph, PaintColrGlyph, nested,
  // rotated, ranges, format 2 var) against Chrome clipping the box outline; COLRv0 layers and a COLRv1 tree on the demo page.
  'test/font/colrSpecRenderSmoke.mjs',
  // Bbox-sized filter RTs must be byte-identical to canvas-sized ones. Also the
  // gate for fragment-quad parity: an odd RT origin shifts derivative
  // quads and breaks edge AA on shape corners.
  'test/filterBboxRenderDiffSmoke.mjs',
  'test/cpatchAutoGpuSmoke.mjs',
  'test/cpatchConversionSupersedeGpuSmoke.mjs',
  'test/cpatchOccupancyGpuSmoke.mjs', // actual worker replies preserve live CPatch coefficients and translucent output
  'test/colorMatrixDepthClaimGpuSmoke.mjs', // alpha-changing recolor retains single ownership and mutable state
  'test/recolorFoldPixelGpuSmoke.mjs', // the one recolor program of a bundle declared both ways draws the lean programs' pixels
  'test/contextGenerationGpuSmoke.mjs', // real restoration, late disposal, shared caches and worker resources
  'test/translucentDepthClaimGpuSmoke.mjs', // low and nearly opaque pieces retain single ownership
  'test/treeGridAsyncSmoke.mjs',
  // Per-row hard fill (MANTLE_HARD_MIXED): stroke-covered fills drop their AA
  // individually instead of all-or-nothing per bundle. Must stay byte-identical.
  'test/mixedHardFillSmoke.mjs',
  // paint-order="stroke" paints the stroke under the fill AND still batches into
  // one draw (the rows are emitted in paint order, not swapped afterwards).
  'test/paintOrderStrokeSmoke.mjs',
  // An explicit objectBoundingBox <filter> region clips the output. The control
  // case (no region) must still leak, or the test measures nothing. A region's
  // edge past 2^31 px does not wrap: a flood stays painted at every zoom.
  'test/filterRegionSmoke.mjs',
  'test/groupFilterCacheRenderSmoke.mjs', // a filter on a <g> hits the result cache only while every key term is unchanged; cached == uncached
  // A nested viewport clips its content (nested <svg>, <use> of a <symbol>) and a clip def's own clip-path
  // intersects with it. Controls (overflow:visible, an all-covering own clip) keep the probe honest.
  'test/svgViewportClipSmoke.mjs',
];

// Collect the FAILING NAMES, not just a count. With a suite this size,
// "FAIL (3/181)" means grepping a 2000-line log and mapping error lines back
// to the nearest heading to find out what broke.
// Focused runs: any extra CLI args are substring filters over the test paths,
// so `npm test -- stroke filter` runs just those. Unfiltered is the full suite,
// which is what CI and prepublish want; a filtered run is for iterating on one
// change and is NOT a substitute for the full run before a merge.
const FILTERS = process.argv.slice(2);
const SELECTED = FILTERS.length
  ? SMOKES.filter((rel) => FILTERS.some((f) => rel.toLowerCase().includes(f.toLowerCase())))
  : SMOKES;
if (FILTERS.length && !SELECTED.length) {
  console.error(`no smoke matches ${JSON.stringify(FILTERS)} — filters are substrings of the path`);
  process.exit(1);
}
if (FILTERS.length)
  console.log(`FILTERED: ${SELECTED.length}/${SMOKES.length} smokes match ${FILTERS.join(', ')}`);

// SKIPS ARE NOT PASSES — same contract as runSmokes.mjs: exit 77 (test/_assets.mjs
// SKIP_EXIT) means the smoke could not run for want of an asset git does not carry. The
// render lane reads the same fonts and the same tiger as the unit lane.
const SKIP_EXIT = 77;

// A HUNG SMOKE MUST NOT COST THE whole LANE. Without a timeout, a page that never finishes would
// block here forever and the only thing that stopped it would be whatever outer `timeout` the
// caller wrapped the lane in — which reports nothing except that the lane died, at the end,
// after the full budget.
//
// So every smoke gets its own wall cap. The cap is deliberately well above the slowest honest
// smoke (the lane averages ~3 s a test and its slowest legitimate ones run tens of seconds), so
// hitting it means hung, not slow, and the run says so immediately and moves on.
const PER_TEST_MS = +(process.env.RENDER_TEST_TIMEOUT_MS || 180000);
// A test that takes longer than this is REPORTED at the end even when it passes, because "the
// lane got slower" is otherwise invisible until it overruns something.
const SLOW_MS = +(process.env.RENDER_SLOW_MS || 30000);
// THE CHILD IS TOLD ITS own CAP. A test that waits longer than the cap can never report WHY it is
// stuck: the SIGKILL lands first and its diagnostic branch -- the one that prints the page's
// console errors -- is unreachable, and the hang dies silently. Passing the
// effective cap down lets each test size its own wait against it (see `pageTimeoutFor`), and
// `renderTimeoutBudgetSmoke` fails if any of them stops doing so.
// A smoke whose honest run exceeds the default cap names its own larger cap here (the cap is still a hang detector for it,
// and the child is told the cap it really has). filterOffCanvasRenderSmoke renders about 80 cases on two routes (215 s on Metal).
const CAP_OVERRIDE_MS = {
  'variantFirstDefaultSmoke.mjs': 600000,
  'basicShapeClipRenderSmoke.mjs': 600000,
  'filterOffCanvasRenderSmoke.mjs': 900000,
  'filterSubregionRenderSmoke.mjs': 600000,
  'filterScaleRenderSmoke.mjs': 900000,
  'filterLinearRenderSmoke.mjs': 600000,
  'morphGroupOpacityGpuSmoke.mjs': 900000,
  'morphGroupOpacityRenderSmoke.mjs': 600000,
  'filterLinearBlurRenderSmoke.mjs': 600000,
  'filterOwnerGradientRenderSmoke.mjs': 900000,
  // Files that hold several former smokes as cases: the cap covers all of them. The probe-driven ones
  // give each probe launch its own timeout (two launches of up to 130 s, or 70 + 130 s; two 180 s wall
  // caps), which the default cap would cut short; the two longest page-driven ones measured 53-63 s on
  // a loaded machine.
  'loopBlinnRenderDiffSmoke.mjs': 600000,
  'unifiedFillCurveTexWideIndexSmoke.mjs': 600000,
  'cpatchMorphReadinessGpuSmoke.mjs': 600000,
  'fillNormalizePolynomialGpuSmoke.mjs': 600000,
  'aacAffineCoverReachGpuSmoke.mjs': 600000,
  // Merged smokes, a browser and many pages each: 40-95 s on a loaded machine (load average over 30).
  'nativeFallbackSmoke.mjs': 360000,
  'morphRouteSmoke.mjs': 360000,
  'splitStrokeRouteSmoke.mjs': 360000,
  'importerSemanticsRenderSmoke.mjs': 360000,
};
const capFor = (abs) => Math.max(PER_TEST_MS, CAP_OVERRIDE_MS[path.basename(abs)] || 0);

// ONE BROWSER PER WORKER. A smoke's launchBrowser() (test/_launch.mjs) takes a fresh incognito context in a browser
// its worker keeps (scripts/sharedBrowsers.mjs) instead of launching Chrome, which costs 0.7-1.0 s of a small smoke's
// 1.2-2.1 s. The worker's browsers serve one smoke at a time; between smokes the runner disposes every context the last
// one left, and replaces a browser that crashed, stopped answering, served a failed or hung smoke, or served
// RENDER_SHARED_BROWSER_USES smokes (default 25). A retry always launches its own browser. RENDER_SHARED_BROWSER=0
// gives every smoke its own browser, as before.
//
// A smoke whose subject is a cold browser keeps its own. A program another browser already compiled links as a cache
// hit in a new browser too (the Metal shader cache is per machine), so a browser of its own never made a compile fast;
// what a shared browser adds is its GPU process's state from earlier smokes. A program an earlier smoke compiled in the
// same GPU process can round an AA tie differently from a fresh compile of it (strokeEndCandidateGpuSmoke's shipped
// stroke program, after other stroke smokes, is 1/255 off at up to 24 bytes from its gate-defeated copy, compiled
// fresh), and --disable-gpu-program-cache does not change that. So these keep their own: the smokes that compare a
// fresh compile with a cache hit, keep every program fresh, or compare the shipped program with an edited copy of its
// source byte for byte; that assert what a first frame or a still-linking program draws; that count links or pipelines
// built in play; that lose a real context; or that time compiles. The originRender parts keep their own because one
// browser that has drawn a few hundred corpus assets draws blank frames. Probes a smoke spawns are not the runner's
// children, so they always launch their own.
const FRESH_BROWSER = new Set([
  'maskCodeSolidParityRenderSmoke.mjs', // every program compiled fresh in both arms
  'worldMatrixPositionRenderSmoke.mjs', // each zoom drawn by a fresh compile and by a program-cache hit
  'alphaSlotRenderSmoke.mjs', // balanced OFF/ON arms with an A/A floor
  'groupFilterSkipRenderSmoke.mjs', // balanced OFF/ON arms with an A/A floor
  'recolorFoldPixelGpuSmoke.mjs', // every program a fresh compile in its page
  'strokeEndCandidateGpuSmoke.mjs', // the shipped program against a gate-defeated copy of its source, byte for byte
  'variantFirstDefaultSmoke.mjs', // the first frame of every engine and route class
  'instancedLeanFirstSmoke.mjs', // the program of the first instanced draw
  'instancedAsyncPixelGpuSmoke.mjs', // the frame drawn while the specialization links
  'standInsReuseGpuSmoke.mjs', // the frames drawn while the needed program links
  'slugRotatedColdGpuSmoke.mjs', // a cold fill's first frame
  'aacPointsWarmGpuSmoke.mjs', // the point program is linked before its first visible draw
  'psoWarmQueueGpuSmoke.mjs', // loading calls that stop before a later pipeline
  'streamWarmRenderSmoke.mjs', // links and pipelines built in play
  'linkRetryRenderSmoke.mjs', // a program that fails to link, and its relink
  'aacPointsDisposeGpuSmoke.mjs', // programs deleted while their link runs
  'rendererReadyBaseline.mjs', // how long createRenderer blocks, sync against async compile
  'lifecycleRealContextRenderSmoke.mjs', // a real context loss and restore
  'contextGenerationGpuSmoke.mjs', // a real context loss and restore
  'importerSemanticsRenderSmoke.mjs', // exact image probes: a browser that decoded the same image for an earlier smoke can
  //   hand its colorImage case a cached decode with other color handling (one probe read 132 for 127)
]);
const freshBrowser = (rel) =>
  FRESH_BROWSER.has(path.basename(rel)) || path.basename(rel).startsWith('originRender');
{
  // A name here that the lane no longer runs means the smoke was renamed or merged, and the file that now holds its
  // assertions has lost its fresh browser.
  const listed = new Set(SMOKES.map((rel) => path.basename(rel)));
  const stale = [...FRESH_BROWSER].filter((name) => !listed.has(name));
  if (stale.length) {
    console.error(
      `FRESH_BROWSER names smokes the lane does not run: ${stale.join(', ')}. Carry each one's fresh browser to the ` +
        `file that now holds its assertions, or remove the name.`,
    );
    process.exit(1);
  }
}
const SHARED = process.env.RENDER_SHARED_BROWSER !== '0';
const SHARED_USES = Math.max(1, Math.floor(Number(process.env.RENDER_SHARED_BROWSER_USES)) || 25);
const fmt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');

// REAP THE BROWSERS A KILLED TEST LEAVES BEHIND. The per-test cap above stops one hang from eating
// the lane; it does not stop the lane from getting SICKER as it runs, because SIGKILLing a test
// orphans the browser it launched. Orphans accumulate over a long lane — not CPU starvation, just
// browsers holding resources — and the worker-dependent smokes are the first to hang once they do
// (see the retry comment below: "after ~200 browser launches the worker-dependent smokes start
// timing out in setup").
//
// An orphan is identified, not guessed at (scripts/laneProfiles.mjs): every browser a smoke or its probe launches keeps
// its profile in this run's LANE ROOT, named after the process that launched it, so a `Chrome for Testing` process is
// killed only when its parent is PID 1, its profile is under this lane's root (or the root of a runner that is gone),
// and its launcher is gone. Another live lane's browsers, an agent's job, a run outside the lane, a browser whose
// launcher still runs (and its crash handler, which detaches to PID 1 by design) and the runner's own shared browsers
// are never touched.
// RENDER_NO_REAP=1 turns it off.
removeAbandonedLaneRoots();
const LANE_ROOT = createLaneRoot();
process.env[PROFILE_ROOT_ENV] = LANE_ROOT;
process.on('exit', () => rmSync(LANE_ROOT, { recursive: true, force: true }));
// Smokes started by the parallel path, killed if the lane is stopped.
const liveChildren = new Set();
// A stop signal (timeout(1), the scheduler, ^C) ends the lane. Puppeteer's own SIGTERM/SIGINT listeners, installed when
// the shared browsers launch, only close a browser, and any listener keeps Node from exiting, so exit here; the exit
// hooks above and below then close the shared browsers and remove the lane's profiles.
for (const [sig, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
])
  process.on(sig, () => {
    // TERM lets each smoke's puppeteer close the browser it launched; then every Chrome still running under this
    // lane's profile root (shared or a smoke's own) is killed directly, since the lane is ending.
    for (const c of liveChildren) c.kill('SIGTERM');
    try {
      const ps = spawnSync('/bin/ps', ['-eo', 'pid,command'], { encoding: 'utf8' });
      for (const line of (ps.stdout || '').split('\n')) {
        if (!line.includes('Chrome for Testing') || !line.includes(LANE_ROOT)) continue;
        try {
          process.kill(+line.trim().split(/\s+/)[0], 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* the reaper of the next lane collects what is left */
    }
    process.exit(code);
  });
const reapOrphanBrowsers = () => {
  if (process.env.RENDER_NO_REAP) return 0;
  try {
    const ps = spawnSync('/bin/ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8' });
    if (ps.status !== 0 || !ps.stdout) return 0;
    let n = 0;
    for (const pid of orphanBrowserPids(ps.stdout, LANE_ROOT)) {
      try {
        process.kill(pid, 'SIGKILL');
        n++;
      } catch {
        /* already gone */
      }
    }
    return n;
  } catch {
    return 0;
  }
};
const started = Date.now();
const failed = [],
  flaky = [],
  skipped = [],
  timings = [],
  hung = [];
let reapedTotal = 0;
let done = 0;
// GPU CARE IS FOR TIMING ONLY. This lane checks correctness, so it runs the GPU at full duty: no rest between smokes
// (MANTLE_GPU_REST_MS, default 0), and every smoke and probe it starts gets MANTLE_GPU_CARE=0, which turns off the
// per-sample throttle in test/_gpuThrottle.mjs. Timing harnesses keep that throttle by default. MANTLE_GPU_REST_MS=N
// rests N ms after each smoke (MANTLE_GPU_REST_FAST_MS after one shorter than MANTLE_GPU_FAST_SMOKE_MS).
process.env.MANTLE_GPU_CARE ??= '0';
const GPU_REST_MS = Math.max(0, +(process.env.MANTLE_GPU_REST_MS ?? 0) || 0);
const FAST_SMOKE_MS = +(process.env.MANTLE_GPU_FAST_SMOKE_MS ?? 3000) || 0;
const GPU_REST_FAST_MS = Math.min(
  GPU_REST_MS,
  Math.max(0, +(process.env.MANTLE_GPU_REST_FAST_MS ?? GPU_REST_MS) || 0),
);
let lastSmokeMs = Infinity;
const restMsAfter = (ms) => (ms < FAST_SMOKE_MS ? GPU_REST_FAST_MS : GPU_REST_MS);
const gpuRest = () => {
  const ms = restMsAfter(lastSmokeMs);
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
// PARALLEL. RENDER_JOBS=N runs N smokes at once (default 1, the serial lane). Each smoke has its own browser context
// (in its worker's shared browser) or browser, and its own server port, so they do not share state; what they share is
// the GPU, and each worker still rests it after every smoke. The longest smokes start first (their last durations are
// cached in node_modules/.cache, ignored), so the lane ends close to its total time divided by N instead of waiting on
// one slow smoke started last. Output is buffered per smoke and printed whole when it ends.
const JOBS = Math.max(1, Math.floor(Number(process.env.RENDER_JOBS)) || 1);
const TIMES_FILE = path.join(ROOT, 'node_modules', '.cache', 'mantle', 'render-times.json');
const lastTimes = (() => {
  try {
    return JSON.parse(readFileSync(TIMES_FILE, 'utf8'));
  } catch {
    return {};
  }
})();
// `live` streams the smoke's output (the serial lane) instead of buffering it; `env` adds to the smoke's environment.
const runAsync = (abs, { live = false, env = {} } = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const cap = capFor(abs);
    const chunks = [];
    let killed = false,
      settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ r, ms: Date.now() - t0, out: Buffer.concat(chunks).toString() });
    };
    const p = spawn(process.execPath, [abs], {
      cwd: ROOT,
      stdio: live ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, RENDER_TEST_TIMEOUT_MS: String(cap) },
    });
    const timer = setTimeout(() => {
      killed = true;
      p.kill('SIGKILL');
    }, cap);
    if (!live) {
      p.stdout.on('data', (d) => chunks.push(d));
      p.stderr.on('data', (d) => chunks.push(d));
    }
    p.on('error', (error) => finish({ status: null, signal: null, error }));
    liveChildren.add(p);
    p.on('exit', () => liveChildren.delete(p));
    p.on('close', (status, signal) =>
      finish({
        status,
        signal,
        error: killed ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) : undefined,
      }),
    );
  });
// runAsync reports a kill at the cap as an ETIMEDOUT error with a null status.
const timedOut = (x) => x.error && x.error.code === 'ETIMEDOUT';
const exitText = (r) =>
  timedOut(r)
    ? 'HUNG'
    : 'exit ' +
      (r.status === null
        ? r.signal === null && r.error
          ? 'did not start: ' + (r.error.code || r.error.message)
          : 'signal ' + r.signal
        : r.status);
// The shared browsers, and the output of the smoke each worker is running (where their replacements are reported).
let pool = null;
const writers = [];
if (SHARED) {
  pool = await startSharedBrowsers({
    laneRoot: LANE_ROOT,
    maxUses: SHARED_USES,
    maxPerWorker: 3,
    log: (w, line) => writers[w]?.(`  ◇ ${line}\n`),
  });
  process.on('exit', () => pool.killAll());
}
// One smoke on worker `w`, serial (`live`: output inherited) or parallel (output captured into `out`); `write` prints.
const runSmoke = async (rel, w, live, write) => {
  const abs = path.join(ROOT, rel);
  writers[w] = write;
  write(`\n▶ ${rel}\n`);
  const shared = !!pool && !freshBrowser(rel);
  const exec = (withShared) => runAsync(abs, { live, env: withShared ? pool.env(w) : {} });
  let { r, ms, out } = await exec(shared);
  if (out) write(out);
  if (shared) await pool.afterSmoke(w, { failed: r.status !== 0 && r.status !== SKIP_EXIT });
  lastSmokeMs = ms;
  if (timedOut(r)) {
    write(
      `  ⏱ HUNG — killed after ${fmt(capFor(abs))} (RENDER_TEST_TIMEOUT_MS, or the per-smoke CAP_OVERRIDE_MS)\n`,
    );
    hung.push(rel);
  }
  // ONE retry. Every smoke already runs in its own child process, so a failure
  // late in a long run is not per-process leakage — it is system-level: after
  // ~200 browser launches the worker-dependent smokes start timing out in setup,
  // and the same commit passes them immediately on a fresh run. That is not a
  // code defect, so the suite preserves the failed attempt and retries once; a
  // pass does not establish its cause.
  //
  // The retry is REPORTED, never silent. A test that only passes on retry is a
  // signal to investigate, and swallowing it would
  // trade one confusing failure mode for a quieter one.
  // A skip is deterministic -- the asset is absent -- so retrying it only costs a browser launch.
  // The retry launches a browser of its own, so a shared browser cannot be the cause of a retry's failure.
  if (r.status !== 0 && r.status !== SKIP_EXIT) {
    write(`  ↻ retrying ${rel} (first attempt ${exitText(r)})\n`);
    const again = await exec(false);
    if (again.out) write(again.out);
    r = again.r;
    ms += again.ms;
    if (timedOut(r)) {
      write(`  ⏱ HUNG on retry too\n`);
      if (!hung.includes(rel)) hung.push(rel);
    }
    if (r.status === 0) flaky.push(rel);
  }
  timings.push([rel, ms]);
  const reaped = reapOrphanBrowsers();
  if (reaped) {
    reapedTotal += reaped;
    write(`  ♻ reaped ${reaped} orphaned browser(s)\n`);
  }
  done++;
  // Live pace, so a lane that is falling behind says so DURING the run rather than by overrunning
  // its caller's budget at the end.
  const elapsed = Date.now() - started;
  const eta = Math.round(((elapsed / done) * (SELECTED.length - done)) / 1000);
  write(
    `  ⧗ ${fmt(ms)}${ms >= SLOW_MS ? '  SLOW' : ''}` +
      `   [${done}/${SELECTED.length}, ${Math.round(elapsed / 1000)}s elapsed, ~${eta}s left]\n`,
  );
  if (r.status === SKIP_EXIT) skipped.push(rel);
  else if (r.status !== 0) failed.push(`${rel} (${exitText(r)})`);
  return ms;
};
if (pool)
  console.log(
    `SHARED BROWSER: one per worker and launch configuration, replaced every ${SHARED_USES} smokes ` +
      `(RENDER_SHARED_BROWSER=0 gives each smoke its own)`,
  );
if (JOBS === 1) {
  for (const rel of SELECTED) {
    if (done) gpuRest();
    await runSmoke(rel, 0, true, (t) => process.stdout.write(t));
  }
} else {
  console.log(`PARALLEL: ${JOBS} render smokes at a time (RENDER_JOBS), longest first`);
  const queue = [...SELECTED].sort((a, b) => (lastTimes[b] ?? 0) - (lastTimes[a] ?? 0));
  const worker = async (w) => {
    while (queue.length) {
      const rel = queue.shift();
      let block = '';
      const ms = await runSmoke(rel, w, false, (t) => (block += t));
      process.stdout.write(block);
      const rest = restMsAfter(ms);
      if (queue.length && rest) await new Promise((res) => setTimeout(res, rest));
    }
  };
  await Promise.all(Array.from({ length: JOBS }, (_, w) => worker(w)));
}
if (pool) {
  await pool.close();
  const { launched, served, retired } = pool.stats;
  const why = Object.entries(retired).map(([k, n]) => `${n} ${k}`);
  console.log(
    `\nshared browsers: ${launched} started, ${served} launches served from them` +
      (why.length ? `; replaced: ${why.join(', ')}` : ''),
  );
}
// Remember durations for the next parallel run's longest-first order (a missing or unwritable cache only loses the order).
if (!FILTERS.length) {
  try {
    mkdirSync(path.dirname(TIMES_FILE), { recursive: true });
    writeFileSync(TIMES_FILE, JSON.stringify(Object.fromEntries(timings), null, 0));
  } catch {
    /* order only */
  }
}
if (hung.length) {
  console.log(`\nHUNG (${hung.length}) — killed at the per-test cap, not merely slow:`);
  for (const h of hung) console.log('  ' + h);
}
{
  const slow = timings.filter(([, ms]) => ms >= SLOW_MS).sort((a, b) => b[1] - a[1]);
  if (slow.length) {
    console.log(`\nSLOWEST (${slow.length} over ${fmt(SLOW_MS)}) — where the lane's time goes:`);
    for (const [rel, ms] of slow.slice(0, 15)) console.log(`  ${fmt(ms).padStart(8)}  ${rel}`);
  }
  console.log(
    `\nlane wall: ${fmt(Date.now() - started)} over ${SELECTED.length} smokes` +
      (reapedTotal ? `, ${reapedTotal} orphaned browser(s) reaped` : ''),
  );
}
if (flaky.length) {
  console.log(`\nPASSED ON RETRY (${flaky.length}) — cause not established:`);
  for (const f of flaky) console.log('  ' + f);
}
if (skipped.length) {
  console.log(
    `\nSKIPPED (${skipped.length}) — did not run; an asset was absent (each printed its own pointer above):`,
  );
  for (const s of skipped) console.log('  ' + s);
  console.log('  → `npm run fetch:fixtures` gets everything that is fetchable.');
}
// Fail when the lane introduces changes to tracked files or generated fixtures.
const leaked = reportLeaks(newlyDirty(ROOT, GIT_BEFORE), 'render-smokes');
if (leaked) failed.push('(tracked tree dirtied by the lane)');
const failures = failed.length;
if (failures) {
  console.log('\nFAILED:');
  for (const f of failed) console.log('  ' + f);
}
const ran = SELECTED.length - skipped.length;
const tail = skipped.length ? `, ${skipped.length} SKIPPED` : '';
console.log(
  failures
    ? `\nRENDER-SMOKES FAIL (${failures}/${SELECTED.length}${tail})`
    : `\nRENDER-SMOKES PASS (${ran}/${SELECTED.length}${tail})`,
);
process.exitCode = failures ? 1 : 0;
