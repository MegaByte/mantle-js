// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pointListMemorySmoke -- the points route keeps no CPU copy of its point lists, and their GPU buffers stay inside aacPointsBufferBudget.
//
// The lists (one point per covered pixel per row, 8 bytes each) are built on the CPU and uploaded. Keeping the arrays (a GPU buffer cache keyed by
// them, bundle caches holding them) would keep every list twice across many bundles at changing scales, hundreds of MB in a large scene. A list
// is a handle (count, GPU buffer, how to build it); the array lives only between its
// build and its upload, and a buffer the budget evicted is rebuilt from the row counts at the next draw.
// CPU, driver-model stand-in (test/_pendingGl.mjs).
// (the retention check needs gc(); the lane runs node without --expose-gc, so it is enabled here)
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
// every Uint16Array / Uint32Array made while the scenes draw (the point lists and tables), watched through WeakRefs: what survives collection is kept
let watch = null;
for (const name of ['Uint16Array', 'Uint32Array']) {
  // (the list path builds Uint16 points; generated points build a Uint32 entry table)
  const C = globalThis[name];
  globalThis[name] = new Proxy(C, {
    construct(t, a, nt) {
      const o = Reflect.construct(t, a, nt);
      if (watch && o.byteLength >= 64) watch.push(new WeakRef(o));
      return o;
    },
  });
}

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const dots = (seed) => {
  let b = '';
  for (let i = 0; i < 30; i++) {
    const x = ((i * 37 + seed * 11) % 90) + 5,
      y = ((i * 53 + seed * 7) % 90) + 5;
    const r = 1.5 + (i % 3);
    b += `<path d="M${x - r} ${y + r} L${x} ${y - r} L${x + r} ${y + r} Z" fill="#${(seed * 40 + i * 7).toString(16).padStart(3, '0').slice(-3)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
};

async function session(budget) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    aacFill: 'auto',
    ...(budget != null ? { aacPointsBufferBudget: budget } : {}),
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 5);
  await R.ready;
  R.setViewport(512, 512);
  const bundles = [];
  for (let k = 0; k < 20; k++)
    bundles.push(createBundle(W.gl, await importSvg(dots(k), { preserveViewport: true })));
  // (one frame and a pause first: the point program links on its first ask, and a draw before that takes the cover route in either run)
  R.beginFrame([1, 1, 1, 1]);
  for (const b of bundles) R.drawBundle(b);
  R.endFrame();
  await new Promise((r) => setTimeout(r, 30));
  const draws0 = (R.debugStats.pointsStats || {}).draws | 0,
    builds0 = (R.debugStats.pointsStats || {}).builds | 0;
  watch = [];
  let gpuPeak = 0;
  for (let step = 0; step < 10; step++) {
    const sc = 0.4 + step * 0.17;
    const wm = new Float32Array([sc, 0, 0, 0, sc, 0, 0, 0, 1]);
    for (let rep = 0; rep < 2; rep++) {
      R.beginFrame([1, 1, 1, 1]);
      for (const b of bundles) R.drawBundle(b, { worldMatrix: wm });
      R.endFrame();
    }
    const pl = R.getMemoryStats({ bundles: false }).caches.pointLists;
    if (pl.bytes > gpuPeak) gpuPeak = pl.bytes;
  }
  const made = watch.length;
  watch = watch.slice();
  const ws = watch;
  watch = null;
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    global.gc();
  }
  const kept = ws.filter((w) => w.deref() !== undefined).length;
  const st = R.debugStats.pointsStats || {};
  const out = {
    draws: (st.draws | 0) - draws0,
    builds: (st.builds | 0) - builds0,
    points: st.builtPoints | 0,
    gpuPeak,
    made,
    kept,
  };
  if (!(st.draws > 0)) console.log('  (points route declined:', R.debugStats.pointsGateWhy, ')');
  R.dispose();
  return out;
}
console.log(
  '(point lists) 20 bundles x 10 scales: no CPU copy of any list is kept, the GPU buffers stay in budget, and the points route keeps drawing',
);
const big = await session(null);
ok(
  big.draws > 0 && big.builds > 0,
  `the points route drew (${big.draws} draws, ${big.builds} list builds, ${big.points} points)`,
);
ok(
  big.made > 0 && big.kept === 0,
  `no list array outlives its upload (${big.kept} of ${big.made} kept after collection)`,
);
const BUD = 1; // (one byte: every upload evicts the rest, so every reuse rebuilds -- the path a tight budget takes, whatever a list weighs)
const small = await session(BUD);
ok(
  small.draws === big.draws,
  `with a one-byte GPU budget, every draw still went through the points route (${small.draws} draws)`,
);
ok(
  small.gpuPeak < big.gpuPeak,
  `the budget held the GPU side to the newest list (${small.gpuPeak} bytes at most, against ${big.gpuPeak} unbounded)`,
);
ok(
  small.builds > big.builds,
  `evicted buffers were rebuilt from their row counts (${small.builds} builds against ${big.builds})`,
);
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
