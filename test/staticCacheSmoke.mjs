// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// staticCacheSmoke — the static-scene caches bake, reuse and demote correctly, and a bake draws what a live render
// draws. Cases (one browser; each runs on its own fresh page, on mantleDemo.html unless noted):
//   staticCache        whole-asset and viewport-window bakes: valid, reused, live parity, pan, resize, scopes, budget
//   bundleHandleCache  per-handle cache state machines that do not affect each other
//   staticCacheDynamic a forced cache demotes for an override or geometry change, draws live, and rebakes
//   sharedGroupCache   handles in one instance group share, adopt and resize one target
//   staticCacheFilter  a whole-asset bake of a blurred node matches live, also after a translation
//   filterBakeCache    a whole-asset bake of an feDropShadow shape matches live (its own page)
//   cacheLbParity      a bake of an LB-routed bundle equals its direct draw
// Each case's own notes are above it.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openPageSuite, tally } from './_pageSuite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const T = tally();

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
async function staticCache(suite) {
  const { ok, fail } = T;
  // One simple SVG fixture — solid red square on white. Big enough
  // that AA edges don't dominate the center-pixel test.
  const SVG = readFileSync(
    new URL('../examples/smoke/staticCache__SVG.svg', import.meta.url),
    'utf8',
  );
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 300, height: 300 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
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
  await page.close();
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
}

// bundleHandleCache — smoke for the per-handle static-scene
// cache. Verifies two handles each maintain their own cache state
// (state machine, FBO, RT) and that one handle's cache invalidation
// doesn't affect the other's.
//
// Assertions:
//   1. createBundleHandle accepts opts.staticCache config.
//   2. handle.staticCache returns the per-handle state machine.
//   3. After first draw, each handle's cache becomes valid.
//   4. Second draw of each handle reuses its own bake (lastBakeFrame
//      stable).
//   5. Invalidating handle A's cache doesn't affect handle B's cache.
//   6. Pixels through the cached blit match the live render for each
//      handle's own bundle.
async function bundleHandleCache(suite) {
  const { ok, fail } = T;
  const SVG_RED = readFileSync(
    new URL('../examples/smoke/bundleHandleCache__SVG_RED.svg', import.meta.url),
    'utf8',
  );
  const SVG_BLUE = readFileSync(
    new URL('../examples/smoke/bundleHandleCache__SVG_BLUE.svg', import.meta.url),
    'utf8',
  );
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 200, height: 200 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
  const results = await page.evaluate(
    async (svgRed, svgBlue) => {
      const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');

      const bRed = createBundle(gl, await importSvg(svgRed));
      const bBlue = createBundle(gl, await importSvg(svgBlue));

      // Both handles opt into whole-asset caching via the staticCache opts arg.
      const hRed = renderer.createBundleHandle(bRed, {
        staticCache: { strategy: CacheStrategy.ForceWholeAsset },
      });
      const hBlue = renderer.createBundleHandle(bBlue, {
        staticCache: { strategy: CacheStrategy.ForceWholeAsset },
      });

      function snap() {
        const w = cnv.width,
          h = cnv.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const cIdx = ((h >> 1) * w + (w >> 1)) * 4;
        return [px[cIdx], px[cIdx + 1], px[cIdx + 2]];
      }

      const surface = {
        redCacheNonNull: !!hRed.staticCache,
        blueCacheNonNull: !!hBlue.staticCache,
        distinctMachines: hRed.staticCache !== hBlue.staticCache,
      };

      // Frame 1 of red: should bake-then-blit.
      renderer.beginFrame([1, 1, 1, 1]);
      hRed.draw();
      renderer.endFrame();
      const redFrame1Pixel = snap();
      const redValid1 = hRed.staticCache.isCacheValid;
      const redBakeF1 = hRed.staticCache.lastBakeFrame;
      const redGen1 = hRed.staticCache.cacheGeneration;

      // Frame 2 of red: should reuse the bake.
      renderer.beginFrame([1, 1, 1, 1]);
      hRed.draw();
      renderer.endFrame();
      const redFrame2Pixel = snap();
      const redValid2 = hRed.staticCache.isCacheValid;
      const redBakeF2 = hRed.staticCache.lastBakeFrame;
      const redGen2 = hRed.staticCache.cacheGeneration;

      // Frame 1 of blue: blue's cache is INDEPENDENT — should bake on
      // this draw (still at lastBakeFrame=-1 if untouched).
      const blueValidBeforeFirstDraw = hBlue.staticCache.isCacheValid;
      const blueBakeBeforeFirstDraw = hBlue.staticCache.lastBakeFrame;

      renderer.beginFrame([1, 1, 1, 1]);
      hBlue.draw();
      renderer.endFrame();
      const blueFrame1Pixel = snap();
      const blueValid1 = hBlue.staticCache.isCacheValid;
      const blueBakeF1 = hBlue.staticCache.lastBakeFrame;

      // Invalidate red's cache. Blue's cache should NOT be touched.
      hRed.invalidate();
      const redValidAfterInvalidate = hRed.staticCache.isCacheValid;
      const redGenAfterInvalidate = hRed.staticCache.cacheGeneration;
      const blueValidAfterRedInvalid = hBlue.staticCache.isCacheValid;
      const blueGenAfterRedInvalid = hBlue.staticCache.cacheGeneration;

      // Cleanup
      hRed.dispose();
      hBlue.dispose();
      bRed.dispose();
      bBlue.dispose();

      return {
        surface,
        redFrame1Pixel,
        redFrame2Pixel,
        redValid1,
        redValid2,
        redBakeF1,
        redBakeF2,
        redGen1,
        redGen2,
        blueValidBeforeFirstDraw,
        blueBakeBeforeFirstDraw,
        blueFrame1Pixel,
        blueValid1,
        blueBakeF1,
        redValidAfterInvalidate,
        redGenAfterInvalidate,
        blueValidAfterRedInvalid,
        blueGenAfterRedInvalid,
      };
    },
    SVG_RED,
    SVG_BLUE,
  );
  await page.close();
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

  expectColor(results.redFrame1Pixel, [255, 0, 0], 16, 'red frame 1 (bake-then-blit) center');
  expectColor(results.redFrame2Pixel, [255, 0, 0], 16, 'red frame 2 (cached blit) center');

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

  expectColor(results.blueFrame1Pixel, [0, 0, 255], 16, 'blue frame 1 (bake-then-blit) center');

  if (!results.blueValid1) fail('blue cache should be valid after blue.draw()');
  else ok('blue cache valid after its own first draw');

  if (results.redValidAfterInvalidate) fail('red cache should be invalid after invalidate()');
  else ok('red cache invalidated by invalidate()');

  if (results.redGenAfterInvalidate !== results.redGen2 + 1)
    fail(
      `red generation should bump on invalidate (gen=${results.redGen2} → ${results.redGenAfterInvalidate})`,
    );
  else ok('red cache generation bumped on invalidate');

  if (!results.blueValidAfterRedInvalid)
    fail('blue cache should STILL be valid after red.invalidate() — caches are per-handle');
  else ok('blue cache survives red.invalidate() — caches are per-handle');
}

// staticCacheDynamic — a forced static cache must still draw live
// while per-draw content changes. It must not show a stale bake for either an
// override-table update or a bundle geometry-generation update.
async function staticCacheDynamic(suite) {
  const SVG =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect id="box" x="10" y="10" width="80" height="80" fill="#f00"/></svg>';
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 160, height: 160 });
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
  const result = await page.evaluate(async (svg) => {
    const { importSvg, createBundle, createOverrideTable, CacheStrategy, CacheLevel } =
      await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const bundle = createBundle(gl, await importSvg(svg));
    // Await preparation so route adoption does not reset cache hysteresis mid-check.
    await renderer.awaitLbReady(bundle);
    let animatorActive = false,
      morphActive = false,
      requireHashEarlyOut = false;
    const handle = renderer.createBundleHandle(bundle, {
      staticCache: {
        strategy: CacheStrategy.ForceWholeAsset,
        isAnimatorActive: () => animatorActive,
        isMorphActive: () => morphActive,
      },
    });
    const overrides = createOverrideTable(gl, bundle);
    const revisionGetter = Object.getOwnPropertyDescriptor(overrides, 'revision').get;
    Object.defineProperty(overrides, 'revision', {
      get() {
        if (requireHashEarlyOut) throw new Error('live cache path hashed draw state');
        return revisionGetter.call(overrides);
      },
    });
    Object.defineProperty(overrides, 'unrelatedHost', {
      enumerable: true,
      get() {
        throw new Error('cache hash walked unrelated host state');
      },
    });
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const device = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const draw = (opts) => {
      renderer.beginFrame([1, 1, 1, 1]);
      handle.draw(opts);
      renderer.endFrame();
      const px = new Uint8Array(4);
      gl.readPixels(80, 80, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px];
    };

    // Uploading the initial pending writes changes generation, not their visual
    // content. A forced cache baked during that draw must remain a hit next frame.
    const uploadTable = createOverrideTable(gl, bundle);
    uploadTable.set('box', { fill: [0, 0, 1, 1] });
    const uploadHandle = renderer.createBundleHandle(bundle, {
      staticCache: { strategy: CacheStrategy.ForceWholeAsset },
    });
    const uploadDraw = () => {
      renderer.beginFrame([1, 1, 1, 1]);
      uploadHandle.draw({ overrides: uploadTable });
      renderer.endFrame();
      const px = new Uint8Array(4);
      gl.readPixels(80, 80, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px];
    };
    const initialUploadPixel = uploadDraw(),
      initialUploadCached = uploadHandle.staticCache.isCacheValid;
    const initialUploadGeneration = uploadHandle.staticCache.cacheGeneration;
    const nextUploadPixel = uploadDraw();
    const initialUploadStayedCached =
      uploadHandle.staticCache.isCacheValid &&
      uploadHandle.staticCache.cacheGeneration === initialUploadGeneration;
    uploadHandle.dispose();
    uploadTable.dispose();

    draw();
    const initiallyCached = handle.staticCache.isCacheValid;

    overrides.set('box', { fill: [0, 0, 1, 1] });
    const overrideLive = draw({ overrides });
    const overrideDemoted = {
      level: handle.staticCache.resolvedLevel,
      valid: handle.staticCache.isCacheValid,
    };
    // Allow bounded hysteresis before requiring a fresh cached raster.
    const drawUntilCached = (opts, maxFrames = 8) => {
      for (let i = 0; i < maxFrames; i++) {
        draw(opts);
        if (handle.staticCache.isCacheValid) return true;
      }
      return false;
    };
    const overrideRebaked = drawUntilCached({ overrides });

    const generationBeforeGeometry = handle.staticCache.cacheGeneration;
    // Simulate the generation bump a streamed/nine-slice geometry rewrite
    // publishes. The output stays blue so the test isolates cache freshness.
    bundle._geomGen = (bundle._geomGen | 0) + 1;
    const geometryLive = draw({ overrides });
    const geometryDemoted = {
      level: handle.staticCache.resolvedLevel,
      valid: handle.staticCache.isCacheValid,
      generation: handle.staticCache.cacheGeneration,
    };
    const geometryRebaked = drawUntilCached({ overrides }); // stable again → bake the new generation

    const earlyOuts = [];
    for (const mode of ['animator', 'morph', 'alwaysLive']) {
      animatorActive = mode === 'animator';
      morphActive = mode === 'morph';
      if (mode === 'alwaysLive') handle.staticCache.setStrategy(CacheStrategy.AlwaysLive);
      requireHashEarlyOut = true;
      overrides.set('box', { fill: [0, 1, 0, 1] });
      const live = draw({ overrides });
      const demoted =
        handle.staticCache.resolvedLevel === CacheLevel.None && !handle.staticCache.isCacheValid;
      requireHashEarlyOut = false;
      animatorActive = morphActive = false;
      if (mode === 'alwaysLive') handle.staticCache.setStrategy(CacheStrategy.ForceWholeAsset);
      const resumed = draw({ overrides });
      const heldLive = !handle.staticCache.isCacheValid;
      const rebaked = drawUntilCached({ overrides });
      const cached = draw({ overrides });
      earlyOuts.push({ mode, live, demoted, heldLive, rebaked, resumed, cached });
    }

    // A sub-1/8192 color change can cross a cached RGBA8 rounding boundary.
    const matrix = new Float32Array(16);
    matrix[15] = 1;
    const offset = new Float32Array([0.00587, 0, 0, 0]);
    const colorOptions = { colorMatrix: matrix, colorMatrixOffset: offset };
    drawUntilCached(colorOptions);
    const numericBefore = draw(colorOptions);
    offset[0] = 0.0059;
    const numericChanged = draw(colorOptions);
    const numericDemoted = !handle.staticCache.isCacheValid;
    handle.staticCache.invalidate();
    drawUntilCached(colorOptions);
    const numericReference = draw(colorOptions),
      numericGlError = gl.getError();

    const first = createOverrideTable(gl, bundle),
      second = createOverrideTable(gl, bundle);
    first.set('box', { fill: [0, 0, 1, 1] });
    second.set('box', { fill: [0, 1, 0, 1] });
    first.uploadIfDirty();
    second.uploadIfDirty();
    const equalCounters =
      first.generation === second.generation && first.revision === second.revision;
    drawUntilCached({ overrides: first });
    const swapped = draw({ overrides: second }),
      swapDemoted = !handle.staticCache.isCacheValid;
    const swapRebaked = drawUntilCached({ overrides: second });
    const packed = second.packedBuffer;
    packed[12] = 1;
    packed[13] = 0;
    packed[14] = 0;
    packed[15] = 1;
    second.markDirty();
    const directChanged = draw({ overrides: second }),
      directDemoted = !handle.staticCache.isCacheValid;
    const directRebaked = drawUntilCached({ overrides: second }),
      directCached = draw({ overrides: second });
    first.dispose();
    second.dispose();

    handle.dispose();
    bundle.dispose();
    overrides.dispose();
    return {
      device,
      initialUploadCached,
      initialUploadStayedCached,
      initialUploadPixel,
      nextUploadPixel,
      earlyOuts,
      equalCounters,
      swapped,
      swapDemoted,
      swapRebaked,
      directChanged,
      directDemoted,
      directRebaked,
      directCached,
      numericBefore,
      numericChanged,
      numericReference,
      numericDemoted,
      numericGlError,
      initiallyCached,
      overrideLive,
      overrideDemoted,
      overrideRebaked,
      generationBeforeGeometry,
      geometryLive,
      geometryDemoted,
      geometryRebaked,
      none: CacheLevel.None,
    };
  }, SVG);
  await page.close();
  const blue = (px) => px[2] > 220 && px[0] < 30 && px[1] < 30;
  const overrideLiveOk = blue(result.overrideLive);
  const geometryLiveOk = blue(result.geometryLive);
  const overrideDemoted =
    result.overrideDemoted.level === result.none && !result.overrideDemoted.valid;
  const geometryDemoted =
    result.geometryDemoted.level === result.none &&
    !result.geometryDemoted.valid &&
    result.geometryDemoted.generation > result.generationBeforeGeometry;
  const passed =
    result.initialUploadCached &&
    result.initialUploadStayedCached &&
    blue(result.initialUploadPixel) &&
    result.initialUploadPixel.every((v, i) => v === result.nextUploadPixel[i]) &&
    result.initiallyCached &&
    overrideLiveOk &&
    overrideDemoted &&
    result.overrideRebaked &&
    geometryLiveOk &&
    geometryDemoted &&
    result.geometryRebaked &&
    result.earlyOuts.every(
      (r) =>
        r.demoted &&
        r.heldLive &&
        r.rebaked &&
        r.live[1] > 220 &&
        r.live[0] < 30 &&
        r.live[2] < 30 &&
        r.live.every((v, i) => v === r.resumed[i] && v === r.cached[i]),
    ) &&
    result.equalCounters &&
    result.swapped[1] > 220 &&
    result.swapped[0] < 30 &&
    result.swapped[2] < 30 &&
    result.swapDemoted &&
    result.swapRebaked &&
    result.directChanged[0] > 220 &&
    result.directChanged[1] < 30 &&
    result.directDemoted &&
    result.directRebaked &&
    result.directChanged.every((v, i) => v === result.directCached[i]) &&
    result.numericDemoted &&
    !result.numericGlError &&
    result.numericBefore.some((v, i) => v !== result.numericReference[i]) &&
    result.numericChanged.every((v, i) => v === result.numericReference[i]);

  console.log(`  device=${result.device}`);
  console.log(
    `  override=${JSON.stringify(result.overrideLive)} geometry=${JSON.stringify(result.geometryLive)}`,
  );
  if (passed)
    T.ok(
      'a forced cache draws live through override, geometry, swap and numeric changes, and rebakes',
    );
  else T.fail(JSON.stringify(result));
}

// Shared-group cache smoke: handles of the same asset with a matching
// instanceGroupKey share one target. The first member bakes it and siblings
// adopt the result without re-baking.
// Assertions:
//   1. Both handles resolve to CacheLevel.SharedGroup.
//   2. Both handles' cache go valid, sharing ONE group RT (hA.cacheTex ===
//      hB.cacheTex, non-null).
//   3. The second handle finds the GROUP cache valid after the first baked it.
//   4. both handles render the asset's color (the adopting member must blit
//      the shared RT, not render blank) — the failure this guards.
async function sharedGroupCache(suite) {
  const { ok, fail } = T;
  const SVG_GREEN = readFileSync(
    new URL('../examples/smoke/sharedGroupCache__SVG_GREEN.svg', import.meta.url),
    'utf8',
  );
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 200, height: 200 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
  const results = await page.evaluate(async (svgGreen) => {
    const { importSvg, createBundle, CacheStrategy, CacheLevel } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');

    // Two handles of the same asset in one shared cache group.
    const bA = createBundle(gl, await importSvg(svgGreen));
    const bB = createBundle(gl, await importSvg(svgGreen));
    const grp = {
      staticCache: { strategy: CacheStrategy.ForceSharedGroup, instanceGroupKey: 'grp-x' },
    };
    const hA = renderer.createBundleHandle(bA, grp);
    const hB = renderer.createBundleHandle(bB, grp);

    function center() {
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const i = ((h >> 1) * w + (w >> 1)) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    }

    // Frame 1: draw A (owner) — bakes the group RT.
    renderer.beginFrame([1, 1, 1, 1]);
    hA.draw();
    renderer.endFrame();
    const aPixel = center();
    const aLevel = hA.staticCache.resolvedLevel;
    const aValid = hA.staticCache.isCacheValid;

    // Before B draws: the GROUP cache should already be valid (A baked it),
    // even though B's own cache hasn't been touched.
    const bGroupValidBeforeDraw = hB.staticCache.isGroupCacheValid();
    const bOwnValidBeforeDraw = hB.staticCache.isCacheValid;

    // Frame 2: draw B — should ADOPT A's bake and blit the shared RT.
    renderer.beginFrame([1, 1, 1, 1]);
    hB.draw();
    renderer.endFrame();
    const bPixel = center();
    const bLevel = hB.staticCache.resolvedLevel;
    const bValid = hB.staticCache.isCacheValid;

    const sharedRt = !!hA.cacheTex && hA.cacheTex === hB.cacheTex;

    // Resize the backing store. The first member rebuilds and bakes the group
    // target; the stale sibling must adopt it rather than invalidate it or blit
    // the retired target.
    const oldRt = hB.cacheTex;
    cnv.width = 160;
    cnv.height = 120;
    renderer.beginFrame([1, 1, 1, 1]);
    hB.draw();
    renderer.endFrame();
    const resizedBPixel = center();
    const resizedRt = hB.cacheTex;
    renderer.beginFrame([1, 1, 1, 1]);
    hA.draw();
    renderer.endFrame();
    const resizedAPixel = center();
    const sharedAfterResize = !!resizedRt && hA.cacheTex === resizedRt;
    const targetReallocated = !!resizedRt && resizedRt !== oldRt;

    hA.dispose();
    hB.dispose();
    bA.dispose();
    bB.dispose();
    return {
      aPixel,
      aLevel,
      aValid,
      bGroupValidBeforeDraw,
      bOwnValidBeforeDraw,
      bPixel,
      bLevel,
      bValid,
      sharedRt,
      resizedBPixel,
      resizedAPixel,
      sharedAfterResize,
      targetReallocated,
      SharedGroup: CacheLevel.SharedGroup,
    };
  }, SVG_GREEN);
  await page.close();
  // ---- Assertions ----
  const r = results;
  const near = (a, e, t = 24) =>
    Math.abs(a[0] - e[0]) <= t && Math.abs(a[1] - e[1]) <= t && Math.abs(a[2] - e[2]) <= t;
  const GREEN = [0, 200, 0];

  if (r.aLevel === r.SharedGroup) ok('owner resolves to SharedGroup');
  else fail(`owner level ${r.aLevel} != SharedGroup (${r.SharedGroup})`);
  if (r.bLevel === r.SharedGroup) ok('member resolves to SharedGroup');
  else fail(`member level ${r.bLevel} != SharedGroup`);
  if (near(r.aPixel, GREEN)) ok(`owner A renders green ${JSON.stringify(r.aPixel)}`);
  else fail(`A pixel ${JSON.stringify(r.aPixel)} not green`);
  if (r.aValid) ok('A cache valid after bake');
  else fail('A cache should be valid after its bake');
  if (r.bGroupValidBeforeDraw && !r.bOwnValidBeforeDraw)
    ok('B sees the GROUP cache valid (A baked) before its own draw');
  else
    fail(
      `B group-valid=${r.bGroupValidBeforeDraw} own-valid=${r.bOwnValidBeforeDraw} before draw (want group-valid, own-invalid)`,
    );
  if (near(r.bPixel, GREEN))
    ok(`member B renders green via shared-RT blit ${JSON.stringify(r.bPixel)}`);
  else
    fail(
      `B pixel ${JSON.stringify(r.bPixel)} not green — adopting member rendered blank (bake-once/blit-twice broken)`,
    );
  if (r.sharedRt) ok('both members share one cache target');
  else fail('members did not share the cache target');
  if (r.targetReallocated) ok('resize reallocates the shared target');
  else fail('resize kept the old shared target');
  if (near(r.resizedBPixel, GREEN) && near(r.resizedAPixel, GREEN))
    ok('both members render from the resized shared target');
  else
    fail(
      `resized pixels B=${JSON.stringify(r.resizedBPixel)} A=${JSON.stringify(r.resizedAPixel)}`,
    );
  if (r.sharedAfterResize) ok('stale sibling adopts the resized target');
  else fail('sibling did not adopt resized target');
}

// A node using the whole-asset cache whose SVG carries a filter
// (here feGaussianBlur, which exercises the filter region's offscreen RT +
// composite) must bake correctly. Composites must target the cache FBO
// during a bake, not the canvas — otherwise the blit comes back blank/wrong.
// Asserts RMSE(live, cached) stays low.
async function staticCacheFilter(suite) {
  const BLUR = readFileSync(
    new URL('../examples/smoke/staticCacheFilter__BLUR.svg', import.meta.url),
    'utf8',
  );
  const pg = await suite.page({ logs: false });
  await pg.setViewport({ width: 300, height: 300 });
  pg.on('pageerror', (e) => console.error('[page]', e.message));
  await suite.visit(pg, '/mantleDemo.html', { ready: 'renderer' });
  const out = await pg.evaluate(async (BLUR) => {
    const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
    const gl = window.__mantleGl,
      r = window.__mantleRenderer,
      cnv = document.getElementById('glcanvas');
    cnv.width = 300;
    cnv.height = 300;
    r.setViewport(300, 300);
    const grab = () => {
      const px = new Uint8Array(cnv.width * cnv.height * 4);
      gl.readPixels(0, 0, cnv.width, cnv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    let nonbg = 0;
    const b = createBundle(gl, await importSvg(BLUR));
    const liveHandle = r.createBundleHandle(b);
    const cachedHandle = r.createBundleHandle(b, {
      staticCache: { strategy: CacheStrategy.ForceWholeAsset },
    });
    // Card-sized, fully on-screen source and destination: the cache must
    // translate the already-filtered raster without losing or double-shifting it.
    const initial = new Float32Array([0.45, 0, 0, 0, 0.45, 0, -0.25, 0, 1]);
    const moved = new Float32Array([0.45, 0, 0, 0, 0.45, 0, 0.25, 0, 1]);
    const draw = (handle, worldMatrix) => {
      r.beginFrame([1, 1, 1, 1]);
      handle.draw({ worldMatrix });
      r.endFrame();
      return grab();
    };
    const live = draw(liveHandle, initial);
    const cached = draw(cachedHandle, initial);
    const cachedMoved = draw(cachedHandle, moved);
    const liveMoved = draw(liveHandle, moved);
    let se = 0;
    for (let i = 0; i < live.length; i++) se += (live[i] - cached[i]) ** 2;
    let movedSe = 0;
    for (let i = 0; i < liveMoved.length; i++) movedSe += (liveMoved[i] - cachedMoved[i]) ** 2;
    for (let i = 0; i < live.length; i += 4)
      if (live[i] > 50 || live[i + 1] > 50 || live[i + 2] > 50) nonbg++;
    const redBounds = (px) => {
      let x0 = 300,
        y0 = 300,
        x1 = -1,
        y1 = -1,
        count = 0;
      for (let y = 0; y < 300; y++)
        for (let x = 0; x < 300; x++) {
          const i = (y * 300 + x) * 4;
          if (px[i] > 200 && px[i + 1] < 100 && px[i + 2] < 50) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
            count++;
          }
        }
      return [x0, y0, x1, y1, count];
    };
    return {
      rmse: Math.sqrt(se / live.length),
      movedRmse: Math.sqrt(movedSe / liveMoved.length),
      liveNonBg: nonbg,
      px: live.length / 4,
      cacheValid: cachedHandle.staticCache?.isCacheValid,
      liveMovedRed: redBounds(liveMoved),
      cachedMovedRed: redBounds(cachedMoved),
    };
  }, BLUR);
  await pg.close();
  console.log(
    `  live non-bg px=${out.liveNonBg}; RMSE(initial)=${out.rmse.toFixed(2)}; RMSE(translated)=${out.movedRmse.toFixed(2)}; red=${JSON.stringify(out.liveMovedRed)}/${JSON.stringify(out.cachedMovedRed)}`,
  );
  const [lx0, ly0, lx1, ly1, ln] = out.liveMovedRed;
  const [cx0, cy0, cx1, cy1, cn] = out.cachedMovedRed;
  const aligned =
    Math.abs(lx0 - cx0) <= 2 &&
    Math.abs(ly0 - cy0) <= 2 &&
    Math.abs(lx1 - cx1) <= 2 &&
    Math.abs(ly1 - cy1) <= 2;
  const ok =
    out.liveNonBg > 1000 && out.cacheValid && out.rmse < 6 && ln > 1000 && cn > 1000 && aligned;
  if (ok) T.ok('the cached blur matches live, also after a translation');
  else T.fail('filtered cache diverged after translation');
}

// Whole-asset cache bake of a FILTERED shape (feDropShadow) must match the live
// render. A "canvas" composite/backdrop bind in the filter pipeline that
// hard-binds the DEFAULT framebuffer would, during a bake, composite the
// filtered result to the real canvas and leave the bake RT blank — the
// "static-scene cache blanks filtered shapes" class.
//
// Full-buffer comparison, not spot pixels: the shadow spreads coverage.
async function filterBakeCache(suite) {
  const SVG = readFileSync(
    new URL('../examples/smoke/filterBakeCache__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body><canvas id="glcanvas" width="240" height="240"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('glcanvas').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__mantleGl = gl;
window.__mantleRenderer = createRenderer(gl, shaders);
window.__mantleRenderer.setViewport(240, 240);
</script></body></html>`;
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await suite.goto(page, HTML, { ready: 'renderer' });
  const result = await page.evaluate(async (svg) => {
    const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const bundle = createBundle(gl, await importSvg(svg));
    renderer.setBundle(bundle);
    const read = () => {
      const px = new Uint8Array(240 * 240 * 4);
      gl.readPixels(0, 0, 240, 240, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    renderer.render();
    const live = read();

    // TWO instances of the same filtered svg drawn in one frame (the Speed
    // Match card pattern: current + next card side by side) — both must render.
    const bundle2 = createBundle(gl, await importSvg(svg));
    const wmL = new Float32Array([0.5, 0, 0, 0, 0.5, 0, -0.5, 0, 1]);
    const wmR = new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.5, 0, 1]);
    renderer.beginFrame([1, 1, 1, 1]);
    renderer.drawBundle(bundle, { worldMatrix: wmL });
    renderer.drawBundle(bundle2, { worldMatrix: wmR });
    renderer.endFrame();
    const pair = read();
    const inkIn = (px, x0, x1) => {
      let n = 0;
      for (let y = 0; y < 240; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * 240 + x) * 4;
          if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++;
        }
      return n;
    };
    const pairInk = { left: inkIn(pair, 0, 120), right: inkIn(pair, 120, 240) };

    renderer.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
    renderer.render(); // bake + blit
    const cache = renderer.staticCache;
    const baked = read();
    renderer.render(); // reuse path
    const reused = read();

    const diff = (a, b) => {
      let n = 0,
        mx = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]),
        );
        if (d > 24) n++;
        if (d > mx) mx = d;
      }
      return { n, mx };
    };
    // ink check: the card + shadow must exist in the baked frame at all
    let ink = 0;
    for (let i = 0; i < baked.length; i += 4)
      if (baked[i] < 250 || baked[i + 1] < 250 || baked[i + 2] < 250) ink++;
    return {
      valid: cache && cache.isCacheValid,
      liveVsBaked: diff(live, baked),
      bakedVsReused: diff(baked, reused),
      bakedInk: ink,
      pairInk,
    };
  }, SVG);
  await page.close();
  console.log('  result:', JSON.stringify(result));
  let ok = true;
  const fail = (m) => {
    ok = false;
    T.fail(m);
  };
  if (!result.valid) fail('cache did not become valid');
  if (result.bakedInk < 2000)
    fail(
      `baked frame nearly blank (ink ${result.bakedInk}) — the filtered shape vanished from the bake`,
    );
  if (result.liveVsBaked.n > 500)
    fail(`baked diverges from live by ${result.liveVsBaked.n}px (max ${result.liveVsBaked.mx})`);
  if (result.bakedVsReused.n > 50)
    fail(`reuse pass diverges from bake by ${result.bakedVsReused.n}px`);
  if (!result.pairInk || result.pairInk.left < 1000)
    fail(`LEFT filtered instance blank (ink ${result.pairInk && result.pairInk.left})`);
  if (!result.pairInk || result.pairInk.right < 1000)
    fail(`RIGHT filtered instance blank (ink ${result.pairInk && result.pairInk.right})`);
  if (ok) T.ok('the bake of a filtered shape matches live and reuse');
}

// cacheLbParity — a CACHED bake of an LB-routed bundle must be
// pixel-identical to that bundle's DIRECT (uncached) draw.
//
// The bundleHandleCache case only compares Slug-to-Slug: its bundles are tiny
// rects, which never take the analytic (Loop-Blinn) route. Big curved content
// DOES route to LB, and LB draws into whatever framebuffer is bound — so a bake
// has to reproduce it exactly. A baked RT that keeps LB's interior triangles
// but LOSES the curve-bulge triangles leaves the fill missing in a band ALONG
// each curve (a wavy ridge bakes with the region between its chord and its
// curved top left unpainted, showing whatever is behind it).
//
// Shape: two overlapping wavy "hills" (a teal one behind, a green one in
// front) — exactly the parallax-background content that surfaced this. If the
// front hill's curve band is dropped, the teal behind shows through and the
// diff explodes.
async function cacheLbParity(suite) {
  const { ok, fail } = T;
  // Two big wavy ridges. Deep cubic bulges so the curve-band triangles cover a
  // lot of pixels — a dropped band is then unmissable rather than a hairline.
  const SVG = readFileSync(
    new URL('../examples/smoke/cacheLbParity__SVG.svg', import.meta.url),
    'utf8',
  );
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
  const results = await page.evaluate(async (svg) => {
    const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    // Asks for LB EXPLICITLY. This smoke is about the LB machinery, not about
    // whether 'auto' would choose it, and keeping the two apart means a future
    // routing change cannot silently make it vacuous.
    renderer.setLoopBlinnFill('on');
    const cnv = document.getElementById('glcanvas');
    cnv.width = 400;
    cnv.height = 400;

    const shot = () => {
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    const asset = await importSvg(svg);

    // DIRECT: no cache. This is the reference — what the user sees today.
    const bDirect = createBundle(gl, asset);
    const hDirect = renderer.createBundleHandle(bDirect);
    await renderer.awaitLbReady(bDirect);
    const lbRouted = Array.isArray(bDirect._lbMeshes) && bDirect._lbMeshes.length > 0;
    renderer.beginFrame([1, 1, 1, 1]);
    hDirect.draw();
    renderer.endFrame();
    const direct = shot();

    // CACHED: same content, forced through a bake + blit.
    const bCached = createBundle(gl, asset);
    const hCached = renderer.createBundleHandle(bCached, {
      staticCache: { strategy: CacheStrategy.ForceWholeAsset },
    });
    await renderer.awaitLbReady(bCached);
    renderer.beginFrame([1, 1, 1, 1]);
    hCached.draw(); // bake + blit
    renderer.endFrame();
    renderer.beginFrame([1, 1, 1, 1]);
    hCached.draw(); // blit the reused bake
    renderer.endFrame();
    const cached = shot();

    // Count pixels that differ materially. An LB curve band dropped from the
    // bake shows up as thousands of px, not as AA noise on a few hundred.
    let diff = 0,
      worst = 0;
    for (let i = 0; i < direct.length; i += 4) {
      const d = Math.max(
        Math.abs(direct[i] - cached[i]),
        Math.abs(direct[i + 1] - cached[i + 1]),
        Math.abs(direct[i + 2] - cached[i + 2]),
      );
      if (d > 16) diff++;
      if (d > worst) worst = d;
    }

    hDirect.dispose();
    hCached.dispose();
    bDirect.dispose();
    bCached.dispose();
    return { lbRouted, diff, worst, total: direct.length / 4 };
  }, SVG);
  await page.close();
  console.log(
    `  lbRouted=${results.lbRouted} diff=${results.diff}/${results.total}px worst=${results.worst}`,
  );

  if (!results.lbRouted)
    fail('bundle did NOT route to LB — this smoke is not exercising the LB bake path');
  else ok('bundle routes to LB');

  // AA/rounding between a bake+blit and a direct draw can legitimately differ on
  // a handful of edge pixels; a dropped curve band cannot hide in that budget.
  if (results.diff > 400)
    fail(
      `cached bake differs from direct draw on ${results.diff}px (curve-band fill lost in the bake?)`,
    );
  else ok(`cached bake matches direct draw (${results.diff}px differ)`);
}

const suite = await openPageSuite({ root: ROOT });
try {
  await T.run(
    [
      ['staticCache', staticCache],
      ['bundleHandleCache', bundleHandleCache],
      ['staticCacheDynamic', staticCacheDynamic],
      ['sharedGroupCache', sharedGroupCache],
      ['staticCacheFilter', staticCacheFilter],
      ['filterBakeCache', filterBakeCache],
      ['cacheLbParity', cacheLbParity],
    ],
    suite,
  );
} finally {
  await suite.close();
}
if (T.failures()) {
  console.error(`\n${T.failures()} assertions failed`);
  process.exit(1);
}
console.log('\nstaticCacheSmoke: PASS');
