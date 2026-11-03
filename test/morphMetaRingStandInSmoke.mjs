// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphMetaRingStandInSmoke -- a morph created while the lerp helper links keeps moving its meta plane once the helper is ready.
//
// A plane too big for the CPU path renders into the texture its framebuffer was built on, the ring's first. While the helper links, the CPU stand-in
// uploads to the ring's next texture and makes it live. A GPU pass that then writes the first texture writes one nothing samples: colors, stroke
// width and box would stay at the stand-in's pose for good. CPU, driver-model stand-in.
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
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${b}</svg>`;
const rows = (color, dx) =>
  Array.from(
    { length: 400 },
    (_, i) => `<rect id="r${i}" x="${i + dx}" y="${i}" width="5" height="5" fill="${color}"/>`,
  ).join('');
const W = createPendingGl({ hold: true, pipelineMs: 1 });
const gl = W.gl;
const R = createRenderer(gl, taggedShaderSources(), {
  aacFill: 'auto',
  asyncShaderCompile: true,
  nonBlocking: true,
  aacPoints: false,
});
R.ready.catch(() => {});
const attached = new Map();
let bound = null,
  lastTarget = null;
const fbt = gl.framebufferTexture2D,
  bf = gl.bindFramebuffer,
  da = gl.drawArrays;
gl.bindFramebuffer = (t, f) => {
  bound = f;
  return bf.call(gl, t, f);
};
gl.framebufferTexture2D = (t, a, tt, tex, l) => {
  attached.set(bound, tex);
  return fbt.call(gl, t, a, tt, tex, l);
};
gl.drawArrays = (...a) => {
  lastTarget = attached.get(bound);
  return da.apply(gl, a);
};
const A = createBundle(gl, await importSvg(svg(rows('#ff0000', 0)), { preserveViewport: true }));
const B = createBundle(gl, await importSvg(svg(rows('#0000ff', 10)), { preserveViewport: true }));
const morph = createShapeMorph(gl, A, B);
const ms = morph.bundle._morphSrc;
ok(
  morph.bundle._metaRing && morph.bundle.metaTex === morph.bundle._metaRing[1],
  'the premise: the CPU stand-in at creation rotated the live plane',
);
ok(
  (ms.lerpCpuStandIns | 0) > 0,
  `the premise: the helper was still linking (${ms.lerpCpuStandIns | 0} stand-ins)`,
);
W.release();
// The wait ends when a pose no longer needs a stand-in: the helper is ready.
for (let t = 0.25, before = -1; before !== (ms.lerpCpuStandIns | 0); t = 0.75 - t) {
  before = ms.lerpCpuStandIns | 0;
  await new Promise((r) => setTimeout(r, 5));
  morph.setT(t);
}
lastTarget = null;
morph.setT(0.75);
ok(!!lastTarget, 'a GPU pass drew');
ok(lastTarget === morph.bundle.metaTex, 'the meta pass wrote the live plane');
ok(
  morph.bundle.metaTex === morph.bundle._metaRing[0],
  "the live plane is back on the ring's first",
);
morph.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
