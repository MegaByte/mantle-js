// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeReachGateSmoke -- the cubic and arc REACH gates change no pixel.
//
// strokeCubicOutOfReach, the quad gate (its two halves' triangles) (the control polygons of a cubic quarters, in their chord frames) and the arc gate (the
// ellipse implicit function, 1/min(rx,ry)-Lipschitz) skip a segment the pixel cannot reach before its closest-point
// solve. They are optimizations and must be output-identical: uStrokeGates on must equal off, byte for byte, on
// cubics (diagonal, winding, looped, cusped, coincident handles, dashed, hairline, framed, zoomed) and arcs
// (eccentric, chained, tiny, near-line, dashed, framed, zoomed).
//
// One renderer, one program, the uniform toggled between draws (renderer.setStrokeGates): gates on
// must equal gates off, byte for byte, on each case below.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
const k = 0.5522847498;
const circle = (cx, cy, r) =>
  `M${cx + r} ${cy} C${cx + r} ${cy + k * r} ${cx + k * r} ${cy + r} ${cx} ${cy + r} C${cx - k * r} ${cy + r} ${cx - r} ${cy + k * r} ${cx - r} ${cy} C${cx - r} ${cy - k * r} ${cx - k * r} ${cy - r} ${cx} ${cy - r} C${cx + k * r} ${cy - r} ${cx + r} ${cy - k * r} ${cx + r} ${cy} Z`;
const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const sk = (w, d, extra = '') =>
  `<path d="${d}" fill="none" stroke="#000" stroke-width="${w}" ${extra}/>`;
const CASES = [
  [
    'diagonal S cubic, round caps and joins, 8 wide',
    svg(
      240,
      240,
      sk(8, 'M15 225 C 60 20 180 220 225 15', 'stroke-linecap="round" stroke-linejoin="round"'),
    ),
  ],
  [
    'winding two-cubic chain, miter joins, butt caps, 10 wide',
    svg(
      240,
      240,
      sk(
        10,
        'M20 200 C 230 230 20 20 200 30 C 30 120 220 150 120 230',
        'stroke-linejoin="miter" stroke-miterlimit="8"',
      ),
    ),
  ],
  [
    'self-crossing loop cubic, square caps, 6 wide',
    svg(240, 240, sk(6, 'M30 200 C 230 230 10 20 210 40', 'stroke-linecap="square"')),
  ],
  [
    'cusp cubic, round joins, 5 wide',
    svg(
      240,
      240,
      sk(5, 'M30 40 C 220 220 20 220 210 40', 'stroke-linecap="round" stroke-linejoin="round"'),
    ),
  ],
  [
    'coincident-handle cubic (S continuation), bevel, 7 wide',
    svg(
      240,
      240,
      sk(7, 'M20 120 C 20 120 120 20 220 120 S 120 220 20 120', 'stroke-linejoin="bevel"'),
    ),
  ],
  ['hairline cubic, 0.5 wide', svg(240, 240, sk(0.5, 'M15 225 C 60 20 180 220 225 15'))],
  [
    'dashed cubic, round caps, 9 wide',
    svg(
      240,
      240,
      sk(9, 'M15 225 C 60 20 180 220 225 15', 'stroke-linecap="round" stroke-dasharray="30 14"'),
    ),
  ],
  [
    'sharp cubic corner, miter-clip, 12 wide',
    svg(
      240,
      240,
      sk(
        12,
        'M30 200 C 100 40 130 40 210 200 L 30 60',
        'stroke-linejoin="miter-clip" stroke-miterlimit="4"',
      ),
    ),
  ],
  [
    'cubic under a 3:1 scale',
    svg(
      240,
      240,
      `<g transform="scale(3 1)">${sk(6, 'M5 225 C 20 20 60 220 75 15', 'stroke-linecap="round" stroke-linejoin="round"')}</g>`,
    ),
  ],
  [
    'small cubic zoomed 12x',
    svg(
      240,
      240,
      `<g transform="translate(-300 -300) scale(12)">${sk(0.8, 'M26 26 C 28 30 32 24 36 30', 'stroke-linecap="round"')}</g>`,
    ),
  ],
  [
    'diagonal quadratic, round caps and joins, 8 wide',
    svg(
      240,
      240,
      sk(8, 'M15 225 Q 225 225 225 15', 'stroke-linecap="round" stroke-linejoin="round"'),
    ),
  ],
  [
    'quadratic chain, miter joins, 10 wide',
    svg(
      240,
      240,
      sk(
        10,
        'M20 200 Q 120 -40 200 120 T 120 230',
        'stroke-linejoin="miter" stroke-miterlimit="8"',
      ),
    ),
  ],
  [
    'folded quadratic (control past the end), square caps, 6 wide',
    svg(240, 240, sk(6, 'M30 200 Q 230 40 120 120', 'stroke-linecap="square"')),
  ],
  [
    'dashed hairline quadratic',
    svg(240, 240, sk(0.5, 'M15 225 Q 225 225 225 15', 'stroke-dasharray="20 9"')),
  ],
  [
    'quadratic under a 3:1 scale',
    svg(
      240,
      240,
      `<g transform="scale(3 1)">${sk(6, 'M5 225 Q 75 225 75 15', 'stroke-linecap="round"')}</g>`,
    ),
  ],
  [
    'small quadratic zoomed 12x',
    svg(
      240,
      240,
      `<g transform="translate(-300 -300) scale(12)">${sk(0.8, 'M26 26 Q 34 22 36 30', 'stroke-linecap="round"')}</g>`,
    ),
  ],
  [
    'large eccentric arc, round caps, 9 wide',
    svg(
      240,
      240,
      sk(9, 'M30 190 A 120 40 -30 1 1 210 70', 'stroke-linecap="round" stroke-linejoin="round"'),
    ),
  ],
  [
    'arc chain, miter joins, butt caps, 8 wide',
    svg(
      240,
      240,
      sk(
        8,
        'M30 200 A 90 50 20 0 1 140 60 A 60 90 70 1 0 210 190',
        'stroke-linejoin="miter" stroke-miterlimit="6"',
      ),
    ),
  ],
  [
    'circular arc, square caps, 6 wide',
    svg(240, 240, sk(6, 'M40 120 A 80 80 0 1 1 120 200', 'stroke-linecap="square"')),
  ],
  [
    'tiny-radius arc and a near-line arc',
    svg(
      240,
      240,
      sk(4, 'M60 60 A 6 3 0 1 1 72 62 M30 200 A 4000 3000 0 0 1 210 190', 'stroke-linecap="round"'),
    ),
  ],
  ['hairline arc, 0.5 wide', svg(240, 240, sk(0.5, 'M30 190 A 120 40 -30 1 1 210 70'))],
  [
    'dashed arc, 7 wide',
    svg(240, 240, sk(7, 'M30 190 A 120 40 -30 1 1 210 70', 'stroke-dasharray="25 12"')),
  ],
  [
    'arc under a 3:1 scale',
    svg(
      240,
      240,
      `<g transform="scale(3 1)">${sk(6, 'M10 190 A 40 40 0 1 1 70 70', 'stroke-linecap="round"')}</g>`,
    ),
  ],
  [
    'arc zoomed 10x',
    svg(
      240,
      240,
      `<g transform="translate(-250 -250) scale(10)">${sk(0.9, 'M26 30 A 6 3 20 1 1 36 32', 'stroke-linecap="round"')}</g>`,
    ),
  ],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const shot = (b) => {
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return px;
};
window.__case = async (svg) => {
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.prewarmBundle(b); R.precompileFills();   // the loading call: every frame draws the same program
  R.setStrokeGates(true); const on = shot(b);
  R.setStrokeGates(false); const off = shot(b);
  R.setStrokeGates(true); const on2 = shot(b);
  b.dispose && b.dispose();
  let diff = 0, maxd = 0, aa = 0, ink = 0;
  for (let i = 0; i < on.length; i += 4) {
    const d = Math.max(Math.abs(on[i] - off[i]), Math.abs(on[i + 1] - off[i + 1]), Math.abs(on[i + 2] - off[i + 2]));
    if (d) diff++; if (d > maxd) maxd = d;
    if (on[i] !== on2[i]) aa++;
    if (off[i] < 250) ink++;
  }
  return { diff, maxd, aa, ink };
};
window.__ready = true;
</script></body></html>`;

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
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const [name, s] of CASES) {
    const r = await page.evaluate((x) => window.__case(x), s);
    if (r.ink < 50) {
      fail(`${name}: nearly blank (${r.ink} ink px)`);
      continue;
    }
    if (r.aa) {
      fail(
        `${name}: gates on is not reproducible frame to frame (${r.aa} px) — the comparison is unreadable`,
      );
      continue;
    }
    if (r.diff === 0) ok(`${name}: gates on and off are byte-identical (${r.ink} ink px)`);
    else fail(`${name}: gates change ${r.diff} px, by up to ${r.maxd}/255`);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nstrokeReachGateSmoke: the cubic and arc reach gates change no pixel');
