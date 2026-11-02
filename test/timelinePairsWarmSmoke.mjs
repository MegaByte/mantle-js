// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// timelinePairsWarmSmoke -- every bracket-pair morph of a timeline is in the loading call's warm image.
//
// Built lazily (on first visit, or by an idle prewarm that a busy loading page never runs), a shape timeline's pairs past the first would be new bundles in
// play, their programs never warmed, and would build a program in play. A timeline builds every pair at creation, as a static bundle builds its geometry.
// requestIdleCallback is held until the loading call is done, as on a busy page (where an idle prewarm does not run in time).
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
const idle = [];
globalThis.requestIdleCallback = (fn) => {
  idle.push(fn);
  return idle.length;
};
globalThis.cancelIdleCallback = () => {};
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
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const POSES = [
  svg(
    '<path d="M20 50 C20 20 80 20 80 50 C80 80 20 80 20 50Z" fill="#4a8"/><rect x="40" y="40" width="20" height="20" fill="#fff"/>',
  ),
  svg(
    '<path d="M15 50 C15 10 85 10 85 50 C85 90 15 90 15 50Z" fill="#c44" stroke="#222" stroke-width="3"/><rect x="35" y="35" width="30" height="30" fill="#fe0"/>',
  ),
  svg(
    '<path d="M30 50 C30 30 70 30 70 50 C70 70 30 70 30 50Z" fill="#48c"/><rect x="45" y="45" width="10" height="10" fill="#000" opacity=".5"/>',
  ),
];

console.log(
  '(timeline) a timeline created before the loading call: every pair it plays exists at creation and is warmed by that call',
);
{
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const bundles = [];
  for (const p of POSES)
    bundles.push(createBundle(W.gl, await importSvg(p, { preserveViewport: true })));
  const tl = createShapeTimeline(W.gl, bundles, [
    { time: 0, bundleIndex: 0 },
    { time: 1, bundleIndex: 1 },
    { time: 2, bundleIndex: 2 },
    { time: 3, bundleIndex: 0 },
  ]);
  tl.setTime(0);
  await R.precompileFillsAsync({});
  for (const f of idle.splice(0)) f({ timeRemaining: () => 50, didTimeout: false }); // the page goes idle only now
  const nm0 = R.debugStats.needMiss;
  const b0 = {
    blocked: nm0.blocked,
    reuse: nm0.reuseDraws,
    builds: R.debugStats.playBuilds | 0,
    out: nm0.kOutsideWarmSet,
    si: nm0.standInDraws,
  };
  for (let t = 0; t <= 3; t += 0.125) {
    tl.setTime(t);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(tl.bundle);
    R.endFrame();
    await sleep(3);
  }
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      nm.reuseDraws === b0.reuse &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm.kOutsideWarmSet === b0.out &&
      nm.standInDraws === b0.si,
    `played 0..3 s over 3 bracket pairs: blocked ${nm.blocked - b0.blocked}, reuse ${nm.reuseDraws - b0.reuse}, builds in play ${(R.debugStats.playBuilds | 0) - b0.builds}, outside the image ${nm.kOutsideWarmSet - b0.out}, stand-ins ${nm.standInDraws - b0.si}`,
  );
  tl.dispose();
  R.dispose();
}
console.log(
  '(timeline) played past its last key: the hold of the last pose (where the shell feedback ends) is a pair built at creation too',
);
{
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const bundles = [];
  for (const p of POSES)
    bundles.push(createBundle(W.gl, await importSvg(p, { preserveViewport: true })));
  const tl = createShapeTimeline(W.gl, bundles, [
    { time: 0, bundleIndex: 0 },
    { time: 1, bundleIndex: 1 },
    { time: 2, bundleIndex: 2 },
  ]); // ends on a pose the first key is not
  tl.setTime(0);
  await R.precompileFillsAsync({});
  for (const f of idle.splice(0)) f({ timeRemaining: () => 50, didTimeout: false });
  const nm0 = R.debugStats.needMiss;
  const b0 = {
    blocked: nm0.blocked,
    builds: R.debugStats.playBuilds | 0,
    out: nm0.kOutsideWarmSet,
  };
  for (let t = 0; t <= 3; t += 0.25) {
    tl.setTime(t);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(tl.bundle, { morphT: tl.t });
    R.endFrame();
    await sleep(3);
  }
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm.kOutsideWarmSet === b0.out,
    `played 0..3 s past the last key at 2 s: blocked ${nm.blocked - b0.blocked}, builds in play ${(R.debugStats.playBuilds | 0) - b0.builds}, outside the image ${nm.kOutsideWarmSet - b0.out}`,
  );
  tl.dispose();
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
