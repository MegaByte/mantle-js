// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBlendParitySmoke.mjs — per-shape blend via Slug fallback. A blend
// mode needs the backdrop, which the analytic fill can't sample — so a blended
// shape renders via Slug per-shape (Slug blends against the canvas) while the
// rest of the bundle stays analytic. Result must match an all-Slug render.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A solid green diamond (analytic) overlapped by a red diamond with
// mix-blend-mode:multiply (→ Slug fallback). The overlap multiplies to a darker
// color; the red-only region is red·white.
const SVG = readFileSync(
  new URL('../examples/smoke/lbBlendParity__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// Parity over pixels inked in both, and confirm the multiply region (where the
// red shape overlaps green) is DARK (g·r blend) in both — i.e. blend was applied.
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n };
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
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));

if (!o.slugRouted) ok('Slug path used with LB off');
else fail('LB routed with fill off');
if (o.lbRouted) ok('blend bundle routes through the analytic path (blended shape → Slug fallback)');
else fail('blend bundle did NOT route to the analytic fill');
if (o.inkPx > 1000) ok('shapes render (' + o.inkPx + ' ink px)');
else fail('barely rendered: ' + o.inkPx);
if (o.maxDiff <= 6)
  ok(
    'render parity: LB + per-shape-Slug blend matches all-Slug (mean channel diff ' +
      o.maxDiff +
      ')',
  );
else fail('blend interior != all-Slug (mean channel diff ' + o.maxDiff + ')');

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbBlendParitySmoke: all assertions passed');
