// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmSizeRegionBoxSmoke -- a bundle's size regions do not depend on where its art sits.
//
// A bundle's bounds are [x, y, width, height]. The strict loading call's region derivation read them as two corners, so a width came out as |width - x|: art with x = width had no
// regions at all, and art further along had the scale range of a bundle of another size. CPU, driver-model stand-in.
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
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const art = (x, y) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} 50 10"><rect x="${x}" y="${y}" width="50" height="10" fill="#f00"/></svg>`;
const report = async (x, y) => {
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
  R.setViewport(1280, 720);
  const bundle = createBundle(W.gl, await importSvg(art(x, y), { preserveViewport: true }));
  await R.precompileFillsAsync({ maxViewportPx: 4096 });
  const row = R.debugStats.viewportWarm.derived.bundles[0];
  R.dispose();
  ok(
    bundle.globalBBox[0] === x && bundle.globalBBox[2] === 50,
    `the premise: the bundle's bounds are [${bundle.globalBBox}]`,
  );
  return row;
};
const base = await report(0, 0);
ok(base.scaleRange, `at the origin the bundle has a scale range (${base.scaleRange})`);
for (const [x, y] of [
  [50, 0],
  [0, 10],
  [300, 200],
]) {
  const row = await report(x, y);
  ok(
    row.scaleRange &&
      row.scaleRange[0] === base.scaleRange[0] &&
      row.scaleRange[1] === base.scaleRange[1],
    `art at ${x},${y} has the same scale range (${row.scaleRange})`,
  );
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
