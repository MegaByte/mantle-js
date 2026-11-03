// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// objectBboxStrokeSmoke.mjs — `objectBoundingBox` units resolve against the
// GEOMETRY box, not the stroke-padded one.
//
// SVG 1.1 §7.11: "the bounding box ... does not include the stroke". The
// importer keeps two boxes for a stroked shape — path + halfW*miterLimit
// (coverage) and the path-tight one — and clipPathUnits / maskContentUnits
// resolve against the path-tight one. With a wide miter-limited stroke the
// coverage box is several times the geometry, so a `width="0.5"` clip against it
// would cover the entire shape and clip nothing.
//
// Fixture: a 60x60 rect with a stroke-width 20 miter stroke, so the coverage box
// is 140x140. The clip is the MIDDLE HALF (x 0.25..0.75) — deliberately not a
// half-split, because both boxes are centered on the shape and any symmetric cut
// lands in the same place under either. The middle half of a 60-wide geometry box
// is em 35..65; the middle half of the 140-wide padded box is em 15..85, more
// than twice as wide, so the two are trivially told apart.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CLIPPED =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<defs><clipPath id="half" clipPathUnits="objectBoundingBox">' +
  '<rect x="0.25" y="0" width="0.5" height="1"/></clipPath></defs>' +
  '<rect x="20" y="20" width="60" height="60" fill="#ff0000" stroke="#ff0000"' +
  ' stroke-width="20" stroke-linejoin="miter" stroke-miterlimit="4"' +
  ' clip-path="url(#half)"/></svg>';
// Same art, no clip — the control the clipped render is measured against.
const PLAIN = CLIPPED.replace(' clip-path="url(#half)"', '');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders); r.setViewport(200,200);
const inkCols = async (svg) => {
  const b = createBundle(gl, await importSvg(svg));
  r.prepareBundle(b);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px = new Uint8Array(200*200*4);
  gl.readPixels(0,0,200,200,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0, minX=1e9, maxX=-1e9;
  for (let y=0;y<200;y++) for (let x=0;x<200;x++) {
    const q=((199-y)*200+x)*4;
    if (px[q]>200 && px[q+1]<60) { n++; if (x<minX) minX=x; if (x>maxX) maxX=x; }
  }
  return { n, minX, maxX };
};
const plain = await inkCols(${JSON.stringify(PLAIN)});
const clipped = await inkCols(${JSON.stringify(CLIPPED)});
window.__out = { plain, clipped };
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
// The surviving band's WIDTH is the discriminator, in canvas px. Content is
// fitted to the asset frame (em 10..90 over 200px = 2.5 px/em), so the geometry
// box gives 30em -> 75px and the padded box 70em -> 175px.
const w = o.clipped.maxX - o.clipped.minX + 1;
if (o.plain.n > 1000) ok('control draws (' + o.plain.n + ' ink px)');
else fail('control barely drew: ' + JSON.stringify(o.plain));
if (Math.abs(w - 75) <= 8)
  ok('objectBoundingBox clip spans ' + w + 'px — the geometry box (expected ~75)');
else
  fail(
    'clip spans ' +
      w +
      'px, expected ~75 — objectBoundingBox resolved against the' +
      ' STROKE-PADDED box (~175px), not the geometry box (SVG 1.1 §7.11)',
  );

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
