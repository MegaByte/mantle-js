// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// renderDisposedTargetSmoke -- render(target) with a disposed target draws nothing, as drawBundle does.
//
// setBundle refuses a disposed bundle and leaves the last one bound, and render(target) went on to draw that one: a frame of the wrong picture, with no warning.
// CPU (test/_fakeGl.mjs): draws, clears and warnings.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${b}</svg>`;
const F = createFakeGl({ width: 400, height: 400 }),
  gl = F.gl;
const R = createRenderer(gl, taggedShaderSources(), {});
R.setViewport(400, 400);
const imp = async (x) =>
  createBundle(
    gl,
    await importSvg(doc(`<rect id="a" x="${x}" y="50" width="80" height="80" fill="#c33"/>`), {
      preserveViewport: true,
    }),
  );
const live = await imp(50),
  gone = await imp(90),
  m0 = await imp(10),
  m1 = await imp(20);
const morph = createShapeMorph(gl, m0, m1, {});
const paints = () => F.log.filter((e) => e.op === 'draw' || e.op === 'clear').length;
R.render(live);
ok(paints() > 0, 'the premise: a live target draws');
gone.dispose();
let n0 = paints();
R.render(gone);
ok(paints() === n0, `a disposed bundle paints nothing (${paints() - n0} draws and clears)`);
ok(
  warnings.some((w) => /disposed/.test(w)),
  'and says so',
);
morph.dispose();
n0 = paints();
R.render(morph);
ok(paints() === n0, `a disposed morph paints nothing (${paints() - n0})`);
n0 = paints();
R.render(live);
ok(paints() > n0, 'the live bundle still draws');
n0 = paints();
R.render();
ok(paints() > n0, 'and render() with no target draws what is bound');
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
