// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feCompositeArithmeticSmoke — feComposite operator="arithmetic" works on PREMULTIPLIED channels.
//
// THE TRAP: unpremultiplying both inputs, running k1*i1*i2 + k2*i1 + k3*i2 + k4 on the straight color, and
// premultiplying by the arithmetic alpha. Filter Effects 1 says every primitive works on premultiplied RGBA unless it
// says otherwise, and only feColorMatrix and feComponentTransfer do; Chromium (Skia's arithmetic blender with
// enforcePMColor) and Gecko compute on premultiplied values and clamp the color to the alpha. The two agree only
// when the formula happens to commute with the premultiply -- k1 alone does, which is why it is a control here --
// and, by a CPU model of both, differ by 35 to 128 levels on the other sets below (save where both clamp to
// transparent).
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas. Both inputs are translucent
// (a filled rect with fill-opacity, an feFlood with flood-opacity) at two different alpha pairs, and the ground is
// TRANSPARENT on both sides: a white or black ground would fold the output's alpha into its color and hide half of
// what is compared. The comparison is in premultiplied units (Chrome's straight getImageData re-premultiplied), so a
// low-alpha pixel's color is not amplified by the unpremultiply. color-interpolation-filters="sRGB" keeps the
// color-space conversion (which this renderer does not do) out of the measurement.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 48;
// [in color, in alpha, in2 color, in2 alpha]
const PAIRS = [
  ['rgb(220,60,20)', 0.7, 'rgb(40,120,230)', 0.4],
  ['rgb(30,200,160)', 0.25, 'rgb(250,210,40)', 0.9],
];
// k1 k2 k3 k4. [1,0,0,0] is the CONTROL: a pure product commutes with the premultiply, so both formulas give it.
const KS = [
  [0, 0.6, 0.6, 0],
  [1, 0, 0, 0],
  [0.5, 0.5, 0.5, 0.1],
  [-0.5, 1, 1, 0],
  [0, 1, -1, 0.2],
  [0, 0, 0, 0.5],
];
const svg = ([c1, a1, c2, a2], k) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
  `<feFlood flood-color="${c2}" flood-opacity="${a2}" result="fl"/>` +
  `<feComposite in="SourceGraphic" in2="fl" operator="arithmetic" k1="${k[0]}" k2="${k[1]}" k3="${k[2]}" k4="${k[3]}"/>` +
  `</filter><rect width="${N}" height="${N}" fill="${c1}" fill-opacity="${a1}" filter="url(#f)"/></svg>`;
// Inside the rect, away from its edges.
const PTS = [
  [24, 24],
  [12, 10],
  [36, 34],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, pts) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([0, 0, 0, 0]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // WebGL rows are bottom-up and premultiplied; the 2D canvas's are top-down and straight.
  const pre = (p, i) => [p[i] * p[i + 3] / 255, p[i + 1] * p[i + 3] / 255, p[i + 2] * p[i + 3] / 255, p[i + 3]].map(Math.round);
  return pts.map(([x, y]) => ({ x, y,
    mantle: Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4)),
    chrome: pre(ref, (y * ${N} + x) * 4) }));
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
// 3 premultiplied levels: both sides quantize each input to 8 bits and the result again, and Chrome's straight
// readback costs up to one more on the way back to premultiplied. The unpremultiplied formula misses by 35 or more.
const TOL = 3;
let inked = 0;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const pair of PAIRS)
    for (const k of KS) {
      const pts = await page.evaluate((s, p) => window.__case(s, p), svg(pair, k), PTS);
      const name = `in ${pair[0]}@${pair[1]}, in2 ${pair[2]}@${pair[3]}, k ${k.join(' ')}`;
      let worst = 0;
      for (const p of pts)
        worst = Math.max(worst, ...p.mantle.map((v, i) => Math.abs(v - p.chrome[i])));
      if (pts.some((p) => p.chrome[3] > 0)) inked++;
      const at = pts[0];
      const msg = `${name}: mantle rgba(${at.mantle.join(',')}) chrome rgba(${at.chrome.join(',')}) premultiplied, worst ${worst}/255 over ${pts.length} points`;
      if (worst <= TOL) ok(msg);
      else fail(msg);
    }
  // A case where Chrome draws nothing proves nothing about the arithmetic; most here must have ink.
  if (inked < PAIRS.length * KS.length - 2)
    fail(
      `only ${inked} cases have any alpha in Chrome's rendering — the fixture is not exercising the operator`,
    );
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfeCompositeArithmeticSmoke: arithmetic composites premultiplied channels, like Chrome',
);
