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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { snapshot as gitSnapshot, newlyDirty, reportLeaks } from './trackedClean.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Validation reads committed fixtures; generation is an explicit maintenance step.
const GIT_BEFORE = gitSnapshot(ROOT);

const SMOKES = [
  'test/arcDeepZoomRenderSmoke.mjs', // a native arc stays filled at deep zoom under the walk: ellipse, path of arcs, gradient circle, rotated map, pinned kernels
  'test/primDeepZoomRenderSmoke.mjs', // a tagged circle or round rect stays filled past the arc walk's float32 bound, under it the default draws the walk, and a pin keeps the walk
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
  // A static filtered scene must stop evaluating its graphs after frame 1, and the
  // cached frames must be byte-identical. Guards the filter-result cache bound: a
  // bound below the scene's working set misses every time, which is slower than no
  // cache at all.
  'test/filterCacheResidencyRenderSmoke.mjs',
  'test/bundleDisposeReleasesHandleRenderSmoke.mjs', // renderer: bundle.dispose() frees the transient handle's buffers, filter results and the bundle itself
  'test/lifecycleRealContextRenderSmoke.mjs', // renderer: a real WEBGL_lose_context loss + restore fails loudly and a recreate draws; native fallback on a lost context; disposed owners; loss-window noise; sticky getError; resolution scale
  'test/scaleRangeRenderSmoke.mjs', // bbox gradient, blur, radial, filter region, huge miterlimit, sub-pixel pattern tile and sub-ulp gradient vector at 2^-36..2^28 vs the scale-1 control
  'test/originRenderSmoke.mjs', // a bundle ORIGIN (coordinates stored relative to it): every corpus SVG under a forced origin equals the origin-free picture; far cells (1e4..1e7, 2^-10..2^10) equal offset 0 and Chrome 8x
  'test/obbGradientRowsRenderSmoke.mjs', // objectBoundingBox gradients on turned/skewed squares render as their chunked controls past 2048 gradient rows
  'test/deviceLimitPlanesRenderSmoke.mjs', // mask layer array, incremental stroke prim texture and CPatch plane vs a simulated small device
  'test/textureRowLimitsRenderSmoke.mjs', // renderer: per-item tables (meta, gradient, dash, filter, override, mask row) wrap in 4096-row bands; simulated 4096/8192 devices; over-capacity throws
  'test/rendererDisposeThenDrawRenderSmoke.mjs', // renderer: after dispose() a late frame, prepare and createImage allocate nothing; createBundleHandle refuses
  'test/filterResultRecycleRenderSmoke.mjs', // renderer: a cached result that outgrew its texture leaves no deleted pair on the free list: no GL error, the next entry of that size draws
  'test/filterPoolTrimRenderSmoke.mjs', // renderer: alternating filtered scenes never lose scratch; an idle renderer frees it one target per frame; pixels unchanged
  'test/staticCacheDepthReleaseRenderSmoke.mjs', // cacheDraw: a baked static cache frees its depth/stencil renderbuffer, a rebake re-attaches one, pixels unchanged
  'test/strokeInkFitRenderSmoke.mjs', // a fit-to-content view does not crop a miter tip or a diagonal square cap corner
  'test/lbStreamOvershootRenderSmoke.mjs', // streamGeometry: a road band whose edge curve overshoots its far cap draws, against the exact kernel, at the road's scale and past it
  'test/arcsJoinRenderSmoke.mjs', // stroke: SVG2 arcs line join (curved vs round/miter)
  'test/dashStrokeParitySmoke.mjs', // stroke: DASHED strokes vs Slug on the analytic route (deleting the stroke coverage RT left this path untested)
  'test/loopBlinnRenderDiffSmoke.mjs', // morphDraw: LB direct + route
  'test/leanShaderRenderDiffSmoke.mjs', // shaderPrograms: lean fill variants
  'test/variantFirstDefaultSmoke.mjs', // variantFirst is the default -- the first frame of every engine/route class (and later-appearing features, morphs, streams, sprites, instances) equals the settled picture, with an A/A control
  'test/instancedLeanFirstSmoke.mjs', // the first instanced draw uses the bundle's lean program (default), the opt-out the general one
  'test/instancedAsyncPixelGpuSmoke.mjs', // the frame drawn while the instanced specialization links equals the specialized frame (A/A control)
  'test/maskCodeSolidParityRenderSmoke.mjs', // carrying the optional mask code leaves solid pixels byte-identical (every program compiled fresh in both arms)
  'test/fillNormalizePolynomialGpuSmoke.mjs',
  'test/fillNormalizePointsGpuSmoke.mjs',
  'test/cpatchCubicAreaGpuSmoke.mjs',
  // The ordered area/seam split draws every scope of the unified stream and is the combined program's picture.
  'test/cpatchSplitScopesGpuSmoke.mjs',
  'test/cpatchSplitLedgerGpuSmoke.mjs', // actual area/primitive/stroke run attribution and warming parity
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
  'test/nativeImageRecolorSmoke.mjs', // native raster drawImage honors per-draw colorMatrix
  'test/groupAtlasRenderSmoke.mjs', // the group atlas draws the byte-identical picture of the per-group accumulators (9 cells x four engines) and matches Chrome 8x
  'test/groupFilterSkipRenderSmoke.mjs', // a filtered group served from its cached result without repainting its children draws what the repainting group draws (balanced OFF/ON arms with an A/A floor)
  'test/alphaSlotRenderSmoke.mjs', // faded instances that touch, each in a slot of the atlas and drawn together, paint what the layered accumulators paint (balanced OFF/ON arms with an A/A floor)
  'test/instancedFlatTintAlphaRenderSmoke.mjs', // recolored instance batches retain their group opacity
  'test/morphInvisibleOverrideRenderSmoke.mjs', // revealed invisible fills follow prepared morph geometry
  'test/groupAlphaRenderSmoke.mjs', // a draw's alpha is GROUP opacity: svg/control/old cells under four engines vs Chrome 8x box; instanced, loop, submit, handle and morph vs a hand fade; one paint-only leaf identical
  'test/zOrderSubmitSmoke.mjs', // frameLoop: submitBundle zOrder stacking + tiebreak
  'test/spriteRangeRouteSmoke.mjs', // drawSprite: a sprite SUBSET must paint one sprite on the LB route too, not the whole sheet
  'test/occlusionCullOverrideSmoke.mjs', // occlusionCull: a build-time cull must retire when an override moves/hides the occluder
  'test/fillRouteParityGpuSmoke.mjs', // fill route class: static art on the cover pass == unifiedFill:false pixel for pixel; a morph keeps the unified GPU-lerp route and equals the forced unified render; the static source pose stays on the cover pass
  'test/coverQuadBatchSmoke.mjs', // renderer: header-free VBO batches multi-shape draws into one drawArrays
  'test/opaquePrepassSmoke.mjs', // renderer: opaque overlap HSR keeps analytic AA pixels identical
  'test/opaquePrepassShapeCountSmoke.mjs', // renderer: prepass vs ordinary fill byte-identical for every shape count 6..48 (a hollow flipbook frame: prepass/fill depth ulp mismatch)
  'test/bundleInstancedSmoke.mjs', // instancedFill: drawBundleInstanced
  'test/bundleInstancedTintSmoke.mjs', // instancedFill: per-instance tint (fast path) + colorMatrix (loop fallback)
  'test/forcedPinNoPrimitiveGpuSmoke.mjs', // engine pins: physical GPU, never a Node-lane check
  'test/instancedFillPinnedDefinesSmoke.mjs', // pinned LB defines must link and actually draw instances
  'test/instancedCompactCacheSmoke.mjs', // instancedFill: retain compact meshes across alternating assets
  'test/spriteSheetSmoke.mjs', // drawSprites: drawSprite
  'test/bundleHandleCacheSmoke.mjs', // cacheDraw/staticCache: cache bake
  'test/staticCacheSmoke.mjs', // whole-asset + viewport-window bake/reuse and pan parity
  'test/staticCacheDynamicSmoke.mjs', // forced cache demotes for override/geometry changes
  'test/glStateAuditSmoke.mjs', // glState: pipeline-state shadow never diverges from the driver
  'test/annulusStrokeSmoke.mjs', // stroked circle -> closed-form annulus, identical to the band walk
  'test/cacheLbParitySmoke.mjs', // cacheDraw: a bake of an LB-routed bundle == its direct draw
  'test/sharedGroupCacheSmoke.mjs', // shared-group target ownership, adoption, and resize
  'test/filterVisualSmoke.mjs', // shaderPrograms: fe* filter programs
  'test/filterOwnerPaintRenderSmoke.mjs', // static solid FillPaint/StrokePaint inputs: 304 states within 1 byte of an independently authored rectangle
  'test/filterCompositeBackdropSmoke.mjs', // a filtered shape composites once, and stays inside its (nested / blend) group on both routes, against Chrome
  'test/filterPixelFixRenderSmoke.mjs', // the audited filter primitives match Chrome
  'test/filterScaleRenderSmoke.mjs', // every filter length follows the referencing element's transform (group, element, <use>, CSS, override) at Chrome (8x)
  'test/fillCancelledWindingRenderSmoke.mjs', // paths whose winding cancels or whose hulls hold another subpath's fill, pinned Loop-Blinn and CPatch at Chrome (8x)
  'test/basicShapeClipRenderSmoke.mjs', // CSS basic-shape clip-path and nested-<svg> clip-path at Chrome (8x), both routes
  'test/filterSubregionRenderSmoke.mjs', // primitive subregions, primitiveUnits objectBoundingBox and CSS filter functions / lists at Chrome (8x), both routes
  'test/filterLinearRenderSmoke.mjs', // color-interpolation-filters (the linearRGB default, per-primitive spaces, mixed chains, sRGB CSS functions) at Chrome (8x), both routes
  'test/filterLinearBlurRenderSmoke.mjs', // a lone linearRGB blur is the in-place kind-7 record: byte-equal to the graph it replaced, within bounds of Chrome (8x), both routes
  'test/filterLinearPrecisionRenderSmoke.mjs', // linearRGB shadows and blurs of dark content keep the levels, steps and values of the sRGB picture (a dark ramp keeps 49 levels, not 9)
  'test/filterOwnerGradientRenderSmoke.mjs', // gradient FillPaint / StrokePaint (linear, radial, spreads, obb/user units, transforms) vs Chrome (the element itself, or an feImage of the paint), both routes, and at 2^-20 / 2^20 times the size
  'test/feImageOrientationRenderSmoke.mjs', // an id-referenced feImage draws the right way up, square and 2:1, both routes, against Chrome
  'test/feImageMeetAspectRenderSmoke.mjs', // an feImage meet fit uses the region's own aspect, 2:1 and 1:2, both routes, against Chrome
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
  'test/filterPassParityRenderSmoke.mjs', // each filter/paint shader rewrite is within 1 LSB of the text it replaced, as one GPU pass
  'test/groupOverBlitRenderSmoke.mjs', // a normal group's src-over blit is within 1 LSB of the copy path it replaced and at Chrome, both routes and the static cache
  'test/groupLeafDepthSmoke.mjs', // a depth-claimed (translucent, blended) leaf renders the same in a group as out of one, both routes, against Chrome
  'test/feSpotLightConeSmoke.mjs', // an feSpotLight with no cone lights the surface, against Chrome
  'test/feCompositeArithmeticSmoke.mjs', // feComposite arithmetic runs on premultiplied channels, against Chrome
  'test/blurLargeSigmaSmoke.mjs', // blurs of sigma 12-100 reach their full width on both filter routes, against Chrome
  'test/turbulenceChromeSmoke.mjs', // feTurbulence is the spec at pixel centers, and no further from Chrome than Chrome is from it
  'test/filterGroupSmoke.mjs', // renderer: filtered shape INSIDE an opacity group
  'test/filterPassthroughAlphaSmoke.mjs', // filterGraph: in="SourceAlpha" on both routes
  'test/filterUnhandledNodeSmoke.mjs', // filterGraph: lean-build missing-handler fallback
  'test/nativeCircleArcSmoke.mjs', // fallback: full-sweep arc decode (circle/ellipse) survives the browser
  'test/cdnBrowserSmoke.mjs', // import-map CDN recipe in Chrome: shared registries across scripts, cross-origin worker blob recipe, shader asset URLs
  'test/vertexOnPixelCenterRenderSmoke.mjs', // fill: a pixel whose center is a vertex (rect corner, shared arc extremum) reads its exact area on the GPU
  'test/morphFullTurnReanchorRenderSmoke.mjs',
  'test/morphArcDirectionRenderSmoke.mjs',
  'test/morphArcSpecRenderSmoke.mjs', // arc morphs against Chrome animating d, 8x box-averaged, on every route
  'test/morphGradientSolidRenderSmoke.mjs', // a gradient morphing to a solid and back lands on each pose, against Chrome at 8x
  'test/filterRegionTurnedRenderSmoke.mjs', // a filter region under a turn or a skew is the turned rect, at any scale, against Chrome at 8x
  'test/maskOwnClipPathRenderSmoke.mjs', // clip-path on a <mask>: the spec's picture by default, Chrome's under compat chrome
  'test/morphRecordCompatibilityGpuSmoke.mjs',
  'test/aacPointsDisposeGpuSmoke.mjs',
  'test/colorMatrixSmoke.mjs', // shaderPrograms: colorMatrix program
  'test/morphCoverPoseGpuSmoke.mjs', // current raw curves on prepared-morph fallback
  'test/morphRouteSmoke.mjs', // morphDraw: GPU-resident morph route
  'test/morphIntervalSplitSmoke.mjs', // morphDraw: classification-changing morphs route via interval-split (no Slug)
  'test/lbMemBudgetSmoke.mjs', // morphDraw: projected-memory Slug gate (deny → Slug render; account; release on dispose)
  'test/morphGradientRouteSmoke.mjs', // morphDraw: composed gradient morph
  'test/lbMorphChainGateRenderSmoke.mjs', // 'auto' takes a morph whose interior faces its chains cannot serve to Slug; a pin keeps LB
  'test/lbMorphCornerNormalRenderSmoke.mjs', // an LB image morph's kind-10 corner normals are renormalized after the vertex lerp
  'test/morphGradientStopLayoutRenderSmoke.mjs', // a gradient pair packed one texel / two texels per stop tweens its stop colors on the GPU
  'test/isolationSmoke.mjs', // blend/composite
  'test/clipCoverageSmoke.mjs', // drawImages: deleteClipTexture / clip path
  'test/lbStreamGeometrySmoke.mjs', // streamGeometry: lightweight LB stream + handle/instanced
  'test/lbStreamSentinelSmoke.mjs', // streamGeometry: unservable section sentinel-skip
  'test/lbCurvedBandParitySmoke.mjs', // loopBlinn: curved road band fills vs Slug
  'test/lbRoadRingParitySmoke.mjs', // streamGeometry: full multi-band scrolling road vs Slug
  'test/lbBandCurveFlipParitySmoke.mjs', // refreshLoopBlinnMesh: rebuild when the concave edge flips ("wrong wedges")
  'test/lbStreamTeleportParitySmoke.mjs', // refreshLoopBlinnMesh: rebuild across slot-teleport structure jumps (road bands)
  'test/nativeStreamSmoke.mjs', // nativeStream: geometry+fills stream into the no-WebGL native scene
  // ── no-WebGL native fallback ────────────────────────────────────────
  // The fallback is the path that runs where WebGL doesn't, so it is the
  // LEAST likely to be caught by hand. Keep these gated.
  'test/nativeFallbackSmoke.mjs', // the broad one: retain, overrides, clip, morph, raster, sprites, text, timeline
  'test/nativeOpenStrokePaintMorphSmoke.mjs', // morph: an open contour stays open; a fill-opacity fade tweens
  'test/nativeGradientMorphSmoke.mjs', // morph: a matched shape's gradient params + stops tween, raster parity with the GL lerp
  'test/nativeMorphGroupRasterSmoke.mjs', // morph inside a transformed group / <use> / own transform / scaled stroke: pixels equal the browser's static pose
  'test/nativeDstRectRasterSmoke.mjs', // native dstRect vs the WebGL renderer's pixels, bundle and viewport spaces
  'test/nativeReconcilerSmoke.mjs', // DOM reconciliation across redraws
  'test/nativeRecolorSmoke.mjs', // per-draw recolor chain on the CPU mirror
  'test/nativeInstancedRecolorSmoke.mjs', // recolor through instanced draws
  'test/nativeBlendModeSmoke.mjs', // mix-blend-mode / isolation emission
  'test/nativeViewportSpaceSmoke.mjs', // viewport vs viewBox coordinate space
  'test/nativeDefIdCollisionSmoke.mjs', // <defs> id uniqueness across bundles
  'test/nativeClipDefLifecycleSmoke.mjs', // clip def create/reuse/release
  'test/nativeStationaryClipSmoke.mjs', // a clip that doesn't move must not re-emit
  'test/nativeMaskedShapeIndexSmoke.mjs', // mask → shape index mapping
  'test/nativeMaskGeometryMorphSmoke.mjs', // <mask> children animating via overrides
  'test/nativeTextMaskMorphSmoke.mjs', // text inside a morphing mask
  'test/nativeTextClipClearSmoke.mjs', // text clip teardown
  'test/nativeMorphInterpSmoke.mjs', // morph interpolation vs the GL lerp
  'test/nativeMorphAutoApplySmoke.mjs', // morph auto-apply on setTime
  'test/nativeMorphGroupOpacitySmoke.mjs', // the native morph fades a fill+stroke leaf as one element (.5->1, .5->.8, 1->.5)
  'test/nativeDstOnlyMorphSmoke.mjs', // morph where only the destination has the shape
  'test/nativeIdlessMatchedMorphSmoke.mjs', // morph matching without ids
  'test/nativeImageStretchSmoke.mjs', // raster stretch / preserveAspectRatio
  'test/nativeImageInstancedSmoke.mjs', // instanced raster draws
  'test/nativeMorphPerfSmoke.mjs', // morph frame cost stays bounded
  'test/incrementalStrokeSmoke.mjs', // incrementalStroke: dynamic paint stroke — O(1) appends, parity vs loaded-whole, dot/alpha, perf
  'test/incrementalStrokeTypesSmoke.mjs', // ...and it stores line/quad/cubic NATIVELY, matching the same curves sampled
  'test/incrementalStrokeArcMiterSmoke.mjs', // ...and a miter at a native ARC sizes its quad from the arc's real end directions
  'test/incrementalStrokeExactAaSmoke.mjs', // ...and it draws the exact-area AA edge on the renderer's toggle, as the static stroke does
  'test/incrementalStrokeLineExactSmoke.mjs', // ...and its LINE segments solve as lines, within the AA corner model of exact coverage
  // Static/morph analytic-fill feature parity — each renders a feature through
  // the LB route and asserts it matches Slug (the full unified feature set).
  'test/lbHandleInstancedParitySmoke.mjs', // _analyticRoute: static LB reaches handle.draw + instanced; cached handle stays on the cache
  'test/lbComposeOrderSmoke.mjs', // _drawBundleLoopBlinn: solid combined route resets uGradId/uImageId after a gradient draw (cross-shape uniform leak)
  'test/lbHoleParitySmoke.mjs', // _ensureLbMeshes: multi-contour curved-holed static shapes take the CDT partition path (static↔morph unification) — hole stays empty
  'test/lbDiagonalFrameParitySmoke.mjs', // _ensureLbMeshes: a thin diagonal opposite-winding FRAME (folded-corner page outline) routes multi-contour straight shapes to CDT so the earcut hole-bridge does not shatter the sliver
  'test/lbCuspHoleParitySmoke.mjs', // buildLoopBlinnCDT: a CUSP cubic in a curved-holed shape renders via exact Bezout (kind 4), not Slug
  'test/lbLoopParitySmoke.mjs', // a self-intersecting (loop) cubic correctly falls back to Slug (both fill rules) and renders identically
  'test/lbConcaveCubicParitySmoke.mjs', // concave/holed CUBIC shapes (C-notch, cubic ring, disjoint bars) render on LB matching Slug (curved→CDT + crescent adoption)
  'test/lbLensParitySmoke.mjs', // buildLoopBlinnCDT: a lens (two arcs sharing endpoints) has a degenerate chord ring → chordRing re-derives with midpoints so the fill sign isn't inverted
  'test/lbCircleSdfSmoke.mjs', // a filled circle → exact circular-SDF disc (kind 7), seam-free vs the ≤90° crescent seams; matches Slug at every boundary pixel
  'test/lbAnnulusSdfSmoke.mjs', // a cubic concentric RING → exact annulus SDF (kind 7); seam- AND wedge-free at small render scale
  'test/lbMorphEvenOddSmoke.mjs', // ...and an even-odd ring MORPHED: both poses must keep the hole
  'test/lbRibbonGateRenderSmoke.mjs', // ...and keeps its outer AA near the ring's extreme points: no px lighter than exact by >32 at 5 t
  'test/lbReadyPendingSmoke.mjs', // awaitLbReady waits for the off-thread build it started, not the meshes already resident
  'test/cpatchMorphServeSmoke.mjs', // route:'cpatch' draws a morph with CPatch, GPU blend and CPU pack, within 4 px of the exact pose
  'test/cpatchMorphMixedRowsGpuSmoke.mjs', // a CPatch morph with a mask, a group opacity, a gradient or a stroke draws the Slug morph's pose
  'test/cpatchMorphUnplannedRowsRenderSmoke.mjs', // a CPatch morph draws the glyphs CPatch leaves off its plan (counters, second pieces), after awaitLbReady too, and records their decline
  'test/cpatchMorphSwitchBackRenderSmoke.mjs', // a morph switched off a CPatch pin to the default route or to LB draws what a fresh renderer with that setting draws
  'test/cpatchMorphGpuBlendSmoke.mjs', // a CPatch morph drawn through the GPU blend matches the CPU pack, first posed frame included
  // These five launch Chrome too, so they gate here rather than in the fast Node lane.
  'test/cpatchArcScaleRenderSmoke.mjs', // CPatch draws the same arcs at any size of the art
  'test/evenOddCoincidentRenderSmoke.mjs', // a contour drawn twice under even-odd leaves no ring on the cover route
  'test/enginePeerSmoke.mjs', // every engine draws the same shape; the peers must agree on ink
  'test/lbAnnulusEvenOddSmoke.mjs', // an even-odd annulus keeps its hole through the SDF primitive path
  'test/lbConcaveCurveFillSmoke.mjs', // concave curved fills match Slug
  'test/lbHoleOrientScaleRenderSmoke.mjs', // a same-wound even-odd ring draws the same picture at every size
  'test/lbDegenerateCubicDropSmoke.mjs', // near-degenerate cubic pieces leave the mesh without a collapsed survivor
  'test/lbApexClipSmoke.mjs', // tiger declines (almost) nothing to Slug, and every shape is built
  'test/lbEllipticalRingParitySmoke.mjs', // a few-percent-elliptical ring (font o/O/0) must NOT be mistaken for a circle by the annulus SDF (fit checks on-curve MIDPOINTS + 0.01·r tol); rejected → accurate CDT, matches Slug
  'test/lbQuadSeamSmoke.mjs', // a non-circular quad ellipse: kind-1 crescent seams closed by conservative VS dilation (no undercount notch), texcoords carried along the affine map so the u²−v curve is unchanged
  'test/lbRquadSeamSmoke.mjs', // a non-circular <ellipse>: kind-5 rquad ARC crescent seams closed by the same conservative VS dilation (conic → safe extrapolation); notch gone, mean error −65%
  'test/lbConvexCurveFastPathSmoke.mjs', // routing: a single-contour opaque CONVEX curved shape takes the cheap earcut mesh (hasConcave flag), matching Slug; concave curves fall to CDT
  'test/lbTextParitySmoke.mjs', // textBundle: authoritative per-shape curve ranges → LB reconstructs glyphs correctly; 'auto' keeps text on Slug (perf)
  'test/loopBlinnMorphSmoke.mjs', // _analyticRoute: morph routes via the morph route, never the static route
  'test/lbGradientParitySmoke.mjs', // LB per-shape gradient fill vs Slug
  'test/worldMatrixPositionRenderSmoke.mjs', // a vertex lands where its em says under a world matrix of scale 2^20: every engine, a fresh compile and a program-cache hit
  'test/lbChainWorldMatrixSmoke.mjs', // LB chain coverage under a world matrix is translation-invariant and mirror-exact
  'test/lbTranslucentParitySmoke.mjs', // LB translucent solid via the coverage→composite path vs Slug
  'test/lbTranslucentOverlapParitySmoke.mjs', // translucent solids batch into the combined route (CDT partition, direct OVER) — overlapping shapes match Slug
  'test/lbClipParitySmoke.mjs', // LB clipped fill via the composed path vs Slug
  'test/lbMaskParitySmoke.mjs', // LB masked fill via the composed path vs Slug
  'test/unifiedNestedMaskRenderSmoke.mjs', // a mask nested in a mask draws at Chrome 8x on the cover pass, and the forced unified route equals it (nested cells are declined)
  'test/lbFilterParitySmoke.mjs', // LB inline-filter fill via the composed path vs Slug
  'test/lbStrokeParitySmoke.mjs', // LB fill + GPU stroke-coverage vs Slug
  'test/lbFillVariantCompileSmoke.mjs', // the ubershader hosts lbCoverage (MANTLE_LB_FILL links; cover quads unchanged)
  'test/unifiedFillCurveTexWideIndexSmoke.mjs', // >65,535 coefficient blocks stay on the narrow layout
  'test/unifiedFillCurveTexIdx32MorphSmoke.mjs', // a morph past the 16-bit index draws from the 32-bit layout, pixel-equal
  'test/unifiedFillCurveTexOverflowSmoke.mjs', // curve-block overflow (lowered limit) must switch stream AND program
  'test/unifiedFillDrawSmoke.mjs', // cover quads + LB triangles in ONE drawArrays, matching Slug
  'test/lbSeamPartitionSmoke.mjs', // unified route is rim-accurate (AA-union does not double-count)
  'test/unifiedFillFeatureSmoke.mjs', // the unified draw across the feature matrix: no RT, fewer draws, no worse than the RT route
  'test/engineDeclineIsolationSmoke.mjs', // CPatch and LB decline to SLUG, never into each other — the coupling that filed LB's timings under CPatch's name
  'test/cpatchTextSmoke.mjs', // CPatch renders TEXT through the ordinary draw path — the retry, the builder chain and the scale-relative validity bar
  'test/strokeAttributionSmoke.mjs', // a stroke row is reported as the STROKE path, not as the fill kernel that never ran on it
  'test/entryPointRouteSmoke.mjs', // drawBundle, handle.draw and drawBundleInstanced route a bundle to the same engine
  'test/unifiedMorphSmoke.mjs', // ...and for MORPHS: 0 coverage RTs across t, no worse than the RT route
  'test/unifiedFilterSplitSmoke.mjs', // an offscreen filter SPLITS the draw into runs instead of declining the bundle
  'test/lbKindOmitSmoke.mjs', // LB coverage componentized BY KIND (MANTLE_LB_NO_K7/10/13), output-identical
  'test/unifiedStrokeSmoke.mjs', // a STROKED bundle in one draw, no coverage RT
  'test/strokePartitionSmoke.mjs', // bisector ownership == MAX-union (so OVER can replace the stroke RT)
  'test/lbRecolorParitySmoke.mjs', // LB + per-draw recolor (colorMatrix/palette) via the composite path vs Slug
  'test/lbTransformOverrideParitySmoke.mjs', // LB + per-shape transform override → per-shape Slug fallback vs Slug
  'test/overrideMoveRenderSmoke.mjs', // an override-moved/rotated/scaled row, its clip and mask, on every route vs Chrome 8x
  'test/lbBlendParitySmoke.mjs', // LB + per-shape blend mode → per-shape Slug fallback vs Slug
  'test/lbPerShapeFallbackParitySmoke.mjs', // LB with a loop/cusp sentinel → per-shape Slug fallback vs Slug
  'test/optParitySmoke.mjs', // every optimization must be output-identical to the plain path
  'test/filterCacheHitSmoke.mjs', // a filter-cache HIT must paint what the MISS painted
  'test/filterFrameOriginSmoke.mjs', // a filtered draw must not displace the NEXT draw
  'test/textTransplantWarmSmoke.mjs', // setText's spent bundle shell must not reach the pipeline warmer
  'test/resolutionScaleSmoke.mjs', // setResolutionScale: fewer pixels, same screen, no stranded RTs
  'test/groupRectSmoke.mjs', // a group bounded to its content rect paints what the full-canvas one did
  'test/instancedFogSmoke.mjs', // a fog (diagonal matrix + offset) must stay on the instanced fast path
  'test/coincidentAaSmoke.mjs', // the occlusion cull (anti-conflation) must reach every render path
  'test/gwnCurveRangeSmoke.mjs', // a shape's curve range must end at its curves, not at the GWN tree
  'test/lbBuilderOwnershipSmoke.mjs', // a 2nd (Slug-only) renderer must not disarm LB's off-thread builder
  'test/engineSwitchIndependenceSmoke.mjs', // an engine must draw the same regardless of what ran before it
  'test/aaMonotonicSmoke.mjs', // AA must fall monotonically across an edge; aacFill must engage
  'test/lbSalientAaSmoke.mjs', // LB vs SS: no neighbor spikes / non-monotone / bad outliers (not MSE)
  'test/cuspFillSmoke.mjs', // a cubic's cusp fills solid to the tip (path.js splits it)
  'test/gwnEngineSmoke.mjs', // GWN+SDF renders + matches Slug; a GWN kernel with no run tree is EMPTY
  'test/debugOverlaySmoke.mjs', // showTriOutline draws on both routes, and shows the mesh actually submitted
  'test/occlusionCullSmoke.mjs',
  'test/morphOcclusionCullSmoke.mjs', // morphCull: a morph culls only what is hidden for every t (analytic, not sampled)        // bundle: a shape a later OPAQUE shape fully covers must not bleed through the AA edge (conflation)
  'test/lbTranslucentStripBlendSmoke.mjs', // LB: a TRANSLUCENT curved shape must not blend over ITSELF (curve strips co-covering the interior)
  'test/lbCubicOverfillSmoke.mjs',
  'test/lbQuadStripCoverageSmoke.mjs',
  'test/lbBand2Smoke.mjs', // unified curve band (kind 12): emission + quad-corner quality + no new artifacts
  'test/hitRenderAgreementSmoke.mjs', // hit testing answers from WHAT IS DRAWN: band-walk fill decision == rendered pixels (all seg types, both fill rules) + memo consistency
  'test/lbInteriorBudgetSmoke.mjs', // convex cubic rings: OVER over-fills overlapping hulls → partition
  'test/lbTranslucentSolidSmoke.mjs', // translucent solids ride the combined route under 'auto'
  'test/lbGradientBatchSmoke.mjs', // many DIFFERENT gradients in ONE combined draw (per-shape paint texture)
  'test/paintDerivUniformFlowSmoke.mjs', // pattern images, image children and gradient children match Chrome at seams: derivatives from uniform flow
  'test/gradientSeamBoxFilterSmoke.mjs', // REPEAT gradient seams box-filtered on both sides, exact while t is linear across the pixel
  'test/radialConeSmoke.mjs', // a radial whose focus is outside its circle draws the SVG 2 cone, edge box-filtered
  'test/importSpecChromeRenderSmoke.mjs', // a zero viewBox, a gradient on a shape with no box and a group's mask over a leaf's, against Chrome at 8x
  'test/objectBoundingBoxStrokeGradientRenderSmoke.mjs', // objectBoundingBox stroke gradients bind to the path-tight box on the GPU
  'test/strokeLocalFrameRenderSmoke.mjs', // a stroke under a non-conformal CTM is the image of its local stroke on the GPU
  'test/markerTransformRenderSmoke.mjs', // markers are placed in their path's space and transformed with it, against Chrome
  'test/markerAspectRenderSmoke.mjs', // marker viewBoxes fitted by preserveAspectRatio (and none without a viewBox), against Chrome
  'test/markerViewportClipRenderSmoke.mjs', // marker content clipped to its viewport unless overflow is visible, against Chrome
  'test/markerClipMaskRenderSmoke.mjs', // markers take the referencing path's clip-path and mask, against Chrome
  'test/maskRegionRenderSmoke.mjs', // a <mask>'s region (maskUnits x/y/width/height) cuts what it masks, vs Chrome 8x
  'test/importerSemanticsRenderSmoke.mjs', // importer-semantics cases render as their already-correct controls and differ from the uncorrected picture
  'test/svgTextImportRenderSmoke.mjs', // SVG <text> import: font-family lists, letter-spacing, underline metrics and trailing-space anchor render as their controls
  'test/spriteMorphApiRenderSmoke.mjs', // sprite/morph cases render as their literal controls and differ from the uncorrected picture
  'test/importerGeometryAuditRenderSmoke.mjs', // importer geometry cases render as their controls and differ from the uncorrected picture
  'test/strokeDashCapsRenderSmoke.mjs', // dash/cap shader cases render as their controls and differ from the uncorrected picture
  'test/strokeEndCandidateGpuSmoke.mjs', // the end-candidate gate (round/bevel/butt ends skipped) is byte-identical to evaluating every end: 8 path kinds x caps x joins x dash
  'test/strokeDashSeamRenderSmoke.mjs', // a closed dashed contour's seam renders as its already-correct control (one dash through it, caps where only one side is on) and differs from the uncorrected picture
  'test/strokeDashSeamChromeRenderSmoke.mjs', // dashed glyph outlines (O, B, 8) agree with Chrome 8x at stable interiors
  'test/strokeDashSeamMorphRenderSmoke.mjs', // a closed dashed contour morphs through its seam like a static import of each pose, CPU and GPU lerp
  'test/colorImageRenderSmoke.mjs', // compositing pixel cases (premultiplied raster filtering, feComposite lighter, none channel, color-mix) render as their controls and differ from the uncorrected picture
  'test/paintRowsRenderSmoke.mjs', // paint rows (radial fr, singular paint transforms, pattern strokes) against Chrome
  'test/groupIdRenderSmoke.mjs', // a group override on a bundle with NO hit-only rows equals the literal <g transform> control and Chrome 8x
  'test/hitOnlyAnimRenderSmoke.mjs', // a drawn child and a hit-only sibling move together under a group override; the hit tracks the drawn pixel
  'test/filterLeafGroupRenderSmoke.mjs', // a filter on a fill+stroke leaf / a <use> runs once over the composited element
  'test/compositingGroupRenderSmoke.mjs', // compositing cases render as their controls and differ from the uncorrected picture
  'test/droppedContentRenderSmoke.mjs', // a morph from or to an alpha-0 fill or stroke draws the authored picture at t (all kernels), and an override that gives an alpha-0 row a color draws it
  'test/keepHiddenRenderSmoke.mjs', // keepHidden: display:none / visibility cells against Chrome 8x, override reveal, width from zero, morphs from and to a hidden pose (all kernels)
  'test/morphGroupOpacityRenderSmoke.mjs', // a fill+stroke leaf morphs as one group (opacity .5->1, .5->.8, 1->.5, named and unnamed), equal to the authored pose and to Chrome 8x
  'test/maskGroupCostRenderSmoke.mjs', // a masked group's passes scissored to its rect draw the merged picture byte for byte
  'test/animationAuditRenderSmoke.mjs', // a rect -> diamond and a turning ellipse morph render as their literal poses
  'test/paintImageMaskAuditRenderSmoke.mjs', // paint/image/mask cases render as their controls and differ from the uncorrected picture
  'test/lbImageBatchSmoke.mjs', // <image> shapes batch too; image paint tints by white, not fill
  'test/slugExactEdgeAASmoke.mjs', // opt-in exact half-plane coverage for Slug's straight edges
  'test/slugQuadScaleSmoke.mjs', // stable quad-root pair: wide symmetric quads at large viewports (white-slit class)
  'test/noAaStrokeCoverSmoke.mjs', // hard-fill gate: only closed, later-stroked shapes may skip fill AA
  'test/nineSliceInstanceSmoke.mjs', // bundle.nineSliceInstance: per-DRAW nine-slice — two sizes of ONE bundle, undistorted corners, base unmutated, re-slice via same handle
  'test/nineSliceFilterSmoke.mjs', // nine-slice must stretch FILTERED shapes too (feDropShadow) — the filter-pass scissor must not clip to the native bbox
  'test/textBundleIdentitySmoke.mjs', // textBundle: identity-stable setText/setStyle — same bundle object, bound handles re-upload via _geomGen, matches a fresh-bundle render
  // ── general browser-lane smokes ─────────────────────────────────────
  // The morph route smokes are gated in the composed-morph section below.
  'test/aacBandSeamSmoke.mjs',
  'test/arcNonZeroSmoke.mjs',
  'test/bundleHandleDimensionsSmoke.mjs',
  'test/bundleHandleSmoke.mjs',
  'test/clipperAnimVisualSmoke.mjs',
  'test/colorPaletteSmoke.mjs',
  'test/dashCurveArcLenSmoke.mjs',
  'test/ellipseContourHairlineRepro.mjs',
  'test/ellipseHairlineSweepSmoke.mjs',
  'test/exportFrameSvgSmoke.mjs',
  'test/exportTextSvgSmoke.mjs',
  'test/filterBakeCacheSmoke.mjs',
  'test/filterCacheSmoke.mjs',
  'test/filterGraphWorldScaleSmoke.mjs',
  'test/filterWorldScaleSmoke.mjs',
  'test/font/textVisualHarness.mjs',
  'test/font/visualBreadth.mjs',
  'test/fourCubicEllipseHairlineSmoke.mjs',
  'test/instancedBlitSmoke.mjs',
  'test/instancedBundleRenderDiffSmoke.mjs',
  'test/lbGpuMorphSmoke.mjs',
  'test/lbTipSmoke.mjs',
  'test/maskAnimInlineSmoke.mjs',
  'test/maskAnimSmoke.mjs',
  'test/maskCacheSmoke.mjs',
  'test/maskBakePerHandleSmoke.mjs', // two masked handles drawn per frame keep their own layers: 0 re-bakes, not 2 a frame
  'test/morphGpuCurveLerpSmoke.mjs',
  'test/occupancyRenderDiffSmoke.mjs',
  'test/overrideDirtyBandSmoke.mjs',
  'test/overrideVisibilityFadeSmoke.mjs',
  'test/pathBooleanSilhouetteVisualSmoke.mjs',
  'test/pathBooleanSilhouetteImportSmoke.mjs',
  'test/patternTransformSmoke.mjs',
  'test/patternVisualSmoke.mjs',
  'test/patternUnitsRenderSmoke.mjs', // the same pattern cases against Chrome's native SVG rendering
  'test/patternShareRenderSmoke.mjs', // a shared (canonical-space) pattern paints what the per-size baked one did: alignments, slice/none, strokes, transform, nested, stroke paint, sub-pixel tile, morph, nine-slice
  'test/switchSystemLanguageRenderSmoke.mjs', // <switch> skips a child no user language matches, against Chrome
  'test/gradientManyStopsRenderSmoke.mjs', // a 600-stop gradient draws every stop (the importer kept 256), against Chrome
  'test/svgImageDocumentRenderSmoke.mjs', // an SVG <image> draws its document clipped, grouped, uninherited, nested, against Chrome
  'test/feImageExternalRenderSmoke.mjs', // an external feImage is fitted into its subregion and clipped to it, against Chrome
  'test/rectRxDropShadowRenderSmoke.mjs',
  'test/rendererReadyBaseline.mjs',
  'test/sceneToSectionsSmoke.mjs',
  'test/sceneVisualSmoke.mjs',
  'test/scissorRectSmoke.mjs',
  'test/shaderBuildSmoke.mjs',
  'test/shapeAnimationMaskWipeRepro.mjs',
  'test/shapeAnimationMultiCurveRepro.mjs',
  'test/shapeAnimationVisualSmoke.mjs',
  'test/shapeMorphDstOnlySmoke.mjs',
  'test/shapeMorphMaskFilterSmoke.mjs',
  'test/spriteMorphClipSmoke.mjs',
  'test/spriteMorphSmoke.mjs',
  'test/spriteTimelineSmoke.mjs',
  'test/staticCacheFilterSmoke.mjs',
  'test/streamGeometryRenderDiffSmoke.mjs',
  // Fat miter joins on a densely tessellated curve must not turn a round outline spiky.
  'test/strokeCubicOvershootSmoke.mjs',
  'test/strokeGatesExactSmoke.mjs', // uStrokeGates changes no pixel: saturation depth, AA reach of the reject/far/break
  'test/strokeReachGateSmoke.mjs', // the cubic and arc reach gates change no pixel: gates on == off, byte for byte
  'test/depthBitsQueryPerDrawSmoke.mjs', // the draw never queries DEPTH_BITS per draw: a synchronous GPU round trip
  'test/evictedHookDedupeSmoke.mjs', // one eviction hook per bundle, not one per eviction
  'test/strokeStripSmoke.mjs', // the strip cover (opt-in) loses no ink and never clips a stroke: width overrides, crossings, depth, morph, moved geometry
  // Opt-in exact-area AA on straight stroke edges (strokeExactAa).
  'test/strokeExactAaSmoke.mjs',
  'test/strokeBigCircleGpuSmoke.mjs', // physical GPU vs reference
  'test/strokeTypeOmitGpuSmoke.mjs', // specialized stroke kernels retain all curve types and morph poses
  'test/curveAngleSignedZeroGpuSmoke.mjs', // real axis, sector and winding expressions on GPU
  'test/strokeFootSignedZeroGpuSmoke.mjs', // a foot on the minor axis from the negative side keeps its coverage
  'test/strokeCapsJoinsVisualSmoke.mjs',
  'test/textSmallScaleDilationSmoke.mjs',
  'test/viewBoxOverhangSiblingSmoke.mjs',
  // ── composed-morph LB routing ───────────────────────────────────────
  // These assert that a morph carrying a stroke, mask, clip, filter or dash
  // takes the analytic route. The morph-pair mesh builds OFF-THREAD and every
  // draw uses Slug until the worker lands, so a single warm draw measures the
  // pre-build frame; each of these loops until the route engages, as
  // morphRouteSmoke does.
  'test/morphClipRouteSmoke.mjs',
  'test/morphComposedColorRouteSmoke.mjs',
  'test/morphDashMultiSubpathRouteSmoke.mjs',
  'test/morphFilterGraphRouteSmoke.mjs',
  'test/lbChainBorderGpuSmoke.mjs',
  'test/lbZeroRadiusArcGpuSmoke.mjs',
  'test/lbTranslucentGroupMorphGpuSmoke.mjs',
  'test/morphFilterCarryRenderSmoke.mjs',
  'test/morphGroupOpacityGpuSmoke.mjs', // the same morph on LB / CPatch / Slug / AAC, GPU and CPU lerp, against the authored pose and analytic samples
  'test/aacRotatedCoverReachGpuSmoke.mjs',
  'test/aacAffineCoverReachGpuSmoke.mjs', // a thin affine map's cover reaches every pixel its box touches
  'test/slugRotatedColdGpuSmoke.mjs', // a COLD default Slug fill under a rotated/sheared map draws the rotated program, exact to the area
  'test/aacAnisoCoverReachGpuSmoke.mjs', // an axis-aligned anisotropic map's AAC cover reaches every pixel its box touches
  'test/lbJointPixelGpuSmoke.mjs', // Loop-Blinn's joint pixel is ramped by the arc that cuts it
  'test/lbBandHookGpuSmoke.mjs', // the curve band on a rational quad that turns past a right angle: the 80:1 sliver pinned to Loop-Blinn against Chrome 8x and Slug
  'test/lbStaticFanGpuSmoke.mjs', // a simple convex translucent contour's interior is a fan: LB within 4 bytes of raw AAC
  'test/aacMorphGroupBoundsGpuSmoke.mjs',
  'test/cpatchMorphReadinessGpuSmoke.mjs',
  'test/coverProjectionScaleGpuSmoke.mjs', // scale-invariant actual cover support
  'test/linkRetryRenderSmoke.mjs', // on the GPU: a real link failure is not linked again in play, the next loading call links it, and the bundle draws what a healthy renderer draws
  'test/filterRegionDeepZoomRenderSmoke.mjs', // a filter region's edge past 2^31 px does not wrap: a flood stays painted at every zoom
  'test/cacheBlendBackdropRenderSmoke.mjs', // a bundle with a row that blends with what lies under it draws live under every cache strategy; a blend in an isolating group still caches
  'test/streamWarmRenderSmoke.mjs', // on the GPU: a declared stream, or a lightweight stream updated once before the loading call, links and builds nothing in play and draws its last update
  'test/monotoneCubicStatesRenderSmoke.mjs', // an external clip, a sprite range and a zero-scale row draw the plain picture of certified-monotone art, at several scales
  'test/instancedRaisedStrokeRenderSmoke.mjs', // an instanced draw under a table that raises a stroke paints the stroke drawBundle paints
  'test/standInsReuseGpuSmoke.mjs', // previous-variant reuse (standIns:false): the reused frame vs the needed engine's frame within tolerance at 256/1024/2048, no hole, no pop at the switch
  'test/psoWarmQueueGpuSmoke.mjs', // actual warm/first draw programs and budget continuation
  'test/auxWarmSamplerGpuSmoke.mjs', // the loading call's filter-helper warm draws are valid GL draws (no sampler-unit clash) and every helper is warmed
  'test/aacColdKernelGpuSmoke.mjs', // cold runtime AAC request retains kernel/affine footprint
  'test/cpatchMorphCertifiedFallbackGpuSmoke.mjs',
  'test/cpatchRationalMorphGpuSmoke.mjs',

  'test/morphFilterRouteSmoke.mjs',
  'test/morphMaskRouteSmoke.mjs',
  'test/morphOpenStrokeRouteSmoke.mjs',
  'test/splitStrokeBevelRouteSmoke.mjs',
  'test/splitStrokeCapRouteSmoke.mjs',
  'test/splitStrokeDashRouteSmoke.mjs',
  'test/splitStrokeGradientRouteSmoke.mjs',
  'test/splitStrokeMiterRouteSmoke.mjs',
  'test/splitStrokeNonScalingRouteSmoke.mjs',
  'test/splitStrokeRouteSmoke.mjs',
  'test/morphTranslucentRouteSmoke.mjs',
  // Image-painted morphs. The morph-pair program must set uImageAtlasSize like
  // every other image uniform: left at 0, sampleImageLB scales the atlas UVs by
  // the slot size instead of dividing by the atlas size, everything past the
  // first 1/atlasWidth of the shape clamps to the atlas edge, and the shape
  // paints that color flat.
  'test/morphImageRouteSmoke.mjs',
  'test/splitStrokeImageRouteSmoke.mjs',
  // An ungated test is silent, not red: every browser smoke in test/ belongs in
  // a runner list.
  'test/channelLerpSmoke.mjs',
  'test/circleObbAxisAlignedSmoke.mjs',
  // A stroked shape's FILL row must keep the path-tight bbox: the tagged-
  // primitive SDF reads the shape out of it, so a stroke-padded one would make a
  // stroked circle flood its cover quad with fill.
  'test/primStrokedBboxSmoke.mjs',
  // objectBoundingBox units resolve against the GEOMETRY box (SVG 1.1 §7.11),
  // not the stroke-padded coverage box.
  'test/objectBboxStrokeSmoke.mjs',
  'test/font/colrV1VisualSmoke.mjs',
  // COLRv1 transforms, skew, conical radial gradients, hit table, edge softness -- fontTools fonts against
  // Chrome-rasterized outlines and the analytic cone rule.
  'test/font/colrSpecRenderSmoke.mjs',
  // COLRv1 ClipList (base glyph, PaintColrGlyph, nested, rotated, ranges, format 2 var) against Chrome clipping the box outline.
  'test/font/colrClipRenderSmoke.mjs',
  // Bbox-sized filter RTs must be byte-identical to canvas-sized ones. Also the
  // gate for fragment-quad parity: an odd RT origin shifts derivative
  // quads and breaks edge AA on shape corners.
  'test/filterBboxRenderDiffSmoke.mjs',
  // The two memory-heavy async smokes (off-thread LB builds + the async occlusion
  // cull). They are sensitive to HOST MEMORY PRESSURE, not suite load — they fail
  // standalone under a full swap and pass in ~3s on a healthy host. Their internal
  // budgets are already generous. If one times out here, check free swap before
  // looking for a code cause.
  'test/occupancyAsyncSmoke.mjs',
  'test/cpatchAutoGpuSmoke.mjs',
  'test/cpatchConversionSupersedeGpuSmoke.mjs',
  'test/cpatchOccupancyGpuSmoke.mjs', // actual worker replies preserve live CPatch coefficients and translucent output
  'test/colorMatrixDepthClaimGpuSmoke.mjs', // alpha-changing recolor retains single ownership and mutable state
  'test/recolorFoldPixelGpuSmoke.mjs', // the one recolor program of a bundle declared both ways draws the lean programs' pixels
  'test/contextGenerationGpuSmoke.mjs', // real restoration, late disposal, shared caches and worker resources
  'test/translucentDepthClaimGpuSmoke.mjs', // low and nearly opaque pieces retain single ownership
  'test/treeGridAsyncSmoke.mjs',
  // feTurbulence stitchTiles: the noise must join itself at the tile border.
  'test/turbulenceStitchSmoke.mjs',
  // Per-row hard fill (MANTLE_HARD_MIXED): stroke-covered fills drop their AA
  // individually instead of all-or-nothing per bundle. Must stay byte-identical.
  'test/mixedHardFillSmoke.mjs',
  // paint-order="stroke" paints the stroke under the fill AND still batches into
  // one draw (the rows are emitted in paint order, not swapped afterwards).
  'test/paintOrderStrokeSmoke.mjs',
  // Occlusion culling considers STROKE rows (they carry fill alpha 0, so a test of
  // fill alpha alone would never look at them). Includes the near-miss cases that keep
  // the error on the safe side: a band poking past the occluder, and a miter spike
  // reaching beyond the row's halfW-padded bbox.
  'test/strokeOcclusionCullSmoke.mjs',
  // An explicit objectBoundingBox <filter> region clips the output. The control
  // case (no region) must still leak, or the test measures nothing.
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
  'originRenderSmoke.mjs': 900000,
  'basicShapeClipRenderSmoke.mjs': 600000,
  'filterOffCanvasRenderSmoke.mjs': 900000,
  'filterSubregionRenderSmoke.mjs': 600000,
  'filterScaleRenderSmoke.mjs': 900000,
  'filterLinearRenderSmoke.mjs': 600000,
  'morphGroupOpacityGpuSmoke.mjs': 900000,
  'morphGroupOpacityRenderSmoke.mjs': 600000,
  'filterLinearBlurRenderSmoke.mjs': 600000,
  'filterOwnerGradientRenderSmoke.mjs': 900000,
};
const capFor = (abs) => Math.max(PER_TEST_MS, CAP_OVERRIDE_MS[path.basename(abs)] || 0);
const run = (abs) => {
  const t0 = Date.now();
  const cap = capFor(abs);
  const r = spawnSync(process.execPath, [abs], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: cap,
    killSignal: 'SIGKILL',
    env: { ...process.env, RENDER_TEST_TIMEOUT_MS: String(cap) },
  });
  return { r, ms: Date.now() - t0 };
};
const fmt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');

// REAP THE BROWSERS A KILLED TEST LEAVES BEHIND. The per-test cap above stops one hang from eating
// the lane; it does not stop the lane from getting SICKER as it runs, because SIGKILLing a test
// orphans the browser it launched. Orphans accumulate over a long lane — not CPU starvation, just
// browsers holding resources — and the worker-dependent smokes are the first to hang once they do
// (see the retry comment below: "after ~200 browser launches the worker-dependent smokes start
// timing out in setup").
//
// An orphan is identifiable rather than guessed at: when its node parent dies the browser is
// reparented to PID 1, while a browser still in use has a live parent. So this kills only
// `Chrome for Testing` processes whose PPID is 1, which cannot be one another test is using.
// RENDER_NO_REAP=1 turns it off.
const reapOrphanBrowsers = () => {
  if (process.env.RENDER_NO_REAP) return 0;
  try {
    const ps = spawnSync('/bin/ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8' });
    if (ps.status !== 0 || !ps.stdout) return 0;
    let n = 0;
    for (const line of ps.stdout.split('\n')) {
      if (!line.includes('Chrome for Testing')) continue;
      const m = line.trim().match(/^(\d+)\s+(\d+)\s/);
      if (!m || m[2] !== '1') continue;
      try {
        process.kill(+m[1], 'SIGKILL');
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
// GPU THROTTLE. Back-to-back smokes keep the GPU saturated for the whole lane, which can starve the
// desktop compositor (WindowServer on macOS) until the UI freezes or the machine goes down. Rest the
// GPU between smokes: MANTLE_GPU_REST_MS (default 1500) of idle after
// each one, so the desktop keeps compositing. 0 disables it.
const GPU_REST_MS = Math.max(0, +(process.env.MANTLE_GPU_REST_MS ?? 1500) || 0);
// ADAPTIVE REST. The rest exists for sustained GPU load, and a smoke that finished in under FAST_SMOKE_MS spent that
// time launching a browser, not saturating the GPU: after it the rest is MANTLE_GPU_REST_FAST_MS (default 600) instead
// of the full 1500 -- most smokes finish in under 8 s, so this gives back several minutes per lane while every
// smoke that actually loads the GPU still rests the full time. MANTLE_GPU_REST_FAST_MS=full-rest value disables it.
const FAST_SMOKE_MS = +(process.env.MANTLE_GPU_FAST_SMOKE_MS ?? 3000) || 0;
const GPU_REST_FAST_MS = Math.min(
  GPU_REST_MS,
  Math.max(0, +(process.env.MANTLE_GPU_REST_FAST_MS ?? 600) || 0),
);
let lastSmokeMs = Infinity;
const gpuRest = () => {
  const ms = lastSmokeMs < FAST_SMOKE_MS ? GPU_REST_FAST_MS : GPU_REST_MS;
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
for (const rel of SELECTED) {
  if (done) gpuRest();
  const abs = path.join(ROOT, rel);
  process.stdout.write(`\n▶ ${rel}\n`);
  let { r, ms } = run(abs);
  lastSmokeMs = ms;
  // spawnSync reports a timeout kill as an ETIMEDOUT error with a null status.
  const timedOut = (x) => x.error && x.error.code === 'ETIMEDOUT';
  if (timedOut(r)) {
    process.stdout.write(
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
  if (r.status !== 0 && r.status !== SKIP_EXIT) {
    process.stdout.write(
      `  ↻ retrying ${rel} (first attempt ${timedOut(r) ? 'HUNG' : 'exit ' + (r.status === null ? (r.signal === null && r.error ? 'did not start: ' + (r.error.code || r.error.message) : 'signal ' + r.signal) : r.status)})\n`,
    );
    const again = run(abs);
    r = again.r;
    ms += again.ms;
    if (timedOut(r)) {
      process.stdout.write(`  ⏱ HUNG on retry too\n`);
      if (!hung.includes(rel)) hung.push(rel);
    }
    if (r.status === 0) flaky.push(rel);
  }
  timings.push([rel, ms]);
  const reaped = reapOrphanBrowsers();
  if (reaped) {
    reapedTotal += reaped;
    process.stdout.write(`  ♻ reaped ${reaped} orphaned browser(s)\n`);
  }
  done++;
  // Live pace, so a lane that is falling behind says so DURING the run rather than by overrunning
  // its caller's budget at the end.
  const elapsed = Date.now() - started;
  const eta = Math.round(((elapsed / done) * (SELECTED.length - done)) / 1000);
  process.stdout.write(
    `  ⧗ ${fmt(ms)}${ms >= SLOW_MS ? '  SLOW' : ''}` +
      `   [${done}/${SELECTED.length}, ${Math.round(elapsed / 1000)}s elapsed, ~${eta}s left]\n`,
  );
  if (r.status === SKIP_EXIT) skipped.push(rel);
  else if (r.status !== 0)
    failed.push(
      `${rel} (${timedOut(r) ? 'HUNG' : 'exit ' + (r.status === null ? (r.signal === null && r.error ? 'did not start: ' + (r.error.code || r.error.message) : 'signal ' + r.signal) : r.status)})`,
    );
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
