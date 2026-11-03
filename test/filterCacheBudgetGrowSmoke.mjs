// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterCacheBudgetGrowSmoke -- the filter cache's byte budget holds when entries GROW.
//
// Enforced only where an entry is stored, the budget and its hard ceiling miss a single-kind entry that grows (zoom in): it reallocates in place and is never stored again (190 MB accounted against
// a 25 MB ceiling). CPU, recording GL stand-in: what the cache's accounting and the texture allocations say.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const n = 24,
  cols = 6;
let shapes = '';
for (let i = 0; i < n; i++) {
  const x = 10 + (i % cols) * 14,
    y = 10 + Math.floor(i / cols) * 14;
  shapes += `<path d="M${x} ${y} L${x + 8} ${y} L${x + 8} ${y + 8} Z" fill="#d33" filter="url(#b)"/>`;
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b"><feGaussianBlur stdDeviation="0.5"/></filter></defs>${shapes}</svg>`;
const rig = async (budget, svg = SVG, SZ = 1024, more = {}) => {
  const F = createFakeGl({ width: SZ, height: SZ }),
    g = F.gl,
    gp = g.getParameter.bind(g);
  g.getParameter = (p) =>
    p === g.MAX_TEXTURE_SIZE || p === g.MAX_RENDERBUFFER_SIZE
      ? 16384
      : p === g.MAX_VIEWPORT_DIMS
        ? new Int32Array([16384, 16384])
        : gp(p); // (the stand-in answers no limits, and a filter frame reads them)
  const allocs = { n: 0, bytes: 0 },
    ti = g.texImage2D.bind(g);
  g.texImage2D = (...a) => {
    if (a[2] === g.RGBA8 && a[8] == null) {
      allocs.n++;
      allocs.bytes += a[3] * a[4] * 4;
    }
    return ti(...a);
  };
  const R = createRenderer(g, taggedShaderSources(), { filterCacheBytes: budget, ...more });
  R.setViewport(SZ, SZ);
  const b = createBundle(g, await importSvg(svg, { preserveViewport: true }));
  const h = R.createBundleHandle(b);
  const stats = () => R.getMemoryStats({ bundles: false }).caches.filterCache;
  const frame = (s) => {
    R.beginFrame([1, 1, 1, 1]);
    h.draw({ worldMatrix: new Float32Array([s, 0, 0, 0, s, 0, 0, 0, 1]) });
    R.endFrame();
  };
  return { R, stats, frame, allocs };
};

{
  const BUDGET = 8 << 20,
    HARD = 3 * BUDGET,
    { R, stats, frame } = await rig(BUDGET);
  frame(1);
  frame(1);
  const e1 = R.debugStats.filterEvalCount | 0,
    s1 = stats();
  ok(
    s1.bytes < BUDGET && s1.entries === n,
    `under the budget nothing is evicted: ${s1.entries} entries, ${s1.bytes} bytes`,
  );
  frame(1);
  ok((R.debugStats.filterEvalCount | 0) === e1, 'and a steady frame evaluates nothing');
  for (const z of [2, 4, 8, 16, 32]) {
    frame(z);
    frame(z);
    const st = stats();
    ok(
      st.accountedBytes <= HARD,
      `zoom ${z}: ${st.accountedBytes} bytes accounted, in ${st.entries} entries, against a ceiling of ${HARD}`,
    );
    ok(st.bytes === st.accountedBytes, `zoom ${z}: the accounting is the allocation (${st.bytes})`);
    ok(st.entries >= 1, `zoom ${z}: the entry in hand stays`);
  }
  frame(1);
  frame(1);
  const back = stats();
  ok(
    back.accountedBytes <= HARD && back.entries === n && back.accountedBytes < BUDGET,
    `back at zoom 1 they all fit again: ${back.entries} entries, ${back.accountedBytes} bytes`,
  );
  R.dispose();
}
{
  // The default budget, 64 MiB: the same scene at a zoom that fits keeps every entry through growth.
  const { R, stats, frame } = await rig(0);
  frame(1);
  frame(1);
  frame(2);
  frame(2);
  const e = R.debugStats.filterEvalCount | 0,
    st = stats();
  frame(2);
  ok(
    st.entries === n && (R.debugStats.filterEvalCount | 0) === e,
    `an entry that grows inside the budget evicts nothing (${st.entries} entries, ${st.accountedBytes} bytes), and the next frame is all hits`,
  );
  R.dispose();
}
{
  // A working set past the ceiling: the entries that fit stay resident. Evicting oldest-first missed every entry, every frame.
  const BUDGET = 8 << 20,
    HARD = 3 * BUDGET,
    { R, stats, frame } = await rig(BUDGET);
  let z = 2;
  for (; z <= 32; z *= 2) {
    frame(z);
    frame(z);
    if (stats().entries < n && stats().entries > 1) break;
  }
  const e0 = R.debugStats.filterEvalCount | 0;
  frame(z);
  frame(z);
  frame(z);
  const perFrame = ((R.debugStats.filterEvalCount | 0) - e0) / 3,
    st = stats();
  ok(
    z <= 32 && st.entries > 1 && st.accountedBytes <= HARD,
    `zoom ${z}: past the ceiling, ${st.entries} entries stay in ${st.accountedBytes} bytes against ${HARD}`,
  );
  ok(
    perFrame < n - st.entries / 2,
    `and they serve the next frame: ${perFrame.toFixed(1)} of ${n} evaluate per frame`,
  );
  R.dispose();
}
// A store that cannot stay allocates nothing. Allocating a texture, copying into it and being pushed out by the next store, for every entry past the ceiling, every frame, would cost 20 to 24
// textures a frame here, 39 to 314 MiB, and 9 a frame for a filter graph. Every route composites from the target it evaluated in, so nothing needs that copy.
for (const [title, filter] of [
  ['a single-kind blur', '<feGaussianBlur stdDeviation="0.5"/>'],
  [
    'a filter graph',
    '<feGaussianBlur stdDeviation="6" result="r"/><feOffset dx="9" dy="9"/><feMerge><feMergeNode/><feMergeNode in="r"/></feMerge>',
  ],
]) {
  const BUDGET = 8 << 20,
    HARD = 3 * BUDGET,
    { R, stats, frame, allocs } = await rig(
      BUDGET,
      SVG.replace('<feGaussianBlur stdDeviation="0.5"/>', filter),
    );
  let z = 2;
  for (; z <= 64; z *= 2) {
    frame(z);
    frame(z);
    if (stats().entries < n && stats().entries > 1) break;
  }
  frame(z);
  const a0 = allocs.n,
    b0 = allocs.bytes,
    e0 = R.debugStats.filterEvalCount | 0;
  frame(z);
  frame(z);
  frame(z);
  frame(z);
  const st = stats(),
    evals = ((R.debugStats.filterEvalCount | 0) - e0) / 4;
  ok(
    z <= 64 && st.entries > 1 && st.accountedBytes <= HARD,
    `${title} at zoom ${z}: past the ceiling, ${st.entries} of ${n} entries stay in ${st.accountedBytes} bytes against ${HARD}`,
  );
  ok(evals === n - st.entries, `${title}: exactly the rest re-evaluate: ${evals} a frame`);
  ok(
    allocs.n === a0,
    `${title}: and the steady frames allocate nothing: ${(allocs.n - a0) / 4} textures a frame, ${allocs.bytes - b0} bytes in 4 frames`,
  );
  R.dispose();
}
{
  // A lone entry has nothing to push out: it stays past the ceiling and serves the next frame.
  const big =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.5"/></filter></defs><path d="M2 2 L98 2 L98 98 Z" fill="#d33" filter="url(#b)"/></svg>';
  const { R, stats, frame } = await rig(4 << 20, big, 2048);
  frame(1);
  frame(1);
  const e0 = R.debugStats.filterEvalCount | 0,
    st = stats();
  frame(1);
  ok(
    st.entries === 1 &&
      st.accountedBytes > 3 * (4 << 20) &&
      (R.debugStats.filterEvalCount | 0) === e0,
    `one entry of ${st.accountedBytes} bytes against a ceiling of ${3 * (4 << 20)} stays and is served`,
  );
  R.dispose();
}
{
  // A static scene stores once, so a store count never reaches an entry that stopped moving. A result that kept a zoom's texture is given back after the idle window, inside the budget too,
  // with no filter run. A scene under the budget, so only the idle trim can do it.
  const { R, stats, frame } = await rig(64 << 20, SVG, 1024, { filterPoolIdleMs: 20 });
  frame(1);
  frame(1);
  const small = stats().accountedBytes;
  frame(8);
  frame(8);
  frame(1);
  frame(1);
  const zoomedOut = stats(),
    e0 = R.debugStats.filterEvalCount | 0;
  ok(
    zoomedOut.entries === n && zoomedOut.accountedBytes > 2 * small,
    `the premise: back at zoom 1, under the budget, the results keep the zoom's textures (${zoomedOut.accountedBytes} bytes, ${small} at the start)`,
  );
  const until = performance.now() + 60;
  while (performance.now() < until) {
    /* the idle window */
  }
  for (let f = 0; f < n + 2; f++) frame(1);
  const st = stats();
  ok(
    st.entries === n && st.accountedBytes <= 2 * small,
    `after the idle window they are their own size again (${st.accountedBytes} bytes, ${small} at the start)`,
  );
  ok(st.bytes === st.accountedBytes, `and the accounting is the allocation (${st.bytes})`);
  ok(
    (R.debugStats.filterEvalCount | 0) === e0,
    'and no filter ran for it: every one of those frames was hits',
  );
  frame(1);
  ok(!R._resultsOversized, 'with nothing oversized left, the trim stops looking');
  R.dispose();
}
{
  // A result that moves within its texture is not idle: it stores every frame, and nothing is taken from it.
  const { R, stats, frame } = await rig(64 << 20, SVG, 1024, { filterPoolIdleMs: 1e6 });
  frame(1);
  frame(8);
  frame(8);
  frame(1);
  frame(1);
  const st = stats();
  frame(1);
  ok(
    stats().accountedBytes === st.accountedBytes,
    `inside the idle window the texture stays (${st.accountedBytes} bytes)`,
  );
  R.dispose();
}
console.log(
  fail ? `filterCacheBudgetGrowSmoke: ${fail} FAILED` : 'filterCacheBudgetGrowSmoke: PASS',
);
process.exit(fail ? 1 : 0);
