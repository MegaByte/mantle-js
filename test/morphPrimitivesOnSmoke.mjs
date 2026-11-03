// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphPrimitivesOnSmoke -- setFillEngine({ primitives: 'on' }) and a morph whose source is a recognized circle. That route builds at creation, and a build that lands after the bundle
// has become a morph must not be adopted: the source's disc would draw at every t. A morph holds no mesh of one still pose. CPU, driver-model stand-in.
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
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const CIRCLE = svg('<circle id="a" cx="50" cy="50" r="30" fill="#303"/>'),
  ELLIPSE = svg('<ellipse id="a" cx="50" cy="50" rx="45" ry="10" fill="#303"/>');
const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
const R = createRenderer(W.gl, taggedShaderSources(), { asyncShaderCompile: true });
R.ready.catch(() => {});
await R.ready;
R.setViewport(256, 256);
R.setFillEngine({ primitives: 'on' });
const a = createBundle(W.gl, await importSvg(CIRCLE, { preserveViewport: true })),
  b = createBundle(W.gl, await importSvg(ELLIPSE, { preserveViewport: true }));
const m = createShapeMorph(W.gl, a, b);
for (let i = 0; i < 16; i++) {
  m.setT(0.5);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(m.bundle);
  R.endFrame();
  R.precompileFills();
  await new Promise((r) => setTimeout(r, 8));
}
const meshes = m.bundle._lbMeshes;
ok(!(meshes && meshes.some((x) => x && x.prim)), 'the morph holds no primitive mesh of its source');
ok(
  !R.debugStats.engines.draws.sdf,
  `no draw of the morph took the primitive route (${JSON.stringify(R.debugStats.engines.draws)})`,
);
// (A still circle under the option: enginePeerSmoke.)
R.dispose();
if (fail) {
  console.error(`\nMORPH-PRIMITIVES-ON FAIL (${fail})`);
  process.exit(1);
}
console.log('\nMORPH-PRIMITIVES-ON PASS');
process.exit(0);
