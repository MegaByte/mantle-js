// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// recolorFoldWarmSmoke -- a bundle declared both a color matrix and a channel lerp has one recolor program under the stand-in-free policy.
//
// The stand-in-free loading call builds every program a bundle's declared states bind. An app that declares ['channelLerp', 'recolor', 'rotate', ...] for every bundle would give each of its
// base keys a color-matrix program and a channel-lerp program, as drawn and rotated, that differ by one uniform-gated block: a large share of its programs, and of its load
// time. Pinned: the two states ask for one key (and a palette draw keeps its own); the warm image shrinks by exactly those keys; each draw's enabled flags follow its own state, which
// is what keeps the pixels (recolorFoldPixelGpuSmoke); a bundle declared one recolor and the stand-in policy keep their keys, and an undeclared bundle, whose domain is every recolor, folds; a morph that outlives a pose keeps
// the answer its warm was built on; nothing is built, waited for or deferred in play.
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
const CM = new Float32Array([0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1]);
const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const ALL = ['channelLerp', 'recolor', 'rotate'];
const fills = (keys) => keys.filter((k) => k.charAt(0) !== '\u0000');

async function make(tags, opts = {}) {
  const W = createPendingGl({ linkMs: 5, pipelineMs: 10 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
    ...opts,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(512, 512);
  const A = createBundle(W.gl, await importSvg(POSE(0), { preserveViewport: true })),
    B = createBundle(W.gl, await importSvg(POSE(5), { preserveViewport: true }));
  if (tags) {
    R.declareReach(A, tags);
    R.declareReach(B, tags);
  }
  return { W, R, A, B };
}
const keyOf = (R, b, patch) => R._policy.keyWith(b, patch);
const imageOf = (R, b) => fills(R._policy.image(b).map((e) => e.key));

console.log(
  '(declared both) one recolor key per base, the palette keeps its own, the image holds no partial-recolor key',
);
{
  const { R, A } = await make(ALL);
  const cm = keyOf(R, A, { colorMatrix: CM }),
    cl = keyOf(R, A, { channelLerp: CL }),
    both = keyOf(R, A, { colorMatrix: CM, channelLerp: CL });
  ok(cm === cl && cm === both, 'a color-matrix draw, a channel-lerp draw and both ask for one key');
  ok(
    !cm.includes('MANTLE_NO_CHANNEL_LERP') &&
      !cm.includes('MANTLE_NO_COLOR_MATRIX') &&
      cm.includes('MANTLE_NO_PALETTE') &&
      !cm.includes('MANTLE_NO_RECOLOR'),
    'that key keeps both blocks and still omits the palette',
  );
  const pal = keyOf(R, A, { palette: { texture: {} } });
  ok(
    pal.includes('MANTLE_NO_CHANNEL_LERP') &&
      pal.includes('MANTLE_NO_COLOR_MATRIX') &&
      !pal.includes('MANTLE_NO_PALETTE'),
    'a palette draw with neither keeps its own lean key',
  );
  ok(keyOf(R, A, {}).includes('MANTLE_NO_RECOLOR'), 'an uncolored draw keeps the no-recolor key');
  const img = imageOf(R, A);
  ok(
    !img.some((k) => k.includes('MANTLE_NO_CHANNEL_LERP') || k.includes('MANTLE_NO_COLOR_MATRIX')),
    `no partial-recolor key in the image (${img.length} keys)`,
  );
  R.dispose();
}
console.log(
  '(controls) one recolor declared and the stand-in policy keep their keys; an undeclared bundle, whose domain is every recolor, folds',
);
{
  const { R, A, B } = await make(['channelLerp', 'rotate']);
  const k = keyOf(R, A, { channelLerp: CL });
  ok(
    k.includes('MANTLE_NO_COLOR_MATRIX') && !k.includes('MANTLE_NO_CHANNEL_LERP'),
    'declared channelLerp only: the lean channel-lerp key',
  );
  R.declareReach(B, ['recolor', 'rotate']);
  const k2 = keyOf(R, B, { colorMatrix: CM });
  ok(
    k2.includes('MANTLE_NO_CHANNEL_LERP') && !k2.includes('MANTLE_NO_COLOR_MATRIX'),
    'declared recolor only: the lean color-matrix key',
  );
  R.dispose();
  const u = await make(null);
  ok(
    keyOf(u.R, u.A, { colorMatrix: CM }) === keyOf(u.R, u.A, { channelLerp: CL }),
    'undeclared: one key, the one declared art builds (a text bundle created in play asks for it)',
  );
  u.R.dispose();
  const s = await make(ALL, { standIns: true, needMissPolicy: 'defer' });
  ok(
    keyOf(s.R, s.A, { colorMatrix: CM }) !== keyOf(s.R, s.A, { channelLerp: CL }),
    'the stand-in policy: two keys',
  );
  s.R.dispose();
}
console.log(
  '(image) the fold removes exactly the partial-recolor keys, and the warm builds fewer programs',
);
{
  const f = await make(ALL),
    one = await make(['channelLerp', 'rotate']),
    two = await make(['recolor', 'rotate']);
  const fi = imageOf(f.R, f.A),
    plain = (i) => i.filter((k) => k.includes('MANTLE_NO_RECOLOR'));
  ok(plain(fi).length === plain(imageOf(one.R, one.A)).length, 'the uncolored keys are untouched');
  ok(
    fi.length - plain(fi).length ===
      imageOf(two.R, two.A).length - plain(imageOf(two.R, two.A)).length,
    `the recolored half is one flavor's size (${fi.length - plain(fi).length} keys)`,
  );
  await f.R.precompileFillsAsync({});
  const nm = f.R.debugStats.needMiss;
  ok(nm.bindSetUnbuilt === 0, `the whole image built (${nm.bindSetImage} image entries)`);
  f.R.dispose();
  one.R.dispose();
  two.R.dispose();
}
console.log(
  '(play) draws of both states, as drawn and rotated: built at load, each with its own enabled flags',
);
const noBuilds = (W, R, p0, w0, ds0, what) => {
  const d = (k) => (R.debugStats[k] | 0) - (ds0[k] | 0);
  ok(
    W.model.pipelines === p0 &&
      W.model.waits.length === w0 &&
      d('playBuilds') === 0 &&
      d('deferredFillDraws') === 0 &&
      d('playStandInDraws') === 0,
    `${what}: ${W.model.pipelines - p0} pipelines built, ${W.model.waits.length - w0} waits, ${d('playBuilds')} play builds, ${d('deferredFillDraws')} deferred, ${d('playStandInDraws')} stand-ins`,
  );
};
{
  const { W, R, A } = await make(ALL, { aacPoints: false }); // (the fill program's own flags: the small-shape points route has neither block)
  await R.precompileFillsAsync({});
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    ds0 = { ...R.debugStats };
  const seen = [];
  for (const [opts, wantCl, wantCm] of [
    [{ channelLerp: CL }, 1, 0],
    [{ colorMatrix: CM }, 0, 1],
    [{ channelLerp: CL, worldMatrix: ROT }, 1, 0],
    [{ colorMatrix: CM, worldMatrix: ROT }, 0, 1],
    [{}, 0, 0],
  ]) {
    const n0 = W.F.log.length;
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(A, opts);
    R.endFrame();
    await sleep(2);
    const draws = W.F.log.slice(n0).filter((e) => e.uni && 'uChannelLerpEnabled' in e.uni);
    const last = draws[draws.length - 1];
    seen.push(
      !!last && last.uni.uChannelLerpEnabled === wantCl && last.uni.uColorMatrixEnabled === wantCm,
    );
  }
  ok(
    seen.every(Boolean),
    `each draw sets both enabled flags from its own state (${seen.join(',')})`,
  );
  noBuilds(W, R, p0, w0, ds0, 'a bundle in play');
  R.dispose();
}
{
  const { W, R, A, B } = await make(ALL);
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
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    ds0 = { ...R.debugStats };
  for (let i = 0; i < 3; i++) {
    tl.setTime(0.3 + i * 0.2);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(tl.bundle, { channelLerp: CL, morphT: tl.t });
    R.drawBundle(tl.bundle, { colorMatrix: CM, morphT: tl.t, worldMatrix: ROT });
    R.endFrame();
    await sleep(2);
  }
  noBuilds(W, R, p0, w0, ds0, 'a morph in play');
  // a morph that outlives a pose keeps its answer: its reach is read through weak references to its poses, and the draw path asks it (a pose no longer declared reads like a pose gone)
  const k0 = keyOf(R, tl.bundle, { channelLerp: CL });
  R.declareReach(B, null);
  ok(
    keyOf(R, tl.bundle, { channelLerp: CL }) === k0,
    'a morph whose pose is gone binds the key its warm built',
  );
  tl.dispose();
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
