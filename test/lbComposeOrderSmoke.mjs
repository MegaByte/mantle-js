// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MESA = readFileSync(
  new URL('../examples/smoke/lbComposeOrder__MESA.svg', import.meta.url),
  'utf8',
);
const BLOB = readFileSync(
  new URL('../examples/smoke/lbComposeOrder__BLOB.svg', import.meta.url),
  'utf8',
);

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
// Count pixels close to the solid blob color (#3366cc = 51,102,204).
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
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
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
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.slug < 2000) fail('reference (Slug) blob did not render: ' + o.slug + ' blue px');
else ok('Slug composes the solid blob over the gradient mesa (' + o.slug + ' blue px)');
// The bug rendered the blob blank (0 blue). Require it within 15% of the Slug ref.
if (o.lbOn >= o.slug * 0.85)
  ok('LB solid bundle survives a prior gradient draw (' + o.lbOn + ' vs ' + o.slug + ' blue px)');
else
  fail(
    'LB solid bundle vanished/shrank after a gradient draw (' +
      o.lbOn +
      ' vs ' +
      o.slug +
      ' blue px) — uGradId leak',
  );

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nlbComposeOrderSmoke: solid combined route resets uGradId/uImageId after a gradient draw',
);
