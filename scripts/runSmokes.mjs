#!/usr/bin/env node
// runSmokes.mjs — curated fast smoke tests for CI / prepublish.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SMOKES = [
  'test/morphCullCertifierSmoke.mjs',   // morphCull: the analytic no-crossing certificate vs brute force over (u,v,t)
  'test/predicateTiersSmoke.mjs',
  'test/lbTransformRawFieldsSmoke.mjs',
  'test/font/hitTestSmoke.mjs',
  'test/font/hitTestWorldMatrixSmoke.mjs',
  'test/font/coverageHitSmoke.mjs',
  'test/font/robustnessSmoke.mjs',
  // HVAR-less variable-font advances via gvar phantom points.
  // CPU-only, golden-checked against the C# port; skips gracefully when the
  // NewYork.ttf fixture is absent (e.g. non-macOS CI).
  'test/font/hvarlessAdvanceSmoke.mjs',
  // gvar IUP (Interpolation of Untouched Points) inference — synthetic-contour
  // goldens shared with the C# port (TestGvarIup). No fixture needed.
  'test/font/gvarIupSmoke.mjs',
  'test/shaderGeneratedFreshSmoke.mjs',
  'test/featuresToFillDefinesSmoke.mjs',
  'test/featureSetSmoke.mjs',
  'test/svg/closeDeterminismSmoke.mjs',
  // Signed endpoint curvature per segment type — groundwork for the SVG2
  // `arcs` line join. Analytic goldens; the C# port must match.
  'test/svg/curvatureSmoke.mjs',
  'test/svg/degenerateArcSmoke.mjs',
  'test/workerFallbackSmoke.mjs',
  // Static guard for renderer cross-module bare refs and local/R.x shadows.
  // Fast, no browser. The puppeteer RENDER smokes (which exercise the modules
  // at runtime) run via scripts/runRenderSmokes.mjs in the browser-capable CI
  // stage.
  'test/rendererModuleContractSmoke.mjs',
  // The LB mesh a shape builds must not depend on its absolute position — the
  // quantized identity keys are origin-relative, else a glyph in a word triangulates
  // differently than alone (dropped crescents → a diagonal fill slash on 'v').
  'test/lbPositionIndependenceSmoke.mjs',
  // Node-side route coverage across the LB satellite modules: each fixture
  // exercises a distinct builder route; a missing cross-module import shows
  // up here as the builder's swallowed ReferenceError instead of a silent
  // per-shape Slug fallback in the browser render smokes.
  'test/lbBuildRoutesSmoke.mjs',
  // A concave-outline curved shape must fill via the fast
  // mesh, not under-fill: the earcut's interior-spanning tris must NOT be curve-ramped
  // (chord-edge requirement in splitInteriorByCurve). Reproduces on swiftshader.
  'test/lbConcaveCurveFillSmoke.mjs',
  // A non-deferrable loop/cusp sentinel (one a later LB shape paints over) must take the
  // batched SPLIT route — each contiguous LB run is ONE combined-VBO segment, each
  // contiguous sentinel run ONE Slug pass, interleaved in painter order — not a per-shape
  // draw storm and not a whole-bundle Slug bail. Asserts the split ran + Slug-matching ink.
  'test/lbSplitRouteSmoke.mjs',
  // Near-degenerate cubic pieces (a hull collapsed toward a point — ~0-length curve
  // sub-slivers) are DROPPED from the partition mesh before the self-audit: kept, they
  // destabilize the implicit into a spurious f<0 that falsely declines the whole shape
  // to Slug (and grows into a zoom-scaling over-paint). A/Bs the drop on the tiger.
  'test/lbDegenerateCubicDropSmoke.mjs',
  // The apex-tangent supporting-line clip (opt-in __LB_APEX_CLIP) recovers the FAT-POKE
  // decline class: over-painting Bezout crescents clipped to the chord side of their arc
  // apex tangent, re-audited so no over-paint ships. A/Bs the clip on the tiger.
  'test/lbApexClipSmoke.mjs',
  // A straight corner tri with ≥2 boundary edges must subdivide so every edge ramps
  // (else translucent rects — HUD slots — get a bright over-fill ring, defect #11).
  'test/lbBoundaryTriSubdivSmoke.mjs',
  // Travel-frame interiorSign verification on LINE-LESS contours: raw calibrateInterior
  // inverted the kind-10/12 end metadata on glyph bowls (the '8'-waist band holes).
  'test/lbInteriorSignSmoke.mjs',
  // Winding tree (windingTree.js): exact agreement with rayWinding/pointInFill on thousands
  // of probes (all seg types, seam rows, both fill rules) + stroke-prune completeness +
  // the it-actually-wins timing gate. Accelerates lbPartition inkAt and hit tests.
  'test/windingTreeSmoke.mjs',
  // The CDT's orientation predicate is adaptive-EXACT (Shewchuk); this validates
  // it against a BigInt oracle incl. near-collinear inputs where the naive double
  // determinant flips sign — the class that caused the cavity-livelock dead stripe.
  'test/predicatesExactSmoke.mjs',
  // earcut 3.x `deviation()` area self-check: proves our ear-clip port exactly
  // tiles the polygon (the "wrong wedges" mis-threading class shows up as a large
  // deviation), and that the metric is non-vacuous.
  'test/earcutDeviationSmoke.mjs',
  // Exact-predicate CDT robustness on near-degenerate input (microscopic edges,
  // near-collinear / near-cocircular / near-duplicate) — the class CGAL 6.2
  // hardened for; must stay valid or clean-null, never throw/hang/invert.
  'test/cdtDegenerateStressSmoke.mjs',
  // G4: opt-in intersecting-constraint resolution (split crossing constraints at a
  // shared inserted vertex). Off by default, so the default CDT path is unchanged.
  'test/cdtIntersectResolveSmoke.mjs',
  // G4 wired: self-CROSSING straight outlines (bowtie/pentagram) render via the LB
  // CDT partition (crossing constraints split) with the correct even-odd/nonzero
  // fill shape, instead of dropping to Slug.
  'test/cdtSelfIntersectFillSmoke.mjs',
  // G1 (parallel build): exact signed-area coverage module — matches ground-truth
  // clipping and is conflation-free at abutting-triangle junctions.
  'test/signedAreaCoverageSmoke.mjs',
  // G1 stage 3: end-to-end mesh-free fill on a holed curved glyph (no CDT/mesh/
  // per-primitive coverage) vs supersampled truth; conflation-free.
  'test/meshFreeGlyphSmoke.mjs',
  // Production CPU rasterizer (shader twin): all curve types incl. exact rational.
  'test/meshFreeRasterSmoke.mjs',
  // Mesh-free handles every case Slug exists for (loops/cusps/degenerate/self-
  // intersection) — the cases LB cannot render. Proof it can replace Slug.
  'test/meshFreeSlugCasesSmoke.mjs',
  // The SUPPORTED text metrics surface: sections.runMetrics (typoBBox +
  // baselines + lineCount) — shape and semantics games lay out against.
  // GL-free; skips when the Roboto fixture isn't fetched.
  'test/textRunMetricsSmoke.mjs',
  // buildNineSliceMesh: pure cover-quad 3x3 rewrite (borders, clamps,
  // passthroughs, aEmCoord pinning).
  'test/nineSliceSmoke.mjs',
  // Morph hit tests must evaluate geometry at the current t (CPU planes stay
  // at t=0 while the GPU lerps). Also honors override visibility.
  'test/morphHitPoseSmoke.mjs',
  'test/lbCanonicalHashesSmoke.mjs',
];

let failures = 0;
for (const rel of SMOKES) {
  const abs = path.join(ROOT, rel);
  process.stdout.write(`\n▶ ${rel}\n`);
  const r = spawnSync(process.execPath, [abs], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log(failures ? `\nSMOKES FAIL (${failures}/${SMOKES.length})` : `\nSMOKES PASS (${SMOKES.length})`);
process.exit(failures ? 1 : 0);
