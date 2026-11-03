// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// alphaPlanMorphPoseSmoke -- a plan of faded instances follows a morph's pose.
//
// How faded instances share accumulators is decided from their painted boxes and cached. A morph's boxes move with t, so t must be in the key: otherwise the plan of t 0 serves t 1, instances
// that have grown to overlap share one accumulator, and a composite cuts each at its box of t 0. In pixels: groupTargetsRenderSmoke.
// CPU (test/_fakeGl.mjs): the rect the draw reaches the canvas through.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (a, b, c) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect id="a" x="2" y="2" width="${a}" height="${a}" fill="#e04020"/><rect id="b" x="4" y="4" width="${b}" height="${b}" fill="#2040c0"/><rect width="48" height="48" fill="none"/></svg>`;
const F = createFakeGl({ width: 256, height: 256 }),
  gl = F.gl;
const R = createRenderer(gl, taggedShaderSources(), {});
R.setViewport(256, 256);
R.setFillEngine({ route: 'none', kernel: 'slug' });
const A = createBundle(gl, await importSvg(doc(6, 6), { preserveViewport: true })),
  C = createBundle(gl, await importSvg(doc(44, 42), { preserveViewport: true }));
const m = createShapeMorph(gl, A, C, {}),
  m2 = createShapeMorph(gl, A, C, {});
const insts = [0, 1, 2, 3].map((i) => ({
  worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0.7 * (i % 2) - 0.4, 0.4 - 0.7 * (i >> 1), 1]),
  alpha: 0.5,
}));
const draw = (morph) => {
  const n0 = F.log.length;
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundleInstanced(morph, insts);
  R.endFrame();
  return F.log
    .slice(n0)
    .filter((e) => e.op === 'clear' || e.op === 'draw')
    .map((e) => [e.op, e.fbo === null, e.vp ? e.vp.join() : '', JSON.stringify(e.sc)].join(':'))
    .join('|');
};
m.setT(0);
const small = draw(m),
  again = draw(m);
ok(small === again, 'the premise: an unchanged pose draws the same way');
m.setT(1);
const moved = draw(m);
m2.setT(1);
const fresh = draw(m2);
ok(moved !== small, 'the pose moved: the draw changed');
ok(moved === fresh, 'the pose of t 1 after t 0 draws as t 1 alone does');
m.setT(0);
ok(draw(m) === small, 'and back at t 0, as t 0 did');
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
