// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// blurLargeSigmaSmoke — a large feGaussianBlur reaches its full width, on both filter routes, against Chrome.
//
// A fixed 16-pair tap loop has 32 px of reach: 3 sigma only up to sigma ~10.7. A blur of 20 would read 0 at 32 px
// from an edge where Chrome reads ~13 levels, a blur of 40 0 at 40 px where Chrome reads ~40, and a box path capped at
// radius 64 shrinks a blur of 100 to ~64. So blur.frag.glsl's taps are a CPU-built table reaching ceil(3 sigma)
// (test/blurKernelSmoke.mjs pins its math over the whole range) and the widest blurs take box passes whose variances
// sum to sigma^2.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas. An opaque black square on a
// TRANSPARENT ground, so the blurred ALPHA is the whole measurement; its right and bottom edges are each more than
// 3 sigma from every other edge and from the canvas border, so the falloff sampled across them is the 1-D step
// response of the kernel alone. Sampled from sigma inside the edge to 2.5 sigma past it.
//
// Tolerance, 6 levels: Chrome approximates too. Skia's raster path is the spec's three-box blur (within 2.5 levels
// of the Gaussian at these distances, by a CPU model of it) and its GPU path downsamples; Mantle's box passes sit
// within 2.6. By a CPU model of the capped kernels at these very points, they miss the Gaussian by 13 levels at
// sigma 20 (both routes), 41 at sigma 40 on the single route and 79 / 24 at sigma 100 (single / graph). Sigma 12
// (0.9), sigma 16 (5.4) and sigma 40 on the graph route (2.9, a box path) are inside the tolerance even capped:
// they are controls.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGMAS = [12, 16, 20, 40, 100];
// Square [8, 8 + 2T] with T = ceil(3 sigma); canvas 3T + 16, so T of transparent ground lies past the right and
// bottom edges, and the sample row / column (through the square's center) is T from the other edges.
const layout = (s) => {
  const T = Math.ceil(3 * s);
  return { T, S: 3 * T + 16, E: 2 * T + 8, C: T + 8 };
};
const svg = (s, route) => {
  const { S, T } = layout(s);
  const prim =
    route === 'graph'
      ? // feMerge makes the kind heuristic give up, so the chain takes the filter GRAPH; a one-input merge is the input.
        `<feGaussianBlur stdDeviation="${s}" result="b"/><feMerge><feMergeNode in="b"/></feMerge>`
      : `<feGaussianBlur stdDeviation="${s}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}" color-interpolation-filters="sRGB">${prim}</filter>` +
    `<rect x="8" y="8" width="${2 * T}" height="${2 * T}" fill="#000" filter="url(#f)"/></svg>`
  );
};
// Offsets from the edge in pixels: negative is inside the square. d = j + 0.5 is the pixel center's distance.
const offsets = (s) =>
  [-s, -s / 2, 0, s / 4, s / 2, s, 1.5 * s, 1.6 * s, 2 * s, 2.5 * s].map(Math.round);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="64" height="64"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cvs = document.getElementById('c');
const gl = cvs.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
// pts: [x, y] in top-down canvas pixels. Returns the ALPHA at each, from Mantle and from Chrome.
window.__case = async (svg, S, pts) => {
  cvs.width = S; cvs.height = S;
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const graphs = (b.filterGraphs || []).filter(Boolean).length;   // a single-primitive filter leaves a null slot
  R.setViewport(S, S); gl.viewport(0, 0, S, S);
  for (let i = 0; i < 3; i++) { R.beginFrame([0, 0, 0, 0]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, S, S).data;
  // WebGL rows are bottom-up, the 2D canvas's top-down.
  return { graphs, pts: pts.map(([x, y]) => ({ mantle: px[((S - 1 - y) * S + x) * 4 + 3], chrome: ref[(y * S + x) * 4 + 3] })) };
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
const TOL = 6;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const s of SIGMAS)
    for (const route of ['single', 'graph']) {
      const { S, E, C } = layout(s);
      const js = offsets(s);
      // Across the right edge along row C, then across the bottom edge along column C.
      const pts = [...js.map((j) => [E + j, C]), ...js.map((j) => [C, E + j])];
      const r = await page.evaluate((a, b, c) => window.__case(a, b, c), svg(s, route), S, pts);
      const name = `sigma ${s}, ${route} route`;
      if ((route === 'graph') !== r.graphs > 0) {
        fail(`${name}: the fixture took the ${r.graphs ? 'graph' : 'single-primitive'} route`);
        continue;
      }
      const fmt = (arr) => arr.map((p, i) => `${js[i] + 0.5}:${p.mantle}/${p.chrome}`).join(' ');
      const across = r.pts.slice(0, js.length),
        down = r.pts.slice(js.length);
      console.log(`  ${name}, d: mantle/chrome alpha  x: ${fmt(across)}  y: ${fmt(down)}`);
      // Chrome must itself be blurring this wide, or the case compares nothing: Phi(-1.5) is 17 levels.
      const at15 = js.indexOf(Math.round(1.5 * s));
      if (across[at15].chrome < 10 || down[at15].chrome < 10) {
        fail(
          `${name}: Chrome reads ${across[at15].chrome}/${down[at15].chrome} at 1.5 sigma — the reference is not a blur this wide`,
        );
        continue;
      }
      let worst = 0,
        at = '';
      r.pts.forEach((p, i) => {
        const e = Math.abs(p.mantle - p.chrome);
        if (e > worst) {
          worst = e;
          at = `${i < js.length ? 'x' : 'y'} d=${js[i % js.length] + 0.5}`;
        }
      });
      if (worst <= TOL)
        ok(
          `${name}: the falloff matches Chrome within ${worst}/255 from sigma inside to 2.5 sigma out`,
        );
      else fail(`${name}: off by ${worst}/255 at ${at}`);
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
  '\nblurLargeSigmaSmoke: large blurs reach their full width on both routes, as in Chrome',
);
