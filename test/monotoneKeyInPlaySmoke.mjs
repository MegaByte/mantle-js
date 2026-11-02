// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// monotoneKeyInPlaySmoke -- art whose cubics are all monotone (a cubic circle, a rounded rect) keeps one program key through the draw states that do not touch those cubics, and through a stream's first update.
//
// The key of such art carries MANTLE_NO_CUBIC_SPLITS. If an external clip, a sprite range, a zero scale in an override table or a stream's first update took the define away, the warm image, which holds no
// such state, would leave the first such draw to link and build a program in play under the stand-in-free policy. Those draws stay on the key the loading call built; a stream's key is the one without the define from the start.
// CPU, driver-model stand-in (test/_pendingGl.mjs). Same picture on the GPU: monotoneCubicStatesRenderSmoke.
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
  importSvg,
  createOverrideTable,
  buildStreamableSections,
  updateBundleGeometry,
  mkLine,
  mkCubic,
} = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const O = { asyncShaderCompile: true, nonBlocking: true, standIns: false, strictPlay: true };
async function mk() {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), O);
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
const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="a" d="M10 10 C 20 20 40 40 60 90 L 10 90 Z" fill="#303"/></svg>',
  { preserveViewport: true },
);
const STATES = {
  'an external clip': (R, b, gl) =>
    R.drawBundle(b, { extClipTex: gl.createTexture(), extClipMode: 1 }),
  'a sprite range': (R, b) => R.drawSprite(b, [0, 0]),
  'a zero scale in an override table': (R, b, gl) => {
    const t = createOverrideTable(gl, b);
    t.set(0, { localScale: [0, 1] });
    R.drawBundle(b, { overrides: t });
  },
};
console.log('(draw states) the first such draw builds nothing');
for (const [name, fn] of Object.entries(STATES)) {
  const { W, R } = await mk();
  const b = createBundle(W.gl, sec);
  await R.precompileFillsAsync({});
  ok(
    R._policy.image(b).some((e) => e.key.includes('MANTLE_NO_CUBIC_SPLITS')),
    'the premise: the art is on the certified program',
  );
  frame(R, () => R.drawBundle(b));
  const l0 = W.model.links,
    p0 = W.model.pipelines,
    b0 = R.debugStats.needMiss.blocked | 0;
  frame(R, () => fn(R, b, W.gl));
  ok(
    W.model.links === l0 && W.model.pipelines === p0 && (R.debugStats.needMiss.blocked | 0) === b0,
    `${name}: ${W.model.links - l0} links, ${W.model.pipelines - p0} pipelines, ${(R.debugStats.needMiss.blocked | 0) - b0} blocked`,
  );
  R.dispose();
}
console.log('(stream) a stream keeps one key from its first frame through its first update');
{
  const segs = (d) => [
    mkCubic([10 + d, 10], [20 + d, 20], [40 + d, 40], [60 + d, 90]),
    mkLine([60 + d, 90], [10 + d, 90]),
    mkLine([10 + d, 90], [10 + d, 10]),
  ];
  const { W, R } = await mk();
  const b = createBundle(
    W.gl,
    buildStreamableSections([{ segs: segs(0), fill: [1, 0, 0, 1] }], [0, 0, 100, 100], {}),
  );
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const l0 = W.model.links,
    p0 = W.model.pipelines,
    b0 = R.debugStats.needMiss.blocked | 0;
  updateBundleGeometry(W.gl, b, [segs(2)]);
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  ok(
    W.model.links === l0 && W.model.pipelines === p0 && (R.debugStats.needMiss.blocked | 0) === b0,
    `the update builds nothing: ${W.model.links - l0} links, ${W.model.pipelines - p0} pipelines, ${(R.debugStats.needMiss.blocked | 0) - b0} blocked`,
  );
  R.dispose();
}
console.log('(certificate) a rotated map and a rotated row still leave the certified program');
{
  const { W, R } = await mk();
  const b = createBundle(W.gl, sec);
  await R.precompileFillsAsync({});
  const plain = R._policy.K(b).filter((k) => k.charAt(0) !== '\u0000');
  const rot = R._policy
    .K(b, { worldM: new Float32Array([0.7, 0.7, 0, -0.7, 0.7, 0, 0, 0, 1]) })
    .filter((k) => k.charAt(0) !== '\u0000');
  ok(
    plain.some((k) => k.includes('MANTLE_NO_CUBIC_SPLITS')) &&
      !rot.some((k) => k.includes('MANTLE_NO_CUBIC_SPLITS')),
    'a rotated map takes the program with the splits',
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
