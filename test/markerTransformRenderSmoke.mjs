// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerTransformRenderSmoke — markers are placed in their path's own space and transformed with the path, on the GPU,
// against Chrome (the CPU proof is test/markerTransformSmoke.mjs).
//
// Three paths with markers under six carriers, one per row: two CONFORMAL rows, rotate(30) scale(2) and the reflection
// scale(-2 2), then scale(2 1.5), skewX(30), rotate(30) scale(3 1) and scale(-2 1.5) rotate(20). The columns:
//   1. an unstroked polyline, markerUnits="strokeWidth": a stroked ring at the start and the middle vertex, an
//      asymmetric filled arrow at the end, orient="auto";
//   2. a stroked cubic, orient="auto-start-reverse" arrows at both ends, markerUnits="userSpaceOnUse";
//   3. an unstroked triangle, a stroked square at every vertex, a FIXED orient="30".
// The reference is Chrome rasterizing the same SVG at 8x, each pixel the average of its 64 samples (the AA reference
// every render smoke here uses).
//
// WHAT IS HELD: the INK. Black on white, a pixel's ink is 1 - its luminance; one whose ink differs from the reference's
// by more than half is on the wrong side of an outline. Every row fails for markers placed on the document-space path
// with the CTM's mean scale (undistorted, turned to the transformed tangent, never mirrored), or for a marker child's
// stroke-width -- in marker units -- left at its authored width (the rings draw twice as wide, even on the conformal
// rows). REPORTED, NOT HELD: pixels off by more than 32/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 104,
  CARRIERS = [
    'rotate(30) scale(2)',
    'scale(-2 2)',
    'scale(2 1.5)',
    'skewX(30)',
    'rotate(30) scale(3 1)',
    'scale(-2 1.5) rotate(20)',
  ];
const W = 3 * CELL,
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

// Each column's content is in local coordinates about its origin, within 14 units, so the widest carrier (x3) keeps it
// inside its 104 px cell.
const DEFS =
  '<defs>' +
  // an asymmetric arrow (a reflection shows) and a ring whose stroke is in marker units
  '<marker id="arr" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 2 L6 5 L10 9 L1 10 Z" fill="#000"/></marker>' +
  '<marker id="ring" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="2.5" markerHeight="2.5" orient="auto"><circle cx="5" cy="5" r="4" fill="none" stroke="#000" stroke-width="3"/></marker>' +
  '<marker id="rev" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 2 L6 5 L10 9 L1 10 Z" fill="#000"/></marker>' +
  '<marker id="sq" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="30"><rect x="2" y="2" width="6" height="6" fill="none" stroke="#000" stroke-width="2" stroke-linejoin="miter"/></marker>' +
  '</defs>';
const COLUMNS = [
  '<path d="M-12 -5 L0 6 L12 -5" fill="none" stroke="none" stroke-width="2" marker-start="url(#ring)" marker-mid="url(#ring)" marker-end="url(#arr)"/>',
  '<path d="M-10 8 C-5 -14 5 14 10 -8" fill="none" stroke="#000" stroke-width="1.5" marker-start="url(#rev)" marker-end="url(#rev)"/>',
  '<polygon points="-10,-8 10,-8 0,10" fill="none" stroke="none" marker-start="url(#sq)" marker-mid="url(#sq)" marker-end="url(#sq)"/>',
];
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  DEFS +
  CARRIERS.map((t, r) =>
    COLUMNS.map(
      (el, c) =>
        `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">${el}</g>`,
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
const WRONG_INK_MAX = 3; // per row, across its three paths
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
      what = r < 2 ? `${t} (conformal)` : t;
    const line = `route ${route}, ${what}: ${e.wrong} px on the wrong side of an outline (ink off by more than half) of ${e.ink} inked; ${e.over32} px off by more than 32/255`;
    if (e.ink > 300 && e.wrong <= WRONG_INK_MAX) ok(line);
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
  "\nmarkerTransformRenderSmoke: markers are placed in their path's space and transformed with it on the GPU",
);
