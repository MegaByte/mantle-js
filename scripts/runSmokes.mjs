#!/usr/bin/env node
// runSmokes.mjs — curated fast smoke tests for CI / prepublish.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SMOKES = [
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
  'test/featureSetSmoke.mjs',
  'test/svg/closeDeterminismSmoke.mjs',
  // Signed endpoint curvature per segment type — groundwork for the SVG2
  // `arcs` line join. Analytic goldens; the C# port must match.
  'test/svg/curvatureSmoke.mjs',
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
