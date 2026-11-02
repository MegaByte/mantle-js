// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cacheBakeDeferredSmoke -- a static-cache bake must never be a blank frame that is then kept as "valid".
//
// In non-blocking mode a fill draw whose program is still linking is DEFERRED (debugStats.deferredFillDraws): the pass issues nothing and the
// next frame asks again. A cache bake is such a pass, run into the cache render target. If a fill is deferred during the bake the target is
// empty (or part drawn); recorded as valid by markBaked, the empty raster would be blitted every frame after, and a scene's cached
// background would stay black for the whole session (the cache only re-bakes on a change). So the bake reports failure (the caller draws
// live) and the cache stays invalid until a bake completes with nothing deferred.
//
// Runs the real createRenderer on test/_pendingGl.mjs (a recording WebGL stand-in with a driver model: parallel links that finish after a delay).
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg, CacheStrategy } = await import('../src/index.js');

// (the fixtures carry a stroke so their fill program is NOT the plain-fill variant that createRenderer links at init: the premise of this test is a program that is still cold at the first bake)
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#bfeedd"/><path d="M0 60 C 30 40 70 80 100 60 L 100 100 L 0 100 Z" fill="#d8b44c" stroke="#123" stroke-width="2"/></svg>';

const MANY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  Array.from(
    { length: 200 },
    (_, i) =>
      `<rect x="${(i % 20) * 5}" y="${Math.floor(i / 20) * 10}" width="6" height="11" fill="hsl(${i * 7},60%,50%)" stroke="#123" stroke-width="0.5"/>`,
  ).join('') +
  '</svg>';
for (const [size, svg] of [
  [[256, 256], SVG],
  [[1280, 800], SVG],
  [[1920, 1080], SVG],
  [[3374, 2082], SVG],
  [[4096, 2304], SVG],
  [[1280, 800], MANY],
  [[3374, 2082], MANY],
  [[4096, 2304], MANY],
]) {
  console.log(`viewport ${size[0]}x${size[1]}, ${svg === MANY ? '200 shapes' : '2 shapes'}`);
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
  const bundle = createBundle(W.gl, await importSvg(svg, { preserveViewport: true }));
  const h = R.createBundleHandle(bundle, {
    staticCache: { strategy: CacheStrategy.ForceWholeAsset },
  });
  W.hold(); // every program the draw needs is still linking: its fills are deferred
  const d0 = R.debugStats.deferredFillDraws | 0;
  R.beginFrame([1, 1, 1, 1]);
  h.draw();
  R.endFrame();
  const deferred = (R.debugStats.deferredFillDraws | 0) - d0;
  ok(deferred > 0, `the first bake's fill draws were deferred (${deferred})`);
  ok(!h.staticCache.isCacheValid, 'a bake with deferred fills is NOT kept as the valid cache');
  const bakeAfterFirst = h.staticCache.lastBakeFrame;
  W.release();
  let valid = false;
  for (let i = 0; i < 80 && !valid; i++) {
    await sleep(25);
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
    valid = h.staticCache.isCacheValid;
  }
  ok(
    valid && h.staticCache.lastBakeFrame !== bakeAfterFirst,
    'once the programs are ready the cache is re-baked complete and kept',
  );
  const retries = R.debugStats.cacheBakeDeferred | 0;
  ok(
    retries >= 1 && retries <= 40,
    `the refused bake retried only while programs were pending (${retries} refused bakes)`,
  );
  for (let i = 0; i < 20; i++) {
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
  }
  ok(
    (R.debugStats.cacheBakeDeferred | 0) === retries,
    'no further bake is refused or retried once the cache is valid',
  );
  const dBefore = R.debugStats.deferredFillDraws | 0;
  R.beginFrame([1, 1, 1, 1]);
  h.draw();
  R.endFrame();
  ok(
    (R.debugStats.deferredFillDraws | 0) === dBefore && h.staticCache.isCacheValid,
    'the kept bake is reused with nothing deferred',
  );
  R.dispose && R.dispose();
}
console.log(fail ? `FAIL (${fail})` : 'PASS');
process.exit(fail ? 1 : 0);
