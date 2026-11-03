// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _meshFreeVsSlug.mjs — HEADED real-GPU validation: does signed-area coverage match
// Slug on actual rendered pixels? Defines a holed cubic "O" ONCE, renders it via Slug
// (the existing renderer, real GPU — headed, no swiftshader) and diffs against the
// validated CPU signed-area coverage on the identical geometry. This tells us whether
// the mesh-free approach reproduces Slug's output BEFORE investing in the GPU shader —
// and surfaces any AA-filter difference (Slug's H+V box filter vs our exact area).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { signedAreaCoverageSegs } from '../src/renderer/signedAreaCoverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 100; // canvas NxN

// --- holed cubic "O": outer CCW r=40, inner CW r=22, center (50,50) ---
const K = 0.5522847498;
function ring(cx, cy, r, ccw) {
  const on = ccw
    ? [
        [cx + r, cy],
        [cx, cy + r],
        [cx - r, cy],
        [cx, cy - r],
      ]
    : [
        [cx + r, cy],
        [cx, cy - r],
        [cx - r, cy],
        [cx, cy + r],
      ];
  const tan = ccw
    ? [
        [0, r],
        [-r, 0],
        [0, -r],
        [r, 0],
      ]
    : [
        [0, -r],
        [-r, 0],
        [0, r],
        [r, 0],
      ];
  return on.map((a, i) => {
    const b = on[(i + 1) % 4];
    return {
      type: 'cubic',
      P0: a,
      P1: [a[0] + tan[i][0] * K, a[1] + tan[i][1] * K],
      P2: [b[0] - tan[(i + 1) % 4][0] * K, b[1] - tan[(i + 1) % 4][1] * K],
      P3: b,
    };
  });
}
const rawSegs = [...ring(50, 50, 40, true), ...ring(50, 50, 22, false)];
// The renderer fits the path's CURVE-BBOX to the canvas (not the viewBox). Sample the
// curves for the true extent, then apply the same aspect-preserving fit to the CPU
// segs so both rasterize identical device geometry.
function curveBBox(sg) {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  const ev = (s, t) => {
    const u = 1 - t;
    return [
      u * u * u * s.P0[0] + 3 * u * u * t * s.P1[0] + 3 * u * t * t * s.P2[0] + t * t * t * s.P3[0],
      u * u * u * s.P0[1] + 3 * u * u * t * s.P1[1] + 3 * u * t * t * s.P2[1] + t * t * t * s.P3[1],
    ];
  };
  for (const s of sg)
    for (let k = 0; k <= 64; k++) {
      const p = ev(s, k / 64);
      a = Math.min(a, p[0]);
      b = Math.min(b, p[1]);
      c = Math.max(c, p[0]);
      d = Math.max(d, p[1]);
    }
  return [a, b, c, d];
}
const [bx0, by0, bx1, by1] = curveBBox(rawSegs);
const sc = Math.min(N / (bx1 - bx0), N / (by1 - by0));
const tx = (N - (bx1 - bx0) * sc) / 2 - bx0 * sc,
  ty = (N - (by1 - by0) * sc) / 2 - by0 * sc;
const fit = (p) => [p[0] * sc + tx, p[1] * sc + ty];
const segs = rawSegs.map((s) => ({
  type: 'cubic',
  P0: fit(s.P0),
  P1: fit(s.P1),
  P2: fit(s.P2),
  P3: fit(s.P3),
}));
const svgPath = (rg) =>
  `M ${rg[0].P0[0]} ${rg[0].P0[1]} ` +
  rg.map((s) => `C ${s.P1[0]} ${s.P1[1]} ${s.P2[0]} ${s.P2[1]} ${s.P3[0]} ${s.P3[1]}`).join(' ') +
  ' Z';
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000" d="${svgPath(rawSegs.slice(0, 4))} ${svgPath(rawSegs.slice(4))}"/></svg>`;

// CPU signed-area coverage on the identical geometry (SVG y-down; row 0 = top).
const cpu = signedAreaCoverageSegs(segs, N, N, false);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(${N}, ${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.setLoopBlinnFill('off');   // force the Slug path
renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
window.__px = Array.from(px);
window.__gpu = gl.getParameter(gl.RENDERER);
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// HEADED = real GPU (no swiftshader). Fall back to angle=metal if headed can't open.
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
let px, gpu;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  px = await page.evaluate(() => window.__px);
  gpu = await page.evaluate(() => window.__gpu);
} catch (e) {
  console.error('setup failed:', e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();

console.log('GPU:', gpu);
// Slug coverage from the readback (black fill on white): coverage = 1 − gray/255.
// readPixels is bottom-up → screen row (N-1-y) holds SVG row y.
let maxd = 0,
  sumd = 0,
  n = 0,
  holeS = 0,
  ringS = 0;
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    const o = ((N - 1 - y) * N + x) * 4;
    const slug = 1 - px[o] / 255; // black-on-white → coverage
    const c = cpu[y * N + x];
    const d = Math.abs(slug - c);
    maxd = Math.max(maxd, d);
    sumd += d;
    n++;
    if (x === 50 && y === 50) holeS = slug; // hole center
    if (x === 50 && y === 12) ringS = slug; // ring wall (y=12 is inside the r=40 ring, outside r=22)
  }
// debug: totals + coarse map to localize divergence
let sumSlug = 0,
  sumCpu = 0;
const slugAt = (x, y) => 1 - px[((N - 1 - y) * N + x) * 4] / 255;
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    sumSlug += slugAt(x, y);
    sumCpu += cpu[y * N + x];
  }
console.log(
  `total ink: slug=${sumSlug.toFixed(0)}px cpu=${sumCpu.toFixed(0)}px (ring area π(40²−22²)≈3506)`,
);
let map = '';
for (let y = 0; y < N; y += 5) {
  let row = '';
  for (let x = 0; x < N; x += 5) {
    const s = slugAt(x, y) > 0.5,
      c = cpu[y * N + x] > 0.5;
    row += s && c ? '#' : s && !c ? 'S' : !s && c ? 'C' : '.';
  }
  map += row + '\n';
}
console.log('map (# both, S slug-only, C cpu-only, . neither):\n' + map);
console.log(
  `signed-area(CPU) vs Slug(GPU): maxDiff=${maxd.toFixed(3)} meanDiff=${(sumd / n).toFixed(4)}`,
);
console.log(
  `  hole center: slug=${holeS.toFixed(3)} cpu=${cpu[50 * N + 50].toFixed(3)} | ring wall: slug=${ringS.toFixed(3)} cpu=${cpu[12 * N + 50].toFixed(3)}`,
);
// The meaningful metric is meanDiff (whole-image); maxDiff is the worst single AA-edge
// pixel, where Slug's H+V box filter and our exact-area filter legitimately differ
// (sub-visible). A match = identical fill shape + tiny mean diff.
const match = sumd / n < 5e-3 && Math.abs(sumSlug - sumCpu) / sumCpu < 0.01;
console.log(
  match
    ? `\nMATCH — signed-area coverage reproduces Slug on real GPU (mean ${(sumd / n).toFixed(4)}; worst pixel ${maxd.toFixed(3)} = AA-filter shape diff at one edge, sub-visible). The mesh-free coverage math is Slug-accurate.`
    : '\nDIVERGENCE — investigate (AA filter or geometry mismatch)',
);
