// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskBakeNoNetSmoke -- a stand-in-free renderer builds no all-types mask-bake program: it draws each bake with the exact program, so a net could only cost load.
//
// The all-types bakes are the largest pipelines in the renderer (seconds each on a cold Metal cache, holding the compositor, and whether the rotated one is reached at all depends
// on when a fence comes back). Pinned: the loading call builds the lean bakes and neither net; play draws them without a build or a deferral; a masked bundle that first
// arrives in play waits for its exact program instead of deferring; the stand-in policy still builds its nets.
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
const doc = (b, d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${d}</defs>${b}</svg>`;
const MASKED = doc(
  '<g mask="url(#m)"><rect width="100" height="100" fill="#0a3"/></g>',
  '<mask id="m"><path d="M10 10 L90 10 L50 90Z" fill="#fff"/><path d="M10 90 L90 90 L50 20Z" fill="#888"/></mask>',
);
const LATE = doc(
  '<g mask="url(#m)"><rect width="100" height="100" fill="#0a3"/></g>',
  '<mask id="m"><path d="M10 10 C60 0 90 40 80 90 L20 70Z" fill="#fff"/><path d="M10 90 C60 100 90 60 80 10 L20 30Z" fill="#888"/></mask>',
);
const ROT = (() => {
  const c = Math.cos(0.5),
    s = Math.sin(0.5);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
})();

async function arm(opts) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    ...opts,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(512, 512);
  const b = createBundle(W.gl, await importSvg(MASKED, { preserveViewport: true }));
  await R.precompileFillsAsync({});
  const labels = () => R.debugStats.gpuGate.pipeLog.map((e) => e[1]);
  return { W, R, b, labels };
}

console.log('(stand-in-free) the lean bakes are built, the all-types ones are not');
{
  const { W, R, b, labels } = await arm({});
  const L = labels(),
    bakes = L.filter((l) => l === 'maskBake' || l.startsWith('bake:'));
  console.log('   built:', bakes.join(' '));
  ok(
    bakes.some((l) => l.startsWith('bake:axis:')),
    'the axis-aligned lean bake is built',
  );
  ok(
    bakes.some((l) => l.startsWith('bake:rot:')),
    'the rotated lean bake is built',
  );
  ok(!L.includes('maskBake'), 'the general bake program is not drawn');
  ok(!L.includes('bake:rot:15'), 'the rotated all-types bake program is not drawn');
  console.log('(play) the content the loading call saw builds and defers nothing');
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    d0 = R.debugStats.maskBakeDeferred | 0;
  for (const world of [null, ROT]) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, world ? { worldMatrix: world } : {});
    R.endFrame();
  }
  ok(W.model.pipelines === p0, `no pipeline built (${W.model.pipelines - p0})`);
  ok(
    (R.debugStats.maskBakeDeferred | 0) === d0,
    `no bake deferred (${(R.debugStats.maskBakeDeferred | 0) - d0})`,
  );
  ok(W.model.waits.length === w0, `no wait (${W.model.waits.length - w0})`);
  console.log(
    '(miss) a masked bundle first seen in play waits for its exact program and bakes in that frame',
  );
  const late = createBundle(W.gl, await importSvg(LATE, { preserveViewport: true }));
  const n0 = R.debugStats.needMiss.programMisses | 0,
    d1 = R.debugStats.maskBakeDeferred | 0;
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(late);
  R.endFrame();
  ok(
    (R.debugStats.maskBakeDeferred | 0) === d1,
    `the bake is not deferred (${(R.debugStats.maskBakeDeferred | 0) - d1})`,
  );
  ok((R.debugStats.needMiss.programMisses | 0) > n0, 'the miss is counted');
  ok(
    !labels().includes('maskBake') && !labels().includes('bake:rot:15'),
    'it draws no all-types program in place of its own',
  );
  ok(
    labels().some(
      (l) => l.startsWith('bake:axis:') && l !== bakes.find((x) => x.startsWith('bake:axis:')),
    ),
    'it draws its own lean program',
  );
  R.dispose();
}
console.log('(stand-ins) the stand-in policy keeps its net');
{
  const { R, labels } = await arm({ standIns: true, needMissPolicy: 'defer' });
  ok(labels().includes('maskBake'), 'the general bake program is drawn in loading');
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
