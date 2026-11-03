// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// objectBoundingBoxStrokeGradientRenderSmoke — an objectBoundingBox gradient on a STROKE binds to the
// path-tight box on the GPU, under every carrier (the CPU smoke is
// objectBoundingBoxStrokeGradientSmoke).
//
// A positive-diagonal carrier's stroke gradient binds the path-tight box, not the stroke-padded
// meta box. This renders the same four carriers (identity, scale(2 1.5), rotate(30),
// scale(-1 1)) against Chrome rasterized at 8x and box-averaged, and scores the gradient where it
// is the question: the mean color error on pixels both sides ink fully, per carrier. Bound to the
// padded box the identity carrier's stroke would read 5.83/255 and fill-and-stroke 2.65; bound to the
// path box, 0.00.
//
// THE SCALE CARRIER IS HELD TOO. A stroke under a non-conformal CTM is drawn in its own stroke space
// (src/bundle/strokeFrame.js), not at one mean width (3.5 half-width on both axes where SVG draws 4 in x
// and 3 in y), which would move its pixels whatever the gradient did; and the per-carrier
// count of pixels off by more than 32/255 is printed so the scale carrier can be read against the others.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 520;

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
const W0 = 40,
  H0 = 20,
  SW = 4;
const CARRIERS = [
  'translate(40 70)',
  'translate(150 70) scale(2 1.5)',
  'translate(260 70) rotate(30)',
  'translate(390 70) scale(-1 1)',
];
const OBB =
  '<defs><linearGradient id="gd" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#101418"/><stop offset="1" stop-color="#f05a28"/></linearGradient></defs>';
const CASES = () => [
  {
    name: 'objectBoundingBox gradient on fill and stroke, four carriers',
    svg: svg(
      OBB,
      CARRIERS.map(
        (t) =>
          `<g transform="${t}"><rect x="0" y="0" width="${W0}" height="${H0}" fill="url(#gd)" stroke="url(#gd)" stroke-width="${SW}"/></g>`,
      ).join(''),
    ),
  },
  {
    name: 'objectBoundingBox gradient on a stroke only, four carriers',
    svg: svg(
      OBB,
      CARRIERS.map(
        (t) =>
          `<g transform="${t}"><rect x="0" y="0" width="${W0}" height="${H0}" fill="none" stroke="url(#gd)" stroke-width="${SW}"/></g>`,
      ).join(''),
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
    const perBand = {};
    const inked = {};
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
        {
          const lm = o.mantle[i] + o.mantle[i + 1] + o.mantle[i + 2],
            lc = o.chrome[i] + o.chrome[i + 1] + o.chrome[i + 2];
          const band = x < 130 ? 'identity' : x < 250 ? 'scale' : x < 335 ? 'rotate' : 'reflect';
          // fully inked on both sides: the gradient's color, not the AA edge (the ramp's light end is 240,90,40)
          if (o.chrome[i + 3] > 250 && lc < 600 && lm < 600) {
            const e = inked[band] || (inked[band] = { n: 0, s: 0 });
            e.n++;
            e.s += d;
          }
        }
        if (s) seamN++;
        else restN++;
        if (d > 32) {
          if (s) seamBad++;
          else restBad++;
          const band = x < 130 ? 'identity' : x < 250 ? 'scale' : x < 335 ? 'rotate' : 'reflect';
          perBand[band] = (perBand[band] || 0) + 1;
          if (ex.length < 4)
            ex.push(`(${x},${y}) m${o.mantle.slice(i, i + 3)} c${o.chrome.slice(i, i + 3)}`);
        }
      }
    const msg = `${c.name}, route ${route}: ${restBad} px off the box-filtered reference by more than 32/255, ${over8} by more than 8; max ${max}/255, mean ${(sum / (N * N)).toFixed(2)}`;
    for (const band of ['identity', 'scale', 'rotate', 'reflect']) {
      const e = inked[band];
      const m = e ? e.s / e.n : NaN;
      const line = `${c.name}, route ${route}, ${band} carrier: mean ${m.toFixed(2)}/255 over ${e ? e.n : 0} fully inked px`;
      if (e && e.n > 300 && m <= 0.5) ok(line);
      else fail(line + ' — the gradient is off the path-tight box');
    }
    console.log(
      `   ${c.name}, route ${route}: px off by more than 32/255 per carrier: ${['identity', 'scale', 'rotate', 'reflect'].map((b) => `${b} ${perBand[b] || 0}`).join(', ')}`,
    );
  }
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nobjectBoundingBoxStrokeGradientRenderSmoke: stroke gradients bind to the path-tight box on the GPU',
);
