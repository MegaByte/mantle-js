// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternUnitsRenderSmoke — a <pattern> fill paints what the browser's own SVG renderer paints.
//
// patternUnitsSmoke checks the imported numbers against a reading of SVG 2 §14.3; this checks the PICTURE against
// Chrome's native SVG rasterizer, so a misreading of the spec cannot pass both. Each case fills the whole 100x100
// viewBox, so Mantle's content-bbox fit and the browser's viewBox fit frame it identically.
//
// Cases: userSpaceOnUse with x/y, objectBoundingBox fractions (the default), viewBox meet and slice, patternContentUnits
// objectBoundingBox, href inheritance, and the referencing element's scale and rotation.
//
// Metric: per case, the share of INTERIOR pixels (all 8 neighbours match in the reference, so no edge is under them)
// whose color differs from the reference by more than 48/255 in any channel. Mantle's analytic AA and the browser's
// rasterizer differ only at edges; a wrong tile size, origin or orientation moves whole stripes.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 100;
const stripes = (w, h) =>
  `<rect width="${w}" height="${h}" fill="#ffffff"/><rect width="${w / 2}" height="${h}" fill="#0090ff"/>`;
const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100"><defs>${defs}</defs>${body}</svg>`;
const FULL = '<rect x="0" y="0" width="100" height="100" fill="url(#p)"/>';
const CASES = {
  userSpaceOnUse_xy: svg(
    `<pattern id="p" x="5" y="7" width="26" height="26" patternUnits="userSpaceOnUse">${stripes(26, 26)}</pattern>`,
    FULL,
  ),
  objectBoundingBox: svg(
    `<pattern id="p" x="0.05" y="0" width="0.25" height="0.25" patternContentUnits="userSpaceOnUse">${stripes(25, 25)}</pattern>`,
    FULL,
  ),
  viewBox_meet: svg(
    `<pattern id="p" width="30" height="20" patternUnits="userSpaceOnUse" viewBox="0 0 10 10">${stripes(10, 10)}</pattern>`,
    FULL,
  ),
  viewBox_slice: svg(
    `<pattern id="p" width="30" height="20" patternUnits="userSpaceOnUse" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice">${stripes(10, 10)}</pattern>`,
    FULL,
  ),
  contentUnits_obb: svg(
    `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox">${stripes(0.2, 0.2)}</pattern>`,
    FULL,
  ),
  href: svg(
    `<pattern id="base" width="24" height="24" patternUnits="userSpaceOnUse">${stripes(24, 24)}</pattern><pattern id="p" xlink:href="#base" x="6"/>`,
    FULL,
  ),
  group_scale2: svg(
    `<pattern id="p" width="13" height="13" patternUnits="userSpaceOnUse">${stripes(13, 13)}</pattern>`,
    `<g transform="scale(2)"><rect width="50" height="50" fill="url(#p)"/></g>`,
  ),
  group_rotate30: svg(
    `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse">${stripes(26, 26)}</pattern>`,
    `<g transform="rotate(30 50 50)"><rect x="-60" y="-60" width="220" height="220" fill="url(#p)"/></g>`,
  ),
};

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="${N}" height="${N}"></canvas><canvas id="r" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const N = ${N}, CASES = ${JSON.stringify(CASES)};
const gl = document.getElementById('c').getContext('webgl2', { stencil: true, depth: true, antialias: false, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders);
const id = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const ref2d = document.getElementById('r').getContext('2d', { willReadFrequently: true });
async function native(svg) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  ref2d.fillStyle = '#000'; ref2d.fillRect(0, 0, N, N);
  ref2d.drawImage(img, 0, 0, N, N);
  return ref2d.getImageData(0, 0, N, N).data;       // top row first
}
async function mantle(svg) {
  const b = createBundle(gl, await importSvg(svg));
  for (let i = 0; i < 3; i++) { r.setViewport(N, N); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, { worldMatrix: id }); r.endFrame(); }
  const px = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);   // bottom row first
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) out.set(px.subarray((N - 1 - y) * N * 4, (N - y) * N * 4), y * N * 4);
  try { b.dispose(); } catch {}
  return out;
}
const out = {};
try {
  for (const [name, svg] of Object.entries(CASES)) {
    const ref = await native(svg), got = await mantle(svg);
    let interior = 0, wrong = 0;
    const same = (a, b) => Math.max(Math.abs(ref[a] - ref[b]), Math.abs(ref[a + 1] - ref[b + 1]), Math.abs(ref[a + 2] - ref[b + 2])) <= 8;
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const o = (y * N + x) * 4;
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (!same(o, ((y + dy) * N + x + dx) * 4)) { flat = false; break; }
      if (!flat) continue;
      interior++;
      if (Math.max(Math.abs(ref[o] - got[o]), Math.abs(ref[o + 1] - got[o + 1]), Math.abs(ref[o + 2] - got[o + 2])) > 48) wrong++;
    }
    out[name] = { interior, wrong };
  }
  out.ok = true;
} catch (e) { out.err = String((e && e.stack) || e); }
window.__out = out;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, {
      'content-type':
        (/\.(js|mjs)$/.test(u.pathname) ? 'text/javascript' : 'text/plain') + '; charset=utf-8',
    });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page
  .waitForFunction('window.__out !== undefined', { timeout: 120000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__out);
await browser.close();
server.close();

let fail = 0;
if (!r || !r.ok) {
  console.log('FAIL did not complete: ' + (r && r.err));
  process.exit(1);
}
for (const [name, v] of Object.entries(r)) {
  if (name === 'ok') continue;
  const share = v.interior ? v.wrong / v.interior : 1;
  const pass = v.interior > 1000 && share <= 0.01;
  console.log(
    `${pass ? '  ok' : 'FAIL'} ${name}: ${v.wrong} of ${v.interior} interior px differ from the browser's rendering (${(share * 100).toFixed(2)}%)`,
  );
  if (!pass) fail++;
}
console.log(fail ? `\nPATTERN-UNITS-RENDER FAIL (${fail})` : '\nPATTERN-UNITS-RENDER PASS');
process.exit(fail ? 1 : 0);
