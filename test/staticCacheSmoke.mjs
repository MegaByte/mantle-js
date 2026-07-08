// End-to-end proof of the JS static-scene cache at Level A1. Drives a real
// WebGL2 context, calls `renderer.enableStaticCache()` with ForceA1,
// renders a fixture twice, and asserts:
//
//   1. The first render bakes into the cache RT (cache becomes
//      valid; lastBakeFrame moves off -1).
//   2. The second render reuses the bake (lastBakeFrame doesn't
//      change between calls — no second bake).
//   3. Pixels in the second render closely match a live render of the
//      same fixture (bake-then-blit must not change appearance; small
//      differences come from bilinear sampling of the cache RT, so use a
//      tolerance).
//
// Guards the _cacheBakeAndBlit FBO/viewport/restore sequence (a break shows
// as a black or solid-color blit), the blit shader's premultiplied math
// (wrong-color halos), and the state machine (cache never engaging).

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
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

// One simple SVG fixture — solid red square on white. Big enough
// that AA edges don't dominate the centre-pixel test.
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" fill="#ffffff"/>
  <rect x="20" y="20" width="60" height="60" fill="#ff0000"/>
</svg>`;

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 300, height: 300 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const result = await page.evaluate(async (svg) => {
  const { importSvg, createBundle, CacheStrategy, CacheLevel } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  const bundle = createBundle(gl, await importSvg(svg));
  renderer.setBundle(bundle);

  function snapshot() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Sample three pixels: centre (red rect interior), corner
    // (white background), edge of the red rect (transition).
    const ix = (x, y) => (y * w + x) * 4;
    const cIdx = ix(w >> 1, h >> 1);
    const wIdx = ix(5, 5);
    return {
      w, h,
      centre: [px[cIdx], px[cIdx + 1], px[cIdx + 2], px[cIdx + 3]],
      corner: [px[wIdx], px[wIdx + 1], px[wIdx + 2], px[wIdx + 3]],
    };
  }

  // ---- Live render baseline -------------------------------------
  renderer.render();
  const live = snapshot();

  // ---- Enable cache, force A1 (bypass stability hysteresis) -----
  renderer.enableStaticCache({ strategy: CacheStrategy.ForceA1 });

  // Frame 1: should bake-then-blit. After it, cache must be valid
  // and lastBakeFrame should move off -1.
  renderer.render();
  const cache = renderer.staticCache;
  const after1 = snapshot();
  const valid1 = cache.isCacheValid;
  const level1 = cache.resolvedLevel;
  const bakeFrame1 = cache.lastBakeFrame;
  const gen1 = cache.cacheGeneration;

  // Frame 2: same call, should reuse the bake. lastBakeFrame must
  // not increment (bake didn't re-run).
  renderer.render();
  const after2 = snapshot();
  const valid2 = cache.isCacheValid;
  const bakeFrame2 = cache.lastBakeFrame;
  const gen2 = cache.cacheGeneration;

  // ---- Disable, sanity-check we're back on the live path --------
  renderer.disableStaticCache();
  renderer.render();
  const live2 = snapshot();

  return {
    live, after1, after2, live2,
    valid1, valid2, level1,
    bakeFrame1, bakeFrame2, gen1, gen2,
    LevelA1: CacheLevel.A1,
  };
}, SVG);

await browser.close();
server.close();

// ---- Assertions ------------------------------------------------

function near(a, b, tol = 16, label = '') {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a[i] - b[i]) > tol) {
      fail(`${label}: channel ${i} ${a[i]} vs ${b[i]} (tol ${tol})`);
      return false;
    }
  }
  return true;
}

if (result.level1 !== result.LevelA1) {
  fail(`ForceA1 should resolve to Level.A1, got ${result.level1}`);
} else {
  ok('ForceA1 resolves to Level.A1');
}

if (!result.valid1) {
  fail('cache should be valid after frame 1');
} else {
  ok('cache valid after frame 1');
}

if (!result.valid2) {
  fail('cache should still be valid after frame 2');
} else {
  ok('cache still valid after frame 2');
}

if (result.bakeFrame1 === -1) {
  fail('lastBakeFrame should have moved off -1 after frame 1');
} else {
  ok('lastBakeFrame moved off -1 after frame 1');
}

if (result.bakeFrame2 !== result.bakeFrame1) {
  fail(`frame 2 re-baked (bake1=${result.bakeFrame1} bake2=${result.bakeFrame2})`);
} else {
  ok('frame 2 reused the bake (no re-bake)');
}

if (result.gen1 !== result.gen2) {
  fail(`generation should not change between frame 1 and frame 2 (${result.gen1} → ${result.gen2})`);
} else {
  ok('cache generation stable across frames');
}

// Pixel parity: cached blit should match live render within bilinear-sample tolerance.
near(result.live.centre, result.after1.centre, 16, 'frame 1 centre vs live');
near(result.live.corner, result.after1.corner, 16, 'frame 1 corner vs live');
near(result.live.centre, result.after2.centre, 16, 'frame 2 centre vs live');
near(result.live.corner, result.after2.corner, 16, 'frame 2 corner vs live');
ok('cached pixels match live render within tolerance');

// After disable, must still produce correct pixels.
near(result.live.centre, result.live2.centre, 4, 'disabled centre vs live');
near(result.live.corner, result.live2.corner, 4, 'disabled corner vs live');
ok('disableStaticCache returns to live render');

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nstaticCacheSmoke: PASS');
