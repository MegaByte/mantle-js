// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bakeDeferredClassSmoke -- every cache of an offscreen result must refuse an incomplete one (the blank-bake class; see cacheBakeDeferredSmoke).
//
// A draw DEFERRED because its program is still linking (non-blocking mode) leaves the target it was drawing into empty. The filter caches
// (single-kind skEntry, filter-graph _storeFilteredTex) and the mask-region slot must not stamp that result as valid, or an empty filtered
// shape or an empty mask is reused until something invalidates it. Each scenario holds every link, draws once (the draws defer), releases,
// and asserts: nothing was cached/validated from the deferred frame, and the next complete frame produced the result.
globalThis.__MANTLE_DEBUG__ = true;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
const SCEN = {
  'single-kind filter (feGaussianBlur)': doc(
    '<g filter="url(#f)"><circle cx="50" cy="50" r="25" fill="#06c"/></g>',
    '<filter id="f"><feGaussianBlur stdDeviation="3"/></filter>',
  ),
  'filter graph (feOffset + feMerge)': doc(
    '<g filter="url(#f)"><circle cx="50" cy="50" r="25" fill="#06c"/></g>',
    '<filter id="f"><feOffset dx="4" dy="4" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
  ),
  'mask regions': doc(
    '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
    '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
  ),
};

for (const [name, svg] of Object.entries(SCEN)) {
  for (const size of [
    [256, 256],
    [1920, 1080],
    [3374, 2082],
  ]) {
    console.log(`${name} @ ${size[0]}x${size[1]}`);
    const W = createPendingGl({ linkMs: 30, pipelineMs: 60, hold: true });
    const R = createRenderer(W.gl, taggedShaderSources(), {
      asyncShaderCompile: true,
      nonBlocking: true,
      aacPoints: false,
      gpuShedMs: Infinity,
    });
    R.ready.catch(() => {});
    setTimeout(() => W.release(), 40);
    await R.ready;
    R.setViewport(size[0], size[1]);
    const h = R.createBundleHandle(
      createBundle(W.gl, await importSvg(svg, { preserveViewport: true })),
    );
    W.hold();
    const d0 = R.debugStats.deferredFillDraws | 0;
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
    const ds1 = R.debugStats;
    ok(
      (ds1.deferredFillDraws | 0) > d0 ||
        (ds1.maskBakeDeferred | 0) > 0 ||
        (ds1.deferredFilterDraws | 0) > 0,
      'the draws were deferred (programs still linking)',
    );
    ok(
      (ds1.filterCacheEntries | 0) === 0,
      `no filter result was cached from the deferred frame (entries ${ds1.filterCacheEntries})`,
    );
    const mb1 = ds1.maskBakeCount | 0;
    W.release();
    for (let i = 0; i < 80; i++) {
      await sleep(25);
      R.beginFrame([1, 1, 1, 1]);
      h.draw();
      R.endFrame();
    }
    const ds2 = R.debugStats;
    if (name === 'mask regions')
      ok(
        (ds2.maskBakeCount | 0) > mb1,
        `the mask was baked again once the programs were ready (${mb1} -> ${ds2.maskBakeCount})`,
      );
    else
      ok(
        (ds2.filterCacheEntries | 0) > 0,
        `the complete frame cached its filter result (entries ${ds2.filterCacheEntries})`,
      );
    R.dispose && R.dispose();
  }
}
console.log(fail ? `FAIL (${fail})` : 'PASS');
process.exit(fail ? 1 : 0);
