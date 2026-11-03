// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// declaredChannelLerpWarmSmoke -- a DECLARED channel-lerp recolor is a warm state of its own: the loading call builds the pipelines its draws bind.
//
// The bind-set pass draws each bundle under its warm states (as drawn, rotated, a colorMatrix recolor, both); the keys of a channel-lerp recolor
// (renderer.declareReach(bundle, ['channelLerp', ...]): an app's per-class sprite tint) must be drawn too, not only LINKED by the declared reach, or
// their pipelines are first built in play, every run (a tinted sprite timeline's pair morph, as drawn, channel lerp, overrides).
// Pinned: poses declared ['channelLerp', 'rotate'], a timeline over them, the loading call; then the timeline's morph drawn with a channel lerp, as drawn and
// rotated, builds no pipeline, waits for nothing and defers nothing; and the plain recolor declaration (no channelLerp) still adds no channel-lerp state.
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
const { createRenderer, createBundle, importSvg, createShapeTimeline } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POSE = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M${20 - d} 50 C${20 - d} ${20 - d} ${80 + d} ${20 - d} ${80 + d} 50 C80 80 20 80 ${20 - d} 50Z" fill="#f00"/><path d="M40 40 L60 40 L50 70Z" fill="#00f"/></svg>`;
const CL = { primary: [0.1, 0.6, 0.2, 1], contrast: [0.9, 0.8, 0.1, 1], highlight: [1, 1, 1, 1] };
const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);

async function run(tags) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(512, 512);
  const A = createBundle(W.gl, await importSvg(POSE(0), { preserveViewport: true })),
    B = createBundle(W.gl, await importSvg(POSE(5), { preserveViewport: true }));
  R.declareReach(A, tags);
  R.declareReach(B, tags);
  const tl = createShapeTimeline(
    W.gl,
    [A, B],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
    ],
  );
  tl.setTime(0.3);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  return { W, R, A, B, tl };
}

console.log(
  '(declared channelLerp) a timeline over poses declared [channelLerp, rotate]: its channel-lerp draws were built at load',
);
{
  const { W, R, tl } = await run(['channelLerp', 'rotate']);
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    ds0 = { ...R.debugStats };
  for (let i = 0; i < 3; i++) {
    tl.setTime(0.3 + i * 0.2);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(tl.bundle, { channelLerp: CL, morphT: tl.t });
    R.drawBundle(tl.bundle, { channelLerp: CL, morphT: tl.t, worldMatrix: ROT });
    R.endFrame();
    await sleep(4);
  }
  const d = (k) => (R.debugStats[k] | 0) - (ds0[k] | 0);
  ok(
    W.model.pipelines === p0 &&
      W.model.waits.length === w0 &&
      d('playBuilds') === 0 &&
      d('deferredFillDraws') === 0,
    `in play: ${W.model.pipelines - p0} pipelines built, ${W.model.waits.length - w0} waits, ${d('playBuilds')} play builds, ${d('deferredFillDraws')} deferred`,
  );
  tl.dispose();
  R.dispose();
}
console.log(
  '(declared recolor only) no channel-lerp state is added when the declaration does not name it',
);
{
  const { R, A } = await run(['recolor']);
  const states = R._policy.image(A).map((e) => e.ws && e.ws.cl);
  ok(
    !states.some(Boolean),
    `the image of a pose declared [recolor] has no channel-lerp state (${states.length} entries)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
