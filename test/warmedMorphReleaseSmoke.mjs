// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmedMorphReleaseSmoke -- a morph the loading call warmed is not kept alive by having been warmed.
//
// A warm that remembered each morph it drew in a strong set of helper passes, for the renderer's life, would keep every morph of a game that loads and disposes levels of them, with its CPU
// curves. A real garbage collection decides (WeakRef). CPU, driver-model stand-in (test/_pendingGl.mjs).
import v8 from 'node:v8';
import vm from 'node:vm';
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const M = await import('../src/index.js');
const { createRenderer, createBundle, importSvg } = M;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');
const pose = (r) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M${50 - r} 50 C${50 - r} ${50 - r} ${50 + r} ${50 - r} ${50 + r} 50 C${50 + r} ${50 + r} ${50 - r} ${50 + r} ${50 - r} 50Z" fill="#48c"/></svg>`;
const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
const R = createRenderer(W.gl, taggedShaderSources(), {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacFill: 'auto',
});
R.ready.catch(() => {});
setTimeout(() => W.release(), 5);
await R.ready;
R.setViewport(256, 256);
const refs = [];
for (let i = 0; i < 14; i++) {
  await (async () => {
    const a = createBundle(W.gl, await importSvg(pose(20 + i), { preserveViewport: true })),
      b = createBundle(W.gl, await importSvg(pose(30 + i), { preserveViewport: true }));
    const morph = M.createShapeMorph(W.gl, a, b);
    refs.push(new WeakRef(morph.bundle));
    await R.precompileFillsAsync({ classes: false });
    morph.dispose();
    a.dispose();
    b.dispose();
  })();
}
await R.precompileFillsAsync({ classes: false }); // (nothing here holds the last call's bundles but the renderer)
R.beginFrame([1, 1, 1, 1]);
R.endFrame();
for (let i = 0; i < 8; i++) {
  gc();
  await sleep(20);
}
const alive = refs.filter((r) => r.deref()).length;
ok(alive === 0, `disposed morphs still reachable after a collection: ${alive} of ${refs.length}`);
if (typeof R !== 'object') console.log(R);
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
