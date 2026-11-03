// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmKeepsBindingSmoke -- `renderer.setBundle(a)` stays bound through a frame's warm tick and a loading call: a `render()` with no target draws `a`.
//
// A pipeline warm draws through setBundle. Only a standalone render() put the caller's binding back after its tick, so the tick of a beginFrame, or a loading call, left the last warmed bundle bound
// and the next bare render() drew that one, for good.
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
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const SRC = [
  doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
  doc(
    '<path d="M10 10 Q 60 0 80 90 Z" fill="url(#g)"/><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>',
  ),
  doc('<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6"/>'),
];
const secs = await Promise.all(SRC.map((s) => importSvg(s, { preserveViewport: true })));
/// Records which bundle's curve texture is on unit 0 at each draw.
function bound(W, bundles) {
  const log = [];
  let cur = -1,
    unit = 0;
  const at = W.gl.activeTexture;
  W.gl.activeTexture = (u) => {
    unit = u - W.gl.TEXTURE0;
    return at(u);
  };
  const bt = W.gl.bindTexture;
  W.gl.bindTexture = (t, x) => {
    if (unit === 0 && t === W.gl.TEXTURE_2D) cur = bundles.findIndex((b) => b.curveTex === x);
    return bt(t, x);
  };
  for (const n of ['drawArrays', 'drawArraysInstanced']) {
    const d = W.gl[n];
    W.gl[n] = (...r) => {
      log.push(cur);
      return d(...r);
    };
  }
  return log;
}
async function mk(O) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), { aacPoints: false, ...O });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(256, 256);
  const bs = secs.map((s) => createBundle(W.gl, s));
  return { W, R, bs };
}
const POLICIES = [
  ['default', { asyncShaderCompile: true, nonBlocking: true }],
  ['blocking', { asyncShaderCompile: true }],
  ['stand-in-free', { asyncShaderCompile: true, nonBlocking: true, standIns: false }],
];
console.log('(loading call) the binding made before it holds after it');
for (const [name, O] of POLICIES)
  for (const pick of [0, 1, 2]) {
    const { W, R, bs } = await mk(O);
    const log = bound(W, bs);
    R.setBundle(bs[pick]);
    await R.precompileFillsAsync({});
    log.length = 0;
    R.render();
    ok(
      log.at(-1) === pick,
      `${name}, bundle ${pick}: render() drew it after precompileFillsAsync (${log.at(-1)})`,
    );
    R.dispose();
  }
for (const pick of [0, 1, 2]) {
  const { W, R, bs } = await mk({ asyncShaderCompile: true });
  const log = bound(W, bs);
  R.setBundle(bs[pick]);
  R.precompileFills({});
  log.length = 0;
  R.render();
  ok(log.at(-1) === pick, `bundle ${pick}: render() drew it after precompileFills (${log.at(-1)})`);
  R.dispose();
}
console.log('(frame) the tick of a beginFrame, with warms still queued');
for (const [name, O] of POLICIES.slice(0, 2))
  for (const pick of [0, 1, 2]) {
    const { W, R, bs } = await mk({ ...O, psoWarmIdle: () => true });
    R.setBundle(bs[pick]);
    const log = bound(W, bs);
    let wrong = 0,
      frames = 0;
    for (let i = 0; i < 40; i++) {
      R.beginFrame([1, 1, 1, 1]);
      log.length = 0;
      R.render();
      R.endFrame();
      if (log.length) {
        frames++;
        if (log.at(-1) !== pick) wrong++;
      } // (the last draw is the fill: a depth prepass binds no curve texture of its own)
      await sleep(1);
    }
    ok(
      frames > 0 && wrong === 0,
      `${name}, bundle ${pick}: ${wrong} of ${frames} frames drew another bundle`,
    );
    R.dispose();
  }
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
