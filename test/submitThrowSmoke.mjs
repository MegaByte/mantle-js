// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// submitThrowSmoke -- a submitted draw that throws does not repaint its frame's list in the next frame.
//
// The flush swaps its queues. Recycling the drained one only after its loop would leave it, on a throw, in the spare queue; the next flush would make it the queue and its drain paint it,
// the entries already drawn included. CPU, driver-model stand-in.
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
const { gl, R } = await rig();
const B = await bundleOf(gl, svg('<rect x="10" y="10" width="20" height="20" fill="#c00"/>'));
const log = new Set();
let boom = true;
const T = (name, bad) => ({
  get bundle() {
    log.add(name);
    if (bad && boom) throw new Error('boom ' + name);
    return B;
  },
});
R.beginFrame([1, 1, 1, 1]);
R.submitBundle(T('one-A'));
R.submitBundle(T('one-BAD', true));
R.submitBundle(T('one-C'));
let threw = null;
try {
  R.endFrame();
} catch (e) {
  threw = e.message;
}
ok(threw === 'boom one-BAD', `the premise: the flush threw (${threw})`);
boom = false;
log.clear();
R.beginFrame([1, 1, 1, 1]);
R.submitBundle(T('two'));
R.endFrame();
ok([...log].join() === 'two', `the next frame draws its own list only (${[...log].join()})`);
log.clear();
R.beginFrame([1, 1, 1, 1]);
R.submitBundle(T('three'));
R.endFrame();
ok([...log].join() === 'three', `and the one after (${[...log].join()})`);
R.dispose();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
