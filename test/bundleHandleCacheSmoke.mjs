// bundleHandleCacheSmoke.mjs — smoke for the per-handle static-scene
// cache. Verifies two handles each maintain their own cache state
// (state machine, FBO, RT) and that one handle's cache invalidation
// doesn't affect the other's.
//
// Assertions:
//   1. createBundleHandle accepts opts.staticCache config.
//   2. handle.staticCache returns the per-handle state machine.
//   3. After first draw, each handle's cache becomes valid.
//   4. Second draw of each handle reuses its OWN bake (lastBakeFrame
//      stable).
//   5. Invalidating handle A's cache doesn't affect handle B's cache.
//   6. Pixels through the cached blit match the live render for each
//      handle's own bundle.

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
  const { importSvg, createBundle, CacheStrategy } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  const bRed  = createBundle(gl, await importSvg(svgRed));
  const bBlue = createBundle(gl, await importSvg(svgBlue));

  // Both handles opt into A1 caching via the staticCache opts arg.
  const hRed  = renderer.createBundleHandle(bRed,  { staticCache: { strategy: CacheStrategy.ForceA1 } });
  const hBlue = renderer.createBundleHandle(bBlue, { staticCache: { strategy: CacheStrategy.ForceA1 } });

  function snap() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cIdx = ((h >> 1) * w + (w >> 1)) * 4;
    return [px[cIdx], px[cIdx + 1], px[cIdx + 2]];
  }

  const surface = {
    redCacheNonNull:  !!hRed.staticCache,
    blueCacheNonNull: !!hBlue.staticCache,
    distinctMachines: hRed.staticCache !== hBlue.staticCache,
  };

  // Frame 1 of red: should bake-then-blit.
  renderer.beginFrame([1, 1, 1, 1]);
  hRed.draw();
  renderer.endFrame();
  const redFrame1Pixel = snap();
  const redValid1   = hRed.staticCache.isCacheValid;
  const redBakeF1   = hRed.staticCache.lastBakeFrame;
  const redGen1     = hRed.staticCache.cacheGeneration;

  // Frame 2 of red: should reuse the bake.
  renderer.beginFrame([1, 1, 1, 1]);
  hRed.draw();
  renderer.endFrame();
  const redFrame2Pixel = snap();
  const redValid2   = hRed.staticCache.isCacheValid;
  const redBakeF2   = hRed.staticCache.lastBakeFrame;
  const redGen2     = hRed.staticCache.cacheGeneration;

  // Frame 1 of blue: blue's cache is INDEPENDENT — should bake on
  // this draw (still at lastBakeFrame=-1 if untouched).
  const blueValidBeforeFirstDraw = hBlue.staticCache.isCacheValid;
  const blueBakeBeforeFirstDraw  = hBlue.staticCache.lastBakeFrame;

  renderer.beginFrame([1, 1, 1, 1]);
  hBlue.draw();
  renderer.endFrame();
  const blueFrame1Pixel = snap();
  const blueValid1 = hBlue.staticCache.isCacheValid;
  const blueBakeF1 = hBlue.staticCache.lastBakeFrame;

  // Invalidate red's cache. Blue's cache should NOT be touched.
  hRed.invalidate();
  const redValidAfterInvalidate  = hRed.staticCache.isCacheValid;
  const redGenAfterInvalidate    = hRed.staticCache.cacheGeneration;
  const blueValidAfterRedInvalid = hBlue.staticCache.isCacheValid;
  const blueGenAfterRedInvalid   = hBlue.staticCache.cacheGeneration;

  // Cleanup
  hRed.dispose();
  hBlue.dispose();
  bRed.dispose();
  bBlue.dispose();

  return {
    surface,
    redFrame1Pixel, redFrame2Pixel,
    redValid1, redValid2,
    redBakeF1, redBakeF2,
    redGen1, redGen2,
    blueValidBeforeFirstDraw, blueBakeBeforeFirstDraw,
    blueFrame1Pixel,
    blueValid1, blueBakeF1,
    redValidAfterInvalidate, redGenAfterInvalidate,
    blueValidAfterRedInvalid, blueGenAfterRedInvalid,
  };
}, SVG_RED, SVG_BLUE);

await browser.close();
server.close();

// ---- Assertions --------------------------------------------------

const s = results.surface;
if (s.redCacheNonNull && s.blueCacheNonNull && s.distinctMachines) {
  ok('each handle has its own staticCache state machine');
} else {
  fail(`staticCache surface: ${JSON.stringify(s)}`);
}

function expectColor(actual, expected, tol, label) {
  const [r, g, b] = actual;
  const [er, eg, eb] = expected;
  if (Math.abs(r - er) > tol || Math.abs(g - eg) > tol || Math.abs(b - eb) > tol) {
    fail(`${label}: got (${r},${g},${b}), expected ~(${er},${eg},${eb}) tol=${tol}`);
    return false;
  }
  ok(`${label}: (${r},${g},${b}) ≈ (${er},${eg},${eb})`);
  return true;
}

expectColor(results.redFrame1Pixel, [255, 0, 0], 16, 'red frame 1 (bake-then-blit) centre');
expectColor(results.redFrame2Pixel, [255, 0, 0], 16, 'red frame 2 (cached blit) centre');

if (!results.redValid1) fail('red cache should be valid after frame 1');
else ok('red cache valid after frame 1');

if (!results.redValid2) fail('red cache still valid after frame 2');
else ok('red cache still valid after frame 2');

if (results.redBakeF1 === -1) fail('red lastBakeFrame should move off -1 after frame 1');
else ok('red lastBakeFrame moved off -1 after frame 1');

if (results.redBakeF2 !== results.redBakeF1)
  fail(`red re-baked on frame 2 (bake1=${results.redBakeF1} bake2=${results.redBakeF2})`);
else ok('red frame 2 reused the bake');

if (results.blueValidBeforeFirstDraw)
  fail('blue cache should NOT be valid before its first draw (even though red is)');
else ok('blue cache untouched while red drew');

if (results.blueBakeBeforeFirstDraw !== -1)
  fail(`blue lastBakeFrame should still be -1, got ${results.blueBakeBeforeFirstDraw}`);
else ok('blue lastBakeFrame still -1 while red drew');

expectColor(results.blueFrame1Pixel, [0, 0, 255], 16, 'blue frame 1 (bake-then-blit) centre');

if (!results.blueValid1) fail('blue cache should be valid after blue.draw()');
else ok('blue cache valid after its own first draw');

if (results.redValidAfterInvalidate)
  fail('red cache should be invalid after invalidate()');
else ok('red cache invalidated by invalidate()');

if (results.redGenAfterInvalidate !== results.redGen2 + 1)
  fail(`red generation should bump on invalidate (gen=${results.redGen2} → ${results.redGenAfterInvalidate})`);
else ok('red cache generation bumped on invalidate');

if (!results.blueValidAfterRedInvalid)
  fail('blue cache should STILL be valid after red.invalidate() — caches are per-handle');
else ok('blue cache survives red.invalidate() — caches are per-handle');

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nbundleHandleCacheSmoke: PASS');
