// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// loadingCallOverlapSmoke -- overlapping loading calls run one at a time, and awaitBundleReady answers from what was BUILT, never from what a warm has only listed.
//
// A key enters the warm set when the bind-set pass lists it. Read from that set, awaitBundleReady would resolve at once for a program still to be built when called while another
// bundle's warm runs, and say ready for good after a warm stopped at its deadline. Beside that, the size being warmed, the load's phase, the window and the uploads are one set of
// renderer state, which a second call must not move under the first. And a warm of one late bundle must not write the app's viewport range away or mark whole size classes warmed
// for a scene it never draws.
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
const M = await import('../src/index.js');
const { createRenderer, createBundle, importSvg } = M;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const fill = (i) => doc(`<path d="M${10 + i} 10 C60 0 90 40 80 90 L20 70Z" fill="#a48"/>`);
const LATE = (i) =>
  doc(
    `<circle cx="50" cy="50" r="${40 - i}" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="14 10" stroke-linecap="round"/>`,
  );
const OPTS = { asyncShaderCompile: true, nonBlocking: true, strictPlay: true, aacFill: 'auto' };
async function mk(link, pipe) {
  const W = createPendingGl({ linkMs: link, pipelineMs: pipe });
  const R = createRenderer(W.gl, taggedShaderSources(), OPTS);
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(512, 512);
  const scene = [];
  for (let i = 0; i < 4; i++)
    scene.push(createBundle(W.gl, await importSvg(fill(i), { preserveViewport: true })));
  return { W, R, scene };
}
const late = async (W, i) =>
  createBundle(W.gl, await importSvg(LATE(i), { preserveViewport: true }));
const fresh = (key) => key.charAt(0) !== '\u0000';

console.log('(overlap) a late bundle whose keys another warm has only listed waits for that warm');
{
  const { W, R } = await mk(5, 40);
  await R.precompileFillsAsync({});
  const a = await late(W, 0),
    b = await late(W, 1);
  let aDone = false,
    bDone = false;
  const pa = R.awaitBundleReady(a).then(() => {
    aDone = true;
  });
  // until the warm has listed b's keys
  for (
    let i = 0;
    i < 60000 &&
    !aDone &&
    !R._policy
      .image(b)
      .filter((e) => fresh(e.key))
      .every((e) => R._policy.warmSet().has(e.key));
    i++
  )
    await sleep(1);
  ok(!aDone, 'the premise: the first warm is still running');
  const pb = R.awaitBundleReady(b).then(() => {
    bDone = true;
  });
  await sleep(0);
  ok(!bDone, 'the second call did not resolve on keys the first has only listed');
  await pb;
  ok(aDone, 'it resolved after the warm that builds them');
  await pa;
  const p0 = W.model.pipelines,
    ds = { ...R.debugStats };
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(a);
  R.drawBundle(b);
  R.endFrame();
  ok(
    W.model.pipelines === p0 && (R.debugStats.deferredFillDraws | 0) === (ds.deferredFillDraws | 0),
    `both first draws build and defer nothing (${W.model.pipelines - p0} pipelines)`,
  );
  R.dispose();
}
console.log("(one at a time) a second call does not move the running call's state");
{
  const { W, R } = await mk(5, 20);
  const first = R.precompileFillsAsync({});
  const load = R.debugStats.coopLoad;
  await sleep(5);
  const second = R.precompileFillsAsync({});
  await sleep(5);
  ok(R.debugStats.coopLoad === load, 'the running call keeps the load record');
  await first;
  ok(load.phase === 'done', 'the first ran to its own end');
  await sleep(0);
  ok(R.debugStats.coopLoad !== load, 'then the second started');
  await second;
  ok(R.debugStats.coopLoad.phase === 'done', 'and it ends');
  R.dispose();
}
console.log(
  '(deadline) a warm stopped at its deadline left keys listed, not built: the next ask warms them',
);
{
  // Once the pass has listed its keys the fence behind a batch never signals: the pass sits at its first batch break until its deadline, deterministically, with the rest of its list unbuilt.
  // (Doubled when the deadline fell before the listing.)
  let done = false;
  const RICH = [
    doc(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 C60 0 90 40 80 90 L20 70Z" fill="url(#g)"/>',
    ),
    doc(
      '<path d="M10 50 C30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
    ),
    doc(
      '<defs><clipPath id="c"><circle cx="50" cy="50" r="30"/></clipPath></defs><path d="M10 10 Q60 0 80 90 L20 70Z" fill="#a40" clip-path="url(#c)"/>',
    ),
    doc('<path d="M10 10 L90 10 L50 90Z" fill="#0a3"/>'),
  ];
  for (let warmTimeoutMs = 1000; !done && warmTimeoutMs <= 64000; warmTimeoutMs *= 2) {
    const { W, R, scene } = await mk(1, 1);
    for (const x of RICH)
      scene.push(createBundle(W.gl, await importSvg(x, { preserveViewport: true })));
    const sync = W.gl.getSyncParameter;
    W.gl.getSyncParameter = (f, p) => (R._policy.warmSet().size ? -1 : sync.call(W.gl, f, p));
    await R.precompileFillsAsync({ warmTimeoutMs, timeoutMs: 20 });
    W.gl.getSyncParameter = sync;
    if (!R._policy.warmSet().size) {
      R.dispose();
      continue;
    }
    done = true;
    ok(R.debugStats.coopLoad.incomplete === true, 'the premise: the call stopped at its deadline');
    ok(
      scene.some((b) => R._policy.needsWarm(b)),
      'a key listed and not built reads as missing',
    );
    for (const b of scene) await R.awaitBundleReady(b);
    ok(!scene.some((b) => R._policy.needsWarm(b)), 'asked again, the image is built');
    const p0 = W.model.pipelines,
      d0 = R.debugStats.deferredFillDraws | 0,
      wm = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
    R.beginFrame([1, 1, 1, 1]);
    for (const b of scene) {
      R.drawBundle(b);
      R.drawBundle(b, { worldMatrix: wm });
    }
    R.endFrame();
    ok(
      W.model.pipelines === p0 && (R.debugStats.deferredFillDraws | 0) === d0,
      `a draw as drawn and rotated then builds and defers nothing (${W.model.pipelines - p0} pipelines, ${(R.debugStats.deferredFillDraws | 0) - d0} deferred)`,
    );
    R.dispose();
  }
  ok(done, 'the premise: the deadline fell after the pass listed its keys');
}
console.log(
  "(scope) a warm of one late bundle keeps the app's range, and claims no size class for the scene",
);
{
  const { W, R } = await mk(1, 1);
  await R.precompileFillsAsync({ maxViewportPx: 4096 });
  const range0 = R.debugStats.viewportWarm.derived.range;
  const a = await late(W, 0);
  ok(R._policy.needsWarm(a), 'the premise: the late bundle needs a warm');
  R.setViewport(8192, 8192); // past the range: a class only the background warm covers
  R.beginFrame([1, 1, 1, 1]);
  R.endFrame();
  await R.awaitBundleReady(a);
  ok(
    R.debugStats.viewportWarm.derived.range.maxW === range0.maxW,
    `the derived range stays the app's (${R.debugStats.viewportWarm.derived.range.maxW})`,
  );
  // (a hidden tab counts as idle: the background class warm runs without the settled static screen it otherwise waits for)
  globalThis.document = { hidden: true };
  const ev0 = R.debugStats.viewportWarm.events.length;
  for (let i = 0; i < 6000 && R.debugStats.viewportWarm.events.length === ev0; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.endFrame();
    await sleep(10);
  }
  delete globalThis.document;
  ok(
    R.debugStats.viewportWarm.events.length > ev0,
    `the scene's background warm for that class still runs (${R.debugStats.viewportWarm.events.length - ev0} new)`,
  );
  R.dispose();
}
console.log(
  '(throw) a loading call that throws is over: no phase left behind, and the next call runs',
);
{
  const { W, R, scene } = await mk(1, 1);
  await R.precompileFillsAsync({});
  const bbox = scene[0].globalBBox;
  Object.defineProperty(scene[0], 'globalBBox', {
    get() {
      throw new Error('boom');
    },
    configurable: true,
  });
  let threw = false;
  await R.precompileFillsAsync({}).catch(() => {
    threw = true;
  });
  ok(threw, 'the premise: it threw');
  ok(
    R.debugStats.coopLoad.phase === 'done' && R.debugStats.coopLoad.incomplete === true,
    `its record reads done, incomplete (${R.debugStats.coopLoad.phase})`,
  );
  Object.defineProperty(scene[0], 'globalBBox', {
    value: bbox,
    writable: true,
    configurable: true,
  });
  await R.precompileFillsAsync({ classes: false });
  ok(R.debugStats.coopLoad.phase === 'done', 'the next call ran');
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
