// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerViewportClipRenderSmoke — a marker's content is clipped to its viewport unless its overflow is visible, on the
// GPU, against Chrome (the CPU proof is test/markerViewportClipSmoke.mjs).
//
// Seven markers, one per column, each with content that overflows its viewport: a disc overflowing a 0 0 10 10 viewBox
// (overflow hidden, the initial value); the same with overflow="visible" (the control: Chrome draws it whole); a wide
// rect under the default "xMidYMid meet" of a 0 0 10 20 viewBox in a 30 x 30 viewport (the clip reaches past the
// viewBox on x); the same under "xMidYMid slice" (a band of the viewBox); no viewBox (a 6 x 4 viewport); a stroked
// square whose stroke reaches out of the viewBox; and orient="auto" on a diagonal with markerUnits="strokeWidth".
// Plain, and under scale(2 1.5) rotate(20) (the marker transformed with its path). The reference is Chrome
// rasterizing the same SVG at 8x, each pixel the average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline; at most 3 per row. Without the viewport clip every clipped column would draw its overflow. REPORTED, NOT HELD: pixels off by
// more than 32/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 110,
  CARRIERS = ['', 'scale(2 1.5) rotate(20)'];
const MARKERS = [
  // [marker attributes, content, the path's d and stroke-width]
  [
    'viewBox="0 0 10 10" refX="5" refY="5" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
    '<circle cx="5" cy="5" r="8" fill="#000"/>',
    'M-20 0 L0 0',
    1,
  ],
  [
    'viewBox="0 0 10 10" refX="5" refY="5" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0" overflow="visible"',
    '<circle cx="5" cy="5" r="8" fill="#000"/>',
    'M-20 0 L0 0',
    1,
  ],
  [
    'viewBox="0 0 10 20" refX="5" refY="10" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
    '<rect x="-9" y="3" width="28" height="14" fill="#000"/>',
    'M-20 0 L0 0',
    1,
  ],
  [
    'viewBox="0 0 10 20" preserveAspectRatio="xMidYMid slice" refX="5" refY="10" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
    '<rect x="2" y="1" width="6" height="18" fill="#000"/>',
    'M-20 0 L0 0',
    1,
  ],
  [
    'refX="3" refY="2" markerWidth="6" markerHeight="4" markerUnits="userSpaceOnUse" orient="0"',
    '<rect x="-4" y="-6" width="14" height="16" fill="#000"/>',
    'M-20 0 L0 0',
    1,
  ],
  [
    'viewBox="0 0 10 10" refX="5" refY="5" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
    '<rect x="1" y="1" width="8" height="8" fill="none" stroke="#000" stroke-width="3"/>',
    'M-20 0 L0 0',
    1,
  ],
  [
    'viewBox="0 0 10 10" refX="2" refY="5" markerWidth="8" markerHeight="8" markerUnits="strokeWidth" orient="auto"',
    '<path d="M-3 -2 L12 5 L-3 12 Z" fill="#000"/>',
    'M-25 -18 L0 0',
    3,
  ],
];
const W = MARKERS.length * CELL,
  H = CARRIERS.length * CELL;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
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

const DEFS =
  '<defs>' +
  MARKERS.map(([attrs, content], i) => `<marker id="m${i}" ${attrs}>${content}</marker>`).join('') +
  '</defs>';
// Corner dots pin the content box to the canvas, so em -> px is the viewBox mapping whatever the clips take away.
const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  DEFS +
  DOTS +
  CARRIERS.map((t, r) =>
    MARKERS.map(
      ([, , d, sw], c) =>
        `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">` +
        `<path d="${d}" fill="none" stroke="none" stroke-width="${sw}" marker-end="url(#m${c})"/></g>`,
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
const WRONG_INK_MAX = 3; // per row, across its markers
for (const route of ['none', 'lb']) {
  const o = await page.evaluate((s, r) => window.__case(s, r), svg, route);
  const rows = CARRIERS.map(() => ({ wrong: 0, over32: 0, ink: 0, ex: [] }));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if ((x < 2 && y < 2) || (x >= W - 2 && y >= H - 2)) continue; // the pinning dots
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
console.log('\nmarkerViewportClipRenderSmoke: markers are clipped to their viewports on the GPU');
