// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nestedMaskGateSmoke — the unified fill route declines a bundle whose mask children carry masks of their own.
//
// The unified stream samples one baked mask texture per masked shape and has no per-level bake, so a mask used inside another
// mask's child would be dropped (the case _mask_nested would draw blank, where the cover pass draws it within 0.02 of Chrome 8x).
// src/renderer/nestedMask.js declines such bundles from the meta plane, structurally, and the
// route records the reason as debugStats.unifiedFillGate === 'nested-mask'. The bundle draws on the cover pass.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, forced onto the unified route (setFillEngine route 'lb'). A nested
// bundle must not enter the unified stream and must name the gate; every single-level mask bundle must still take the route
// (gate 'on', unified draws > 0) so mask-heavy content keeps it. Pixels are test/unifiedNestedMaskRenderSmoke.mjs.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

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
import { nestedMaskCases } from './_nestedMaskCases.mjs';

const N = 64,
  FRAMES = 4;
async function run(svg) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route: 'lb', kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* reported by the route check */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  const stats = [];
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    R.drawBundle(b);
    R.endFrame();
    stats.push(Object.assign({}, R.debugStats));
  }
  return { first: stats[0], last: stats[FRAMES - 1] };
}

for (const c of nestedMaskCases) {
  const { first, last } = await run(c.svg);
  const unified = (last.unifiedFillDraws | 0) - (first.unifiedFillDraws | 0);
  if (c.nested)
    ok(
      unified === 0 && last.unifiedFillGate === 'nested-mask',
      `${c.id}: declines to the cover pass (unified draws +${unified}, gate '${last.unifiedFillGate}')`,
    );
  else
    ok(
      unified > 0 && last.unifiedFillGate !== 'nested-mask',
      `${c.id}: keeps the unified route (unified draws +${unified}, gate '${last.unifiedFillGate}')`,
    );
}
console.log(fail ? `\nFAIL (${fail})` : '\nPASS nestedMaskGateSmoke');
process.exit(fail ? 1 : 0);
