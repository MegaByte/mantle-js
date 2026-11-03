// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskStandInNotStampedSmoke -- a rotated mask bake drawn by the axis-aligned program while its own program links is not kept.
//
// No draw waits for a link, so for those frames a rotated bake takes the general program, whose footprint is the axis-aligned one. The slot must not be stamped valid for
// that bake, or the wrong bake stays for good once the rotated program is ready. Non-strict renderers only: strict play has the rotated all-types net. CPU, driver-model stand-in: which program baked, and when.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const masked = (child) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><mask id="m">${child}</mask></defs><rect width="100" height="100" fill="#28f" mask="url(#m)"/></svg>`;
const ALL = masked(
  '<path d="M10 10 L50 10 Q60 20 70 10 C80 30 90 40 90 90 A 20 20 0 0 1 10 90 Z" fill="#fff"/><rect x="30" y="30" width="10" height="10" fill="#000"/>',
); // every segment type: bakes with the general program
const LEAN = masked(
  '<path d="M10 10 L90 10 L90 90 L10 90 Z" fill="#fff"/><path d="M30 30 L40 30 L40 40 L30 40 Z" fill="#000"/>',
); // lines only: a typed program

const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
const R = createRenderer(W.gl, taggedShaderSources(), {
  asyncShaderCompile: true,
  nonBlocking: true,
  aacPoints: false,
  gpuShedMs: Infinity,
  psoWarm: true,
});
R.ready.catch(() => {});
setTimeout(() => W.release(), 5);
await R.ready;
R.setViewport(256, 256);
const F = W.F;
const a = createBundle(W.gl, await importSvg(ALL, { preserveViewport: true }));
const b = createBundle(W.gl, await importSvg(LEAN, { preserveViewport: true }));
for (let i = 0; i < 30; i++) {
  await sleep(1);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(a);
  R.endFrame();
}
const standIns = () => R.debugStats.maskBakeStandIns | 0;
ok(standIns() === 0, 'the premise: an axis-aligned bake uses no stand-in');
const c = Math.cos(0.5),
  s = Math.sin(0.5),
  WM = new Float32Array([c * 0.5, s * 0.5, 0, -s * 0.5, c * 0.5, 0, 0, 0, 1]);
const bakes = () => F.log.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('maskBakeFrag'));
const general = bakes()[0]?.prog;
W.hold();
const n0 = bakes().length;
for (let i = 0; i < 6; i++) {
  await sleep(1);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { worldMatrix: WM });
  R.endFrame();
}
const during = bakes().slice(n0);
ok(
  standIns() >= 1 && during.length > 0 && during.every((e) => e.prog === general),
  `the rotated program links: the general one stands in (${standIns()} stand-ins, ${during.length} draws)`,
);
W.release();
await sleep(20);
const n1 = bakes().length;
const frames = [];
for (let i = 0; i < 40; i++) {
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { worldMatrix: WM });
  R.endFrame();
  frames.push(bakes().length);
  await sleep(1);
}
const after = bakes().slice(n1);
ok(after.length > 0, `the rotated program ready: the bake runs again (${after.length} draws)`);
ok(after.length > 0 && after[after.length - 1].prog !== general, 'by the rotated program');
ok(
  frames[frames.length - 1] === frames[frames.length - 11],
  'and once it is right it is kept: the last 10 frames bake nothing',
);
R.dispose();
console.log(
  fail ? `maskStandInNotStampedSmoke: ${fail} FAILED` : 'maskStandInNotStampedSmoke: PASS',
);
process.exit(fail ? 1 : 0);
