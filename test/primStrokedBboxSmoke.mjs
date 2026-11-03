// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primStrokedBboxSmoke.mjs — a FILL row's bbox is the path-tight one, even when
// the shape is stroked.
//
// The tagged-primitive fast path derives its shape from the row's bbox: a
// circle's radius is min(half-extent), a rect's extent is the half-extent. Give
// that row a bbox padded by the stroke's reach and the SDF describes a shape
// LARGER than the cover quad, so coverage comes back 1 for every fragment in the
// quad and the fill floods it — a stroked circle paints a red SQUARE, its bbox
// corners showing outside the ring. (Same bbox also carries objectBoundingBox
// gradient mapping, which SVG 1.1 §7.11 defines on the geometry box WITHOUT
// stroke.)
//
// Invariant tested, scale-independently: for a stroked circle every fill pixel
// lies inside the ring — max fill radius <= min stroke radius.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CIRC =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<circle cx="50" cy="50" r="22" fill="#ff0000" stroke="#000000" stroke-width="8"/></svg>';

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders); r.setViewport(200,200);
const b = createBundle(gl, await importSvg(${JSON.stringify(CIRC)}));
r.prepareBundle(b);
r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
const px = new Uint8Array(200*200*4);
gl.readPixels(0,0,200,200,gl.RGBA,gl.UNSIGNED_BYTE,px);
const at = (x,y) => { const q=((199-y)*200+x)*4; return [px[q],px[q+1],px[q+2]]; };
// Centroid of ink (non-white), then radial extremes per class.
let sx=0, sy=0, n=0;
for (let y=0;y<200;y++) for (let x=0;x<200;x++) { const p=at(x,y);
  if (p[0]>240 && p[1]>240 && p[2]>240) continue; sx+=x; sy+=y; n++; }
const cx=sx/n, cy=sy/n;
let fillMax=0, strokeMin=1e9, fillN=0, strokeN=0;
for (let y=0;y<200;y++) for (let x=0;x<200;x++) { const p=at(x,y);
  const rr=Math.hypot(x-cx,y-cy);
  if (p[0]>200 && p[1]<60 && p[2]<60) { fillN++; if (rr>fillMax) fillMax=rr; }
  else if (p[0]<60 && p[1]<60 && p[2]<60) { strokeN++; if (rr<strokeMin) strokeMin=rr; }
}
window.__out = { fillMax:+fillMax.toFixed(1), strokeMin:+strokeMin.toFixed(1), fillN, strokeN, ink:n };
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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.fillN > 100 && o.strokeN > 100) ok('stroked circle drew both a fill and a ring');
else fail('expected both fill and ring pixels, got ' + JSON.stringify(o));
// One pixel of slack for the AA seam where fill meets stroke.
if (o.fillMax <= o.strokeMin + 1.5)
  ok('fill stays inside the ring (fillMax ' + o.fillMax + ' <= strokeMin ' + o.strokeMin + ')');
else
  fail(
    'fill escapes the ring: fillMax ' +
      o.fillMax +
      ' > strokeMin ' +
      o.strokeMin +
      ' — the fill row is using a stroke-padded bbox, so the primitive SDF floods its cover quad',
  );

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
