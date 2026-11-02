// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nonBlockingGlSmoke -- THE ZERO-BLOCKING INVARIANT, enforced (nonblock).
//
// From createRenderer to the last frame of play, no call into WebGL may wait for the driver: no query on a program that is still linking,
// no draw with one, and no query that comes out behind the GPU thread's pipeline build. A page that waits is a frozen loading screen.
//
// The scenarios run the real createRenderer on test/_pendingGl.mjs, a recording WebGL stand-in with a driver model (parallel links that finish
// after a delay, a serial GPU thread that builds a pipeline at each program's first draw, fences). TWO tallies must both read zero:
//   * the model's own `waits` (independent of the library: every query that had to wait for a link or sit behind a build), and
//   * renderer.debugStats.blockingLinkWaits, the library's guard (src/renderer/glGuard.js, `glGuard: true`).
// Each scenario names itself in the failure, with the call that waited.
//
// Scenarios: renderer creation with the links held; bundles of every engine/feature class; prepareBundle; precompileFillsAsync; draws while
// links are pending; rotate / recolor / override first sight; morph first sight; dispose mid-link; the last-resort branch of the fill pass.
// Without KHR_parallel_shader_compile nothing can be non-blocking; that is the documented synchronous fallback and is asserted to still work.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
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
const CLASSES = {
  fill: doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
  gradient: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  stroke: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
  ),
  dashed: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="4" stroke-dasharray="8 5"/>',
  ),
  clip: doc(
    '<g clip-path="url(#c)"><rect x="0" y="0" width="100" height="100" fill="#a30"/></g>',
    '<clipPath id="c"><circle cx="50" cy="50" r="30"/></clipPath>',
  ),
  // (two shapes in the mask: a single-shape mask is handled inline and never bakes)
  mask: doc(
    '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
    '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
  ),
  filter: doc(
    '<g filter="url(#f)"><circle cx="50" cy="50" r="25" fill="#06c"/></g>',
    '<filter id="f"><feGaussianBlur stdDeviation="3"/></filter>',
  ),
  group: doc(
    '<g opacity="0.5"><rect x="10" y="10" width="50" height="50" fill="#c00"/><rect x="40" y="40" width="50" height="50" fill="#00c"/></g>',
  ),
  arcs: doc('<path d="M10 50 A 40 25 20 1 1 90 50 A 40 25 20 1 1 10 50 Z" fill="#640"/>'),
  many: doc(
    Array.from(
      { length: 24 },
      (_, i) =>
        `<rect x="${(i % 6) * 15 + 3}" y="${Math.floor(i / 6) * 22 + 3}" width="12" height="18" fill="hsl(${i * 15},60%,45%)"/>`,
    ).join(''),
  ),
};
const sections = {};
for (const [k, s] of Object.entries(CLASSES))
  sections[k] = await importSvg(s, { preserveViewport: true });
const ROT45 = new Float32Array([
  Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  -Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  0,
  0,
  1,
]);
const TINT = {
  colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
  colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
};

/// One driver + renderer. `async` renderers resolve ready on a timer once the links are released.
async function rig(name, { driver = {}, opts = {}, release = 60, skipReady = false } = {}) {
  const W = createPendingGl({ linkMs: 30, pipelineMs: 120, ...driver });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: Infinity,
    ...opts,
  });
  const out = { name, W, R, base: 0, shed: opts.gpuShedMs != null && opts.gpuShedMs !== Infinity };
  R.ready.catch(() => {});
  if (release != null) setTimeout(() => W.release(), release);
  if (!skipReady) await R.ready;
  R.setViewport(128, 128);
  return out;
}
function bundlesOf(W, names) {
  const o = {};
  for (const n of names) o[n] = createBundle(W.gl, sections[n]);
  return o;
}
function frame(R, list, drawOpts) {
  R.beginFrame([1, 1, 1, 1]);
  for (const b of list) R.drawBundle(b, drawOpts);
  R.endFrame();
}
function reset(S) {
  S.W.resetWaits();
  S.base = S.R.debugStats ? S.R.debugStats.blockingLinkWaits : 0;
}
function report(S, label) {
  const m = S.W.model,
    g = S.R.debugStats || { blockingLinkWaits: 0, glGuard: null },
    gw = g.blockingLinkWaits - S.base;
  // An upload that waits behind a build is a wait only for a renderer that sheds frames (createMantleScene's default); a direct createRenderer draws
  // into the backlog by design (README).
  const waits = m.waits.filter((w) => S.shed || w.kind !== 'upload-behind-build');
  const byName = {};
  for (const w of waits) byName[w.kind + ':' + w.name] = (byName[w.kind + ':' + w.name] || 0) + 1;
  const where = waits
    .slice(0, 1)
    .map((w) =>
      w.stack
        .split(' < ')
        .filter((x) => !/glGuard|memoryLedger|_pendingGl|timed|Proxy/.test(x))
        .slice(0, 6)
        .join('<'),
    )
    .join(' || ');
  const ml =
    Object.entries(byName)
      .map(([k, n]) => `${k}x${n}`)
      .join(' ') || 'none';
  const sites = (g.glGuard ? g.glGuard.violations.slice(S.base) : [])
    .slice(0, 3)
    .map(
      (v) =>
        v.name +
        '@' +
        v.stack
          .split(' <- ')
          .slice(0, 3)
          .map((x) => x.replace(/\(?file:.*\/src\//, '('))
          .join('<'),
    )
    .join(' | ');
  ok(
    waits.length === 0 && gw === 0,
    `${S.name}${label ? ' / ' + label : ''}: no wait [model: ${ml}; stalled ${Math.round(m.stalledMs)} ms; guard blockingLinkWaits ${gw}${where ? '; at ' + where : ''}${sites ? '; ' + sites : ''}]`,
  );
}

console.log(
  '(1) renderer creation with the driver holding every link: createRenderer returns, ready resolves, nothing waited',
);
{
  const S = await rig('create', { release: 80 });
  ok(S.W.progCount() > 5, `${S.W.progCount()} programs linking at creation`);
  report(S);
  S.R.dispose();
}

console.log(
  '(2) one bundle of each engine / feature class, drawn while the driver is still linking their programs',
);
{
  const S = await rig('classes', { release: 400 });
  const B = bundlesOf(S.W, Object.keys(CLASSES));
  for (const b of Object.values(B)) S.R.prepareBundle(b);
  for (let i = 0; i < 3; i++) frame(S.R, Object.values(B));
  report(S, 'prepared, 3 frames while links pending');
  S.W.release();
  for (let i = 0; i < 20; i++) {
    frame(S.R, Object.values(B));
    await sleep(5);
  }
  report(S, '+20 frames as links finish');
  S.R.dispose();
}

console.log(
  '(2b) the small-shape point route, the instanced fast path, a linearRGB filter and CPatch, with every link held, then as they finish',
);
{
  const S = await rig('routes', {
    release: 500,
    opts: { aacPoints: true, aacFill: 'auto', cpatchAuto: true },
  });
  const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke', 'filter', 'many']);
  const lin = createBundle(
    S.W.gl,
    await importSvg(
      doc(
        '<g filter="url(#f)"><circle cx="50" cy="50" r="25" fill="#06c"/></g>',
        '<filter id="f" color-interpolation-filters="linearRGB"><feGaussianBlur stdDeviation="3"/><feColorMatrix type="saturate" values="0.5"/></filter>',
      ),
      { preserveViewport: true },
    ),
  );
  const SMALL = new Float32Array([0.04, 0, 0, 0, 0.04, 0, 0, 0, 1]);
  const many = [
    { worldMatrix: SMALL },
    { worldMatrix: new Float32Array([0.05, 0, 0.3, 0, 0.05, 0.2, 0, 0, 1]) },
    { worldMatrix: ROT45 },
  ];
  const drive = (n) => {
    for (let i = 0; i < n; i++) {
      S.R.beginFrame([1, 1, 1, 1]);
      for (const b of [...Object.values(B), lin]) {
        S.R.drawBundle(b, { worldMatrix: SMALL });
        S.R.drawBundle(b);
      }
      S.R.drawBundleInstanced(B.fill, many);
      S.R.drawBundleInstanced(B.many, many);
      S.R.endFrame();
    }
  };
  for (const b of [...Object.values(B), lin]) S.R.prepareBundle(b);
  drive(3);
  report(S, 'held');
  for (let k = 0; k < 25; k++) {
    drive(1);
    await sleep(25);
  }
  report(S, 'as links finish');
  const ds = S.R.debugStats,
    routes = (ds.engines && ds.engines.routes) || {};
  console.log(
    `  routes drawn: ${JSON.stringify(routes)}; instanced fast ${ds.instancedFastCount}; deferred fills ${ds.deferredFillDraws}, filters ${ds.deferredFilterDraws}`,
  );
  S.R.dispose();
}

console.log(
  '(2b-shed) the same routes on a renderer that sheds frames (the createMantleScene default): frames are spaced, so a shed frame is a frame not drawn',
);
{
  const S = await rig('routes-shed', {
    release: 300,
    opts: { aacPoints: true, aacFill: 'auto', gpuShedMs: 40 },
  });
  const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke', 'filter', 'many']);
  const SMALL = new Float32Array([0.04, 0, 0, 0, 0.04, 0, 0, 0, 1]);
  for (const b of Object.values(B)) S.R.prepareBundle(b);
  for (let k = 0; k < 40; k++) {
    S.R.beginFrame([1, 1, 1, 1]);
    for (const b of Object.values(B)) {
      S.R.drawBundle(b, { worldMatrix: SMALL });
      S.R.drawBundle(b);
    }
    S.R.endFrame();
    await sleep(12);
  }
  report(S, 'shedding');
  const ds = S.R.debugStats;
  ok(
    ds.shedFrames > 0 || S.W.model.pipelines === 0,
    `frames were shed while pipelines built (${ds.shedFrames} decisions, ${S.W.model.pipelines} pipelines)`,
  );
  S.R.dispose();
}

console.log(
  '(2c) the instanced fast path and the small-shape point route, programs held linking then finishing',
);
{
  const S = await rig('instanced', { release: 400, opts: { aacPoints: true, aacFill: 'auto' } });
  const b = createBundle(S.W.gl, sections.fill);
  const list = [
    { worldMatrix: new Float32Array([0.04, 0, 0, 0, 0.04, 0, 0, 0, 1]) },
    { worldMatrix: ROT45 },
    { worldMatrix: ROT45 },
  ];
  S.R.prepareBundle(b);
  for (let i = 0; i < 3; i++) {
    S.R.beginFrame([1, 1, 1, 1]);
    S.R.drawBundleInstanced(b, list);
    S.R.endFrame();
  }
  report(S, 'held');
  for (let i = 0; i < 40; i++) {
    S.R.beginFrame([1, 1, 1, 1]);
    S.R.drawBundleInstanced(b, list);
    S.R.drawBundle(b, { worldMatrix: new Float32Array([0.03, 0, 0.5, 0, 0.03, 0.5, 0, 0, 1]) });
    S.R.endFrame();
    await sleep(20);
  }
  ok(
    S.R.debugStats.instancedFastCount > 0,
    `the instanced fast path drew once its program was ready (${S.R.debugStats.instancedFastCount} draws)`,
  );
  report(S, 'as links finish');
  S.R.dispose();
}

console.log('(3) prewarmBundle / prepareBundle / the idle warm tick');
{
  const S = await rig('prepare', { release: 300 });
  const B = bundlesOf(S.W, Object.keys(CLASSES));
  for (const b of Object.values(B)) {
    S.R.prewarmBundle(b);
  }
  for (let i = 0; i < 10; i++) {
    frame(S.R, [B.fill, B.gradient]);
    await sleep(10);
  }
  report(S);
  S.R.dispose();
}

console.log('(4) precompileFillsAsync, links held for 200 ms, GPU thread building pipelines');
{
  const S = await rig('loading', { release: 200, driver: { pipelineMs: 150 } });
  const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke', 'dashed', 'group', 'filter', 'mask']);
  for (const b of Object.values(B)) S.R.prewarmBundle(b);
  const t0 = performance.now();
  await S.R.precompileFillsAsync({ timeoutMs: 20000 });
  ok(
    true,
    `resolved after ${Math.round(performance.now() - t0)} ms real, ${S.W.model.pipelines} pipelines built, ${S.W.model.fences} fences`,
  );
  ok(
    S.W.idle(),
    'and the driver is idle: every link complete and the GPU thread has nothing queued',
  );
  const cl = S.R.debugStats.coopLoad;
  ok(
    cl && !cl.incomplete && cl.steps > 1,
    `the loading call ran in slices (${cl && cl.steps} steps, the longest ${cl && Math.round(cl.maxStepMs)} ms), none cut short`,
  );
  ok(
    S.R.debugStats.gpuGate.fences > 1,
    `and it paced itself on fences (${S.R.debugStats.gpuGate.fences})`,
  );
  report(S);
  S.R.dispose();
}

console.log(
  '(4b) precompileFillsAsync({ viewport }) warms for the final size and leaves the renderer at the real one',
);
{
  const S = await rig('viewport', { release: 20 });
  const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke']);
  for (const b of Object.values(B)) S.R.prewarmBundle(b);
  const p0 = S.W.progCount();
  await S.R.precompileFillsAsync({ timeoutMs: 20000, viewport: [3456, 2169] });
  ok(S.W.progCount() > p0, `it warmed (${S.W.progCount() - p0} programs)`);
  reset(S);
  const mark = S.W.F.log.length;
  frame(S.R, Object.values(B));
  const drawn = S.W.F.log.slice(mark).filter((e) => e.op === 'draw' && !e.fbo);
  ok(
    drawn.length > 0 && drawn.every((e) => e.vp[2] <= 128 && e.vp[3] <= 128),
    `and the next real frame drew at the real viewport (${drawn.length} draws, no override leaked)`,
  );
  report(S, 'viewport warm');
  S.R.dispose();
}

console.log(
  '(4c) size is a continuous input: a drag through many scale classes builds nothing in the middle, a settled new class is warmed in the background',
);
{
  const S = await rig('resize', { release: 20, opts: { gpuShedMs: 40 } });
  const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke', 'group']);
  for (const b of Object.values(B)) S.R.prewarmBundle(b);
  await S.R.precompileFillsAsync({ timeoutMs: 20000 });
  reset(S);
  const sizes = Array.from({ length: 26 }, (_, i) => Math.round(128 * Math.pow(1.12, i))); // a drag from 128 up through ~8 quarter-octave classes
  const p0 = S.W.progCount();
  for (const w of sizes) {
    S.R.setViewport(w, Math.round(w * 0.75));
    frame(S.R, Object.values(B));
    await sleep(5);
  }
  const vw = S.R.debugStats.viewportWarm;
  ok(vw.changes >= 20, `the drag was seen (${vw.changes} viewport changes)`);
  ok(
    vw.events.length === 0,
    `no class was warmed while the size kept moving (${vw.events.length} warms during a ${sizes.length}-step drag)`,
  );
  const mark = S.W.model.draws;
  for (
    let k = 0;
    k < 400 &&
    !(S.R.debugStats.viewportWarm.events[0] && S.R.debugStats.viewportWarm.events[0].done);
    k++
  ) {
    frame(S.R, Object.values(B));
    await sleep(15);
  } // settled: frames at the final size until its warm is done (bounded)
  const vw2 = S.R.debugStats.viewportWarm;
  ok(
    vw2.events.length === 1 && vw2.events[0].done,
    `the settled size's class was warmed once, in the background (${JSON.stringify(vw2.events.map((e) => ({ cls: e.class, settledAfterMs: e.settledAfterMs, warmMs: e.warmMs })))})`,
  );
  ok(S.W.model.draws > mark, 'and frames kept drawing meanwhile');
  report(S, 'drag + settle');
  ok(
    S.R.debugStats.deferredFillDraws < 300,
    `deferrals stayed bounded (${S.R.debugStats.deferredFillDraws})`,
  );
  S.R.dispose();
}

console.log('(5) first sight of a rotated map, a recolor and an override table after loading');
{
  const S = await rig('first-sight', { release: 30 });
  const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke', 'group']);
  for (const b of Object.values(B)) S.R.prewarmBundle(b);
  await S.R.precompileFillsAsync({ timeoutMs: 20000 });
  reset(S);
  frame(S.R, Object.values(B));
  frame(S.R, Object.values(B), { worldMatrix: ROT45 });
  frame(S.R, Object.values(B), TINT);
  frame(S.R, Object.values(B), { worldMatrix: ROT45, ...TINT });
  report(S, 'rotated / recolored / both, immediately');
  for (let i = 0; i < 12; i++) {
    frame(S.R, Object.values(B), i % 2 ? { worldMatrix: ROT45 } : TINT);
    await sleep(8);
  }
  report(S, '+12 frames');
  S.R.dispose();
}

console.log('(6) morph first sight');
{
  const S = await rig('morph', { release: 30 });
  const a = createBundle(
    S.W.gl,
    await importSvg(doc('<path id="s" d="M10 10 L 90 10 L 90 90 L 10 90 Z" fill="#a00"/>'), {
      preserveViewport: true,
    }),
  );
  const b = createBundle(
    S.W.gl,
    await importSvg(
      doc('<path id="s" d="M50 5 C 95 20 95 80 50 95 C 5 80 5 20 50 5 Z" fill="#00a"/>'),
      { preserveViewport: true },
    ),
  );
  const m = createShapeMorph(S.W.gl, a, b);
  S.R.prewarmBundle(a);
  S.R.prewarmBundle(b);
  await S.R.precompileFillsAsync({ timeoutMs: 20000 });
  reset(S);
  for (let i = 0; i <= 10; i++) {
    m.setT(i / 10);
    frame(S.R, [m]);
  }
  report(S, 'first sight');
  S.R.dispose();
}

console.log(
  '(6b) a morph builds its GPU lerp targets when it is created, not at its first setT in play',
);
{
  const S = await rig('morph-prebuild', { release: 20 });
  const shape = (id, k, dx) =>
    `<path id="${id}" d="M${10 + dx} ${10 + (k % 5)} ` +
    Array.from({ length: 40 }, (_, i) => `L${10 + dx + i * 1.5} ${20 + ((i * 7 + k) % 13)}`).join(
      ' ',
    ) +
    ' Z" fill="#a00"/>';
  const big = (dx) =>
    doc(Array.from({ length: 90 }, (_, k) => shape('s' + k, k, dx % 1 === 0 ? dx : 0)).join(''));
  const a = createBundle(S.W.gl, await importSvg(big(0), { preserveViewport: true }));
  const b = createBundle(S.W.gl, await importSvg(big(3), { preserveViewport: true }));
  const m = createShapeMorph(S.W.gl, a, b);
  ok(m.usesGpuCurveLerp, 'the GPU lerp target exists as soon as the morph does');
  await sleep(300); // the helper programs finish (until then the CPU interpolation stands in, and uploads)
  m.setT(0.25);
  const u0 = S.W.model.texAllocs | 0;
  m.setT(0.5);
  ok(
    (S.W.model.texAllocs | 0) === u0,
    `and setT allocated no texture (${(S.W.model.texAllocs | 0) - u0} texImage2D)`,
  );
  S.R.dispose();
}

console.log('(7) dispose mid-link');
{
  const S = await rig('dispose', { release: null, skipReady: true, driver: { hold: true } });
  S.R.dispose();
  reset(S);
  await sleep(40);
  S.W.release();
  await sleep(60);
  report(S);
  const S2 = await rig('dispose-late', { release: 40 });
  const B = bundlesOf(S2.W, ['fill', 'gradient']);
  for (const b of Object.values(B)) S2.R.prewarmBundle(b);
  frame(S2.R, Object.values(B));
  S2.R.dispose();
  await sleep(80);
  report(S2, 'after variants were started');
}

console.log(
  '(8) the fill pass last resort: a lean variant still linking with nothing built to stand in',
);
{
  const S = await rig('last-resort', { release: 40 });
  S.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  S.W.hold();
  const B = bundlesOf(S.W, ['gradient', 'fill']);
  for (let i = 0; i < 6; i++) {
    frame(S.R, Object.values(B));
  }
  S.W.release();
  for (let i = 0; i < 6; i++) {
    frame(S.R, Object.values(B));
    await sleep(6);
  }
  ok(
    (S.R.debugStats.blockingLinkWaits | 0) === 0,
    `the last-resort counter stayed 0 (${S.R.debugStats.blockingLinkWaits})`,
  );
  report(S);
  S.R.dispose();
}

console.log(
  '(8b) backpressure: while the GPU thread is deep in a pipeline build, frame entries shed their frames; they resume when it catches up',
);
{
  const { gateFor } = await import('../src/renderer/gpuGate.js');
  const run = async (opts) => {
    const S = await rig('backpressure', { release: 20, opts });
    const B = bundlesOf(S.W, ['fill', 'gradient', 'group']);
    for (const b of Object.values(B)) S.R.prewarmBundle(b);
    await S.R.precompileFillsAsync({ timeoutMs: 20000 });
    return { S, B: Object.values(B) };
  };
  const frames = (S, B, n) => {
    const d0 = S.W.model.draws;
    for (let i = 0; i < n; i++) frame(S.R, B);
    return S.W.model.draws - d0;
  };
  for (const [label, shedMs] of [
    ['shed', 40],
    ['unshed', Infinity],
  ]) {
    const { S, B } = await run({ gpuShedMs: shedMs });
    const base = frames(S, B, 2);
    // a build is in flight: the model's GPU thread is busy for 600 ms and the gate was told work was queued
    S.W.model.gpuFree = S.W.vt() + 600;
    gateFor(S.W.gl).work();
    await sleep(60); // past the shed threshold
    const during = frames(S, B, 4);
    const shedNow = S.R.debugStats.shedFrames;
    await sleep(650);
    const after = frames(S, B, 2);
    if (shedMs === 40) {
      ok(
        base > 0 && during === 0,
        `${label}: drawing resumed state: ${base} draws before, ${during} while the build was queued (all frames shed: ${shedNow})`,
      );
      ok(after > 0, `${label}: ${after} draws once the GPU thread caught up`);
    } else
      ok(
        during > 0 && S.R.debugStats.shedFrames === 0,
        `${label}: gpuShedMs Infinity draws into the backlog (${during} draws, ${S.R.debugStats.shedFrames} shed)`,
      );
    S.R.dispose();
  }
}

console.log(
  '(8c) a mask bake whose lean program is still linking does not fall back to the general program (a ~7 s pipeline build on a cold cache)',
);
{
  const S = await rig('maskbake', { release: 20 });
  const b = createBundle(S.W.gl, sections.mask);
  S.W.hold(); // programs started from here on stay linking
  S.R.prewarmBundle(b);
  for (let i = 0; i < 4; i++) frame(S.R, [b]);
  const deferredHeld = S.R.debugStats.maskBakeDeferred;
  ok(
    deferredHeld >= 1,
    `a bake whose lean program was linking was deferred, not drawn with the general program (${deferredHeld} deferred)`,
  );
  S.W.release();
  for (let i = 0; i < 40; i++) {
    frame(S.R, [b]);
    await sleep(8);
  }
  const d1 = S.R.debugStats.maskBakeDeferred;
  for (let i = 0; i < 6; i++) {
    frame(S.R, [b]);
    await sleep(8);
  }
  ok(
    S.R.debugStats.maskBakeDeferred === d1,
    `and it bakes once the program is ready (no further deferrals: ${d1} -> ${S.R.debugStats.maskBakeDeferred})`,
  );
  reset(S);
  report(S, 'mask bake');
  S.R.dispose();
}

console.log(
  '(8d) the gate cannot wedge a game: a fence that never signals, and one that signals only after a flush',
);
{
  // flush runs on both static routes: the cover pass (router A*'s default) and the unified route (staticUnified), whose fence sequences differ
  for (const [mode, staticUnified] of [
    ['never', false],
    ['flush', false],
    ['flush', true],
  ]) {
    const S = await rig('fence-' + mode + (staticUnified ? '-unified' : ''), {
      release: 20,
      driver: { fenceMode: mode, pipelineMs: 60 },
      opts: {
        gpuRelaxMs: mode === 'flush' ? 1e9 : 80,
        gpuShedMs: 40,
        aacPoints: false,
        staticUnified,
      },
    }); // (flush: the relax window is out of reach of real elapsed time, so a loaded lane cannot cross it; relaxed must stay 0)
    const B = bundlesOf(S.W, ['fill', 'gradient', 'stroke', 'group']);
    for (const b of Object.values(B)) S.R.prewarmBundle(b);
    let framesDrawn = 0,
      framesTried = 0,
      firstDrawFrame = -1;
    for (let k = 0; k < 60; k++) {
      const d0 = S.W.model.draws;
      framesTried++;
      frame(S.R, Object.values(B));
      if (S.W.model.draws > d0) {
        framesDrawn++;
        if (firstDrawFrame < 0) firstDrawFrame = k;
      }
      await sleep(15);
    }
    const ds = S.R.debugStats,
      gs = ds.gpuGate;
    ok(
      framesDrawn > 20 && firstDrawFrame >= 0,
      `${mode}: the game kept drawing (${framesDrawn} of ${framesTried} frames submitted draws, the first at frame ${firstDrawFrame})`,
    );
    ok(
      ds.deferredFillDraws < 400,
      `${mode}: deferred work is bounded (${ds.deferredFillDraws} deferred fill draws)`,
    );
    ok(gs.stuckFences === 0, `${mode}: the 30 s valve was not needed (${gs.stuckFences})`);
    if (mode === 'never')
      ok(
        gs.relaxed > 0,
        `never: the starvation rule validated ready programs after the relax window (${gs.relaxed})`,
      );
    else
      ok(
        gs.relaxed === 0 && S.W.model.flushes > 0,
        `flush: progress came from the fence's own flush, with no relaxation (${gs.relaxed} relaxed, ${S.W.model.flushes} flushes)`,
      );
    S.R.dispose();
  }
}

console.log(
  '(9) without KHR_parallel_shader_compile the synchronous path is the documented fallback and works',
);
{
  const W = createPendingGl({ khr: false });
  const R = createRenderer(W.gl, taggedShaderSources(), { aacPoints: false });
  await R.ready;
  R.setViewport(128, 128);
  const b = createBundle(W.gl, sections.fill);
  frame(R, [b]);
  ok(W.model.draws > 0, 'a renderer without the extension draws');
  R.dispose();
}

console.log(
  '(9b) the default renderer (nonBlocking off) keeps its blocking semantics: it waits for links instead of deferring draws',
);
{
  const W = createPendingGl({ linkMs: 30, pipelineMs: 60 });
  const R = createRenderer(W.gl, taggedShaderSources(), { aacPoints: false, glGuard: true });
  await R.ready;
  R.setViewport(128, 128);
  const b = createBundle(W.gl, sections.fill);
  R.prewarmBundle(b);
  W.hold();
  frame(R, [b]);
  const n = R.precompileFills();
  ok(typeof n === 'number', `precompileFills() (the blocking loading call) ran (${n})`);
  ok(R.debugStats.deferredFillDraws === 0, 'no draw was deferred (blocking mode never defers)');
  ok(W.model.draws > 0, 'and it drew');
  ok(
    R.debugStats.blockingLinkWaits >= 0,
    `blocking waits are counted, not forbidden here (${R.debugStats.blockingLinkWaits})`,
  );
  R.dispose();
}

if (fail) {
  console.error(`FAIL nonBlockingGlSmoke: ${fail}`);
  process.exit(1);
}
console.log('nonBlockingGlSmoke PASS');
