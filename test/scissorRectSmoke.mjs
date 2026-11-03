// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// scissorRectSmoke.mjs — scissor-rect API.
//
// renderer.setScissorRect(x, y, w, h) restricts subsequent
// drawBundle() calls to a rectangular region of the canvas;
// renderer.clearScissorRect() removes it. Drawing-buffer coordinates,
// origin lower-left.
//
// Tests:
//   T1 — basic clip: 100×100 canvas, full-canvas red bundle, scissor
//        (25,25,50,50) → 50×50 red patch, rest of canvas = backdrop.
//   T2 — replace not intersect: two consecutive setScissorRect calls
//        produce a result determined by the LAST rect alone.
//   T3 — endFrame implicit-clears: after endFrame, SCISSOR_TEST is
//        disabled (subsequent draws cover full viewport).
//
// Offscreen-RT preservation (the trickiest property of the contract)
// is structurally guaranteed by the renderer's bindFb wrapper: every
// internal bindFramebuffer routes through bindFb, which disables
// SCISSOR_TEST whenever fbo !== null. No visual proof needed beyond
// "T1 inside the clip is fully red" — if internal RTs were getting
// cropped, the coverage fill pass would have produced black pixels inside
// the scissor (the offscreen FBO defaults to clear-color outside the
// clip), and the canvas-composite would have inherited them.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'scissor-rect');
mkdirSync(OUT, { recursive: true });

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import {
  createScene, sceneToBundle, rectContour,
  createBundle, createRenderer, loadShaders,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', {
  stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true,
});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

// Bundle: a 200×200 red rectangle at the origin. Drawn into a 100×100
// canvas it covers the whole canvas at z-scale (the importer adjusts
// globalBBox to enclose the geometry).
function makeRedBundle() {
  const scene = createScene();
  scene.root.shapes.push({
    contours: [rectContour(0, 0, 200, 200)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  return sceneToBundle(scene).then(s => createBundle(gl, s));
}

const id = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function readPx(x, y) {
  // GL coords: origin lower-left, matches setScissorRect convention.
  const buf = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return [buf[0], buf[1], buf[2], buf[3]];
}

const results = {};

// ----- T1: basic clip -----
{
  const bundle = await makeRedBundle();
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 1, 1]);   // blue backdrop
  renderer.setScissorRect(25, 25, 50, 50);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  // Inside rect: expect red (1,0,0). Outside: expect blue (0,0,1).
  const insideCenter = readPx(50, 50);
  const insideLL     = readPx(25, 25);  // bottom-left of clip
  const insideUR     = readPx(74, 74);  // top-right inside
  const outsideLeft  = readPx(10, 50);
  const outsideRight = readPx(85, 50);
  const outsideTop   = readPx(50, 85);
  const outsideBot   = readPx(50, 10);
  // Just OUTSIDE the rect edges (should be blue).
  const justOutsideLeft   = readPx(24, 50);
  const justOutsideBot    = readPx(50, 24);
  const justOutsideRight  = readPx(75, 50);
  const justOutsideTop    = readPx(50, 75);

  results.T1 = {
    insideCenter, insideLL, insideUR,
    outsideLeft, outsideRight, outsideTop, outsideBot,
    justOutsideLeft, justOutsideBot, justOutsideRight, justOutsideTop,
    pngDataUrl: cnv.toDataURL('image/png'),
  };
  bundle.dispose();
}

// ----- T2: replace not intersect -----
{
  const bundle = await makeRedBundle();
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 1, 1]);   // blue backdrop
  // First rect (would carve top-left if intersect was the semantic).
  renderer.setScissorRect(0, 50, 50, 50);
  // Second rect (this should be the only one that applies).
  renderer.setScissorRect(50, 0, 50, 50);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  // Expect red in lower-right quadrant (50,0,50,50), blue elsewhere.
  // If intersect were the semantic, the two rects don't overlap → all blue.
  const inSecond  = readPx(75, 25);   // inside second rect → red
  const inFirst   = readPx(25, 75);   // inside first rect ONLY → blue (replaced)
  results.T2 = {
    inSecond, inFirst,
    pngDataUrl: cnv.toDataURL('image/png'),
  };
  bundle.dispose();
}

// ----- T3: endFrame implicit-clears scissor -----
{
  const bundle = await makeRedBundle();
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 1, 1]);
  renderer.setScissorRect(25, 25, 50, 50);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  // SCISSOR_TEST must be disabled after endFrame. The user has no
  // direct getter; probe via gl.getParameter(gl.SCISSOR_TEST).
  const scissorEnabledAfterEnd = gl.getParameter(gl.SCISSOR_TEST);
  // Now a second frame with NO setScissorRect should fill the whole
  // canvas, not just the previous rect.
  renderer.beginFrame([0, 1, 0, 1]);   // green backdrop
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  // Outside the previous rect: should be red (the second-frame bundle
  // had no scissor → filled full canvas).
  const oldOutside1 = readPx(10, 10);
  const oldOutside2 = readPx(90, 90);
  results.T3 = {
    scissorEnabledAfterEnd: !!scissorEnabledAfterEnd,
    oldOutside1, oldOutside2,
    pngDataUrl: cnv.toDataURL('image/png'),
  };
  bundle.dispose();
}

window.__result = results;
window.__done = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('  [console-err]', msg.text());
});
await page.setViewport({ width: 200, height: 200 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 });
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

function dumpPng(name, dataUrl) {
  if (!dataUrl) return;
  writeFileSync(
    path.join(OUT, name + '.png'),
    Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
  );
}
dumpPng('T1-basic', r.T1?.pngDataUrl);
dumpPng('T2-replace', r.T2?.pngDataUrl);
dumpPng('T3-endframe', r.T3?.pngDataUrl);

// T1 thresholds — exact channel inequalities (no AA on the scissor edges).
function isRed(px) {
  return px[0] > 240 && px[1] < 16 && px[2] < 16;
}
function isBlue(px) {
  return px[0] < 16 && px[1] < 16 && px[2] > 240;
}

// T1.
{
  const t = r.T1;
  if (!t) fail('T1 result missing');
  else {
    if (isRed(t.insideCenter)) ok('T1 inside center is red');
    else fail(`T1 inside center expected red, got ${JSON.stringify(t.insideCenter)}`);
    if (isRed(t.insideLL)) ok('T1 inside bottom-left corner is red');
    else fail(`T1 inside LL expected red, got ${JSON.stringify(t.insideLL)}`);
    if (isRed(t.insideUR)) ok('T1 inside top-right corner is red');
    else fail(`T1 inside UR expected red, got ${JSON.stringify(t.insideUR)}`);
    if (isBlue(t.outsideLeft)) ok('T1 outside-left is backdrop');
    else fail(`T1 outside-left expected blue, got ${JSON.stringify(t.outsideLeft)}`);
    if (isBlue(t.outsideRight)) ok('T1 outside-right is backdrop');
    else fail(`T1 outside-right expected blue, got ${JSON.stringify(t.outsideRight)}`);
    if (isBlue(t.outsideTop)) ok('T1 outside-top is backdrop');
    else fail(`T1 outside-top expected blue, got ${JSON.stringify(t.outsideTop)}`);
    if (isBlue(t.outsideBot)) ok('T1 outside-bottom is backdrop');
    else fail(`T1 outside-bottom expected blue, got ${JSON.stringify(t.outsideBot)}`);
    if (isBlue(t.justOutsideLeft)) ok('T1 just-outside-left is backdrop');
    else fail(`T1 just-outside-left got ${JSON.stringify(t.justOutsideLeft)}`);
    if (isBlue(t.justOutsideBot)) ok('T1 just-outside-bottom is backdrop');
    else fail(`T1 just-outside-bottom got ${JSON.stringify(t.justOutsideBot)}`);
    if (isBlue(t.justOutsideRight)) ok('T1 just-outside-right is backdrop');
    else fail(`T1 just-outside-right got ${JSON.stringify(t.justOutsideRight)}`);
    if (isBlue(t.justOutsideTop)) ok('T1 just-outside-top is backdrop');
    else fail(`T1 just-outside-top got ${JSON.stringify(t.justOutsideTop)}`);
  }
}

// T2.
{
  const t = r.T2;
  if (!t) fail('T2 result missing');
  else {
    if (isRed(t.inSecond)) ok('T2 inside second rect is red (latest setScissorRect wins)');
    else fail(`T2 inSecond expected red, got ${JSON.stringify(t.inSecond)}`);
    if (isBlue(t.inFirst))
      ok(
        'T2 inside first-rect-only region is backdrop (intersect semantic would also be blue, but the test asserts the bottom-right is red — see inSecond)',
      );
    else fail(`T2 inFirst expected blue, got ${JSON.stringify(t.inFirst)}`);
  }
}

// T3.
{
  const t = r.T3;
  if (!t) fail('T3 result missing');
  else {
    if (t.scissorEnabledAfterEnd === false) ok('T3 SCISSOR_TEST disabled after endFrame');
    else fail(`T3 SCISSOR_TEST still enabled after endFrame`);
    if (isRed(t.oldOutside1)) ok('T3 next frame fills (10,10) with red (no scissor leak)');
    else fail(`T3 oldOutside1 expected red, got ${JSON.stringify(t.oldOutside1)}`);
    if (isRed(t.oldOutside2)) ok('T3 next frame fills (90,90) with red (no scissor leak)');
    else fail(`T3 oldOutside2 expected red, got ${JSON.stringify(t.oldOutside2)}`);
  }
}

console.log(`\nPNGs saved to ${OUT}`);
if (failures > 0) {
  console.error(`\nSCISSOR-RECT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nSCISSOR-RECT PASS');
