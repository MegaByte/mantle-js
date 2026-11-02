// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeStreamSmoke.mjs — geometry streaming on the no-WebGL NATIVE scene.
//
// A buildStreamableSections bundle carries a synthesized svgSource (one
// <path> per shape), so createNativeScene can render it; updateNativeBundleGeometry
// streams new per-shape geometry (and fills) by rewriting each <path d> via an
// override table the scene auto-applies. This proves a streamed shape actually
// MOVES + RECOLORS in the live SVG DOM on the native path (the WebGL streaming
// road's no-WebGL equivalent).
//
// Real browser (puppeteer), NO WebGL context — createNativeScene only. Pixels
// sampled by rasterizing the live <svg> into a 2D canvas.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="raster" width="120" height="120"></canvas>
<script type="module">
import { buildStreamableSections, createNativeScene, updateNativeBundleGeometry } from '/src/index.js';
import { mkLine } from '/src/primitives/seg.js';

const W=120,H=120,VBOX=[0,0,W,H];
const rect=(x,y,w,h)=>[mkLine([x,y],[x+w,y]),mkLine([x+w,y],[x+w,y+h]),mkLine([x+w,y+h],[x,y+h]),mkLine([x,y+h],[x,y])];

// Streamable bundle: ONE red square at top-left. On native the bundle IS the
// sections object (svgSource + numShapes + shapeIds — all the native scene reads).
const bundle = buildStreamableSections([{ segs: rect(10,10,30,30), fill:[1,0,0,1] }], VBOX);
bundle.globalBBox = VBOX.slice();
window.__hasSvgSource = typeof bundle.svgSource === 'string' && bundle.svgSource.includes('<path');

const host = document.getElementById('host');
const scene = createNativeScene(host);
scene.setViewport(W,H);
const drawOnce = () => { scene.beginFrame([1,1,1,1]); scene.drawBundle(bundle); scene.endFrame(); };

const rctx = document.getElementById('raster').getContext('2d');
async function sampleAll() {
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=url;});
  rctx.clearRect(0,0,W,H); rctx.drawImage(img,0,0,W,H);
}
const at = (x,y) => { const p = rctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
const isRed = c => c[0]>180 && c[1]<80 && c[2]<80;
const isBlue = c => c[2]>180 && c[0]<80 && c[1]<80;
const isWhite = c => c[0]>200 && c[1]>200 && c[2]>200;

// Frame 1: initial geometry at top-left (25,25); bottom-right (95,95) empty.
drawOnce(); await sampleAll();
const f1 = { atStart: at(25,25), atTarget: at(95,95) };

// Stream: move the square to the BOTTOM-RIGHT.
const r2 = updateNativeBundleGeometry(bundle, [rect(80,80,30,30)]);
drawOnce(); await sampleAll();
const f2 = { ok:r2.ok, atStart: at(25,25), atTarget: at(95,95) };

// Stream fills: recolor (in place) red → blue at the streamed position.
const r3 = updateNativeBundleGeometry(bundle, [rect(80,80,30,30)], { fills:[[0,0,1,1]] });
drawOnce(); await sampleAll();
const f3 = { ok:r3.ok, atTarget: at(95,95) };

window.__out = {
  hasSvgSource: window.__hasSvgSource,
  f1_start_red: isRed(f1.atStart), f1_target_empty: isWhite(f1.atTarget),
  f2_ok: f2.ok, f2_start_empty: isWhite(f2.atStart), f2_target_red: isRed(f2.atTarget),
  f3_ok: f3.ok, f3_target_blue: isBlue(f3.atTarget),
  raw: { f1, f2, f3 },
};
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
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o.raw));

if (o.hasSvgSource) ok('buildStreamableSections synthesizes an svgSource (<path> per shape)');
else fail('no synthesized svgSource — native scene cannot render a streamable bundle');
if (o.f1_start_red && o.f1_target_empty)
  ok('initial streamed geometry renders on the native scene');
else fail('initial render wrong: ' + JSON.stringify(o.raw.f1));
if (o.f2_ok) ok('updateNativeBundleGeometry returns ok');
else fail('updateNativeBundleGeometry failed');
if (o.f2_start_empty && o.f2_target_red)
  ok('streamed geometry MOVED in the live SVG DOM (start cleared, target filled)');
else fail('stream did not move geometry: ' + JSON.stringify(o.raw.f2));
if (o.f3_ok && o.f3_target_blue) ok('streamed per-shape fill recolors the shape (red→blue)');
else fail('fill stream wrong: ' + JSON.stringify(o.raw.f3));

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nnativeStreamSmoke: geometry + fills stream into the no-WebGL native scene');
