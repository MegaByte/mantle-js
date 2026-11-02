// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sceneVisualSmoke.mjs — end-to-end Puppeteer proof that
// createScene + sceneToBundle → createBundle → render produces actual
// pixels. Two shapes: red rect filling [0..100, 0..100], blue
// ellipse inscribed centerd on (50, 50) r=30. Reads pixels at the
// corner (should be RED) and center (should be BLUE).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
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
await page.setViewport({ width: 300, height: 300 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 10000, polling: 100 });
const result = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let failures = 0;
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

console.log();
console.log(failures === 0 ? 'SCENE-VISUAL PASS' : `SCENE-VISUAL FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
