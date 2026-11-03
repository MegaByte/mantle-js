// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamUpdateBeforeLoadSmoke -- the README's rule for a lightweight stream: update it once before the loading call, and its updates in play link and build nothing.
//
// Until its first update a lightweight stream has no analytic meshes, so the warm has no vertices to draw its keys with, and the first draw after the first update builds one pipeline in play. One update
// before the loading call gives the warm those vertices. The number without the rule is printed, not asserted: a warm that one day draws those keys on a synthetic layout is no failure of this rule.
// A stream whose content changes kind in play (lines to a cubic or a quad, a cubic to lines) builds nothing either: under the stand-in-free policy the warm
// image pins a streamable bundle's content omissions, so a segment type new mid-stream keeps the one key the image holds (no build, no block, no reuse, no
// fill miss, no key outside the image).
// CPU, driver-model stand-in (test/_pendingGl.mjs). Same picture on the GPU: streamWarmRenderSmoke.
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
const {
  createRenderer,
  createBundle,
  buildStreamableSections,
  updateBundleGeometry,
  mkLine,
  mkCubic,
  mkQuad,
} = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const STRICT = { asyncShaderCompile: true, nonBlocking: true, standIns: false, strictPlay: true };
async function mk(o = STRICT) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), o);
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(512, 512);
  return { W, R };
}
const frame = (R, fn) => {
  R.beginFrame([1, 1, 1, 1]);
  fn();
  R.endFrame();
};
const cubic = (d) => [
  mkCubic([10 + d, 10], [20 + d, 20], [40 + d, 40], [60 + d, 90]),
  mkLine([60 + d, 90], [10 + d, 90]),
  mkLine([10 + d, 90], [10 + d, 10]),
];
const lines = (d) => [
  mkLine([10 + d, 10], [60 + d, 90]),
  mkLine([60 + d, 90], [10 + d, 90]),
  mkLine([10 + d, 90], [10 + d, 10]),
];
const quad = (d) => [
  mkQuad([10 + d, 10], [40 + d, 20], [60 + d, 90]),
  mkLine([60 + d, 90], [10 + d, 90]),
  mkLine([10 + d, 90], [10 + d, 10]),
];
const marks = (W, R) => [W.model.links, W.model.pipelines, R.debugStats.needMiss.blocked | 0];
const moved = (W, R, m) => {
  const n = marks(W, R);
  return [n[0] - m[0], n[1] - m[1], n[2] - m[2]];
};
const none = (d) => d[0] === 0 && d[1] === 0 && d[2] === 0;
const say = (d) => `${d[0]} links, ${d[1]} pipelines, ${d[2]} blocked`;
const stream = (W, first = cubic(0)) =>
  createBundle(
    W.gl,
    buildStreamableSections([{ segs: first, fill: [1, 0, 0, 1] }], [0, 0, 100, 100], {
      lightweight: true,
    }),
  );

console.log('(without the rule) the first update comes after the loading call');
{
  const { W, R } = await mk();
  const b = stream(W);
  await R.precompileFillsAsync({});
  const un = R.debugStats.needMiss.bindSetUnbuilt;
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  updateBundleGeometry(W.gl, b, [cubic(2)], { lightweight: true });
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  console.log(
    `  (printed, not asserted) ${say(moved(W, R, m))}; the warm left ${un} keys it could not draw`,
  );
  ok(moved(W, R, m)[2] === 0, `nothing blocks on it either way (${moved(W, R, m)[2]})`);
  R.dispose();
}

console.log('(the rule) one update before the loading call');
for (const [name, O] of [
  ['the stand-in-free default', STRICT],
  ['the stand-in policy', { ...STRICT, standIns: true, needMissPolicy: 'defer' }],
]) {
  const { W, R } = await mk(O);
  const b = stream(W);
  updateBundleGeometry(W.gl, b, [cubic(1)], { lightweight: true });
  await R.precompileFillsAsync({});
  if (O === STRICT)
    ok(
      (R.debugStats.needMiss.bindSetUnbuilt | 0) === 0,
      `${name}: the warm built every key it listed (${R.debugStats.needMiss.bindSetUnbuilt} unbuilt)`,
    );
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  const r = updateBundleGeometry(W.gl, b, [cubic(2)], { lightweight: true });
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  ok(r.ok && none(moved(W, R, m)), `${name}: the first update in play (${say(moved(W, R, m))})`);
  const m2 = marks(W, R);
  for (let n = 3; n < 40; n++) {
    updateBundleGeometry(W.gl, b, [cubic(n)], { lightweight: true });
    frame(R, () => R.drawBundle(b));
  }
  ok(none(moved(W, R, m2)), `${name}: and 37 more (${say(moved(W, R, m2))})`);
  R.dispose();
}

console.log('(the rule) a stream of another content');
for (const [name, first, next] of [
  ['lines to a cubic', lines, cubic],
  ['lines to a quad', lines, quad],
  ['a cubic to lines', cubic, lines],
]) {
  const { W, R } = await mk();
  const b = stream(W, first(0));
  updateBundleGeometry(W.gl, b, [first(1)], { lightweight: true });
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  updateBundleGeometry(W.gl, b, [next(2)], { lightweight: true });
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  ok(none(moved(W, R, m)), `${name} (${say(moved(W, R, m))})`);
  R.dispose();
}
// A streamed bundle's content is unknown at warm time: a segment type that first appears mid-stream removes a MANTLE_NO_*
// from its program. Under the stand-in-free policy the warm image therefore pins the content omissions of a streamable
// bundle (one content-agnostic key for its whole life), so streaming a new segment type in after the loading call
// builds nothing, blocks nothing and asks for no key outside the image. A streamed road on the auto AAC route: two
// cubic blobs, updated once before the loading call, then one of them takes a line. Run at link 30 ms and pipeline
// 100 ms, so a key outside the image would still be pending when it is drawn.
console.log(
  '(the rule) a stand-in-free stream pins its content omissions: a new segment type mid-stream',
);
{
  const K = 0.5522847498;
  const blob = (cx, cy, rx, ry) => {
    const kx = K * rx,
      ky = K * ry;
    const E = [cx + rx, cy],
      N = [cx, cy - ry],
      Wp = [cx - rx, cy],
      S = [cx, cy + ry];
    return [
      mkCubic(E, [cx + rx, cy - ky], [cx + kx, cy - ry], N),
      mkCubic(N, [cx - kx, cy - ry], [cx - rx, cy - ky], Wp),
      mkCubic(Wp, [cx - rx, cy + ky], [cx - kx, cy + ry], S),
      mkCubic(S, [cx + kx, cy + ry], [cx + rx, cy + ky], E),
    ];
  };
  const withLine = (cx, cy, rx, ry) => {
    const s = blob(cx, cy, rx, ry);
    s[3] = mkLine([cx, cy + ry], [cx + rx, cy]);
    return s;
  };
  const FILLS = [
    [0.78, 0.2, 0.2, 1],
    [0.2, 0.55, 0.78, 1],
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    aacFill: 'auto',
    standIns: false,
  });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(256, 256);
  const st = createBundle(
    W.gl,
    buildStreamableSections(
      [blob(70, 70, 30, 30), blob(160, 160, 22, 22)].map((segs, i) => ({ segs, fill: FILLS[i] })),
      null,
      { lightweight: true },
    ),
  );
  // The app's first stream frame, before its loading call.
  updateBundleGeometry(W.gl, st, [blob(72, 68, 31, 29), blob(158, 162, 23, 21)], {
    lightweight: true,
  });
  await R.precompileFillsAsync({});
  const draw = async (n) => {
    for (let i = 0; i < n; i++) {
      frame(R, () => R.drawBundle(st, {}));
      await sleep(3);
    }
  };
  await draw(3);
  const maskBefore = st.segTypeMask;
  const keyBefore = R._policy.K(st).join('\n');
  const up = updateBundleGeometry(W.gl, st, [withLine(85, 60, 42, 38), blob(150, 175, 18, 26)], {
    lightweight: true,
  });
  const keyAfter = R._policy.K(st).join('\n');
  const count = () => {
    const nm = R.debugStats.needMiss;
    return [
      R.debugStats.playBuilds | 0,
      nm.blocked,
      nm.kOutsideWarmSet,
      nm.reuseDraws,
      nm.fillMisses,
    ];
  };
  const c0 = count();
  await draw(4);
  const [b, k, o, r, f] = count().map((v, i) => v - c0[i]);
  ok(
    up.ok &&
      st.segTypeMask & 1 &&
      keyBefore === keyAfter &&
      b === 0 &&
      k === 0 &&
      o === 0 &&
      r === 0 &&
      f === 0,
    `the stand-in-free stream has ONE key across the new segment type, covered by its image (no build, no block, no key outside it): update ok ${up.ok}, mask 0x${(maskBefore | 0).toString(16)} -> 0x${(st.segTypeMask | 0).toString(16)}, K before == after ${keyBefore === keyAfter}; builds ${b}, blocked ${k}, outside the image ${o}, reuse ${r}, fill misses ${f}`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
