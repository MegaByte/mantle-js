// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrGradientPlacement — DIAGNOSTIC probe (GPU): does a COLRv1 gradient land
// where its coordinates say, inside a glyph that does not fill the canvas?
//
// The COLR paint shaders map their output as if each
// node's render target covered the node's BOX (a gradient pass computes q = uBboxOrigin + vUV *
// uBboxSize; PaintTransform maps through the output and input boxes), so the renderer's COLR leaf
// must pass node rects to evaluateGraph so each target is that box. Without them every target is the whole
// CANVAS and vUV spans the canvas: a glyph at (100, 100, 64, 64) on a 256 px canvas draws its linear gradient
// over a 256 x 256 viewport with uBboxOrigin (100, 100) and uBboxSize (64, 64), so a gradient is squeezed into
// the box's scale and offset across the canvas, and (the boxes are y-down, vUV is y-up) flipped vertically,
// so inside the glyph it shows the wrong colors.
//
// This renders a 64 px square with a synthetic COLR graph -- PaintGlyph(PaintLinearGradient) -- whose
// gradient runs red to blue exactly across the square, horizontally and then vertically, on both
// routes, and reads the color 4 px inside each end. Expected: red at the start, blue at the end.
// If the targets are misplaced: purple at both ends (t near 0.41 and 0.63 instead of 0.06
// and 0.94), and the vertical case reversed.
//
// The renderer passes node rects for the leaf's graph, every pass mapping its own target (colrPaintShared.js),
// the graph placed with its glyph. Node: test/colrPaintPlacementSmoke.mjs replays
// this case through the shaders; render: test/colrGradientPlacementRenderSmoke.mjs.
//
//   node probes/filtperf/colrGradientPlacement.mjs      (exit 1 when a gradient is misplaced)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const N = 256;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (dir, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">'
    + '<rect x="100" y="100" width="64" height="64" fill="#0f0"/></svg>';
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const op = b.drawList.filter((o) => o.kind === 'fillShape').pop();
  const mb = op.shapeIdx * b.metaFloatsPerShape;   // the COLR leaf reads the shape's em box here too
  const M = b.metaFloats;
  const x0 = M[mb], y0 = M[mb + 1], x1 = M[mb + 2], y1 = M[mb + 3];
  const my = (y0 + y1) / 2, mx = (x0 + x1) / 2;
  // The gradient spans the square: horizontal from its left edge to its right, or vertical from top to bottom.
  const p0 = dir === 'h' ? [x0, my] : [mx, y0], p1 = dir === 'h' ? [x1, my] : [mx, y1];
  const p2 = [p0[0] - (p1[1] - p0[1]), p0[1] + (p1[0] - p0[0])];
  b.colrGraphs = [{ nodes: [
    { type: 'PaintLinearGradient', inputs: [], params: { p0, p1, p2, extend: 0,
      stops: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }] } },
    { type: 'PaintGlyph', inputs: [0], params: { glyphId: 1 } },
  ], rootOut: 1 }];
  op.colrGraphId = 1;
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4));
  const pts = dir === 'h' ? { start: at(104, 132), mid: at(132, 132), end: at(160, 132) }
                          : { start: at(132, 104), mid: at(132, 132), end: at(132, 160) };
  b.dispose && b.dispose();
  return { em: [x0, y0, x1, y1], pts, stats: { colrLeaves: R.debugStats.unifiedColrLeaves | 0 } };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => {
  failures++;
  console.error('FAIL: page: ' + e.message);
});
// Red-dominant at the start, blue-dominant at the end, both at least 3:1 over the other.
const reddish = (c) => c[0] >= 3 * Math.max(1, c[2]),
  bluish = (c) => c[2] >= 3 * Math.max(1, c[0]);
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const route of ['none', 'lb'])
    for (const dir of ['h', 'v']) {
      const r = await page.evaluate((d, rt) => window.__case(d, rt), dir, route);
      const tag = `route ${route}, ${dir === 'h' ? 'horizontal' : 'vertical'} gradient (square in em ${r.em.map((v) => v.toFixed(3)).join(',')})`;
      const msg = `${tag}: start rgba(${r.pts.start}) mid rgba(${r.pts.mid}) end rgba(${r.pts.end})`;
      if (reddish(r.pts.start) && bluish(r.pts.end)) console.log('ok ' + msg);
      else {
        failures++;
        console.error('FAIL: ' + msg + ' -- want red at the start and blue at the end');
      }
    }
} catch (e) {
  failures++;
  console.error('FAIL: setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ncolrGradientPlacement: COLR gradients land where their coordinates say');
