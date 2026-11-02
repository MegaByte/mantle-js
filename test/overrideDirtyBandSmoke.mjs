// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// uploadIfDirty uploads only the DIRTY ROW BAND (texSubImage2D at
// yoffset=loRow, height=rows), not the whole n-row plane. The property under
// test: a partial upload at a NON-ZERO row offset must (a) land on the right
// shape and (b) leave earlier rows' GPU data intact (they aren't re-uploaded).
//
// Fixture: 4 white rects (override rows 0..3). Frame A overrides shape 0 → red
// (band [0,0]). Frame B overrides shape 3 → blue (band [3,3], yoffset=3). After
// B: s3 blue (correct row), s0 still red (row 0 not re-uploaded but preserved),
// s1/s2 authored white (never touched). A whole-plane upload would also pass —
// the discriminating check is that row 0 survives without being re-touched.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SVG =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0"  y="0" width="25" height="100" fill="#ffffff"/>' +
  '<rect x="25" y="0" width="25" height="100" fill="#ffffff"/>' +
  '<rect x="50" y="0" width="25" height="100" fill="#ffffff"/>' +
  '<rect x="75" y="0" width="25" height="100" fill="#ffffff"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { stencil: true, depth: true, antialias: false, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
const table = createOverrideTable(gl, bundle);
const px = (x) => { const b = new Uint8Array(4); gl.readPixels(x, 50, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
const draw = () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, { worldMatrix: id, overrides: table });
  renderer.endFrame();
  return { s0: px(12), s1: px(37), s2: px(62), s3: px(87) };
};
window.__run = () => {
  table.set(0, { fill: [1, 0, 0, 1] });      // row 0 → red; band [0,0]
  const A = draw();
  table.set(3, { fill: [0, 0, 1, 1] });      // row 3 → blue; band [3,3], yoffset=3
  const B = draw();
  return { A, B };
};
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
const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90;
const isBlue = (p) => p[2] > 150 && p[0] < 90 && p[1] < 90;
const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;

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
// Frame A: row 0 uploaded → red; rest authored white.
if (isRed(r.A.s0)) ok('A: shape 0 override (band [0,0]) → red');
else fail('A s0 not red: ' + r.A.s0);
if (isWhite(r.A.s3)) ok('A: shape 3 untouched → white');
else fail('A s3 not white: ' + r.A.s3);
// Frame B: row 3 uploaded at yoffset=3 → blue; row 0 PRESERVED (not re-uploaded).
if (isBlue(r.B.s3)) ok('B: shape 3 override (band [3,3], yoffset=3) → blue');
else fail('B s3 not blue: ' + r.B.s3);
if (isRed(r.B.s0)) ok('B: shape 0 STILL red — earlier row preserved across partial upload');
else fail('B s0 lost its override: ' + r.B.s0);
if (isWhite(r.B.s1) && isWhite(r.B.s2)) ok('B: untouched shapes 1,2 still white');
else fail('B s1/s2 wrong: ' + r.B.s1 + ' / ' + r.B.s2);

await browser.close();
server.close();
if (failures === 0) console.log('\nOVERRIDE-DIRTY-BAND PASS');
else console.log(`\nOVERRIDE-DIRTY-BAND FAIL (${failures})`);
process.exit(failures ? 1 : 0);
