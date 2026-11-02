// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStreamSentinelSmoke.mjs — a STREAMED (lightweight `_lbStream`) bundle with a
// section the analytic fill can't serve must NOT blank or fragment the whole
// road. The unservable section becomes a slug sentinel (skipped); the servable
// sections still stream through the one-draw unified route (seamless).
//
// The unservable section is a cubic lying back along its own chord (zero area,
// which the static builder declines). Not a self-crossing loop: the stream builds
// through buildLbShape, the static route, which serves a loop.
//
// A streamed road must not fragment: a stream that fails whole on one unservable
// section leaves _lbStream unset → a blank road that frame (flicker), and a draw
// that bails to per-shape on sentinels leaves AA seams between sections.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="120" height="120"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkLine, mkCubic } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
// NOTE: global analytic toggle stays OFF — the lightweight stream must self-route.
renderer.setLoopBlinnFill(false);
const VBOX = [0, 0, 120, 120];
const rect = (x, y, w, h) => [mkLine([x, y], [x + w, y]), mkLine([x + w, y], [x + w, y + h]), mkLine([x + w, y + h], [x, y + h]), mkLine([x, y + h], [x, y])];
// a cubic folded back along its own chord: no area, so no builder serves it
const loopShape = [mkLine([50, 20], [50, 100]), mkCubic([50, 100], [50, 70], [50, 50], [50, 20])];
const init = [{ segs: rect(10, 45, 30, 30), fill: [1, 0, 0, 1] },
              { segs: loopShape, fill: [0, 0, 1, 1] },
              { segs: rect(85, 45, 30, 30), fill: [0, 1, 0, 1] }];
const bundle = createBundle(gl, buildStreamableSections(init, VBOX, { lightweight: true }));
const segs = [rect(10, 45, 30, 30), loopShape, rect(85, 45, 30, 30)];
const fills = [[1, 0, 0, 1], [0, 0, 1, 1], [0, 1, 0, 1]];
for (let f = 0; f < 3; f++) updateBundleGeometry(gl, bundle, segs, { fills });   // a few scroll frames

const r0 = renderer.debugStats.loopBlinnRouteCount;
const u0 = renderer.debugStats.unifiedFillDraws | 0;
renderer.setViewport(120, 120); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame();
const px = new Uint8Array(120 * 120 * 4); gl.readPixels(0, 0, 120, 120, gl.RGBA, gl.UNSIGNED_BYTE, px);
let red = 0, green = 0, blue = 0;
for (let i = 0; i < px.length; i += 4) {
  if (px[i] > 128 && px[i + 1] < 80 && px[i + 2] < 80) red++;
  else if (px[i + 1] > 128 && px[i] < 80 && px[i + 2] < 80) green++;
  else if (px[i + 2] > 128 && px[i] < 80 && px[i + 1] < 80) blue++;
}
window.__out = {
  lbStream: !!bundle._lbStream, hasSlug: !!bundle._lbHasSlug, unified: (renderer.debugStats.unifiedFillDraws | 0) > u0,
  routed: renderer.debugStats.loopBlinnRouteCount > r0, red, green, blue,
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));

if (o.lbStream) ok('lightweight stream stayed on the analytic path despite an unservable section');
else fail('_lbStream unset — the unservable section blanked the whole stream (the bug)');
if (o.routed) ok('bundle routed through the analytic fill');
else fail('did not route');
if (o.hasSlug) ok('the unservable section was sentinel-skipped (not a whole-bundle failure)');
else fail('expected _lbHasSlug — the unservable section should be a sentinel');
if (o.unified)
  ok('servable sections render through the unified draw (one stream, no AA-seam fragmenting)');
else fail('the unified draw did not run, so the sections were not drawn as one stream');
if (o.red > 600 && o.green > 600)
  ok('both servable rect sections rendered (red ' + o.red + ', green ' + o.green + ')');
else fail('servable sections missing: red=' + o.red + ' green=' + o.green);
if (o.blue < 50)
  ok(
    'the unservable section is skipped (no Slug geometry on the lightweight path), not fragmenting the rest',
  );
else fail('unexpected blue ' + o.blue);

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nlbStreamSentinelSmoke: streamed road skips an unservable section without blanking/fragmenting',
);
