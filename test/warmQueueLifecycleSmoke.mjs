// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmQueueLifecycleSmoke -- the warm queue's lifecycle: nothing left waiting, wedged or held.
//
// Pinned: cancel of the focused scene leaves the others pumped; a game's load promise settles on a cancel or a dispose rather than at its timeout (180 s by default), and `add` after a dispose
// settles; a finished scene releases its bundles; onResize({ block }) does not spin on a lost context to its deadline; a fractional warmQueueMaxLinks does not floor to 0 and refuse every link;
// a null in a manifest's scales does not make status() throw. The queue's own state machine against a scripted executor, and a real renderer with a real collection for the references.
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
import v8 from 'node:v8';
import vm from 'node:vm';
import { attachWarmQueue } from '../src/renderer/warmQueue.js';
import { attachWarmManifest } from '../src/renderer/warmManifest.js';
const DEADLINE = 60000; // (each wait ends on its condition; only the defect reaches this)
const race = (p, ms) =>
  Promise.race([
    p.then((v) => ({ resolved: true, v })),
    sleep(ms).then(() => ({ resolved: false })),
  ]);
function mkQ(o = {}) {
  const log = { link: [], pipe: [] };
  const linked = new Map(),
    built = new Set();
  const ex = {
    has: (k) => linked.has(k),
    link: (k) => {
      log.link.push(k);
      linked.set(k, 'ready');
      return true;
    },
    linked: (k) => linked.get(k) || 'failed',
    built: (k) => built.has(k),
    pipeline: (it) => {
      log.pipe.push(it.k);
      built.add(it.k);
      return 'built';
    },
    bundle: () => 'built',
    release: () => true,
    keyOfBundle: () => null,
    exhaustiveStates: () => [null],
    ...(o.ex || {}),
  };
  const Q = {
    opts: o.opts || {},
    shaderSources: { fillVert: 'v', fillFrag: 'f' },
    _wq: ex,
    _idleNow: () => false,
    _gpuClear: () => true,
    ...(o.R || {}),
  };
  attachWarmManifest(Q);
  const warm = attachWarmQueue(Q, (b) => b);
  warm.setInference(false);
  const manifest = (keys, vc) => ({
    version: 3,
    format: 3,
    shaders: Q._wmShaderHash(),
    entries: {},
    variants: keys.map((k) => ({ k, vc })),
    pipelines: keys.map((k) => ({
      k,
      lay: [[0, 2, 0x1406, 0, 8, 0]],
      tex: true,
      inst: false,
      blend: null,
      cmask: 15,
      vc,
    })),
    scales: [],
  });
  return { Q, warm, log, manifest };
}
console.log('(cancel) canceling the focused scene lets the others run');
{
  const { warm, log, manifest } = mkQ();
  warm.window(true);
  warm.add('A', { manifest: manifest(['a']) });
  const b = warm.add('B', { manifest: manifest(['b1', 'b2']) });
  await warm.focus('A');
  warm.cancel('A');
  const r = await race(b.ready, DEADLINE);
  ok(
    r.resolved && log.pipe.filter((k) => k[0] === 'b').length === 2,
    `scene B finished (${warm.status().scenes.B.state}, ${log.pipe.filter((k) => k[0] === 'b').length} of 2 pipelines)`,
  );
}
console.log('(cancel) a game waiting on a canceled scene is told');
{
  const { warm, manifest } = mkQ({
    ex: { linked: () => 'linking', link: () => true, has: () => true },
  });
  warm.add('game', { manifest: manifest(['a']) });
  const start = warm.gameStart('game', { viewport: [512, 512], timeoutMs: Infinity });
  await sleep(20);
  warm.cancel('game');
  ok((await race(start, DEADLINE)).resolved, 'the gameStart promise settled');
}
console.log('(dispose) nothing waits on a disposed queue');
{
  const { Q, warm, manifest } = mkQ({
    ex: { linked: () => 'linking', link: () => true, has: () => true },
  });
  warm.add('game', { manifest: manifest(['a']) });
  const start = warm.gameStart('game', { viewport: [512, 512], timeoutMs: Infinity });
  const resize = warm.onResize(1024, 1024, { timeoutMs: Infinity });
  await sleep(20);
  Q._warmQueueDispose();
  ok((await race(start, DEADLINE)).resolved, 'gameStart settled');
  ok((await race(resize, DEADLINE)).resolved, 'onResize settled');
  ok(
    (await race(warm.add('late', { manifest: manifest(['z']) }).ready, DEADLINE)).resolved,
    'an add after the dispose settled',
  );
}
console.log("(options and content) a fractional link limit, and a null in a manifest's scales");
{
  const { warm, log, manifest } = mkQ({ opts: { warmQueueMaxLinks: 0.5 } });
  warm.window(true);
  ok(
    (await race(warm.add('s', { manifest: manifest(['a']) }).ready, DEADLINE)).resolved &&
      log.link.length === 1,
    `warmQueueMaxLinks 0.5 still links (${log.link.length})`,
  );
  const q2 = mkQ(),
    m = q2.manifest(['a']);
  m.scales = [null];
  q2.warm.add('s', { manifest: m });
  let threw = null;
  try {
    q2.warm.status();
  } catch (e) {
    threw = e;
  }
  ok(!threw, `status() does not throw${threw ? ': ' + threw.message : ''}`);
}
console.log('(lost context) a blocking resize does not spin on it');
{
  const { warm, manifest } = mkQ({
    R: { _contextLost: true },
    ex: { linked: () => 'linking', link: () => true, has: () => true },
  });
  warm.add('g', { manifest: manifest(['a']) });
  warm.gameStart('g', { viewport: [128, 128] });
  // (no deadline to fall back on: the defect hangs here, and the lane's per-test cap ends it)
  warm.onResize(1024, 1024, { block: true, maxBlockMs: Infinity });
  ok(true, 'it returned');
}
console.log('(references) a finished scene does not keep its bundles alive');
{
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc');
  const { gl, R } = await rig({
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
  });
  R.warm.setInference(false);
  R.warm.window(true);
  const refs = [];
  await (async () => {
    for (let i = 0; i < 4; i++) {
      const b = await bundleOf(
        gl,
        svg(`<path d="M${10 + i} 10 C60 0 90 40 80 90 L20 70Z" fill="#303"/>`),
      );
      refs.push(new WeakRef(b));
      await race(R.warm.add('s' + i, { bundles: [b] }).ready, DEADLINE);
      b.dispose();
    }
  })();
  for (let i = 0; i < 8; i++) {
    gc();
    await sleep(20);
  }
  const alive = refs.filter((r) => r.deref()).length;
  ok(
    alive <= 1,
    `disposed bundles still reachable after a collection: ${alive} of ${refs.length} (the renderer's current bundle may be one)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
