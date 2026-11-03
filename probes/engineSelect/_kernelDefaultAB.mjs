// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _kernelDefaultAB — the cover-kernel default and its reverse in one run: does letting the renderer CHOOSE its cover kernel
// pay, and what would AAC as the only cover kernel (no Slug in the program) cost or buy?
//
//   GPU=1 node probes/engineSelect/_kernelDefaultAB.mjs
//   GPU=1 SIZES=128,1024 ASSETS=tiger node probes/engineSelect/_kernelDefaultAB.mjs
//   GPU=1 OPTS='{"typeOmit":true}' node probes/engineSelect/_kernelDefaultAB.mjs   (createRenderer options, every arm)
//
// Nothing gives `aacFill` a default, so `preferAac` never runs and the corpus takes Slug at every size.
// `kernel: 'auto'` is the only way to reach AAC selection, the AAC point route and the no-AA
// kernels; `kernel: 'aac'` is the reverse default -- AAC shades every cover row, and
// in a program with no clip, mask or pattern (which call Slug's renderFill for clip coverage) there is no
// Slug in it at all. Arms:
//
//   slug   {route:'auto', kernel:'slug'}  THE PACKAGE DEFAULT
//   auto   {route:'auto', kernel:'auto'}  the renderer chooses; a unified draw's AAC priced by the presence model
//                                         (coverKernelPolicy.aacPresenceTerms), a classic one by the bundle mean
//   aac    {route:'auto', kernel:'aac'}   AAC for every cover row; Slug's kernel not compiled in
//
// AUTO = auto vs slug.   REV = aac vs slug.   A/A = slug twice, the floor for both.
//
// The timing traps this guards against:
//
//   * A FENCE, NOT gl.finish(). On ANGLE/Metal finish() does not block until the GPU has retired
//     the commands, so a loop bounded by it times the CPU SUBMIT (tiger reads 0.022 ms at both 128
//     and 2048 while the GPU timer says 1.6 and 8.2), which can give the OPPOSITE verdict.
//   * A/A FIRST -- a difference inside the A/A spread is not evidence.
//   * THE FIRST ARM ON A PAGE READS ~2x, so a discard arm runs before anything is recorded.
//   * A BLANK FRAME MISPRICES: every arm asserts ink > 0.
//   * A BOUND VARIANT, NOT A FRAME COUNT. A variant is served only once it has LINKED and its
//     pipeline has WARMED, and until then the BASE program (Slug) draws; a fixed 8-frame warm times
//     the base in every arm. Each arm drives prewarmBundle + precompileFills until debugStats.drawnFillVariantKey names a
//     variant, and a row whose key is empty in any arm is REFUSED.
//   * A SECOND COMPILE, NOT THE FIRST: a precompile pass over every (asset, size, arm), then a FRESH
//     renderer, so no arm is timed on the first compile of its program (a first compile differs from a cache hit).
//   * A FENCE BOUNDED BY TIME, with a MessageChannel yield: a count bound with a fast yield gives up
//     after a few ms and times the submit.
//   * THE GPU THROTTLE (test/_gpuThrottle.mjs). The timed frames run in fence-synced bursts of
//     <= MANTLE_GPU_BURST_MS, each followed by an idle of at least its own length (MANTLE_GPU_DUTY,
//     default 0.5) outside the clock; wall/frame is the bursts' summed time over the frame count, the
//     GPU timer is one query per burst, summed. The run is capped at MANTLE_GPU_WALL_MS. Run it in the
//     FOREGROUND, one GPU job at a time.
//   * THE DRAW TALLY IS THE PROOF. Each arm records debugStats.engines.draws. Here the engine set
//     is EXPECTED to differ (that is the whole point), so the tally is REPORTED rather than
//     enforced -- but an `auto` arm whose tally names no aac is an arm that chose Slug anyway, and
//     its time is not evidence about AAC.
import { readFileSync, existsSync } from 'fs';
import { benchNames, BENCH_UNSET } from '../../test/_assets.mjs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIZES = (process.env.SIZES || '128,256,512,1024,2048').split(',').map(Number);
const FRAMES = +(process.env.FRAMES || 60);
const REPS = +(process.env.REPS || 3);
const OPTS = JSON.parse(process.env.OPTS || '{}');

const CANDIDATES = [
  ['tiger', 'examples/tiger.svg'],
  ['lbMemBudget', 'examples/smoke/lbMemBudget__SVG.svg'],
];
if (!benchNames().length) console.log(BENCH_UNSET);
for (const f of benchNames()) {
  CANDIDATES.push([f, `examples/_bench/${f}.svg`]);
}
// TEXT: a Roboto run through createTextBundle (a .ttf path is a text arm; the page builds the run). Glyph rows are
// Slug's best case -- on the CPU emulator AAC costs 1.00-1.68x Slug per fragment on them (_kernelEmuCost) -- so the
// reverse default has to be timed here as well as on the SVGs.
CANDIDATES.push(['text', 'test/font/fixtures/roboto-regular.ttf']);
const only = process.env.ASSETS ? new Set(process.env.ASSETS.split(',')) : null;
const ASSETS = CANDIDATES.filter(
  ([n, rel]) => (!only || only.has(n)) && existsSync(path.join(ROOT, rel)),
);
if (!ASSETS.length) {
  console.error('no assets found (the _bench corpus is gitignored)');
  process.exit(2);
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="2048" height="2048"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createTextBundle, MantleFontAsset } from '/src/index.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const srcCache = new Map();
const getSvg = async (url) => { if (!srcCache.has(url)) srcCache.set(url, await (await fetch(url)).text()); return srcCache.get(url); };
const TEXT = 'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow.';
const fonts = new Map();
const bundleFor = async (url) => {
  if (!url.endsWith('.ttf')) return createBundle(gl, await importSvg(await getSvg(url), { preserveViewport: true }));
  if (!fonts.has(url)) {
    const f = new MantleFontAsset(new Uint8Array(await (await fetch(url)).arrayBuffer()));
    await f.ready;
    fonts.set(url, f);
  }
  // the raw bundle, not the handle, so the arm draws and disposes exactly what an SVG arm does
  return (await createTextBundle(gl, { font: fonts.get(url), text: TEXT, style: { fontSize: 32, fill: [0, 0, 0, 1] } })).bundle;
};

// ONE timed renderer re-decides through the flag, built fresh after the precompile pass below.
const OPTS = ${JSON.stringify(OPTS)};
let R = createRenderer(gl, shaders, OPTS);
await R.ready;
// A FRESH RENDERER after the precompile pass: every variant this run binds was linked once already
// (by the renderer being replaced), so the timed programs are all SECOND compiles of their source.
// The first renderer compiled from a given shader source is slow for life on ANGLE/Metal, and one
// renderer compiles each variant once -- so without this, slug and auto each time a first compile.
window.__fresh = async () => { try { R.dispose(); } catch {} R = createRenderer(gl, shaders, OPTS); await R.ready; };
const _mc = new MessageChannel(); let _res = null; _mc.port1.onmessage = () => { const r = _res; _res = null; if (r) r(); };
const yieldNow = () => new Promise((r) => { _res = r; _mc.port2.postMessage(0); });

window.__arm = async (url, size, mode, frames) => {
  // The size term is NOT under test here; pin it to the default so it cannot drift.
  R.setFillEngine({ route: 'auto', kernel: mode });
  const b = await bundleFor(url);
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) await R.awaitLbReady(b);
  R.setViewport(size, size); gl.viewport(0, 0, size, size);

  // WARM UNTIL A VARIANT IS BOUND, not for a frame count. A variant is
  // served only once it has LINKED and its pipeline has WARMED; on a miss selectFillVariant returns the
  // BASE program (Slug) and requests the warm, which runs in frame slack a tight loop never has. So:
  // prewarmBundle, then draw with real time between frames, driving precompileFills, until
  // debugStats.drawnFillVariantKey is non-empty. A row whose key stays empty is REFUSED below.
  if (R.prewarmBundle) R.prewarmBundle(b);
  let warmFrames = 0;
  for (; warmFrames < 400; warmFrames++) {
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    if (R.precompileFills) R.precompileFills();
    if (warmFrames >= 8 && R.debugStats.drawnFillVariantKey) break;
    await new Promise((r) => setTimeout(r, 16));
  }
  for (let i = 0; i < 8; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const key = R.debugStats.drawnFillVariantKey || '';

  // The frame must actually paint, or the time is the price of a blank canvas.
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) ink++;

  const before = Object.assign({}, ((R.debugStats.engines || {}).draws) || {});
  // THROTTLED: fence-synced bursts, each followed by an idle outside the clock (window.__gpuFrames,
  // test/_gpuThrottle.mjs). One timer query per burst, summed, read after the burst's clock stopped.
  let q = null, gpuSum = 0, gpuOk = !!ext, cpu = 0;
  const timed = await window.__gpuFrames(frames, () => {
    const c0 = performance.now();
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    cpu += performance.now() - c0;
  }, async () => {
    if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
    // gl.finish() IS NOT A GPU SYNC ON ANGLE/METAL. Timing a loop bounded by it measures the CPU
    // SUBMIT and nothing else -- which is how this probe first reported tiger at 0.022 ms/frame for
    // BOTH 128 and 2048 while its own GPU timer read 1.6 ms and 8.2 ms. 60 frames at 8.2 ms cannot
    // fit in the 1.3 ms of wall that implies, and that arithmetic is the tell.
    //
    // A fence is the real sync: clientWaitSync blocks until the GPU has actually retired the
    // commands, so the clock stops when the work is DONE rather than when it was handed over.
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (fence) {
      // BOUNDED BY TIME, not by a count: the yield is not a >=1 ms setTimeout, so a count of 2000 would give up
      // after a few ms and time the SUBMIT (tiger 2048 would read 0.13 ms).
      for (const tEnd = performance.now() + 15000; performance.now() < tEnd;) {
        const st = gl.clientWaitSync(fence, 0, 0);
        if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) break;
        await yieldNow();
      }
      gl.deleteSync(fence);
    } else {
      gl.finish();
    }
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
  const wall = timed.ms;
  const gpuMs = gpuOk ? gpuSum / frames : -1;
  const after = ((R.debugStats.engines || {}).draws) || {};
  const drew = {};
  for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  const picks = R.debugStats.lbAutoPicked | 0;
  const shapes = b.numShapes | 0;          // read BEFORE dispose, which clears the bundle
  b.dispose();
  // THE PROGRAM THAT DREW THE TIMED FRAMES, re-read after them (a variant can bind mid-run).
  const keyAfter = R.debugStats.drawnFillVariantKey || '';
  return { wall: wall / frames, cpu: cpu / frames, gpu: gpuMs, ink, drew, picks, shapes, key, keyAfter, warmFrames };
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
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const cap = capWallTime('_kernelDefaultAB', async () => {
  await br.close();
  server.close();
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 100 });
await installGpuThrottle(pg);

const run = (url, size, mode) =>
  pg.evaluate((u, s, m, f) => window.__arm(u, s, m, f), url, size, mode, FRAMES);
const best = (xs) => xs.reduce((a, b) => (b.wall < a.wall ? b : a));
const same = (a, b) =>
  JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

// PRECOMPILE PASS: every (asset, size, arm) once on a throwaway renderer, then a fresh one -- so every
// timed program is a second compile of its source (PRECOMPILE=0 skips it and times first compiles).
if (process.env.PRECOMPILE !== '0') {
  for (const [, rel] of ASSETS)
    for (const size of SIZES)
      for (const m of ['slug', 'auto', 'aac']) await run(`/${rel}`, size, m);
  await pg.evaluate(() => window.__fresh());
}
// THE DISCARD ARM. The first arm a page runs reads about 2x; it is not reported.
await run(`/${ASSETS[0][1]}`, SIZES[0], 'slug');

console.log(
  `AUTO + REV — ${FRAMES} frames x ${REPS} reps per arm, best-of, fence-synced; wall is the verdict${Object.keys(OPTS).length ? `; renderer opts ${JSON.stringify(OPTS)}` : ''}`,
);
console.log(gpuThrottleBanner());
console.log(
  "  asset        size     slug      auto       aac    slug'   |  A/A  AUTO auto/slug   REV aac/slug",
);
let failures = 0;
for (const [name, rel] of ASSETS) {
  for (const size of SIZES) {
    const S = [],
      AU = [],
      RW = [],
      S2 = [];
    for (let i = 0; i < REPS; i++) {
      S.push(await run(`/${rel}`, size, 'slug'));
      AU.push(await run(`/${rel}`, size, 'auto'));
      RW.push(await run(`/${rel}`, size, 'aac'));
      S2.push(await run(`/${rel}`, size, 'slug'));
    }
    const s = best(S),
      au = best(AU),
      rw = best(RW),
      s2 = best(S2);
    if (!s.ink || !au.ink || !rw.ink) {
      console.log(`  ${name} @${size}: BLANK FRAME — not timed`);
      failures++;
      continue;
    }
    // REFUSE A ROW WHOSE BOUND KEY IS EMPTY: the base program drew, so the arm measured nothing it names.
    const emptyKey = [
      ['slug', s],
      ['auto', au],
      ['aac', rw],
      ["slug'", s2],
    ]
      .filter(([, x]) => !x.key || !x.keyAfter)
      .map(([n]) => n);
    if (emptyKey.length) {
      console.log(
        `  ${name} @${size}: UNUSABLE — empty bound variant key in ${emptyKey.join(',')} (the BASE program drew)`,
      );
      failures++;
      continue;
    }
    const floor = Math.abs(s2.wall - s.wall) / s.wall;
    const d1 = au.wall / s.wall; // < 1 means 'auto' is FASTER than the package default
    const rev = rw.wall / s.wall; // < 1 means AAC-only is FASTER than the package default
    const mark = (r) => (Math.abs(1 - r) <= floor ? 'tie ' : r < 1 ? 'FASTER' : 'slower');
    console.log(
      `  ${name.padEnd(12)}${String(size).padStart(4)}` +
        `${s.wall.toFixed(3).padStart(10)}${au.wall.toFixed(3).padStart(10)}${rw.wall.toFixed(3).padStart(10)}${s2.wall.toFixed(3).padStart(9)}` +
        `   | ${(100 * floor).toFixed(1).padStart(5)}%  ${d1.toFixed(3)} ${mark(d1).padEnd(6)}  ${rev.toFixed(3)} ${mark(rev)}`,
    );
    console.log(
      `               draws slug ${JSON.stringify(s.drew)}  auto ${JSON.stringify(au.drew)}  aac ${JSON.stringify(rw.drew)}`,
    );
    const kd = (x) => {
      const a = new Set(s.keyAfter.split('|')),
        b2 = new Set(x.keyAfter.split('|'));
      const p = [...b2].filter((d) => !a.has(d)).map((d) => '+' + d),
        m = [...a].filter((d) => !b2.has(d)).map((d) => '-' + d);
      return p.length || m.length ? [...p, ...m].join(' ') : 'same program';
    };
    console.log(
      `               bound program vs slug: auto [${kd(au)}]  aac [${kd(rw)}]  (warm frames ${s.warmFrames}/${au.warmFrames}/${rw.warmFrames})`,
    );
    // THE TALLY NAMES THE KERNEL only FOR COVER-ROUTE DRAWS (renderer.js: _engines.drew(kern,
    // ROUTES.COVER)). So a row whose keys are just lb/sdf/stroke emitted NO COVER QUAD AT ALL, and
    // any difference between these arms cannot be AAC-on-cover-rows -- it is the kernel chosen
    // INSIDE the analytic draws.
    const kern = (d) => Object.keys(d).filter((k) => /^(slug|aac|hard)/i.test(k));
    const ks = kern(s.drew),
      ka = kern(au.drew),
      kr = kern(rw.drew);
    console.log(
      `               cover kernels: slug[${ks.join(',') || 'none'}] auto[${ka.join(',') || 'none'}] aac[${kr.join(',') || 'none'}]`,
    );
    if (!ka.length && !kr.length)
      console.log(
        '               note: NO COVER QUADS on this cell — the delta is kernel choice inside the analytic draws, not AAC',
      );
  }
}
console.log(
  failures
    ? `\nKERNEL-DEFAULT AB: ${failures} unusable row(s)`
    : '\nKERNEL-DEFAULT AB: every row timed',
);
const duty = await pg.evaluate(() => window.__gpuDuty());
console.log(
  `gpu duty over the timed bursts: ${(duty.busy / (duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await br.close();
server.close();
process.exit(failures ? 1 : 0);
