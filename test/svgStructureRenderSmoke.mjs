// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgStructureRenderSmoke -- three importer structure cases render as Chrome renders them.
//
//   <use opacity=".5"> of a group of two overlapping shapes composes the instance as ONE group: the overlap
//          shows the top shape at half strength over the ground, not the bottom shape through it.
//   a CSS transform with transform-origin on a rect (a quarter turn about the rect's center).
//   a marker whose child is painted with a gradient (not black).
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read through a 2D canvas over the same opaque ground; shapes
// are sampled at flat points. Node smokes: svg/useSwitchGroupSmoke, svg/cssTransformSmoke, svg/markerContentSmoke.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 120;
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${defs}</defs><rect width="${N}" height="${N}" fill="#4060c0"/>${body}</svg>`;
const CASES = [
  {
    name: '<use opacity=".5"> of two overlapping shapes',
    svg: svg(
      '<use href="#t" opacity=".5"/>',
      '<g id="t"><rect x="30" y="30" width="40" height="40" fill="#e00"/><rect x="50" y="50" width="40" height="40" fill="#0c0"/></g>',
    ),
    pts: [
      [35, 35, 'first shape only'],
      [60, 60, 'the overlap: the top shape over the ground'],
      [85, 85, 'second shape only'],
    ],
  },
  {
    name: 'CSS transform with transform-origin',
    svg: svg(
      '<rect x="40" y="40" width="40" height="20" fill="#e00" style="transform: rotate(90deg); transform-origin: 60px 50px"/>',
    ),
    pts: [
      [60, 35, 'inside after the turn, outside before'],
      [45, 50, 'inside before the turn, outside after'],
      [60, 50, 'the center'],
    ],
  },
  {
    name: 'a marker with a gradient fill',
    svg: svg(
      '<path d="M10 30 L60 30" fill="none" stroke="#000" stroke-width="2" marker-end="url(#m)"/>',
      '<linearGradient id="lg"><stop offset="0" stop-color="#e00"/><stop offset="1" stop-color="#00e"/></linearGradient>' +
        '<marker id="m" viewBox="0 0 20 20" markerWidth="20" markerHeight="20" refX="10" refY="10" markerUnits="userSpaceOnUse"><rect width="20" height="20" fill="url(#lg)"/></marker>',
    ),
    pts: [
      [52, 30, 'the marker, red end of the ramp'],
      [68, 30, 'the marker, blue end of the ramp'],
    ],
  },
];
const ROUTES = ['none'];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  let before = null;
  for (let i = 0; i < 4; i++) { if (i === 3) before = Object.assign({}, R.debugStats); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const uni = (R.debugStats.unifiedFillDraws | 0) - (before.unifiedFillDraws | 0);
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N}); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // Rows: WebGL reads bottom-up, the 2D canvas top-down.
  const mantleAt = (x, y) => Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4));
  const chromeAt = (x, y) => Array.from(ref.slice((y * ${N} + x) * 4, (y * ${N} + x) * 4 + 4));
  window.__at = { mantleAt, chromeAt };
  return { uni };
};
window.__pts = (pts) => pts.map(([x, y, what]) => ({ x, y, what, mantle: window.__at.mantleAt(x, y), chrome: window.__at.chromeAt(x, y) }));
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
// The ground is opaque, so the WebGL canvas's premultiplied bytes are its color.
const TOL = 6;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES)
    for (const route of ROUTES) {
      const r = await page.evaluate((s, rt) => window.__case(s, rt), c.svg, route);
      const tag = `${c.name}, route ${route}`;
      if (route === 'none' && r.uni !== 0)
        fail(`${tag}: the classic arm drew ${r.uni} unified draws`);
      const got = await page.evaluate((p) => window.__pts(p), c.pts);
      for (const p of got) {
        const d = Math.max(...p.mantle.slice(0, 3).map((v, i) => Math.abs(v - p.chrome[i])));
        const at = p.x != null ? ` (${p.x},${p.y})` : '';
        const msg = `${tag}, ${p.what}${at}: mantle rgba(${p.mantle.join(',')}) chrome rgba(${p.chrome.join(',')})`;
        if (d <= TOL) ok(msg);
        else fail(msg + ` -- off by ${d}/255`);
      }
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
  '\nsvgStructureRenderSmoke: use opacity, CSS transform-origin and a marker gradient render at Chrome',
);
