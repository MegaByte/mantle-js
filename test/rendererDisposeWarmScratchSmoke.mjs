// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rendererDisposeWarmScratchSmoke -- a renderer's dispose frees what its warms made. A context outlives its renderers (a hub, an app shell), so a create and dispose must not leave
// textures, framebuffers, renderbuffers or filter helper programs behind.
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
const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>',
  { preserveViewport: true },
);
const KINDS = ['Texture', 'Framebuffer', 'Renderbuffer', 'VertexArray', 'Buffer', 'Program'];
for (const [name, O] of [
  ['strict play, stand-in-free', { strictPlay: true, standIns: false }],
  ['strict play', { strictPlay: true }],
  ['default', {}],
]) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 }),
    gl = W.gl;
  const live = {},
    made = new Map();
  for (const k of KINDS) {
    const c = gl['create' + k],
      d = gl['delete' + k];
    live[k] = 0;
    gl['create' + k] = (...a) => {
      live[k]++;
      const o = c(...a);
      made.set(o, k);
      return o;
    };
    gl['delete' + k] = (o) => {
      if (o && made.delete(o)) live[k]--;
      return d(o);
    };
  }
  const b = createBundle(gl, sec);
  const cycle = async () => {
    const R = createRenderer(gl, taggedShaderSources(), {
      asyncShaderCompile: true,
      nonBlocking: true,
      aacPoints: false,
      ...O,
    });
    R.ready.catch(() => {});
    await R.ready;
    R.setViewport(256, 256);
    await R.precompileFillsAsync({});
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    R.dispose();
    await sleep(40); // (a program still linking is deleted when its link completes)
  };
  await cycle(); // what a context keeps once, for all its renderers
  const first = { ...live };
  await cycle();
  await cycle();
  for (const k of KINDS)
    ok(
      live[k] === first[k],
      `${name}: ${k}: ${live[k] - first[k]} more after two more renderers (${first[k]} held for the context)`,
    );
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
