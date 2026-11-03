// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// vertexOnPixelCenterRenderSmoke.mjs -- the GPU pixels: a pixel whose center is a vertex of the outline
// (a rect corner; the extremum shared by two half-turn arcs) is drawn at its exact area, on the default route and on the AAC
// engine, as read back from a real WebGL2 context. A two-ray estimate (the CPU band walker) reads 0.25 off at these pixels; the
// shipped fill does not (vertexOnPixelCenterSmoke.mjs proves it on the shader text, this one on the framebuffer).
//
// A white canvas, a black shape, coverage = 1 - red/255 against the closed-form area of the pixel box; the bar is two 8-bit
// levels (0.008) of the antialiased edge.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = 4,
  W = 32 * R,
  BAR = 0.02;
const F = (x, y, r) => {
  const a = Math.min(Math.max(x, 0), r),
    b = Math.min(Math.max(y, 0), r);
  if (a * a + b * b <= r * r) return a * b;
  const xa = Math.min(a, Math.sqrt(Math.max(r * r - b * b, 0)));
  const I = (t) =>
    0.5 * (t * Math.sqrt(Math.max(r * r - t * t, 0)) + r * r * Math.asin(Math.min(1, t / r)));
  return xa * b + (I(a) - I(xa));
};
const S = (x, y, r) => Math.sign(x) * Math.sign(y) * F(Math.abs(x), Math.abs(y), r);
const disc = (x0, y0, x1, y1, r) => S(x1, y1, r) - S(x0, y1, r) - S(x1, y0, r) + S(x0, y0, r);
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const cases = [];
for (const off of [0, 0.5]) {
  const C = 16 * R + off,
    r = R,
    ex = (jx, jy) => disc(jx - C, jy - C, jx + 1 - C, jy + 1 - C, r);
  const arc2 = (sx, sy, ex2, ey) =>
    `<path d="M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex2} ${ey} A ${r} ${r} 0 0 1 ${sx} ${sy} Z" fill="#000"/>`;
  cases.push(
    [`offset ${off} circle`, `<circle cx="${C}" cy="${C}" r="${r}" fill="#000"/>`, ex],
    [`offset ${off} two arcs from +x`, arc2(C + r, C, C - r, C), ex],
    [`offset ${off} two arcs from -x`, arc2(C - r, C, C + r, C), ex],
    [`offset ${off} two arcs from top`, arc2(C, C - r, C, C + r), ex],
  );
  const x0 = Math.floor(C) + 0.5 - r,
    w = 2 * r + 1;
  cases.push([
    `offset ${off} rect, corners on pixel centres`,
    `<rect x="${x0}" y="${x0}" width="${w}" height="${w}" fill="#000"/>`,
    (jx, jy) => ov(jx, jx + 1, x0, x0 + w) * ov(jy, jy + 1, x0, x0 + w),
  ]);
}
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (svgText, engine) => {
  if (engine) R.setFillEngine(engine);
  const b = createBundle(gl, await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">' + svgText + '</svg>', { preserveViewport: true }));
  for (let f = 0; f < 3; f++) { R.setViewport(${W}, ${W}); gl.viewport(0, 0, ${W}, ${W}); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); await new Promise((r) => setTimeout(r, 30)); }
  const px = new Uint8Array(${W} * ${W} * 4); gl.readPixels(0, 0, ${W}, ${W}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Float32Array(${W} * ${W}); for (let y = 0; y < ${W}; y++) for (let x = 0; x < ${W}; x++) out[y * ${W} + x] = (255 - px[((${W} - 1 - y) * ${W} + x) * 4]) / 255;
  return Array.from(out);
};
window.__ready = true;</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    res.writeHead(200, { 'content-type': u.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, u)));
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
let fail = 0;
for (const engine of [null, 'aac']) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction('window.__ready === true', { timeout: 60000 });
  for (const [name, markup, exactOf] of cases) {
    const g = await page.evaluate((m, e) => window.__render(m, e), markup, engine);
    let worst = 0,
      at = null;
    for (let jy = 0; jy < W; jy++)
      for (let jx = 0; jx < W; jx++) {
        const e = Math.abs(g[jy * W + jx] - exactOf(jx, jy));
        if (e > worst) {
          worst = e;
          at = [jx, jy, g[jy * W + jx], exactOf(jx, jy)];
        }
      }
    const good = worst <= BAR;
    console.log(
      `${good ? '  ok' : 'FAIL'} ${engine || 'default route'}, ${name}: worst pixel ${worst.toFixed(4)} from the exact area (bar ${BAR})` +
        (good
          ? ''
          : ` at (${at[0]}, ${at[1]}) read ${at[2].toFixed(3)}, exact ${at[3].toFixed(3)}`),
    );
    if (!good) fail++;
  }
  await page.close();
}
await browser.close();
server.close();
if (fail) {
  console.error(`FAIL vertexOnPixelCenterRenderSmoke: ${fail}`);
  process.exit(1);
}
console.log('vertexOnPixelCenterRenderSmoke PASS');
