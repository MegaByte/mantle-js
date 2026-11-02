// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// standInsPriorOwnerSmoke -- previous-variant reuse (standIns:false) only reuses a variant of this renderer.
//
// The record of the variant a bundle last drew with lives on the bundle, and a bundle outlives a renderer on its context. A later renderer that met a cold program and reused the record would bind a
// program the disposed renderer deleted: in GL that is an INVALID_OPERATION, and the draw then runs on whichever program is bound.
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
const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>',
  { preserveViewport: true },
);
const O = { asyncShaderCompile: true, nonBlocking: true, aacPoints: false, standIns: false };
async function mk(W) {
  const R = createRenderer(W.gl, taggedShaderSources(), O);
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(128, 128);
  return R;
}

console.log(
  "(renderer) a bundle that outlives its renderer: the next renderer does not bind the disposed one's program",
);
{
  const W = createPendingGl({ linkMs: 3, pipelineMs: 3 });
  const deleted = new Set(),
    dp = W.gl.deleteProgram;
  W.gl.deleteProgram = (p) => {
    deleted.add(p);
    return dp(p);
  };
  const R1 = await mk(W);
  R1.setFillEngine({ route: 'none', kernel: 'aac' });
  const b = createBundle(W.gl, sec);
  await R1.precompileFillsAsync({});
  for (let i = 0; i < 3; i++) {
    R1.beginFrame([1, 1, 1, 1]);
    R1.drawBundle(b);
    R1.endFrame();
    await sleep(3);
  }
  R1.dispose();
  await sleep(20);
  ok(deleted.size > 0, `the premise: the disposed renderer deleted its programs (${deleted.size})`);
  const R2 = await mk(W);
  R2.setFillEngine({ route: 'none', kernel: 'aac' });
  await R2.precompileFillsAsync({});
  R2.setFillEngine({ route: 'none', kernel: 'slug' }); // a program this renderer has not built, with the feature key of the one the bundle last drew with
  const used = [],
    up = W.gl.useProgram;
  W.gl.useProgram = (p) => {
    used.push(p);
    return up(p);
  };
  R2.beginFrame([1, 1, 1, 1]);
  R2.drawBundle(b);
  R2.endFrame();
  ok(used.length > 0, `the frame bound a program (${used.length})`);
  ok(!used.some((p) => deleted.has(p)), 'none of them is a deleted program');
  W.gl.useProgram = up;
  await sleep(10);
  R2.beginFrame([1, 1, 1, 1]);
  R2.drawBundle(b);
  R2.endFrame();
  R2.dispose();
}
console.log("(own record) the reuse rule still serves a renderer's own variant");
{
  const W = createPendingGl({ linkMs: 30, pipelineMs: 3 });
  const R = await mk(W);
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(W.gl, sec);
  await R.precompileFillsAsync({});
  for (let i = 0; i < 3; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
    await sleep(3);
  }
  const r0 = R.debugStats.needMiss.reuseDraws | 0;
  R.setFillEngine({ route: 'none', kernel: 'aac' });
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b);
  R.endFrame();
  ok(
    (R.debugStats.needMiss.reuseDraws | 0) > r0,
    `a kernel flip reuses the renderer's own previous variant (${(R.debugStats.needMiss.reuseDraws | 0) - r0} reuse draws)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
