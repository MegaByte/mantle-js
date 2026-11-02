// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbLensParitySmoke.mjs — a LENS (vesica: two arcs sharing both endpoints) must
// render through the LB route matching Slug — filled INSIDE, empty OUTSIDE.
//
// Guards the degenerate chord ring. The CDT fill-sign calibration probes just
// off the first segment's chord and tests an even-odd polygon built from segment
// ENDPOINTS. A lens's two arcs share the same two vertices, so that polygon is a
// hairline (zero area) → pointInPoly always false → the sign would invert and LB
// fill the OUTSIDE (a bowtie/diamond), leaving the lens empty (~2× Slug's ink).
// So chordRing re-derives a degenerate ring with on-curve midpoints, which gives
// it real area.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Sharp vesica: two arcs from (50,10)→(50,90)→(50,10), bulging opposite ways.
const SVG = readFileSync(
  new URL('../examples/smoke/lbLensParity__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
renderer.setViewport(100, 100);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
const draw = (mode) => { renderer.setLoopBlinnFill(mode); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: readAll(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const ink = (px) => { let n = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (px[o] < 230 || px[o + 1] < 230 || px[o + 2] < 230) n++; } return n; };
const slug = draw('off');
const lb = draw('on');
window.__out = { slugRouted: slug.routed, lbRouted: lb.routed, slugInk: ink(slug.px), lbInk: ink(lb.px),
  // (50,50) = lens center (INSIDE) · (14,50) = far-left (OUTSIDE the lens, inside the inverted bowtie)
  centerSlug: at(slug.px, 50, 50), centerLb: at(lb.px, 50, 50),
  outSlug: at(slug.px, 14, 50), outLb: at(lb.px, 14, 50) };
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
const isBg = (c) => c[0] > 230 && c[1] > 230 && c[2] > 230;
const isFill = (c) => c[2] > 120 && c[0] < 160 && c[1] < 200; // ~#3366cc

if (!o.slugRouted) ok('Slug used with LB off');
else fail('LB routed with fill off');
if (o.lbRouted) ok('lens routes through LB');
else fail('lens did NOT route to LB');
if (isFill(o.centerSlug)) ok('Slug fills the lens center');
else fail('Slug reference did not fill center?? ' + JSON.stringify(o.centerSlug));
if (isFill(o.centerLb)) ok('LB fills the lens center (sign not inverted)');
else
  fail(
    'LB left the lens center EMPTY (' +
      JSON.stringify(o.centerLb) +
      ') — degenerate-ring sign inversion',
  );
if (isBg(o.outLb)) ok('LB leaves OUTSIDE the lens empty (no inverted bowtie)');
else fail('LB filled OUTSIDE the lens (' + JSON.stringify(o.outLb) + ') — inverted fill');
if (Math.abs(o.lbInk - o.slugInk) <= o.slugInk * 0.05)
  ok('LB ink matches Slug within 5% (' + o.lbInk + ' vs ' + o.slugInk + ')');
else fail('LB ink != Slug (' + o.lbInk + ' vs ' + o.slugInk + ') — inversion / mis-fill');

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbLensParitySmoke: lens fills inside, empty outside, ink matches Slug');
