// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeBlendModeSmoke.mjs — the native fallback must honor a per-draw
// blendMode on drawBundle (CSS mix-blend-mode), like the GL path.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A full-canvas magenta backdrop, then a cyan square blended over it.
// multiply(magenta #FF00FF, cyan #00FFFF) = #0000FF (blue). normal = cyan.
const MAGENTA =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="100" fill="#FF00FF"/></svg>';
const CYAN =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="25" y="25" width="50" height="50" fill="#00FFFF"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
const magenta = await importSvg(${JSON.stringify(MAGENTA)}, { retainSource: true });
const cyan = await importSvg(${JSON.stringify(CYAN)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const ctx = document.getElementById('c').getContext('2d');

async function draw(cyanBlend) {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(magenta, { worldMatrix: id });
  scene.drawBundle(cyan, { worldMatrix: id, blendMode: cyanBlend });   // 0=normal, 1=multiply
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const p = ctx.getImageData(50,50,1,1).data; return [p[0],p[1],p[2]];
}
window.__normal = () => draw(0);
window.__multiply = () => draw(1);
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
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
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const normal = await page.evaluate(() => window.__normal());
// normal: cyan square shows cyan (G & B high, R low).
if (normal[0] < 80 && normal[1] > 180 && normal[2] > 180)
  ok('blendMode=normal: cyan over magenta stays cyan (' + normal + ')');
else fail('normal blend wrong: ' + normal);

const mult = await page.evaluate(() => window.__multiply());
// multiply(magenta, cyan) = blue: R≈0, G≈0, B≈255.
if (mult[0] < 80 && mult[1] < 80 && mult[2] > 180)
  ok('blendMode=multiply: cyan × magenta → BLUE (' + mult + ')');
else fail('multiply blend not applied (bundle blendMode dropped?): ' + mult);

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeBlendModeSmoke: all checks passed');
