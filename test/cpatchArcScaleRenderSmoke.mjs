// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchArcScaleRenderSmoke -- CPatch draws the same arcs at every size of the art.
//
// A bundle is fit to the canvas, so the art's own size must not change the picture. Each drawing is compared with the same art at size 1, on the
// pinned CPatch route (the engine tally says so). A kernel that divided its distances by max(em per pixel, 1e-9), an absolute length, would from about 2^-30 of the
// art read every distance short by the floor's ratio, widen the AA ramp and fade shapes toward half coverage. Arcs reach it because they take the implicit kernel; lines and polynomials
// mostly take the complete-paint area, which has no such floor. Below 2^-30 a rational arc's closest-point solve loses its products to float32's range: not checked here.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;
const arc = (x, y, rx, ry = rx, phi = 0) =>
  `M${x + rx} ${y}A${rx} ${ry} ${phi} 0 1 ${x - rx} ${y}A${rx} ${ry} ${phi} 0 1 ${x + rx} ${y}Z`;
const CASES = [
  { name: 'overlapping circles', body: `<path d="${arc(50.3, 64.2, 30)}${arc(78.3, 64.2, 30)}"/>` },
  {
    name: 'overlapping ellipses',
    body: `<path d="M20 64A30 12 30 0 1 90 40A30 12 30 0 1 20 64Z${arc(78.3, 64.2, 30, 18)}"/>`,
  },
  { name: 'one ellipse', body: `<path d="${arc(64.3, 64.2, 40, 25)}"/>` },
];
const SCALES = [-24, -28, -30, 24];
const svgAt = (body, s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${128 * s} ${128 * s}"><g transform="scale(${s})">${body}</g></svg>`;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const R = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href), { aacPoints: false, cpatchFill: true, psoWarmIdle: () => true }); if (R.ready) await R.ready;
R.setViewport(${N}, ${N}); R.setFillEngine({ route: 'cpatch' });
const BUDGET = ${pageTimeoutFor(120000, 30000)}, DEADLINE = performance.now() + BUDGET;
const drew = () => ((R.debugStats.engines && R.debugStats.engines.draws) || {}).cpatch | 0;
window.__draw = async (svg) => {
  const b = createBundle(gl, await importSvg(svg));
  R.prepareBundle(b); await R.awaitEngine(b, 'cpatch', BUDGET);
  const frame = () => { const c0 = drew(); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); return drew() - c0; };
  let routed = frame();
  while (!routed && performance.now() < DEADLINE) { R.precompileFills(); await new Promise((r) => setTimeout(r, 25)); routed = frame(); }
  routed = frame();
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (b.dispose) b.dispose();
  return { routed, px: Array.from(px) };
};
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
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
let failures = 0,
  compared = 0;
const report = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failures++;
};
for (const c of CASES) {
  const ref = await page.evaluate((s) => window.__draw(s), svgAt(c.body, 1));
  let inkRef = 0;
  for (let i = 0; i < ref.px.length; i += 4) if (ref.px[i] < 250) inkRef++;
  report(
    ref.routed > 0 && inkRef > 0,
    `${c.name}: size 1 draws through CPatch (${inkRef} px of ink)`,
  );
  for (const k2 of SCALES) {
    const o = await page.evaluate((s) => window.__draw(s), svgAt(c.body, 2 ** k2));
    let off = 0,
      worst = 0;
    for (let i = 0; i < o.px.length; i++) {
      const d = Math.abs(o.px[i] - ref.px[i]);
      if (d > worst) worst = d;
      if (d > 2) off++;
    }
    compared++;
    report(
      o.routed > 0 && off === 0,
      `${c.name} at 2^${k2}: ${off} channel values differ from size 1 by more than 2/255 (worst ${worst}, routed ${o.routed})`,
    );
  }
}
await browser.close();
server.close();
if (failures) {
  console.error(`cpatchArcScaleRenderSmoke: ${failures} failed of ${compared} sizes`);
  process.exit(1);
}
console.log(`cpatchArcScaleRenderSmoke: ${compared} sizes match size 1`);
