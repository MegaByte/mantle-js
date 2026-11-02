// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmTargetSizeSmoke -- a pipeline warm allocates its group, filter and coverage targets at one small size, and still builds every pipeline.
//
// A warm draw builds pipelines (which depend on the target's format, not its size) by drawing one scissored pixel, but it ran a bundle's whole group
// and filter path at the warm viewport's size, and the loading call warms at every derived size region: each region allocated its own targets and
// the pool kept them. One scene: 1541 new targets, 4.07 GB, 95% from warms (memory probe allocation log). The targets a warm
// allocates are WARM_RT_PX square; a draw in play after loading builds and blocks nothing (the pipelines are the same).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blurred = (w, h, sd) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><filter id="f"><feGaussianBlur stdDeviation="${sd}"/></filter></defs>` +
  `<g filter="url(#f)" opacity=".8"><path d="M${w * 0.2} ${h / 2} C${w * 0.2} ${h * 0.1} ${w * 0.8} ${h * 0.1} ${w * 0.8} ${h / 2} C${w * 0.8} ${h * 0.9} ${w * 0.2} ${h * 0.9} ${w * 0.2} ${h / 2}Z" fill="#48c"/></g></svg>`;

console.log(
  '(warm targets) the loading call over filtered groups at several sizes allocates only warm-size targets; play builds nothing and allocates its own',
);
{
  const sizeOf = (e) => (typeof e[0] === 'string' ? [e[1], e[2]] : [e[0], e[1]]);
  const bytesOf = (list) =>
    list.reduce((n, e) => {
      const [w, h] = sizeOf(e);
      return n + w * h * (typeof e[0] === 'string' ? 8 : 4);
    }, 0);
  const big = (list) =>
    list.filter((e) => {
      const [w, h] = sizeOf(e);
      return w > 16 || h > 16;
    });
  globalThis.__rtAllocLog = [];
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
  R.setViewport(1280, 720);
  const bundles = [];
  for (const [w, h, sd] of [
    [100, 100, 2],
    [300, 80, 4],
    [60, 200, 1.5],
    [500, 500, 6],
  ])
    bundles.push(
      createBundle(W.gl, await importSvg(blurred(w, h, sd), { preserveViewport: true })),
    );
  await R.precompileFillsAsync({
    viewports: [
      [1280, 720],
      [640, 360],
      [2560, 1440],
    ],
  });
  const warm = globalThis.__rtAllocLog.splice(0);
  ok(warm.length > 0, `the warm drew the filtered groups (${warm.length} target allocations)`);
  ok(
    big(warm).length === 0,
    `every target the warm allocated is warm-size (${big(warm).length} larger${
      big(warm).length
        ? ': ' +
          big(warm)
            .slice(0, 4)
            .map((e) => sizeOf(e).join('x'))
            .join(' ')
        : ''
    })`,
  );
  ok(bytesOf(warm) < 64 * 1024, `the warm's targets total ${(bytesOf(warm) / 1024).toFixed(1)} KB`);
  const nm0 = R.debugStats.needMiss,
    b0 = { blocked: nm0.blocked, builds: R.debugStats.playBuilds | 0, out: nm0.kOutsideWarmSet };
  for (let i = 0; i < 4; i++) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of bundles) R.drawBundle(b);
    R.endFrame();
    await sleep(4);
  }
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm.kOutsideWarmSet === b0.out,
    `drawn in play after loading: blocked ${nm.blocked - b0.blocked}, builds in play ${(R.debugStats.playBuilds | 0) - b0.builds}, outside the image ${nm.kOutsideWarmSet - b0.out}`,
  );
  const play = globalThis.__rtAllocLog.splice(0);
  ok(
    big(play).length > 0,
    `play allocates the real-size targets it draws with (${big(play).length})`,
  );
  R.dispose();
  globalThis.__rtAllocLog = null;
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
