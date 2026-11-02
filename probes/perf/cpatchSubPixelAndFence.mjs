// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/cpatchSubPixelAndFence.mjs — CPatch's sub-pixel over-ink and the fence-free residual: what the
// CPU twin can measure, which draws get the sub-pixel piece, and the GPU runs that read the rest.
//
//   node probes/perf/cpatchSubPixelAndFence.mjs
//
// The sub-pixel coverage lives in the shaders: `exactBoxCov3` and the two-tightest tracking in
// `_boxCov.glsl` / `_cpatchCoverage.glsl`. The first table counts those features in the shader and in the
// CPU twin (`src/renderer/cpatchCov.js`); a CPU quality instrument (`_rowGateAaRef`, `_rowGateSpill`,
// `_zzAaAudit`, `_cpatchShapeQuality`, `morphScale/_morphCov`, and the smokes built on the same model) can
// only see a feature the twin carries.
//
// ── THE RESIDUAL OVER-INK, from the code ────────────────────────────────────────────────────
//
// 1. only TWO CONSTRAINTS ARE exact. The walk keeps a 2-deep sorted set, so a pixel with a
//    THIRD binding outline constraint falls back to min(), which returns the largest single
//    coverage — over-ink. Only ONE cut is carried, so a pixel straddling two seams keeps min()
//    for the second.
// 2. THE RELAXED SEAM TRADES OVER-INK FOR UNDER-COVERAGE: the two pieces sum to the pixel's coverage
//    and OVER is short by their product, so every relaxed seam carries a residual a*b deficit.
// 3. A MORPH OR TRANSLUCENT DRAW GETS NONE OF IT. `fillPass` pushes MANTLE_CPATCH_SEAM_HARD
//    whenever the unified draw claims depth, and the hard-seam branch skips the `exactBoxCov3`
//    piece and the soft hull. A CPatch MORPH therefore never receives the sub-pixel piece.
//    (The `exactBoxCov2` min-combine is outside that guard and does apply.)
// 4. AN ALL-SEAM PATCH THINNER THAN A PIXEL IS UN-ANTIALIASED, and its own area is not a legal
//    substitute: the depth claim draws ONE patch per pixel, so a ribbon cut into cells along its
//    length reports one cell's share and the neighbors never draw. The two routes are to sum the
//    pieces a pixel holds, which plain OVER cannot express, or not to split a feature already
//    thinner than the grid.
//
// ── THE FENCE-FREE RESIDUAL, in the kernel's own words ──────────────────────────────────────
//
// The fence-free route is the only route. Its residual is NOT primarily at corners
// (`_cpatchCoverage.glsl`):
//
//   "a skirt fragment carries TWO of its patch's planes and a patch has up to six, so wherever
//    a third is the binding bound ... relaxing either of the two leaves nothing holding the
//    fragment in."
//
// And the geometric statement of where the residual lives, from the converter (`cpatchConvert.js`):
//   "The box is LOOSER than the convex cover the search validates against, so the guarantee ...
//    and the enforcement no longer meet"
//
// The skirt's normal is DERIVED from its offset direction (`vec2 hvN = vTC.xy;`). On a miter-joined
// skirt the outer corner moves along the bisector of two normals, so the derived one is off by the
// miter angle there; the GPU A/B below measures whether that reaches a pixel.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');

console.log('\n== can the CPU twin measure the shipped kernel? ==');
{
  const cov = readFileSync(path.join(JS, 'src/renderer/cpatchCov.js'), 'utf8');
  const shader = readFileSync(path.join(JS, 'src/shaders/_cpatchCoverage.glsl'), 'utf8');
  const count = (t, re) => (t.match(re) || []).length;
  const rows = [
    ['exactBoxCov2 (two half-planes, the min-combine)', /exactBoxCov2/g],
    ['exactBoxCov3 (three, the relaxed seam piece)', /exactBoxCov3/g],
    ['the fence-free hull (vTC.z)', /vTC\.z/g],
  ];
  console.log('  feature                                          shader   CPU twin');
  for (const [name, re] of rows) {
    console.log(
      `  ${name.padEnd(48)} ${String(count(shader, re)).padStart(6)}   ${String(count(cov, re)).padStart(8)}`,
    );
  }
  console.log(
    `  ${'exactBoxCov (one half-plane)'.padEnd(48)}` +
      ` ${String(count(shader, /exactBoxCov(?![23])/g)).padStart(6)}   ${String(count(cov, /exactBoxCov(?![23])/g)).padStart(8)}`,
  );
  console.log('  -> a feature the CPU twin counts 0 of is invisible to every CPU quality probe in');
  console.log('     the tree, since they are all built on it.');
}

console.log('\n== which draws get the sub-pixel piece at all ==');
{
  const fp = readFileSync(path.join(JS, 'src/renderer/fillPass.js'), 'utf8');
  const hard = /MANTLE_CPATCH_SEAM_HARD/.test(fp);
  const claims = /const claims = R\.opts\.unifiedFillDepthClaim/.test(fp);
  console.log(`  fillPass pushes MANTLE_CPATCH_SEAM_HARD: ${hard}`);
  console.log(`  ...gated on the depth claim:            ${claims}`);
  console.log('  The claim engages for a translucent draw (alpha in (0.004, 0.996)), for any');
  console.log('  overrides table, for a morph, and for a bundle that needs the claim. Every one');
  console.log('  of those takes the HARD seam and therefore skips the exactBoxCov3 piece. So the');
  console.log(
    '  sub-pixel piece is an OPAQUE-STATIC feature, and any measurement of it on a morph',
  );
  console.log('  is measuring the branch that does not contain it.');
}

console.log(`
== FIRST, A CPU CHECK ========================================================================

CPU  cpatchCov.js matches the shipped kernel.
  It must carry exactBoxCov2 / exactBoxCov3, the two-tightest tracking and the fence-free hull, so the
  twin composes constraints the way the shader does. Then every existing CPU probe measures the
  kernel that ships.
  gate:  per-patch coverage agreeing with a rendered readback to within the readback's own 1/255
         on a handful of patches -- the twin does not have to be bit-exact, it has to be the
         SAME MODEL. (A shared endpoint IS zero here: do not chase the shader's ulps.)
  fill in: [ ] exactBoxCov2   [ ] exactBoxCov3   [ ] fence-free hull   [ ] agrees on N patches

== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU  How much sub-pixel over-ink is left, and where.
  Without the CPU check above this has to be read off frames.
    assets:  Roboto at a 3 px cap, a 0.5 px bar
             grid, a 1.5 px square grid, and tiger at 512 for the regression side.
    arms:    A default; B __CP_DEFINES=MANTLE_CPATCH_MINCOMBINE,MANTLE_CPATCH_SEAM_MINPIECE
             (both mechanisms off, i.e. no sub-pixel coverage). The shipped kernel has no such
             defines: B runs on a tree that carries them (TREES= in probes/_zzEngineCorpus.mjs
             interleaves the two trees in one run).
    read:    INK RATIO against the exact reference, not luminance and not a diff against another
             engine. Report it per asset as a percentage over/under.
    fill in: bars 0.5px  A ____%  B ____%   |  squares 1.5px  A ____%  B ____%
             Roboto 3px  A ____%  B ____%   |  tiger AA>0.3   A ____   B ____
    Expected, B -> A: 0.5px bars +38% -> +4.9%, 1.5px squares +13% -> +4.8%, Roboto 3px cap
    +69% -> +24%, 5.7px +22.8% -> +8.5%, at a cost of tiger AA>0.3 250 -> 318 at 512.

GPU  The derived skirt normal at a miter.
  arms:   A default (normal DERIVED from vTC.xy); B a build carrying the skirt normal
          explicitly in a spare slot.
  asset:  a shape with SHARP miter joins on thin features -- a star with narrow points is the
          cheapest, and the tree already has one.
  read:   wrong-solid and AA max at the join pixels specifically, not the whole-frame mean; the
          claim is about a handful of fragments per join.
  decide: whether the derived normal's miter-angle error is a residual that reaches a pixel.
  fill in: A wrong at joins ____   B ____   |  A AA max ____   B ____
`);
