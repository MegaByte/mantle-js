// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pointListTwoRenderersSmoke -- a point list shared by two renderers on one context cannot wedge or double-count the other.
//
// The list handle lives on the bundle; each renderer has its own map and byte count. A renderer's dispose freed the handle, which stayed in the other's map with no buffer; the free returned
// early on that, so the eviction loop spun on the dead first entry for good (the page hung), and a rebuild counted the same list's bytes twice. CPU, driver-model stand-in.
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
const rig = async (opts = {}, W = createPendingGl({ linkMs: 1, pipelineMs: 1 })) => {
  const R = createRenderer(W.gl, taggedShaderSources(), { aacFill: 'auto', ...opts });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 5);
  await R.ready;
  R.setViewport(256, 256);
  return { W, R, gl: W.gl };
};
const bundleOf = async (gl, s, o = { preserveViewport: true }) =>
  createBundle(gl, await importSvg(s, o));
const X = svg(
  '<rect x="10" y="10" width="30" height="30" fill="#c00"/><rect x="50" y="50" width="30" height="30" fill="#0c0"/>',
);
const Y = svg(
  '<rect x="20" y="10" width="30" height="30" fill="#00c"/><rect x="60" y="50" width="30" height="30" fill="#cc0"/>',
);
const pl = (R) => R.getMemoryStats({ bundles: false }).caches.pointLists;
const draw = (R, b) => {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b);
  R.endFrame();
};
console.log('(count) a list comes back counted once');
{
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const { R: R1, gl } = await rig({}, W),
    { R: R2 } = await rig({}, W);
  const x = await bundleOf(gl, X);
  draw(R1, x);
  const one = pl(R1);
  for (let i = 0; i < 20000 && !pl(R2).lists; i++) {
    draw(R2, x);
    await sleep(3);
  }
  ok(
    pl(R2).lists === 1 && pl(R2).bytes === one.bytes,
    `a second renderer holds it at its size (${JSON.stringify(pl(R2))})`,
  );
  R2.dispose();
  draw(R1, x);
  ok(
    pl(R1).lists === 1 && pl(R1).bytes === one.bytes,
    `rebuilt after the other renderer freed it: ${JSON.stringify(pl(R1))} (was ${JSON.stringify(one)})`,
  );
  R1.dispose();
}
console.log('(eviction) a list freed by another renderer leaves the eviction loop');
{
  // (a hang here means the defect: the lane's per-test cap ends it)
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const { R: R1, gl } = await rig({ aacPointsBufferBudget: 1 }, W),
    { R: R2 } = await rig({ aacPointsBufferBudget: 1 }, W);
  const x = await bundleOf(gl, X),
    y = await bundleOf(gl, Y);
  draw(R1, x);
  for (let i = 0; i < 20000 && !pl(R2).lists; i++) {
    draw(R2, x);
    await sleep(3);
  }
  R2.dispose();
  draw(R1, y);
  ok(pl(R1).lists === 1, `the eviction returned (${JSON.stringify(pl(R1))})`);
  R1.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
