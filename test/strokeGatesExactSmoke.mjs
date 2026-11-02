// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeGatesExactSmoke — the stroke walker's early-out GATES change no pixel.
//
// uStrokeGates switches the band walk's saturation return, its hull reject and its break/far tests.
// They are optimizations and must be output-identical. Two ways they can fail to be:
//   a saturation depth of halfW - 0.25*(ePx.x + ePx.y) saturates the RAMP model, but the
//        default exact-area AA is full only at 0.5*length(ePx) -- so where a later segment is closer
//        (joins, self-overlap) the early return would keep the wrong one: up to ~11/255 on square
//        pixels and ~42/255 at a 3:1 non-uniform footprint.
//   a hull reject and break/far tests that use the join reach with NO AA margin, while coverage
//        is nonzero out to halfW + ~0.75 px, reject a fringe pixel beyond an endpoint or joint at an
//        extremum of its control box, which loses up to half its coverage.
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
const POLY = 'M20 150 L60 60 L100 150 L140 60 L180 150 L220 60';
const CASES = [
  [
    '45-degree miter polyline, 14 wide',
    svg(
      240,
      200,
      `<path d="${POLY}" fill="none" stroke="#000" stroke-width="14" stroke-linejoin="miter" stroke-miterlimit="10"/>`,
    ),
  ],
  [
    '45-degree bevel polyline, 14 wide',
    svg(
      240,
      200,
      `<path d="${POLY}" fill="none" stroke="#000" stroke-width="14" stroke-linejoin="bevel"/>`,
    ),
  ],
  [
    'miter polyline under a 3:1 scale',
    svg(
      240,
      200,
      `<g transform="scale(3 1)"><path d="M10 150 L20 60 L33 150 L46 60 L60 150 L73 60" fill="none" stroke="#000" stroke-width="5" stroke-linejoin="miter" stroke-miterlimit="10"/></g>`,
    ),
  ],
  [
    'dashed round-joined circle, 4 wide',
    svg(
      200,
      200,
      `<path d="${circle(100, 100, 70)}" fill="none" stroke="#000" stroke-width="4" stroke-linejoin="round" stroke-dasharray="40 7"/>`,
    ),
  ],
  [
    'dashed round-joined circle, 1 wide',
    svg(
      200,
      200,
      `<path d="${circle(100, 100, 70)}" fill="none" stroke="#000" stroke-width="1" stroke-linejoin="round" stroke-dasharray="40 7"/>`,
    ),
  ],
  [
    'dashed round-joined circle, 0.5 wide',
    svg(
      200,
      200,
      `<path d="${circle(100, 100, 70)}" fill="none" stroke="#000" stroke-width="0.5" stroke-linejoin="round" stroke-dasharray="40 7"/>`,
    ),
  ],
  [
    'vertical 0.5 px line',
    svg(200, 200, `<path d="M100.3 20 L100.3 180" fill="none" stroke="#000" stroke-width="0.5"/>`),
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
// THE BREAK IS NOT GATED, so gates on against off cannot see it. A vertical 0.5 px line centred on a
// pixel column has mirror-symmetric fringes; the break cuts only segments to one side of the pixel,
// so a break short of the AA fringe shows as the left fringe differing from the right.
window.__symmetry = async (svg, col) => {
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.prewarmBundle(b); R.precompileFills();   // the loading call: every frame draws the same program
  R.setStrokeGates(false);
  const px = shot(b);
  R.setStrokeGates(true);
  b.dispose && b.dispose();
  const at = (x, y) => px[((${N} - 1 - y) * ${N} + x) * 4];
  let worst = 0, centre = 0;
  for (let y = 60; y < 200; y++) {
    centre = Math.max(centre, 255 - at(col, y));
    for (let d = 1; d <= 2; d++) worst = Math.max(worst, Math.abs(at(col - d, y) - at(col + d, y)));
  }
  return { worst, centre };
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
  {
    // x = 100 + 0.5 in canvas px: the canvas is 256 px over a 200-unit viewBox, so place the line at
    // the viewBox coordinate whose device x is a pixel center.
    const col = 128,
      xv = (((col + 0.5) * 200) / N).toFixed(6);
    const s = svg(
      200,
      200,
      `<path d="M${xv} 10 L${xv} 190" fill="none" stroke="#000" stroke-width="0.5"/>`,
    );
    const r = await page.evaluate((a, c) => window.__symmetry(a, c), s, col);
    if (r.centre < 20) fail(`vertical 0.5 px line: nearly blank at its column (${r.centre})`);
    else if (r.worst <= 1)
      ok(`vertical 0.5 px line: left and right fringes mirror within ${r.worst}/255`);
    else
      fail(
        `vertical 0.5 px line: left and right fringes differ by up to ${r.worst}/255 — the break cut one side`,
      );
  }
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
console.log('\nstrokeGatesExactSmoke: the stroke gates change no pixel');
