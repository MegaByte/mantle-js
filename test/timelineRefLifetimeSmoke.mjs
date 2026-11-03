// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// timelineRefLifetimeSmoke -- a timeline's references on shared pair morphs survive a caller's array, a failed creation, and a label.
//
// dispose must not release through the caller's `bundles` array: emptied since, the map entry would outlive its disposed morph and the next timeline over those poses get a dead morph
// that draws nothing. A creation that throws on a later pair must release the references it took on the earlier pairs, or the morph outlives its last real user. And `debugLabel` on a pair
// morph has a setter, so naming it does not throw. CPU, driver-model stand-in.
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
const circ = (r) =>
  svg(
    `<path d="M${50 - r} 50 C${50 - r} ${50 - r} ${50 + r} ${50 - r} ${50 + r} 50 C${50 + r} ${50 + r} ${50 - r} ${50 + r} ${50 - r} 50Z" fill="#48c"/>`,
  );
const { gl } = await rig();
const K2 = [
    { time: 0, bundleIndex: 0 },
    { time: 1, bundleIndex: 1 },
  ],
  K3 = [...K2, { time: 2, bundleIndex: 2 }];
console.log('(array) a caller that empties its array');
{
  const c = await bundleOf(gl, circ(25)),
    d = await bundleOf(gl, circ(35));
  const poses = [c, d];
  const U = M.createShapeTimeline(gl, poses, K2);
  U.setTime(0.5);
  const um = U.currentMorph;
  poses.length = 0;
  U.dispose();
  const V = M.createShapeTimeline(gl, [c, d], K2);
  V.setTime(0.5);
  ok(
    V.currentMorph !== um && !V.bundle._disposed,
    'the next timeline over those poses gets a live morph',
  );
  V.dispose();
}
console.log('(failed creation) references taken before a throw are released');
{
  const a = await bundleOf(gl, circ(20)),
    b = await bundleOf(gl, circ(30));
  const p1 = await bundleOf(gl, svg('<rect id="p" x="0" y="0" width="10" height="10"/>')),
    p2 = await bundleOf(gl, svg('<circle id="q" cx="5" cy="5" r="5"/>'));
  const chained = M.createShapeMorph(gl, p1, p2);
  chained.setT(0.5);
  let threw = false;
  try {
    M.createShapeTimeline(gl, [a, b, chained.bundle], K3);
  } catch {
    threw = true;
  }
  ok(threw, 'the premise: the creation threw');
  const T = M.createShapeTimeline(gl, [a, b], K2);
  T.setTime(0.5);
  const mb = T.currentMorph.bundle;
  T.dispose();
  ok(!!mb._disposed, 'the morph is disposed with its last real user');
}
console.log('(label) a pair morph takes a name');
{
  const e = await bundleOf(gl, circ(26)),
    f = await bundleOf(gl, circ(36));
  const T = M.createShapeTimeline(gl, [e, f], K2);
  T.setTime(0.5);
  ok(/^pair:/.test(T.bundle.debugLabel), `its default name (${T.bundle.debugLabel})`);
  let err = null;
  try {
    T.bundle.debugLabel = 'train';
  } catch (x) {
    err = x;
  }
  ok(
    !err && T.bundle.debugLabel === 'train',
    `set by the app: ${err ? err.message.slice(0, 50) : T.bundle.debugLabel}`,
  );
  T.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
