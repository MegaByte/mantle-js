#!/usr/bin/env node
// runRenderSmokes.mjs — the RENDER gate. Curated puppeteer smokes that exercise
// the renderer modules at runtime (shaderPrograms, drawImages, instancedFill,
// morphDraw, drawSprites, cacheDraw, staticCache).
//
// Catches silent wrong-pixel regressions that the static contract smoke in
// runSmokes can't. Needs a browser (puppeteer + chrome) → run it in the
// browser-capable CI stage, not the fast unit lane.
//
// Each entry is chosen to touch a distinct module; keep it small so it stays
// runnable. Add coverage as modules grow.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Refresh examples/smoke/ from the smokes before running them. The fixtures a smoke declares
// INLINE are derived from its source, so a derived file that isn't regenerated is a file that
// silently lies — and the demo's picker reads exactly these. Regenerating here means it can't.
spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'genSmokeAssets.mjs')],
  { cwd: ROOT, stdio: 'inherit' });

const SMOKES = [
  'test/arcsJoinRenderSmoke.mjs',        // stroke: SVG2 arcs line join (curved vs round/miter)
  'test/loopBlinnRenderDiffSmoke.mjs',   // morphDraw: LB direct + route
  'test/leanShaderRenderDiffSmoke.mjs',  // shaderPrograms: lean fill variants
  'test/aacFillParitySmoke.mjs',         // AAC: analytic-area fill vs Slug (line/quad/cubic/arc)
  'test/drawImageSmoke.mjs',             // drawImages: createImage/drawImage opts
  'test/nestedClipIntersectSmoke.mjs',   // nested clip-path intersects (SVG 1.1 §14.3)
  'test/nativeImageRecolorSmoke.mjs',    // native raster drawImage honors per-draw colorMatrix
  'test/zOrderSubmitSmoke.mjs',          // frameLoop: submitBundle zOrder stacking + tiebreak
  'test/spriteRangeRouteSmoke.mjs',      // drawSprite: a sprite SUBSET must paint one sprite on the LB route too (it painted the whole sheet)
  'test/occlusionCullOverrideSmoke.mjs', // occlusionCull: a build-time cull must retire when an override moves/hides the occluder
  'test/coverQuadBatchSmoke.mjs',        // renderer: header-free VBO batches multi-shape draws into one drawArrays
  'test/opaquePrepassSmoke.mjs',         // renderer: opaque overlap HSR keeps analytic AA pixels identical
  'test/bundleInstancedSmoke.mjs',       // instancedFill: drawBundleInstanced
  'test/bundleInstancedTintSmoke.mjs',   // instancedFill: per-instance tint (fast path) + colorMatrix (loop fallback)
  'test/instancedCompactCacheSmoke.mjs', // instancedFill: retain compact meshes across alternating assets
  'test/spriteSheetSmoke.mjs',           // drawSprites: drawSprite
  'test/bundleHandleCacheSmoke.mjs',     // cacheDraw/staticCache: cache bake
  'test/staticCacheSmoke.mjs',           // whole-asset + viewport-window bake/reuse and pan parity
  'test/cacheLbParitySmoke.mjs',         // cacheDraw: a bake of an LB-routed bundle == its direct draw
  'test/sharedGroupCacheSmoke.mjs',      // shared-group target ownership, adoption, and resize
  'test/filterVisualSmoke.mjs',          // shaderPrograms: fe* filter programs
  'test/filterGroupSmoke.mjs',           // renderer: filtered shape INSIDE an opacity group
  'test/colorMatrixSmoke.mjs',           // shaderPrograms: colorMatrix program
  'test/morphRouteSmoke.mjs',            // morphDraw: GPU-resident morph route
  'test/morphIntervalSplitSmoke.mjs',    // morphDraw: classification-changing morphs route via interval-split (no Slug)
  'test/lbMemBudgetSmoke.mjs',           // morphDraw: projected-memory Slug gate (deny → Slug render; account; release on dispose)
  'test/morphGradientRouteSmoke.mjs',    // morphDraw: composed gradient morph
  'test/isolationSmoke.mjs',             // blend/composite
  'test/clipCoverageSmoke.mjs',          // drawImages: deleteClipTexture / clip path
  'test/lbStreamGeometrySmoke.mjs',      // streamGeometry: lightweight LB stream + handle/instanced
  'test/lbStreamSentinelSmoke.mjs',      // streamGeometry: unservable section sentinel-skip
  'test/lbCurvedBandParitySmoke.mjs',    // loopBlinn: curved road band fills vs Slug
  'test/lbRoadRingParitySmoke.mjs',      // streamGeometry: full multi-band scrolling road vs Slug
  'test/lbBandCurveFlipParitySmoke.mjs', // refreshLoopBlinnMesh: rebuild when the concave edge flips ("wrong wedges")
  'test/lbStreamTeleportParitySmoke.mjs',// refreshLoopBlinnMesh: rebuild across slot-teleport structure jumps (road bands)
  'test/nativeStreamSmoke.mjs',          // nativeStream: geometry+fills stream into the no-WebGL native scene
  'test/incrementalStrokeSmoke.mjs',     // incrementalStroke: dynamic paint stroke — O(1) appends, parity vs loaded-whole, dot/alpha, perf
  // Static/morph analytic-fill feature parity — each renders a feature through
  // the LB route and asserts it matches Slug (the full unified feature set).
  'test/lbHandleInstancedParitySmoke.mjs',// _analyticRoute: static LB reaches handle.draw + instanced; cached handle stays on the cache
  'test/lbComposeOrderSmoke.mjs',        // _drawBundleLoopBlinn: solid combined route resets uGradId/uImageId after a gradient draw (cross-shape uniform leak)
  'test/lbHoleParitySmoke.mjs',          // _ensureLbMeshes: multi-contour curved-holed static shapes take the CDT partition path (static↔morph unification) — hole stays empty
  'test/lbDiagonalFrameParitySmoke.mjs', // _ensureLbMeshes: a thin diagonal opposite-winding FRAME (folded-corner page outline) routes multi-contour straight shapes to CDT so the earcut hole-bridge no longer shatters the sliver
  'test/lbCuspHoleParitySmoke.mjs',      // buildLoopBlinnCDT: a CUSP cubic in a curved-holed shape renders via exact Bezout (kind 4), not Slug
  'test/lbLoopParitySmoke.mjs',          // a self-intersecting (loop) cubic correctly falls back to Slug (both fill rules) and renders identically
  'test/lbConcaveCubicParitySmoke.mjs',  // concave/holed CUBIC shapes (C-notch, cubic ring, disjoint bars) render on LB matching Slug (curved→CDT + crescent adoption)
  'test/lbLensParitySmoke.mjs',          // buildLoopBlinnCDT: a lens (two arcs sharing endpoints) has a degenerate chord ring → chordRing re-derives with midpoints so the fill sign isn't inverted
  'test/lbCircleSdfSmoke.mjs',           // a filled circle → exact circular-SDF disc (kind 7), seam-free vs the ≤90° crescent seams; matches Slug at every boundary pixel
  'test/lbAnnulusSdfSmoke.mjs',          // a cubic concentric RING (how-to-play "?" ring) → exact annulus SDF (kind 7); seam- AND wedge-free at small render scale
  'test/lbEllipticalRingParitySmoke.mjs',// a few-percent-elliptical ring (font o/O/0) must NOT be mistaken for a circle by the annulus SDF (fit checks on-curve MIDPOINTS + 0.01·r tol); rejected → accurate CDT, matches Slug
  'test/lbQuadSeamSmoke.mjs',            // a non-circular quad ellipse: kind-1 crescent seams closed by conservative VS dilation (no undercount notch), texcoords carried along the affine map so the u²−v curve is unchanged
  'test/lbRquadSeamSmoke.mjs',           // a non-circular <ellipse>: kind-5 rquad ARC crescent seams closed by the same conservative VS dilation (conic → safe extrapolation); notch gone, mean error −65%
  'test/lbConvexCurveFastPathSmoke.mjs', // routing: a single-contour opaque CONVEX curved shape takes the cheap earcut mesh (hasConcave flag), matching Slug; concave curves fall to CDT
  'test/lbTextParitySmoke.mjs',          // textBundle: authoritative per-shape curve ranges → LB reconstructs glyphs correctly; 'auto' keeps text on Slug (perf)
  'test/loopBlinnMorphSmoke.mjs',        // _analyticRoute: morph routes via the morph route, never the static route
  'test/lbGradientParitySmoke.mjs',      // LB per-shape gradient fill vs Slug
  'test/lbTranslucentParitySmoke.mjs',   // LB translucent solid via the coverage→composite path vs Slug
  'test/lbTranslucentOverlapParitySmoke.mjs', // translucent solids batch into the combined route (CDT partition, direct OVER) — overlapping shapes match Slug
  'test/lbClipParitySmoke.mjs',          // LB clipped fill via the composed path vs Slug
  'test/lbMaskParitySmoke.mjs',          // LB masked fill via the composed path vs Slug
  'test/lbFilterParitySmoke.mjs',        // LB inline-filter fill via the composed path vs Slug
  'test/lbStrokeParitySmoke.mjs',        // LB fill + GPU stroke-coverage vs Slug
  'test/lbRecolorParitySmoke.mjs',       // LB + per-draw recolor (colorMatrix/palette) via the composite path vs Slug
  'test/lbTransformOverrideParitySmoke.mjs',// LB + per-shape transform override → per-shape Slug fallback vs Slug
  'test/lbBlendParitySmoke.mjs',         // LB + per-shape blend mode → per-shape Slug fallback vs Slug
  'test/lbPerShapeFallbackParitySmoke.mjs',// LB with a loop/cusp sentinel → per-shape Slug fallback vs Slug
  'test/lbSentinelDeferralSmoke.mjs',      // sentinels deferred past the combined draw only when order-safe
  'test/optParitySmoke.mjs',            // EVERY optimization must be output-identical to the plain path
  'test/filterCacheHitSmoke.mjs',       // a filter-cache HIT must paint what the MISS painted
  'test/filterFrameOriginSmoke.mjs',    // a filtered draw must not displace the NEXT draw
  'test/textTransplantWarmSmoke.mjs',   // setText's spent bundle shell must not reach the pipeline warmer
  'test/resolutionScaleSmoke.mjs',      // setResolutionScale: fewer pixels, same screen, no stranded RTs
  'test/groupRectSmoke.mjs',            // a group bounded to its content rect paints what the full-canvas one did
  'test/instancedFogSmoke.mjs',         // a fog (diagonal matrix + offset) must stay on the instanced fast path
  'test/coincidentAaSmoke.mjs',         // the occlusion cull (anti-conflation) must reach EVERY render path
  'test/gwnCurveRangeSmoke.mjs',          // a shape's curve range must end at its curves, not at the GWN tree
  'test/lbBuilderOwnershipSmoke.mjs',     // a 2nd (Slug-only) renderer must not disarm LB's off-thread builder
  'test/engineSwitchIndependenceSmoke.mjs', // an engine must draw the same regardless of what ran before it
  'test/aaMonotonicSmoke.mjs',           // AA must fall monotonically across an edge; aacFill must engage
  'test/lbSalientAaSmoke.mjs',           // LB vs SS: no neighbor spikes / non-monotone / bad outliers (not MSE)
  'test/cuspFillSmoke.mjs',              // a cubic's cusp fills solid to the tip (path.js splits it)
  'test/gwnEngineSmoke.mjs',            // GWN+SDF renders + matches Slug; a GWN kernel with no run tree is EMPTY
  'test/debugOverlaySmoke.mjs',         // showTriOutline draws on both routes, and shows the mesh actually submitted
  'test/occlusionCullSmoke.mjs',
  'test/morphOcclusionCullSmoke.mjs',   // morphCull: a morph culls only what is hidden for EVERY t (analytic, not sampled)        // bundle: a shape a later OPAQUE shape fully covers must not bleed through the AA edge (conflation)
  'test/lbTranslucentStripBlendSmoke.mjs', // LB: a TRANSLUCENT curved shape must not blend over ITSELF (curve strips co-covering the interior)
  'test/lbCubicOverfillSmoke.mjs',
  'test/lbQuadStripCoverageSmoke.mjs',
  'test/lbBand2Smoke.mjs',                 // unified curve band (kind 12): emission + quad-corner quality + no new artifacts
  'test/hitRenderAgreementSmoke.mjs',      // hit testing answers from WHAT IS DRAWN: band-walk fill decision == rendered pixels (all seg types, both fill rules) + memo consistency
  'test/lbInteriorBudgetSmoke.mjs',         // convex cubic rings: OVER over-fills overlapping hulls → partition
  'test/lbTranslucentSolidSmoke.mjs',      // translucent solids ride the combined route under 'auto'
  'test/lbGradientBatchSmoke.mjs',         // many DIFFERENT gradients in ONE combined draw (per-shape paint texture)
  'test/lbImageBatchSmoke.mjs',            // <image> shapes batch too; image paint tints by white, not fill
  'test/slugExactEdgeAASmoke.mjs',         // opt-in exact half-plane coverage for Slug's straight edges
  'test/slugQuadScaleSmoke.mjs',           // stable quad-root pair: wide symmetric quads at large viewports (white-slit class)
  'test/noAaStrokeCoverSmoke.mjs',         // hard-fill gate: only closed, later-stroked shapes may skip fill AA
  'test/nineSliceInstanceSmoke.mjs',       // bundle.nineSliceInstance: per-DRAW nine-slice — two sizes of ONE bundle, undistorted corners, base unmutated, re-slice via same handle
  'test/nineSliceFilterSmoke.mjs',         // nine-slice must stretch FILTERED shapes too (feDropShadow) — filter-pass scissor was clipping to the native bbox
  'test/precompileFillsSmoke.mjs',        // renderer.precompileFills: up-front warm all fill pipelines (no-idle games)
  'test/textBundleIdentitySmoke.mjs',      // textBundle: identity-stable setText/setStyle — same bundle object, bound handles re-upload via _geomGen, matches a fresh-bundle render
];

let failures = 0;
for (const rel of SMOKES) {
  const abs = path.join(ROOT, rel);
  process.stdout.write(`\n▶ ${rel}\n`);
  const r = spawnSync(process.execPath, [abs], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log(failures ? `\nRENDER-SMOKES FAIL (${failures}/${SMOKES.length})` : `\nRENDER-SMOKES PASS (${SMOKES.length})`);
process.exit(failures ? 1 : 0);
