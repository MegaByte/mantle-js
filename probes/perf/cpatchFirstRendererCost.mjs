// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/cpatchFirstRendererCost.mjs — why the first CPatch renderer in a page reads ~2x slow for its
// whole life, and what does NOT cause it.
//
//   node probes/perf/cpatchFirstRendererCost.mjs
//
// THE CAUSE is the first COMPILE of each shader source, which stays slow for that program's life; a
// renderer-owned warm-up of the coefficient texture, built and timed on a GPU, does not move the first
// frame. probes/shaderArmAB.mjs discards a first compile per source for that reason. This probe prints
// which warm-ups the tree carries, so a pool warm-up is not mistaken for a GPU one, and the recipe for
// re-testing an allocation warm-up.
//
// this ONE HAS NO CPU MEASUREMENT AND SHOULD NOT PRETEND TO. The effect is a frame time or it is
// nothing.
//
// ── WHAT IS RULED OUT, each BY MEASUREMENT ──────────────────────────────────────────────────
//
// Tiger at 512: the first CPatch renderer in a page reads 5.50 ms, every arm after it 2.40-2.60.
//
//   * NOT the GPU warming up. With ARMS='lb,lb,cpatch,cpatch', LB is already fast as the FIRST
//     arm (2.30 -> 2.10) and CPatch still reads 5.50 at position three. Only a previous CPATCH
//     renderer helps.
//   * NOT the fill variant: the same key in every arm, and not the universal program.
//   * NOT the program link: precompileFills() changes nothing.
//   * NOT uploads or extra draws: GLCOUNT=1 gives 24 drawArrays, zero texImage2D, zero
//     bufferData, and debugStats byte-identical across arms.
//   * NOT a one-off pipeline build: 14 / 24 / 48 / 96 / 400 frames all read 4.7-5.4. Two
//     seconds of drawing never converge. The renderer is slow FOR ITS whole LIFE.
//   * NOT the first large allocation. An embedder-side throwaway looks like it:
//
//       WARM2=1        throwaway renderer + bundle, drawn, then disposed   2.60 ms
//       WARM2=nodraw   built and disposed, never DRAWN                     3.10 ms
//       WARM2=bundle   throwaway bundle on the MEASURED renderer           5.60 ms
//       (unset)                                                            5.50 ms
//
//     but a throwaway renderer also compiles the program sources first, and a renderer-owned
//     allocation of a patch-texture-sized texture at construction (no compile) does not move the
//     first frame.
//
// `warmCpatchPool` warms the WORKER pool (off-thread conversion) and touches no GL at all. Counted
// below so the two stay apart.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');

console.log('\n== what warm-up exists, and is it a GPU one? ==');
{
  const pool = readFileSync(path.join(JS, 'src/renderer/cpatchWorkerPool.js'), 'utf8');
  const fill = readFileSync(path.join(JS, 'src/renderer/fillPass.js'), 'utf8');
  const uni = readFileSync(path.join(JS, 'src/renderer/unifiedFillDraw.js'), 'utf8');
  const hasWarm = /export function warmCpatchPool/.test(pool);
  const warmUsesGl = /gl\.|createTexture|texImage2D/.test(
    (pool.match(/export function warmCpatchPool[\s\S]*?\n}/) || [''])[0],
  );
  const coefWarm = /_warmCoefTex\s*=\s*function/.test(uni);
  const coefWarmFlag = /__MANTLE_COEF_WARM/.test(uni);
  const coefWarmDefaultOff = !/__MANTLE_COEF_WARM\s*(!==|===)\s*false/.test(uni);
  console.log(`  warmCpatchPool exists                 : ${hasWarm}`);
  console.log(`  ...and touches GL                     : ${warmUsesGl}`);
  console.log(`  fillPass calls it                     : ${/warmCpatchPool\(/.test(fill)}`);
  console.log(`  R._warmCoefTex (the GPU one) exists   : ${coefWarm}`);
  console.log(`  ...driven by __MANTLE_COEF_WARM       : ${coefWarmFlag}`);
  console.log(`  ...and OFF unless asked               : ${coefWarmDefaultOff}`);
  console.log(
    '  -> warmCpatchPool warms the WORKER POOL (off-thread conversion) and touches no GL.',
  );
  console.log(
    '     A GPU allocation warm-up would be R._warmCoefTex (allocate, upload and delete one',
  );
  console.log(
    "     RGBA32F of the coefficient texture's kind at renderer construction), driven by",
  );
  console.log(
    '     __MANTLE_COEF_WARM; the shipped renderer has none. The recipe below needs a tree that does.',
  );
}

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU  Does a renderer-owned warm-up recover the first-renderer penalty?
  build:   on a tree that carries it: \`globalThis.__MANTLE_COEF_WARM = true\` allocates, uploads and
           deletes one RGBA32F of 256 x 2432 texels (9.5 MB, CPatch's raw data size) on unit 12 at
           renderer construction, with the same parameters the real allocation asks for; '<w>x<h>'
           sets any other size. Check \`R._coefWarm\` in each arm -- null means the arm warmed
           NOTHING however the flag was spelled, which is the trap that makes a warm-up A/B read as
           noise. The "draw one triangle" half is NOT built (no program, VAO or bundle exists at
           construction), so expect B to land at WARM2=nodraw rather than at WARM2=1.
  arms:    with ARMS='cpatch,cpatch' on a FRESH page each time:
             A  default, first arm                   expect ~5.5 ms
             A' default, second arm                  expect ~2.5 ms
             B  warm-up on, first arm                expect ~2.6-3.1 ms
             B' warm-up on, second arm               expect ~2.5 ms
  RESULT: B reads ~5.5, so the cause is not the first large allocation; the first-compile cost is
  (see the header). The allocation hypothesis predicted B at about WARM2=nodraw (3.10). Second
  falsifier, one more run:
  __MANTLE_COEF_WARM = '8x8' warms 4 KB instead of 9.5 MB; if THAT also reads ~3.1 the size is not
  what the allocator is matching on and the recipe is wrong whatever B said.
  A PAGE PER ARM. This effect is per-page and per-renderer-order; two arms in one page measure
  the second arm twice.
  also:    measure the startup cost of the warm-up itself on a scene with NO CPatch content. If
           it is not free there, it has to be gated on the bundle, and then it is back to
           arriving too late -- which is what makes this a design question and not a patch.
  fill in: A ____ ms   A' ____ ms   B ____ ms   B' ____ ms   |  warm-up startup cost ____ ms

GPU  Is it the patch texture specifically?
  One run decides the SIZE and the FORMAT of a throwaway: allocate the throwaway as (a) the same format and size as the patch texture,
  (b) the same bytes in a different format, (c) a plain buffer of the same bytes. If only (a)
  recovers the time, the allocator is matching on format and the warm-up must match it too.
  fill in: (a) ____ ms   (b) ____ ms   (c) ____ ms
`);
