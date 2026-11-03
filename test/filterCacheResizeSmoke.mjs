// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterCacheResizeSmoke -- a resize takes the filter results off the byte count with the results themselves.
//
// A canvas resize frees every cached filter result, so the count of cached bytes must drop with them. Left as it was, every resize would add a full working set of bytes nothing holds; past the ceiling
// the budget would evict every other result on every store, and a scene with a resolution scaler would re-evaluate every filter on every frame, for good.
// CPU (test/_fakeGl.mjs): debugStats.filterCacheBytes and filterEvalCount.
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
const withLimits = (F) => {
  const g = F.gl,
    gp = g.getParameter.bind(g),
    max = new Set([g.MAX_TEXTURE_SIZE, g.MAX_RENDERBUFFER_SIZE]);
  g.getParameter = (p) =>
    max.has(p) ? 16384 : p === g.MAX_VIEWPORT_DIMS ? new Int32Array([16384, 16384]) : gp(p);
  return F;
};
const SZ = 600;
let body = '';
for (let i = 0; i < 12; i++)
  body += `<rect x="${20 + (i % 4) * 140}" y="${20 + ((i / 4) | 0) * 190}" width="100" height="100" fill="#c33" filter="url(#b)"/>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/><feOffset dx="1"/></filter></defs>${body}</svg>`;
const F = withLimits(createFakeGl({ width: SZ, height: SZ })),
  gl = F.gl;
const R = createRenderer(gl, taggedShaderSources(), { filterCacheBytes: 4 * 1048576 });
const bundle = createBundle(gl, await importSvg(SVG, { preserveViewport: true }));
const frame = () => {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(bundle);
  R.endFrame();
};
frame();
frame();
const one = R.debugStats.filterCacheBytes;
ok(
  R.debugStats.filterCacheEntries === 12 && one > 0,
  `the premise: 12 results cached, ${one} bytes`,
);
const seen = new Set();
for (let k = 0; k < 40; k++) {
  R.setResolutionScale(k % 2 ? 1 : 0.5, { dpr: 1 });
  seen.add(R.debugStats.filterCacheBytes);
  frame();
  frame();
}
ok(
  seen.size === 1 && seen.has(0),
  `a resize leaves no bytes counted (${[...seen].slice(0, 4).join(', ')}${seen.size > 4 ? ', ...' : ''})`,
);
ok(
  R.debugStats.filterCacheBytes === one,
  `the same scene counts the same bytes after 40 resizes (${R.debugStats.filterCacheBytes} against ${one})`,
);
const v0 = R.debugStats.filterEvalCount;
frame();
frame();
ok(
  R.debugStats.filterEvalCount === v0,
  `a static scene is served from the cache after 40 resizes (${R.debugStats.filterEvalCount - v0} evaluations in 2 frames)`,
);
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
