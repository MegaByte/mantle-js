// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// viewBoxOverhangSiblingSmoke.mjs — a shape that OVERHANGS the viewBox must not
// drop its on-canvas siblings. In tight (default) bbox mode the importer's
// globalBBox must NOT aggregate geometry extending outside the viewBox: SVG
// clips content to the viewport, so off-viewBox geometry expanding the bounds
// would shrink every on-canvas shape — under an identity worldMatrix — into a
// tiny off-screen sub-region that vanishes. The tight bbox is therefore clamped
// to the viewBox per-shape.
//
// One case is a clipPath + rotated stripe overlay where the stripes overhang
// the rounded-rect viewBox (the clip is incidental); the other is the minimal
// clip-free overhang. We assert the white background renders in both.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Canonical: white rounded-rect bg + diagonal stripe overlay clipped to the bg,
// where the stripes overhang the 340×120 viewBox.
const CLIPPED =
  '<svg viewBox="0 0 340 120" xmlns="http://www.w3.org/2000/svg">' +
  '<defs><clipPath id="round"><rect x="0" y="0" width="340" height="120" rx="16" ry="16"/></clipPath></defs>' +
  '<rect id="bg" x="0" y="0" width="340" height="120" rx="16" ry="16" fill="#ffffff"/>' +
  '<g clip-path="url(#round)"><g transform="rotate(45 170 60)" fill="#2fbeea" fill-opacity="0.5">' +
  '<rect x="-120" y="-120" width="13" height="360"/><rect x="-94" y="-120" width="13" height="360"/></g></g></svg>';
// Minimal trigger (no clip): white bg + a non-rotated rect far outside the viewBox.
const OVERHANG =
  '<svg viewBox="0 0 340 120" xmlns="http://www.w3.org/2000/svg">' +
  '<rect id="bg" x="0" y="0" width="340" height="120" fill="#ffffff"/>' +
  '<rect x="-3000" y="-3000" width="13" height="8000" fill="#2fbeea"/></svg>';
// Sanity control: bg alone.
const CONTROL =
  '<svg viewBox="0 0 340 120" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0" y="0" width="340" height="120" fill="#ffffff"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="340" height="120"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { stencil:true, depth:true, antialias:false, preserveDrawingBuffer:true });
const sh = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, sh);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
async function render(svg) {
  const b = createBundle(gl, await importSvg(svg));
  r.setViewport(340,120); r.beginFrame([1,0,1,1]);   // magenta clear → shows through if bg missing
  r.drawBundle(b, { worldMatrix: id }); r.endFrame();
  const px = (x,yTop) => { const a=new Uint8Array(4); gl.readPixels(x,120-1-yTop,1,1,gl.RGBA,gl.UNSIGNED_BYTE,a); return [a[0],a[1],a[2],a[3]]; };
  return { tl: px(20,20), center: px(170,60), br: px(320,100), bbox: b.globalBBox };
}
window.__run = async () => ({
  control: await render(${JSON.stringify(CONTROL)}),
  clipped: await render(${JSON.stringify(CLIPPED)}),
  overhang: await render(${JSON.stringify(OVERHANG)}),
});
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const isMagenta = (p) => p[0] > 200 && p[1] < 80 && p[2] > 200;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const r = await page.evaluate(() => window.__run());

// Control: bg fills the canvas.
if (isWhite(r.control.tl) && isWhite(r.control.br)) ok('control: plain bg renders white');
else fail('control bg missing: ' + JSON.stringify(r.control));

// Overhang (minimal trigger): bg must still fill the canvas, and globalBBox is
// clamped to the viewBox (340×120), not the off-canvas rect's huge extent.
const ob = r.overhang.bbox;
if (isWhite(r.overhang.tl) && isWhite(r.overhang.center) && isWhite(r.overhang.br))
  ok('overhang: on-canvas bg renders despite an off-viewBox sibling (' + JSON.stringify(ob) + ')');
else fail('overhang dropped the bg: ' + JSON.stringify(r.overhang));
if (ob && ob[2] <= 340.5 && ob[3] <= 120.5) ok('overhang: globalBBox clamped to the viewBox');
else fail('globalBBox not clamped: ' + JSON.stringify(ob));

// Clipped + rotated case: the un-clipped white bg renders.
if (isWhite(r.clipped.tl) && isWhite(r.clipped.br))
  ok('clipped case: un-clipped white bg renders (clip+overhang does not drop it)');
else fail('clipped case dropped the bg: ' + JSON.stringify(r.clipped));

await browser.close();
server.close();
if (failures === 0) console.log('\nVIEWBOX-OVERHANG-SIBLING PASS');
else console.log(`\nVIEWBOX-OVERHANG-SIBLING FAIL (${failures})`);
process.exit(failures ? 1 : 0);
