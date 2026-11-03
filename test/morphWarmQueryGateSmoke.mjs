// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphWarmQueryGateSmoke -- the loading call's morph pass warm must not hold the page behind a pipeline build: its checkFramebufferStatus query (a synchronous
// round trip to the GPU process) is asked only when the GPU thread is clear (z4m11ftf: 195 ms in warmMorphPasses, loading). Runs on the driver-model stand-in
// (test/_pendingGl.mjs), whose framebuffer-status query waits behind a build in flight like the real service's.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const W = createPendingGl({ linkMs: 30, pipelineMs: 25 });
// the float color-buffer extension, so the pass warm draws into both plane formats (the second format's status query is the one that waited)
{
  const orig = W.gl.getExtension;
  W.gl.getExtension = (n) => (n === 'EXT_color_buffer_float' ? {} : orig(n));
}
const R = createRenderer(W.gl, taggedShaderSources(), {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  glGuard: true,
  gpuShedMs: 40,
});
R.ready.catch(() => {});
setTimeout(() => W.release(), 40);
await R.ready;
R.setViewport(256, 256);
const shape = (id, k, dx) =>
  `<path id="${id}" d="M${10 + dx} ${10 + (k % 5)} ` +
  Array.from({ length: 12 }, (_, i) => `L${10 + dx + i * 3} ${20 + ((i * 7 + k) % 13)}`).join(' ') +
  ' Z" fill="#a00"/>';
const big = (dx) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${Array.from({ length: 6 }, (_, k) => shape('s' + k, k, dx)).join('')}</svg>`;
const a = createBundle(W.gl, await importSvg(big(0), { preserveViewport: true })),
  b = createBundle(W.gl, await importSvg(big(3), { preserveViewport: true }));
createShapeMorph(W.gl, a, b);
await R.precompileFillsAsync({});
const q = W.model.waits.filter((w) => w.name === 'checkFramebufferStatus');
ok(
  q.length === 0,
  `no checkFramebufferStatus waited behind a build during the loading call (${q.length}${q.length ? ': ' + q.map((w) => Math.round(w.ms) + ' ms').join(', ') : ''})`,
);
ok(W.model.pipelines > 0, `the loading call did build pipelines (${W.model.pipelines})`);
R.dispose();
console.log(fail ? `morphWarmQueryGateSmoke FAIL (${fail})` : 'morphWarmQueryGateSmoke PASS');
process.exit(fail ? 1 : 0);
