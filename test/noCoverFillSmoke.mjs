// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noCoverFillSmoke — a unified draw whose every fill row is a mesh compiles NO cover fill kernel
// (MANTLE_NO_COVER_FILL), and that program draws every cover quad such a draw emits bit-identically.
//
// The cover fill kernel -- Slug's renderFill, or AAC, hard or GWN -- shades one thing: the cover quad of a FILL
// row. On the unified route a row with a Loop-Blinn mesh draws its triangles instead, and a stroke row's cover
// quad has doFill false, so a draw whose fill rows are all meshes never runs the kernel at all. Compiled in
// anyway, its presence is not free: lbMemBudget's LB program is 8,439 optimized SPIR-V instructions with Slug in it
// and 5,231 without (spirv-opt -O; a liveness proxy for registers 78 -> 70 components). AAC is kept out of such a
// draw (coverKernelPolicy); this takes out the kernel it would fall back to.
//
//   (a) the real renderer on test/_fakeGl.mjs binds MANTLE_NO_COVER_FILL for an all-mesh bundle (lbMemBudget) under
//       kernel 'slug' and 'auto' -- and NOT for a bundle with a cover fill row (a transform override sends one row
//       to its cover quad -- and that draw WARMS, since the pipeline warm replays the override table), nor
//       under a per-draw color matrix (it lifts a stroke row's empty fill into a fill);
//   (b) the classic fill pass never binds that key: it shades every row as a cover quad and would draw every fill
//       empty, so it keeps a usable base or completes the required cold AAC program;
//   (d) after the loading call (awaitLbReady, then precompileFills), the FIRST frame of an override draw takes the
//       unified route: the warm builds a key's cover sibling (the key without the define, which that draw binds)
//       beside it;
//   (e) a key without the kernel that is still cold draws with its warm cover sibling (the same pixels), so turning
//       the 'lb' route on after an 'auto' warm keeps the route on the first frame;
//   (c) main() of the generated shader in float32 (test/_glslMainEmu), with and without the define, over the
//       shader-identity assets and the uniform scenarios without a color matrix: bit-identical on every cover
//       fragment of a row with no fill (the only cover quads such a draw emits), and different on fill rows (the
//       define is not a no-op).
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const warn = console.warn;
console.warn = () => {};

const LBMEM = readFileSync(path.join(ROOT, 'examples/smoke/lbMemBudget__SVG.svg'), 'utf8');
// A filled blob (a mesh on the 'lb' route) and a stroke-only path (a cover quad whose doFill is false).
const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy}` +
  ` C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const FILL_AND_STROKE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${blob(35, 40, 25)}" fill="#48c"/>` +
  `<path d="${blob(65, 60, 25)}" fill="none" stroke="#222" stroke-width="3"/></svg>`;

async function bound(svg, { kernel = 'slug', draw = null, size = 512, route = 'lb' } = {}) {
  const F = createFakeGl({ width: size, height: size });
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false, staticUnified: true });
  R.setFillEngine({ route, kernel });
  const b = createBundle(F.gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the key check reports it */
    }
  }
  R.setViewport(size, size);
  R.prewarmBundle(b);
  let key = '';
  for (let i = 0; i < 30; i++) {
    R.beginFrame([1, 1, 1, 1]);
    if (draw) draw(R, b, F.gl);
    else R.drawBundle(b);
    R.endFrame();
    R.precompileFills();
    key = R.debugStats.drawnFillVariantKey || '';
    if (i >= 2 && key) break;
  }
  const out = { key, defs: new Set(key.split('|')), gate: R.debugStats.unifiedFillGate, R, b };
  return out;
}

// ---- (a) --------------------------------------------------------------------------------------------------------
for (const kernel of ['slug', 'auto']) {
  const r = await bound(LBMEM, { kernel });
  ok(
    r.gate === 'on' && r.defs.has('MANTLE_LB_FILL') && r.defs.has('MANTLE_NO_COVER_FILL'),
    `(a) lbMemBudget, every fill row a mesh, kernel '${kernel}': the unified program has no cover fill kernel (gate ${r.gate}; ${r.defs.has('MANTLE_NO_COVER_FILL') ? 'NO_COVER_FILL' : 'kernel present'})`,
  );
  try {
    r.R.dispose();
  } catch {
    /* headless */
  }
}
{
  // One shape moved by a transform override takes its cover quad (entriesFor), so its fill needs the kernel.
  const { createOverrideTable } = await import('../src/index.js');
  let ov = null;
  const r = await bound(LBMEM, {
    draw: (R, b, gl) => {
      if (!ov) {
        ov = createOverrideTable(gl, b);
        ov.set(0, { localPosition: [2, 3], localScale: [1.1, 1.1] });
      }
      R.drawBundle(b, { overrides: ov });
    },
  });
  // The key depends on the override, so the slack-time pipeline warm must replay it: otherwise the draw sits on
  // 'variant-warming' and the classic Slug pass for good (the AAC gating has the same hole under 'auto').
  ok(
    r.gate === 'on' && r.defs.has('MANTLE_LB_FILL') && !r.defs.has('MANTLE_NO_COVER_FILL'),
    `(a) ...a transformed row takes its cover quad: the unified draw warms and keeps the kernel (gate ${r.gate}, ${r.defs.has('MANTLE_NO_COVER_FILL') ? 'dropped' : 'kept'})`,
  );
  try {
    r.R.dispose();
  } catch {
    /* headless */
  }
  // The AAC gating's case: under kernel 'auto' at 2048 px the policy picks AAC only for a draw with cover rows, and
  // the override is what makes them -- a key a warm without the override never builds, so the draw would sit on the
  // classic pass. (Every row is moved: one moved row does not buy AAC its presence -- coverKernelPolicy.aacPresenceTerms.)
  let ov2 = null;
  const r2 = await bound(LBMEM, {
    size: 2048,
    route: 'auto',
    kernel: 'auto',
    draw: (R, b, gl) => {
      if (!ov2) {
        ov2 = createOverrideTable(gl, b);
        for (let s = 0; s < (b.numShapes | 0); s++)
          ov2.set(s, { localPosition: [2, 3], localScale: [1.1, 1.1] });
      }
      R.drawBundle(b, { overrides: ov2 });
    },
  });
  ok(
    r2.gate === 'on' && r2.defs.has('MANTLE_AAC') && r2.defs.has('MANTLE_LB_FILL'),
    `(a) ...and under 'auto' at 2048 px, where those rows bring AAC back into the key, the draw warms too (gate ${r2.gate})`,
  );
  try {
    r2.R.dispose();
  } catch {
    /* headless */
  }
}
{
  const plain = await bound(FILL_AND_STROKE);
  ok(
    plain.gate === 'on' && plain.defs.has('MANTLE_NO_COVER_FILL'),
    `(a) a filled mesh beside a stroke-only row: the stroke's cover quad has no fill, so no kernel (gate ${plain.gate}, ${plain.defs.has('MANTLE_NO_COVER_FILL') ? 'dropped' : 'kept'})`,
  );
  try {
    plain.R.dispose();
  } catch {
    /* headless */
  }
  const cm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const r = await bound(FILL_AND_STROKE, {
    draw: (R, b) => R.drawBundle(b, { colorMatrix: cm, colorMatrixOffset: [0, 0, 0, 0.2] }),
  });
  ok(
    r.gate === 'on' && !r.defs.has('MANTLE_NO_COVER_FILL'),
    `(a) ...but under a color matrix, which lifts the stroke row's empty fill into a fill, the kernel stays (gate ${r.gate}, ${r.defs.has('MANTLE_NO_COVER_FILL') ? 'dropped' : 'kept'})`,
  );
  try {
    r.R.dispose();
  } catch {
    /* headless */
  }
}

// Zero-alpha-preserving recolors cannot introduce a fill on the stroke row.
// RGB-to-alpha terms can, even with no explicit alpha offset.
for (const lift of [false, true]) {
  const cm = new Float32Array([1, 0, 0, lift ? 0.2 : 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5]);
  const r = await bound(FILL_AND_STROKE, { draw: (R, b) => R.drawBundle(b, { colorMatrix: cm }) });
  ok(
    r.gate === 'on' && r.defs.has('MANTLE_NO_COVER_FILL') === !lift,
    `(a) ${lift ? 'RGB-to-alpha mixing keeps' : 'alpha scaling omits'} the cover kernel`,
  );
  try {
    r.R.dispose();
  } catch {
    /* headless */
  }
}

// ---- (d) the first override frame --------------------------------------------------------------------------------
// The loading call warms the key the bundle draws with, and that key drops the kernel; the same bundle drawn under an
// override table binds the key WITH it (its cover sibling). Warming only the no-override key would send the FIRST
// frames of an override draw to the classic pass while later ones draw the unified route, so the warm builds the
// sibling beside its key.
//
// THE LOADING CALL IS awaitLbReady THEN precompileFills, as the unified render smokes run it (a draw does
// not wait for its program, so selectFillVariant hands the lean key back at once and awaitLbReady's own
// warmFillVariant finds the variant already usable and draws no warm). The pipeline warm that builds the key AND
// its sibling is precompileFills's, and the count is read straight after it, before any frame can have built the
// sibling by drawing it.
{
  const { createOverrideTable } = await import('../src/index.js');
  const TOP = readFileSync(
    path.join(ROOT, 'examples/smoke/lbTransformOverrideParity__SVG.svg'),
    'utf8',
  );
  const F = createFakeGl({ width: 200, height: 200 });
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false, staticUnified: true });
  const b = createBundle(F.gl, await importSvg(TOP));
  // The route pinned BEFORE the warm: under 'auto' these line-only diamonds are declined (no row picks its mesh),
  // so the warm would build the classic key, which is the override draw's key too, and the sibling would not be what
  // this checks.
  R.setLoopBlinnFill(true);
  R.prepareBundle(b);
  await R.awaitLbReady(b);
  R.precompileFills();
  const siblingsAfterLoad = R.debugStats.coverSiblingWarms | 0;
  const ov = createOverrideTable(F.gl, b);
  ov.set(1, { localPosition: [0, -60] });
  const frame = (o) => {
    const r0 = R.debugStats.loopBlinnRouteCount;
    R.setViewport(200, 200);
    R.beginFrame([0, 0, 0, 1]);
    R.drawBundle(b, o);
    R.endFrame();
    return {
      routed: R.debugStats.loopBlinnRouteCount > r0,
      gate: R.debugStats.unifiedFillGate,
      defs: new Set((R.debugStats.drawnFillVariantKey || '').split('|')),
    };
  };
  // the render smoke's sequence: a Slug frame with the route off, then the route on
  R.setLoopBlinnFill(false);
  frame({ overrides: ov });
  R.setLoopBlinnFill(true);
  const first = frame({ overrides: ov });
  ok(
    first.routed &&
      first.gate === 'on' &&
      first.defs.has('MANTLE_LB_FILL') &&
      !first.defs.has('MANTLE_NO_COVER_FILL'),
    `(d) after the loading call, the FIRST override frame draws the unified route with the kernel (routed ${first.routed}, gate ${first.gate})`,
  );
  const plain = frame({});
  ok(
    plain.routed && plain.defs.has('MANTLE_NO_COVER_FILL'),
    `(d) ...and the next frame without the table binds the key without it (routed ${plain.routed}, ${plain.defs.has('MANTLE_NO_COVER_FILL') ? 'no kernel' : 'kernel'})`,
  );
  ok(
    siblingsAfterLoad >= 1,
    `(d) the loading call's warm built the sibling before any frame drew (${siblingsAfterLoad} sibling warm(s))`,
  );
  try {
    R.dispose();
  } catch {
    /* headless */
  }
}

// ---- (e) a cold no-kernel key draws with its warm sibling ---------------------------------------------------------
// awaitLbReady under 'auto', where these line-only diamonds are declined (no row picks its mesh), warms the classic
// key; turning the 'lb' route on then asks for the key without the kernel, which nothing warmed. It is served by its
// warm cover sibling -- same pixels, the kernel only present -- so the route is taken on the first frame
// (lbStrokeParitySmoke, render), and the lean key replaces it once its own warm has run.
{
  const F = createFakeGl({ width: 200, height: 200 });
  const R = createRenderer(F.gl, taggedShaderSources(), { aacPoints: false, staticUnified: true });
  const b = createBundle(
    F.gl,
    await importSvg(
      readFileSync(path.join(ROOT, 'examples/smoke/lbStrokeParity__SVG.svg'), 'utf8'),
    ),
  );
  R.prepareBundle(b);
  await R.awaitLbReady(b);
  R.setLoopBlinnFill(true);
  const frame = () => {
    const r0 = R.debugStats.loopBlinnRouteCount;
    R.setViewport(200, 200);
    R.beginFrame([0, 0, 0, 1]);
    R.drawBundle(b);
    R.endFrame();
    return {
      routed: R.debugStats.loopBlinnRouteCount > r0,
      defs: new Set((R.debugStats.drawnFillVariantKey || '').split('|')),
    };
  };
  const first = frame();
  ok(
    first.routed && first.defs.has('MANTLE_LB_FILL') && !first.defs.has('MANTLE_NO_COVER_FILL'),
    `(e) the first 'lb' frame after an 'auto' warm takes the route on the cover sibling (routed ${first.routed})`,
  );
  R.precompileFills();
  const later = frame();
  ok(
    later.routed && later.defs.has('MANTLE_NO_COVER_FILL'),
    `(e) ...and once its own warm has run, the key without the kernel (routed ${later.routed}, ${later.defs.has('MANTLE_NO_COVER_FILL') ? 'no kernel' : 'kernel'})`,
  );
  try {
    R.dispose();
  } catch {
    /* headless */
  }
}

// ---- (b) --------------------------------------------------------------------------------------------------------
{
  // Force the selector to encounter a no-cover key, then exercise the real classic pass.
  // A textual check of an unconditional base return missed the cold AAC correctness contract.
  const debugBefore = globalThis.__MANTLE_DEBUG__,
    definesBefore = globalThis.__MANTLE_FILL_DEFINES;
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__MANTLE_FILL_DEFINES = 'MANTLE_NO_COVER_FILL';
  try {
    const sec = await importSvg(
      '<svg viewBox="0 0 128 128"><path fill="#48c" d="M10 10L110 20L30 100Z"/></svg>',
    );
    for (const c of [
      { name: 'Slug base', kernel: 'slug' },
      { name: 'cold runtime AAC', kernel: 'aac' },
      { name: 'constructor AAC base', kernel: 'aac', initialAac: true },
      { name: 'cold rotated AAC', kernel: 'aac', world: [0.9, 0.3, 0, -0.3, 0.9, 0, 0, 0, 1] },
    ]) {
      const F = createFakeGl({ width: 128, height: 128 });
      const R = createRenderer(F.gl, taggedShaderSources(), {
        loopBlinnFill: 'off',
        psoWarm: false,
        variantFirst: false,
        aacFill: !!c.initialAac,
        aacPoints: false,
      }); // (variantFirst:false: the base program is the immediate fallback this case asserts; the default draws the lean variant itself)
      const b = createBundle(F.gl, sec);
      R.setFillEngine({ route: 'none', kernel: c.kernel });
      R.drawBundle(b, c.world ? { worldMatrix: c.world } : {});
      const key = R.debugStats.drawnFillVariantKey,
        defs = new Set(String(key || '').split('|'));
      ok(
        !defs.has('MANTLE_NO_COVER_FILL') &&
          R.debugStats.loopBlinnRouteCount === 0 &&
          R.debugStats.engines.draws[c.kernel] === 1,
        `(b) ${c.name}: the first actual classic draw keeps its required cover kernel`,
      );
      ok(
        (c.kernel === 'aac') === defs.has('MANTLE_AAC'),
        `(b) ${c.name}: bound kernel matches the request`,
      );
      if (c.world)
        ok(
          defs.has('MANTLE_ROTATED_MAP'),
          '(b) the cold affine draw retains the rotated AAC footprint',
        );
      if (c.kernel === 'slug' || c.initialAac)
        ok(
          key === (c.initialAac ? 'MANTLE_AAC' : null),
          `(b) ${c.name}: a valid base remains the immediate fallback`,
        );
      R.dispose();
    }
  } finally {
    if (debugBefore === undefined) delete globalThis.__MANTLE_DEBUG__;
    else globalThis.__MANTLE_DEBUG__ = debugBefore;
    if (definesBefore === undefined) delete globalThis.__MANTLE_FILL_DEFINES;
    else globalThis.__MANTLE_FILL_DEFINES = definesBefore;
  }
  const r = await bound(FILL_AND_STROKE);
  const before = r.R.debugStats.engines.draws.slug || 0;
  ok(
    r.gate === 'on' && r.defs.has('MANTLE_NO_COVER_FILL'),
    '(b) the unified span selected its no-cover program',
  );
  r.R.setFillEngine({ route: 'none', kernel: 'slug' });
  r.R.beginFrame([1, 1, 1, 1]);
  r.R.drawBundle(r.b);
  r.R.endFrame();
  const classic = new Set((r.R.debugStats.drawnFillVariantKey || '').split('|'));
  ok(
    !classic.has('MANTLE_NO_COVER_FILL') && (r.R.debugStats.engines.draws.slug || 0) === before + 1,
    '(b) switching the same renderer to classic restores the usable cover program',
  );
  r.R.dispose();
}

// ---- (c) --------------------------------------------------------------------------------------------------------
const { hasMainEmu, buildMainEmu, runMainEmu } = await import('./_glslMainEmu.mjs');
if (!hasMainEmu()) {
  console.log('  SKIP (c): no C++ compiler or clang for the main() emulator');
} else {
  const SI = await import('./_shaderIdentity.mjs');
  const text = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const eA = buildMainEmu(text, ['MANTLE_LB_FILL']),
    eB = buildMainEmu(text, ['MANTLE_LB_FILL', 'MANTLE_NO_COVER_FILL']);
  let n = 0,
    differ = 0,
    nFill = 0,
    fillDiffer = 0;
  const bits = (A, i) => Array.from(new Uint32Array(A.buffer, A.byteOffset + i * 20, 5));
  for (const a of SI.defaultAssets({ quick: true })) {
    const P = await SI.prepareAsset(a);
    for (const sc of SI.scenarios(P)) {
      if (sc.U.get('uColorMatrixEnabled')) continue; // the renderer never emits the define under a color matrix
      const frags = SI.mainFrags(P, sc, 8);
      const A = runMainEmu(eA, P.T, sc.U, frags),
        B = runMainEmu(eB, P.T, sc.U, frags);
      frags.forEach((f, i) => {
        const s = f.varyings.get('vInst');
        const fillRow = P.meta[s * 48 + 7] > 0 || (f.varyings.get('vOverrideMask') | 0) & 1;
        const x = bits(A, i),
          y = bits(B, i);
        const eq = x.every((v, k) => v === y[k]) || (A[i * 5 + 4] === 1 && B[i * 5 + 4] === 1);
        if (fillRow) {
          nFill++;
          if (!eq) fillDiffer++;
        } else {
          n++;
          if (!eq) differ++;
        }
      });
    }
  }
  ok(
    n > 1000 && differ === 0,
    `(c) main() is bit-identical with and without the define on ${n} cover fragments of rows with no fill (${differ} differ)`,
  );
  ok(
    fillDiffer > 0,
    `(c) ...and differs on fill rows (${fillDiffer} of ${nFill}), so the define is not a no-op`,
  );
}

console.warn = warn;
console.log(fail ? `noCoverFillSmoke FAIL (${fail})` : 'noCoverFillSmoke PASS');
process.exit(fail ? 1 : 0);
