// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// memoryBudgetSmoke -- the scene memory budget: createRenderer({ memoryBudgetBytes }) / setMemoryBudget, the eviction ORDER (filter cache, idle
// pools, point lists, group atlas), the rule that nothing the current frame used is evicted, refusal of optional resources (Loop-Blinn meshes,
// CPatch planes, static-cache rasters, the group atlas) with one warning each, the budget respected at every frame end when the essential
// set fits, dispose returning the memory ledger to zero, and the preparation brackets (createBundle, createShapeMorph, importSvg).
// Headless on test/_fakeGl.mjs; the render lane draws a budget-limited scene on the GPU (memoryBudgetRenderSmoke).
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer, createShapeMorph, CacheStrategy } =
  await import('../src/index.js');

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => {
  warnings.push(a.join(' '));
};
const memWarnings = () => warnings.filter((w) => /memory budget/.test(w));

const N = 96;
const REGION = 'x="-50%" y="-50%" width="200%" height="200%"';
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs><filter id="b" ${REGION}><feGaussianBlur stdDeviation="2"/></filter></defs>${body}</svg>`;
const blurred = (cx, cy, fill) =>
  svg(`<circle cx="${cx}" cy="${cy}" r="20" fill="${fill}" filter="url(#b)"/>`);
const GROUPS = svg(
  '<g opacity="0.5"><rect x="5" y="5" width="50" height="50" fill="#f00"/><circle cx="50" cy="50" r="20" fill="#00f"/></g>' +
    '<g opacity="0.7"><rect x="30" y="30" width="50" height="50" fill="#0f0"/><circle cx="20" cy="70" r="15" fill="#00f"/></g>',
);
const BLOBS = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) & 0x7fffffff) / 2147483647;
  let body = '';
  for (let i = 0; i < 60; i++) {
    const cx = 10 + rnd() * 76,
      cy = 10 + rnd() * 76,
      r = 3 + rnd() * 8;
    let d = `M${cx + r} ${cy}`;
    for (let j = 1; j <= 6; j++) {
      const a = (j / 6) * Math.PI * 2,
        rr = r * (0.6 + rnd() * 0.8);
      d += `C${cx + Math.cos(a - 0.3) * rr} ${cy + Math.sin(a - 0.3) * rr} ${cx + Math.cos(a - 0.1) * rr} ${cy + Math.sin(a - 0.1) * rr} ${cx + Math.cos(a) * rr} ${cy + Math.sin(a) * rr}`;
    }
    body += `<path d="${d}Z" fill="#${Math.floor(rnd() * 0xffffff)
      .toString(16)
      .padStart(6, '0')}"/>`;
  }
  return svg(body);
})();

async function make(opts = {}) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), opts);
  R.setViewport(N, N);
  const bundle = async (text, extra = {}) =>
    createBundle(F.gl, await importSvg(text, { preserveViewport: true, ...extra }));
  const frame = (i, ...bs) => {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    for (const b of bs) R.drawBundle(b);
    R.endFrame();
  };
  const emptyFrame = () => {
    R.beginFrame([0, 0, 0, 0]);
    R.endFrame();
  };
  return { F, R, bundle, frame, emptyFrame };
}
const cat = (R, c) => {
  const e = R.getMemoryStats().gpu.byCategory[c];
  return e ? e.bytes : 0;
};

{
  console.log('\n  option and API validation:');
  const { F } = await make();
  for (const bad of [-1, NaN, 'big', {}, true]) {
    let threw = false;
    try {
      createRenderer(F.gl, taggedShaderSources(), { memoryBudgetBytes: bad });
    } catch (e) {
      threw = /memoryBudgetBytes/.test(e.message);
    }
    ok(
      threw,
      `createRenderer({ memoryBudgetBytes: ${JSON.stringify(bad)} }) throws naming the option`,
    );
  }
  const R1 = createRenderer(F.gl, taggedShaderSources(), { memoryBudgetBytes: 12345678 });
  ok(
    R1.getMemoryBudget() === 12345678 && R1.getMemoryStats().budgetBytes === 12345678,
    'the creation option sets the budget',
  );
  R1.setMemoryBudget(null);
  ok(R1.getMemoryBudget() === Infinity, 'setMemoryBudget(null) removes it');
  let threw = false;
  try {
    R1.setMemoryBudget(-5);
  } catch {
    threw = true;
  }
  ok(threw, 'setMemoryBudget(-5) throws');
  const R0 = createRenderer(F.gl, taggedShaderSources(), {});
  ok(R0.getMemoryBudget() === Infinity, 'the default is no budget (no behavior change)');
  R0.dispose();
  R1.dispose();
}

{
  console.log('\n  eviction order, and nothing in use is evicted:');
  const { F, R, bundle, frame, emptyFrame } = await make();
  const A = await bundle(blurred(30, 30, '#00f')),
    B = await bundle(blurred(60, 60, '#0a0'));
  frame(1, A);
  frame(2, B);
  let s = R.getMemoryStats();
  const T = s.gpu.totalBytes,
    fcEntries = s.caches.filterCache.entries,
    fcBytes = s.caches.filterCache.bytes;
  ok(
    fcEntries === 2 && fcBytes > 0 && cat(R, 'pool') > 0,
    `two filter results (${fcBytes} B) and scratch targets (${cat(R, 'pool')} B) are resident`,
  );
  // A deficit of one byte: the oldest filter result goes (it is not the current frame's), nothing after it is touched.
  const poolBefore = cat(R, 'pool');
  void poolBefore;
  R.setMemoryBudget(T - 1);
  s = R.getMemoryStats();
  ok(
    s.caches.filterCache.entries === 1,
    `deficit 1 B: the older filter result is evicted, the current frame's stays (${s.caches.filterCache.entries} entries)`,
  );
  ok(s.gpu.totalBytes <= T - 1, `  the total fits the budget (${s.gpu.totalBytes} <= ${T - 1})`);
  ok(
    !s.policy.evictions.pools && cat(R, 'pool') === poolBefore,
    '  idle pools were not touched (the first stage was enough)',
  );
  // Inside an OPEN frame everything it drew is in use: a budget of 1 byte evicts nothing and reports the excess.
  // (A's result was evicted above, so drawing A in an open frame recomputes it: its result and the scratch targets are what frame 3 uses.)
  R.setMemoryBudget(null);
  F.setFrame(3);
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(A);
  const poolInFrame = cat(R, 'pool');
  R.setMemoryBudget(1);
  s = R.getMemoryStats();
  ok(
    s.caches.filterCache.entries === 1 && cat(R, 'pool') === poolInFrame && poolInFrame > 0,
    `budget 1 B inside an open frame: the filter result and scratch targets that frame used are NOT evicted, the stale result (frame 2) is (${s.caches.filterCache.entries} entry, pool ${cat(R, 'pool')} B)`,
  );
  ok(
    s.policy.overBudgetBytes === s.gpu.totalBytes - 1 && s.policy.overBudgetBytes > 0,
    `  the excess is reported (overBudgetBytes ${s.policy.overBudgetBytes})`,
  );
  R.endFrame();
  s = R.getMemoryStats();
  ok(
    s.caches.filterCache.entries === 1 && cat(R, 'pool') === poolInFrame,
    "  and the endFrame safe point keeps the frame just drawn (it is the next frame's working set)",
  );
  ok(memWarnings().length === 1, `  warned about once (${memWarnings().length})`);
  R.setMemoryBudget(null);
  // Frames pass without drawing: everything cached is now stale. A deficit larger than the filter cache reaches the pools next, in order.
  emptyFrame();
  emptyFrame();
  s = R.getMemoryStats();
  const T2 = s.gpu.totalBytes,
    fcNow = s.caches.filterCache.bytes,
    poolNow = cat(R, 'pool');
  R.setMemoryBudget(T2 - fcNow - 1);
  s = R.getMemoryStats();
  ok(
    s.policy.evictions.filterCache && s.caches.filterCache.entries === 0,
    'stale: the filter cache is emptied first',
  );
  ok(
    s.policy.evictions.pools && cat(R, 'pool') < poolNow,
    `  then the pools give up bytes (${poolNow} -> ${cat(R, 'pool')})`,
  );
  ok(
    !s.policy.evictions.pointLists && !s.policy.evictions.atlas,
    '  and the later stages are not reached',
  );
  ok(s.gpu.totalBytes <= T2 - fcNow - 1, `  the budget holds (${s.gpu.totalBytes})`);
  R.setMemoryBudget(1);
  s = R.getMemoryStats();
  ok(
    cat(R, 'pool') === 0 && cat(R, 'filterCache') === 0,
    'budget 1 B with nothing in use: every cache is gone',
  );
  ok(cat(R, 'bundle') > 0 && cat(R, 'core') > 0, '  bundles and core resources are never evicted');
  // The scene still draws: caches refill on demand (the budget is advisory for essential work).
  const drawsBefore = R.debugStats.filterEvalCount | 0;
  frame(10, A, B);
  ok(
    (R.debugStats.filterEvalCount | 0) > drawsBefore,
    'the filtered shapes draw again after eviction (the results are recomputed)',
  );
  R.dispose();
}

{
  console.log(
    '\n  the group atlas: refused when it does not fit, evicted last, never while in use:',
  );
  const { F, R, bundle, frame, emptyFrame } = await make();
  R.setFillEngine({ route: 'lb', kernel: 'slug' });
  const G = await bundle(GROUPS);
  for (let i = 1; i < 4; i++) frame(i, G);
  let s = R.getMemoryStats();
  ok(
    s.caches.atlas.bytes === 2048 * 2048 * 8,
    `unbudgeted: the atlas target is resident (${s.caches.atlas.bytes} B = 2048 x 2048 x 8)`,
  );
  F.setFrame(4);
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(G);
  R.setMemoryBudget(1);
  ok(
    R.getMemoryStats().caches.atlas.bytes > 0,
    'budget 1 B inside the frame that used it: the atlas stays (in use by the current frame)',
  );
  R.endFrame();
  ok(
    R.getMemoryStats().caches.atlas.bytes > 0,
    "  and at that frame's endFrame (the working set of the next frame)",
  );
  emptyFrame();
  s = R.getMemoryStats();
  ok(
    s.caches.atlas.bytes === 0 &&
      s.policy.evictions.atlas &&
      s.policy.evictions.atlas.bytes === 2048 * 2048 * 8,
    'a frame later it is idle and the endFrame safe point evicts it',
  );
  warnings.length = 0;
  for (let i = 20; i < 24; i++) frame(i, G);
  s = R.getMemoryStats();
  ok(
    s.caches.atlas.bytes === 0 &&
      s.policy.refusals['group atlas'] &&
      s.policy.refusals['group atlas'].count > 0,
    'under the budget the atlas is refused (the groups take their own accumulators)',
  );
  ok(memWarnings().filter((w) => /group atlas/.test(w)).length === 1, '  with one warning');
  ok(cat(R, 'frameTargets') > 0 || cat(R, 'pool') > 0, '  and the scene still drew');
  R.dispose();
}

{
  console.log('\n  optional preparation is refused with a warning, not allocated past the budget:');
  for (const route of ['lb', 'cpatch']) {
    const { F, R, frame } = await make();
    R.setFillEngine({ route, kernel: 'slug' });
    const sections = await importSvg(BLOBS, { preserveViewport: true });
    const b = createBundle(F.gl, sections); // no await between this and the budget: the deferred LB build has not run
    const base = R.getMemoryStats().gpu.totalBytes;
    R.setMemoryBudget(base + 4096);
    warnings.length = 0;
    const prepared = R.prepareBundle(b);
    // The LB build is a deferred one, refused again when it runs. The CPatch plane is built (here: refused) inside prepareBundle, and a refused bundle never
    // settles, so awaiting it would only run out the timeout.
    if (route === 'lb')
      try {
        await R.awaitLbReady(b, 5000);
      } catch {
        /* the refusal is what is asserted */
      }
    for (let i = 1; i < 4; i++) frame(i, b);
    const s = R.getMemoryStats();
    const name = route === 'lb' ? 'loopBlinn mesh' : 'CPatch plane';
    ok(prepared === false, `route ${route}: prepareBundle reports false (nothing prepared)`);
    ok(
      s.policy.refusals[name] && s.policy.refusals[name].count >= 1,
      `route ${route}: ${name} refusal recorded (${JSON.stringify(s.policy.refusals[name])})`,
    );
    ok(
      memWarnings().filter((w) => w.includes(name)).length === 1,
      `route ${route}: exactly one warning names it`,
    );
    ok(
      memWarnings().some(
        (w) =>
          w.includes(name) && w.includes('cover/Slug fallback') && w.includes('explicitly pinned'),
      ),
      `route ${route}: the warning explains the pinned-engine fallback`,
    );
    ok(
      cat(R, 'bundle') === base - cat(R, 'core') - cat(R, 'coverGeometry') ||
        s.gpu.byCategory.bundle.bytes <= base,
      `route ${route}: the bundle's own textures did not grow`,
    );
    // Unbudgeted control: the same bundle prepares.
    const c = await make();
    c.R.setFillEngine({ route, kernel: 'slug' });
    const b2 = await c.bundle(BLOBS);
    c.R.prepareBundle(b2);
    try {
      await c.R.awaitLbReady(b2, 5000);
    } catch {
      /* ignore */
    }
    ok(
      Object.keys(c.R.getMemoryStats().policy.refusals).length === 0,
      `route ${route}: no budget, no refusal (control)`,
    );
    R.dispose();
    c.R.dispose();
  }
  // A static-cache raster is optional too: refused, the bundle draws live.
  const { R, bundle } = await make();
  const A = await bundle(
    svg(
      '<circle cx="30" cy="30" r="20" fill="#00f"/><rect x="40" y="40" width="30" height="30" fill="#f00"/>',
    ),
  );
  R.setBundle(A);
  R.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
  R.setMemoryBudget(R.getMemoryStats().gpu.totalBytes + 1000);
  warnings.length = 0;
  for (let i = 0; i < 3; i++) R.render();
  let s = R.getMemoryStats();
  ok(
    s.policy.refusals['static-cache raster'] && cat(R, 'staticCache') === 0,
    'a static-cache raster that does not fit is refused (the bundle draws live)',
  );
  R.setMemoryBudget(null);
  for (let i = 0; i < 3; i++) R.render();
  ok(cat(R, 'staticCache') > 0, '  and with the budget lifted it bakes');
  R.dispose();
}

{
  console.log('\n  the budget is respected at every frame end when the essential set fits:');
  const { R, bundle, frame } = await make();
  const bs = [
    await bundle(blurred(30, 30, '#00f')),
    await bundle(blurred(60, 60, '#0a0')),
    await bundle(BLOBS),
    await bundle(GROUPS),
  ];
  for (let i = 0; i < 3; i++) frame(i, ...bs); // warm: the unbudgeted working set
  const warm = R.getMemoryStats().gpu.totalBytes;
  const essential = cat(R, 'bundle') + cat(R, 'core') + cat(R, 'coverGeometry');
  const budget = essential + Math.floor((warm - essential) / 4);
  R.setMemoryBudget(budget);
  let worst = 0,
    over = 0;
  R.resetMemoryPeaks();
  for (let i = 10; i < 30; i++) {
    frame(i, bs[i % 4], bs[(i + 1) % 4]); // a different pair each frame: the working set shifts
    const t = R.getMemoryStats().gpu.totalBytes;
    worst = Math.max(worst, t);
    if (t > budget) over++;
  }
  ok(
    over === 0,
    `${over} of 20 frame ends above the ${budget}-byte budget (worst ${worst}; unbudgeted working set ${warm}, essential ${essential})`,
  );
  const s = R.getMemoryStats();
  ok(s.policy.overBudgetBytes === 0, 'overBudgetBytes is 0');
  ok(
    s.gpu.peakBytes >= worst,
    `the in-frame high-water (${s.gpu.peakBytes}) is reported and is not below a frame end (${worst})`,
  );
  ok(
    Object.keys(s.policy.evictions).length > 0,
    `the budget evicted (${Object.entries(s.policy.evictions)
      .map(([k, v]) => `${k} ${v.bytes} B`)
      .join(', ')})`,
  );
  R.dispose();
}

{
  console.log('\n  dispose returns every byte, with a budget set:');
  const { R, F, bundle, frame } = await make({ memoryBudgetBytes: 50 * 1024 * 1024 });
  const bs = [await bundle(blurred(30, 30, '#00f')), await bundle(GROUPS), await bundle(BLOBS)];
  for (let i = 0; i < 4; i++) frame(i, ...bs);
  ok(R.getMemoryStats().gpu.totalBytes > 0, 'something is resident');
  for (const b of bs) b.dispose();
  R.dispose();
  const s = R.getMemoryStats();
  ok(
    s.gpu.totalBytes === 0 && s.gpu.resources === 0 && Object.keys(s.gpu.byCategory).length === 0,
    `zero after dispose (${s.gpu.totalBytes} B, ${s.gpu.resources} resources, ${JSON.stringify(s.gpu.byCategory)})`,
  );
  void F;
}

{
  console.log('\n  preparation accounting:');
  const { R, F, bundle } = await make();
  R.resetMemoryPeaks();
  const A = await bundle(svg('<path d="M10 10L80 10L80 80L10 80Z" fill="#00f"/>'), {
    keepInvisibleShapes: true,
  });
  let p = R.getMemoryStats().preparation;
  const labels = p.recent.map((r) => r.label);
  ok(
    labels.includes('importSvg') && labels.includes('createBundle'),
    `importSvg and createBundle are bracketed (${labels.join(', ')})`,
  );
  const cb = p.recent.filter((r) => r.label === 'createBundle').pop();
  const held = R.getMemoryStats().bundles.reduce((n, r) => n + r.gpuBytes, 0);
  ok(
    cb.gpuPeakBytes >= held && cb.gpuPeakBytes > 0,
    `createBundle's GPU high-water (${cb.gpuPeakBytes}) covers what the bundle holds (${held})`,
  );
  ok(
    p.heapSampled && cb.heapPeakDeltaBytes !== null,
    'the JS heap is sampled where the host exposes one',
  );
  const B = await bundle(svg('<path d="M20 20L70 20L70 70L20 70Z" fill="#00f"/>'), {
    keepInvisibleShapes: true,
  });
  const m = createShapeMorph(F.gl, A, B);
  p = R.getMemoryStats().preparation;
  ok(
    p.recent.some((r) => r.label === 'createShapeMorph' && r.gpuPeakBytes > 0),
    'createShapeMorph is bracketed with its GPU high-water',
  );
  ok(
    p.highWater.gpuPeakBytes >= cb.gpuPeakBytes,
    `the high-water (${p.highWater.gpuPeakBytes}) is at least any bracket's`,
  );
  R.resetMemoryPeaks();
  const q = R.getMemoryStats();
  ok(
    q.preparation.recent.length === 0 &&
      q.preparation.highWater.gpuPeakBytes === 0 &&
      q.gpu.peakBytes === q.gpu.totalBytes,
    'resetMemoryPeaks clears the log and brings the GPU peak to the current level',
  );
  const pre = R.getMemoryStats().gpu.totalBytes;
  ok(R.prepareBundle(A) !== undefined, 'prepareBundle runs');
  ok(
    R.getMemoryStats().preparation.recent.some((r) => r.label === 'prepareBundle'),
    'prepareBundle is bracketed',
  );
  ok(
    R.getMemoryStats().gpu.peakBytes >= pre,
    'the peak never falls below the level it started from',
  );
  void m;
  R.dispose();
}

// CPatch morphs must admit both the grown live curve plane and the static blend planes.
// This exercises production packing/allocation only; no shader arithmetic is simulated.
{
  const { applyCPatchMorphFrame, _toCurvesPair } =
    await import('../src/renderer/cpatchMorphBuild.js');
  const { curveRangeToContours } = await import('../src/geom/lbContour.js');
  const { certifyPolynomialMorph } = await import('../src/core/polynomialMorph.js');
  const { ledgerFor } = await import('../src/renderer/memoryLedger.js');
  const { cpatchBlendAllocationBytes } = await import('../src/renderer/cpatchMorphBlend.js');
  const { F, R, bundle } = await make({ cpatchFill: true });
  const a = await bundle(svg('<rect x="10" y="10" width="40" height="40" fill="#123"/>'));
  const b = await bundle(svg('<rect x="20" y="20" width="60" height="60" fill="#123"/>'));
  const m = createShapeMorph(F.gl, a, b, { cpuLerp: true }),
    bb = m.bundle || m,
    ms = bb._morphSrc;
  const range = ms.curveRanges[0];
  const pair = _toCurvesPair(
    curveRangeToContours(ms.mergedCurveF32, range.begin, range.end)[0],
    curveRangeToContours(ms.dstCurveF32, range.begin, range.end)[0],
  );
  const nativeArea = certifyPolynomialMorph(pair.A, pair.B);
  ok(!!nativeArea, 'the rectangle morph has a native boundary plan');
  const plan = [{ t0: 0, t1: 1, nativeArea }];
  bb._cpatchMorphPlan = { shapes: [{ A: pair.A, B: pair.B, plan, seg: -1, first: 0 }], planned: 1 };
  m.setT(0.37);
  const L = ledgerFor(F.gl),
    before = L.total,
    curveBefore = L.bytesOf(bb.curveTex);
  R.setMemoryBudget(before + 1);
  warnings.length = 0;
  ok(
    !applyCPatchMorphFrame(F.gl, bb, {}, R),
    'a constrained CPatch morph declines before allocating',
  );
  const refusal = L.policy.refusals['CPatch plane'],
    requestedBytes = refusal?.bytes;
  ok(
    refusal?.bytes > 1 && L.bytesOf(bb.curveTex) === curveBefore && L.total === before,
    'refusal preserves the raw curve allocation and allocates no blend resources',
  );
  ok(
    !bb._cpatchBuilt && !bb._cpatchMorphPlane && !bb._cpatchBlend && !ms.skipCurveUploads,
    'refusal leaves the raw morph live and does not publish prepared CPatch geometry',
  );
  applyCPatchMorphFrame(F.gl, bb, {}, R);
  ok(
    memWarnings().filter((w) => w.includes('CPatch plane')).length === 1,
    'repeated refusal warns once and explains the pinned fallback',
  );
  R.setMemoryBudget(before + requestedBytes);
  ok(
    applyCPatchMorphFrame(F.gl, bb, {}, R) && !!bb._cpatchBlend,
    'the exact requested headroom admits the complete CPatch morph route',
  );
  const admitted = L.total;
  ok(
    admitted - before === requestedBytes,
    'requested bytes equal the live plane growth, three blend planes, and helper buffer',
  );
  const target = bb._cpatchBlend;
  ok(
    cpatchBlendAllocationBytes(
      F.gl,
      target,
      target.w,
      target.h,
      target.y0,
      target.cw,
      target.ch,
    ) === 0,
    'an unchanged blend rectangle requires no additional bytes',
  );
  ok(
    cpatchBlendAllocationBytes(F.gl, null, target.w, target.h, target.y0, target.cw, target.ch) ===
      (2 * target.w * target.h + target.cw * target.ch) * 16,
    'another blend target credits the already resident shared helper',
  );
  bb._cpatchBlendKey = null; // Repack the same interval, requiring coefficient refill rather than the fast draw path.
  ok(
    applyCPatchMorphFrame(F.gl, bb, {}, R) && L.total === admitted,
    'coefficient refill at the exact budget reuses its resident allocations',
  );
  m.dispose();
  a.dispose();
  b.dispose();
  R.dispose();
}

// An impossible request must preserve useful caches; a potentially fitting request may evict them.
{
  const { ledgerFor } = await import('../src/renderer/memoryLedger.js');
  const { trackGlResource, deleteGlResource } = await import('../src/renderer/contextResources.js');
  const F = createFakeGl(),
    gl = F.gl,
    L = ledgerFor(gl),
    owner = {},
    other = {};
  const buffer = trackGlResource(gl, gl.createBuffer(), 'filterCache');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, 128, gl.STATIC_DRAW);
  let calls = 0;
  L.setBudget(owner, 256);
  L.setEvictors(owner, {
    filterCache: () => {
      calls++;
      deleteGlResource(gl, 'Buffer', buffer);
    },
  });
  const before = memWarnings().length;
  let refused = true;
  for (let i = 0; i < 1000; i++) refused = !L.admit(512, 'impossible-test') && refused;
  ok(refused, 'oversized optional allocations remain refused');
  ok(calls === 0 && L.bytesOf(buffer) === 128, 'impossible allocations preserve the cached buffer');
  ok(
    L.policy.refusals['impossible-test'].count === 1000 && memWarnings().length === before + 1,
    'refusal accounting is retained with one warning',
  );
  ok(
    L.admit(256, 'fitting-test') && calls === 1,
    'a fitting allocation still evicts a reusable cache',
  );
  L.setBudget(owner, 1024);
  ok(L.admit(512, 'impossible-test'), 'raising the budget permits the former refusal');
  L.setBudget(other, 256);
  ok(!L.admit(512, 'shared-test'), 'another renderer can lower the shared budget');
  L.dropRenderer(other);
  ok(L.admit(512, 'shared-test'), 'removing the shared limit permits allocation again');
  L.dropRenderer(owner);
}

console.warn = realWarn;
console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
