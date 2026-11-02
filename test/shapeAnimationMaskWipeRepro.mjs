// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shape-morph must interpolate an inherited mask. Top-down mask wipe: SRC mask
// rect height = 10px, DST = 80px, content rect = 100px wide × 100px tall.
// Driving the morph t = 0 → 0.5 → 1 should produce three distinct row-counts
// of revealed pixels.
//
// The mask is carried on a `<g mask="url(#m)">` wrapper, not the leaf shape:
// the importer must inherit mask + clip-path through container elements so the
// mask geometry becomes a matched topology-layer (FLAG_LAYER) shape that the
// curve+meta lerp interpolates.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const mk = (h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><mask id="m"><rect x="0" y="0" width="100" height="${h}" fill="#fff"/></mask></defs>
  <g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#ff0000"/></g>
</svg>`;

const SRC = mk(10); // thin slit at top — only ~10% red visible
const DST = mk(80); // wide reveal — ~80% red visible

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import {
  importSvg, createBundle, createShapeMorph,
  createRenderer, loadShaders,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

const bSrc = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
const bDst = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
const morph = createShapeMorph(gl, bSrc, bDst);

function snap(handle) {
  renderer.render(handle);
  const w = cnv.width, h = cnv.height;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // Count rows that are >= 50% red along their middle column.
  let redPixels = 0;
  const midX = w >> 1;
  for (let y = 0; y < h; y++) {
    const i = (y * w + midX) * 4;
    if (px[i] > 128 && px[i+1] < 64 && px[i+2] < 64) redPixels++;
  }
  return redPixels;
}

morph.setT(0);   const cnt0   = snap(morph);
morph.setT(0.5); const cntMid = snap(morph);
morph.setT(1);   const cnt1   = snap(morph);
window.__result = { cnt0, cntMid, cnt1, h: cnv.height };
window.__done = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.setViewport({ width: 300, height: 300 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 10000, polling: 100 });
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let failures = 0;
console.log('canvas height =', r.h);
console.log(`red rows at t=0   = ${r.cnt0}  (expect ~10% of canvas h)`);
console.log(`red rows at t=0.5 = ${r.cntMid}  (expect ~45% — midpoint of 10% and 80%)`);
console.log(`red rows at t=1   = ${r.cnt1}  (expect ~80%)`);

if (r.cnt0 <= 2 || r.cntMid <= 2 || r.cnt1 <= 2)
  console.error('FAIL one or more reads produced zero / negligible red — mask is fully clipping');
else if (r.cntMid <= r.cnt0 + 5) {
  failures++;
  console.error('FAIL midpoint not visibly bigger than t=0 (mask not interpolating)');
} else if (r.cntMid >= r.cnt1 - 5) {
  failures++;
  console.error('FAIL midpoint not visibly smaller than t=1 (mask not interpolating)');
} else
  console.log(
    'ok mask geometry interpolates monotonically across t (' +
      r.cnt0 +
      ' < ' +
      r.cntMid +
      ' < ' +
      r.cnt1 +
      ')',
  );

console.log();
console.log(failures === 0 ? 'MASK-WIPE PASS' : `MASK-WIPE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
