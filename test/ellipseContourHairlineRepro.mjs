// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Guards against a vertical center hairline in circles built from
// ellipseContour: the 4-segment cubic approximation lands its top and
// bottom apex vertices on x=cx (the center column), where the coverage
// H-walker can mis-count the crossing at the shared-endpoint vertex.
// Renders a circle at multiple sizes and reads the center column.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'ellipse-hairline');
mkdirSync(OUT, { recursive: true });

// Cover both even and odd canvas widths: the hairline appears at widths
// where (canvas_w / em_w) places the center column on an exact pixel
// center — typically odd widths (e.g. 157, 241).
const sizes = [50, 100, 150, 157, 200, 241, 250, 300, 400, 599];

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="400" height="400"></canvas>
<script type="module">
import {
  createScene, sceneToBundle, ellipseContour,
  createBundle, createRenderer, loadShaders,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

const sizes = ${JSON.stringify(sizes)};
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const results = {};
for (const px of sizes) {
  cnv.width = px;
  cnv.height = px;
  const scene = createScene();
  scene.root.shapes.push({
    contours: [ellipseContour(50, 50, 50, 50)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const sections = await sceneToBundle(scene);
  const bundle = createBundle(gl, sections);
  renderer.setViewport(px, px);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  // Read the CENTER COLUMN — if a hairline exists it shows as
  // black/dark pixels along x = px/2 with red on either side.
  const w = px, h = px;
  const colX = w >> 1;
  const pxBuf = new Uint8Array(4);
  const colRs = [];     // R value at each y of center column
  const sideRs = [];    // R value at colX - 2 (just left of column)
  for (let y = 0; y < h; y++) {
    gl.readPixels(colX,     y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf); colRs.push(pxBuf[0]);
    gl.readPixels(colX - 2, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf); sideRs.push(pxBuf[0]);
  }
  // Count rows where center is visibly DARKER than the side (hairline).
  // Threshold: side > 200 (deep inside the disk) AND center < side - 20.
  let darkerRows = 0;
  const darkerY = [];
  for (let y = 0; y < h; y++) {
    if (sideRs[y] > 200 && colRs[y] < sideRs[y] - 20) {
      darkerRows++;
      if (darkerY.length < 5) darkerY.push({ y, col: colRs[y], side: sideRs[y] });
    }
  }
  results[px] = {
    interiorRows: sideRs.filter(v => v > 200).length,
    centerDarkerRows: darkerRows,
    sample: darkerY,
    pngDataUrl: cnv.toDataURL('image/png'),
  };
  bundle.dispose();
}
window.__result = results;
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
await page.setViewport({ width: 500, height: 500 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 });
const results = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let anyHairline = false;
for (const px of sizes) {
  const r = results[px];
  const pct = r.interiorRows > 0 ? ((100 * r.centerDarkerRows) / r.interiorRows).toFixed(1) : '0';
  console.log(
    `size=${String(px).padStart(3)}: interior=${r.interiorRows}, center-darker=${r.centerDarkerRows} (${pct}%) ${r.sample.length ? 'first: ' + JSON.stringify(r.sample[0]) : ''}`,
  );
  if (r.pngDataUrl) {
    writeFileSync(
      path.join(OUT, `ellipse-${px}.png`),
      Buffer.from(r.pngDataUrl.slice('data:image/png;base64,'.length), 'base64'),
    );
  }
  if (r.centerDarkerRows > 3) anyHairline = true;
}
console.log(`PNGs saved to ${OUT}`);
if (anyHairline) {
  console.error('FAIL: center hairline detected (center column pixels darker than +/-2 px sides)');
  process.exit(1);
}
console.log('PASS: no center hairline at any tested size');
