// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeImageRecolorSmoke.mjs — the native (no-WebGL) raster drawImage must
// honor a PER-DRAW colorMatrix / colorMatrixOffset, matching the WebGL path
// (src/shaders/drawImage.frag.glsl, covered by test/drawImageSmoke.mjs).
//
// Both backends apply `out = colorMatrix * in + colorMatrixOffset` to STRAIGHT
// color before the tint multiply; natively that is an feColorMatrix chained
// ahead of the tint's. Two blits of the same source with different offsets
// must differ — a per-ASSET tint cannot express that.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Solid red source — every recolor below is checked against pure red in.
const SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
      '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>',
  );

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { createNativeScene } from '/src/index.js';
const SRC = ${JSON.stringify(SRC)};
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const ctx = document.getElementById('cv').getContext('2d');

// Draw N blits in one frame and sample the center of each dstRect.
window.__draw = async (calls) => {
  scene.beginFrame([0,0,0,1]);
  for (const c of calls) scene.drawImage(SRC, c);
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  return calls.map(c => {
    const [x,y,w,h] = c.dstRect;
    const p = ctx.getImageData(x + w/2 | 0, y + h/2 | 0, 1, 1).data;
    return [p[0],p[1],p[2],p[3]];
  });
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
const near = (a, b, t = 20) => Math.abs(a - b) <= t;
const rgbNear = (c, r, g, b, t = 20) => near(c[0], r, t) && near(c[1], g, t) && near(c[2], b, t);

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

// 1) Two blits of ONE source with different offsets recolor independently:
//    red +G → yellow, red +B → magenta, and a third plain blit stays red
//    (the filter is per-draw and must not leak).
{
  const s = await page.evaluate(() =>
    window.__draw([
      { dstRect: [0, 0, 50, 50], colorMatrixOffset: [0, 1, 0, 0] },
      { dstRect: [50, 0, 50, 50], colorMatrixOffset: [0, 0, 1, 0] },
      { dstRect: [0, 50, 50, 50] },
    ]),
  );
  if (rgbNear(s[0], 255, 255, 0)) ok('colorMatrixOffset +G: red → yellow');
  else fail('offset +G: ' + s[0]);
  if (rgbNear(s[1], 255, 0, 255)) ok('colorMatrixOffset +B: red → magenta');
  else fail('offset +B: ' + s[1]);
  if (!rgbNear(s[0], s[1][0], s[1][1], s[1][2]))
    ok('two blits of one source recolor independently');
  else fail('offsets produced identical pixels: ' + s[0]);
  if (rgbNear(s[2], 255, 0, 0)) ok('recolor does not leak to the next drawImage');
  else fail('leaked recolor: ' + s[2]);
}

// 2) A column-major mat4 that swaps R↔B — the GL→SVG row/column transpose
//    is the easy thing to get wrong, so assert the actual channel landing.
{
  const swapRB = [
    0,
    0,
    1,
    0, // in.r → out.b
    0,
    1,
    0,
    0,
    1,
    0,
    0,
    0, // in.b → out.r
    0,
    0,
    0,
    1,
  ];
  const s = await page.evaluate(
    (m) => window.__draw([{ dstRect: [0, 0, 50, 50], colorMatrix: m }]),
    swapRB,
  );
  if (rgbNear(s[0], 0, 0, 255)) ok('colorMatrix R↔B: red → blue');
  else fail('swap: ' + s[0]);
}

// 3) colorMatrix and tint compose in shader order (recolor, then tint):
//    red --(+G offset)--> yellow --(tint green)--> green.
{
  const s = await page.evaluate(() =>
    window.__draw([
      { dstRect: [0, 0, 50, 50], colorMatrixOffset: [0, 1, 0, 0], tint: [0, 1, 0, 1] },
    ]),
  );
  if (rgbNear(s[0], 0, 255, 0)) ok('colorMatrix then tint compose in shader order');
  else fail('compose: ' + s[0]);
}

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-IMAGE-RECOLOR PASS');
else console.log(`\nNATIVE-IMAGE-RECOLOR FAIL (${failures})`);
process.exit(failures ? 1 : 0);
