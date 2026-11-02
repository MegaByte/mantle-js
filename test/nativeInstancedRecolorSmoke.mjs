// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeInstancedRecolorSmoke.mjs — the native fallback's instanced draws
// must honor per-instance recolor (tint / colorMatrix / …), like the GL
// instanced path: N instances of one white source must each render in their
// own tint, not a single shared color.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// One white bundle, instanced three times with different tints → R/G/B.
const WHITE =
  '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="20" height="20" fill="#FFFFFF"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="200" height="60"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';

const bundle = await importSvg(${JSON.stringify(WHITE)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
scene.setViewport(200, 60);
const ctx = document.getElementById('c').getContext('2d');

// em→pixel affine placing the 20×20 bundle at a pixel rect.
function emToPx(px, py, s) { return new Float32Array([s/20,0,0, 0,s/20,0, px,py,1]); }

window.__instancedTint = async () => {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundleInstanced(bundle, [
    { worldMatrix: emToPx(20,  20, 20), tint: [1, 0, 0, 1] },   // red
    { worldMatrix: emToPx(90,  20, 20), tint: [0, 1, 0, 1] },   // green
    { worldMatrix: emToPx(160, 20, 20), tint: [0, 0, 1, 1] },   // blue
  ]);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,200,60); ctx.drawImage(img, 0, 0, 200, 60);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { groups: scene.svg.querySelectorAll(':scope > g').length, r: at(30,30), g: at(100,30), b: at(170,30) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const near = (px, r, g, b, tol = 40) =>
  Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const r = await page.evaluate(() => window.__instancedTint());
if (r.groups === 3) ok('drawBundleInstanced drew 3 instances (3 <g>)');
else fail('instance count: ' + r.groups);
if (near(r.r, 255, 0, 0)) ok('instance 0: PER-INSTANCE tint → red (' + r.r + ')');
else fail('instance 0 not red — per-instance tint dropped: ' + r.r);
if (near(r.g, 0, 255, 0)) ok('instance 1: PER-INSTANCE tint → green (' + r.g + ')');
else fail('instance 1 not green: ' + r.g);
if (near(r.b, 0, 0, 255)) ok('instance 2: PER-INSTANCE tint → blue (' + r.b + ')');
else fail('instance 2 not blue: ' + r.b);

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeInstancedRecolorSmoke: all checks passed');
