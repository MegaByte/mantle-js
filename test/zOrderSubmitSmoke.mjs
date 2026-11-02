// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// zOrderSubmitSmoke.mjs — renderer.submitBundle(): deferred, stacking-ordered draws.
//
// Mantle paints in painter's order, so with drawBundle alone the stacking order IS the mount
// order — unstable the moment anything mounts asynchronously (an overlay that loads a font
// late, a feedback flash), unless each consumer keeps its own sorted mount list and calls
// drawBundle in sequence. submitBundle owns that: queue the draws, paint them at endFrame in
// (zOrder asc, submission asc) order.
//
// Guards the four properties the API promises:
//   1. LOWER zOrder paints UNDERNEATH, even when submitted LAST (the whole point).
//   2. Equal zOrder keeps SUBMISSION order (stable tiebreak).
//   3. The result is independent of submission order for distinct z (sort is total).
//   4. Immediate drawBundle still paints when called → lands UNDER anything submitted.
// Plus: submitBundle outside a frame must not silently drop the draw.
//
// Two full-canvas opaque squares of different colors; whichever paints last owns the pixel.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const sq = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="${color}"/></svg>`;
const RED = sq('#ff0000'); // 255,0,0
const BLUE = sq('#0000ff'); // 0,0,255

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders);
r.setViewport(100, 100);
const red = createBundle(gl, await importSvg(${JSON.stringify(RED)}));
const blue = createBundle(gl, await importSvg(${JSON.stringify(BLUE)}));
r.prepareBundle && r.prepareBundle(red); r.prepareBundle && r.prepareBundle(blue);
if (r.awaitLbReady) { await r.awaitLbReady(red); await r.awaitLbReady(blue); }

// Center pixel: 'red' | 'blue' | other. Whichever bundle painted LAST owns it.
const top = () => {
  const px = new Uint8Array(4);
  gl.readPixels(50, 50, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (px[0] > 180 && px[1] < 70 && px[2] < 70) return 'red';
  if (px[2] > 180 && px[0] < 70 && px[1] < 70) return 'blue';
  return 'other(' + px[0] + ',' + px[1] + ',' + px[2] + ')';
};
const out = {};

// 1. Submit BLUE first at high z, RED second at low z. Sort must put RED first → BLUE on top.
r.beginFrame([1,1,1,1]);
r.submitBundle(blue, { zOrder: 10 });
r.submitBundle(red,  { zOrder: 0 });
r.endFrame();
out.lowZUnderneath = top();                 // expect 'blue'

// 2. Same z → submission order decides. RED then BLUE → BLUE on top.
r.beginFrame([1,1,1,1]);
r.submitBundle(red,  { zOrder: 5 });
r.submitBundle(blue, { zOrder: 5 });
r.endFrame();
out.equalZFirstSubmitted = top();           // expect 'blue'
// ...and the reverse submission order flips it, proving the tiebreak is submission (not id).
r.beginFrame([1,1,1,1]);
r.submitBundle(blue, { zOrder: 5 });
r.submitBundle(red,  { zOrder: 5 });
r.endFrame();
out.equalZReversed = top();                 // expect 'red'

// 3. Distinct z is order-independent: submitting in the OTHER order must give the SAME image.
r.beginFrame([1,1,1,1]);
r.submitBundle(red,  { zOrder: 0 });
r.submitBundle(blue, { zOrder: 10 });
r.endFrame();
out.distinctZOrderIndependent = top();      // expect 'blue' (same as case 1)

// 4. Immediate drawBundle paints NOW, so it sits under anything submitted — even when the
//    submitted draw has a lower zOrder (z only orders the queue, not the immediates).
r.beginFrame([1,1,1,1]);
r.drawBundle(blue, {});                     // immediate → paints first
r.submitBundle(red, { zOrder: -100 });      // deferred → paints at endFrame, on top
r.endFrame();
out.immediateUnderSubmitted = top();        // expect 'red'

// 5. A submit with no frame open must not be silently dropped.
r.beginFrame([1,1,1,1]); r.drawBundle(blue, {}); r.endFrame();
r.submitBundle(red, { zOrder: 0 });         // outside a frame → falls back to immediate
out.submitOutsideFrame = top();             // expect 'red'

// 6. Default zOrder is 0 and still sorts against explicit values.
r.beginFrame([1,1,1,1]);
r.submitBundle(blue, { zOrder: 1 });
r.submitBundle(red,  {});                   // no zOrder → 0 → underneath
r.endFrame();
out.defaultZeroZ = top();                   // expect 'blue'

window.__out = out;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const out = await page.evaluate(() => window.__out);
await browser.close();
server.close();

let fail = 0;
const expect = (name, got, want) => {
  if (got === want) console.log('ok', name, '=', got);
  else {
    console.log('FAIL', name, '— got', got, 'want', want);
    fail++;
  }
};
expect('low zOrder paints underneath (submitted last)', out.lowZUnderneath, 'blue');
expect('equal zOrder keeps submission order', out.equalZFirstSubmitted, 'blue');
expect('equal zOrder tiebreak follows submission, not identity', out.equalZReversed, 'red');
expect('distinct zOrder is submission-order independent', out.distinctZOrderIndependent, 'blue');
expect('immediate drawBundle lands under submitted', out.immediateUnderSubmitted, 'red');
expect('submit outside a frame is not dropped', out.submitOutsideFrame, 'red');
expect('default zOrder is 0', out.defaultZeroZ, 'blue');

if (fail) {
  console.log(`\nZORDER-SUBMIT FAIL (${fail})`);
  process.exit(1);
}
console.log('\nZORDER-SUBMIT PASS');
