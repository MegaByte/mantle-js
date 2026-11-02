// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeImageInstancedSmoke.mjs — drawImageInstanced on the native backend must
// draw N copies of the same raster source. A DOM <image> node can have only one
// parent, so same-href instances need per-slot image elements, not one shared
// href-keyed node.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="120" height="40"></canvas>
<script type="module">
import { createNativeScene } from '/src/index.js';
const scene = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
scene.setViewport(120, 40);
const px = { width: 1, height: 1, rgba: new Uint8Array([0, 220, 0, 255]) };
const ctx = document.getElementById('c').getContext('2d');
window.__render = async () => {
  scene.beginFrame([0,0,0,1]);
  const n = scene.drawImageInstanced(px, [
    { dstRect: [10, 10, 20, 20] },
    { dstRect: [50, 10, 20, 20] },
    { dstRect: [90, 10, 20, 20] },
  ]);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,120,40); ctx.drawImage(img, 0, 0, 120, 40);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return {
    n,
    imageEls: scene.svg.querySelectorAll('image').length,
    a: at(20,20), b: at(60,20), c: at(100,20), gap: at(40,20),
  };
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
const isGreen = (p) => p[1] > 150 && p[0] < 80 && p[2] < 80 && p[3] > 120;
const isBg = (p) => p[0] < 40 && p[1] < 40 && p[2] < 40;

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

const r = await page.evaluate(() => window.__render());
if (r.n === 3) ok('drawImageInstanced returned 3');
else fail('instance count: ' + r.n);
if (r.imageEls === 3) ok('same source produced 3 live <image> nodes');
else fail('expected 3 image nodes, got ' + r.imageEls);
if (isGreen(r.a) && isGreen(r.b) && isGreen(r.c))
  ok('all three same-source raster instances rendered');
else fail('missing same-source instance(s): ' + r.a + ' / ' + r.b + ' / ' + r.c);
if (isBg(r.gap)) ok('gap between instances stays clear');
else fail('unexpected fill in gap: ' + r.gap);

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-IMAGE-INSTANCED PASS');
else console.log(`\nNATIVE-IMAGE-INSTANCED FAIL (${failures})`);
process.exit(failures ? 1 : 0);
