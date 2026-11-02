// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// staticCacheDynamicSmoke.mjs — a forced static cache must still draw live
// while per-draw content changes. It must not show a stale bake for either an
// override-table update or a bundle geometry-generation update.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect id="box" x="10" y="10" width="80" height="80" fill="#f00"/></svg>';

const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript; charset=utf-8'
      : p.endsWith('.glsl')
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const file = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    const body = readFileSync(path.join(ROOT, file));
    res.writeHead(200, { 'content-type': mime(file) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 160, height: 160 });
await page.goto(`http://127.0.0.1:${server.address().port}/mantleDemo.html`, {
  waitUntil: 'load',
  timeout: 10000,
});
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 10000,
  polling: 100,
});

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

await browser.close();
server.close();

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
console.log(
  passed
    ? 'staticCacheDynamicSmoke: PASS'
    : `staticCacheDynamicSmoke: FAIL ${JSON.stringify(result)}`,
);
process.exit(passed ? 0 : 1);
