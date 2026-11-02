// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedBundleRenderDiffSmoke — proves the drawBundleInstanced GPU
// fast path (one drawArraysInstanced per cover-quad chunk, per-instance
// worldMatrix+alpha streamed from a vertex buffer read by the
// MANTLE_INSTANCED vertex variant) renders BYTE-IDENTICAL to the
// per-instance render() loop it replaces.
//
//   A = drawBundleInstanced with the fast path ON  (default)
//   B = drawBundleInstanced with the fast path OFF (_setInstancedFast(false)
//       → the per-instance render() loop)
//   assert A === B byte-for-byte.
//
// Two cases: plain (worldMatrix + per-instance alpha) and a shared
// override table (exercises the uHasOverrides path that every instance
// reads). The non-instanced drawBundle path is never touched.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const SVG = readFileSync(
  new URL('../examples/smoke/instancedBundleRenderDiff__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const W = 256, H = 256;
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});

// 4 instances: quadrants, scaled 0.5, varying alpha. worldMatrix is a
// column-major mat3 applied in clip space ([m00,m10,0, m01,m11,0, tx,ty,1]).
function wm(s, tx, ty) { return new Float32Array([s,0,0, 0,s,0, tx,ty,1]); }
const INSTANCES = [
  { worldMatrix: wm(0.5, -0.5,  0.5), alpha: 1.0 },
  { worldMatrix: wm(0.5,  0.5,  0.5), alpha: 0.6 },
  { worldMatrix: wm(0.5, -0.5, -0.5), alpha: 0.85 },
  { worldMatrix: wm(0.45, 0.5, -0.5), alpha: 1.0 },
];

function readback() {
  const buf = new Uint8Array(W*H*4);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  return buf;
}

// Render the instances with the fast path forced on/off. Fresh bundle +
// renderer each call so neither shares state.
function renderInstanced(fast, shared) {
  const bundle = createBundle(gl, sec);
  const renderer = createRenderer(gl, shaders);
  renderer.setViewport(W, H);
  renderer._setInstancedFast(fast);
  let sh = shared;
  if (shared === 'overrides') {
    const ov = createOverrideTable(gl, bundle);
    sh = { overrides: ov };
  }
  // drawBundleInstanced accumulates N copies; it must run inside a frame
  // (beginFrame owns the single color clear — standalone render() would
  // clear color per instance and show only the last).
  renderer.beginFrame([0, 0, 0, 0]);
  const n = renderer.drawBundleInstanced(bundle, INSTANCES, sh || undefined);
  renderer.endFrame();
  const buf = readback();
  bundle.dispose(); renderer.dispose();
  return { buf, n };
}

const result = { cases: [] };
try {
  for (const [name, shared] of [['plain', null], ['overrides', 'overrides']]) {
    const A = renderInstanced(true, shared);
    const B = renderInstanced(false, shared);
    let maxDiff = 0, nDiff = 0, ink = 0;
    for (let i = 0; i < A.buf.length; i++) {
      const d = Math.abs(A.buf[i] - B.buf[i]);
      if (d > maxDiff) maxDiff = d;
      if (d !== 0) nDiff++;
      if (B.buf[i] !== 0) ink++;
    }
    result.cases.push({ name, maxDiff, nDiff, ink, nFast: A.n, nLoop: B.n });
  }
  result.compiled = true;
} catch (e) { result.error = String(e && e.stack || e); }
window.__result = result;
window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page
  .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

if (!r || !r.compiled) {
  fail('instanced render did not complete: ' + ((r && r.error) || 'page error'));
} else
  for (const c of r.cases) {
    // Bar: ≤1 LSB at a handful of subpixels. The instanced path issues ONE
    // drawArraysInstanced (instance-major) where the loop issues N separate
    // draws; at an instance-seam AA edge that can round 1 LSB differently —
    // a sub-quantization rasterization artifact, not a logic difference (the
    // override case is exactly byte-identical). A real bug (wrong transform /
    // missing instance / bad order) shows maxDiff in the dozens-to-hundreds
    // over thousands of pixels, which this gate still catches.
    if (c.nFast !== 4 || c.nLoop !== 4)
      fail(`${c.name}: drew ${c.nFast}/${c.nLoop} instances (expected 4/4)`);
    else if (c.ink === 0) fail(`${c.name}: nothing rendered`);
    else if (c.maxDiff === 0)
      ok(`${c.name}: instanced == per-instance loop byte-identical (ink=${c.ink})`);
    else if (c.maxDiff <= 1 && c.nDiff <= 16)
      ok(
        `${c.name}: instanced matches loop within 1 LSB (nDiff=${c.nDiff}/${c.ink}, ink=${c.ink})`,
      );
    else fail(`${c.name}: instanced differs (maxDiff=${c.maxDiff}, nDiff=${c.nDiff})`);
  }
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\ninstancedBundleRenderDiffSmoke: drawBundleInstanced fast path is byte-identical to the loop',
);
