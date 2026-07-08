// lbComposeOrderSmoke.mjs — guards a cross-shape uniform-leak in the analytic
// fill: lbProg's uGradId/uImageId are shared between the per-shape DIRECT path
// (_drawLBShapeDirect, sets them for gradient/image shapes) and the all-solid
// COMBINED route (_drawBundleLoopBlinn). The combined route must RESET them, or
// a solid bundle drawn after a gradient one in the same frame samples the stale
// gradient and renders blank. Reproduces what a real multi-bundle scene does
// (gradient scenery + solid shapes composed per frame) — LB 'on' so both route.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MESA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#c8a060"/><stop offset="1" stop-color="#603010"/>
  </linearGradient></defs>
  <path d="M10 160 C10 90 40 70 70 70 L130 70 C160 70 190 90 190 160 Z" fill="url(#g)"/>
</svg>`;
const BLOB = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path d="M60 120 C60 80 100 80 110 110 C120 140 90 160 70 150 C55 143 60 135 60 120 Z" fill="#3366cc"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(200, 200);
const hMesa = renderer.createBundleHandle(createBundle(gl, await importSvg(${JSON.stringify(MESA)})));
const hBlob = renderer.createBundleHandle(createBundle(gl, await importSvg(${JSON.stringify(BLOB)})));
const read = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
// Count pixels close to the solid blob colour (#3366cc = 51,102,204).
const bluePx = (px) => { let n = 0; for (let i = 0; i < 200 * 200; i++) { const o = i * 4;
  if (Math.abs(px[o] - 51) < 40 && Math.abs(px[o + 1] - 102) < 40 && Math.abs(px[o + 2] - 204) < 40) n++; } return n; };
// ONE frame: gradient mesa first, then the solid blob ON TOP. LB 'on' → both route.
const compose = (lbMode) => {
  renderer.setLoopBlinnFill(lbMode);
  renderer.beginFrame([1, 1, 1, 1]); hMesa.draw({}); hBlob.draw({}); renderer.endFrame();
  return bluePx(read());
};
window.__out = { slug: compose('off'), lbOn: compose('on') };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.slug < 2000) fail('reference (Slug) blob did not render: ' + o.slug + ' blue px');
else ok('Slug composes the solid blob over the gradient mesa (' + o.slug + ' blue px)');
// The bug rendered the blob blank (0 blue). Require it within 15% of the Slug ref.
if (o.lbOn >= o.slug * 0.85) ok('LB solid bundle survives a prior gradient draw (' + o.lbOn + ' vs ' + o.slug + ' blue px)');
else fail('LB solid bundle vanished/shrank after a gradient draw (' + o.lbOn + ' vs ' + o.slug + ' blue px) — uGradId leak');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbComposeOrderSmoke: solid combined route resets uGradId/uImageId after a gradient draw');
