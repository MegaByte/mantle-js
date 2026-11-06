#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// CPU production-code tests and static/API checks. Shader models run separately.
import { runNodeChecks } from './runNodeChecks.mjs';
const SMOKES = [
  'test/spdxHeaderSmoke.mjs',
  'test/exitDeadlockRunnerSmoke.mjs', // a smoke deadlocked in process.exit is counted by the code it asked for: no timeout, no retry
  'test/strokeWalkSiteBudgetSmoke.mjs', // the stroke walk is compiled once per call site: sites per variant, one entry, source budget (cold pipeline cost)
  'test/memoryLedgerSmoke.mjs', // getMemoryStats(): GPU bytes exact against a spy on texImage2D / texImage3D / texStorage / bufferData / renderbufferStorage, per category and bundle, zero after dispose
  'test/memoryBudgetSmoke.mjs', // memoryBudgetBytes: eviction order, nothing in use evicted, optional resources refused with one warning, budget respected at frame ends, preparation brackets
  'test/glStateLifetimeSmoke.mjs',
  'test/turbulenceLatticeSmoke.mjs',
  'test/gradientTablePackingSmoke.mjs',
  'test/scaleRangeSmoke.mjs', // fallback path data, miter-limit reach ceiling, sub-ulp gradient vectors, scene arc guard and self-overlap resolve at 2^-40..2^40
  'test/obbGradientRowsSmoke.mjs', // every rotated/skewed objectBoundingBox carrier gets its own placement row at any count (no 2048 cap)
  'test/tableLayoutSmoke.mjs', // per-item tables wrap in 4096-row bands; GLSL helpers == JS map; no raw fetch; the hard check's message
  'test/cpatchConversionSupersedeSmoke.mjs',
  'test/fillCancelledGeometrySmoke.mjs', // builders on geometry that cancels or coincides: no hairline mesh, an empty CPatch pack, one walk per coincident edge, a bounded fast resolve
  'test/cpatchCycleAreaSmoke.mjs', // extracted cycles that certify take the complete-paint area; node coordinates snap by a few ulps of the paint's scale
  'test/cpatchAreaGateSmoke.mjs', // the area cost gate -- a complete-paint area over 3e6 curve-pixels of box yields its cover quad, decided in device pixels
  'test/lbPipeSceneOverflowSmoke.mjs',
  'test/trackedCleanSmoke.mjs',
  'test/exportOverridesSmoke.mjs', // fill+stroke rows, composed local transforms, non-finite numbers
  'test/nativeMorphGroupSpaceSmoke.mjs', // a native morph draws in the coordinates of the element it lands on (groups, own transform, <use>, stroke width, overrides)
  'test/staticCacheMorphHashSmoke.mjs', // the static-cache draw-state hash covers a morph t without the optional hook
  'test/bakeDeferredClassSmoke.mjs', // filter caches, the mask slot and the static cache refuse an incomplete (deferred) result; a kept blank bake would draw black where the deferred fill belongs
  'test/opaquePrepassOptOutSmoke.mjs', // the opaque prepass runs by default; opaquePrepass:false opts out; it is off for a nine-sliced bundle
  'test/opaquePrepassMeshCacheSmoke.mjs', // one prepass mesh per bundle: several bundles per frame upload no plan; one bundle holds one plan; budget evicts idle meshes, refuses one that does not fit
  'test/instancedSpriteRangeSmoke.mjs', // the instanced fast path draws only a sprite's rows
  'test/occlusionCullListRefreshSmoke.mjs', // the uncut draw list follows applyNineSlice and the full stream rebuild
  'test/occlusionCullRetiredSmoke.mjs', // a cull an override or a sprite draw retired stays retired (late worker cull, kill-switch tick, instanced route, a kept row's reveal)
  'test/coverLayoutDrawListSmoke.mjs', // a handle lays its cover buffer out for its draw list: a culled row does not split the cover draw, the draws read the listed vertices, only the moved span uploads
  'test/nativeDstRectSmoke.mjs', // native drawBundle dstRect/fit/clipToRect place the content bbox where WebGL does
  'test/exportIsolationSmoke.mjs', // scoped CSS, stripped active content, deterministic ids, shared instances
  'test/exportReplaySmoke.mjs', // scissor and node-clip replay, recovered text anchors, declined image draws
  'test/sceneSurfaceSmoke.mjs', // toScene memo, native args, sceneToSections parity, scene numbers, wire validation
  'test/readmeSamplesSmoke.mjs', // the README samples run
  'test/browserSafeImportsSmoke.mjs', // no literal Node builtin specifier in src; the three decompress paths
  'test/shaderLoadPathsSmoke.mjs', // fromPackage/loadShaders bundled default, file: via fs, loud URL failures, no loadShadersSync
  'test/workerConfigSmoke.mjs', // configureWorkers disables/relocates workers; readable worker error text
  'test/importSpecEdgesSmoke.mjs', // a zero viewBox disables rendering; marker content; selector backtracking, style media and type, non-ASCII identifiers; concurrent compat; a fallback for an unusable gradient
  'test/importTextElementSmoke.mjs', // text: blend and isolation, paint-order, <a>, elements that do not render, a url() to nothing, objectBoundingBox references
  'test/importDefContentSmoke.mjs', // clip and mask content keeps what it inherits and matches when the def is folded; a binary mask over a leaf that names a mask
  'test/importLeafCascadeSmoke.mjs', // blend, isolation, vector-effect, filter and paint-order on a leaf read the whole cascade; initial and unset; a group row does not widen the box
  'test/importAuthoredNamesSmoke.mjs', // names that spell Object.prototype members are data; a sprite allow-list keeps a kept sprite's clip and mask; a group over a very long path
  'test/hitSpriteSmoke.mjs', // hit tests take a sprite id or [first, last] range
  'test/morphHitBitsOneSidedSmoke.mjs', // a morph with a table-less side keeps that side's rows targetable
  'test/viewCullMorphTrimSmoke.mjs', // a morph draw never view-cull-trims (rows move between poses)
  'test/metaHeaderTagSmoke.mjs', // the meta header carries a magic and a version word
  'test/originSmoke.mjs', // the per-bundle origin: float32 store at 1e4..1e8, header v3, corpus under forced origins, overrides pivot, morph/stream/scene, converter input
  'test/readmeTypesSmoke.mjs', // every documented sample type-checks under strict against the published declarations
  'test/bundleSizeClaimsSmoke.mjs', // every documented bundle size is marked, measured and within 20%
  'test/tarballContentsSmoke.mjs', // npm pack contents (must-have / must-not-have), no private reference, NOTICE/UCD truth
  'test/consumerInstallSmoke.mjs', // pack + install into a scratch consumer, import every exports subpath, fromPackage in Node, TS consumer
  'test/nativeEntrySmoke.mjs', // @kontek/mantle/native reaches no GL module (graph + bundle metafile), draws in node with no WebGL, webgl backend throws naming the import
  'test/missingRegistrationSmoke.mjs', // a feature used without its registration throws/warns naming the exact import (renderer features, filter/COLR nodes, scripts, bidi, readers, SVG-in-OT)
  'test/buildMatrixSmoke.mjs', // usage matrix: minimal entries reach only what they use; sizes within 8% of test/data/buildMatrix.json; relations; rollup/webpack/Vite when installed
  'test/importMapSmoke.mjs', // the generated import map covers every export and every specifier in src
  'test/cdnComposeSmoke.mjs', // two games on one CDN-served unbundled package share one registry/pool set; separately bundled copies stay independent and say so
  'test/smokeAssetsFreshSmoke.mjs',
  'test/rendererTypesGateSmoke.mjs',
  'test/morphCullCertifierSmoke.mjs',
  'test/occlusionCullEvenOddSmoke.mjs',
  'test/occlusionCullSmallHoleSmoke.mjs',
  'test/imageExportInstancedSmoke.mjs',
  'test/nodeClipBundleDisposeSmoke.mjs',
  'test/incrementalStrokeDotNanSmoke.mjs',
  'test/streamFillsCheckSmoke.mjs',
  'test/imageWorldMatrixCheckSmoke.mjs',
  'test/occlusionCullScaleInvariantSmoke.mjs',
  'test/occlusionCullPerturbationSmoke.mjs',
  'test/strokeSubpathTouchSmoke.mjs',
  'test/strokeDashSeamHitSmoke.mjs', // the CPU stroke hit test agrees with the SVG 2 oracle at the seam of a closed dashed contour (straight edges exact; curves reported)
  'test/strokeDashSeamMorphSmoke.mjs', // a morph of a closed dashed contour writes the contour's length (-L) with each pose's startDists, as a fresh import of the pose does
  'test/spriteMorphApiSmoke.mjs', // sprite/morph: nine-slice hits + options, submit copy + zOrder, sprite ids, morph chain, streaming input, override table, cull retire, prepare
  'test/perfRowsSmoke.mjs', // the SVG-image document budget (loader and data: fan-out), 20000 gradients fit the wrapped table
  'test/strokeInkBBoxSmoke.mjs', // globalBBox holds miter tips and square-cap corners; the row bbox and the wire sections do not move
  'test/importerGeometryAuditSmoke.mjs', // importer geometry: records, dash table, clamp, LB decline, GWN marker
  'test/filterLeafGroupSmoke.mjs', // a filtered fill+stroke leaf and a <use filter> are one group (the filter runs once)
  'test/compositingGroupSmoke.mjs', // compositing: a mask on a group, markers under the element's opacity / filter / mask, context paints
  'test/singularPaintTransformSmoke.mjs', // a gradientTransform / patternTransform with no inverse is no paint server: the url() fallback, else nothing
  'test/radialFrSmoke.mjs', // radial gradient fr: record encoding in the spread slot, the two-circle solver against brute force
  'test/patternStrokeSmoke.mjs', // a vector pattern as a stroke paint is the pattern masked by the stroked outline; unsupported cases paint the fallback
  'test/patternShareSmoke.mjs', // pattern content that depends on the referencing box is stored once (canonical space; each carrier an ordinary pattern in it): O(1) rows, the control's picture in tile units, no flag
  'test/atlasDedupeSmoke.mjs', // one picture embedded by several <image> elements decodes once and shares one atlas region
  'test/useBudgetSmoke.mjs', // the <use> expansion budget (maxUseInstances): a doubling chain is refused loudly, exact boundary, option validation
  'test/maskGroupCostSmoke.mjs', // a masked group's accumulator, masked copy and composite stay inside the rect it paints (pass counts and scissors on the fake GL)
  'test/fillNormalizePerturbationSmoke.mjs',
  'test/lbTransformRawFieldsSmoke.mjs',
  'test/unifiedFillVertsSmoke.mjs',
  'test/curveCoefUnitMaskSmoke.mjs',
  'test/graphDegenerateSmoke.mjs',
  'test/cpatchBoundarySmoke.mjs',
  'test/lbSharedApexContourSmoke.mjs',
  'test/lbShapePolicySmoke.mjs',
  'test/lbPartialAdoptionSmoke.mjs',
  'test/lbPrepareRoutesSmoke.mjs',
  'test/lbDeclineCensusSmoke.mjs',
  'test/lbWorkerPoolCauseSmoke.mjs',
  'test/lbShapeMemBudgetSmoke.mjs',
  'test/lbBuildGateSmoke.mjs',
  'test/engineSelectionTermsSmoke.mjs',
  'test/engineSwitchPathsSmoke.mjs',
  'test/forcedCoverNoPrimitiveSmoke.mjs',
  'test/strokeExactOptInSmoke.mjs',
  'test/lbHookOwnershipSmoke.mjs',
  'test/fillPrewarmOwnershipSmoke.mjs',
  'test/bundleDisposeForgetsPrewarmSmoke.mjs',
  'test/shapeMorphSourceReleaseSmoke.mjs',
  'test/morphSourcePrewarmSmoke.mjs',
  'test/filterPoolTrimSmoke.mjs',
  'test/curveBuf32Smoke.mjs', // texel-buffer storage is memory-only: float32 curve and band buffers, any starting capacity and dropping the curves64 twin leave every other wire section byte-identical
  'test/unifiedNarrowDirectSmoke.mjs',
  'test/psoWarmQueueSmoke.mjs',
  'test/fillUsageRegistrationSmoke.mjs',
  'test/fillBezoutOmitSmoke.mjs',
  'test/submitQueueAllocSmoke.mjs',
  'test/autoSceneDepthAttribSmoke.mjs',
  'test/rememberFailedWebglSmoke.mjs', // a failed WebGL start is remembered per GPU and browser, so the next load starts native at once
  'test/lbAdoptIntegritySmoke.mjs',
  'test/aacBandLevelsSmoke.mjs',
  'test/lbWorkerWireParitySmoke.mjs',
  'test/lbAirFaceCrescentSmoke.mjs',
  'test/lbNotchAirFaceSmoke.mjs',
  'test/lbHolePieceFaceSmoke.mjs',
  'test/lbPartitionConformSmoke.mjs',
  'test/lbQuadHullCrossSmoke.mjs',
  'test/lbPairBadFaceSplitSmoke.mjs',
  'test/lbPairQuadHullSplitSmoke.mjs',
  'test/lbPairCubicPlanSmoke.mjs',
  'test/lbMorphPairDeclineCensusSmoke.mjs',
  'test/lbInkProbeExactSmoke.mjs',
  'test/lbPairOrientationSmoke.mjs',
  'test/lbKlmnRowsSmoke.mjs',
  'test/lbOpenContourSmoke.mjs',
  'test/lbMorphGroupMetadataSmoke.mjs',
  'test/lbBandFootprintSmoke.mjs',
  'test/bandSegmentCountBoundSmoke.mjs',
  'test/smallRadiusAaSmoke.mjs',
  'test/sourceTextSmoke.mjs',
  'test/testLaneBackendSmoke.mjs',
  'test/ucdFixturePinSmoke.mjs',
  'test/coverKernelSmoke.mjs',
  'test/coverKernelPresenceSmoke.mjs',
  'test/variantFirstOptInSmoke.mjs',
  'test/universalProgramsSmoke.mjs', // no universal program (fill base, AAC base, instanced base + AAC, drawImage pair) in a default session; the options that can draw one build it; need-miss policy; the base fill program is not built at createRenderer unless an option can draw it
  'test/warmPolicySmoke.mjs', // the warm policy: likelihood order, game start/resize/end, declared needs and need misses, API reach (every public mutation API vs the variant-key axes)
  'test/warmBuiltSetSmoke.mjs', // the guard: after the loading call every draw state binds a program built in the loading window (as drawn, recolor asserted; rotated states listed as an open gap)
  'test/aacPresenceSmoke.mjs',
  'test/fillRouteClassSmoke.mjs',
  'test/cpatchCurveCutSmoke.mjs',
  'test/cpatchMorphPlanSmoke.mjs',
  'test/cpatchMorphCertificationSmoke.mjs',
  'test/cpatchRationalCertificateSmoke.mjs',
  'test/cpatchMorphPlanCostSmoke.mjs',
  'test/cpatchMorphPlanBoundSmoke.mjs',
  'test/cpatchMorphBlendStateSmoke.mjs',
  'test/cpatchPinnedRationalQuadSmoke.mjs', // a pinned CPatch build packs native arcs (rational quads); the auto policy still declines
  'test/cpatchTraceSmoke.mjs',
  'test/cpatchConvStallSmoke.mjs',
  'test/cpatchPoolWarmReadinessSmoke.mjs',
  'test/debugHookGateSmoke.mjs', // test hooks change output only under __MANTLE_DEBUG__, on the main thread and through the worker pools; the fillDefines option too, with one warning when dropped
  'test/workerFlagsSmoke.mjs',
  'test/switchCensusSmoke.mjs',
  'test/sharedRendererOptionsSmoke.mjs',
  'test/rendererUnknownOptionSmoke.mjs',
  'test/cpatchBezoutCriticalSmoke.mjs',
  'test/font/hitTestSmoke.mjs', // bbox hit mode: topmost wins, fillHits order, minAlpha, the opts-object form and worldMatrix
  'test/font/coverageHitSmoke.mjs',
  'test/font/robustnessSmoke.mjs',
  'test/font/hvarlessAdvanceSmoke.mjs',
  'test/font/gvarIupSmoke.mjs',
  'test/font/ligatureMarkSmoke.mjs',
  'test/font/bidiConformanceSmoke.mjs',
  'test/font/nfcConformanceSmoke.mjs',
  'test/font/breakConformanceSmoke.mjs',
  'test/font/textLayoutAuditSmoke.mjs', // per-cluster NFC, UAX #14 wrap, hard breaks, per-paragraph alignment, rebuild race, emoji clusters, vertical wrap, line scale, letter-spacing, space fallbacks, glyph budget, validation (hb-shape values frozen in test/fixtures/text-layout-hb.json)
  'test/font/gsubNestedShiftSmoke.mjs',
  'test/shaderGeneratedFreshSmoke.mjs',
  'test/featureSetSmoke.mjs', // FeatureSet inventory, and the tracked paint fixtures carry their row types on curves
  'test/svg/filterBboxReachSmoke.mjs',
  'test/svg/filterRouteSmoke.mjs',
  'test/svg/filterOwnerPaintImportSmoke.mjs',
  'test/svg/filterOwnerGradientImportSmoke.mjs',
  'test/svg/filterLinearBlurImportSmoke.mjs',
  'test/filterOwnerPaintCostSmoke.mjs',
  'test/svg/closeDeterminismSmoke.mjs',
  'test/svg/malformedAttrSmoke.mjs',
  'test/svg/cssDeclarationSmoke.mjs',
  'test/svg/lengthUnitsSmoke.mjs',
  'test/svg/paintImageMaskAuditSmoke.mjs',
  'test/svg/paintReferenceSmoke.mjs',
  'test/svg/markerPlacementSmoke.mjs',
  'test/svg/markerContentSmoke.mjs',
  'test/svg/useSwitchGroupSmoke.mjs',
  'test/svg/cssTransformSmoke.mjs',
  'test/svg/filterSemanticsImportSmoke.mjs',
  'test/svg/structureSemanticsSmoke.mjs',
  'test/svg/cssSpecificitySmoke.mjs',
  'test/svg/curvatureSmoke.mjs',
  'test/svg/degenerateArcSmoke.mjs',
  'test/workerFallbackSmoke.mjs',
  'test/staticCacheDynamicStateSmoke.mjs',
  'test/textStyleWeightSmoke.mjs',
  'test/markupSpacingSmoke.mjs',
  'test/rendererModuleContractSmoke.mjs',
  'test/lbPackReuseSmoke.mjs', // a frame packed over the last frame's buffer equals a fresh pack: no stale second chain
  'test/lbCpatchScaleEquivarianceSmoke.mjs',
  'test/lbUnderCoverAnnulusSmoke.mjs',
  'test/lbMeshCacheExactKeySmoke.mjs',
  'test/lbPrepareWorkerParitySmoke.mjs',
  'test/lbEmTunedLengthScaleSmoke.mjs',
  'test/lbTranslationInvarianceSmoke.mjs', // LB vertex keys, packed topology, row plan and the CDT/mesh builds do not depend on the shape's position
  'test/cpatchRowGateSmoke.mjs',
  'test/cpatchCoverGuardSmoke.mjs',
  'test/cpatchFrameInvarianceSmoke.mjs',
  'test/cpatchSeamSplitSmoke.mjs',
  'test/cpatchConvexAreaCertificateSmoke.mjs',
  'test/cpatchCubicAreaCertificateSmoke.mjs',
  'test/cpatchCubicAreaPresenceSmoke.mjs',
  'test/cpatchNormalizedBakeSmoke.mjs',
  'test/cpatchPoolSplitParitySmoke.mjs',
  'test/cpatchConvKeyExactSmoke.mjs',
  'test/cpatchLensSmoke.mjs',
  'test/cpatchCurveCutCloseSmoke.mjs',
  'test/cpatchNestedHolesSmoke.mjs',
  'test/cpatchSkirtReachSmoke.mjs',
  'test/cpatchCrossExactSmoke.mjs',
  'test/morphScaleEquivarianceSmoke.mjs',
  'test/morphJoinTangentScaleSmoke.mjs',
  'test/morphBandPlaneSizeSmoke.mjs',
  'test/cpatchLeakWidthSmoke.mjs',
  'test/lbInvisibleBoundaryScaleSmoke.mjs',
  'test/lbBuildRoutesSmoke.mjs',
  'test/lbFastPathDeclineSmoke.mjs',
  'test/lbBoundaryTriSubdivSmoke.mjs',
  'test/lbInteriorSignSmoke.mjs',
  'test/lbZeroLengthCloseSmoke.mjs',
  'test/windingTreeSmoke.mjs',
  'test/lbHullRejectDegenerateSmoke.mjs',
  'test/slugArcRayToleranceSmoke.mjs',
  'test/slugQuadRootScaleSmoke.mjs',
  'test/slugArcEndpointOnRaySmoke.mjs',
  'test/slugArcRadiusScaleSmoke.mjs',
  'test/bandArcEndpointMembershipSmoke.mjs',
  'test/fusedChecksListSmoke.mjs',
  'test/shaderVariantCompileSmoke.mjs',
  'test/rotatedMapVariantSmoke.mjs',
  'test/instancedAsyncSpecializationSmoke.mjs',
  'test/streamDerivedStatsSmoke.mjs',
  'test/aacPointsPerShapeGateSmoke.mjs',
  'test/aacPointsBucketSmoke.mjs',
  'test/aacPointsGateSmoke.mjs', // the point budget by overlap depth, the calibration cells, scale-free point lists, and each decline's named reason under __MANTLE_DEBUG__
  'test/aacPointsRowGateSmoke.mjs',
  'test/lbPickDeterminismSmoke.mjs',
  'test/renderTimeoutBudgetSmoke.mjs',
  'test/renderReaperScopeSmoke.mjs', // the render lane reaps only its own orphans: a profile under its lane root whose launcher is gone
  'test/lbResearchSwitchSmoke.mjs',
  'test/bandWindingCubicSplitSmoke.mjs',
  'test/hitStrokeJoinSvgShapeSmoke.mjs', // pointOnStroke and fillHitShape(Outline) against the SVG 2 stroke shape: every join, all nine start/end cap pairs, scales 1e-3..1e3, mutations, Flash per-axis widths
  'test/filterStrokeRtPadSmoke.mjs',
  'test/hitTestScaleInvariantSmoke.mjs',
  'test/hitTestBoxRoundingSmoke.mjs',
  'test/hitTestClipMaskSmoke.mjs',
  'test/basicShapeClipSmoke.mjs', // CSS basic-shape clip-path regions, the stroke box in closed form, nested <svg> clips, layered clips
  'test/dstRectPlacementSmoke.mjs',
  'test/slugCubicApexScaleSmoke.mjs',
  'test/slugCubicVertexTouchSmoke.mjs',
  'test/lbQuadArcContainmentSmoke.mjs',
  'test/lbCurveTriExactSmoke.mjs',
  'test/predicatesExactSmoke.mjs', // orient2d and incircle signs equal a BigInt oracle on adversarial inputs, and every adaptive tier is reached
  'test/earcutDeviationSmoke.mjs',
  'test/cdtDegenerateStressSmoke.mjs',
  'test/cdtIntersectResolveSmoke.mjs',
  'test/cdtSelfIntersectFillSmoke.mjs',
  'test/textRunMetricsSmoke.mjs',
  'test/nineSliceSmoke.mjs',
  'test/morphHitPoseSmoke.mjs',
  'test/lbCanonicalHashesSmoke.mjs',
  'test/cssClassFillSmoke.mjs',
  'test/cssConcurrentImportSmoke.mjs',
  'test/gzipBombSmoke.mjs',
  'test/feLightingWorldScaleSmoke.mjs',
  'test/filterGraphBboxSmoke.mjs',
  'test/filterFrameSmoke.mjs', // filter frame: reach of a graph, frame geometry at every scale, the compensated world matrix
  'test/filterGraphColrSmoke.mjs',
  'test/font/aatKerxSmoke.mjs',
  'test/font/aatMortSmoke.mjs',
  'test/font/aatMorxSmoke.mjs',
  'test/font/arabicFormSubstSmoke.mjs',
  'test/font/arabicJoiningSmoke.mjs',
  'test/font/arabicShapingSmoke.mjs',
  'test/font/autoRegisterSmoke.mjs',
  'test/font/avarReaderSmoke.mjs',
  'test/font/bidiSmoke.mjs', // bidi classes, paragraph direction, levels and reordering, isolates and N0 paired brackets (hand cases, no fixture)
  'test/font/bidiTextRunSmoke.mjs',
  'test/font/bitmapFontAssetSmoke.mjs', // getBitmapGlyph dispatch and the TTC + sbix reader on Apple Color Emoji (read once)
  'test/font/boldItalicSmoke.mjs',
  'test/font/cbdtReaderSmoke.mjs',
  'test/font/cff2ReaderSmoke.mjs',
  'test/font/cffFlexSmoke.mjs',
  'test/font/cffFixedOperandSmoke.mjs',
  'test/font/cffJsSmoke.mjs',
  'test/font/cffMultiFontSmoke.mjs',
  'test/font/cffSeacSmoke.mjs',
  'test/font/cjkWrapSmoke.mjs',
  'test/font/cmapExtendedFormatsSmoke.mjs',
  'test/font/colrFontAssetSmoke.mjs',
  'test/font/colrPaintToGraphSmoke.mjs',
  'test/font/colrColorLineSmoke.mjs', // a color line off [0, 1] renormalizes with its geometry; ill-formed gradients paint nothing
  'test/font/colrReaderSmoke.mjs',
  'test/font/colrTextRunSmoke.mjs',
  'test/font/colrV1GradSmoke.mjs',
  'test/font/colrSpecLayoutSmoke.mjs', // COLRv1 PaintTransform + Var* layouts and PaintSkew against fontTools-written fonts
  'test/font/colrPlacedHitSmoke.mjs', // paint transforms pushed to the leaves; hit table, bbox, undrawn base outline
  'test/font/colrClipHitSmoke.mjs', // a hit where the ClipList box cuts a PaintGlyph silhouette away does not answer
  'test/font/textStyleLayoutForwardSmoke.mjs', // style.varCoords / fallbacks / language reach the layout
  'test/font/gposVariationIndexSmoke.mjs', // GPOS VariationIndex deltas on pair kerning and SinglePos (HarfBuzz widths)
  'test/font/colrClipListSmoke.mjs', // COLRv1 ClipList (format 1/2, ranges, PaintColrGlyph boxes), HarfBuzz clip pushes
  'test/font/gposValueRecordSmoke.mjs', // GPOS xPlacement/yPlacement/yAdvance, second pair record, Device + VariationIndex, ppem tables, anchor devices (HarfBuzz)
  'test/font/cffCharStringBudgetSmoke.mjs', // CFF charstring work budget (subroutine bomb), GlyphOutlineError
  'test/font/woff1Smoke.mjs', // WOFF 1.0 decode through decodeIfWoff2, clear constructor error
  'test/font/colrV1ReaderSmoke.mjs',
  'test/font/colrV1RichSmoke.mjs',
  'test/font/colrVarSmoke.mjs',
  'test/font/cursiveAttachSmoke.mjs',
  'test/font/curveRangesSmoke.mjs',
  'test/font/defaultIgnorableSmoke.mjs',
  'test/font/ebdtBitmapSmoke.mjs',
  'test/font/markupTagsSmoke.mjs',
  'test/font/markupIndentMarginSmoke.mjs',
  'test/font/markupRichTextSmoke.mjs',
  'test/font/markupLayoutSmoke.mjs',
  'test/font/fallbackSmoke.mjs',
  'test/font/featureEntryGenSmoke.mjs',
  'test/font/fontAssetColrV1GraphSmoke.mjs',
  'test/font/fvarReaderSmoke.mjs',
  'test/font/glyphSegsTtfNativeQuadSmoke.mjs',
  'test/font/gposLookupTypesSmoke.mjs',
  'test/font/gposMarkSmoke.mjs',
  'test/font/graphemeSmoke.mjs',
  'test/font/gsubLookupTypesSmoke.mjs',
  'test/font/gvarReaderSmoke.mjs',
  'test/font/hangulJamoSmoke.mjs',
  'test/font/hangulShapingSmoke.mjs',
  'test/font/harakatSmoke.mjs',
  'test/font/hvarReaderSmoke.mjs',
  'test/font/indicBaseConsonantSmoke.mjs',
  'test/font/indicClassifySmoke.mjs', // Indic classes, positions and syllable reorders across the ten scripts
  'test/font/indicFeatureApplySmoke.mjs',
  'test/font/indicFeatureSmoke.mjs',
  'test/font/indicLookupTypesSmoke.mjs',
  'test/font/jstfPrioritiesSmoke.mjs', // JSTF priorities, source ranges, cursive joins and vertical extenders.
  'test/font/indicReorderSmoke.mjs',
  'test/font/indicShapingSmoke.mjs',
  'test/font/jstfKashidaSmoke.mjs',
  'test/font/justifySmoke.mjs',
  'test/font/l0Smoke.mjs',
  'test/font/l1Smoke.mjs',
  'test/font/lamAlefSmoke.mjs',
  'test/font/linkTagSmoke.mjs',
  'test/font/lookupFlagSmoke.mjs',
  'test/font/markLigPosSmoke.mjs',
  'test/font/mathAssemblyEmitSmoke.mjs',
  'test/font/mathAssemblySmoke.mjs',
  'test/font/mathReaderSmoke.mjs',
  'test/font/mathShapingSmoke.mjs',
  'test/font/mathStretchySmoke.mjs',
  'test/font/measureTextSmoke.mjs',
  'test/font/mvarReaderSmoke.mjs',
  'test/font/nameReaderSmoke.mjs',
  'test/font/nameCodecsSmoke.mjs',
  'test/font/statSelectionSmoke.mjs',
  'test/font/aatPreferSmoke.mjs', // a font with both AAT and OpenType tables is shaped by AAT by default (preferAat), GSUB/GPOS on request
  'test/font/otTablesSmoke.mjs',
  'test/font/overridesSmoke.mjs',
  'test/font/richDecorationSmoke.mjs',
  'test/font/sbixReaderSmoke.mjs',
  'test/font/shapeMorphSmoke.mjs',
  'test/font/svgInOtReaderSmoke.mjs',
  'test/font/svgInOtTextRunSmoke.mjs',
  'test/font/scriptLangSysSmoke.mjs',
  'test/font/svgTextAnchorPerTspanSmoke.mjs',
  'test/font/svgTextAnchorSmoke.mjs',
  'test/font/svgTextPathAnchorParitySmoke.mjs',
  'test/font/svgTextPathSmoke.mjs', // textPath placement, startOffset and styled glyphs; the shipped quad/GL16 arc length against a trapezoid reference
  'test/font/svgTextSmoke.mjs', // <text> and <textArea> import: per-glyph shapes, wrapping in em, skips, a warning without svgTextLayout
  'test/font/svgTextStrokeFallbackSmoke.mjs',
  'test/font/svgTspanSmoke.mjs',
  'test/font/syntheticFallbackSmoke.mjs',
  'test/font/textBundleFontMetricsSmoke.mjs',
  'test/font/textBundleSmoke.mjs',
  'test/font/textBundleVerticalSmoke.mjs',
  'test/font/textRunColrV1Smoke.mjs',
  'test/font/textRunFeaturesSmoke.mjs',
  'test/font/thaiShaperSmoke.mjs',
  'test/font/thaiShapingSmoke.mjs',
  'test/font/ttcFaceSelectSmoke.mjs',
  'test/font/useShaperSmoke.mjs',
  'test/font/useShapingSmoke.mjs',
  'test/font/useFeatureSmoke.mjs',
  'test/font/vmtxReaderSmoke.mjs',
  'test/font/wouldSubstituteSmoke.mjs',
  'test/font/woff2CollectionSmoke.mjs',
  'test/font/woff2TransformedHmtxSmoke.mjs',
  'test/font/wordBreakSmoke.mjs',
  'test/font/fontBudgetSmoke.mjs', // small fonts that ask for unbounded work: hang and heap-exhaustion budgets.
  'test/font/fontMalformedTableSmoke.mjs', // a malformed table is dropped, not thrown out of layout.
  'test/font/bidiBracketsSmoke.mjs', // rule N0 over every pair of BidiBrackets.txt, and L1 through what X9 removes.
  'test/font/textShapingRegressSmoke.mjs', // shaping and layout cases read against hb-shape.
  'test/font/wordStartsRegistrySmoke.mjs',
  'test/gradientStopsPackSmoke.mjs',
  'test/droppedContentSmoke.mjs', // invisible content kept for morphs, overrides, bounds and text fades; the optimizing mode drops it
  'test/streamArcSectionSmoke.mjs',
  'test/morphKeptInvisibleFillMeshSmoke.mjs',
  'test/keepHiddenSmoke.mjs',
  'test/morphOccupancyGuardSmoke.mjs',
  'test/morphClipBindingSmoke.mjs',
  'test/morphClipRunsSmoke.mjs',
  'test/drawMorphOverridesSmoke.mjs',
  'test/bundleHandleMorphSmoke.mjs',
  'test/occupancyGridSmoke.mjs',
  'test/occupancyImportSmoke.mjs',
  'test/occupancyUploadBoundsSmoke.mjs',
  'test/pathBooleanIntersectKernelsSmoke.mjs',
  'test/pathBooleanLineIntersectSmoke.mjs',
  'test/pathBooleanQuadQuadSmoke.mjs',
  'test/pathBooleanQuadArcSmoke.mjs',
  'test/pathBooleanBezierClipSmoke.mjs',
  'test/pathBooleanArcIntersectSmoke.mjs',
  'test/pathBooleanMonotoneSmoke.mjs',
  'test/pathBooleanSplitSmoke.mjs',
  'test/pathBooleanDcelSmoke.mjs',
  'test/pathBooleanUnionSmoke.mjs',
  'test/silhouetteCrossingSmoke.mjs',
  'test/silhouetteRefIndexSmoke.mjs',
  'test/silhouetteClippedExtentSmoke.mjs',
  'test/pointInShapeSeamRaySmoke.mjs',
  'test/pathBooleanCoincidentSmoke.mjs',
  'test/pathBooleanPlanarGraphSmoke.mjs',
  'test/pathBooleanFaceClassifySmoke.mjs',
  'test/pathBooleanThinLobeSmoke.mjs',
  'test/lbAnnulusCenterSmoke.mjs',
  'test/shapeRecognizeEnclosesOnceSmoke.mjs',
  'test/sceneBoxSmoke.mjs',
  'test/polyRootsQuarticSmoke.mjs',
  'test/pathBooleanCoincidentArcLineSmoke.mjs',
  'test/pathBooleanScaleInvariantSmoke.mjs',
  'test/importerScaleInvariantSmoke.mjs',
  'test/strokeWalkShapeSmoke.mjs',
  'test/strokeStripFoldSmoke.mjs', // a folding stroke row strips with patches that hold the whole stroke (CPU coverage, 2^-20..2^20)
  'test/incrementalStrokeTangentScaleSmoke.mjs',
  'test/circlePrimConformalSmoke.mjs',
  'test/markerAspectSmoke.mjs',
  'test/markerClipMaskSmoke.mjs',
  'test/markerViewportClipSmoke.mjs',
  'test/objectBoundingBoxTransformSmoke.mjs',
  'test/objectBoundingBoxStrokeGradientSmoke.mjs',
  'test/streamScopeGuardSmoke.mjs',
  'test/psoWarmDeadlineSmoke.mjs', // a variant is bound whatever the frame time (deadline warm after 60 frames and 1 s); render() is a frame entry: a setBundle + render() loop moves to its variant and stays, render() inside beginFrame starts no warm
  'test/frameEntryWarmSmoke.mjs',
  'test/renderRouteParitySmoke.mjs',
  'test/frameEntryContractSmoke.mjs',
  'test/transformArcConditioningSmoke.mjs',
  'test/lbArcPieceInvarianceSmoke.mjs',
  'test/patternChildrenSmoke.mjs',
  'test/patternUnitsSmoke.mjs',
  'test/filterRegionImportSmoke.mjs',
  'test/filterSubregionImportSmoke.mjs',
  'test/filterScaleImportSmoke.mjs', // a filter's lengths (stdDeviation, radius, displacement, light height) and places (light, noise) follow the referencing element's transform
  'test/svg/filterColorSpaceImportSmoke.mjs', // color-interpolation-filters read (attribute, style, rule, inherited, per primitive), spaces per node, conversion counts, routes, CSS functions sRGB
  'test/filterRegionTransformSmoke.mjs',
  'test/unifiedFilterSubRectCacheSmoke.mjs',
  'test/filterSnapshotCountSmoke.mjs',
  'test/unifiedFilterInGroupSmoke.mjs',
  'test/nestedGroupSmoke.mjs',
  'test/groupOverBlitSmoke.mjs',
  'test/groupAlphaSmoke.mjs', // a draw's alpha is GROUP opacity: one accumulator faded once; alpha 1 keeps the call log; one paint-only leaf stays direct; faded instances leave the single instanced draw
  'test/alphaRecolorDirectSmoke.mjs', // a faded one-leaf draw whose colorMatrix leaves alpha alone is direct, not a group (a board of tinted border cells: 26 -> 4 ms a frame)
  'test/groupAtlasSmoke.mjs', // a run of plain groups (faded fill+stroke leaves, faded instance layers) shares ONE atlas target: 3 passes, slots disjoint with even shifts, composites in painter order; groupAtlas:false is a pass pair per group
  'test/groupFilterSkipSmoke.mjs', // a filtered group whose result key is unchanged skips its children (no accumulator pass, one composite per element), on both routes; every key input still invalidates; inputs the key does not hold bypass the skip
  'test/groupAlphaExportSmoke.mjs', // the export / native scene write a draw's alpha as opacity on ONE <g> around the bundle (as the GL path does)
  'test/psoWarmScissorSmoke.mjs',
  'test/filterCacheInputsSmoke.mjs',
  'test/unifiedSpanBailGroupSmoke.mjs',
  'test/contextResourceOwnershipSmoke.mjs', // allocation-generation bookkeeping and native-call audit
  'test/groupLeafTargetSmoke.mjs',
  'test/nestedMaskGateSmoke.mjs', // a mask nested in a mask declines the unified route (gate 'nested-mask'); single-level masks keep it
  // strict play smokes: the driver-model and derivation guards
  'test/coopUploadSmoke.mjs',
  'test/coversDrawSmoke.mjs',
  'test/debugStatsSerializableSmoke.mjs',
  'test/gateBarsSmoke.mjs',
  'test/instancedCompactCacheNodeSmoke.mjs',
  'test/transientHandleWorkingSetSmoke.mjs', // bare draws of more distinct bundles per frame than the 8-handle bound keep their handles resident; the budget may evict idle ones
  'test/morphWarmQueryGateSmoke.mjs',
  'test/strictDerivedRegionsSmoke.mjs',
  'test/aacPickRegionsSmoke.mjs',
  'test/emptyBundleWarmSmoke.mjs',
  'test/textReflowKeySmoke.mjs',
  'test/timelinePairsWarmSmoke.mjs',
  'test/rendererOptionsListSmoke.mjs',
  'test/aacPointsGenTableSmoke.mjs', // the generated points' entry table, searched as the vertex shader searches it, is the point list point for point
  'test/spriteTimelineLazySmoke.mjs', // a sprite timeline builds no frame at creation (each frame is a morph bundle; one scene has 2827 of them)
  'test/pointListMemorySmoke.mjs', // the points route keeps no CPU copy of its lists; their GPU buffers stay inside aacPointsBufferBudget
  'test/declareReachSmoke.mjs', // renderer.declareReach(bundle, tags): the warm builds exactly the declared states; a morph reaches its poses' union
  'test/cpatchPinDeclineRecordSmoke.mjs', // a pinned CPatch that did not draw says why: pending before its build lands, on the points route too; unsupported for a row an override takes off its patches
  'test/morphPrimitivesOnSmoke.mjs', // primitives 'on' and a morph from a recognized circle: the source's disc does not draw at every t
  'test/streamFrameFixedSmoke.mjs', // an update keeps a frame the author fixed (fixedBBox, preserveViewport); without one the box follows the content
  'test/declareStreamSmoke.mjs', // renderer.declareStream(bundle): an imported bundle's first and later updates link and build nothing in play; undeclared, the warm is unchanged, key for key
  'test/streamUpdateBeforeLoadSmoke.mjs', // a lightweight stream updated once before the loading call links and builds nothing in play (README's streaming rule); a stand-in-free stream keeps one key when a new segment type streams in
  'test/linkRetryWindowSmoke.mjs', // a fill key that failed to link is not linked in play, is tried once per loading call or warm window, and draws when the link then succeeds
  'test/declaredChannelLerpWarmSmoke.mjs', // a declared channel-lerp recolor is a warm state: its pipelines are built at load (a per-class sprite tint built them in play)
  'test/bindSetBatchCapSmoke.mjs', // the bind-set pass builds pipelines in small batches behind fences, so the loading screen can present between them
  'test/maskBakeNoNetSmoke.mjs', // a stand-in-free renderer builds no all-types mask-bake program; a bake that misses in play waits for its exact program
  'test/filterGeneratorRegionSmoke.mjs', // a generator or arithmetic k4 paints the filter region, a negative displacement scale grows the rect; a <desc> child keeps the filter; an owner paint with nothing to draw reads transparent
  'test/hitNonScalingDashSmoke.mjs', // a non-scaling stroke's hit dashes follow the row's differentials, an override's scale and a turned world matrix too
  'test/nativeOverrideReplaySmoke.mjs', // native scene: an unchanged override table does not compound a recolor, keep a sprite's hide or lose its writes; the bake's placement and which draws may use it; scissor across a resize; drawImage's NaN matrix
  'test/nativeActiveContentSmoke.mjs', // the clone drops a javascript: href spelled with a tab or newline, the animation that would write one, and an iframe
  'test/hitTieMemoSmoke.mjs', // a hit query's answer does not depend on the one before it: the memo stops short of the tie band
  'test/groupFilterRectSmoke.mjs', // a filter on a <g> paints past its children: the static cache's blit and an outer group's composite are not cut at the children's box
  'test/pointsVectorEffectSmoke.mjs', // a row with a vector effect does not take the points route: the point shader cannot cancel the world matrix per row
  'test/coopUploadDrainSmoke.mjs', // a loading call never ends with a vertex buffer unfilled: past its deadline, or cut short by a dispose, it finishes the queue
  'test/loadingCallOverlapSmoke.mjs', // overlapping loading calls run one at a time; awaitBundleReady answers from what was built; a warm of one late bundle keeps the app's range and claims no size class; a thrown call leaves no phase behind; a late bundle's awaitBundleReady warms it alone (a fraction of a full warm), and its first draw builds nothing
  'test/warmedMorphReleaseSmoke.mjs', // a morph the loading call warmed is not kept alive by having been warmed
  'test/filterIncompleteNotStampedSmoke.mjs', // a result drawn without its program is not kept: a linear blur while its converting programs link, a FillPaint gradient, a bake over a reuse draw
  'test/timelineSharedPoseSmoke.mjs', // timelines over shared poses: drawBundle(timeline), setTime with an unchanged time, the instanced and handle entries each draw the right pose; a pose change keeps a caller's framebuffer
  'test/handleKeptRowsSmoke.mjs', // a mount brings a kept row back as drawBundle does: an override with ink, reveal on a keepHidden row
  'test/spriteViewDrawSpriteSmoke.mjs', // drawSprite and drawSpriteInstanced take a sprite timeline and its held frame
  'test/filterOverrideTablesSmoke.mjs', // one bundle with two override tables: a filter result or a mask bake re-evaluates when the rows that feed it differ, and only then
  'test/filterCacheBudgetGrowSmoke.mjs', // the filter cache's budget and ceiling hold when entries grow (zoom in), not only when one is stored
  'test/renderDisposedTargetSmoke.mjs', // render(target) with a disposed target draws nothing, not the bundle bound before it
  'test/filterScratchCeilingSmoke.mjs', // filter scratch has a ceiling while filters run: a long zoom does not keep every target size it crosses, and a working set in use is never freed
  'test/filterFrameAllocSmoke.mjs', // a filtered shape crossing the canvas edge reuses its targets while it moves: the frame's margin sits on a grid and a rect the frame cuts goes back on its quantum
  'test/strokeWidthOverrideRectSmoke.mjs', // a stroke-width override widens the box a group's composite is bounded by
  'test/cullRetireDocumentUnitsSmoke.mjs', // an override that moves an occluder retires the occlusion cull in a document of any units
  'test/alphaPlanMorphPoseSmoke.mjs', // the plans of faded instances follow a morph's pose: t 0 then t 1 draws as t 1 alone does
  'test/alphaSlotHomogeneousSmoke.mjs', // the slot offset of a faded instance goes through the matrix's w: a matrix and its multiple land in one place
  'test/alphaSlotBudgetSmoke.mjs', // faded instances in slots ask the memory budget for the atlas, and fall to the layered accumulators when refused
  'test/filterCacheResizeSmoke.mjs', // a resize takes the filter results' bytes off the count: the cache still serves a static scene after 40 resizes
  'test/groupFrameTargetSmoke.mjs', // a filter frame does not re-size the accumulator of the group around it: a graph-filtered leaf, a plain group, a blend leaf; a faded draw
  'test/sharedGroupSiblingBakeSmoke.mjs', // members of a shared static-cache group never blit a raster that shows something else: a sibling's bake is adopted when equal, and a raster in use is not baked over
  'test/setTextRetrySmoke.mjs', // setText and setStyle after a failed rebuild can be retried; a repeat of a call still running waits for it
  'test/maskStandInNotStampedSmoke.mjs', // a rotated mask bake drawn by the axis-aligned program while its own links is not kept once the program is ready
  'test/bundleDisposeCachesSmoke.mjs', // what a renderer caches for a bundle goes with its dispose: point lists on each renderer, instanced compact buffers
  'test/handleExportSmoke.mjs', // exportFrameSVG of a frame drawn through a mount is the export of the same frame through drawBundle
  'test/filterPastCanvasRectSmoke.mjs', // a filter's targets stop at what can reach the canvas: a pointwise filter on a shape far past it asks for canvas-sized targets at any zoom
  'test/submitThrowSmoke.mjs', // a submitted draw that throws does not repaint its frame's list in the next frame
  'test/pointListTwoRenderersSmoke.mjs', // a point list shared by two renderers cannot wedge the other's eviction or be counted twice
  'test/timelineRefLifetimeSmoke.mjs', // a timeline's references on shared pair morphs survive a caller's array and a failed creation; a pair morph takes a label
  'test/warmQueueLifecycleSmoke.mjs', // the warm queue's lifecycle: cancel and dispose leave nothing waiting or stranded; a finished scene releases its bundles; a lost context, a fractional link limit and a null scale wedge nothing
  'test/warmQueueGameContextSmoke.mjs', // a game on the warm queue: a late scene, a start over a game, the deadline closing the window, focus with a game, one game's needs, listed keys, idle, a waiting item, the scan limit, the viewport, release on cancel
  'test/warmManifestClassesSmoke.mjs', // manifest minor 2 on the real renderer: every class a key was bound at, older manifests read at any size; bundles on a manifest scene; a capture; release on cancel; world maps recorded at any scale
  'test/morphPassWarmRestoredSmoke.mjs', // a restored context's renderer warms the morph helper passes again
  'test/morphMetaRingStandInSmoke.mjs', // a morph created while the lerp helper links keeps moving its meta plane once the helper is ready
  'test/morphAliasResourceIdsSmoke.mjs', // a row of a rebuilt mask run reads the same resources as the row it mirrors
  'test/streamMeshStalenessSmoke.mjs', // a lightweight update's meshes follow arc parameters, and a full update releases them
  'test/morphDstOnlyStrokeBandSmoke.mjs', // a destination-only stroke keeps its band pad
  'test/morphArcHalfTurnSmoke.mjs', // a half turn's large-arc flag and a scaled arc's band break
  'test/morphArcSpecNumbersSmoke.mjs', // an arc's rotation and radii interpolate as numbers (SVG 2, 9.3.2), under a transform too
  'test/morphArcRotationOptionSmoke.mjs', // arcRotation: 'shortest' for running-angle art, on a morph and on every timeline; compat reaches timelines too
  'test/morphArcSpecFlagsSmoke.mjs', // an arc flag that differs is 1 between the poses; compat: 'chrome' steps it at 0.5
  'test/morphArcFlagEndPoseSmoke.mjs', // an arc whose poses disagree on sweep lands on each pose at t = 0 and t = 1
  'test/nativeMorphStashSmoke.mjs', // the native morph's auto-apply stashes are on the bundle it hands out, and leave a pose when the morph does
  'test/nativeSceneDomSmoke.mjs', // native scene DOM under the shim: morph addressing beside text and masks, per-frame interpolation, id-less morphs, reconciler reuse/reset/trim, open strokes, paint fades, auto-applied tweens, mask geometry, morph write counts
  'test/warmSizeRegionBoxSmoke.mjs', // a bundle's warm size regions do not depend on where its art sits
  'test/morphCullScaleSmoke.mjs', // the morph cull's boundary certificate gives one answer at any scale
  'test/coverFanHullKeySmoke.mjs', // the cover-fan hull cache: non-finite axis values are separate keys, and a copy far out for its size leaves no rounded hull for a near one
  'test/coverFanHullShareSmoke.mjs', // a glyph's cover-fan hull is computed once, and each copy's fan still contains it
  'test/standInReadyRoundsSmoke.mjs', // the stand-in policy: awaitBundleReady runs at most one warm round per missing key (it reran the whole loading call on every text re-flow and trial)
  'test/recolorFoldWarmSmoke.mjs', // a bundle declared both a color matrix and a channel lerp has one recolor program; each draw's enabled flags still follow its own state; no program built in play
  'test/groupTargetPickWarmSmoke.mjs', // a bundle whose AAC engine pick has a bar at some drawn scale warms both outcomes (tiles that pop in from scale 0)
  'test/noAaGateWarmSmoke.mjs', // the no-AA gates' bar (a covering stroke's device width) is reached by a world matrix: both outcomes are warmed
  'test/patternTileGateWarmSmoke.mjs', // the pattern minification gate's bar (a tile's device size) is reached by a world matrix: both outcomes are warmed
  'test/lbPickGateWarmSmoke.mjs', // every row tally the Loop-Blinn pick's bars admit in (0, inf) is warmed, and the image's probes leave the pick cache alone
  'test/strokeStripGateNeutralSmoke.mjs', // the stroke strip policy moves no program: the sweep crosses its bar and nothing builds
  'test/instancedScaleNeutralSmoke.mjs', // the instanced fast path's pick is neutral to the instances' matrices: both engines are warmed only for a bar in the viewport range
  'test/aacPointsScaleNeutralSmoke.mjs', // a scale that takes the points route with an unbuilt program declines to the cover key and links nothing in play
  'test/poseDirectWarmSmoke.mjs', // a morph's source pose is warmed under the stand-in-free policy (warmMorphSources: false opts out): drawn directly, nothing builds in play
  'test/compositeInstancedWarmSmoke.mjs', // the group composite's instanced helper is built by the loading call of a scene that can reach it, and of no other
  'test/standInsPriorOwnerSmoke.mjs', // previous-variant reuse only reuses this renderer's variant: a bundle's record of a disposed renderer's program is not bound
  'test/fillSelectThrowSmoke.mjs', // a draw on a lost context defers instead of throwing; a selection that throws leaves no fill pass active; a failed link is not linked again every frame
  'test/idleInferenceMotionSmoke.mjs', // the static-frame count the idle warm reads climbs on a still screen and on no moving one, whichever entry draws the motion
  'test/warmKeepsBindingSmoke.mjs', // setBundle stays bound through a frame's warm tick and a loading call: a bare render() draws what the caller bound
  'test/rendererDisposeWarmScratchSmoke.mjs', // a renderer's dispose frees its warm scratch and filter helper programs: a shared context does not collect them
  'test/warmQueueReleaseSmoke.mjs', // warmQueueRelease (the hub's warmer): each program is deleted once built; a released key is done for later scenes
  'test/warmTargetSizeSmoke.mjs', // a pipeline warm allocates group/filter targets at real size only for the as-drawn play state; play builds nothing
  'test/warmSizeDedupSmoke.mjs', // the loading call skips a derived size whose owners ask for nothing new, and stops at its deadline (one scene: 262 sizes to the 180 s cap)
  'test/timelineShareSmoke.mjs', // timelines over the same poses share one morph per pair; each draws its own pose (drawBundle morphT) // createRenderer's known-option list is exactly the options the renderer reads (no false "unknown option" warning, no dead option)  // every bracket-pair morph of a timeline is built by the loading call and in its warm image     // a text bundle's warm image covers every string of its font (font outline types; both AAC gate outcomes)   // a bundle with nothing to draw binds no fill program: empty image, nothing unbuilt, nothing blocked in play
  'test/filterParamTweenSmoke.mjs',
  'test/filterGraphTweenReachSmoke.mjs',
  'test/blurKernelSmoke.mjs',
  'test/porterDuffSmoke.mjs',
  'test/svgCommentDashSmoke.mjs',
  'test/zeroValuedAttributeSmoke.mjs',
  'test/inheritedChannelOpacitySmoke.mjs',
  'test/gradientPaintOpacitySmoke.mjs',
  'test/useInheritanceSmoke.mjs',
  'test/textInheritanceSmoke.mjs',
  'test/markerInheritanceSmoke.mjs',
  'test/defContentInheritanceSmoke.mjs',
  'test/clipRuleSmoke.mjs',
  'test/childGradientOpacitySmoke.mjs',
  'test/childImageOpacitySmoke.mjs',
  'test/primHitTestSmoke.mjs',
  'test/shaderFeatureSelectSmoke.mjs',
  'test/shaderMinifySmoke.mjs',
  'test/shapeAnimationSmoke.mjs',
  'test/shapeMorphMetaSmoke.mjs',
  'test/morphGradientStopLayoutSmoke.mjs', // a gradient pair packed one texel / two texels per stop still tweens its stops (prepareMorphGradients relayout)
  'test/svg/anchorHrefHitSmoke.mjs', // importSvg records one href per shape (no-href <a> gives ''); createBundle carries shapeHrefs; fillHitHref answers the link under a point
  'test/svg/blendModeSmoke.mjs',
  'test/svg/colorParseSmoke.mjs',
  'test/svg/colorChromeSmoke.mjs', // compositing color: ~650 strings vs Chrome's own answers, invalid colors fall back, currentcolor in functions, straight-alpha clear, premultipliedAlpha:false warning
  'test/svg/cssAtRulesSmoke.mjs',
  'test/svg/cssImportantSmoke.mjs',
  'test/svg/cssRuleIndexSmoke.mjs',
  'test/svg/cssSelectorsSmoke.mjs',
  'test/svg/externalStylesheetSmoke.mjs',
  'test/svg/imageMaskInheritanceSmoke.mjs',
  'test/svg/lengthIntegrationSmoke.mjs',
  'test/svg/lengthParseSmoke.mjs',
  'test/svg/manyStopsSmoke.mjs',
  'test/svg/maskInheritanceSmoke.mjs',
  'test/svg/convolveOrderPassThroughSmoke.mjs',
  'test/svg/maskTypeSmoke.mjs',
  'test/svg/modifiersSmoke.mjs',
  'test/svg/modifiersClosedPathSmoke.mjs',
  'test/svg/nestedClipSmoke.mjs',
  'test/svg/nestedSvgImageSmoke.mjs',
  'test/svg/svgImageDocumentSmoke.mjs',
  'test/svg/feImageExternalSmoke.mjs',
  'test/svg/nestedSvgSmoke.mjs',
  'test/svg/repeaterArcSmoke.mjs',
  'test/svg/riveModifiersSmoke.mjs',
  'test/svg/sceneApiSmoke.mjs',
  'test/svg/shapeIdsSmoke.mjs',
  'test/svg/svgzHrefSmoke.mjs',
  'test/svg/switchSystemLanguageSmoke.mjs',
  'test/svg/svgTextImportSmoke.mjs',
  'test/svg/svgWhiteSpaceSmoke.mjs', // CSS white-space on SVG text (collapse vs preserve, inheritance, xml:space), tab stops and tab-size

  'test/svg/specDefaultSmoke.mjs', // compat: spec by default, chrome opt-in: zero subregion, filter list with a missing url(), zero-length square cap direction, xml:space=default newline
  'test/svg/textMaskInheritanceSmoke.mjs',
  'test/svg/vectorEffectSmoke.mjs',
  'test/svg/viewElementSmoke.mjs',
  'test/svg/namespaceElementsSmoke.mjs',
  'test/svgAutoSmoke.mjs',
  'test/svgTextDecorationSmoke.mjs',
  'test/svgTextSourceExpansionSmoke.mjs',
  'test/svgTextSynthVerticalSmoke.mjs',
  'test/textLayoutWidthSmoke.mjs',
  'test/arcMorphAuthoredRadiiSmoke.mjs',
  'test/arcMorphGateSmoke.mjs',
  'test/cpatchMorphMixedRowsSmoke.mjs',
  'test/fillNormalizeBandsSmoke.mjs',
  'test/fillNormalizeArcsSmoke.mjs',
  'test/cpatchMixedAreaOrientationSmoke.mjs',
  'test/cpatchPerturbationSmoke.mjs',
  'test/cpatchWorkBudgetSmoke.mjs',
  'test/cpatchRoundingSmoke.mjs',
  'test/warmSceneSmoke.mjs',
  'test/morphFillParitySmoke.mjs',
  'test/sceneUnionSmoke.mjs',
  'test/fillVariantNoWaitSmoke.mjs', // no fill draw in play reads an unfinished link or takes a never-built universal; the warm-superset algebra
  'test/nonBlockingGlSmoke.mjs', // nonblock: the zero-blocking invariant -- no query on an unfinished program, no draw with one, no query behind a pipeline build, from creation to play (recording GL with a driver model + src/renderer/glGuard.js)
  'test/strictPlaySmoke.mjs', // strictPlay: every play frame complete and new, zero builds/deferrals/sheds; safety nets stand in for unpredicted states
  'test/warmQueueSmoke.mjs', // renderer.warm (focus/resume/cancel/priority, manifest v3 warm without bundles, stale-manifest fallback) and warmPolicy 'idle'/'off' on the driver model
  'test/primitiveStartPointSmoke.mjs',
  'test/morphFullTurnReanchorSmoke.mjs',
  'test/morphArcDirectionSmoke.mjs',
  'test/morphRecordCompatibilitySmoke.mjs',
  'test/aacPointsPolicyToggleSmoke.mjs',
  'test/monotoneKeyInPlaySmoke.mjs', // certified-monotone art keeps its key through an external clip, a sprite range, a zero-scale row and a stream's first update: nothing is linked in play
  'test/aacCubicPreparationSmoke.mjs',
  'test/hitQueryContractSmoke.mjs',
  'test/hitSpecModelSmoke.mjs',
  'test/morphColorInterpSmoke.mjs',
  'test/morphFilterCarrySmoke.mjs',
  'test/morphLeafPropsSmoke.mjs',
  'test/morphGroupOpacitySmoke.mjs', // a fill+stroke leaf with opacity is one group; a morph across opacity 1 keeps the group around the same shapes and lerps its opacity
  'test/groupIdsEveryBundleSmoke.mjs', // the group tree is on every bundle with an id'd container: GL and native tables resolve group ids without hit-only rows; morph merges it
  'test/hitOnlyAnimSmoke.mjs', // hit-only shapes follow overrides by id / index and group overrides; native table agrees; morph and stream warn
  'test/overrideTableContractSmoke.mjs',
  'test/disposeLifecycleSmoke.mjs',
  'test/lifecycleContractSmoke.mjs', // context loss/restore contract, unusable contexts, option and argument validation, disposed owners, updateBundleGeometry results; filtered shapes and nested groups on both routes: the loss is taken, nothing is drawn while lost, nothing reaches the GL after the restore
  'test/apiArgumentContractSmoke.mjs',
  'test/animationAuditSmoke.mjs',
];
// CPU-bound smokes that can pass the default 180 s hang cap when the node and render lanes share the machine.
const CAPS = { 'test/lbInvisibleBoundaryScaleSmoke.mjs': 600000 };
process.exitCode = await runNodeChecks(SMOKES, { filters: process.argv.slice(2), caps: CAPS });
