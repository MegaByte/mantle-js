// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskRegionRenderSmoke — a <mask>'s REGION cuts what it masks, on the GPU, against Chrome (CSS Masking 1 §7.1; the
// importer's applyMaskRegions, bundleFinalize.js; the CPU proof is test/markerClipMaskSmoke.mjs (b)).
//
// Outside the mask's x/y/width/height rect -- in maskUnits, objectBoundingBox -10%/-10%/120%/120% of the referencing
// element's box by default -- the mask is transparent black. Five columns, each an element under a mask whose content
// is white everywhere, so only the region cuts: a wide mitered stroke that leaves the default region; a stated
// objectBoundingBox region (the left-center quarter of the box); a stated userSpaceOnUse region; a group's stated
// region, a fraction of the GROUP's box; a region on an element that is already clipped (the region nests the clip).
// Plain, and under scale(1.5 1.2) rotate(15). The reference is Chrome rasterizing the same SVG at 8x, each pixel the
// average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline; at most 3 per row. Without the region every column would draw its element whole. REPORTED, NOT HELD: pixels off
// by more than 32/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 110,
  CARRIERS = ['', 'scale(1.5 1.2) rotate(15)'];
const WHITE = '<rect x="-100" y="-100" width="200" height="200" fill="white"/>';
// [defs for column c (ids suffixed with c), the masked element(s)]
const CASES = [
  [
    (c) => `<mask id="k${c}">${WHITE}</mask>`,
    (c) =>
      `<path d="M-30 -20 L30 20" fill="none" stroke="#000" stroke-width="16" mask="url(#k${c})"/>`,
  ],
  [
    (c) => `<mask id="k${c}" x="0.25" y="0" width="0.5" height="1">${WHITE}</mask>`,
    (c) => `<rect x="-40" y="-30" width="80" height="60" fill="#000" mask="url(#k${c})"/>`,
  ],
  [
    (c) =>
      `<mask id="k${c}" maskUnits="userSpaceOnUse" x="-20" y="-40" width="30" height="80">${WHITE}</mask>`,
    (c) => `<rect x="-40" y="-30" width="80" height="60" fill="#000" mask="url(#k${c})"/>`,
  ],
  [
    (c) => `<mask id="k${c}" x="0" y="0.5" width="1" height="0.5">${WHITE}</mask>`,
    (c) =>
      `<g mask="url(#k${c})"><rect x="-40" y="-40" width="30" height="80" fill="#000"/><rect x="10" y="-10" width="30" height="50" fill="#000"/></g>`,
  ],
  [
    (c) =>
      `<mask id="k${c}" x="0" y="0" width="0.5" height="1">${WHITE}</mask><clipPath id="c${c}"><rect x="-60" y="-10" width="120" height="70"/></clipPath>`,
    (c) =>
      `<rect x="-40" y="-30" width="80" height="60" fill="#000" mask="url(#k${c})" clip-path="url(#c${c})"/>`,
  ],
];
const W = CASES.length * CELL,
  H = CARRIERS.length * CELL;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const maskShaders = new WeakMap(), maskPrograms = new Map(), maskDraws = new Map(); let currentMaskProgram = null;
const sourceShader = gl.shaderSource.bind(gl); gl.shaderSource = (shader, source) => {
  if (source.includes('uMaskChildRow1Based')) maskShaders.set(shader, [...source.matchAll(/^#define (MANTLE_\\w+)/gm)].map(m => m[1]));
  return sourceShader(shader, source);
};
const attachShader = gl.attachShader.bind(gl); gl.attachShader = (program, shader) => {
  if (maskShaders.has(shader)) maskPrograms.set(program, maskShaders.get(shader));
  return attachShader(program, shader);
};
const useProgram = gl.useProgram.bind(gl); gl.useProgram = program => { currentMaskProgram = program; return useProgram(program); };
const drawArrays = gl.drawArrays.bind(gl); gl.drawArrays = (...args) => {
  if (maskPrograms.has(currentMaskProgram)) { const key = maskPrograms.get(currentMaskProgram).join('|'); maskDraws.set(key, (maskDraws.get(key) || 0) + 1); }
  return drawArrays(...args);
};
window.__maskProgramUses = () => [...maskDraws].map(([defines, draws]) => ({ defines, draws }));
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__auditImages = async () => { const {runImageCases} = await import('/test/_auditPaintCases.mjs'); return runImageCases(gl, R); };
window.__auditPaint = async () => { const {runPaintCases} = await import('/test/_auditPaintCases.mjs'); return runPaintCases(gl, R); };
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
  const m = new Uint8Array(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) m.set(px.subarray((${H} - 1 - y) * ${W} * 4, (${H} - y) * ${W} * 4), y * ${W} * 4);
  return b64(m);
};
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
// The Chrome reference depends on the document alone, so it is rasterized once for every route.
window.__chromeRef = async (svg) => {
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
  return b64(ref);
};
window.__ready = true;
</script></body></html>`;

// Corner dots pin the content box to the canvas, so em -> px is the viewBox mapping whatever the clips take away.
const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
let defs = '',
  cells = '';
CARRIERS.forEach((t, r) =>
  CASES.forEach(([df, el], c) => {
    const k = r * CASES.length + c;
    defs += df(k);
    cells += `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">${el(k)}</g>`;
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
const WRONG_INK_MAX = 3; // per row, across its columns
const u8 = (b) => new Uint8Array(Buffer.from(b, 'base64'));
const chromeRef = u8(await page.evaluate((s) => window.__chromeRef(s), svg));
for (const route of ['none', 'lb']) {
  const o = {
    mantle: u8(await page.evaluate((s, r) => window.__case(s, r), svg, route)),
    chrome: chromeRef,
  };
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
const auditCases = await page.evaluate(() => window.__auditPaint());
for (const row of auditCases) {
  if (row.maxByte <= 1) ok('audit paint ' + row.name);
  else fail('audit paint ' + JSON.stringify(row));
}
const auditImages = await page.evaluate(() => window.__auditImages());
for (const row of auditImages) {
  if (row.maxByte <= 1) ok('audit image ' + JSON.stringify(row));
  else fail('audit image ' + JSON.stringify(row));
}
const maskPrograms = await page.evaluate(() => window.__maskProgramUses());
if (
  maskPrograms.some(
    (p) =>
      p.draws > 0 && p.defines.includes('MANTLE_NO_CUBIC') && p.defines.includes('MANTLE_NO_ARC'),
  )
)
  ok('line-only resource draws omit absent curve kernels');
else fail('line-only resource draws retain unused curve kernels: ' + JSON.stringify(maskPrograms));
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log("\nmaskRegionRenderSmoke: a mask's region cuts what it masks on the GPU");
