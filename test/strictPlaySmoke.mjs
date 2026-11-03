// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strictPlaySmoke -- the PLAY INVARIANT of opts.strictPlay (createMantleScene sets it): once the loading call is done, every frame is a
// complete, correct, NEW frame. No frame is shed, no draw is deferred, no program is drawn for the first time (a pipeline build holds the GPU
// thread and stalls presentation), however unpredicted the draw state. The loading call builds the safety nets; a draw whose own program is not
// built draws a net and its lean program waits for renderer.beginWarmWindow().
// Runs the real renderer on the driver-model stand-in (test/_pendingGl.mjs). The control arm (strictPlay off) shows the test can fail: its
// first-sight draws build their own programs in play.
// The safety nets are the STAND-IN policy's (the default is stand-in-free, which builds the exact image and waits on a miss: warmPolicySmoke (reuse, bindset)).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const STAND_INS = { standIns: true, needMissPolicy: 'defer' };
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
const SRC = {
  bg: doc('<rect x="0" y="0" width="100" height="100" fill="#234"/>'),
  fill: doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
  gradient: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  mask: doc(
    '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
    '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
  ),
  group: doc(
    '<g opacity="0.5"><rect x="10" y="10" width="50" height="50" fill="#c00"/><rect x="40" y="40" width="50" height="50" fill="#00c"/></g>',
  ),
  stroke: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
  ),
};
const sections = {};
for (const [k, s] of Object.entries(SRC))
  sections[k] = await importSvg(s, { preserveViewport: true });
const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const TINT = {
  colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
  colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
};

async function arm(strict) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: strict,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    ...STAND_INS,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(128, 128);
  const loaded = ['bg', 'gradient', 'stroke', 'mask', 'group'].map((k) =>
    createBundle(W.gl, sections[k]),
  );
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 120 }); // (play at the durations a stray link or build shows against)
  // PLAY: bundles that arrive after loading (fill), under draw states the loading call did not build (rotated AND recolored at once).
  const late = createBundle(W.gl, sections.fill);
  const all = [...loaded, late];
  all.forEach((b, i) => {
    b.__n = 'b' + i;
  });
  const states = [{}, { worldMatrix: ROT }, { worldMatrix: ROT, ...TINT }, TINT];
  R._playDbg = true;
  const ds0 = { ...R.debugStats };
  const m0 = { pipelines: W.model.pipelines, waits: W.model.waits.length, links: W.model.links };
  let minDraws = Infinity,
    frames = 0,
    empty = 0;
  for (let i = 0; i < 60; i++) {
    const st = states[i % states.length];
    const d0 = W.model.draws;
    R.beginFrame([1, 1, 1, 1]);
    for (const b of all) R.drawBundle(b, st);
    R.endFrame();
    const d = W.model.draws - d0;
    frames++;
    minDraws = Math.min(minDraws, d);
    if (d < all.length) empty++;
    await sleep(3);
  }
  const ds = R.debugStats;
  const prSnap = ((ds.gpuGate && ds.gpuGate.postReady) || []).map((e) => ({
    target: e.target,
    program: e.program,
    variant: e.ctx && e.ctx.variant,
    rot: e.ctx && e.ctx.rotated,
    rec: e.ctx && e.ctx.recolor,
  }));
  if (strict && process.env.DBG) {
    for (const n of ds.nets)
      console.log(
        '  net',
        n.pending ? 'PENDING' : 'linked',
        n.psoReady ? 'warm' : 'COLD',
        n.key.slice(0, 150),
      );
    console.log('deferred last key', ds.lastDeferredKey);
    for (const e of prSnap) {
      const pl = (ds.gpuGate.pipeLog || [])
        .filter((x) => x[1] === e.program.slice(0, 80))
        .map((x) => x.slice(2).join('/') + (x[5] ? '*' : ''));
      console.log('  PIPES for', e.program.slice(0, 60), JSON.stringify(pl));
    }
    for (const e of prSnap)
      console.log(
        '  postReady',
        e.target,
        e.program,
        '\n     variant',
        e.variant,
        '| rot',
        e.rot,
        'rec',
        e.rec,
      );
    console.log(
      'postReady',
      JSON.stringify((ds.gpuGate && ds.gpuGate.postReady) || null, null, 0).slice(0, 1500),
    );
    console.log('standIns', JSON.stringify(ds.playStandIns, null, 1));
    console.log('playBuildKeys', ds.playBuildKeys);
  }
  const out = {
    prSnap,
    R,
    W,
    all,
    ds0,
    ds,
    m0,
    minDraws,
    frames,
    empty,
    links: W.model.links - m0.links,
    pipes: W.model.pipelines - m0.pipelines,
    waits: W.model.waits.length - m0.waits,
  };
  return out;
}

console.log('(control) strictPlay off: first-sight draws in play build their own programs');
{
  const o = await arm(false);
  ok(
    o.pipes > 0 || o.ds.deferredFillDraws - o.ds0.deferredFillDraws > 0,
    `control builds or defers in play (${o.pipes} pipelines, ${o.ds.deferredFillDraws - o.ds0.deferredFillDraws} deferred)`,
  );
  o.R.dispose();
}
console.log(
  '(strict) strictPlay on: every play frame is complete and new, with zero builds, zero deferrals, zero shed frames',
);
{
  const o = await arm(true);
  const d = (k) => (o.ds[k] | 0) - (o.ds0[k] | 0);
  ok(
    o.empty === 0,
    `every one of ${o.frames} frames drew all ${o.all.length} bundles (fewest draw calls in a frame: ${o.minDraws})`,
  );
  ok(
    d('deferredFillDraws') === 0 && d('deferredFilterDraws') === 0,
    `no deferral in play (fills ${d('deferredFillDraws')}, filters ${d('deferredFilterDraws')})`,
  );
  ok(d('shedFrames') === 0, `no shed frame in play (${d('shedFrames')})`);
  ok(d('maskBakeDeferred') === 0, `no mask bake deferred in play (${d('maskBakeDeferred')})`);
  ok(
    o.pipes === 0,
    `no program drawn for the first time in play (${o.pipes}; keys ${JSON.stringify(o.ds.playBuildKeys)})`,
  );
  ok(o.waits === 0, `no main-thread wait in play (${o.waits})`);
  ok(
    o.prSnap.length === 0,
    `no pipeline (program x attachment format x layout) first built in play, canvas or render target (${o.prSnap.length}: ${o.prSnap
      .slice(0, 2)
      .map((e) => e.program.slice(0, 40))
      .join(' | ')})`,
  );
  ok(
    o.links === 0,
    `no program linked in play (${o.links}): a link is GPU-process compile work that delays every frame behind it`,
  );
  ok(
    o.ds.playStandInDraws > 0,
    `unpredicted states drew a safety net (${o.ds.playStandInDraws} draws, ${o.ds.playStandIns.length} states)`,
  );
  // the next window builds the lean programs; afterwards the same states draw their own programs
  const pb = o.W.model.pipelines;
  await o.R.beginWarmWindow({});
  if (process.env.DBG)
    console.log(
      '  window built pipelines:',
      o.W.model.pipelines - pb,
      'queued',
      o.R.debugStats.psoWarmPending,
    );
  if (process.env.DBG2) {
    await o.R.beginWarmWindow({});
    console.log('  2nd window built', o.W.model.pipelines - pb);
  }
  ok(o.ds.warmWindows === 1 || o.R.debugStats.warmWindows === 1, 'a warm window ran');
  const before = o.R.debugStats.playStandInDraws;
  const sBefore = new Map(o.R.debugStats.playStandIns.map((e) => [e.want, e.frames]));
  for (let i = 0; i < 12; i++) {
    o.R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) o.R.drawBundle(b, { worldMatrix: ROT });
    o.R.endFrame();
    await sleep(3);
  }
  // (a window builds lean programs: how fast the stand-in is retired per state is reported by the real-flow harness, debugStats.playStandIns)
  ok(o.W.model.pipelines - pb > 0, `the window built pipelines (${o.W.model.pipelines - pb})`);
  o.R.dispose();
}
console.log(
  "(morph) a morph's lerp and fixup pass pipelines are built by the loading call, so a setT in play builds nothing",
);
{
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    ...STAND_INS,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(128, 128);
  const shape = (id, k, dx) =>
    `<path id="${id}" d="M${10 + dx} ${10 + (k % 5)} ` +
    Array.from({ length: 40 }, (_, i) => `L${10 + dx + i * 1.5} ${20 + ((i * 7 + k) % 13)}`).join(
      ' ',
    ) +
    ' Z" fill="#a00"/>';
  const big = (dx) => doc(Array.from({ length: 90 }, (_, k) => shape('s' + k, k, dx)).join(''));
  const a = createBundle(W.gl, await importSvg(big(0), { preserveViewport: true }));
  const b = createBundle(W.gl, await importSvg(big(3), { preserveViewport: true }));
  const m = createShapeMorph(W.gl, a, b);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 120 }); // (play at the durations a stray link or build shows against)
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    ds0 = { ...R.debugStats };
  for (let i = 1; i <= 12; i++) {
    m.setT(i / 12);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(m.bundle);
    R.endFrame();
    await sleep(3);
  }
  if (process.env.DBG) {
    for (const n of R.debugStats.variantKeys)
      if (n.net || /union/.test('')) console.log('  MV', n.net, n.ready, n.pending, n.key);
    for (const x of R.debugStats.gpuGate.pipeLog)
      if (
        /prewarm:MANTLE_AAC_PAIR_BANDS\|MANTLE_NO_ARC\|MANTLE_NO_CLIP\|MANTLE_NO_CUBIC/.test(x[1])
      )
        console.log('  PL', JSON.stringify(x));
    console.log(
      'MORPH lastDeferred',
      R.debugStats.lastDeferredKey,
      'playBuilds',
      R.debugStats.playBuilds,
      JSON.stringify(R.debugStats.playBuildKeys),
      'standIns',
      R.debugStats.playStandInDraws,
    );
    for (const e of R.debugStats.gpuGate.postReady || [])
      console.log('  MPR', e.program.slice(0, 160), e.ctx && e.ctx.window);
  }
  ok(
    W.model.pipelines === p0,
    `no pipeline built by 12 setT calls and draws in play (${W.model.pipelines - p0})`,
  );
  ok(
    W.model.waits.length === w0 &&
      (R.debugStats.deferredFillDraws | 0) === (ds0.deferredFillDraws | 0),
    'no wait, no deferral',
  );
  // a morph that is created IN play (its passes were built by the loading call, not by a morph of its own)
  const a2 = createBundle(W.gl, await importSvg(big(0), { preserveViewport: true })),
    b2 = createBundle(W.gl, await importSvg(big(5), { preserveViewport: true }));
  const p1 = W.model.pipelines;
  const m2 = createShapeMorph(W.gl, a2, b2);
  await sleep(5);
  for (let i = 1; i <= 6; i++) {
    m2.setT(i / 6);
    await sleep(2);
  }
  ok(
    W.model.pipelines === p1,
    `a morph created in play builds no lerp/fixup pipeline (${W.model.pipelines - p1})`,
  );
  // ...and a morph disposed and rebuilt (a resize does) links nothing: the warmer holds the pass programs
  const l1 = W.model.links;
  if (m2.dispose) m2.dispose();
  const m3 = createShapeMorph(W.gl, a2, b2);
  await sleep(5);
  for (let i = 1; i <= 4; i++) {
    m3.setT(i / 4);
    await sleep(2);
  }
  ok(
    W.model.links === l1,
    `a morph disposed and rebuilt in play links no program (${W.model.links - l1})`,
  );
  R.dispose();
}
console.log(
  '(filter) a bundle with a linearRGB filter that arrives in play draws without deferral: the helpers were started and primed by the loading call',
);
{
  const o = await arm(true);
  const R = o.R,
    W = o.W;
  const lin = createBundle(
    W.gl,
    await importSvg(
      doc(
        '<g filter="url(#f)"><circle cx="50" cy="50" r="25" fill="#06c"/></g>',
        '<filter id="f" color-interpolation-filters="linearRGB"><feGaussianBlur stdDeviation="3"/></filter>',
      ),
      { preserveViewport: true },
    ),
  );
  const ds0 = { ...R.debugStats };
  for (let i = 0; i < 20; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(lin);
    R.endFrame();
    await sleep(3);
  }
  ok(
    (R.debugStats.deferredFilterDraws | 0) === (ds0.deferredFilterDraws | 0),
    `no filter draw deferred (${(R.debugStats.deferredFilterDraws | 0) - (ds0.deferredFilterDraws | 0)})`,
  );
  R.dispose();
}
console.log(
  '(resize) a drag through scale classes in strict play: every frame complete and new, no build, no deferral, no shed',
);
{
  const o = await arm(true);
  const R = o.R,
    W = o.W;
  const ds0 = { ...R.debugStats },
    p0 = W.model.pipelines,
    w0 = W.model.waits.length;
  let empty = 0;
  const sizes = [];
  for (let i = 0; i < 24; i++) sizes.push(Math.round(96 * Math.pow(1.12, i)));
  for (const n of [...sizes, ...sizes.slice().reverse()]) {
    R.setViewport(n, Math.round(n * 0.65));
    const d0 = W.model.draws;
    R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) R.drawBundle(b, { worldMatrix: ROT });
    R.endFrame();
    if (W.model.draws - d0 < o.all.length) empty++;
    await sleep(3);
  }
  const d = (k) => (R.debugStats[k] | 0) - (ds0[k] | 0);
  ok(empty === 0, `all ${sizes.length * 2} resize frames drew every bundle`);
  ok(
    d('deferredFillDraws') === 0 && d('shedFrames') === 0,
    `no deferral (${d('deferredFillDraws')}) and no shed frame (${d('shedFrames')}) across the drag`,
  );
  ok(
    W.model.pipelines === p0 && W.model.waits.length === w0,
    `no pipeline built (${W.model.pipelines - p0}) and no wait (${W.model.waits.length - w0}) across the drag`,
  );
  if (process.env.DBG) {
    console.log('lastDeferred', R.debugStats.lastDeferredKey);
    for (const n of R.debugStats.nets)
      if (/LB_FILL/.test(n.key) && !/ROTATED/.test(n.key))
        console.log('NETFULL', n.psoReady, n.built, n.key);
  }
  if (process.env.DBG)
    for (const e of R.debugStats.gpuGate.postReady || [])
      console.log('  PR', e.program.slice(0, 200), JSON.stringify(e.ctx));
  R.dispose();
}
console.log(
  '(inferred) the library opens its own windows: an ANIMATED screen builds nothing, a STATIC screen builds the queued lean programs, one pipeline per fence',
);
{
  const o = await arm(true);
  const R = o.R,
    W = o.W;
  const p0 = W.model.pipelines;
  for (let i = 0; i < 60; i++) {
    // animated: a new matrix every frame
    const a = 0.3 + i * 0.01,
      m = new Float32Array([Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1]);
    R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) R.drawBundle(b, { worldMatrix: m });
    R.endFrame();
    await sleep(3);
  }
  ok(W.model.pipelines === p0, `an animated screen built no pipeline (${W.model.pipelines - p0})`);
  const w0 = R.debugStats.inferredWindows,
    standIn0 = R.debugStats.playStandInDraws;
  for (let i = 0; i < 600; i++) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) R.drawBundle(b, { worldMatrix: ROT });
    R.endFrame();
    await sleep(8);
  }
  ok(
    R.debugStats.inferredWindows > w0,
    `a static screen opened inferred windows (${R.debugStats.inferredWindows - w0})`,
  );
  ok(
    W.model.pipelines > p0,
    `...and built the queued lean programs (${W.model.pipelines - p0} pipelines)`,
  );
  ok(
    R.debugStats.deferredFillDraws - o.ds0.deferredFillDraws === 0 && W.model.waits.length === 0,
    'no deferral and no main-thread wait while it built',
  );
  const sBefore = R.debugStats.playStandInDraws;
  for (let i = 0; i < 6; i++) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) R.drawBundle(b, { worldMatrix: ROT });
    R.endFrame();
    await sleep(3);
  }
  if (process.env.DBG) {
    console.log(
      'queued',
      R.debugStats.psoWarmPending,
      JSON.stringify(R.debugStats.pendingVariants),
      'gpuBusy',
      JSON.stringify(
        R.debugStats.gpuGate && {
          pending: R.debugStats.gpuGate.pending,
          fences: R.debugStats.gpuGate.fences,
        },
      ),
    );
    for (const e of R.debugStats.playStandIns)
      console.log('  SI', e.want.slice(-70), JSON.stringify(R.debugStats.variantState(e.want)));
  }
  console.log(
    `  (stand-in draws in the 6 frames after: ${R.debugStats.playStandInDraws - sBefore} of ${6 * o.all.length})`,
  );
  R.dispose();
}
console.log(
  '(resize window) a resize does not open a build window while the user may still be interacting; a size that settles is built only after the longer quiet',
);
{
  const o = await arm(true);
  const R = o.R,
    W = o.W;
  const p0 = W.model.pipelines,
    w0 = R.debugStats.inferredWindows;
  R.setViewport(300, 195); // a resize into another scale class, then a STATIC screen
  const t0 = performance.now();
  while (performance.now() - t0 < 3500) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) R.drawBundle(b, { worldMatrix: ROT });
    R.endFrame();
    await sleep(8);
  }
  ok(
    R.debugStats.inferredWindows === w0 && W.model.pipelines === p0,
    `3.5 s of static screen after a resize opened no window (${R.debugStats.inferredWindows - w0}) and built no pipeline (${W.model.pipelines - p0})`,
  );
  while (performance.now() - t0 < 9500) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of o.all) R.drawBundle(b, { worldMatrix: ROT });
    R.endFrame();
    await sleep(8);
  }
  ok(
    R.debugStats.inferredWindows > w0,
    `after the longer quiet the static screen opened a window (${R.debugStats.inferredWindows - w0})`,
  );
  R.dispose();
}
console.log(fail ? `strictPlaySmoke FAIL (${fail})` : 'strictPlaySmoke PASS');
process.exit(fail ? 1 : 0);
