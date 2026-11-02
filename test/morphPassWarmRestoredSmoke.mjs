// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphPassWarmRestoredSmoke -- a restored context's renderer warms the morph helper passes again.
//
// A record of "warmed" keyed by the gl object, which survives a context loss, would keep the restored context's new renderer from linking or building the lerp and fixup passes
// behind its loading screen, and its first setT would do both in play. CPU, driver-model stand-in.
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
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const rig = async (opts = {}, W = createPendingGl({ linkMs: 1, pipelineMs: 1 })) => {
  const R = createRenderer(W.gl, taggedShaderSources(), { aacFill: 'auto', ...opts });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 5);
  await R.ready;
  R.setViewport(256, 256);
  return { W, R, gl: W.gl };
};
const bundleOf = async (gl, s, o = { preserveViewport: true }) =>
  createBundle(gl, await importSvg(s, o));
const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
let lerp = 0;
const ss = W.gl.shaderSource;
W.gl.shaderSource = (sh, src) => {
  if (src.includes('mix(texelFetch(uA, p, 0), texelFetch(uB, p, 0), uT)')) lerp++;
  return ss.call(W.gl, sh, src);
};
const OPTS = { asyncShaderCompile: true, nonBlocking: true, strictPlay: true, aacPoints: false };
const { R } = await rig(OPTS, W);
await R.precompileFillsAsync({});
ok(lerp > 0, `the premise: the first context's loading call compiled the lerp pass (${lerp})`);
W.F.loseContext();
W.F.restoreContext();
R.dispose();
lerp = 0;
const { R: R2 } = await rig(OPTS, W);
await R2.precompileFillsAsync({});
ok(lerp > 0, `the restored context's loading call compiled it again (${lerp})`);
R2.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
