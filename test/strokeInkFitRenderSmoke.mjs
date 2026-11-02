// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeInkFitRenderSmoke -- on the GPU: a renderer that FITS the content box (setViewport + drawBundle) must not crop a
// stroke's ink. A globalBBox of path +- halfW leaves a miter spike and the corners of a diagonal square cap outside the box, and the
// canvas edge would cut them flat. Each case is drawn at a canvas of the content box's aspect, so the box fills
// the canvas: the ink must reach the edge only at the tip itself (a short run of pixels on the border), never as a flat cut.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = [
  // 67.4 degree corner, half width 5, limit 10: the tip is 4 units above path +- halfW. The ink box: 90 x 74.01.
  {
    name: 'miter spike',
    d: 'M10 80 L50 20 L90 80',
    attrs: 'stroke-width="10" stroke-miterlimit="10"',
    W: 270,
    H: 222,
    edges: ['top'],
  },
  // a diagonal square cap: the corner points leave path +- halfW by 4.14 units on each side. The ink box: 88.28 square.
  {
    name: 'diagonal square caps',
    d: 'M20 20 L80 80',
    attrs: 'stroke-width="20" stroke-linecap="square"',
    W: 200,
    H: 200,
    edges: ['top', 'bottom', 'left', 'right'],
  },
];
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="300" height="300"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (svg, W, H) => {
  const c = document.getElementById('c'); c.width = W; c.height = H;
  R.setViewport(W, H);
  const b = createBundle(gl, await importSvg(svg));
  const draw = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, {}); R.endFrame(); };
  const warmed = await R.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  if (!warmed.complete) throw Error('scene did not finish warming');
  draw();
  const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = { px: Array.from(px), err: gl.getError(), box: Array.from(b.globalBBox) };
  b.dispose();
  return out;
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
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
for (const c of CASES) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${c.d}" fill="none" stroke="#000" ${c.attrs}/></svg>`;
  let r;
  try {
    r = await page.evaluate((s, w, h) => window.__render(s, w, h), svg, c.W, c.H);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const dark = (x, y) => r.px[((c.H - 1 - y) * c.W + x) * 4] < 128;
  // the longest run of ink pixels along each border line
  const run = (len, f) => {
    let best = 0,
      cur = 0;
    for (let i = 0; i < len; i++) {
      cur = f(i) ? cur + 1 : 0;
      best = Math.max(best, cur);
    }
    return best;
  };
  const runs = {
    top: run(c.W, (x) => dark(x, 0)),
    bottom: run(c.W, (x) => dark(x, c.H - 1)),
    left: run(c.H, (y) => dark(0, y)),
    right: run(c.H, (y) => dark(c.W - 1, y)),
  };
  const worst = Math.max(...c.edges.map((e) => runs[e]));
  // ...and the ink must reach the edge at all (within 3 px of it: a tip is a point and anti-aliases below the threshold)
  const near = {
    top: (x, k) => dark(x, k),
    bottom: (x, k) => dark(x, c.H - 1 - k),
    left: (y, k) => dark(k, y),
    right: (y, k) => dark(c.W - 1 - k, y),
  };
  const touched = c.edges.every((e) => {
    const len = e === 'top' || e === 'bottom' ? c.W : c.H;
    for (let i = 0; i < len; i++) for (let k = 0; k < 3; k++) if (near[e](i, k)) return true;
    return false;
  });
  const line = `${c.name}: box [${r.box.map((v) => +v.toFixed(2))}], border ink runs ${JSON.stringify(runs)}`;
  if (r.err) fail(line + ' -- GL error ' + r.err);
  else if (worst > 5)
    fail(line + ' -- the ink is cut flat by the canvas edge (a run of ' + worst + ' px)');
  else if (!touched) fail(line + ' -- vacuous: the ink does not reach the edge at all');
  else console.log('ok ' + line);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nstrokeInkFitRenderSmoke: a fit-to-content view does not crop miter tips or square-cap corners',
);
