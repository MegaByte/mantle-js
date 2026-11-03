// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// worldMatrixPositionRenderSmoke -- a vertex lands where its em says it does, under any world matrix.
//
// A vertex stage that rounds the plane position to the ulp of 1 and only then multiplies by the matrix moves a vertex in 2 px steps under a matrix of scale 2^16 on a 512 px canvas while vEmCoord keeps the exact
// em: every fragment reads an em up to half a pixel from where it is rasterized, in every engine. The position is the matrix's linear part plus its constant, summed in the order that lets a translation cancel, and
// gl_Position is invariant, because on ANGLE/Metal a program-cache hit of the same source can otherwise give a different answer from a fresh compile.
//
// The art here is scaled down by the zoom, so the matrix is the deep zoom's while the art spans the same pixels at every zoom and its own coordinates and segment spans stay well inside float32: those are a separate limit,
// which this file does not ask about. So the picture must be the zoom-1 picture. Each arm draws every zoom twice from the same source, a fresh compile and a cache hit. MANTLE_SMOKE_SRC_ROOT serves /src from another tree.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = process.env.MANTLE_SMOKE_SRC_ROOT
  ? path.resolve(process.env.MANTLE_SMOKE_SRC_ROOT)
  : ROOT;
let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const svgAt = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0 L${100 * s} 0 C${100 * s} ${40 * s} ${80 * s} ${60 * s} ${100 * s} ${100 * s} L0 ${90 * s} C${20 * s} ${60 * s} ${10 * s} ${30 * s} 0 0 Z" fill="#d33"/></svg>`;
const ZOOMS = [16, 18, 20];
// A level or two is the AA rounding between two compiles of a program (fresh against a cache hit); the defect is 160 levels.
const TOLERANCE = 2;
const ARMS = {
  slug: { engine: { route: 'none', kernel: 'slug' }, drew: 'slug' },
  aac: { engine: { route: 'none', kernel: 'aac' }, drew: 'aac' },
  lb: { engine: { route: 'lb', kernel: 'slug' }, wait: 'lb', drew: 'lb' },
  cpatch: { engine: { route: 'cpatch', kernel: 'slug' }, wait: 'cpatch', drew: 'cpatch' },
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W = 512, H = 512, gl = document.getElementById('c').getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (svg, z, arm) => {
  const bundle = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const R = createRenderer(gl, shaders, { nonBlocking: false, asyncShaderCompile: false });
  R.setFillEngine(arm.engine); R.setViewport(W, H);
  // the art's corner lands at (128, 384) on the canvas, the translation that takes it there as large as the zoom
  const m = new Float32Array([z, 0, 0, 0, z, 0, z - 0.5, 0.5 - z, 1]);
  const draw = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); R.drawBundle(bundle, { worldMatrix: m }); };
  R.prepareBundle(bundle); draw(); await R.ready;
  if (arm.wait) await R.awaitEngine(bundle, arm.wait);
  for (let i = 0; i < 3; i++) draw();
  const before = { ...R.debugStats.engines.draws };
  draw();
  const after = R.debugStats.engines.draws, drew = Object.keys(after).filter((k) => (after[k] | 0) > (before[k] | 0));
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const glErr = gl.getError();
  bundle.dispose(); R.dispose();
  let b = ''; for (let k = 0; k < buf.length; k += 8192) b += String.fromCharCode.apply(null, buf.subarray(k, k + 8192));
  return { px: btoa(b), drew, glErr };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(p.startsWith('/src/') ? SRC_ROOT : ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
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
page.on('pageerror', (e) => fail('page: ' + e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: pageTimeoutFor(),
});
await page.waitForFunction(() => window.__ready === true, {
  timeout: pageTimeoutFor(),
  polling: 100,
});
const run = (s, z, arm) => page.evaluate((a, b, c) => window.__run(a, b, c), svgAt(s), z, arm);
for (const [name, arm] of Object.entries(ARMS)) {
  const ref = await run(1, 1, arm);
  const rb = Buffer.from(ref.px, 'base64');
  let ink = 0;
  for (let i = 3; i < rb.length; i += 4) if (rb[i]) ink++;
  if (ref.drew.join() !== arm.drew || !ink) {
    fail(`${name}: the zoom-1 picture drew ${ref.drew.join() || 'nothing'} with ${ink} ink px`);
    continue;
  }
  for (const zl of ZOOMS)
    for (const pass of ['first', 'second']) {
      const z = 2 ** zl,
        r = await run(1 / z, z, arm);
      const b = Buffer.from(r.px, 'base64');
      let max = 0,
        n = 0,
        at = '';
      for (let i = 0; i < b.length; i++) {
        const d = Math.abs(b[i] - rb[i]);
        if (d > max) {
          max = d;
          at = `${(i >> 2) % 512},${((i >> 2) / 512) | 0}`;
        }
        if (d > TOLERANCE) n++;
      }
      const line = `${name} at 2^${zl}, ${pass} draw: ${n} channels past ${TOLERANCE} of the zoom-1 picture, max ${max}${at ? ' at ' + at : ''}, drew ${r.drew.join()}, gl error ${r.glErr}`;
      if (max <= TOLERANCE && r.drew.join() === arm.drew && r.glErr === 0) ok(line);
      else fail(line);
    }
}
await browser.close();
server.close();
console.log(
  failures
    ? `worldMatrixPositionRenderSmoke: ${failures} FAILED`
    : 'worldMatrixPositionRenderSmoke: PASS',
);
process.exit(failures ? 1 : 0);
