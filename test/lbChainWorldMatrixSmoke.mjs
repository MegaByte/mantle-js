// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbChainWorldMatrixSmoke — Loop-Blinn chain coverage under a world matrix depends on the matrix,
// not on where the drawing sits.
//
// The chain kernels (chainBoxCov: kind-13 strips, interior chain faces and chain 2) clip the chain
// against ONE DEVICE PIXEL's box. A single em-per-pixel scalar cannot map each point into it: for a
// chain face, a scalar taken along the chain's first POINT (emPerPxFor(aC3.xy), where aC3.xy holds P0)
// moves a face's scale with its position under a non-uniform or skewed world matrix. The points go
// through the whole em -> pixel linear map (lbChainCellMap).
//
// TRANSLATION: the same shapes drawn at two em offsets that map to whole-pixel shifts must give the
// same pixels, shifted (a scalar map leaves a 3/255 difference under an anisotropic matrix).
// MIRROR: a mirrored matrix must draw the mirror image of the unmirrored one -- the map reflects
// its output once more so the chain's fill side keeps em's orientation, and this proves it does.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 384;
const BODY = `<circle cx="100" cy="110" r="50" fill="#000"/><path d="M200 60 C240 20 300 120 260 160 S160 200 200 60 Z" fill="#000"/>`;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setFillEngine({ route: 'lb', kernel: 'slug' });
// W is the plane-space linear part, row-major [[a, b], [c, d]].
window.__shot = async (ox, oy, W) => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}"><g transform="translate(' + ox + ' ' + oy + ')">' + ${JSON.stringify(BODY)} + '</g></svg>';
  const b = createBundle(gl, await importSvg(src, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b); if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  const before = ((R.debugStats.engines || {}).draws || {}).lb | 0;
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, { worldMatrix: new Float32Array([W[0], W[2], 0, W[1], W[3], 0, 0, 0, 1]) }); R.endFrame(); }
  const lb = (((R.debugStats.engines || {}).draws || {}).lb | 0) - before;
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); b.dispose && b.dispose();
  const out = []; for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) out.push(px[((${N} - 1 - y) * ${N} + x) * 4]);
  return { red: out, lb };
};
window.__ready = true;</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
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
const ok = (m) => console.log('ok ' + m);
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
const shot = (ox, oy, W) => page.evaluate((a, b, w) => window.__shot(a, b, w), ox, oy, W);
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  // Two anisotropic matrices; em offsets chosen so the pixel shift F W F (dx, dy) is whole.
  for (const [W, dx, dy] of [
    [[0.9, 0, 0, 0.45], 20, 40],
    [[0.5, 0, 0, 1.0], 40, 20],
  ]) {
    const a = await shot(0, 0, W),
      b = await shot(dx, dy, W);
    const sx = Math.round(W[0] * dx),
      sy = Math.round(W[3] * dy);
    let n = 0,
      max = 0;
    for (let y = 40; y < N - 40; y++)
      for (let x = 40; x < N - 40; x++) {
        const va = a.red[y * N + x],
          vb = b.red[(y + sy) * N + (x + sx)];
        if (va < 255 || vb < 255) n++;
        max = Math.max(max, Math.abs(va - vb));
      }
    const msg = `scale (${W[0]}, ${W[3]}): moved ${dx},${dy} em (${sx},${sy} px), ${n} ink px, max difference ${max}/255 (lb draws ${a.lb}, ${b.lb})`;
    if (!a.lb || !b.lb) fail(msg + ' — the Loop-Blinn route did not draw');
    else if (max <= 1) ok(msg);
    else fail(msg + ' — coverage depends on where the drawing sits');
  }
  // Mirror: diag(-0.9, 0.45) against diag(0.9, 0.45) flipped left-right about the canvas center.
  {
    const a = await shot(0, 0, [0.9, 0, 0, 0.45]),
      b = await shot(0, 0, [-0.9, 0, 0, 0.45]);
    let n = 0,
      max = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const va = a.red[y * N + x],
          vb = b.red[y * N + (N - 1 - x)];
        if (va < 255 || vb < 255) n++;
        max = Math.max(max, Math.abs(va - vb));
      }
    const msg = `a mirrored matrix draws the mirror image: ${n} ink px, max difference ${max}/255`;
    if (n > 3000 && max <= 1) ok(msg);
    else fail(msg);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nlbChainWorldMatrixSmoke: chain coverage follows the matrix, not the position');
