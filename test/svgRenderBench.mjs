// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgRenderBench.mjs — measure per-frame render throughput.
//
// Drives a real headless WebGL2 context via Puppeteer + mantleDemo.html,
// loads tiger.svg, and times N calls to renderer.render(). Reports
// avg/min/max CPU-submit ms per frame plus a wall-clock total bounded
// by gl.finish().
//
// CPU-submit time = time spent on JS in renderer.render() + driver
// command-queue insertion. Wall time at the end of the loop adds the
// remaining GPU drain.
//
// Usage:
//   node test/svgRenderBench.mjs                  steady state (the default; see BENCH_MODE below)
//   BENCH_MODE=cold node test/svgRenderBench.mjs  the first frames after load
//
// Outputs a table per fixture: shapes, hybrid verts, avg/min/max CPU
// ms per frame, total wall ms.
//
// THROTTLED (test/_gpuThrottle.mjs). Warm-up and timed frames run in
// bursts, each ended by a 1-px readback (a real sync -- gl.finish() is not one on ANGLE/Metal) and followed by an idle
// of at least its own length (MANTLE_GPU_DUTY, default 0.5). A burst of fast frames is at least 64 of them, so the
// renderer still sees the run of consecutive fast frames it needs before it warms a variant's pipeline (45); slow
// frames are never stretched past 4 x MANTLE_GPU_BURST_MS. wall(ms) is the SUM of the timed bursts' own times, idle
// excluded. The run is capped at MANTLE_GPU_WALL_MS.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { example, requireAsset } from './_assets.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// BENCH_ROOT serves ANOTHER tree's mantleDemo.html and src (another checkout's js.kontek.mantle, e.g. an earlier
// release) through this harness, so two releases are timed by one script. The fixtures still come from
// this tree's examples/.
const ROOT = process.env.BENCH_ROOT
  ? path.resolve(process.env.BENCH_ROOT)
  : path.resolve(__dirname, '..');

// tiger is the default fixture; requireAsset stops before the browser starts when it is missing.
// BENCH_ASSETS=tiger,_bench/<asset> names the fixtures. A claim about a CORPUS geomean needs
// more than one fixture.
const FIXTURES = (process.env.BENCH_ASSETS || 'tiger').split(',').map((n) => ({
  label: n,
  svgPath: requireAsset(example(n.endsWith('.svg') ? n : n + '.svg')),
}));

// BENCH_MODE says WHICH REGIME is timed, and every line is labeled with it (timing the universal fill program,
// which a renderer draws only until it has warmed the variant compiled for the bundle, can read several times slower
// on simple art).
//
//   steady (default) -- what an app gets once it is running: precompileFills() at load, the bundle's async builds
//          settled (occupancy grids, occlusion cull), its Loop-Blinn build awaited (awaitLbReady; one frame starts
//          it), precompileFills() again (a build that lands can change the variant), 200 warm-up frames, then more
//          warm-up bursts until the fill program bound is the variant (up to 8 s). A line whose timed frames are not
//          all on a variant is marked NOT STEADY.
//   cold   -- the first frames after load: no precompile, no settle, no LB wait,
//          10 warm-up frames. The renderer is still on the universal program and has not built the variant's pipeline,
//          so this is NOT steady state -- the number to quote for load / first-seconds cost only.
//
// The knobs below override the mode's value one at a time:
//   BENCH_WARMUP=<n>      warm-up frames before the timed ones (steady 200, cold 10). The frames run in throttled
//                         bursts; anything the renderer does in frame slack happens only as their wall time allows.
//   BENCH_PRECOMPILE=0|1  renderer.precompileFills() before the warm-up (steady 1, cold 0; a tree without it, which
//                         compiles its variant synchronously at the first draw, is unaffected).
//   BENCH_SETTLE=0|1      wait, drawing nothing, for the occupancy grids and the occlusion cull (steady 1, cold 0).
//   BENCH_LBREADY=0|1     one frame, then await the Loop-Blinn build, then precompileFills() again (steady 1, cold 0).
//   BENCH_PREPASS=0       the opaque depth prepass off for an A/B, by pinning the bundle's cached prepass plan to
//                         "none" (harness-only; a tree without the prepass ignores it).
const MODE = process.env.BENCH_MODE || 'steady';
if (MODE !== 'steady' && MODE !== 'cold') {
  console.error(`BENCH_MODE=${MODE}: steady or cold`);
  process.exit(2);
}
const STEADY = MODE === 'steady';
const envBit = (k, d) =>
  process.env[k] === undefined || process.env[k] === '' ? d : process.env[k] === '1';
const N_WARMUP = +(process.env.BENCH_WARMUP || (STEADY ? 200 : 10));
const PRECOMPILE = envBit('BENCH_PRECOMPILE', STEADY);
const SETTLE = envBit('BENCH_SETTLE', STEADY);
const LBREADY = envBit('BENCH_LBREADY', STEADY);
const PREPASS = process.env.BENCH_PREPASS !== '0';
const N_RUNS = 500;

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 800 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail/i.test(t)) console.log('  [console]', t);
});

const cap = capWallTime('svgRenderBench', async () => {
  await browser.close();
  server.close();
});
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 15000,
  polling: 100,
});
await installGpuThrottle(page);

console.log(
  `${'fixture'.padEnd(20)}  ${'shapes'.padStart(7)}  ${'verts'.padStart(7)}  ${'avg(ms)'.padStart(8)}  ${'min(ms)'.padStart(8)}  ${'max(ms)'.padStart(8)}  ${'wall(ms)'.padStart(9)}  ${'prog'.padStart(4)}  ${'prepass'.padStart(7)}`,
);
console.log('-'.repeat(100));
console.log(
  `MODE ${MODE}${
    STEADY
      ? ' -- steady state: precompiled, settled, warm'
      : ' -- the first frames after load, NOT steady state: ' +
        'the renderer is still on the universal fill program (quote this for load cost only)'
  }`,
);
console.log(
  `root=${ROOT} warmup=${N_WARMUP} precompile=${PRECOMPILE ? 1 : 0} settle=${SETTLE ? 1 : 0} lbready=${LBREADY ? 1 : 0} prepass=${PREPASS ? 1 : 0}`,
);
console.log(
  'prog: fill program at the first and last timed frame, V a variant, U the universal one (- not reported);',
);
console.log('prepass: opaque depth prepasses per timed frame.');
console.log(gpuThrottleBanner());

for (const fx of FIXTURES) {
  const svgText = readFileSync(fx.svgPath, 'utf8');

  const result = await page.evaluate(
    async (svgText, N_WARMUP, N_RUNS, PRECOMPILE, SETTLE, PREPASS, LBREADY, STEADY) => {
      const { importSvg, createBundle } = await import('/src/index.js');

      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;

      // Build the bundle once; we time only renderer.render().
      const sections = await importSvg(svgText);
      const bundle = createBundle(gl, sections);
      renderer.setBundle(bundle);
      // PRECOMPILE: the documented load-time warm (renderer.precompileFills: link the bundle's fill variant and build
      // its pipeline now), so the timed frames draw with the program the bundle settles on rather than the universal
      // one it starts on.
      if (PRECOMPILE && renderer.precompileFills) renderer.precompileFills();
      let settled = null;
      if (SETTLE) {
        const t0 = performance.now();
        const pending = () =>
          bundle._occupancyBuildPending ||
          bundle._occlusionCullPending ||
          // A tree that fills its grids in idle callbacks has no pending flag: wait for the flag it flips.
          (sections.pendingOccupancy &&
            sections.pendingOccupancy.length &&
            !bundle.hasOccupancy &&
            performance.now() - t0 < 3000);
        while (pending() && performance.now() - t0 < 15000)
          await new Promise((r) => setTimeout(r, 10));
        settled = { ms: performance.now() - t0, occ: !!bundle.hasOccupancy };
      }
      if (!PREPASS) {
        Object.defineProperty(bundle, '_opaquePrepassPlan', {
          configurable: true,
          set() {},
          get: () => ({ none: true, geomGen: bundle._geomGen | 0, cullGen: bundle._cullGen | 0 }),
        });
      }
      const stats = () => {
        try {
          return renderer.debugStats || {};
        } catch {
          return {};
        }
      };
      const progAt = (st) =>
        !('drawnFillVariantKey' in st) ? '-' : st.drawnFillVariantKey ? 'V' : 'U';
      const rb = new Uint8Array(4);
      const sync = async () => {
        gl.flush();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rb);
      };
      // LBREADY: one frame starts the draw-time Loop-Blinn build; wait for it (a tree with awaitLbReady), then warm
      // again, because a build that lands can change the variant the bundle needs.
      let lbReady = null;
      if (LBREADY && renderer.awaitLbReady) {
        renderer.render();
        await sync();
        try {
          lbReady = !!(await renderer.awaitLbReady(bundle, 20000));
        } catch {
          lbReady = false;
        }
        if (PRECOMPILE && renderer.precompileFills) renderer.precompileFills();
      }

      // Warmup: get shaders, VBOs, textures, FBOs resident, JIT settled. In throttled bursts (>= 64 fast frames).
      if (N_WARMUP > 0) await window.__gpuFrames(N_WARMUP, () => renderer.render(), sync, 64);
      // STEADY: keep warming, in throttled 16-frame bursts, until the bound fill program is the variant (up to 8 s): a
      // variant bound in the middle of the timed frames would split them between two programs.
      if (STEADY && progAt(stats()) === 'U') {
        const t0 = performance.now();
        while (progAt(stats()) === 'U' && performance.now() - t0 < 8000)
          await window.__gpuFrames(16, () => renderer.render(), sync, 16);
      }

      // Which fill program the timed frames start and end on (a variant, or the universal program), and how many
      // opaque prepasses they ran -- so a line says what it timed. Read outside the timed loop.
      const s0 = stats();
      const prog0 = progAt(s0),
        prepass0 = s0.opaquePrepassCount;
      const times = new Array(N_RUNS);
      // Each burst ends in the 1-px readback, so wall-time covers the GPU work too; wallMs sums the bursts (no idle).
      const timed = await window.__gpuFrames(
        N_RUNS,
        (i) => {
          const t0 = performance.now();
          renderer.render();
          times[i] = performance.now() - t0;
        },
        sync,
        64,
      );
      const wallMs = timed.ms;
      const s1 = stats();
      const prog = prog0 + progAt(s1);
      const prepass =
        prepass0 == null ? '-' : ((s1.opaquePrepassCount - prepass0) / N_RUNS).toFixed(2);

      const shapes = bundle.numShapes;
      const verts = bundle.hybridVerts || 0;
      bundle.dispose();

      return { times, wallMs, shapes, verts, prog, prepass, settled, lbReady };
    },
    svgText,
    N_WARMUP,
    N_RUNS,
    PRECOMPILE,
    SETTLE,
    PREPASS,
    LBREADY,
    STEADY,
  );

  const times = result.times.slice().sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const min = times[0];
  const max = times[times.length - 1];

  console.log(
    `${fx.label.padEnd(20)}  ${String(result.shapes).padStart(7)}  ${String(result.verts).padStart(7)}  ` +
      `${avg.toFixed(3).padStart(8)}  ${min.toFixed(3).padStart(8)}  ${max.toFixed(3).padStart(8)}  ` +
      `${result.wallMs.toFixed(1).padStart(9)}  ${result.prog.padStart(4)}  ${String(result.prepass).padStart(7)}` +
      (result.settled
        ? `  settled ${result.settled.ms.toFixed(0)}ms occ=${result.settled.occ ? 1 : 0}`
        : '') +
      (result.lbReady !== null && result.lbReady !== undefined
        ? `  lbReady=${result.lbReady ? 1 : 0}`
        : '') +
      // The regime this line timed. A steady line whose timed frames were not all on a variant did not time steady state.
      (!STEADY
        ? '  [cold: NOT steady state]'
        : /U/.test(result.prog)
          ? '  [NOT STEADY: universal program timed]'
          : '  [steady]'),
  );
}

cap.clear();
await browser.close();
server.close();

console.log();
console.log('SVG-RENDER-BENCH DONE');
