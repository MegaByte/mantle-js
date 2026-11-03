// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterIncompleteNotStampedSmoke -- a result drawn without the program it needs is not kept as the valid result.
//
// Three cases that must move a deferral counter, or the filter cache and the static cache keep a wrong picture for good:
//   a linear-light blur (the default color-interpolation-filters) drawn while its converting programs link: blurred in sRGB, an edge's midpoint 128/255 where 188 is asked;
//   a filter reading FillPaint as a gradient, first evaluated while the paint program links: a transparent paint, and the next frame must ask again (a cache hit never asks);
//   a static-cache bake over a previous-variant reuse draw: R._deferTotal counts it and such a bake is refused, so the bake's own sum must count it too.
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
const { CacheStrategy } = await import('../src/index.js')
  .then((m) => ({ CacheStrategy: m.CacheStrategy }))
  .then((x) => x);
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPTS = { asyncShaderCompile: true, nonBlocking: true, aacPoints: false, gpuShedMs: Infinity };
async function mk() {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), OPTS);
  R.ready.catch(() => {});
  const released = new Promise((r) => setTimeout(() => r(W.release()), 5));
  await R.ready;
  await released; // (ready does not wait for it: a release still pending would land after a scenario's hold() and undo it)
  R.setViewport(256, 256);
  return { W, R };
}
console.log(
  '(linear blur) a pass whose converting program links is deferred; the result is evaluated again once it can be right',
);
{
  const { W, R } = await mk();
  const F = W.F,
    Mo = W.model;
  W.hold();
  const bundle = createBundle(
    W.gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs><rect x="30" y="30" width="40" height="40" fill="#d33" filter="url(#b)"/></svg>',
      { preserveViewport: true },
    ),
  );
  const h = R.createBundleHandle(bundle, {
    staticCache: { strategy: CacheStrategy.ForceWholeAsset },
  });
  const others = () => {
    for (const [p, r] of Mo.progs)
      if (r.readyAt === Infinity && !F.progKeys(p).has('blurFrag')) r.readyAt = 0;
  };
  const frame = async () => {
    others();
    await sleep(2);
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
  };
  for (let i = 0; i < 20; i++) await frame();
  const held = [...Mo.progs.keys()].filter(
    (p) => F.progKeys(p).has('blurFrag') && Mo.progs.get(p).readyAt === Infinity,
  );
  ok(held.length > 0, `the premise: converting blur programs still link (${held.length})`);
  ok(!h.staticCache.isCacheValid, 'the static cache kept nothing');
  const n0 = F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('blurFrag')).length;
  W.release();
  for (let i = 0; i < 20000 && !h.staticCache.isCacheValid; i++) await frame();
  const after = F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('blurFrag'));
  ok(
    after.length > n0 && after.slice(n0).some((e) => held.includes(e.prog)),
    `once they link the blur runs again, on them (${after.length - n0} passes)`,
  );
  ok(h.staticCache.isCacheValid, 'and that result is kept');
  R.dispose();
}
for (const [label, strategy] of [
  ['filter cache', CacheStrategy.AlwaysLive],
  ['static cache', CacheStrategy.ForceWholeAsset],
]) {
  console.log(`(FillPaint gradient, ${label}) the paint is drawn once its program links`);
  const { W, R } = await mk();
  const F = W.F;
  const bundle = createBundle(
    W.gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><filter id="f" x="0" y="0" width="1" height="1"><feOffset in="FillPaint" dx="5"/></filter></defs><rect x="20" y="20" width="60" height="60" fill="url(#g)" filter="url(#f)"/></svg>',
      { preserveViewport: true },
    ),
  );
  const h = R.createBundleHandle(bundle, { staticCache: { strategy } });
  const draws = () =>
    F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('ownerPaintFrag')).length;
  for (let i = 0; i < 20000 && !draws(); i++) {
    await sleep(1);
    R.beginFrame([1, 1, 1, 1]);
    h.draw();
    R.endFrame();
  }
  ok(draws() > 0, `the gradient was painted (${draws()} draws)`);
  R.dispose();
}
console.log('(reuse) a bake over a previous-variant reuse draw is refused like a deferred one');
{
  const { attachCacheDraw } = await import('../src/renderer/cacheDraw.js');
  const { createStaticCache, Strategy, Level } = await import('../src/renderer/staticCache.js');
  const { createFakeGl } = await import('./_fakeGl.mjs');
  const F = createFakeGl({ width: 64, height: 64 });
  for (const [what, raise, keep] of [
    ['nothing deferred (control)', () => {}, true],
    [
      'fill deferred (control)',
      (R) => {
        R._deferredFillDraws = (R._deferredFillDraws | 0) + 1;
      },
      false,
    ],
    [
      'previous-variant reuse draw',
      (R) => {
        R._reuseDraws = (R._reuseDraws | 0) + 1;
      },
      false,
    ],
  ]) {
    const R = {
      gl: F.gl,
      opts: {},
      cacheBlitProg: {},
      CacheLevel: Level,
      CacheStrategy: Strategy,
      viewportSize: () => [64, 64],
      arScale: () => [1, 1],
      draw: { worldM: null, alpha: 1 },
      bindFb: (t, f) => F.gl.bindFramebuffer(t, f),
      glViewport() {},
      glDisable() {},
      glEnable() {},
      _forgetFillUnits() {},
      mantleWarn() {},
    };
    R._deferTotal = () =>
      (R._deferredFillDraws | 0) +
      (R._deferredFilterDraws | 0) +
      (R._maskBakeDeferred | 0) +
      (R._reuseDraws | 0);
    attachCacheDraw(R);
    const cache = createStaticCache({ strategy: Strategy.ForceWholeAsset });
    cache.tick({ hasAsset: true, viewportW: 64, viewportH: 64 });
    R._handle = { cache, bundle: { globalBBox: [0, 0, 1, 1], drawList: [] } };
    R._analyticRoute = () => {
      raise(R);
      return true;
    };
    const kept = R._cacheBakeAndBlit();
    ok(
      kept === keep && cache.isCacheValid === keep,
      `${what}: kept ${kept}, valid ${cache.isCacheValid}`,
    );
  }
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
