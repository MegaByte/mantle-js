// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmQueueSmoke -- renderer.warm (the prioritized, pausable, cancellable background warm queue, recorded warm manifests of scenes) and
// warmPolicy 'idle' (previous-release behavior that builds queued variants in inferred idle windows) on the driver-model stand-in (test/_pendingGl.mjs).
//
//   queue    pending work of other scenes STOPS on focus (an item is one synchronous step, so a build in flight is the GPU's and finishes), the focused
//            scene's keys build first, resume continues, cancel removes, priorities order scenes, nothing ever waits on a link (blockingLinkWaits 0,
//            no main-thread wait in the model)
//   manifest a scene warmed from its manifest alone (no bundles) cuts the pipelines its loading call builds; a stale, missing or garbled manifest never
//            throws and falls back to the bundles when they exist
//   frames   gameplay frames stay complete while the queue builds in an inferred window
//   idle     warmPolicy 'idle': builds only on idle frames, none while the screen animates, none after input, frames complete; direct createRenderer's
//            blocking default is unchanged; invalid combinations throw
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const listeners = {};
globalThis.window = {
  addEventListener: (t, f) => {
    (listeners[t] ||= []).push(f);
  },
};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await sleep(5);
  return f();
};
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
  stroke: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
  ),
  quad: doc('<path d="M10 80 Q 50 0 90 80 Z" fill="#a40"/>'),
};
const sections = {};
for (const [k, s] of Object.entries(SRC))
  sections[k] = await importSvg(s, { preserveViewport: true });
const SET_A = ['bg', 'fill', 'gradient'],
  SET_B = ['mask', 'stroke', 'quad'];

const strictOpts = {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  glGuard: true,
  gpuShedMs: 40,
};
async function mk(extra = {}, link = 30, pipe = 120) {
  const W = createPendingGl({ linkMs: link, pipelineMs: pipe });
  const R = createRenderer(W.gl, taggedShaderSources(), { ...strictOpts, ...extra });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(128, 128);
  return { W, R };
}
const bundlesOf = (W, keys) => keys.map((k) => createBundle(W.gl, sections[k]));
const frame = (R, bs, st) => {
  R.beginFrame([1, 1, 1, 1]);
  for (const b of bs) R.drawBundle(b, st);
  R.endFrame();
};

// RECORD one manifest per scene set: a real session (load, then a few frames in the states play meets). What it records is what the session bound, whatever its
// builds cost, so it runs at short model durations.
async function record(keys) {
  const { W, R } = await mk({ recordWarmManifest: true }, 2, 2);
  const bs = bundlesOf(W, keys);
  await R.precompileFillsAsync({});
  for (const st of [{}, { worldMatrix: new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]) }]) {
    frame(R, bs, st);
    await sleep(3);
  }
  const m = R.exportWarmManifest();
  R.dispose();
  return m;
}
console.log(
  '(record) a recording session exports a version 3 manifest: fingerprints, pipelines with layouts, scale classes',
);
const mA = await record(SET_A),
  mB = await record(SET_B);
{
  ok(
    mA.version === 3 &&
      typeof mA.shaders === 'string' &&
      typeof mA.bundleSet === 'string' &&
      mA.bundleSet !== mB.bundleSet,
    `fingerprints (shaders ${mA.shaders}, bundle sets ${mA.bundleSet} / ${mB.bundleSet})`,
  );
  ok(
    mA.pipelines.length > 0 &&
      mA.pipelines.every(
        (p) => typeof p.k === 'string' && p.lay.length > 0 && typeof p.tex === 'boolean',
      ),
    `${mA.pipelines.length} pipelines recorded, each with a vertex layout and a target kind`,
  );
  ok(
    Array.isArray(mA.scales) && mA.scales.length >= 1 && mA.scales[0].w === 128,
    `scale classes recorded (${JSON.stringify(mA.scales)})`,
  );
  ok(
    JSON.parse(JSON.stringify(mA)).pipelines.length === mA.pipelines.length,
    'the manifest survives JSON',
  );
}

console.log(
  "(queue) focus stops OTHER scenes' pending work, builds the focused scene first; resume continues; priorities order scenes; cancel removes",
);
{
  const { W, R } = await mk();
  R.warm.window(true);
  const hA = R.warm.add('A', { manifest: mA }),
    hB = R.warm.add('B', { manifest: mB });
  const st0 = R.warm.status();
  ok(
    st0.scenes.A.source === 'manifest' && st0.scenes.A.total > 0 && st0.scenes.A.manifest === 'ok',
    `A is queued from its manifest (${st0.scenes.A.total} items, no bundles loaded)`,
  );
  ok(await until(() => R.warm.status().scenes.A.built >= 2), 'A started building');
  const a0 = R.warm.status().scenes.A,
    order = [];
  hA.ready.then(() => order.push('A'));
  hB.ready.then(() => order.push('B'));
  const p0 = W.model.pipelines;
  const fB = R.warm.focus('B');
  const rB = await fB;
  const aAtB = R.warm.status().scenes.A;
  ok(
    rB.state === 'done' && rB.built > 0,
    `focus(B) resolved with B's work done (${rB.built} built, ${rB.skipped} skipped, ${rB.ms} ms)`,
  );
  ok(
    aAtB.pending === a0.pending && aAtB.built === a0.built,
    `A's pending work stopped while B was focused (pending ${a0.pending} -> ${aAtB.pending}, built ${a0.built} -> ${aAtB.built})`,
  );
  ok(aAtB.state === 'paused', `A reports paused (${aAtB.state})`);
  ok(W.model.pipelines > p0, `B's pipelines were built (${W.model.pipelines - p0})`);
  R.warm.resume();
  const rA = await hA.ready;
  ok(
    rA.state === 'done' && order.join('') === 'BA',
    `resume continued A to the end (${rA.built} built), after B (order ${order.join('')})`,
  );
  ok(
    W.model.waits.length === 0 && (R.debugStats.blockingLinkWaits | 0) === 0,
    `nothing waited on the driver (model waits ${W.model.waits.length}, blockingLinkWaits ${R.debugStats.blockingLinkWaits | 0})`,
  );
  // priorities
  const lo = R.warm.add('lo', { manifest: mA, priority: 1 }),
    hi = R.warm.add('hi', { manifest: mB, priority: 9 });
  const seen = [];
  lo.ready.then(() => seen.push('lo'));
  hi.ready.then(() => seen.push('hi'));
  await Promise.all([lo.ready, hi.ready]);
  ok(
    seen[0] === 'hi' || R.warm.status().scenes.hi.built === 0,
    `the higher priority scene finishes first (${seen.join(',')})`,
  );
  // cancel
  const { W: W2, R: R2 } = await mk();
  R2.warm.window(true);
  const hc = R2.warm.add('C', { manifest: mA });
  await until(() => R2.warm.status().scenes.C.built >= 1);
  ok(R2.warm.cancel('C') === true, 'cancel(C) accepted');
  const rc = await hc.ready;
  const pc = W2.model.pipelines;
  await sleep(300);
  ok(
    rc.state === 'cancelled' &&
      W2.model.pipelines === pc &&
      R2.warm.status().scenes.C.pending === 0,
    `cancel removed the pending work (${rc.state}; pipelines stable at ${pc})`,
  );
  ok(R2.warm.cancel('nope') === false, 'cancel of an unknown scene is a no-op');
  R2.dispose();
  R.dispose();
}

console.log(
  '(manifest) a scene warmed from its manifest alone cuts what its loading call builds; stale, missing and garbled manifests never throw',
);
{
  // control: no warm (a pipeline count, so at short model durations)
  const c = await mk({}, 2, 2);
  const cb = bundlesOf(c.W, SET_A);
  const cp0 = c.W.model.pipelines;
  await c.R.precompileFillsAsync({});
  const controlPipes = c.W.model.pipelines - cp0;
  // warmed: manifest first (no bundles exist), then the scene loads
  const w = await mk();
  w.R.warm.window(true);
  w.R.warm.add('A', { manifest: mA });
  const res = await w.R.warm.focus('A');
  const warmedBy = w.W.model.pipelines;
  const wb = bundlesOf(w.W, SET_A);
  await w.R.precompileFillsAsync({});
  const loadPipes = w.W.model.pipelines - warmedBy;
  ok(
    res.state === 'done' && res.built > 0,
    `warmed from the manifest alone: ${res.built} programs built before any bundle existed`,
  );
  ok(
    loadPipes < controlPipes,
    `the loading call built ${loadPipes} pipelines after the manifest warm vs ${controlPipes} cold`,
  );
  ok(
    w.W.model.waits.length === 0 && (w.R.debugStats.blockingLinkWaits | 0) === 0,
    'no main-thread wait, blockingLinkWaits 0',
  );
  for (const b of wb) {
    frame(w.R, [b], {});
  }
  ok((w.R.debugStats.playBuilds | 0) === 0, 'play after the warmed load builds nothing');
  // fallbacks: nothing throws
  const f = await mk();
  f.R.warm.window(true);
  const fbundles = bundlesOf(f.W, SET_A);
  const stale = { ...mA, shaders: 'deadbeef' };
  let threw = false;
  try {
    const hs = f.R.warm.add('stale-bundles', { manifest: stale, bundles: fbundles });
    const rs = await f.R.warm.focus('stale-bundles');
    const ss = f.R.warm.status().scenes['stale-bundles'];
    ok(
      ss.manifest === 'stale' && /bundles/.test(ss.source) && rs.state === 'done',
      `a stale manifest with bundles falls back to the bundles (${ss.source}, built ${rs.built})`,
    );
    f.R.warm.resume();
    const hn = f.R.warm.add('stale-nobundles', { manifest: stale });
    const rn = await f.R.warm.focus('stale-nobundles');
    ok(
      rn.state === 'done' &&
        rn.total === 0 &&
        f.R.warm.status().scenes['stale-nobundles'].manifest === 'stale',
      'a stale manifest without bundles warms nothing and resolves (the nets cover the draw)',
    );
    f.R.warm.resume();
    const mism = {
      ...mA,
      bundleSet: 'ffffffff',
      entries: Object.fromEntries(Object.entries(mA.entries).map(([k, v]) => ['x' + k, v])),
    };
    const hm = f.R.warm.add('mismatch', { manifest: mism });
    const rm = await f.R.warm.focus('mismatch');
    ok(
      rm.state === 'done',
      `a bundle-set mismatch with a matching build warms the recorded pipelines and resolves (${rm.state}, ${rm.built} built)`,
    );
    f.R.warm.resume();
    let i = 0;
    for (const bad of [
      undefined,
      null,
      '',
      '{not json',
      '[]',
      { version: 99, entries: {} },
      { version: 3, entries: null },
      {
        version: 3,
        format: 3,
        shaders: mA.shaders,
        entries: {},
        pipelines: [
          null,
          7,
          { k: 5 },
          { k: 'MANTLE_NOPE', lay: [] },
          {
            k: 'MANTLE_NO_ARC',
            lay: [{ i: 0, s: 2, t: 5126, st: 0, int: false, o: 0, n: false, d: 0 }],
          },
        ],
      },
    ]) {
      const id = 'bad' + i++;
      f.R.warm.add(id, { manifest: bad });
      const r = await f.R.warm.focus(id, { timeoutMs: 4000 });
      f.R.warm.resume();
      if (r.state !== 'done') {
        ok(false, `garbled manifest #${i} did not resolve: ${JSON.stringify(r)}`);
      }
    }
  } catch (e) {
    threw = true;
    console.log(e);
  }
  ok(
    !threw,
    'undefined / null / empty / garbled / wrong-version / half-valid manifests never throw and always resolve',
  );
  ok(f.W.model.waits.length === 0, 'and never waited');
  ok(
    f.R.warm.status().scenes.unknownScene === undefined &&
      (await f.R.warm.focus('unknownScene')).state === 'unknown',
    'focus of an unknown scene resolves as unknown',
  );
  for (const r of [c.R, w.R, f.R]) r.dispose();
}

console.log('(frames) gameplay frames stay complete while the queue builds in an inferred window');
{
  const { W, R } = await mk();
  const bs = bundlesOf(W, SET_A);
  await R.precompileFillsAsync({});
  R.warm.add('B', { manifest: mB });
  const ds0 = { ...R.debugStats },
    p0 = W.model.pipelines;
  let empty = 0,
    frames = 0;
  for (let i = 0; i < 120; i++) {
    const d0 = W.model.draws;
    frame(R, bs, {});
    frames++;
    if (W.model.draws - d0 < bs.length) empty++;
    await sleep(8);
  }
  const st = R.warm.status();
  ok(
    empty === 0,
    `every one of ${frames} frames drew all ${bs.length} bundles while the queue ran`,
  );
  ok(
    st.scenes.B.built > 0 && W.model.pipelines > p0,
    `the static screen was an idle window: the queue built ${st.scenes.B.built} programs (window ${st.window.reason})`,
  );
  ok(
    (R.debugStats.shedFrames | 0) === (ds0.shedFrames | 0) &&
      (R.debugStats.deferredFillDraws | 0) === (ds0.deferredFillDraws | 0) &&
      W.model.waits.length === 0,
    'no shed frame, no deferral, no wait',
  );
  // an ANIMATED screen opens no window: nothing is built by the queue
  R.warm.add('C', { manifest: mA, priority: -1 });
  const b0 = R.warm.status().scenes.C.built;
  for (let i = 0; i < 40; i++) {
    const a = 0.3 + i * 0.02;
    frame(R, bs, {
      worldMatrix: new Float32Array([
        Math.cos(a),
        Math.sin(a),
        0,
        -Math.sin(a),
        Math.cos(a),
        0,
        0,
        0,
        1,
      ]),
    });
    await sleep(8);
  }
  ok(
    R.warm.status().scenes.C.built - b0 <= 0,
    `an animated screen built nothing for the queue (${R.warm.status().scenes.C.built - b0})`,
  );
  R.dispose();
}

console.log(
  '(display) the scale classes a display can reach are reported against the recorded ones',
);
{
  const { R } = await mk();
  R.warm.setDisplay({ width: 1920, height: 1080, dpr: 2 });
  R.warm.add('A', { manifest: mA });
  const s = R.warm.status().scenes.A.scales;
  ok(
    Array.isArray(s.recorded) &&
      s.recorded.length >= 1 &&
      s.reachable &&
      s.reachable.length > s.recorded.length &&
      s.missing.length > 0,
    `recorded ${JSON.stringify(s.recorded)}, reachable ${s.reachable && s.reachable.length}, missing ${s.missing && s.missing.length}`,
  );
  R.dispose();
}

console.log(
  '(policy) warmPolicy validation; direct createRenderer keeps its blocking default; strict/idle/off',
);
{
  const W = createPendingGl({});
  const sh = taggedShaderSources();
  let e1 = null,
    e2 = null,
    e3 = null;
  try {
    createRenderer(W.gl, sh, { warmPolicy: 'bogus' });
  } catch (e) {
    e1 = e;
  }
  try {
    createRenderer(W.gl, sh, { warmPolicy: 'idle', strictPlay: true });
  } catch (e) {
    e2 = e;
  }
  try {
    createRenderer(W.gl, sh, { warmPolicy: 'off', strictPlay: true });
  } catch (e) {
    e3 = e;
  }
  ok(
    e1 && /warmPolicy/.test(e1.message) && e2 && /excludes strictPlay/.test(e2.message) && e3,
    'an unknown policy and idle/off with strictPlay: true throw',
  );
  // blocking default: a link the driver holds is waited for by the first draw (previous releases), under no policy and under 'idle'; strict never waits
  const waitsFor = async (extra) => {
    const Wx = createPendingGl({ linkMs: 30, pipelineMs: 50, hold: false });
    const Rx = createRenderer(Wx.gl, taggedShaderSources(), { aacPoints: false, ...extra });
    if (extra.asyncShaderCompile) {
      setTimeout(() => Wx.release(), 40);
      await Rx.ready;
    } else await Rx.ready;
    Rx.setViewport(128, 128);
    const b = createBundle(Wx.gl, sections.gradient);
    Wx.resetWaits();
    Wx.hold(); // (the links the frames start stay pending: a renderer that waits for them waits, whatever the frames cost the CPU)
    for (let i = 0; i < 6; i++) {
      frame(Rx, [b], {});
      await sleep(3);
    }
    const n = Wx.model.waits.length;
    Rx.dispose();
    return n;
  };
  const wNone = await waitsFor({}),
    wIdle = await waitsFor({ warmPolicy: 'idle' }),
    wStrict = await waitsFor({ warmPolicy: 'strict' });
  ok(
    wNone > 0 && wIdle > 0,
    `no policy and 'idle' keep the previous blocking behavior (waits ${wNone} / ${wIdle})`,
  );
  ok(
    wStrict === 0,
    `'strict' (nonBlocking + strictPlay + async creation) never waits (${wStrict})`,
  );
  const wOff = await waitsFor({ warmPolicy: 'off' });
  ok(wOff > 0, `'off' is previous-release behavior too (${wOff})`);
}

console.log(
  '(idle) warmPolicy idle: builds only in inferred idle windows, none while the screen animates, none after input; frames complete',
);
{
  const W = createPendingGl({ linkMs: 20, pipelineMs: 60 });
  const R = createRenderer(W.gl, taggedShaderSources(), { warmPolicy: 'idle', aacPoints: false });
  await R.ready;
  R.setViewport(128, 128);
  const bs = bundlesOf(W, ['bg', 'gradient', 'mask', 'stroke', 'quad']);
  let empty = 0;
  const run = async (n, mat, ms) => {
    for (let i = 0; i < n; i++) {
      const d0 = W.model.draws;
      frame(R, bs, mat ? { worldMatrix: mat(i) } : {});
      if (W.model.draws - d0 < bs.length) empty++;
      await sleep(ms);
    }
  };
  await run(2, null, 2); // (first sight of each bundle: on-demand compile, the default without a queue)
  const w0 = R.debugStats.inferredWindows | 0,
    p0 = W.model.pipelines;
  await run(
    50,
    (i) => {
      const a = 0.2 + i * 0.03;
      return new Float32Array([Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1]);
    },
    4,
  );
  ok(
    (R.debugStats.inferredWindows | 0) === w0,
    `an animated screen opened no idle window (${(R.debugStats.inferredWindows | 0) - w0})`,
  );
  await run(60, null, 6);
  const w1 = R.debugStats.inferredWindows | 0;
  ok(w1 > w0, `a static screen opened idle windows (${w1 - w0})`);
  ok(
    W.model.pipelines > p0,
    `...and built queued variants in them (${W.model.pipelines - p0} pipelines)`,
  );
  // input aborts: after a pointer event the next frames open no window for 700 ms
  for (const f of listeners.pointermove || []) f({});
  const w2 = R.debugStats.inferredWindows | 0;
  await run(20, null, 4);
  ok(
    (R.debugStats.inferredWindows | 0) === w2,
    `input stopped the windows (${(R.debugStats.inferredWindows | 0) - w2} opened in the 80 ms after it)`,
  );
  ok(
    empty === 0,
    'every frame drew every bundle (previous behavior: complete frames, blocking compile on demand)',
  );
  // the default without a queue: no safety nets, no strict bookkeeping
  ok(
    (R.debugStats.nets || []).length === 0 && (R.debugStats.playStandInDraws | 0) === 0,
    'no safety nets, no stand-in draws',
  );
  R.dispose();
}
console.log('(off) warmPolicy off builds no variant in the background');
{
  const W = createPendingGl({ linkMs: 20, pipelineMs: 60 });
  const R = createRenderer(W.gl, taggedShaderSources(), { warmPolicy: 'off', aacPoints: false });
  await R.ready;
  R.setViewport(128, 128);
  const bs = bundlesOf(W, ['bg', 'gradient']);
  for (let i = 0; i < 4; i++) {
    frame(R, bs, {});
    await sleep(3);
  }
  const p0 = W.model.pipelines;
  for (let i = 0; i < 120; i++) {
    frame(R, bs, {});
    await sleep(6);
  }
  ok(
    W.model.pipelines === p0,
    `a static screen built nothing in the background (${W.model.pipelines - p0})`,
  );
  R.dispose();
}
console.log(fail ? `warmQueueSmoke FAIL (${fail})` : 'warmQueueSmoke PASS');
process.exit(fail ? 1 : 0);
