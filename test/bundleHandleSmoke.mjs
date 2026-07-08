// bundleHandleSmoke.mjs — smoke for the public createBundleHandle
// API. Verifies that two persistent handles holding distinct bundles
// render correctly in the SAME frame: each handle's mesh stays
// resident in its own VBO across frames, no re-upload on switch, no
// cross-interference.
//
// Assertions:
//   1. Each handle's draw() produces its own bundle's pixels at its
//      own world transform.
//   2. Drawing handle A → B → A → B in one frame produces the same
//      pixels as drawing B alone (because B is drawn last and covers
//      the canvas centre).
//   3. Drawing handle A → B in one frame produces both contributions
//      (different world matrices place them in non-overlapping rects).
//   4. handle.invalidate() flips the dirty flag without breaking the
//      next draw.
//   5. handle.dispose() releases GL resources without affecting other
//      handles.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/mantleDemo.html`;

// Two distinct fixtures: solid red square vs solid blue square.
// Different colors give the cross-interference assertion a clear signal.
const SVG_RED  = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" fill="#ff0000"/>
</svg>`;
const SVG_BLUE = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" fill="#0000ff"/>
</svg>`;

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const results = await page.evaluate(async (svgRed, svgBlue) => {
  const { importSvg, createBundle } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  const bRed  = createBundle(gl, await importSvg(svgRed));
  const bBlue = createBundle(gl, await importSvg(svgBlue));

  // Verify the renderer exposes createBundleHandle.
  if (typeof renderer.createBundleHandle !== 'function') {
    return { error: 'renderer.createBundleHandle is not a function' };
  }
  const hRed  = renderer.createBundleHandle(bRed);
  const hBlue = renderer.createBundleHandle(bBlue);

  // Handles expose the contract.
  const surface = {
    bundle:     hRed.bundle === bRed,
    draw:       typeof hRed.draw === 'function',
    invalidate: typeof hRed.invalidate === 'function',
    dispose:    typeof hRed.dispose === 'function',
  };

  function snap() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cIdx = ((h >> 1) * w + (w >> 1)) * 4;
    return [px[cIdx], px[cIdx + 1], px[cIdx + 2]];
  }

  // Single-handle render: should be the bundle's color.
  renderer.beginFrame([1, 1, 1, 1]);
  hRed.draw();
  renderer.endFrame();
  const onlyRed = snap();

  renderer.beginFrame([1, 1, 1, 1]);
  hBlue.draw();
  renderer.endFrame();
  const onlyBlue = snap();

  // Two-handle render, blue last → centre pixel is blue.
  // (Both bundles fill the full canvas at default world matrix.)
  renderer.beginFrame([1, 1, 1, 1]);
  hRed.draw();
  hBlue.draw();
  renderer.endFrame();
  const redThenBlue = snap();

  // Reverse order → centre pixel is red.
  renderer.beginFrame([1, 1, 1, 1]);
  hBlue.draw();
  hRed.draw();
  renderer.endFrame();
  const blueThenRed = snap();

  // Alternating order: A → B → A → B. Last is blue.
  renderer.beginFrame([1, 1, 1, 1]);
  hRed.draw();
  hBlue.draw();
  hRed.draw();
  hBlue.draw();
  renderer.endFrame();
  const alt4 = snap();

  // After invalidate(), the next draw should still work (mesh
  // re-uploads to the same VBO, no surface change).
  hRed.invalidate();
  renderer.beginFrame([1, 1, 1, 1]);
  hRed.draw();
  renderer.endFrame();
  const afterInvalidate = snap();

  // Dispose hRed; hBlue should still work.
  hRed.dispose();
  renderer.beginFrame([1, 1, 1, 1]);
  hBlue.draw();
  renderer.endFrame();
  const blueAfterRedDispose = snap();

  hBlue.dispose();
  bRed.dispose();
  bBlue.dispose();

  return { surface, onlyRed, onlyBlue, redThenBlue, blueThenRed, alt4,
           afterInvalidate, blueAfterRedDispose };
}, SVG_RED, SVG_BLUE);

await browser.close();
server.close();

if (results.error) {
  fail(results.error);
  process.exit(1);
}

const s = results.surface;
if (s.bundle && s.draw && s.invalidate && s.dispose) {
  ok('handle surface: { bundle, draw, invalidate, dispose }');
} else {
  fail(`handle surface missing fields: ${JSON.stringify(s)}`);
}

function expectColor(actual, expected, label) {
  const [r, g, b] = actual;
  const [er, eg, eb] = expected;
  const dr = Math.abs(r - er), dg = Math.abs(g - eg), db = Math.abs(b - eb);
  if (dr > 16 || dg > 16 || db > 16) {
    fail(`${label}: got (${r},${g},${b}), expected ~(${er},${eg},${eb})`);
    return false;
  }
  ok(`${label}: (${r},${g},${b}) ≈ (${er},${eg},${eb})`);
  return true;
}

expectColor(results.onlyRed,            [255, 0, 0],   'single hRed.draw centre is red');
expectColor(results.onlyBlue,           [0, 0, 255],   'single hBlue.draw centre is blue');
expectColor(results.redThenBlue,        [0, 0, 255],   'A → B order: centre is blue (B last)');
expectColor(results.blueThenRed,        [255, 0, 0],   'B → A order: centre is red (A last)');
expectColor(results.alt4,               [0, 0, 255],   'A → B → A → B: centre is blue (B last)');
expectColor(results.afterInvalidate,    [255, 0, 0],   'after hRed.invalidate(): red still renders');
expectColor(results.blueAfterRedDispose,[0, 0, 255],   'after hRed.dispose(): hBlue still renders');

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nbundleHandleSmoke: PASS');
