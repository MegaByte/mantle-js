// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeStationaryClipSmoke.mjs — setNodeClip on the native (no-WebGL)
// backend: a STATIONARY viewport-space clip that MOVING content is drawn
// through. This is the case Mantle's intra-bundle <mask> can't express (an
// intra-bundle mask shares the bundle's em-space and translates WITH it).
//
// On native it's fully analytic — a <clipPath>/<mask> in <defs>, transformed
// each frame by inverse(worldMatrix) so it stays put while the bundle's <g>
// transform animates. NO rasterization, NO sampling (the GL analogue is
// renderClipCoverage → a coverage RT).
//
// Fixture: content = a 20×20 red square at the TOP (em y 0..20). Its
// worldMatrix translates it DOWN. The clip = the top half (viewport y 0..50).
//   mode 'in' : square visible while it's in the top half; clipped out once it
//               descends past y=50. (If the clip moved with the bundle, the
//               square would stay visible forever.)
//   mode 'out': the exact complement — square hidden at top, appears below.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 20×20 red square at the top (em 40..60 x, 0..20 y) of a 100×100 em box.
const CONTENT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="40" y="0" width="20" height="20" fill="#ff0000"/></svg>';
// Clip mask shape: the TOP half of the viewport (px 0..50 in y). Paint is
// irrelevant for mode 'in' (clipPath uses geometry); for 'out' the impl
// forces it black.
const CLIP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="0" y="0" width="100" height="50" fill="#fff"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const content = await importSvg(${JSON.stringify(CONTENT)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
// em→px identity; translate Y by dy (column-major mat3: tx=[6], ty=[7]).
const wm = (dy) => new Float32Array([1,0,0, 0,1,0, 0,dy,1]);
const ctx = document.getElementById('cv').getContext('2d');

window.__setClip = (mode) => scene.setNodeClip(content, { maskSvg: ${JSON.stringify(CLIP)}, mode });
window.__clearClip = () => scene.clearNodeClip(content);

window.__renderAt = async (dy) => {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(content, { worldMatrix: wm(dy) });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  // Sample the CENTER of where the square is now (viewport y = dy+10).
  const p = ctx.getImageData(50, dy + 10, 1, 1).data;
  return [p[0], p[1], p[2], p[3]];
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
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
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
const isRed = (px) => px[0] > 150 && px[1] < 90 && px[2] < 90;
const isBg = (px) => px[0] < 60 && px[1] < 60 && px[2] < 60;

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

// mode 'in': visible in the top half, clipped out below.
await page.evaluate(() => window.__setClip('in'));
const inTop = await page.evaluate(() => window.__renderAt(10)); // square at y10..30 → inside
const inBot = await page.evaluate(() => window.__renderAt(60)); // square at y60..80 → below clip
if (isRed(inTop)) ok("mode 'in': square RED while in the top half (y~20): " + inTop);
else fail("mode 'in' top: expected red, got " + inTop);
if (isBg(inBot))
  ok("mode 'in': square CLIPPED OUT once it descends past y=50 (clip is stationary): " + inBot);
else fail("mode 'in' bottom: square still visible — clip moved WITH the bundle: " + inBot);

// mode 'out': complement — hidden at top, visible once below.
await page.evaluate(() => window.__setClip('out'));
const outTop = await page.evaluate(() => window.__renderAt(10)); // top → destination-out → hidden
const outBot = await page.evaluate(() => window.__renderAt(60)); // below → visible
if (isBg(outTop)) ok("mode 'out': square HIDDEN in the top half (destination-out): " + outTop);
else fail("mode 'out' top: expected bg, got " + outTop);
if (isRed(outBot)) ok("mode 'out': square VISIBLE once below the stationary mask: " + outBot);
else fail("mode 'out' bottom: expected red, got " + outBot);

// clearNodeClip removes the clip entirely (square visible everywhere).
await page.evaluate(() => window.__clearClip());
const clrBot = await page.evaluate(() => window.__renderAt(60));
if (isRed(clrBot)) ok('clearNodeClip: clip removed, square visible at y60 again: ' + clrBot);
else fail('clearNodeClip did not remove the clip: ' + clrBot);

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-STATIONARY-CLIP PASS');
else console.log(`\nNATIVE-STATIONARY-CLIP FAIL (${failures})`);
process.exit(failures ? 1 : 0);
