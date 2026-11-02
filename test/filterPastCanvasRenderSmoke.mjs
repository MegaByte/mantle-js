// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPastCanvasRenderSmoke -- a filter's targets cut at what can reach the canvas change no pixel.
//
// A shape running far past the canvas must not ask for targets its own size: they stop at the canvas plus the reach of what reads them (filterDraw.js _clipRectToSeen). The CONTROL is the route with no
// rects at all: canvas-sized targets (renderer._setFilterBbox(false)), a route that holds nothing past the canvas. Each case must match it, at a zoom where the uncut targets fit (4) and at zooms where they
// are past any device's limit (64, 2^10). 2^10 is the top because the coverage kernels' own float32 error on these long curves grows with the zoom, 12 levels against an exact reference at 2^10 and 90 at 2^12: past it two routes disagree inside that error, whichever is right, and the comparison says nothing about the cut. MANTLE_SMOKE_SRC_ROOT serves /src from another tree, to run this file against the code it must fail on: at the higher zooms that code has no target.
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

const FILTERS = {
  floodIn:
    '<filter id="p" x="0" y="0" width="1" height="1"><feFlood flood-color="#0a0"/><feComposite in2="SourceAlpha" operator="in"/></filter>',
  floodNoRegion:
    '<filter id="p"><feFlood flood-color="#0a0" flood-opacity="0.5"/><feComposite in2="SourceAlpha" operator="in"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode/></feMerge></filter>',
  matrix:
    '<filter id="p" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0.2"/></filter>',
  transfer:
    '<filter id="p" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="0.5"/><feFuncG type="gamma" exponent="2"/></feComponentTransfer></filter>',
  linearMatrix: '<filter id="p"><feColorMatrix type="hueRotate" values="40"/></filter>',
  blend:
    '<filter id="p"><feFlood flood-color="#08f"/><feBlend in2="SourceGraphic" mode="multiply"/><feComposite in2="SourceAlpha" operator="in"/></filter>',
  turbulence:
    '<filter id="p" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.3" numOctaves="2"/><feComposite in2="SourceAlpha" operator="in"/></filter>',
  subregion:
    '<filter id="p" x="0" y="0" width="1" height="1" primitiveUnits="userSpaceOnUse"><feFlood flood-color="#0a0" x="20" y="20" width="60" height="30"/><feComposite in="SourceGraphic" operator="over"/></filter>',
};
// A shape with curves, so an edge AA pixel reads its derivative quad, and ink near every corner of the viewBox.
const doc = (flt) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${flt}</defs><path d="M0 0 L100 0 C100 40 80 60 100 100 L0 90 C20 60 10 30 0 0 Z" fill="#d33" filter="url(#p)"/><path d="M3 3 L9 3 L6 9 Z" fill="#35a" filter="url(#p)"/></svg>`;
// An edge pixel's derivatives are rect-local on one route and canvas-local on the other: the two routes differ by a level or two on a few AA pixels, before and after the cut, as filterOffCanvasRenderSmoke's bound allows.
const TOLERANCE = 3;
const CASES = [];
for (const [name, f] of Object.entries(FILTERS))
  for (const z of [4, 64, 1024]) CASES.push({ name: `${name}@${z}`, svg: doc(f), z });

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W = 512, H = 512, gl = document.getElementById('c').getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__run = async (svg, z) => {
  const one = async (rects) => {
    const bundle = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
    const R = createRenderer(gl, shaders, { nonBlocking: false, asyncShaderCompile: false });
    R._setFilterBbox(rects); R.setViewport(W, H);
    // the art's top-left quarter: a corner lands at a point just inside the canvas, the rest runs past the far edges
    const m = new Float32Array([z, 0, 0, 0, z, 0, z - 0.5, 0.5 - z, 1]);
    const draw = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); R.drawBundle(bundle, { worldMatrix: m }); };
    draw(); await R.ready; for (let i = 0; i < 3; i++) draw();
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const active = R.debugStats.filterBboxActiveCount | 0, glErr = gl.getError();
    bundle.dispose(); R.dispose();
    return { buf, active, glErr };
  };
  const on = await one(true), off = await one(false);
  let nDiff = 0, maxDiff = 0, ink = 0, at = '';
  for (let i = 0; i < on.buf.length; i++) {
    const d = Math.abs(on.buf[i] - off.buf[i]);
    if (d) { nDiff++; if (at.length < 80) at += ' ' + ((i >> 2) % W) + ',' + ((i >> 2) / W | 0) + '.' + (i & 3); }
    if (d > maxDiff) maxDiff = d;
    if (off.buf[i]) ink++;
  }
  return { nDiff, maxDiff, ink, at, active: on.active, glErr: on.glErr, glErrOff: off.glErr };
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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: pageTimeoutFor(),
});
await page.waitForFunction(() => window.__ready === true, {
  timeout: pageTimeoutFor(),
  polling: 100,
});
for (const c of CASES) {
  const r = await page.evaluate((svg, z) => window.__run(svg, z), c.svg, c.z);
  const line = `${c.name}: ${r.nDiff} bytes differ (max ${r.maxDiff})${r.at}, control ink ${r.ink}, rect route engaged ${r.active}, gl error ${r.glErr}`;
  // (a single-kind filter's rect route is not counted in filterBboxActiveCount, which is the graph route's)
  if (
    r.maxDiff <= TOLERANCE &&
    r.ink > 0 &&
    (r.active > 0 || c.name.startsWith('matrix')) &&
    r.glErr === 0
  )
    ok(line);
  else fail(line);
}
await browser.close();
server.close();
console.log(
  failures
    ? `filterPastCanvasRenderSmoke: ${failures} FAILED`
    : 'filterPastCanvasRenderSmoke: PASS',
);
process.exit(failures ? 1 : 0);
