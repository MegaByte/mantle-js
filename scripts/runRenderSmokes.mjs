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

const SMOKES = [
  'test/arcsJoinRenderSmoke.mjs',        // stroke: SVG2 arcs line join (curved vs round/miter)
  'test/loopBlinnRenderDiffSmoke.mjs',   // morphDraw: LB direct + route
  'test/leanShaderRenderDiffSmoke.mjs',  // shaderPrograms: lean fill variants
  'test/drawImageSmoke.mjs',             // drawImages: createImage/drawImage opts
  'test/bundleInstancedSmoke.mjs',       // instancedFill: drawBundleInstanced
  'test/spriteSheetSmoke.mjs',           // drawSprites: drawSprite
  'test/bundleHandleCacheSmoke.mjs',     // cacheDraw/staticCache: cache bake
  'test/a3InstanceGroupSmoke.mjs',       // staticCache: A3 instance-group shared-RT bake-once/blit-twice
  'test/filterVisualSmoke.mjs',          // shaderPrograms: fe* filter programs
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
  'test/lbCircleSdfSmoke.mjs',           // a filled circle → exact circular-SDF disc (kind 6), seam-free vs the ≤90° crescent seams; matches Slug at every boundary pixel
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
