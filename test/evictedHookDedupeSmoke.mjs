// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { installGpuThrottle } from './_gpuThrottle.mjs';
// evictedHookDedupeSmoke -- drawing more bundles than the eight-handle cache holds costs O(1) bookkeeping per eviction.
// A WeakRef added per eviction and the whole set swept on each one past 256 entries would cost a scene of hundreds of
// bundles (the sprites of a scene) ~12% of the main thread. So _hookEvicted keeps one entry per bundle, and the sweep runs
// when the set has doubled.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = (i) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="${i % 20}" y="2" width="8" height="8" fill="#c33"/></svg>`;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setViewport(256, 256); gl.viewport(0, 0, 256, 256);
const SVG = ${SVG.toString()};
const N = 400, ROUNDS = 5, bs = [];
for (let i = 0; i < N; i++) bs.push(createBundle(gl, await importSvg(SVG(i), { preserveViewport: true })));
let made = 0; const RealWR = globalThis.WeakRef;
globalThis.WeakRef = class extends RealWR { constructor(x) { super(x); if (new Error().stack.includes('_hookEvicted')) made++; } };
const t0 = performance.now();
for (let r = 0; r < ROUNDS; r++) for (let i = 0; i < N; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(bs[i]); R.endFrame(); }
globalThis.WeakRef = RealWR;
window.__r = { made, N, draws: N * ROUNDS, ms: performance.now() - t0 };
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await installGpuThrottle(page);
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const r = await page.evaluate(() => window.__r);
  if (r.made === 0) fail('no eviction hooked a bundle: the smoke proves nothing');
  else if (r.made > r.N)
    fail(`${r.made} WeakRefs for ${r.N} bundles over ${r.draws} draws: one per eviction`);
  else
    console.log(
      `ok ${r.made} WeakRefs for ${r.N} bundles over ${r.draws} draws (${r.ms.toFixed(0)} ms)`,
    );
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nevictedHookDedupeSmoke: one eviction hook per bundle');
