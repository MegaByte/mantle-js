// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// emptyBundleWarmSmoke -- a bundle with nothing to draw binds no fill program.
//
// An all-invisible drawing (every path fill="none" with no stroke: an empty animation frame) imports to zero shapes. A draw that entered the fill pass and bound a
// fill program for a draw of nothing would list four fill keys in the warm image (as drawn, rotated, recolor, both) that no warm draw can build (no cover mesh):
// the bind-set pass would leave them unbuilt, and under the stand-in-free policy the first draw of the frame in play would wait on a link. The image is empty, the pass leaves
// nothing unbuilt, and drawing it in every state blocks, reuses and builds nothing.
// CPU, driver-model stand-in (test/_pendingGl.mjs).
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
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INVISIBLE =
  '<svg viewBox="0 0 300 150" xmlns="http://www.w3.org/2000/svg"><g fill="none"><path d="m43 68v-163h-85v163z" transform="matrix(2.94 0 0 .92 123.5 87.4)"/><path d="m3-3.1q-1.2-1.2-3-1.2-1.8 0-3.1 1.2-1.2 1.3-1.2 3.1z"/></g></svg>';
const SOLID =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M20 50 C20 20 80 20 80 50 C80 80 20 80 20 50Z" fill="#48c"/></svg>';
const rot = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const tint = new Float32Array([0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1]);

console.log(
  '(empty bundle) nothing to draw: no fill program in its image, nothing unbuilt, nothing blocked or built in play',
);
{
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const empty = createBundle(W.gl, await importSvg(INVISIBLE, { preserveViewport: true }));
  const solid = createBundle(W.gl, await importSvg(SOLID, { preserveViewport: true }));
  ok(!(empty.numShapes > 0), `the invisible drawing imports to no shapes (${empty.numShapes | 0})`);
  await R.precompileFillsAsync({});
  const img = R._policy.image(empty);
  ok(img.length === 0, `its warm image is empty (${img.length} keys)`);
  const nm0 = R.debugStats.needMiss;
  ok(
    nm0.bindSetUnbuilt === 0,
    `the bind-set pass left nothing unbuilt (${nm0.bindSetUnbuilt}: ${JSON.stringify(nm0.bindSetUnbuiltKeys.map((u) => u.state + ' ' + u.seen))})`,
  );
  const b0 = {
    blocked: nm0.blocked,
    reuse: nm0.reuseDraws,
    builds: R.debugStats.playBuilds | 0,
    def: R.debugStats.deferredFillDraws | 0,
  };
  for (const st of [
    {},
    { worldMatrix: rot },
    { colorMatrix: tint },
    { worldMatrix: rot, colorMatrix: tint },
  ])
    for (let i = 0; i < 3; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(empty, st);
      R.drawBundle(solid, st);
      R.endFrame();
      await sleep(4);
    }
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      nm.reuseDraws === b0.reuse &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      (R.debugStats.deferredFillDraws | 0) === b0.def,
    `drawn in every state: blocked ${nm.blocked - b0.blocked}, reuse ${nm.reuseDraws - b0.reuse}, builds in play ${(R.debugStats.playBuilds | 0) - b0.builds}, deferred ${(R.debugStats.deferredFillDraws | 0) - b0.def}`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
