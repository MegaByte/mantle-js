// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sceneToSectionsSmoke.mjs — Architecture B: direct scene→sections build,
// skipping the sceneToSvg → SVG-string → importSvg round-trip.
//
// Proves:
//   1. sceneToSections takes the DIRECT path for a solid-fill scene (no
//      `version` field — importSvg stamps version:3; the direct build omits it).
//   2. RENDER PARITY: a bundle from sceneToSections renders identically to one
//      from sceneToBundle (the SVG round-trip) — same shapes, nested transforms.
//   3. FALLBACK: a scene with a gradient fill transparently routes through
//      sceneToBundle (version:3 present), so unsupported features still build.
//
// Real browser + WebGL2 (renders both bundles and pixel-compares).
//
// ABSOLUTE COLORS (second page): createScene + sceneToBundle → createBundle → render produces actual
// pixels. Two shapes: red rect filling [0..100, 0..100], blue ellipse inscribed centered on
// (50, 50) r=30. Reads pixels at the corner (should be RED) and center (should be BLUE).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, sceneToSections, sceneToBundle, rectContour }
  from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const VBOX = [0, 0, 100, 100];

// Solid-fill scene: a red rect at the origin + a blue rect inside a node that
// translates it (exercises nested-node transform composition).
const solidScene = { root: { children: [
  { shapes: [{ id: 'red', contours: [rectContour(10, 10, 30, 30)], fill: { kind: 'solid', color: [1, 0, 0, 1] } }] },
  { transform: [1, 0, 0, 1, 50, 50],
    shapes: [{ id: 'blue', contours: [rectContour(0, 0, 30, 30)], fill: { kind: 'solid', color: [0, 0, 1, 1] } }] },
] } };

// Gradient scene → must fall back to the SVG round-trip.
const gradScene = { root: { children: [
  { shapes: [{ id: 'g', contours: [rectContour(10, 10, 60, 60)],
      fill: { kind: 'gradient', type: 'linear', stops: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 1, 0, 1] }],
        x1: 10, y1: 10, x2: 70, y2: 70 } }] },
] } };

const draw = (b) => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(b, {}); renderer.endFrame(); };
const mask = (pred) => {
  const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const m = new Uint8Array(100 * 100); let c = 0;
  for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (pred(px[o], px[o + 1], px[o + 2])) { m[i] = 1; c++; } }
  return { m, c };
};
const colored = () => mask((r, g, b) => r > 60 || g > 60 || b > 60);   // any non-black
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { const uu = a[k] || b[k]; u += uu; i += (a[k] && b[k]) ? 1 : 0; } return u ? i / u : 1; };

const out = {};

// (1)+(2) Direct vs round-trip parity.
const secDirect = await sceneToSections(solidScene, { viewBox: VBOX });
const secSvg = await sceneToBundle(solidScene, { viewBox: VBOX });
out.directNoVersion = secDirect.version === undefined;   // direct build omits importSvg's version:3
out.svgHasVersion = secSvg.version === 3;
out.directShapes = secDirect.numShapes;
out.svgShapes = secSvg.numShapes;

const bDirect = createBundle(gl, secDirect); draw(bDirect); const dColored = colored();
const bSvg = createBundle(gl, secSvg); draw(bSvg); const sColored = colored();
out.parityIoU = iou(dColored.m, sColored.m);
out.directPx = dColored.c; out.svgPx = sColored.c;

// (3) Gradient scene falls back to the SVG round-trip.
const secFb = await sceneToSections(gradScene, { viewBox: VBOX });
out.fallbackVersion = secFb.version;   // 3 → went through importSvg

window.__out = out; window.__ready = true;
</script></body></html>`;

const VISUAL_HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import {
  createScene, sceneToBundle, rectContour, ellipseContour,
  createBundle, createRenderer, loadShaders,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

const scene = createScene();
scene.root.shapes.push({
  contours: [rectContour(0, 0, 100, 100)],
  fill: { kind: 'solid', color: [1, 0, 0, 1] },
});
scene.root.shapes.push({
  contours: [ellipseContour(50, 50, 30, 30)],
  fill: { kind: 'solid', color: [0, 0, 1, 1] },
});
const sections = await sceneToBundle(scene);
const bundle = createBundle(gl, sections);

const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
renderer.setViewport(200, 200);
renderer.beginFrame([0,0,0,1]);
renderer.drawBundle(bundle, { worldMatrix: id });
renderer.endFrame();

function readAt(x, y) {
  const px = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [px[0], px[1], px[2]];
}
window.__result = {
  corner: readAt(20, 100),  // inside red rect, outside blue ellipse
  center: readAt(100, 100), // inside blue ellipse (covers the center)
};
window.__done = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (req.url === '/visual') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(VISUAL_HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    const buf = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(buf);
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

if (o.directNoVersion && o.svgHasVersion)
  ok(
    'sceneToSections built directly (no SVG round-trip — version omitted; round-trip stamps version:3)',
  );
else
  fail(
    'direct-path detection wrong: ' +
      JSON.stringify({ direct: o.directNoVersion, svg: o.svgHasVersion }),
  );
if (o.directShapes === o.svgShapes && o.directShapes === 2)
  ok('direct + round-trip agree on shape count (' + o.directShapes + ')');
else fail('shape-count mismatch: direct=' + o.directShapes + ' svg=' + o.svgShapes);
if (o.parityIoU > 0.95 && o.directPx > 500)
  ok(
    'render parity: direct == round-trip (IoU ' +
      o.parityIoU.toFixed(3) +
      ', ' +
      o.directPx +
      ' px)',
  );
else
  fail(
    'render parity failed: IoU ' +
      o.parityIoU.toFixed(3) +
      ' directPx=' +
      o.directPx +
      ' svgPx=' +
      o.svgPx,
  );
if (o.fallbackVersion === 3) ok('gradient scene falls back to the SVG round-trip (version:3)');
else fail('gradient scene did not fall back: version=' + o.fallbackVersion);

// ---- absolute colors of a createScene → sceneToBundle render ----
{
  const sectionsFailures = failures;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.setViewport({ width: 300, height: 300 });
  await page.goto(`http://127.0.0.1:${port}/visual`, {
    waitUntil: 'load',
    timeout: pageTimeoutFor(),
  });
  await page.waitForFunction(() => window.__done === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
  const result = await page.evaluate(() => window.__result);
  await page.close();
  const expectRed = (px, name) => {
    if (px[0] > 200 && px[1] < 30 && px[2] < 30) console.log('ok', name, 'is red', px);
    else {
      failures++;
      console.error('FAIL', name, 'expected red, got', px);
    }
  };
  const expectBlue = (px, name) => {
    if (px[0] < 30 && px[1] < 30 && px[2] > 200) console.log('ok', name, 'is blue', px);
    else {
      failures++;
      console.error('FAIL', name, 'expected blue, got', px);
    }
  };
  expectRed(result.corner, 'sceneToBundle rect corner');
  expectBlue(result.center, 'sceneToBundle ellipse center');

  const n = failures - sectionsFailures;
  console.log();
  console.log(n === 0 ? 'SCENE-VISUAL PASS' : `SCENE-VISUAL FAIL (${n})`);
}

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nsceneToSectionsSmoke: all assertions passed');
