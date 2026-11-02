// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// End-to-end proof of the whole-asset and viewport-window caches.
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
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

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
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

// One simple SVG fixture — solid red square on white. Big enough
// that AA edges don't dominate the center-pixel test.
const SVG = readFileSync(
  new URL('../examples/smoke/staticCache__SVG.svg', import.meta.url),
  'utf8',
);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 300, height: 300 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});
await openReady(page, url, { ready: 'renderer' });

const result = await page.evaluate(async (svg) => {
  const { importSvg, createBundle, createStaticCache, CacheStrategy, CacheLevel, CacheReason } =
    await import('/src/index.js');
  const { borrowSharedGroupTarget } = await import('/src/renderer/staticCache.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  const bundle = createBundle(gl, await importSvg(svg));
  renderer.setBundle(bundle);

  const unsupportedWindow = createStaticCache({ strategy: CacheStrategy.ForceViewportWindow });
  unsupportedWindow.tick({ viewportWindowCompatible: false });
  const unsupportedExternalClip = createStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
  unsupportedExternalClip.tick({ cacheCompatible: false });

  // Equal user keys share only inside the same renderer/context scope.
  const scopeA = {},
    scopeB = {};
  let releasedTargets = 0;
  const sharedOpts = (scope) => ({
    strategy: CacheStrategy.ForceSharedGroup,
    instanceGroupKey: 'same-key',
    groupScope: scope,
    releaseSharedTarget: () => {
      releasedTargets++;
    },
  });
  const scopedA = createStaticCache(sharedOpts(scopeA));
  const scopedAPeer = createStaticCache(sharedOpts(scopeA));
  const scopedB = createStaticCache(sharedOpts(scopeB));
  const allocFake = (w, h) => ({ tex: {}, fbo: {}, rb: {}, rtW: w, rtH: h });
  const targetA = borrowSharedGroupTarget('same-key', scopedA._cacheState, 64, 64, allocFake);
  const targetAPeer = borrowSharedGroupTarget(
    'same-key',
    scopedAPeer._cacheState,
    64,
    64,
    allocFake,
  );
  const targetB = borrowSharedGroupTarget('same-key', scopedB._cacheState, 64, 64, allocFake);
  scopedA.markBaked(1);
  const sameScopeShares = targetA.tex === targetAPeer.tex && scopedAPeer.isGroupCacheValid();
  const crossScopeIsolated = targetA.tex !== targetB.tex && !scopedB.isGroupCacheValid();
  scopedA.dispose();
  scopedAPeer.dispose();
  scopedB.dispose();
  const scopedTargetsReleased = releasedTargets === 2;

  // Disposed automatic caches return their global promotion-budget slot.
  // The inputs must first clear Auto's live-cost heuristic (high coverage +
  // enough live complexity), or every cache resolves to LiveCheaper and the
  // budget is never exercised.
  const fit = {
    hasAsset: true,
    animatorActive: false,
    morphActive: false,
    footprintW: 180,
    footprintH: 180,
    viewportW: 200,
    viewportH: 200,
    liveComplexity: 512,
  };
  const budgetCaches = Array.from({ length: 7 }, () =>
    createStaticCache({
      autoBudgeted: true,
      stabilityPromoteFrames: 1,
    }),
  );
  for (const c of budgetCaches) c.tick(fit);
  const budgetInitiallyFull =
    budgetCaches.slice(0, 6).every((c) => c.resolvedLevel === CacheLevel.WholeAsset) &&
    budgetCaches[6].resolvedLevel === CacheLevel.None;
  budgetCaches[0].dispose();
  budgetCaches[6].tick(fit);
  const budgetSlotReused = budgetCaches[6].resolvedLevel === CacheLevel.WholeAsset;
  for (const c of budgetCaches) c.dispose();

  function snapshot() {
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Sample three pixels: center (red rect interior), corner
    // (white background), edge of the red rect (transition).
    const ix = (x, y) => (y * w + x) * 4;
    const cIdx = ix(w >> 1, h >> 1);
    const wIdx = ix(5, 5);
    const lIdx = ix(Math.round(w * 0.22), h >> 1);
    const rIdx = ix(Math.round(w * 0.28), h >> 1);
    return {
      w,
      h,
      center: [px[cIdx], px[cIdx + 1], px[cIdx + 2], px[cIdx + 3]],
      corner: [px[wIdx], px[wIdx + 1], px[wIdx + 2], px[wIdx + 3]],
      left: [px[lIdx], px[lIdx + 1], px[lIdx + 2], px[lIdx + 3]],
      right: [px[rIdx], px[rIdx + 1], px[rIdx + 2], px[rIdx + 3]],
    };
  }

  // ---- Live render baseline -------------------------------------
  renderer.render();
  const live = snapshot();

  // ---- Whole-asset cache (bypass stability hysteresis) ----------
  renderer.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });

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

  // ---- Viewport window: larger target + translation reuse -------
  renderer.enableStaticCache({
    strategy: CacheStrategy.ForceViewportWindow,
    viewportWindowMarginPixels: 64,
  });
  renderer.render();
  const windowInitial = snapshot();
  const windowLevel = renderer.staticCache.resolvedLevel;
  const windowValid = renderer.staticCache.isCacheValid;
  const windowBake1 = renderer.staticCache.lastBakeFrame;

  const pan = new Float32Array([1, 0, 0, 0, 1, 0, 0.1, 0, 1]);
  // Framed: a bare drawBundle composes over what is there, the frame owns the clear.
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(bundle, { worldMatrix: pan });
  renderer.endFrame();
  const windowPan = snapshot();
  const windowBake2 = renderer.staticCache.lastBakeFrame;

  renderer.disableStaticCache();
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(bundle, { worldMatrix: pan });
  renderer.endFrame();
  const livePan = snapshot();

  // ---- Whole-asset resize invalidation --------------------------
  renderer.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
  renderer.render();
  const resizeBake1 = renderer.staticCache.lastBakeFrame;
  cnv.width = 240;
  cnv.height = 180;
  renderer.render();
  const resizedCached = snapshot();
  const resizeBake2 = renderer.staticCache.lastBakeFrame;
  const resizedValid = renderer.staticCache.isCacheValid;
  renderer.disableStaticCache();
  renderer.render();
  const resizedLive = snapshot();

  return {
    live,
    after1,
    after2,
    live2,
    valid1,
    valid2,
    level1,
    bakeFrame1,
    bakeFrame2,
    gen1,
    gen2,
    WholeAsset: CacheLevel.WholeAsset,
    windowInitial,
    windowPan,
    livePan,
    windowLevel,
    windowValid,
    windowBake1,
    windowBake2,
    ViewportWindow: CacheLevel.ViewportWindow,
    resizeBake1,
    resizeBake2,
    resizedCached,
    resizedLive,
    resizedValid,
    unsupportedWindowLevel: unsupportedWindow.resolvedLevel,
    unsupportedWindowReason: unsupportedWindow.resolvedReason,
    unsupportedClipLevel: unsupportedExternalClip.resolvedLevel,
    unsupportedClipReason: unsupportedExternalClip.resolvedReason,
    None: CacheLevel.None,
    UnsupportedFeatures: CacheReason.UnsupportedFeatures,
    sameScopeShares,
    crossScopeIsolated,
    scopedTargetsReleased,
    budgetInitiallyFull,
    budgetSlotReused,
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

if (result.level1 !== result.WholeAsset) {
  fail(`ForceWholeAsset should resolve to WholeAsset, got ${result.level1}`);
} else {
  ok('ForceWholeAsset resolves to WholeAsset');
}

if (
  result.unsupportedWindowLevel !== result.None ||
  result.unsupportedWindowReason !== result.UnsupportedFeatures ||
  result.unsupportedClipLevel !== result.None ||
  result.unsupportedClipReason !== result.UnsupportedFeatures
) {
  fail('unsupported cache dependencies must resolve to live rendering');
} else {
  ok('unsupported cache dependencies resolve to live rendering');
}

if (result.sameScopeShares && result.crossScopeIsolated && result.scopedTargetsReleased) {
  ok('shared targets are context-scoped and released exactly once');
} else {
  fail(
    `shared-target scope/release failed: ${JSON.stringify({
      sameScopeShares: result.sameScopeShares,
      crossScopeIsolated: result.crossScopeIsolated,
      scopedTargetsReleased: result.scopedTargetsReleased,
    })}`,
  );
}

if (result.budgetInitiallyFull && result.budgetSlotReused) {
  ok('automatic cache budget slot returns on dispose');
} else {
  fail(
    `automatic cache budget lifetime failed: ${JSON.stringify({
      budgetInitiallyFull: result.budgetInitiallyFull,
      budgetSlotReused: result.budgetSlotReused,
    })}`,
  );
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
  fail(
    `generation should not change between frame 1 and frame 2 (${result.gen1} → ${result.gen2})`,
  );
} else {
  ok('cache generation stable across frames');
}

// Pixel parity: cached blit should match live render within bilinear-sample tolerance.
near(result.live.center, result.after1.center, 16, 'frame 1 center vs live');
near(result.live.corner, result.after1.corner, 16, 'frame 1 corner vs live');
near(result.live.center, result.after2.center, 16, 'frame 2 center vs live');
near(result.live.corner, result.after2.corner, 16, 'frame 2 corner vs live');
ok('cached pixels match live render within tolerance');

// After disable, must still produce correct pixels.
near(result.live.center, result.live2.center, 4, 'disabled center vs live');
near(result.live.corner, result.live2.corner, 4, 'disabled corner vs live');
ok('disableStaticCache returns to live render');

if (result.windowLevel !== result.ViewportWindow) {
  fail(`ForceViewportWindow should resolve to ViewportWindow, got ${result.windowLevel}`);
} else {
  ok('ForceViewportWindow resolves to ViewportWindow');
}
if (!result.windowValid) fail('viewport-window cache should be valid after its first bake');
else ok('viewport-window cache valid after first bake');
if (result.windowBake2 !== result.windowBake1) {
  fail(`in-margin viewport-window pan re-baked (${result.windowBake1} -> ${result.windowBake2})`);
} else {
  ok('in-margin viewport-window pan reused the bake');
}
for (const key of ['center', 'corner', 'left', 'right']) {
  near(result.live[key], result.windowInitial[key], 16, `window initial ${key} vs live`);
  near(result.livePan[key], result.windowPan[key], 16, `window pan ${key} vs live`);
}
ok('viewport-window initial and panned pixels match live rendering');

if (!(result.resizeBake2 > result.resizeBake1)) {
  fail(`whole-asset resize did not re-bake (${result.resizeBake1} -> ${result.resizeBake2})`);
} else {
  ok('whole-asset resize invalidates and re-bakes');
}
if (!result.resizedValid) fail('whole-asset cache invalid after resize');
for (const key of ['center', 'corner', 'left', 'right'])
  near(result.resizedLive[key], result.resizedCached[key], 16, `resized ${key} vs live`);
ok('resized whole-asset pixels match live rendering');

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nstaticCacheSmoke: PASS');
