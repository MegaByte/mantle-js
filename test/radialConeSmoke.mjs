// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// radialConeSmoke — a radial gradient whose focus lies outside its circle draws SVG 2's cone
//.
//
// SVG 2: a point lies on the circle interpolated from the focus (radius 0) to the end circle, and
// takes the LARGEST parameter with a non-negative radius; with the focus outside the circle that is
// a cone touched by both, transparent outside it. A parameter of 1 / ((B + sqrt(disc)) / 2A) is
// the SMALLER root once the focus is outside, and wrong across most of the square against Chrome.
// The shader takes the larger root, and antialiases the
// cone's EDGE by the box filter REPEAT seams use: the root discriminant is linear across a
// pixel at the edge, so the covered fraction is the same trapezoid tail.
//
// THE REFERENCE IS BOX-FILTERED: Chrome rasterizes the SVG at 8x and each pixel averages its 64
// samples. A focus-inside gradient is the control. What remains is the cone's APEX, where the
// discriminant is not linear across a pixel and a REPEAT's rings compress without bound (the pixel is
// under-sampled and falls back to point sampling).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
// A 16x16 checker of 4x4 cells, red and blue: its smallest mip is purple, which neither colour is.
const cv = document.createElement('canvas'); cv.width = cv.height = 16;
const cx = cv.getContext('2d');
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { cx.fillStyle = (x + y) & 1 ? '#00f' : '#f00'; cx.fillRect(x * 4, y * 4, 4, 4); }
window.__checker = cv.toDataURL('image/png');
window.__case = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const drew = Object.assign({}, (R.debugStats.engines || {}).draws || {});
  b.dispose && b.dispose();
  // THE REFERENCE IS BOX-FILTERED: Chrome rasterizes the SVG at 8x and each pixel averages its 64
  // samples. A REPEAT gradient's seam is antialiased by box filter both sides, which a
  // browser's own point-sampled seam is not; a pixelated image's texel edges sit on pixel
  // boundaries here, so for the image cases the two references agree.
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
  return { mantle: Array.from(m), chrome: Array.from(ref), drew };
};
window.__ready = true;
</script></body></html>`;

const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}"><defs>${defs}</defs>${body}</svg>`;
// Seams: every 32 user units from 1 (the tile starts at x = y = 1), one pixel either side. ODD
// seams: a seam on a multiple of 32 falls between 2x2 derivative quads and no quad spans the wrap.
const onSeam32 = (x, y) =>
  (x - 1) % 32 === 0 || (x - 1) % 32 === 31 || (y - 1) % 32 === 0 || (y - 1) % 32 === 31;
const CASES = () => [
  {
    name: 'focus outside, PAD',
    svg: svg(
      `<radialGradient id="g" cx="128" cy="128" r="40" fx="200" fy="128" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient>`,
      `<rect width="${N}" height="${N}" fill="url(#g)"/>`,
    ),
  },
  {
    name: 'focus outside, REPEAT',
    svg: svg(
      `<radialGradient id="g" cx="128" cy="128" r="40" fx="200" fy="128" gradientUnits="userSpaceOnUse" spreadMethod="repeat"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient>`,
      `<rect width="${N}" height="${N}" fill="url(#g)"/>`,
    ),
  },
  {
    name: 'focus outside, oblique, REFLECT',
    svg: svg(
      `<radialGradient id="g" cx="110" cy="140" r="30" fx="40" fy="60" gradientUnits="userSpaceOnUse" spreadMethod="reflect"><stop offset="0" stop-color="#0a0"/><stop offset="0.5" stop-color="#fc0"/><stop offset="1" stop-color="#00f"/></radialGradient>`,
      `<rect width="${N}" height="${N}" fill="url(#g)"/>`,
    ),
  },
  {
    name: 'focus inside (control)',
    svg: svg(
      `<radialGradient id="g" cx="128" cy="128" r="60" fx="110" fy="120" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient>`,
      `<rect width="${N}" height="${N}" fill="url(#g)"/>`,
    ),
  },
];

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
for (const c of CASES())
  for (const route of ['none', 'lb']) {
    const o = await page.evaluate((s, r) => window.__case(s, r), c.svg, route);
    const isSeam = () => false;
    let seamN = 0,
      seamBad = 0,
      restN = 0,
      restBad = 0,
      max = 0,
      sum = 0,
      over8 = 0;
    const ex = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        const d = Math.max(
          Math.abs(o.mantle[i] - o.chrome[i]),
          Math.abs(o.mantle[i + 1] - o.chrome[i + 1]),
          Math.abs(o.mantle[i + 2] - o.chrome[i + 2]),
        );
        if (d > max) max = d;
        sum += d;
        if (d > 8) over8++;
        const s = isSeam(x, y);
        if (s) seamN++;
        else restN++;
        if (d > 32) {
          if (s) seamBad++;
          else restBad++;
          if (ex.length < 4)
            ex.push(`(${x},${y}) m${o.mantle.slice(i, i + 3)} c${o.chrome.slice(i, i + 3)}`);
        }
      }
    const msg = `${c.name}, route ${route}: ${restBad} px off the box-filtered reference by more than 32/255, ${over8} by more than 8; max ${max}/255, mean ${(sum / (N * N)).toFixed(2)}`;
    // Bars by case, set from the apex residual (PAD 1 px past 32, REFLECT 3, REPEAT 36 -- the rings
    // compress into the apex) with room for another GPU; the smaller root reads thousands.
    const lim = c.name.includes('inside')
      ? { over: 0, mean: 0.05 }
      : c.name.includes('REPEAT')
        ? { over: 60, mean: 0.3 }
        : { over: 10, mean: 0.3 };
    const mean = sum / (N * N);
    if (restBad <= lim.over && mean <= lim.mean)
      ok(msg + ` (bars: ${lim.over} px past 32, mean ${lim.mean})`);
    else
      fail(
        msg +
          ` — past the bars (${lim.over} px, mean ${lim.mean})` +
          (ex.length ? '  e.g. ' + ex.join('  ') : ''),
      );
  }
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nradialConeSmoke: an outside focus draws the SVG 2 cone, its edge box-filtered');
