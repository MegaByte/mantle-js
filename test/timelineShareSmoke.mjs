// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// timelineShareSmoke -- timelines over the same poses share their pair morphs; each draws its own pose.
//
// A scene that makes each of its sprites a timeline over the same 40 poses would, without sharing, build 31 pair morphs (~4 MB each) per sprite: memory
// growing with every sprite on screen. A pair morph is one per context and pose pair (reference-counted, disposed with its last user), and each user draws its
// own pose with drawBundle(timeline.bundle, { morphT: timeline.t }).
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
const pose = (r, c) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M${50 - r} 50 C${50 - r} ${50 - r} ${50 + r} ${50 - r} ${50 + r} 50 C${50 + r} ${50 + r} ${50 - r} ${50 + r} ${50 - r} 50Z" fill="${c}"/></svg>`;
const KEYS = [
  { time: 0, bundleIndex: 0 },
  { time: 1, bundleIndex: 1 },
  { time: 2, bundleIndex: 2 },
];

console.log(
  '(shared pairs) two timelines over the same poses: one morph per pair, each drawn at its own pose, disposed with the last user',
);
{
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
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
  const poses = [];
  for (const [r, c] of [
    [20, '#48c'],
    [30, '#c84'],
    [25, '#4c8'],
  ])
    poses.push(createBundle(W.gl, await importSvg(pose(r, c), { preserveViewport: true })));
  poses.forEach((b, i) => {
    b.debugLabel = 'pose' + i;
  }); // (as an app labels each asset)
  const A = createShapeTimeline(W.gl, poses, KEYS),
    B = createShapeTimeline(W.gl, poses, KEYS);
  A.setTime(0.25);
  B.setTime(0.75);
  ok(
    A.currentMorph && A.currentMorph === B.currentMorph,
    'both timelines are on the same pair morph (0..1)',
  );
  {
    const lb = A.currentMorph && A.currentMorph.bundle && A.currentMorph.bundle.debugLabel;
    ok(lb === 'pair:pose0>pose1', `the pair morph is named by its poses (${lb})`);
  }
  A.setTime(1.5);
  B.setTime(1.25);
  ok(
    A.currentMorph === B.currentMorph && A.currentMorph !== null,
    'and on the same morph of the second pair (1..2)',
  );
  ok(A.t === 0.5 && B.t === 0.25, `each keeps its own pose on it (A ${A.t}, B ${B.t})`);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  // each draw applies its own user's pose, in draw order, on the one shared morph
  const m = A.currentMorph,
    seen = [],
    orig = m.bundle._morphSetT;
  Object.defineProperty(m.bundle, '_morphSetT', {
    value: (t) => {
      seen.push(t);
      return orig(t);
    },
    configurable: true,
    writable: true,
  });
  const nm0 = R.debugStats.needMiss,
    b0 = { blocked: nm0.blocked, builds: R.debugStats.playBuilds | 0, out: nm0.kOutsideWarmSet };
  for (let i = 0; i < 3; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(A.bundle, { morphT: A.t });
    R.drawBundle(B.bundle, { morphT: B.t });
    R.endFrame();
    await sleep(4);
  }
  ok(
    seen.length === 6 && seen.every((t, i) => t === (i % 2 ? B.t : A.t)),
    `the draws applied A's and B's poses in turn (${seen.join(' ')})`,
  );
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm.kOutsideWarmSet === b0.out,
    `drawn in play: blocked ${nm.blocked - b0.blocked}, builds in play ${(R.debugStats.playBuilds | 0) - b0.builds}, outside the image ${nm.kOutsideWarmSet - b0.out}`,
  );
  A.dispose();
  ok(
    !m.bundle._disposed && B.currentMorph === m,
    'disposing one user keeps the shared morph for the other',
  );
  B.dispose();
  ok(!!m.bundle._disposed || m.bundle === null, 'disposing the last user disposes it');
  const C = createShapeTimeline(W.gl, poses, KEYS);
  C.setTime(0.5);
  ok(
    C.currentMorph && C.currentMorph !== m && !C.currentMorph.bundle._disposed,
    'a later timeline over the same poses gets a fresh morph',
  );
  C.dispose();
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
