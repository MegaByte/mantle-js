// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmSizeDedupSmoke -- the loading call warms a derived size only when it asks for a program no earlier size asked for.
//
// Strict play's loading call derives one warm size per decision region of every bundle (fillPass.js _deriveSizeRegions). Warming the whole scene at each is
// waste: near-identical bundles derive sizes a pixel apart, hundreds of them, and the loading call would run on to its 180 s deadline warming sizes that
// build nothing. A size is skipped when every key its owners ask for there was asked for (and,
// under the bind-set pass, built) at a size already warmed (fillPass.js R._sizeCoveredG); the loop stops at the deadline.
// Pinned, in both policies (stand-in-free and defaults): the derivation itself is unchanged (a region per bundle side); most sizes are covered; the load
// completes; drawing every bundle at every derived size and under every warm state afterwards builds nothing, waits for nothing and defers nothing; and a
// loading call past its deadline starts no further size. CPU, driver-model stand-in (test/_pendingGl.mjs).
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

const N = 24;
// twenty tiny cubic blobs (their mean area puts the engine-pick bar inside the reachable range), the viewBox 1.5 % wider per copy: each copy has its own bar, so
// its own derived sizes, and all share one key image
const blob = (i) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 + i * 1.5} 30">${Array.from({ length: 20 }, (_, k) => `<path d="M${5 + k * 4} 10 c1 -1 2 -1 2 0 c0 1 -1 2 -2 2 z" fill="#a0${k % 10}"/>`).join('')}</svg>`;
const datas = [];
for (let i = 0; i < N; i++) datas.push(await importSvg(blob(i), { preserveViewport: true }));
const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const TINT = {
  colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
  colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
};
const STATES = [{}, { worldMatrix: ROT }, TINT, { worldMatrix: ROT, ...TINT }];

async function load(rOpts, loadOpts = {}, gl = {}) {
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100, ...gl });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    aacPoints: true,
    ...rOpts,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(1280, 720);
  const bundles = datas.map((d) => createBundle(W.gl, d));
  await R.precompileFillsAsync({ maxViewportPx: 4096, ...loadOpts });
  return { W, R, bundles };
}

for (const [name, rOpts] of [
  ['stand-in-free', { standIns: false, needMissPolicy: 'block' }],
  ['defaults', {}],
]) {
  console.log(`(${name}) ${N} near-identical bundles`);
  const { W, R, bundles } = await load(rOpts);
  const vw = R.debugStats.viewportWarm,
    dv = vw.derived,
    rows = vw.loadClasses || [];
  const warmed = rows.filter((r) => !r.covered).length,
    covered = rows.filter((r) => r.covered).length;
  console.log(
    `   ${dv.regions} derived sizes; ${warmed} warmed, ${covered} covered; ${rows.reduce((n, r) => n + r.pipelines, 0)} pipelines at load`,
  );
  ok(
    dv.regions >= N,
    `the derivation is unchanged: a size per bundle region (${dv.regions} >= ${N})`,
  );
  ok(
    covered >= dv.regions - 4 && warmed <= 5,
    `the loading call warmed ${warmed} size(s) and skipped ${covered} that asked for nothing new`,
  );
  ok(
    R.debugStats.coopLoad && R.debugStats.coopLoad.incomplete === false,
    'the loading call completed',
  );
  // every bundle at every derived size, under every warm state: nothing is built, waited for or deferred
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    ds0 = { ...R.debugStats };
  for (const [w, h] of dv.sizes) {
    R.setViewport(w, h);
    for (const st of STATES) {
      R.beginFrame([1, 1, 1, 1]);
      for (const b of bundles) R.drawBundle(b, st);
      R.endFrame();
    }
  }
  const d = (k) => (R.debugStats[k] | 0) - (ds0[k] | 0);
  ok(
    W.model.pipelines === p0 &&
      W.model.waits.length === w0 &&
      d('playBuilds') === 0 &&
      d('deferredFillDraws') === 0,
    `drawing every bundle at all ${dv.sizes.length} sizes in ${STATES.length} states built ${W.model.pipelines - p0} pipelines, waited ${W.model.waits.length - w0} times, played ${d('playBuilds')} builds, deferred ${d('deferredFillDraws')}`,
  );
  for (const b of bundles) b.dispose();
  R.dispose();
}

console.log('(deadline) a loading call past its deadline starts no further size');
{
  const { R, bundles } = await load(
    { standIns: false, needMissPolicy: 'block' },
    { warmTimeoutMs: 1 },
    { pipelineMs: 400 },
  );
  const rows = R.debugStats.viewportWarm.loadClasses || [],
    dv = R.debugStats.viewportWarm.derived;
  ok(
    R.debugStats.coopLoad.incomplete === true && rows.length <= 2,
    `incomplete, ${rows.length} size(s) started of ${dv.regions + 1}`,
  );
  for (const b of bundles) b.dispose();
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
