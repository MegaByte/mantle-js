// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanSilhouetteVisualSmoke — end-to-end visual smoke for the
// perimeter-outline feature. Imports an SVG with computeSilhouette
// enabled, renders it via WebGL, samples the rendered pixels to
// verify the silhouette outline appears around the union.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// The PNGs are a debugging aid for a failure, not evidence -- every assertion below reads the
// in-page pixel samples, never a file. Writing them to test/visuals/ on every run would put
// untracked output inside the package tree, so they default to the system temp directory; MANTLE_SMOKE_PNG_DIR puts them
// wherever you actually want to look at them.
const OUT = process.env.MANTLE_SMOKE_PNG_DIR
  ? path.resolve(process.env.MANTLE_SMOKE_PNG_DIR)
  : path.join(os.tmpdir(), 'mantle-smoke-png', 'silhouette-outline');
mkdirSync(OUT, { recursive: true });

// Two overlapping red squares. Computed silhouette: L-shaped boundary.
// Outline color: white, outline width: 4 em-units. The rendered image
// should show:
//   - red interior (the two squares).
//   - white outline along the L-shape boundary.
//   - black background outside everything.
const SVG = readFileSync(
  new URL('../examples/smoke/pathBooleanSilhouetteVisual__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);

// Baseline (no silhouette).
{
  const sections = await importSvg(${JSON.stringify(SVG)});
  const bundle = createBundle(gl, sections);
  renderer.setViewport(200, 200);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  window.__baseline = cnv.toDataURL('image/png');
  bundle.dispose();
}

// With silhouette outline (computeSilhouette + default white 4em outline).
{
  const sections = await importSvg(${JSON.stringify(SVG)}, {
    computeSilhouette: true,
    outlineColor: [1, 1, 1, 1],
    outlineWidth: 4,
  });
  const bundle = createBundle(gl, sections);
  renderer.setViewport(200, 200);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
  window.__outlined = cnv.toDataURL('image/png');

  // Sample a few pixels to verify:
  //   - Inside the union (e.g. center of first square at em (25, 25)):
  //     red, possibly with anti-aliasing from the stroke if at edge.
  //   - On the silhouette boundary: white (or at least lighter than red).
  //   - Outside the union: black.
  function readPx(x, y) {
    const buf = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2], buf[3]];
  }
  // Count white pixels in the rendered output. The outline should
  // produce a substantial number of white pixels (background
  // pre-outline was either red or black, never white).
  const w = 200, h = 200;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let whiteCount = 0, redCount = 0, blackCount = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i], g = buf[i+1], b = buf[i+2];
    if (r > 240 && g > 240 && b > 240) whiteCount++;
    else if (r > 240 && g < 16 && b < 16) redCount++;
    else if (r < 16 && g < 16 && b < 16) blackCount++;
  }
  window.__samples = { whiteCount, redCount, blackCount };
  bundle.dispose();
}

window.__d = true;
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
page.on('console', (m) => console.error(`  [console-${m.type()}]`, m.text()));
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
try {
  await page.waitForFunction(() => window.__d === true, { timeout: 30000, polling: 100 });
} catch (e) {
  console.error('  [wait-timeout]', e.message);
}
const baseline = await page.evaluate(() => window.__baseline);
const outlined = await page.evaluate(() => window.__outlined);
const samples = await page.evaluate(() => window.__samples);
await browser.close();
server.close();

if (baseline)
  writeFileSync(
    path.join(OUT, 'baseline.png'),
    Buffer.from(baseline.slice('data:image/png;base64,'.length), 'base64'),
  );
if (outlined)
  writeFileSync(
    path.join(OUT, 'outlined.png'),
    Buffer.from(outlined.slice('data:image/png;base64,'.length), 'base64'),
  );

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

if (samples) {
  console.log('samples:', JSON.stringify(samples));
  // The outlined render should have a substantial number of white
  // pixels — the silhouette stroke painted in white. Baseline
  // (no outline) has NO white pixels (background black, shapes red).
  if (samples.whiteCount > 500)
    ok(`outline rendered: ${samples.whiteCount} white pixels (silhouette stroke)`);
  else fail(`outline absent: whiteCount=${samples.whiteCount} (expected > 500)`);
  if (samples.redCount > 500)
    ok(`shape preserved: ${samples.redCount} red pixels (filled squares)`);
  else fail(`shape missing: redCount=${samples.redCount}`);
  if (samples.blackCount > 500)
    ok(`background preserved: ${samples.blackCount} black pixels (outside outline)`);
  else fail(`background eaten: blackCount=${samples.blackCount}`);
} else {
  fail('samples not captured');
}

console.log(`\nPNGs saved to ${OUT}`);
console.log(`baseline: ${path.join(OUT, 'baseline.png')}`);
console.log(`outlined: ${path.join(OUT, 'outlined.png')}`);

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN SILHOUETTE-VISUAL FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN SILHOUETTE-VISUAL PASS');
