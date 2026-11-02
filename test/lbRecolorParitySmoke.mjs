// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRecolorParitySmoke.mjs — a per-draw colorMatrix recolor composes
// over the analytic fill (the composed MANTLE_LB_COV variant keeps the recolor
// block; _drawBundleLB forces solid shapes through the composite path under
// recolor), matching Slug. The matrix forces the #3366cc fill to pure green.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SVG = readFileSync(
  new URL('../examples/smoke/lbRecolorParity__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);

// Column-major mat4: out = M*in + offset. M zeroes RGB, passes A; offset forces G=1
// → any fill renders pure green (alpha preserved).
const M = new Float32Array([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]);
const OFF = new Float32Array([0,1,0,0]);
const opts = { colorMatrix: M, colorMatrixOffset: OFF };

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, opts); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
// STEADY STATE. A RECOLORED draw selects its own fill variant (drawUsesRecolor
// changes the defines), and while a variant links the bundle falls to the best
// non-LB engine rather than into the classic coverage-RT routes — so frame 1 routes
// nothing to LB by design. Spin until the recolor variant is warm; that is what an
// application sees after the first handful of frames.
//
// A pipeline warm that runs with whatever R.draw last held never warms the recolored
// variant, and the gate never clears. The warm replays the draw state that was found
// mismatched, which is what makes this converge at all.
const r1 = renderer.debugStats.loopBlinnRouteCount;
for (let i = 0; i < 20; i++) {
  const c = renderer.debugStats.loopBlinnRouteCount;
  draw();
  if (renderer.debugStats.loopBlinnRouteCount - c > 0) break;
  if (renderer.precompileFills) { try { renderer.precompileFills(); } catch {} }
  // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
      await new Promise((res) => { const _t = setTimeout(res, 100); requestAnimationFrame(() => { clearTimeout(_t); res(); }); });
}
draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n, ctrLB: at(lb, 50, 50), ctrSlug: at(slug, 50, 50) };
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
console.log('  ', JSON.stringify(o));

const isGreen = (c) => c[1] > 150 && c[0] < 60 && c[2] < 60;

if (!o.slugRouted) ok('Slug path used with LB off');
else fail('LB routed with fill off');
if (o.lbRouted) ok('recolored bundle routes through the analytic composite path (LB on)');
else fail('recolored bundle did NOT route to the analytic fill');
if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
else fail('shape barely rendered: ' + o.inkPx);
if (isGreen(o.ctrLB))
  ok('colorMatrix recolor applied (center green ' + JSON.stringify(o.ctrLB) + ')');
else fail('recolor not applied: center=' + JSON.stringify(o.ctrLB));
if (o.maxDiff <= 6)
  ok('render parity: analytic recolored fill matches Slug (mean channel diff ' + o.maxDiff + ')');
else fail('analytic recolored interior != Slug (mean channel diff ' + o.maxDiff + ')');

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbRecolorParitySmoke: all assertions passed');
