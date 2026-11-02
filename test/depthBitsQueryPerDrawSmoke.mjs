// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { installGpuThrottle } from './_gpuThrottle.mjs';
// depthBitsQueryPerDrawSmoke -- the draw never asks the GL context for DEPTH_BITS once per draw.
// gl.getParameter is a synchronous round trip to the GPU process. Reading DEPTH_BITS on every draw of every bundle
// with an overlapping stroke strip (stripModeFor) would stall the whole browser behind the GPU queue for an app that
// requests a depth buffer (hundreds of stroked sprites a frame). The value is fixed for the context's life:
// it is read at most once per renderer.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff"/><path d="M20 20 L 236 236 L 236 20 L 20 236 L 20 100 L 200 100" fill="none" stroke="#000" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const R = createRenderer(gl, shaders, { strokeStrip: 'on' }); if (R.ready) await R.ready;
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true, strokeStrip: true }));
const raw = b && b.bundle && typeof b.setT === 'function' ? b.bundle : b;
if (R.prepareBundle) R.prepareBundle(b);
if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
R.setViewport(256, 256); gl.viewport(0, 0, 256, 256);
if (R.prewarmBundle) { try { R.prewarmBundle(raw); } catch {} }
for (let i = 0; i < 80; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } if (R.debugStats && R.debugStats.drawnFillVariantKey) break; await new Promise((q) => setTimeout(q, 25)); }
let n = 0; const orig = gl.getParameter.bind(gl);
gl.getParameter = (p) => { if (p === gl.DEPTH_BITS) n++; return orig(p); };
const DRAWS = 40;
for (let i = 0; i < DRAWS; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
window.__r = { n, DRAWS, mode: raw._stripModeNow | 0, overlap: !!raw.stripOverlap };
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
  if (!r.overlap || r.mode !== 2)
    fail(
      `the case did not reach the depth query (overlap ${r.overlap}, mode ${r.mode}): the smoke proves nothing`,
    );
  else if (r.n > 1)
    fail(`${r.n} DEPTH_BITS queries in ${r.DRAWS} draws: a synchronous GPU round trip per draw`);
  else console.log(`ok ${r.n} DEPTH_BITS queries in ${r.DRAWS} draws (strip mode ${r.mode})`);
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ndepthBitsQueryPerDrawSmoke: DEPTH_BITS is read at most once per renderer');
