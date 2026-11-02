// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamUpdateBeforeLoadSmoke -- the README's rule for a lightweight stream: update it once before the loading call, and its updates in play link and build nothing.
//
// Until its first update a lightweight stream has no analytic meshes, so the warm has no vertices to draw its keys with, and the first draw after the first update builds one pipeline in play. One update
// before the loading call gives the warm those vertices. The number without the rule is printed, not asserted: a warm that one day draws those keys on a synthetic layout is no failure of this rule.
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
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
