// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeDstOnlyMorphSmoke.mjs — dst-only morph shapes (geometry present only
// in the destination pose, with no element in the cloned source markup) must
// render on native, faded in across t. The native morph decodes each from the
// dst bundle and injects it as a <path> the scene fades in.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// SRC: one red square on the left. DST: the same red square PLUS a blue
// square on the right (the dst-only shape). The blue square exists only in
// the destination, so it must fade in over the right half as t→1.
const SRC =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/></svg>';
const DST =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/>' +
  '<rect x="70" y="40" width="20" height="20" fill="#0000FF"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const src = await importSvg(${JSON.stringify(SRC)}, { retainSource: true });
const dst = await importSvg(${JSON.stringify(DST)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'));
scene.setViewport(100, 100);
const morph = createNativeMorph(src, dst);
const ctx = document.getElementById('c').getContext('2d');
window.__info = {
  dstOnly: morph.plan.dstOnly.length,
  extras: (morph.overrides.extraShapes || []).length,
  unrenderable: morph.unrenderableDstOnly.length,
};
async function blueAt(t) {
  morph.setT(t);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(morph.bundle, { overrides: morph.overrides });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const p = ctx.getImageData(80, 50, 1, 1).data;   // center of the blue dst-only square
  return [p[0], p[1], p[2], p[3]];
}
window.__sweep = async () => ({ t0: await blueAt(0), t05: await blueAt(0.5), t1: await blueAt(1) });

// Per-draw recolor must also reach the injected dst-only shape (it's drawn
// geometry like any other). Tint the blue square green via a colorMatrix
// that maps the blue (B) channel to green output. At t=1 the dst-only square
// should be GREEN, proving recolor composes with the injected extra.
async function blueAtRecolored(t) {
  morph.setT(t);
  // colorMatrix (col-major mat4) that sends in.b → out.g, alpha passthrough.
  const cm = new Float32Array([
    0,0,0,0,   // in.r → nothing
    0,0,0,0,   // in.g → nothing
    0,1,0,0,   // in.b → out.g
    0,0,0,1,   // in.a → out.a
  ]);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(morph.bundle, { overrides: morph.overrides, colorMatrix: cm, colorMatrixOffset: [0,0,0,0] });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const p = ctx.getImageData(80, 50, 1, 1).data;
  return [p[0], p[1], p[2], p[3]];
}
window.__recoloredExtra = () => blueAtRecolored(1);
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
const isBlue = (px) => px[3] > 120 && px[2] > 150 && px[0] < 120 && px[1] < 120;
const isWhite = (px) => px[0] > 220 && px[1] > 220 && px[2] > 220; // bg

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

const info = await page.evaluate(() => window.__info);
if (info.dstOnly === 1) ok('plan has 1 dst-only shape (the blue square)');
else fail('dstOnly count: ' + info.dstOnly);
if (info.extras === 1) ok('morph exposes 1 injected extra shape');
else fail('extras count: ' + info.extras);
if (info.unrenderable === 0) ok('unrenderableDstOnly is EMPTY (dst-only renders)');
else fail('still unrenderable: ' + info.unrenderable);

const s = await page.evaluate(() => window.__sweep());
if (isWhite(s.t0)) ok('t=0: dst-only square ABSENT (bg, ' + s.t0 + ') — not yet faded in');
else fail('t=0 should be empty: ' + s.t0);
if (s.t05[3] > 60 && s.t05[2] > s.t05[0])
  ok('t=0.5: dst-only square FADING IN (partial blue, ' + s.t05 + ')');
else fail('t=0.5 not fading in: ' + s.t05);
if (isBlue(s.t1)) ok('t=1: dst-only square FULLY RENDERED blue (' + s.t1 + ') — dst-only renders');
else fail('t=1 dst-only not rendered: ' + s.t1);

// Per-draw recolor reaches the injected dst-only shape too.
const rc = await page.evaluate(() => window.__recoloredExtra());
const isGreen = (px) => px[3] > 120 && px[1] > 150 && px[0] < 120 && px[2] < 120;
if (isGreen(rc))
  ok('per-draw recolor RECOLORS the dst-only shape (blue→green via colorMatrix, ' + rc + ')');
else fail('recolor did not reach the injected dst-only shape: ' + rc);

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeDstOnlyMorphSmoke: all checks passed');
