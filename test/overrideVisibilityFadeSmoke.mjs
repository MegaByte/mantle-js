// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Per-shape override `visibility` is a CONTINUOUS [0,1] fade, not binary
// on/off.
//
// The GL vertex shader folds visibility into the override tint alpha
// (vFill *= vOverrideTint), so visibility 0.5 ⇒ 50% opacity. A single green
// square over BLACK so the green channel directly reads the opacity (over
// white it would stay 255 and hide a binary-collapse fault).
//
// DIRTY ROW BAND (second page).
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
  '<rect id="g" x="20" y="20" width="60" height="60" fill="#00FF00"/></svg>';

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="80" height="80"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);
const ov = createOverrideTable(gl, b);
// center-pixel green channel over a BLACK clear → directly = opacity*255.
function centerGreen() {
  const px = new Uint8Array(80*80*4);
  gl.readPixels(0,0,80,80, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px[(40*80 + 40)*4 + 1];
}
window.__byVis = () => {
  const out = {};
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    ov.update(0, { visibility: v });
    renderer.beginFrame([0,0,0,1]);
    renderer.drawBundle(b, { worldMatrix: id, overrides: ov });
    renderer.endFrame();
    out[v] = centerGreen();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

// Four white rects: override rows 0..3.
const BAND_SVG =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0"  y="0" width="25" height="100" fill="#ffffff"/>' +
  '<rect x="25" y="0" width="25" height="100" fill="#ffffff"/>' +
  '<rect x="50" y="0" width="25" height="100" fill="#ffffff"/>' +
  '<rect x="75" y="0" width="25" height="100" fill="#ffffff"/></svg>';

const BAND_HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { stencil: true, depth: true, antialias: false, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(BAND_SVG)}));
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
  if (req.url === '/dirty-band') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(BAND_HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const x = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(x);
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

// The lane's backend choice, not a hardcoded one — see test/shapeAnimationVisualSmoke.mjs.
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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const g = await page.evaluate(() => window.__byVis());
const near = (a, b, tol = 24) => Math.abs(a - b) <= tol;
if (g['0'] === 0) ok('visibility 0 → fully hidden (green 0)');
else fail('vis0 green=' + g['0']);
if (g['1'] >= 230) ok('visibility 1 → fully opaque (green ' + g['1'] + ')');
else fail('vis1 green=' + g['1']);
// The bug: fractional visibility rendered FULL (255). Assert a linear ramp.
if (near(g['0.25'], 64)) ok('visibility 0.25 → ~25% opacity (green ' + g['0.25'] + ')');
else fail('vis0.25 not ~64: ' + g['0.25'] + ' (binary visibility)');
if (near(g['0.5'], 128)) ok('visibility 0.5 → ~50% opacity (green ' + g['0.5'] + ')');
else fail('vis0.5 not ~128: ' + g['0.5'] + ' (binary visibility)');
if (near(g['0.75'], 191)) ok('visibility 0.75 → ~75% opacity (green ' + g['0.75'] + ')');
else fail('vis0.75 not ~191: ' + g['0.75']);
if (g['0.25'] < g['0.5'] && g['0.5'] < g['0.75'])
  ok('opacity ramps monotonically with visibility (CONTINUOUS fade, not binary)');
else fail('non-monotonic: ' + JSON.stringify(g));

// ---- dirty row band: a partial override upload at a non-zero row offset ----
{
  const fadeFailures = failures;
  const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90;
  const isBlue = (p) => p[2] > 150 && p[0] < 90 && p[1] < 90;
  const isWhite = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/dirty-band`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
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
  }
  await page.close();
  const n = failures - fadeFailures;
  if (n === 0) console.log('\nOVERRIDE-DIRTY-BAND PASS');
  else console.log(`\nOVERRIDE-DIRTY-BAND FAIL (${n})`);
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\noverrideVisibilityFadeSmoke: all checks passed');
