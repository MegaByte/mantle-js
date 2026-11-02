// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerAspectRenderSmoke — a marker's viewBox is fitted into its viewport by preserveAspectRatio, on the GPU, against
// Chrome (the CPU proof is test/markerAspectSmoke.mjs).
//
// An asymmetric filled arrow in a viewBox 0 0 10 20, fitted into a 30 x 30 viewport six ways, one per column: the
// default ("xMidYMid meet"), "xMinYMin meet", "xMaxYMax meet", "none", "xMidYMid slice" (an arrow inside the band a
// slice shows, so Chrome's overflow clip takes nothing), and no viewBox at all (the content in the viewport's own
// units); plain, and under rotate(30) scale(2). The reference is Chrome rasterizing the same SVG at 8x, each pixel the
// average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline. Scaling each axis on its own would stretch the meet and slice columns, and a "0 0 3 3" stand-in viewBox would draw
// the no-viewBox column ten times too big; the "none" column is the control. REPORTED, NOT HELD: pixels off by more than 32/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 104,
  CARRIERS = ['', 'rotate(30) scale(2)'];
const W = 6 * CELL,
  H = CARRIERS.length * CELL;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${W}, ${H}); gl.viewport(0, 0, ${W}, ${H});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${W} * ${H} * 4);
  gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  // THE REFERENCE IS BOX-FILTERED: Chrome rasterizes the SVG at 8x and each pixel averages its 64 samples.
  const SS = 8, W2 = ${W} * SS, H2 = ${H} * SS;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="${W}" height="${H}"', 'width="' + W2 + '" height="' + H2 + '"')); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = W2; c2.height = H2;
  const ctx = c2.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W2, H2); ctx.drawImage(img, 0, 0, W2, H2);
  const big = ctx.getImageData(0, 0, W2, H2).data, ref = new Uint8ClampedArray(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) for (let x = 0; x < ${W}; x++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * W2 + x * SS + i) * 4 + ch];
    ref[(y * ${W} + x) * 4 + ch] = Math.round(s / (SS * SS));
  }
  const m = new Uint8Array(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) m.set(px.subarray((${H} - 1 - y) * ${W} * 4, (${H} - y) * ${W} * 4), y * ${W} * 4);
  return { mantle: Array.from(m), chrome: Array.from(ref) };
};
window.__ready = true;
</script></body></html>`;

const ARROW = 'M1 2 L9 6 L5 9 L9 16 L2 18 Z',
  ARROW_BAND = 'M1 6 L9 8 L5 10 L9 13 L2 14 Z';
const FITS = [
  ['', ARROW],
  ['preserveAspectRatio="xMinYMin meet"', ARROW],
  ['preserveAspectRatio="xMaxYMax meet"', ARROW],
  ['preserveAspectRatio="none"', ARROW],
  ['preserveAspectRatio="xMidYMid slice"', ARROW_BAND],
  [null, ARROW],
];
const DEFS =
  '<defs>' +
  FITS.map(
    ([par, d], i) =>
      `<marker id="m${i}" ${par === null ? '' : 'viewBox="0 0 10 20" ' + par}` +
      ` refX="2" refY="10" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"><path d="${d}" fill="#000"/></marker>`,
  ).join('') +
  '</defs>';
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  DEFS +
  CARRIERS.map((t, r) =>
    FITS.map(
      (_, c) =>
        `<g transform="translate(${CELL * c + 30} ${CELL * r + CELL / 2}) ${t}">` +
        `<path d="M-20 0 L0 0" fill="none" stroke="none" marker-end="url(#m${c})"/></g>`,
    ).join(''),
  ).join('') +
  '</svg>';

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
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const WRONG_INK_MAX = 3; // per row, across its six markers
for (const route of ['none', 'lb']) {
  const o = await page.evaluate((s, r) => window.__case(s, r), svg, route);
  const rows = CARRIERS.map(() => ({ wrong: 0, over32: 0, ink: 0, ex: [] }));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4,
        row = rows[Math.min(CARRIERS.length - 1, Math.floor(y / CELL))];
      const lm = (o.mantle[i] + o.mantle[i + 1] + o.mantle[i + 2]) / 765,
        lc = (o.chrome[i] + o.chrome[i + 1] + o.chrome[i + 2]) / 765;
      const d = Math.max(
        Math.abs(o.mantle[i] - o.chrome[i]),
        Math.abs(o.mantle[i + 1] - o.chrome[i + 1]),
        Math.abs(o.mantle[i + 2] - o.chrome[i + 2]),
      );
      if (lc < 0.5) row.ink++;
      if (d > 32) row.over32++;
      if (Math.abs(lm - lc) > 0.5) {
        row.wrong++;
        if (row.ex.length < 3)
          row.ex.push(`(${x},${y}) ink ${(1 - lm).toFixed(2)} for ${(1 - lc).toFixed(2)}`);
      }
    }
  CARRIERS.forEach((t, r) => {
    const e = rows[r],
      what = t || 'plain';
    const line = `route ${route}, ${what}: ${e.wrong} px on the wrong side of an outline (ink off by more than half) of ${e.ink} inked; ${e.over32} px off by more than 32/255`;
    if (e.ink > 1000 && e.wrong <= WRONG_INK_MAX) ok(line);
    else fail(line + (e.ex.length ? ' -- ' + e.ex.join('; ') : ''));
  });
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nmarkerAspectRenderSmoke: marker viewBoxes are fitted by preserveAspectRatio on the GPU',
);
