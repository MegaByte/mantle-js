// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bindSetBatchCapSmoke -- the bind-set pass builds its pipelines in small batches, each behind a fence, so the loading screen can present between them.
//
// The compositor shares the GPU thread: one batch holding a whole image keeps the loading screen still for 20-39 s on a large app.
// Pinned: the pipelines built between two fences stay small, the whole image is still built, and nothing is left for play.
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
const doc = (b, d = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${d}</defs>${b}</svg>`;
const G =
  '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';
const SCENES = [
  doc('<path d="M10 10 L90 10 L50 90Z" fill="#a48"/>'),
  doc('<path d="M10 10 C60 0 90 40 80 90 L20 70Z" fill="#a48"/>'),
  doc('<path d="M10 10 Q60 0 80 90 L20 70Z" fill="url(#g)"/>', G),
  doc('<path d="M10 10 C60 0 90 40 80 90 L20 70Z" fill="url(#g)"/>', G),
  doc('<path d="M10 10 L90 10 L50 90Z" fill="none" stroke="#333" stroke-width="4"/>'),
  doc('<path d="M10 10 C60 0 90 40 80 90Z" fill="#a48" stroke="#333" stroke-width="4"/>'),
];
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
const bundles = [];
for (const s of SCENES) {
  const b = createBundle(W.gl, await importSvg(s, { preserveViewport: true }));
  R.declareReach(b, ['rotate', 'recolor', 'channelLerp']);
  bundles.push(b);
}
let last = W.model.pipelines,
  most = 0,
  fences = 0;
const fs = W.gl.fenceSync.bind(W.gl);
W.gl.fenceSync = (...a) => {
  const n = W.model.pipelines - last;
  if (n > most) most = n;
  last = W.model.pipelines;
  fences++;
  return fs(...a);
};
const p0 = W.model.pipelines,
  w0 = W.model.waits.length;
await R.precompileFillsAsync({});
const waits = W.model.waits.slice(w0);
const built = W.model.pipelines - p0,
  st = R.debugStats.needMiss;
console.log('(batches) the pipelines between two fences stay small');
ok(built > 16, `the image needs more pipelines than one batch (${built})`);
ok(most <= 16, `at most ${most} pipelines behind one fence (${fences} fences)`);
ok((st.bindSetUnbuilt | 0) === 0, `nothing left unbuilt (${st.bindSetUnbuilt | 0})`);
console.log('(no wait) nothing in the loading call waits behind a batch');
ok(
  waits.length === 0,
  `no status read came back behind the batch's builds (${waits.length}${waits.length ? ': ' + JSON.stringify(waits[0]).slice(0, 160) : ''})`,
);
console.log('(play) nothing was left for play');
const p1 = W.model.pipelines;
for (const b of bundles) {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b);
  R.endFrame();
}
ok(W.model.pipelines === p1, `no pipeline built by the first draws (${W.model.pipelines - p1})`);
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
