// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// timelineSharedPoseSmoke -- timelines over the same poses share one morph, and each still draws its own pose wherever the draw can tell whose it is.
//
// Pair morphs are shared per context, so every entry must apply its user's pose: drawBundle(timeline) draws that timeline's pose, not whichever timeline called setTime last; setTime with an
// unchanged time applies its pose over the other user's; the instanced and handle entries honor morphT. And morphT keeps the draw's framebuffer, so a caller's own target
// (drawInstance: "into the currently-bound framebuffer") is not swapped for the canvas. NOT covered, and not claimed: a bare timeline.bundle drawn after other timelines moved it (the bundle
// does not know its user) and hit tests of such a bundle. CPU, driver-model stand-in (test/_pendingGl.mjs).
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
const circ = (r) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M${50 - r} 50 C${50 - r} ${50 - r} ${50 + r} ${50 - r} ${50 + r} 50 C${50 + r} ${50 + r} ${50 - r} ${50 + r} ${50 - r} 50Z" fill="#48c"/></svg>`;
const W = createPendingGl({ linkMs: 1, pipelineMs: 1 }),
  gl = W.gl;
const R = createRenderer(gl, taggedShaderSources(), { aacFill: 'auto' });
R.ready.catch(() => {});
setTimeout(() => W.release(), 5);
await R.ready;
R.setViewport(256, 256);
const poses = [
  createBundle(gl, await importSvg(circ(20), { preserveViewport: true })),
  createBundle(gl, await importSvg(circ(40), { preserveViewport: true })),
];
const KEYS = [
  { time: 0, bundleIndex: 0 },
  { time: 1, bundleIndex: 1 },
];
const A = M.createShapeTimeline(gl, poses, KEYS),
  B = M.createShapeTimeline(gl, poses, KEYS);
A.setTime(0.25);
B.setTime(0.75);
const b = A.bundle;
ok(A.bundle === B.bundle, 'the premise: one shared morph');
console.log('(drawBundle) each timeline drawn draws its own pose');
{
  const seen = [];
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(A);
  seen.push(b._morphSrc.t);
  R.drawBundle(B);
  seen.push(b._morphSrc.t);
  R.drawBundle(A);
  seen.push(b._morphSrc.t);
  R.endFrame();
  ok(seen.join() === '0.25,0.75,0.25', `poses at the draws: ${seen.join()}`);
}
console.log("(setTime) an unchanged time still puts this timeline's pose back");
{
  B.setTime(0.75);
  ok(b._morphSrc.t === 0.75, `after B.setTime: ${b._morphSrc.t}`);
  A.setTime(0.25);
  ok(b._morphSrc.t === 0.25, `after A.setTime with its old time: ${b._morphSrc.t}`);
}
console.log('(entries) the instanced and handle entries honor morphT');
{
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundleInstanced(b, [{}, {}], { morphT: 0.6 });
  ok(b._morphSrc.t === 0.6, `drawBundleInstanced: ${b._morphSrc.t}`);
  const h = R.createBundleHandle(b);
  h.draw({ morphT: 0.4 });
  ok(b._morphSrc.t === 0.4, `handle.draw: ${b._morphSrc.t}`);
  R.endFrame();
}
console.log("(target) a pose change puts back the framebuffer the draw found, the caller's too");
{
  const mine = gl.createFramebuffer();
  let cur = null;
  const oB = gl.bindFramebuffer;
  gl.bindFramebuffer = (t, f) => {
    if (t === gl.FRAMEBUFFER || t === gl.DRAW_FRAMEBUFFER) cur = f;
    return oB.call(gl, t, f);
  };
  const oP = gl.getParameter;
  gl.getParameter = (p) => (p === gl.FRAMEBUFFER_BINDING ? cur : oP.call(gl, p));
  const targets = [],
    oD = gl.drawArrays;
  gl.drawArrays = (...a) => {
    targets.push(cur === mine ? 'mine' : cur === null ? 'canvas' : 'other');
    return oD.apply(gl, a);
  };
  for (const t of [0.5, 0.5, 0.9]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, mine);
    targets.length = 0;
    R.drawInstance(b, { morphT: t });
    ok(
      cur === mine && targets.length > 0 && targets.at(-1) === 'mine',
      `morphT ${t}: the draw targets ${targets.at(-1)}, bound after: ${cur === mine ? 'mine' : 'other'}`,
    );
  }
  gl.drawArrays = oD;
  gl.bindFramebuffer = oB;
  gl.getParameter = oP;
}
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
