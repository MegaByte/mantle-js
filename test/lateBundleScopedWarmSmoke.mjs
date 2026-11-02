// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lateBundleScopedWarmSmoke -- awaitBundleReady warms the late bundle alone, not the whole scene.
//
// A late bundle with a program not built must not rerun the loading call over every live bundle: that is hundreds of warm draws and seconds for one dashed ring, overlapping play.
// Pinned: a late bundle's warm draws a fraction of what a full warm draws; the bundle is ready afterward and its first draw builds nothing; a full loading call in flight
// still walks every bundle; and the scope is gone once the warm ends.
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
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const fill = (i) => doc(`<path d="M${10 + i} 10 C60 0 90 40 80 90 L20 70Z" fill="#a48"/>`);
const LATE = doc(
  '<circle cx="50" cy="50" r="44" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="14 10" stroke-linecap="round"/>',
);

const W = createPendingGl({ linkMs: 1, pipelineMs: 2 });
const R = createRenderer(W.gl, taggedShaderSources(), {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacFill: 'auto',
});
R.ready.catch(() => {});
setTimeout(() => W.release(), 10);
await R.ready;
R.setViewport(512, 512);
const scene = [];
for (let i = 0; i < 24; i++)
  scene.push(createBundle(W.gl, await importSvg(fill(i), { preserveViewport: true })));
await R.precompileFillsAsync({});
for (const b of scene) {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b);
  R.endFrame();
}

console.log('(scope) a late bundle warms alone');
const late = createBundle(W.gl, await importSvg(LATE, { preserveViewport: true }));
ok(R._policy.needsWarm(late), 'the late bundle needs a program the scene did not');
const d0 = W.model.draws;
await R.awaitBundleReady(late);
const lateDraws = W.model.draws - d0;
ok(!R._policy.needsWarm(late), 'and is ready afterward');
const p0 = W.model.pipelines;
R.beginFrame([1, 1, 1, 1]);
R.drawBundle(late);
R.endFrame();
ok(W.model.pipelines === p0, `its first draw builds nothing (${W.model.pipelines - p0})`);

console.log('(full) a full warm still walks every bundle, so the scope has gone');
const d1 = W.model.draws;
await R.precompileFillsAsync({});
const fullDraws = W.model.draws - d1;
ok(
  lateDraws * 2 < fullDraws,
  `the late warm drew far less than a full one (${lateDraws} draws against ${fullDraws})`,
);
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
