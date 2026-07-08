// instancedBlitSmoke.mjs — drawImageInstanced (WebGL GPU instancing) proof.
// Upload ONE 1×1 white image, then stamp it at N transforms in a SINGLE
// drawArraysInstanced call. Asserts:
//   1. Each instance lands at its own dstRect (distinct screen positions).
//   2. Per-instance tint colors the shared white source independently.
//   3. Per-instance alpha attenuates independently.
//   4. A per-instance worldMatrix (translate) offsets that instance only.
//   5. Empty / zero-length instance list is a safe no-op (returns 0).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
// 1×1 white opaque source (premultiplied upload).
const px = new Uint8Array([255,255,255,255]);
const img = renderer.createImage({ data: px, width: 1, height: 1 });
window.__hasImg = !!(img && img.texture);
window.__hasFn = typeof renderer.drawImageInstanced === 'function';
window.__draw = (instances, opts) => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawImageInstanced(img, instances, opts || {});
  renderer.endFrame();
  return n;
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 200-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try { res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };
const near = (a, b, t = 12) => Math.abs(a - b) <= t;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

if (await page.evaluate(() => window.__hasFn)) ok('renderer.drawImageInstanced exists');
else fail('drawImageInstanced not exported');
if (await page.evaluate(() => window.__hasImg)) ok('1×1 source image uploaded');
else fail('source image upload failed');

// (1) Three instances at distinct dstRects → three filled squares.
const r1 = await page.evaluate(() => {
  const n = window.__draw([
    { dstRect: [10, 10, 20, 20] },     // top-left  → center (20,20)
    { dstRect: [90, 90, 20, 20] },     // center    → center (100,100)
    { dstRect: [160, 160, 20, 20] },   // bot-right → center (170,170)
  ]);
  return { n,
    a: window.__sample(20, 20), b: window.__sample(100, 100), c: window.__sample(170, 170),
    gap: window.__sample(60, 60) };   // between instances → background
});
if (r1.n === 3) ok('drew 3 instances (single instanced call)'); else fail('instance count: ' + r1.n);
if (r1.a[0] > 200 && r1.b[0] > 200 && r1.c[0] > 200) ok('all 3 instances rendered at their dstRects (white)');
else fail('missing instance(s): a=' + r1.a + ' b=' + r1.b + ' c=' + r1.c);
if (r1.gap[0] < 30 && r1.gap[1] < 30) ok('background between instances is clear (no stretch)');
else fail('unexpected fill between instances: ' + r1.gap);

// (2) Per-instance tint: red, green, blue squares from one white source.
const r2 = await page.evaluate(() => {
  window.__draw([
    { dstRect: [10, 90, 20, 20], tint: [1, 0, 0, 1] },
    { dstRect: [90, 90, 20, 20], tint: [0, 1, 0, 1] },
    { dstRect: [170, 90, 20, 20], tint: [0, 0, 1, 1] },
  ]);
  return { r: window.__sample(20, 100), g: window.__sample(100, 100), b: window.__sample(180, 100) };
});
if (r2.r[0] > 200 && r2.r[1] < 40 && r2.r[2] < 40) ok('instance 0 tinted red'); else fail('tint red: ' + r2.r);
if (r2.g[1] > 200 && r2.g[0] < 40 && r2.g[2] < 40) ok('instance 1 tinted green'); else fail('tint green: ' + r2.g);
if (r2.b[2] > 200 && r2.b[0] < 40 && r2.b[1] < 40) ok('instance 2 tinted blue'); else fail('tint blue: ' + r2.b);

// (3) Per-instance alpha: full vs ~half over a black background.
const r3 = await page.evaluate(() => {
  window.__draw([
    { dstRect: [40, 90, 20, 20], alpha: 1.0 },
    { dstRect: [140, 90, 20, 20], alpha: 0.5 },
  ]);
  return { full: window.__sample(50, 100), half: window.__sample(150, 100) };
});
if (r3.full[0] > 230) ok('alpha=1 instance fully opaque (' + r3.full[0] + ')'); else fail('alpha=1: ' + r3.full);
if (near(r3.half[0], 128, 30)) ok('alpha=0.5 instance ~half over black (' + r3.half[0] + ')'); else fail('alpha=0.5: ' + r3.half);

// (4) Per-instance worldMatrix translate moves ONE instance only.
const r4 = await page.evaluate(() => {
  const T = [1,0,0, 0,1,0, 60,0,1];   // column-major translate +60 in x
  window.__draw([
    { dstRect: [20, 90, 20, 20] },                   // stays at x≈30
    { dstRect: [20, 90, 20, 20], worldMatrix: T },   // shifts to x≈90
  ]);
  return { base: window.__sample(30, 100), shifted: window.__sample(90, 100), origOfShift: window.__sample(30, 100) };
});
if (r4.base[0] > 200) ok('untransformed instance at origin'); else fail('base instance missing: ' + r4.base);
if (r4.shifted[0] > 200) ok('worldMatrix-translated instance shifted +60px'); else fail('shifted instance missing: ' + r4.shifted);

// (5) Empty list → safe no-op.
const r5 = await page.evaluate(() => window.__draw([]));
if (r5 === 0) ok('empty instance list is a no-op (returns 0)'); else fail('empty list returned: ' + r5);

await browser.close();
server.close();
if (failures === 0) console.log('\nINSTANCED-BLIT PASS');
else console.log(`\nINSTANCED-BLIT FAIL (${failures})`);
process.exit(failures ? 1 : 0);
