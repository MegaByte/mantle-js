// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// standInReadyRoundsSmoke -- under the stand-in policy, awaitBundleReady runs at most one warm round per missing key, not one per call.
//
// The stand-in policy runs no bind-set pass, so its built set never holds an image's keys and a readiness check would answer "missing" for good: every awaitBundleReady
// (each text re-flow, each trial) would rerun the whole loading call in play, thousands of warm draws a second.
// Pinned: after the loading call, the first asks may warm; repeating them draws nothing and resolves at once. The stand-in-free default keeps its exact answer: a bundle
// whose image was built needs nothing, and a call that still finds a key missing asks again.
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
const SVG = (c) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M20 50 C20 20 80 20 80 50 C80 80 20 80 20 50Z" fill="${c}"/><path d="M40 40 L60 40 L50 70Z" fill="#00f"/></svg>`;

async function run(policy) {
  const W = createPendingGl({ linkMs: 10, pipelineMs: 20 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    ...policy,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 20);
  await R.ready;
  R.setViewport(256, 256);
  const A = createBundle(W.gl, await importSvg(SVG('#f00'), { preserveViewport: true }));
  await R.precompileFillsAsync({});
  return { W, R, A };
}
// settle: ask until an ask draws nothing (a key missing at the first ask may be followed by one of a later size)
async function settle(R, W, b, max = 10) {
  let rounds = 0;
  for (; rounds < max; rounds++) {
    const d0 = W.model.draws;
    await R.awaitBundleReady(b);
    if (W.model.draws === d0) break;
  }
  return rounds;
}

console.log('(stand-ins) repeated awaitBundleReady draws nothing once its keys have been asked');
{
  const { W, R, A } = await run({ standIns: true, needMissPolicy: 'defer' });
  const rounds = await settle(R, W, A);
  ok(rounds < 10, `the asks settled (${rounds} warm rounds)`);
  const d0 = W.model.draws;
  for (let i = 0; i < 20; i++) await R.awaitBundleReady(A);
  ok(W.model.draws === d0, `20 more asks drew nothing (${W.model.draws - d0} draws)`);
  ok(!R._policy.needsWarm(A), 'and the bundle no longer asks');
  R.dispose();
}
console.log('(stand-in-free) the default: a built image needs nothing, and the answer stays exact');
{
  const { W, R, A } = await run({});
  ok(!R._policy.needsWarm(A), 'the loading call built the whole image of a loaded bundle');
  const d0 = W.model.draws;
  for (let i = 0; i < 20; i++) await R.awaitBundleReady(A);
  ok(W.model.draws === d0, `20 asks drew nothing (${W.model.draws - d0} draws)`);
  const B = createBundle(
    W.gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 L90 10 L50 90Z" fill="url(#g)"/></svg>',
      { preserveViewport: true },
    ),
  );
  ok(
    R._policy.needsWarm(B) && R._policy.needsWarm(B),
    'a bundle with a program not built keeps asking until it is built, however often it is asked',
  );
  const rp = W.gl.readPixels;
  let reads = 0;
  W.gl.readPixels = (...x) => {
    reads++;
    return rp(...x);
  };
  const links0 = W.model.draws;
  await R.awaitBundleReady(B);
  ok(!R._policy.needsWarm(B), 'and after its warm it needs nothing');
  // That window can open in play (a text re-flow): it waits on the fence and takes no read-back, which can hold the page tens of ms with the GPU thread already clear.
  ok(
    W.model.draws > links0 && reads === 0,
    `the window drew its warm (${W.model.draws - links0} draws) with no read-back (${reads})`,
  );
  W.gl.readPixels = rp;
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
