// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pointsVectorEffectSmoke -- a row with a vector effect does not take the points route.
//
// non-scaling-size, non-rotation and fixed-position cancel part of the world matrix per row, in the cover vertex shader. The point shader has no such code, and the route declined only the
// stroke effects: such a fill under a worldMatrix followed the whole matrix, its point grid shrinking with the plain row beside it. Pinned: each effect draws no point list, and a plain
// bundle (the control) does. CPU, driver-model stand-in (test/_pendingGl.mjs).
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
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
const gl = W.gl;
const R = createRenderer(gl, taggedShaderSources(), { aacFill: 'auto' });
R.ready.catch(() => {});
setTimeout(() => W.release(), 5);
await R.ready;
R.setViewport(256, 256);
let points = 0;
const oI = gl.drawArraysInstanced;
gl.drawArraysInstanced = (m, f, c, n) => {
  if (m === gl.POINTS) points++;
  return oI.call(gl, m, f, c, n);
};
const oA = gl.drawArrays;
gl.drawArrays = (m, f, c) => {
  if (m === gl.POINTS) points++;
  return oA.call(gl, m, f, c);
};
async function pointDraws(body) {
  const b = createBundle(gl, await importSvg(svg(body), { preserveViewport: true }));
  await R.precompileFillsAsync({ classes: false });
  points = 0;
  for (const s of [1, 0.5, 0.25]) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { worldMatrix: new Float32Array([s, 0, 0, 0, s, 0, 0.3, 0.1, 1]) });
    R.endFrame();
  }
  const n = points;
  b.dispose();
  return n;
}
const PLAIN = '<rect x="60" y="60" width="20" height="20" fill="#0c0"/>';
console.log('(control) plain rows take the route');
ok(
  (await pointDraws(`<rect x="10" y="10" width="20" height="20" fill="#c00"/>${PLAIN}`)) > 0,
  'a plain bundle draws point lists',
);
for (const ve of ['non-scaling-size', 'non-rotation', 'fixed-position']) {
  console.log(`(${ve})`);
  const n = await pointDraws(
    `<rect x="10" y="10" width="20" height="20" fill="#c00" vector-effect="${ve}"/>${PLAIN}`,
  );
  ok(n === 0, `no point list is drawn (${n})`);
}
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
