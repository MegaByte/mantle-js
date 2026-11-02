// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbGradientParitySmoke.mjs — the analytic (Loop-Blinn) route renders
// GRADIENT fills, not just solid, and matches the Slug fill.
//
// A gradient-filled path drawn with setLoopBlinnFill(true) (→ analytic route)
// must pixel-match the same bundle drawn with it OFF (→ Slug), and show the
// gradient (left red → right green).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A diamond PATH (not a <rect>, so it's not the primKind-excluded rect) with a
// horizontal linear gradient red→green in objectBoundingBox units.
const SVG = readFileSync(
  new URL('../examples/smoke/lbGradientParity__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
window.__hasGrad = !!bundle.gradientTex;

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// INTERIOR parity: mean RGB diff over pixels inked in BOTH (excludes the
// silhouette AA edge, where LB and Slug antialias differently — that's a few
// px of mismatch, not a paint difference). The gradient interior must match.
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 30 || lb[o + 1] > 30, slugInk = slug[o] > 30 || slug[o + 1] > 30;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;   // mean channel diff over interior
// Gradient direction (center row): left should be red-dominant, right green.
const left = at(lb, 25, 50), right = at(lb, 75, 50);
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n,
  left, right,
};
window.__ready = true;
var out_slugRouted, out_lbRouted;
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
const hasGrad = await page.evaluate(() => window.__hasGrad);

if (hasGrad) ok('bundle carries a gradient texture');
else fail('no gradientTex');
if (!o.slugRouted) ok('Slug path used with LB off');
else fail('LB routed with fill off');
if (o.lbRouted) ok('gradient bundle routes through the analytic per-shape path (LB on)');
else fail('gradient bundle did NOT route to the analytic fill');
if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
else fail('shape barely rendered: ' + o.inkPx);
if (o.maxDiff <= 6)
  ok(
    'render parity: analytic gradient interior matches Slug (mean channel diff ' + o.maxDiff + ')',
  );
else fail('analytic gradient interior != Slug (mean channel diff ' + o.maxDiff + ')');
if (o.left[0] > o.left[1] + 40 && o.right[1] > o.right[0] + 40)
  ok(
    'gradient direction correct (left red ' +
      JSON.stringify(o.left) +
      ', right green ' +
      JSON.stringify(o.right) +
      ')',
  );
else fail('gradient wrong: left=' + JSON.stringify(o.left) + ' right=' + JSON.stringify(o.right));

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbGradientParitySmoke: all assertions passed');
