// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerClipMaskRenderSmoke — a marker takes the referencing path's clip-path and mask, on the GPU, against Chrome
// (the CPU proof is test/markerClipMaskSmoke.mjs).
//
// Six columns, one per case, each a path that paints nothing with a 16 x 16 square marker on each of its three
// vertices: a userSpaceOnUse clip on the path; the same with marker content that overflows its viewport (the viewport
// clip AND the path's clip); an objectBoundingBox clip (the PATH's box, not the marker's); a clip on the enclosing
// group; a luminance mask on the path; an objectBoundingBox mask. Plain, and under scale(1.5 1.2) rotate(15). The
// reference is Chrome rasterizing the same SVG at 8x, each pixel the average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline; at most 3 per row. Without the path's clip and mask every column would draw every marker whole. REPORTED, NOT HELD: pixels off by
// more than 32/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 110,
  CARRIERS = ['', 'scale(1.5 1.2) rotate(15)'];
// The path (cell-local) and its vertices' markers: 16 x 16 squares centered on each vertex.
const D = 'M-30 -20 L0 10 L30 20';
const SQ = (id, big) =>
  `<marker id="${id}" refX="8" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="0">` +
  (big
    ? '<path d="M-8 -8 H24 V24 H-8 Z" fill="#000"/>'
    : '<path d="M0 0 H16 V16 H0 Z" fill="#000"/>') +
  '</marker>';
// [defs for column c (ids suffixed with c), the path's attributes, wrap the path in a clipped group]
const CASES = [
  [
    (c) =>
      SQ(`m${c}`) +
      `<clipPath id="c${c}"><rect x="-60" y="-60" width="65" height="120"/></clipPath>`,
    (c) => `clip-path="url(#c${c})"`,
    false,
  ],
  [
    (c) =>
      SQ(`m${c}`, true) +
      `<clipPath id="c${c}"><rect x="-60" y="-60" width="65" height="120"/></clipPath>`,
    (c) => `clip-path="url(#c${c})"`,
    false,
  ],
  [
    (c) =>
      SQ(`m${c}`) +
      `<clipPath id="c${c}" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>`,
    (c) => `clip-path="url(#c${c})"`,
    false,
  ],
  [
    (c) =>
      SQ(`m${c}`) +
      `<clipPath id="c${c}"><rect x="-6" y="-60" width="70" height="120"/></clipPath>`,
    () => '',
    true,
  ],
  [
    (c) =>
      SQ(`m${c}`) +
      `<mask id="k${c}"><rect x="-60" y="-60" width="120" height="75" fill="white"/></mask>`,
    (c) => `mask="url(#k${c})"`,
    false,
  ],
  [
    (c) =>
      SQ(`m${c}`) +
      `<mask id="k${c}" maskContentUnits="objectBoundingBox"><rect x="0.5" y="0" width="0.5" height="1" fill="white"/></mask>`,
    (c) => `mask="url(#k${c})"`,
    false,
  ],
];
const W = CASES.length * CELL,
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

// Corner dots pin the content box to the canvas, so em -> px is the viewBox mapping whatever the clips take away.
const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
let defs = '',
  cells = '';
CARRIERS.forEach((t, r) =>
  CASES.forEach(([df, pa, grouped], c) => {
    const k = r * CASES.length + c;
    defs += df(k);
    const p = `<path d="${D}" fill="none" stroke="none" ${pa(k)} marker-start="url(#m${k})" marker-mid="url(#m${k})" marker-end="url(#m${k})"/>`;
    cells +=
      `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">` +
      (grouped ? `<g clip-path="url(#c${k})">${p}</g>` : p) +
      '</g>';
  }),
);
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>` +
  DOTS +
  cells +
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
    if (e.ink > 500 && e.wrong <= WRONG_INK_MAX) ok(line);
    else fail(line + (e.ex.length ? ' -- ' + e.ex.join('; ') : ''));
  });
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log("\nmarkerClipMaskRenderSmoke: markers take their path's clip-path and mask on the GPU");
