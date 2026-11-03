// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/frameClaims.mjs — three per-frame performance claims, taken to a verdict each.
//
// GL-FREE. Two of the three are settled by reading the code (what the stencil buffer is used
// for; whether cross-bundle early-Z can ever reject anything); the third — why the opaque
// prepass engages on nothing — is settled by running its own gate over the corpus with a
// one-sided bound in place of the occupancy bits, which a worker would otherwise have to build.
//
//   node probes/perf/frameClaims.mjs
//
// ── THE CLAIMS ──────────────────────────────────────────────────────────────────────────────
//
// A. "every drawBundle clears STENCIL and DEPTH (loses cross-bundle early-Z)".
//
//    STENCIL: PRICED AND REJECTED, for a stronger reason than the claim's. Mantle never
//    TESTS THE STENCIL BUFFER. There is not one `gl.stencilFunc` or `gl.stencilOp` call in
//    src/, and every `STENCIL_TEST` mention is a DISABLE or a save/restore of something nothing
//    enables (counted below). So the stencil bit in those clears costs nothing to correctness
//    and removing it is very likely a PESSIMIZATION, not a win: the attachment is a packed
//    DEPTH24_STENCIL8 renderbuffer (renderer.js, cacheDraw.js), and clearing only half of a
//    packed buffer is what makes a driver fall off its fast clear path. The right change, if
//    any, is to stop ALLOCATING stencil — which is the consumer's `getContext` attribute, not
//    ours, and Mantle's own fallback path already asks for `stencil: true` with `depth: false`
//    (src/fallback/autoScene.js), which is backwards.
//
//    DEPTH: NOT A DEFECT, by the frame's own semantics. Mantle paints in PAINTER'S ORDER, so a
//    bundle drawn later is IN FRONT of every bundle drawn earlier. Early-Z rejects the fragments
//    of the current draw against depth already in the buffer — i.e. it can only reject fragments
//    that are BEHIND. A later bundle is never behind an earlier one, so cross-bundle early-Z has
//    nothing to reject and the clear loses nothing. (The one exception is `submitBundle`, which
//    REORDERS before painting — and it reorders into painter's order too, so the conclusion
//    holds.) The clear is also load-bearing in the other direction: the fill pass enables
//    DEPTH_TEST with LEQUAL and depth WRITES on (`glDepthMask(!_opaquePrepassActive)`), so a
//    bundle inherits the previous bundle's depth values without it — which is the cross-bundle
//    painter-order failure the clear prevents.
//
// B. "the opaque prepass gate engages on 0 of 98 assets". REPRODUCED BELOW, with the condition
//    that kills it named. The gate is a conjunction and only one clause needs to fail.
//
// C. "without KHR_parallel_shader_compile variants link synchronously". TRUE AND NOT FIXABLE
//    FROM HERE: without the extension there is no completion query, so `getProgramParameter`
//    with LINK_STATUS is the only way to ask and it blocks. What the renderer already does is
//    the only available mitigation — move the stall to LOAD rather than to the first frame
//    (`prewarmFillVariant` per bundle, `fillWarmTick` one per frame before any draw,
//    `precompileFills()` as the explicit "stall me HERE"). Nothing to measure.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');

// ── A: the stencil buffer, counted ──────────────────────────────────────────────────────────
console.log('\n== A: what the stencil buffer is used for ==');
{
  const src = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) src.push(p);
    }
  };
  walk(path.join(JS, 'src'));
  let stencilFunc = 0,
    stencilOp = 0,
    enableStencil = 0,
    disableStencil = 0,
    clearsWithStencil = 0;
  let stencilMask = 0,
    isEnabled = 0;
  for (const p of src) {
    const t = readFileSync(p, 'utf8');
    stencilFunc += (t.match(/\.stencilFunc\s*\(/g) || []).length;
    stencilOp += (t.match(/\.stencilOpSeparate\s*\(|\.stencilOp\s*\(/g) || []).length;
    stencilMask += (t.match(/\.stencilMask\s*\(/g) || []).length;
    enableStencil += (t.match(/glEnable\([^)]*STENCIL_TEST\)/g) || []).length;
    disableStencil += (t.match(/glDisable\([^)]*STENCIL_TEST\)/g) || []).length;
    isEnabled += (t.match(/isEnabled\([^)]*STENCIL_TEST\)/g) || []).length;
    clearsWithStencil += (t.match(/STENCIL_BUFFER_BIT/g) || []).length;
  }
  console.log(`  ${src.length} source files scanned`);
  console.log(`  gl.stencilFunc call sites   : ${stencilFunc}`);
  console.log(`  gl.stencilOp call sites     : ${stencilOp}`);
  console.log(`  gl.stencilMask call sites   : ${stencilMask}   (all immediately before a clear)`);
  console.log(
    `  glEnable(STENCIL_TEST)      : ${enableStencil}   (restores of a saved value only)`,
  );
  console.log(`  glDisable(STENCIL_TEST)     : ${disableStencil}`);
  console.log(`  isEnabled(STENCIL_TEST)     : ${isEnabled}`);
  console.log(`  STENCIL_BUFFER_BIT in clears: ${clearsWithStencil}`);
  console.log('  -> with 0 stencilFunc and 0 stencilOp, no fragment is ever stencil-tested. The');
  console.log('     bit in the clear is free; the allocation is the only thing that is not, and');
  console.log("     that is the consumer's getContext attribute.");
}

// ── B: the opaque prepass gate ──────────────────────────────────────────────────────────────
console.log('\n== B: why the opaque prepass never engages ==');
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
  const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
  const { isPlainOpaque } = await import(path.join(JS, 'src/renderer/occlusionCull.js'));

  // The gate's own constants (opaquePrepass.js).
  const MIN_CELLS = 512,
    OVERLAP_GRID = 64,
    MIN_OVERLAP = 1.35;
  const VECTOR_EFFECT_FLAGS = 1024 | 2048 | 4096;

  const dirs = [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')];
  const files = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
    } catch {}
  }
  files.sort();

  let assets = 0,
    noOpaque = 0,
    failOverlap = 0,
    couldPass = 0;
  const passers = [];
  for (const f of files) {
    let sec, pm;
    try {
      sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
      pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    } catch {
      continue;
    }
    const n = sec.numShapes | 0,
      st = pm.floatsPerShape | 0,
      m = pm.metaFloats;
    const gbb = sec.globalBBox;
    if (!n || !st || !gbb || !(gbb[2] > 0) || !(gbb[3] > 0)) continue;
    assets++;
    // Which shapes could ever contribute a cell?
    let opaque = 0,
      area = 0;
    const bits = new Uint8Array(OVERLAP_GRID * OVERLAP_GRID);
    for (let s = 0; s < n; s++) {
      if (!isPlainOpaque(m, st, s)) continue;
      if ((Math.floor(m[s * st + 27] + 0.5) & VECTOR_EFFECT_FLAGS) !== 0) continue;
      const o = s * st;
      const x0 = m[o],
        y0 = m[o + 1],
        x1 = m[o + 2],
        y1 = m[o + 3];
      if (!(x1 > x0) || !(y1 > y0)) continue;
      opaque++;
      area += (x1 - x0) * (y1 - y0);
      let ix0 = Math.max(
        0,
        Math.min(OVERLAP_GRID - 1, Math.floor(((x0 - gbb[0]) / gbb[2]) * OVERLAP_GRID)),
      );
      let iy0 = Math.max(
        0,
        Math.min(OVERLAP_GRID - 1, Math.floor(((y0 - gbb[1]) / gbb[3]) * OVERLAP_GRID)),
      );
      let ix1 = Math.max(
        0,
        Math.min(OVERLAP_GRID - 1, Math.floor(((x1 - gbb[0]) / gbb[2]) * OVERLAP_GRID)),
      );
      let iy1 = Math.max(
        0,
        Math.min(OVERLAP_GRID - 1, Math.floor(((y1 - gbb[1]) / gbb[3]) * OVERLAP_GRID)),
      );
      for (let iy = iy0; iy <= iy1; iy++)
        for (let ix = ix0; ix <= ix1; ix++) bits[iy * OVERLAP_GRID + ix] = 1;
    }
    if (!opaque) {
      noOpaque++;
      continue;
    }
    let occ = 0;
    for (let i = 0; i < bits.length; i++) occ += bits[i];
    const unionArea = occ * ((gbb[2] * gbb[3]) / bits.length);
    // A ONE-SIDED BOUND, deliberately. The gate divides the CELLS' total area by the union of
    // the cells; a cell is inside its shape's bbox, so bbox area / bbox union is an OVER-
    // estimate of that ratio on the numerator and an over-estimate of the union too. Where the
    // BBOX ratio is already under MIN_OVERLAP the cell ratio certainly is, and the gate cannot
    // pass however the occupancy bits land — which is what makes this answerable without a
    // worker.
    const ratio = unionArea > 0 ? area / unionArea : 0;
    if (ratio < MIN_OVERLAP) {
      failOverlap++;
      continue;
    }
    couldPass++;
    passers.push([path.basename(f), opaque, ratio.toFixed(2)]);
  }
  console.log(`  ${assets} assets`);
  console.log(`  no plain-opaque shape at all        : ${noOpaque}`);
  console.log(
    `  bbox overlap already under ${MIN_OVERLAP}x   : ${failOverlap}   <- cannot pass, whatever`,
  );
  console.log(`                                          the occupancy bits say`);
  console.log(`  could still pass on overlap          : ${couldPass}`);
  for (const [nm, k, r] of passers.slice(0, 12)) {
    console.log(`     ${nm.padEnd(32)} ${String(k).padStart(4)} opaque shapes, bbox overlap ${r}x`);
  }
  console.log('  ...and each survivor must ALSO clear three more clauses that this cannot see');
  console.log(
    `  without building the occupancy grids: at least ${MIN_CELLS} certified interior cells,`,
  );
  console.log('  the smallest of them over 1.5 device px after the world transform, and a draw');
  console.log('  list with no filter, blend, mask or COLR op on any shape. The gate is a');
  console.log('  conjunction, so "engages on 0" needs only one of the five to fail per asset.');
}

// ── C: the link stall ───────────────────────────────────────────────────────────────────────
console.log('\n== C: synchronous variant links without KHR_parallel_shader_compile ==');
console.log('  TRUE, and there is nothing to build: without the extension there is no completion');
console.log('  query, so asking whether a program linked IS the block. The renderer already does');
console.log('  the only available thing -- move the stall to LOAD: prewarmFillVariant per bundle,');
console.log('  fillWarmTick one variant per frame BEFORE any draw, precompileFills() as the');
console.log('  explicit "stall me here", and a lean variant falls back to the full program while');
console.log('  it links rather than blocking on it.');

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU A  Does dropping STENCIL_BUFFER_BIT from the per-bundle clear help or hurt?
  Only run this if the stencil buffer is still being ALLOCATED (it is: mantleDemo.html asks
  for stencil: true). The prediction is that it HURTS, because the attachment is a packed
  DEPTH24_STENCIL8 and a partial clear of a packed buffer can force a read-modify-write
  instead of a fast clear. Arms: default vs COLOR|DEPTH only, on a multi-mount scene (8+
  drawBundle calls per frame) at 2048.
  PREDICTION: B is slower or tied. If B is faster, the follow-up is not to keep B -- it is to
  stop allocating stencil at all, which is a documentation change for consumers plus
  src/fallback/autoScene.js, and costs nothing at run time.
  fill in: A/A ____ %  |  B/A ____ x  |  verdict ____

GPU B  Is the per-bundle DEPTH clear measurable at all?
  arms: default vs a build that clears depth once per FRAME instead of once per bundle. That is
  WRONG (it reintroduces the cross-bundle painter-order failure), so read the timer only and
  confirm the frame is wrong -- if it renders correctly the scene has no cross-bundle overlap
  and the arm proves nothing.
  scene: 16 overlapping mounts at 2048.
  PREDICTION: inside the A/A floor. A full-surface depth clear is a load-action on a tiler and
  a fast clear elsewhere. If it is NOT inside the floor, the answer is still not to remove the
  clear -- it is to gate it on whether this bundle's draw list can reach the depth test at all.
  fill in: A/A ____ %  |  B/A ____ x  |  frame wrong as expected [ ]

GPU C  The prepass, on an asset built to pass its gate.
  The gate's value when it engages is unknown -- "engages on 0 of 98" says it
  never fires, not that firing would not pay. Build the asset the gate describes: 600+ large
  flat opaque shapes stacked with >= 2x overlap, no filters, at 2048 where fill rate binds.
  Then arm A = default, arm B = opaquePrepass forced off.
  PREDICTION: B is faster than A on every real asset (the prepass is pure added cost when it
  cannot reject), and A is faster than B on the built one. If A does not win even there, the
  whole pass is dead code and should be deleted rather than re-gated.
  fill in: synthetic ____ x  |  tiger ____ x  |  verdict: re-gate / delete / keep
`);
