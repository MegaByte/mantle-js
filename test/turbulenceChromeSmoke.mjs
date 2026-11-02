// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// turbulenceChromeSmoke — feTurbulence is the spec at pixel centers, and as close to Chrome as Chrome is to it.
//
// feTurbulence.frag.glsl evaluates the Filter Effects 1 reference algorithm from the spec's own seeded tables (a sin()
// hash for the lattice gradients keeps the spec's structure without its tables, so no seed would produce the pattern
// any browser draws); test/turbulenceSpecSmoke.mjs
// proves the math against a float64 transcription of the spec's C code. This checks the pixels against Chrome, whose
// Skia implementation runs the same algorithm (same Park-Miller tables, same noise2, same stitching) at lower precision.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas: the whole 128 x 128 canvas, on
// a TRANSPARENT ground on the Mantle side and as premultiplied values from two grounds on Chrome's (over black the
// color IS the premultiplied color; over white it is color + 255 - alpha) -- turbulence's alpha is its fourth noise
// channel, and a single ground would fold it into the color. color-interpolation-filters="sRGB": this renderer runs
// filters in sRGB, and the default linearRGB would add a color-space conversion that is not the question. The filter
// region is the canvas at the origin, so the stitch tile is the same in both (Skia takes the tile origin as 0, the
// spec as the subregion's x/y; they agree there).
//
// WHAT CAN HOLD. Chrome is not the spec to the level: on the first GPU run its output sat 1.65-6.10 levels (mean)
// from the float64 spec sampled at pixel CENTERS, and 3.20-10.64 from it at corners -- it samples centers, at reduced
// GPU precision (Skia's GPU path stores gradients at 16 bits and computes at half precision). So the criteria are:
//   * Mantle vs the float64 spec oracle at pixel centers (test/_turbulenceSpecOracle.mjs), max <= 1 level: the
//     spec's algorithm, to the rounding of the final byte;
//   * Mantle vs Chrome, mean <= (Chrome vs the spec at centers, mean) + 0.5: no further from Chrome than Chrome is
//     from the spec. The sin() hash sat ~30 levels from the spec on average.
// Both are printed per case, with Chrome against the spec at corners as the control that says where Chrome samples.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { specInit, specTurbulence, specColor } from './_turbulenceSpecOracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;
// [type, baseFrequency, numOctaves, seed, stitchTiles]
const CASES = [
  ['fractalNoise', '0.05', 1, 0, false],
  ['fractalNoise', '0.05', 4, 7, false],
  ['turbulence', '0.03 0.07', 4, -3.5, false],
  ['turbulence', '0.05', 1, 42, false],
  ['fractalNoise', '0.047', 2, 5, true], // 6.02 cells across the tile: the stitch snaps the frequency
  ['turbulence', '0.06', 4, 11.9, true],
];
const svg = ([type, bf, oct, seed, stitch]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<filter id="t" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">` +
  `<feTurbulence type="${type}" baseFrequency="${bf}" numOctaves="${oct}" seed="${seed}" stitchTiles="${stitch ? 'stitch' : 'noStitch'}"/>` +
  `</filter><rect width="${N}" height="${N}" fill="#fff" filter="url(#t)"/></svg>`;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const N = ${N};
// Both renderings as premultiplied RGBA, top-down rows.
window.__case = async (svg) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.setViewport(N, N); gl.viewport(0, 0, N, N);
  for (let i = 0; i < 2; i++) { R.beginFrame([0, 0, 0, 0]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const mantle = new Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N * 4; x++) mantle[y * N * 4 + x] = px[(N - 1 - y) * N * 4 + x];
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const on = (ground) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const ctx = cv.getContext('2d'); ctx.fillStyle = ground; ctx.fillRect(0, 0, N, N); ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, N, N).data;
  };
  const k = on('#000'), w = on('#fff');
  const chrome = new Array(N * N * 4);
  for (let i = 0; i < N * N * 4; i += 4) { chrome[i] = k[i]; chrome[i + 1] = k[i + 1]; chrome[i + 2] = k[i + 2]; chrome[i + 3] = k[i] + 255 - w[i]; }
  return { mantle, chrome };
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

// The spec's premultiplied bytes for pixel (i, j) sampled at (i + d, j + d): the straight float color times the
// float alpha, rounded once -- what the shader's fragColor becomes in an RGBA8 target.
function oracleImage(c, d) {
  const [type, bf, oct, seed, stitch] = c;
  const [bx, by = bx] = bf.split(' ').map(Number);
  const T = specInit(Math.trunc(seed));
  const fractal = type === 'fractalNoise';
  const out = new Float64Array(N * N * 4);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const s = [0, 1, 2, 3].map((ch) =>
        specColor(
          specTurbulence(T, ch, [i + d, j + d], bx, by, oct, fractal, stitch, 0, 0, N, N),
          fractal,
        ),
      );
      const o = (j * N + i) * 4;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round((s[ch] * s[3]) / 255);
      out[o + 3] = Math.round(s[3]);
    }
  return out;
}
const stats = (a, b) => {
  let sum = 0,
    max = 0;
  for (let i = 0; i < a.length; i++) {
    const e = Math.abs(a[i] - b[i]);
    sum += e;
    if (e > max) max = e;
  }
  return { mean: sum / a.length, max };
};
const fmt = (s) => `mean ${s.mean.toFixed(2)} max ${s.max}`;

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
  for (const c of CASES) {
    const name = `${c[0]} ${c[1]}, ${c[2]} octave${c[2] > 1 ? 's' : ''}, seed ${c[3]}${c[4] ? ', stitch' : ''}`;
    const { mantle, chrome } = await page.evaluate((s) => window.__case(s), svg(c));
    const corner = oracleImage(c, 0),
      center = oracleImage(c, 0.5);
    const mc = stats(mantle, chrome),
      ms = stats(mantle, center),
      cs = stats(chrome, center);
    console.log(
      `  ${name}: mantle vs spec@center ${fmt(ms)} | mantle vs chrome ${fmt(mc)} | chrome vs spec@center ${fmt(cs)}` +
        ` | chrome vs spec@corner ${fmt(stats(chrome, corner))}`,
    );
    // A flat or empty Chrome image would match anything flat; the noise must vary.
    let varied = 0;
    for (let i = 4; i < chrome.length; i += 4)
      if (Math.abs(chrome[i] - chrome[i - 4]) > 2) varied++;
    if (varied < (N * N) / 20) {
      fail(`${name}: Chrome's image hardly varies (${varied} steps) — the case measures nothing`);
      continue;
    }
    if (ms.max <= 1) ok(`${name}: the spec at pixel centers, to the byte (${fmt(ms)})`);
    else fail(`${name}: off the spec at pixel centers (${fmt(ms)})`);
    const lim = cs.mean + 0.5;
    if (mc.mean <= lim)
      ok(
        `${name}: no further from Chrome (mean ${mc.mean.toFixed(2)}) than Chrome is from the spec + 0.5 (${lim.toFixed(2)})`,
      );
    else
      fail(
        `${name}: mean ${mc.mean.toFixed(2)} from Chrome, past Chrome's own distance from the spec + 0.5 (${lim.toFixed(2)})`,
      );
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
console.log(
  '\nturbulenceChromeSmoke: feTurbulence is the spec at pixel centers, and as close to Chrome as Chrome is to the spec',
);
