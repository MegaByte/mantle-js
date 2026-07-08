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
//   node test/svgRenderBench.mjs
//
// Outputs a table per fixture: shapes, hybrid verts, avg/min/max CPU
// ms per frame, total wall ms.

import { readFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FIXTURES = [
  { label: 'tiger', svgPath: path.join(ROOT, 'examples/tiger.svg') },
];

const N_WARMUP = 10;
const N_RUNS   = 500;

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
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 800 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => {
  const t = m.text();
  if (/error|fail/i.test(t)) console.log('  [console]', t);
});

await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 15000 });

console.log(`${'fixture'.padEnd(20)}  ${'shapes'.padStart(7)}  ${'verts'.padStart(7)}  ${'avg(ms)'.padStart(8)}  ${'min(ms)'.padStart(8)}  ${'max(ms)'.padStart(8)}  ${'wall(ms)'.padStart(9)}`);
console.log('-'.repeat(85));

for (const fx of FIXTURES) {
  if (!existsSync(fx.svgPath)) {
    console.log(`${fx.label.padEnd(20)}  SKIP (missing: ${fx.svgPath})`);
    continue;
  }
  const svgText = readFileSync(fx.svgPath, 'utf8');

  const result = await page.evaluate(async (svgText, N_WARMUP, N_RUNS) => {
    const { importSvg, createBundle } = await import('/src/index.js');

    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;

    // Build the bundle once; we time only renderer.render().
    const sections = await importSvg(svgText);
    const bundle = createBundle(gl, sections);
    renderer.setBundle(bundle);

    // Warmup: get shaders, VBOs, textures, FBOs resident, JIT settled.
    for (let i = 0; i < N_WARMUP; i++) renderer.render();
    gl.finish();

    const times = new Array(N_RUNS);
    const wall0 = performance.now();
    for (let i = 0; i < N_RUNS; i++) {
      const t0 = performance.now();
      renderer.render();
      times[i] = performance.now() - t0;
    }
    // Drain pipeline so wall-time covers the GPU work too.
    const rb = new Uint8Array(4);
    gl.flush();
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rb);
    const wallMs = performance.now() - wall0;

    const shapes = bundle.numShapes;
    const verts  = bundle.hybridVerts || 0;
    bundle.dispose();

    return { times, wallMs, shapes, verts };
  }, svgText, N_WARMUP, N_RUNS);

  const times = result.times.slice().sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const min = times[0];
  const max = times[times.length - 1];

  console.log(
    `${fx.label.padEnd(20)}  ${String(result.shapes).padStart(7)}  ${String(result.verts).padStart(7)}  ` +
    `${avg.toFixed(3).padStart(8)}  ${min.toFixed(3).padStart(8)}  ${max.toFixed(3).padStart(8)}  ` +
    `${result.wallMs.toFixed(1).padStart(9)}`
  );
}

await browser.close();
server.close();

console.log();
console.log('SVG-RENDER-BENCH DONE');
