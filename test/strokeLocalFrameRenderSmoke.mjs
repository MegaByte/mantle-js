// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeLocalFrameRenderSmoke — a stroke under a non-conformal transform draws the image of its LOCAL stroke, on the
// GPU, against Chrome (the CPU proof is test/strokeLocalFrameSmoke.mjs).
//
// Five strokes (a miter polyline with butt caps, a round cubic, an elliptical arc with square caps, a dashed polyline
// and a circle) under five carriers, one per row: a CONFORMAL control, rotate(30) scale(2), then scale(2 1.5),
// skewX(30), rotate(30) scale(3 1) and scale(-2 1.5) skewY(10). The reference is Chrome rasterizing the same SVG at 8x,
// each pixel the average of its 64 samples (the AA reference every render smoke here uses).
//
// WHAT IS HELD: the INK. Black on white, a pixel's ink is 1 - its luminance; one whose ink differs from the reference's
// by more than half is on the wrong side of the outline, which no AA ramp does to a correct edge. A stroke at one mean
// width under a non-conformal row gets every edge whose true width differs from the mean by half a pixel or more wrong
// that way -- the rows below are sized so that is most of them (half-width off by 0.6 to 2.5 px). The control row is
// held to the same bar, so a failure there is the harness, not the renderer.
//
// NOT VACUOUS: the reference must ink every stroke of a row -- each of its five cells at least CELL_INK_MIN pixels --
// or a blank reference (an SVG the browser failed to draw) would agree with anything. The bar is per stroke, not per
// row: a row's ink scales with its carrier's area, |det|, and skewX(30), which keeps area, inks 714 px where the
// scaled carriers ink 2,209 to 3,006 (about 740 px per unit of |det| in every row). A row total of 1,000 as the bar would
// fail the skew row on its size alone, with no pixel on the wrong side.
//
// REPORTED, NOT HELD: pixels off by more than 32/255. Where a cap or a join wins, the walk has no boundary normal to map
// and ramps with the geometric mean of the frame's stretch, so a cap edge's AA width is off by up to sqrt(stretch)
// (1.7x on the rotate(30) scale(3 1) row) -- the edge is exactly placed, its ramp is not exactly shaped.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 520,
  CELL = 104;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
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
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  // THE REFERENCE IS BOX-FILTERED: Chrome rasterizes the SVG at 8x and each pixel averages its 64 samples.
  const SS = 8, M2 = ${N} * SS;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="${N}" height="${N}"', 'width="' + M2 + '" height="' + M2 + '"')); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = c2.height = M2;
  const ctx = c2.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, M2, M2); ctx.drawImage(img, 0, 0, M2, M2);
  const big = ctx.getImageData(0, 0, M2, M2).data, ref = new Uint8ClampedArray(${N} * ${N} * 4);
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * M2 + x * SS + i) * 4 + ch];
    ref[(y * ${N} + x) * 4 + ch] = Math.round(s / (SS * SS));
  }
  const m = new Uint8Array(${N} * ${N} * 4);
  for (let y = 0; y < ${N}; y++) m.set(px.subarray((${N} - 1 - y) * ${N} * 4, (${N} - y) * ${N} * 4), y * ${N} * 4);
  return { mantle: Array.from(m), chrome: Array.from(ref) };
};
window.__ready = true;
</script></body></html>`;

// Rows: carriers (the first is the conformal control). Columns: strokes, each in local coordinates about its origin,
// sized so the widest carrier (x3) keeps it inside its 104 px cell.
const CARRIERS = [
  'rotate(30) scale(2)',
  'scale(2 1.5)',
  'skewX(30)',
  'rotate(30) scale(3 1)',
  'scale(-2 1.5) skewY(10)',
];
const STROKES = [
  '<path d="M-10 -7 L7 -7 L7 7 L-5 10" stroke-width="5" stroke-linejoin="miter" stroke-linecap="butt"/>',
  '<path d="M-10 0 C-5 -12 5 12 10 0" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>',
  '<path d="M-9 3 A9 5 30 0 1 7 5" stroke-width="4" stroke-linecap="square"/>',
  // dashes 6 3 from offset 6: the corner at path length 24 sits mid-dash, 3 units clear of either end
  '<path d="M-12 -6 L12 -6 L12 10" stroke-width="3" stroke-linejoin="miter" stroke-linecap="butt" stroke-dasharray="6 3" stroke-dashoffset="6"/>',
  '<circle cx="0" cy="0" r="8" stroke-width="4"/>',
];
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  CARRIERS.map((t, r) =>
    STROKES.map(
      (el, c) =>
        `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">` +
        `<g fill="none" stroke="#000">${el}</g></g>`,
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
const WRONG_INK_MAX = 3; // per row, across its five strokes
const CELL_INK_MIN = 40; // reference ink per stroke; the least-inked one, the skew row's dashed polyline, inks 61
for (const route of ['none', 'lb']) {
  const o = await page.evaluate((s, r) => window.__case(s, r), svg, route);
  const rows = CARRIERS.map(() => ({
    wrong: 0,
    over32: 0,
    ink: 0,
    cells: STROKES.map(() => 0),
    ex: [],
  }));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4,
        r = Math.min(CARRIERS.length - 1, Math.floor(y / CELL)),
        row = rows[r];
      const lm = (o.mantle[i] + o.mantle[i + 1] + o.mantle[i + 2]) / 765,
        lc = (o.chrome[i] + o.chrome[i + 1] + o.chrome[i + 2]) / 765;
      const d = Math.max(
        Math.abs(o.mantle[i] - o.chrome[i]),
        Math.abs(o.mantle[i + 1] - o.chrome[i + 1]),
        Math.abs(o.mantle[i + 2] - o.chrome[i + 2]),
      );
      if (lc < 0.5) {
        row.ink++;
        row.cells[Math.min(STROKES.length - 1, Math.floor(x / CELL))]++;
      }
      if (d > 32) row.over32++;
      if (Math.abs(lm - lc) > 0.5) {
        row.wrong++;
        if (row.ex.length < 3)
          row.ex.push(`(${x},${y}) ink ${(1 - lm).toFixed(2)} for ${(1 - lc).toFixed(2)}`);
      }
    }
  CARRIERS.forEach((t, r) => {
    const e = rows[r],
      what = r === 0 ? `${t} (conformal control)` : t;
    const line =
      `route ${route}, ${what}: ${e.wrong} px on the wrong side of the outline (ink off by more than half) of ${e.ink} inked` +
      ` (per stroke ${e.cells.join(' / ')}); ${e.over32} px off by more than 32/255`;
    if (Math.min(...e.cells) >= CELL_INK_MIN && e.wrong <= WRONG_INK_MAX) ok(line);
    else
      fail(
        line +
          (e.ex.length ? ' -- ' + e.ex.join('; ') : '') +
          (r === 0 ? ' (the CONTROL: the harness, not the renderer)' : ''),
      );
  });
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nstrokeLocalFrameRenderSmoke: strokes under non-conformal transforms are the image of their local stroke on the GPU',
);
