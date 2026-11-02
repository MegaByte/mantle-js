// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// clearNodeClip must clear the clip record for the current nativeText mode:
// a nativeText scene stores its clip under __nativeRecordText, so clearNodeClip
// must not delete only the normal __nativeRecord id and leave the clip active.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONTENT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/></svg>';
const CLIP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="0" y="0" width="100" height="50" fill="#fff"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<div id="host"></div><canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const content = await importSvg(${JSON.stringify(CONTENT)}, { retainSource: true });

// Create the normal-mode bundle record first: the clip must be cleared even
// when both cache slots (__nativeRecord and __nativeRecordText) exist.
const warm = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
warm.setViewport(100, 100);
warm.beginFrame([1,1,1,1]); warm.drawBundle(content); warm.endFrame();

const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport', nativeText: true });
scene.setViewport(100, 100);
const ctx = document.getElementById('cv').getContext('2d');

window.__run = async () => {
  scene.setNodeClip(content, { maskSvg: ${JSON.stringify(CLIP)}, mode: 'in' });
  scene.clearNodeClip(content);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(content);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { top: at(50, 25), bottom: at(50, 75) };
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
const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90 && p[3] > 120;

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

const r = await page.evaluate(() => window.__run());
if (isRed(r.top) && isRed(r.bottom))
  ok('nativeText clearNodeClip removed the clip from both top and bottom samples');
else fail('nativeText clearNodeClip left a stale clip: top=' + r.top + ' bottom=' + r.bottom);

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-TEXT-CLIP-CLEAR PASS');
else console.log(`\nNATIVE-TEXT-CLIP-CLEAR FAIL (${failures})`);
process.exit(failures ? 1 : 0);
