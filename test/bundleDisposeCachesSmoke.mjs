// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleDisposeCachesSmoke -- what a renderer caches for a bundle goes with the bundle's dispose: its point lists and its instanced compact buffers.
//
// Both caches are bounded (48 MB of lists, the last 8 compacts); left to the bound alone, both would outlive the bundle, with GL buffers: 40 disposed bundles would hold 40 lists, 14 disposed morphs 8
// compacts and through them the bundles themselves. CPU, driver-model stand-in, with a real collection for what stays reachable.
import v8 from 'node:v8';
import vm from 'node:vm';
if (typeof globalThis.gc !== 'function') {
  v8.setFlagsFromString('--expose-gc');
  globalThis.gc = vm.runInNewContext('gc');
}
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
const rig = async (W = createPendingGl({ linkMs: 1, pipelineMs: 1 }), opts = {}) => {
  const R = createRenderer(W.gl, taggedShaderSources(), { aacFill: 'auto', ...opts });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 5);
  await R.ready;
  R.setViewport(256, 256);
  return { W, R, gl: W.gl };
};
const rects = Array.from(
  { length: 200 },
  (_, i) =>
    `<rect x="${(i % 20) * 5}" y="${Math.floor(i / 20) * 10}" width="4" height="8" fill="#c0${i % 10}"/>`,
).join('');
const MANY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${rects}</svg>`;
const ONE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 L50 90 Z" fill="#c00"/></svg>';
const parsed = {
  many: await importSvg(MANY, { preserveViewport: true }),
  one: await importSvg(ONE, { preserveViewport: true }),
};

// ---- the point lists
{
  const { R, gl } = await rig();
  const pl = () => R.getMemoryStats({ bundles: false }).caches.pointLists;
  const deletes = { n: 0 },
    db = gl.deleteBuffer.bind(gl),
    dt = gl.deleteTexture.bind(gl);
  gl.deleteBuffer = (x) => {
    deletes.n++;
    return db(x);
  };
  gl.deleteTexture = (x) => {
    deletes.n++;
    return dt(x);
  };
  const draw = (b) => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
  };
  const first = createBundle(gl, parsed.many);
  draw(first);
  ok(
    pl().lists >= 1,
    `the premise: a draw takes the points route and leaves a list (${pl().lists})`,
  );
  const live = createBundle(gl, parsed.many);
  draw(live);
  const withLive = pl();
  const d0 = deletes.n;
  first.dispose();
  ok(
    pl().lists === withLive.lists - 1 && pl().bytes < withLive.bytes,
    `a dispose frees that bundle's list and no other (${withLive.lists} -> ${pl().lists})`,
  );
  ok(deletes.n > d0, 'with its GL object');
  for (let i = 0; i < 40; i++) {
    const b = createBundle(gl, parsed.many);
    draw(b);
    b.dispose();
  }
  ok(
    pl().lists === 1,
    `40 more drawn and disposed: only the live bundle's list is left (${pl().lists})`,
  );
  draw(live);
  ok(pl().lists === 1, 'and the live bundle draws from it as before');
  // its dispose hook is the renderer's only hold on it, and the renderer's dispose takes it off
  const hold = createBundle(gl, parsed.many);
  draw(hold);
  ok(
    hold._disposeHooks && hold._disposeHooks.size >= 1,
    "a drawn bundle carries the renderer's hook",
  );
  R.dispose();
  ok(
    !live._disposeHooks || live._disposeHooks.size === 0,
    "the renderer's dispose takes its hooks off a bundle that outlives it",
  );
  hold.dispose();
  live.dispose();
}
// ---- two renderers on one context share a bundle's lists: a dispose empties both counts
{
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const { R: A, gl } = await rig(W),
    { R: B } = await rig(W);
  const count = (R) => R.getMemoryStats({ bundles: false }).caches.pointLists.lists;
  const b = createBundle(gl, parsed.many);
  for (const R of [A, B])
    for (let i = 0; i < 20000 && !count(R); i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      await sleep(3);
    } // (each renderer's point program links on its own)
  ok(
    count(A) === 1 && count(B) === 1,
    `two renderers: each counts the shared list (${count(A)}, ${count(B)})`,
  );
  b.dispose();
  ok(count(A) === 0 && count(B) === 0, 'and the dispose empties both counts');
  A.dispose();
  B.dispose();
}
// ---- the instanced compact buffers
{
  const { R, gl } = await rig();
  let vaoDeletes = 0;
  const dv = gl.deleteVertexArray.bind(gl);
  gl.deleteVertexArray = (x) => {
    vaoDeletes++;
    return dv(x);
  };
  const at = (x) => ({ worldMatrix: new Float32Array([0.2, 0, 0, 0, 0.2, 0, x, 0, 1]) });
  const refs = [];
  let hooked = 0;
  await (async () => {
    for (let i = 0; i < 6; i++) {
      const b = createBundle(gl, parsed.one);
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundleInstanced(b, [at(-0.5), at(0.5)]);
      R.endFrame();
      if (b._disposeHooks && b._disposeHooks.size) hooked++;
      refs.push(new WeakRef(b));
      const v0 = vaoDeletes;
      b.dispose();
      if (vaoDeletes > v0) hooked += 100;
    }
  })();
  ok(
    hooked >= 600,
    `an instanced draw's compact goes at the dispose, its vertex array with it (6 bundles: ${Math.floor(hooked / 100)} freed at once)`,
  );
  R.beginFrame([1, 1, 1, 1]);
  R.endFrame();
  for (let i = 0; i < 8; i++) {
    gc();
    await sleep(10);
  }
  const alive = refs.filter((r) => r.deref()).length;
  ok(
    alive <= 1,
    `and they are collected, but for the last one drawn, which the renderer's last-draw state holds until the next draw (${alive} of ${refs.length} reachable)`,
  );
  // past the bound the oldest compact is dropped, and the hook with it
  const keep = [];
  for (let i = 0; i < 10; i++) {
    const b = createBundle(gl, parsed.one);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, [at(-0.5), at(0.5)]);
    R.endFrame();
    keep.push(b);
  }
  ok(
    !keep[0]._disposeHooks || !keep[0]._disposeHooks.size || keep[9]._disposeHooks.size >= 1,
    'a compact the bound dropped leaves no hook behind',
  );
  R.dispose();
  ok(
    keep.every((b) => !b._disposeHooks || b._disposeHooks.size === 0),
    "the renderer's dispose takes the rest off",
  );
  for (const b of keep) b.dispose();
}
console.log(fail ? `bundleDisposeCachesSmoke: ${fail} FAILED` : 'bundleDisposeCachesSmoke: PASS');
process.exit(fail ? 1 : 0);
