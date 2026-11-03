// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _flagAB — one within-run A/B for one switch: a global, a fill define, or both. It answers every
// OFF switch the same way, so each verdict is comparable.
//
//   GPU=1 ARM_B='{"defines":["MANTLE_SOME_ARM"]}' ROUTE=none KERNEL=slug \
//     node probes/flags/_flagAB.mjs
//   GPU=1 ARM_B='{"globals":{"__MANTLE_DEBUG__":true,"__LB_HULL_TOL_REL":0.0005}}' ROUTE=lb KERNEL=slug node ...
//
// ARM_A defaults to '{}' (what ships). Env: ASSETS, SIZES, FRAMES, REPS, ROUTE, KERNEL.
// A `defines` arm opens the __MANTLE_DEBUG__ gate itself (__MANTLE_FILL_DEFINES reads only under it);
// a `globals` arm that sets a test hook (mantleDebugHook in core/diagnostics.js) must set
// "__MANTLE_DEBUG__": true beside it, or the hook reads as unset and the arm measures the default.
//
// WHAT every ROW HAS TO SURVIVE BEFORE ITS RATIO MEANS ANYTHING (each is a trap this repository
// has paid for):
//   * A FENCE, not gl.finish(): on ANGLE/Metal finish() times the CPU submit.
//   * ABBA order, each arm best-of over both positions, and an A/A floor from A against A'. A fixed
//     A-then-B order reads B slow under any clock or thermal drift.
//   * A discard arm first: a page's first arm reads ~2x.
//   * ink > 0 in every arm: a blank frame is not a time.
//   * THE BOUND VARIANT, not the one asked for: a define the program did not compile reads as "no
//     cost" -- so the B arm's drawnFillVariantKey must contain every define it adds.
//   * PIXELS: arms are compared byte for byte, so a switch claimed exact is checked on the GPU
//     while it is being timed.
//   * A FRESH BUILD PER ARM. The Loop-Blinn mesh cache is module-level and keyed by curve bytes, and
//     it caches Slug verdicts too, so without clearLbMeshCaches() every arm after the first drew the
//     first arm's meshes and a build-time switch read as an exact tie.
//   * A SECOND COMPILE, NOT THE FIRST. On ANGLE/Metal the first renderer compiled from a given shader
//     source is slow for life, and this page keeps one renderer, so an
//     arm whose PROGRAM differs from A's -- a define arm, or a switch that changes which defines a
//     bundle needs -- would be timed on its first compile, biased slow. A precompile pass runs every
//     (asset, size, arm) once, then the timed renderer is a FRESH one (PRECOMPILE=0 skips it).
//   * THE GPU THROTTLE (test/_gpuThrottle.mjs). The timed frames run in bursts of <= MANTLE_GPU_BURST_MS,
//     each fence-synced and followed by an idle of at least its own length (MANTLE_GPU_DUTY, default 0.5),
//     outside the timed region; ms/frame is the bursts' summed time over the frame count, and the GPU
//     timer runs one query per burst, summed (a query spanning an idle would time the idle). The fence
//     is polled with a MessageChannel yield (window.__gpuFence), not setTimeout(1): after an idle every
//     timer is nested and clamps to 4 ms, paid once per burst. The run is capped at MANTLE_GPU_WALL_MS.
//     Run it in the FOREGROUND, one GPU job at a time.
//   * THE ENGINE THE ROUTE NAMES. ROUTE=cpatch waits for the CPatch conversion (awaitEngine) and an
//     arm whose program is not MANTLE_CPATCH is refused; ROUTE=lb refuses one without MANTLE_LB_FILL.
//     An engine that declined draws correctly, which is exactly what makes it read as a result.
import { readFileSync, existsSync } from 'fs';
import { benchNames, BENCH_UNSET } from '../../test/_assets.mjs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIZES = (process.env.SIZES || '256,1024').split(',').map(Number);
const FRAMES = +(process.env.FRAMES || 60);
const REPS = +(process.env.REPS || 3);
const ROUTE = process.env.ROUTE || 'none',
  KERNEL = process.env.KERNEL || 'slug';
const ARM_A = JSON.parse(process.env.ARM_A || '{}'),
  ARM_B = JSON.parse(process.env.ARM_B || '{}');
const CANDIDATES = [
  ['tiger', 'examples/tiger.svg'],
  ['lbMemBudget', 'examples/smoke/lbMemBudget__SVG.svg'],
];
if (!benchNames().length) console.log(BENCH_UNSET);
for (const f of benchNames()) CANDIDATES.push([f, `examples/_bench/${f}.svg`]);
// EXTRA=name:path,... adds assets outside the corpus (a path relative to js.kontek.mantle).
for (const e of (process.env.EXTRA || '').split(',').filter(Boolean)) {
  const [n, rel] = e.split(':');
  CANDIDATES.push([n, rel]);
}
const only = process.env.ASSETS ? new Set(process.env.ASSETS.split(',')) : null;
const ASSETS = CANDIDATES.filter(
  ([n, rel]) => (!only || only.has(n)) && existsSync(path.join(ROOT, rel)),
);
if (!ASSETS.length) {
  console.error('no assets found');
  process.exit(2);
}
// Every global either arm touches is cleared before each arm, so neither inherits the other's.
const KEYS = [
  ...new Set([...Object.keys(ARM_A.globals || {}), ...Object.keys(ARM_B.globals || {})]),
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="2048" height="2048"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { clearLbMeshCaches } from '/src/renderer/morphDraw.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
let R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
// A FRESH RENDERER after a precompile pass, so both arms time SECOND compiles of their programs (on
// ANGLE/Metal the first renderer compiled from a given source is slow for life, and this page keeps
// one renderer, so arms whose programs differ were each timed on a first compile).
window.__fresh = async () => { try { R.dispose(); } catch {} R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready; };
const srcCache = new Map();
const getSvg = async (u) => { if (!srcCache.has(u)) srcCache.set(u, await (await fetch(u)).text()); return srcCache.get(u); };
window.__arm = async (url, size, arm, keys, frames, route, kernel) => {
  for (const k of keys) delete globalThis[k];
  for (const [k, v] of Object.entries(arm.globals || {})) globalThis[k] = v;
  // __MANTLE_FILL_DEFINES is a test hook, read only under __MANTLE_DEBUG__.
  if (arm.defines && arm.defines.length) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__MANTLE_FILL_DEFINES = arm.defines.join(','); }
  else delete globalThis.__MANTLE_FILL_DEFINES;
  R.setFillEngine({ route, kernel });
  clearLbMeshCaches();
  const b = createBundle(gl, await importSvg(await getSvg(url), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (route === 'cpatch' && R.awaitEngine) { try { await R.awaitEngine(b, 'cpatch', 180000); } catch {} }
  else if (R.awaitLbReady) { try { await R.awaitLbReady(b, 60000); } catch {} }
  R.setViewport(size, size); gl.viewport(0, 0, size, size);
  // WAIT FOR THE VARIANT, not for a frame count. Fill variants link asynchronously and the BASE
  // program draws until one has linked and warmed, so a timing taken after a fixed eight frames
  // measured the base program in BOTH arms (the bound key read empty). Draw with real time between
  // frames until a variant is bound, then settle.
  // A variant is served only once it has LINKED and its pipeline has WARMED (psoReady); the warm is
  // requested on a miss and run in frame slack, which a tight probe loop never has. Drive it.
  if (R.prewarmBundle) R.prewarmBundle(b);
  let warmFrames = 0;
  for (; warmFrames < 400; warmFrames++) {
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    if (R.precompileFills) R.precompileFills();
    if (warmFrames >= 8 && R.debugStats.drawnFillVariantKey) break;
    await new Promise((r) => setTimeout(r, 16));
  }
  for (let i = 0; i < 8; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0, h = 2166136261;
  for (let i = 0; i < px.length; i++) { h = Math.imul(h ^ px[i], 16777619); if ((i & 3) < 3 && px[i] < 250) ink++; }
  const key = R.debugStats.drawnFillVariantKey || '';
  const before = Object.assign({}, (R.debugStats.engines || {}).draws || {});
  // THROTTLED: the frames run in fence-synced bursts, each followed by an idle outside the clock
  // (window.__gpuFrames, test/_gpuThrottle.mjs). One timer query per burst, summed, read after the
  // burst's clock stopped; any burst whose query is lost makes the GPU column n/a.
  let q = null, gpuSum = 0, gpuOk = !!ext;
  const timed = await window.__gpuFrames(frames, () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }, async () => {
    if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
    await window.__gpuFence(gl, 15000);   // a MessageChannel poll: a setTimeout poll clamps to 4 ms per burst
  }, {
    begin: () => { if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); } },
    end: async () => {
      if (!q) return;
      for (let i = 0; i < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); i++) await new Promise((r) => setTimeout(r, 5));
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuSum += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      else gpuOk = false;
      gl.deleteQuery(q); q = null;
    },
  });
  const wall = timed.ms / frames;
  const gpu = gpuOk ? gpuSum / frames : -1;
  const after = (R.debugStats.engines || {}).draws || {}, drew = {};
  for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  b.dispose && b.dispose();
  for (const k of keys) delete globalThis[k];
  delete globalThis.__MANTLE_FILL_DEFINES; delete globalThis.__MANTLE_DEBUG__;
  return { wall, gpu, ink, hash: h >>> 0, key, drew, warmFrames };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, {
      'content-type': pp.endsWith('.glsl')
        ? 'text/plain'
        : pp.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/javascript',
    });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
const cap = capWallTime('_flagAB', async () => {
  await br.close();
  server.close();
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 100 });
await installGpuThrottle(pg);

const run = (rel, size, arm) =>
  pg.evaluate(
    (u, s, a, k, f, r, kn) => window.__arm(u, s, a, k, f, r, kn),
    `/${rel}`,
    size,
    arm,
    KEYS,
    FRAMES,
    ROUTE,
    KERNEL,
  );
const best = (xs) => xs.reduce((a, b) => (b.wall < a.wall ? b : a));
if (process.env.PRECOMPILE !== '0') {
  for (const [, rel] of ASSETS)
    for (const size of SIZES) {
      await run(rel, size, ARM_A);
      await run(rel, size, ARM_B);
    }
  await pg.evaluate(() => window.__fresh());
}
await run(ASSETS[0][1], SIZES[0], ARM_A); // discard arm
console.log(
  `flag A/B  route=${ROUTE} kernel=${KERNEL}  A=${JSON.stringify(ARM_A)}  B=${JSON.stringify(ARM_B)}  ${FRAMES} frames x ${REPS} reps, ABBA, fence-synced`,
);
console.log(gpuThrottleBanner());
console.log('  asset         size    A ms     B ms   B/A     A/A    verdict   pixels     program');
let unusable = 0;
for (const [name, rel] of ASSETS)
  for (const size of SIZES) {
    const A1 = [],
      A2 = [],
      B = [];
    for (let i = 0; i < REPS; i++) {
      A1.push(await run(rel, size, ARM_A));
      B.push(await run(rel, size, ARM_B));
      B.push(await run(rel, size, ARM_B));
      A2.push(await run(rel, size, ARM_A));
    }
    const a = best([...A1, ...A2]),
      b = best(B);
    const floor = Math.abs(best(A2).wall - best(A1).wall) / best(A1).wall;
    const why = [];
    if (!a.ink || !b.ink) why.push('BLANK');
    if (!a.key || !b.key) why.push('the BASE program drew (no variant linked within the wait)');
    for (const d of ARM_B.defines || []) if (!b.key.includes(d)) why.push(`B did not bind ${d}`);
    const need = ROUTE === 'cpatch' ? 'MANTLE_CPATCH' : ROUTE === 'lb' ? 'MANTLE_LB_FILL' : null;
    if (need)
      for (const [n, x] of [
        ['A', a],
        ['B', b],
      ])
        if (!x.key.split('|').includes(need))
          why.push(`${n} drew no ${need} program (the ${ROUTE} engine declined or never built)`);
    if (why.length) {
      console.log(
        `  ${name.padEnd(12)}${String(size).padStart(5)}  UNUSABLE: ${why.join('; ')}\n      A bound [${a.key}] drew ${JSON.stringify(a.drew)}\n      B bound [${b.key}] drew ${JSON.stringify(b.drew)}`,
      );
      unusable++;
      continue;
    }
    const r = b.wall / a.wall,
      v = Math.abs(1 - r) <= floor ? 'tie' : r < 1 ? 'B FASTER' : 'B slower';
    const same =
      new Set([...A1, ...A2, ...B].map((x) => x.hash)).size === 1
        ? 'identical'
        : new Set([...A1, ...A2].map((x) => x.hash)).size === 1 &&
            new Set(B.map((x) => x.hash)).size === 1
          ? 'DIFFER'
          : 'unstable';
    // DID THE BOUND PROGRAM CHANGE? A switch that decides a kernel is invisible to the draw tally when
    // the kernel is compiled into the unified draw; the bound key is not.
    const ka = new Set(a.key.split('|')),
      kb = new Set(b.key.split('|'));
    const plus = [...kb].filter((d) => !ka.has(d)),
      minus = [...ka].filter((d) => !kb.has(d));
    const prog =
      plus.length || minus.length
        ? [...plus.map((d) => '+' + d), ...minus.map((d) => '-' + d)].join(' ')
        : 'same';
    console.log(
      `  ${name.padEnd(12)}${String(size).padStart(5)}${a.wall.toFixed(3).padStart(8)}${b.wall.toFixed(3).padStart(9)}${r.toFixed(3).padStart(7)}${(100 * floor).toFixed(1).padStart(7)}%  ${v.padEnd(9)} ${same.padEnd(10)} ${prog}`,
    );
  }
const duty = await pg.evaluate(() => window.__gpuDuty());
console.log(
  `gpu duty over the timed bursts: ${(duty.busy / (duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await br.close();
server.close();
process.exit(unusable ? 1 : 0);
