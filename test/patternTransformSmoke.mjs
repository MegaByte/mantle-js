// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// <pattern patternTransform="rotate(θ)"> must rotate the tile lattice. The
// inverse linear part is stored in the carrier's texel 5; the sample coord is
// mapped into pattern space before the wrap.
//
// Discriminator: a 45° stripe pattern's stripes run diagonally, so a VERTICAL
// scan-line crosses them and hits both colors. An un-transformed pattern is
// vertical stripes, so a vertical scan-line is a SINGLE color. We assert the
// rotated case shows both colors and the control shows one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 26px tile: white, with the left 13px an OPAQUE cyan stripe → vertical stripes
// when un-transformed. The fill rect is the whole 100×100 viewport.
const tile = (xform) =>
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs>' +
  `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse"${xform}>` +
  '<rect width="26" height="26" fill="#ffffff"/><rect width="13" height="26" fill="#0090ff"/></pattern>' +
  '</defs><rect x="0" y="0" width="100" height="100" fill="url(#p)"/></svg>';
const ROTATED = tile(' patternTransform="rotate(45)"');
const CONTROL = tile('');

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { stencil:true, depth:true, antialias:false, preserveDrawingBuffer:true });
const sh = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, sh);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
async function render(svg) {
  const b = createBundle(gl, await importSvg(svg));
  r.setViewport(100,100); r.beginFrame([0,0,0,1]);
  r.drawBundle(b, { worldMatrix: id }); r.endFrame();
  const px = (x,yTop) => { const a=new Uint8Array(4); gl.readPixels(x,100-1-yTop,1,1,gl.RGBA,gl.UNSIGNED_BYTE,a); return [a[0],a[1],a[2]]; };
  // Scan a vertical line at x=50 across y.
  const col = [];
  for (let y = 5; y < 100; y += 6) col.push(px(50, y));
  return col;
}
window.__run = async () => ({ rotated: await render(${JSON.stringify(ROTATED)}), control: await render(${JSON.stringify(CONTROL)}) });
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
const isCyan = (p) => p[2] > 150 && p[0] < 90;
const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const countColors = (col) => ({
  cyan: col.filter(isCyan).length,
  white: col.filter(isWhite).length,
});

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
const rc = countColors(r.rotated),
  cc = countColors(r.control);
console.log('  rotated vertical scan:', JSON.stringify(rc), '| control:', JSON.stringify(cc));

// Rotated (45°): the vertical scan-line crosses diagonal stripes → both colors.
if (rc.cyan >= 3 && rc.white >= 3)
  ok('rotate(45) pattern: vertical scan hits BOTH stripe colors (diagonal lattice)');
else fail('rotated pattern not diagonal (vertical scan one color): ' + JSON.stringify(rc));

// Control (no transform): vertical stripes → the x=50 scan-line is ONE color.
if (cc.cyan === 0 || cc.white === 0)
  ok(
    'control (no patternTransform): vertical scan is a single color (vertical stripes) — test discriminates',
  );
else fail('control not vertical stripes — discriminator weak: ' + JSON.stringify(cc));

await browser.close();
server.close();
if (failures === 0) console.log('\nPATTERN-TRANSFORM PASS');
else console.log(`\nPATTERN-TRANSFORM FAIL (${failures})`);
process.exit(failures ? 1 : 0);
