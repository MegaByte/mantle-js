// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// An animated clip must survive a sprite morph: composeMorphSections must
// forward bundle.clipperRows so overrides.setClipper() resolves on the
// morph bundle — otherwise an animated clipPath on a morphed (sprite)
// bundle silently stops moving.
//
// Fixture: a sheet whose 'win' sprite is a big orange rect clipped to a small
// window; 'plain' is the morph partner (same rect topology, no clip). After
// createSpriteMorph('win'→'plain'), assert:
//   1. The morph bundle FORWARDS clipperRows (the 'window' clip is present).
//   2. setClipper('window', …) returns true.
//   3. Moving the clip actually changes the rendered output (the orange
//      window shifts), proving the clip override reaches the shader.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 'win' = orange rect clipped to a 20×20 window at (40,40). 'plain' = a
// matching rect (morph partner). The clipPath layer rows are appended after
// the visible shapes (outside any sprite range) — exactly the case that
// exercises the forwarded-clipperRows path.
const SHEET = readFileSync(
  new URL('../examples/smoke/spriteMorphClip__SHEET.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createSpriteMorph } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sheet = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__sheetClippers = Object.keys(sheet.clipperRows || {});

// Morph the clipped sprite against the plain one, pinned at t=0 (fully 'win').
const morph = createSpriteMorph(gl, { bundle: sheet, sprite: 'win' }, { bundle: sheet, sprite: 'plain' });
morph.setT(0);
window.__morphClippers = Object.keys(morph.bundle.clipperRows || {});

window.__draw = () => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(morph.bundle, { worldMatrix: id, overrides: morph.overrides });
  renderer.endFrame();
};
window.__setClip = (dx, dy) => morph.overrides.setClipper('window', { localPosition: [dx, dy] });
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
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
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

// Sanity: the sheet has the 'window' clip.
const sheetClips = await page.evaluate(() => window.__sheetClippers);
if (sheetClips.includes('window')) ok('sheet exposes clipperRows.window');
else fail('sheet missing window clip: ' + JSON.stringify(sheetClips));

// (1) The morph bundle FORWARDS clipperRows.
const morphClips = await page.evaluate(() => window.__morphClippers);
if (morphClips.includes('window')) ok('morph bundle forwarded clipperRows.window (fix)');
else
  fail(
    'morph bundle dropped clipperRows: ' +
      JSON.stringify(morphClips) +
      ' — animated clip would silently stop',
  );

// (2) setClipper returns true on the morph bundle.
const ret = await page.evaluate(() => window.__setClip(0, 0));
if (ret === true) ok('setClipper("window") returns true on the morph bundle');
else fail('setClipper returned ' + ret + ' (clip not resolvable)');

// (3) Moving the clip visibly shifts the orange window. Baseline window at
// (40..60); a probe inside it is orange, outside is background. Shift the
// clip +25 in x → the probe that was inside is now outside (and vice versa).
const r = await page.evaluate(() => {
  window.__setClip(0, 0);
  window.__draw();
  const at50 = window.__sample(50, 50); // inside the un-moved window → orange
  const at80 = window.__sample(80, 50); // outside → background
  window.__setClip(25, 0);
  window.__draw(); // shift window right by 25 (em)
  const at50b = window.__sample(50, 50); // now outside the moved window
  const at80b = window.__sample(80, 50); // now inside → orange
  return { at50, at80, at50b, at80b };
});
const isOrange = (p) => p[0] > 180 && p[1] > 60 && p[1] < 160 && p[2] < 60;
const isBg = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;
if (isOrange(r.at50) && isBg(r.at80)) ok('baseline: orange window at x=50, background at x=80');
else fail('baseline clip wrong: at50=' + r.at50 + ' at80=' + r.at80);
if (isBg(r.at50b) && isOrange(r.at80b))
  ok('clip moved: window shifted to x=80 (clip override reaches the shader)');
else fail('clip did NOT move: at50=' + r.at50b + ' at80=' + r.at80b);

await browser.close();
server.close();
if (failures === 0) console.log('\nSPRITE-MORPH-CLIP PASS');
else console.log(`\nSPRITE-MORPH-CLIP FAIL (${failures})`);
process.exit(failures ? 1 : 0);
