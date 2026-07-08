// fourCubicEllipseHairlineSmoke.mjs — Renderer robustness against the
// centre-vertical hairline produced by the canonical 4-cubic ellipse fan
// (cardinal-point joints at (cx±rx,cy) and (cx,cy±ry)).
//
// The 4-cubic fan double-counts the shared-vertex crossing at the top +
// bottom apex (x=cx, y=cy±ry) when the coverage H-walker scans the centre
// column. This authors the fan directly via the cubic-segment scene API so
// it exercises the renderer (not the ellipse emitter): a passing run means
// the renderer is robust to shared-vertex apex joints.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'four-cubic-ellipse');
mkdirSync(OUT, { recursive: true });

// Sizes — sweep wide enough to catch the resolution-sensitive case where
// the joint x lands on a pixel centre at some sizes but not others.
const sizes = [50, 100, 150, 157, 200, 241, 250, 300, 400, 599];

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="400" height="400"></canvas>
<script type="module">
import {
  createScene, sceneToBundle,
  createBundle, createRenderer, loadShaders,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', {
  stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true,
});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

// The exact 4-cubic ellipse fan.
const K = 0.5522847498307936;
function fourCubicEllipseContour(cx, cy, rx, ry) {
  const Kx = rx * K, Ky = ry * K;
  return {
    segments: [
      { p0: [cx + rx, cy     ], p1: [cx + rx, cy + Ky], p2: [cx + Kx, cy + ry] },
      { p0: [cx,      cy + ry], p1: [cx - Kx, cy + ry], p2: [cx - rx, cy + Ky] },
      { p0: [cx - rx, cy     ], p1: [cx - rx, cy - Ky], p2: [cx - Kx, cy - ry] },
      { p0: [cx,      cy - ry], p1: [cx + Kx, cy - ry], p2: [cx + rx, cy - Ky] },
    ],
    closed: true,
  };
}

const sizes = ${JSON.stringify(sizes)};
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const results = {};
for (const px of sizes) {
  cnv.width = px;
  cnv.height = px;
  const scene = createScene();
  scene.root.shapes.push({
    contours: [fourCubicEllipseContour(50, 50, 50, 50)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const sections = await sceneToBundle(scene);
  const bundle = createBundle(gl, sections);
  renderer.setViewport(px, px);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  // Read centre column + sample 2 px to either side per row.
  const w = px, h = px;
  const colX = w >> 1;
  const buf = new Uint8Array(4);
  const colRs = [], sideRs = [];
  for (let y = 0; y < h; y++) {
    gl.readPixels(colX,     y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); colRs.push(buf[0]);
    gl.readPixels(colX - 2, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); sideRs.push(buf[0]);
  }
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
    centreDarkerRows: darkerRows,
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
  const mime = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
             : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try { res.writeHead(404); res.end(); } catch {}
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.setViewport({ width: 500, height: 500 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 30000 });
const results = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let anyHairline = false;
for (const px of sizes) {
  const r = results[px];
  const pct = r.interiorRows > 0
    ? (100 * r.centreDarkerRows / r.interiorRows).toFixed(1)
    : '0';
  console.log(`size=${String(px).padStart(3)}: interior=${r.interiorRows}, centre-darker=${r.centreDarkerRows} (${pct}%) ${r.sample.length ? 'first: ' + JSON.stringify(r.sample[0]) : ''}`);
  if (r.pngDataUrl) {
    writeFileSync(path.join(OUT, `4cubic-${px}.png`),
      Buffer.from(r.pngDataUrl.slice('data:image/png;base64,'.length), 'base64'));
  }
  if (r.centreDarkerRows > 3) anyHairline = true;
}
console.log(`PNGs saved to ${OUT}`);
if (anyHairline) {
  console.error('FAIL: 4-cubic ellipse centre hairline detected');
  process.exit(1);
}
console.log('PASS: 4-cubic ellipse renders clean (renderer robust to shared-vertex apex)');
