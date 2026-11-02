// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// alphaSlotBudgetSmoke -- faded instances in slots ask the memory budget for the atlas, as a run of groups does.
//
// The group atlas is an optional resource: a budget that cannot hold it sends a run of groups to their own accumulators. A slot path that allocated it without asking would take 33 MiB against a 4 MiB budget.
// CPU (test/_fakeGl.mjs): getMemoryStats and debugStats.alphaSlotBatches.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="4" y="4" width="28" height="28" fill="#e04020"/><rect x="16" y="16" width="28" height="28" fill="#2040c0"/></svg>';
const insts = Array.from({ length: 64 }, (_, i) => ({
  worldMatrix: new Float32Array([
    0.225,
    0,
    0,
    0,
    0.225,
    0,
    -0.875 + 0.25 * (i % 8),
    0.875 - 0.25 * ((i / 8) | 0),
    1,
  ]),
  alpha: 0.5,
}));
for (const budget of [Infinity, 4 * 1048576]) {
  console.log(`(budget ${budget})`);
  const F = createFakeGl({ width: 128, height: 128 }),
    gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  R.setViewport(128, 128);
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(SVG, { preserveViewport: true }));
  if (budget < Infinity) R.setMemoryBudget(budget);
  const before = F.log.length;
  for (let i = 0; i < 3; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, insts);
    R.endFrame();
  }
  const atlas = R.getMemoryStats().caches.atlas.bytes,
    slots = R.debugStats.alphaSlotBatches;
  if (budget === Infinity)
    ok(
      slots > 0 && atlas > 0,
      `no budget: the slot path runs and holds the atlas (${slots} batches, ${atlas} bytes)`,
    );
  else {
    ok(atlas === 0, `a budget that cannot hold it: no atlas (${atlas} bytes)`);
    ok(slots === 0, `...and no slot batch (${slots})`);
    ok(
      F.log.slice(before).some((e) => e.op === 'draw' && e.fbo === null),
      '...and the instances still reach the canvas',
    );
  }
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
