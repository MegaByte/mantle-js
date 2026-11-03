// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleHandleSmoke — two persistent bundle handles drawn in one frame do not bleed into each
// other:
//   bundleHandle             each handle's mesh stays in its own VBO, no re-upload on switch
//   bundleHandleDimensions   handles of different aspect ratios keep their own projection
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// bundleHandle — smoke for the public createBundleHandle
// API. Verifies that two persistent handles holding distinct bundles
// render correctly in the same frame: each handle's mesh stays
// resident in its own VBO across frames, no re-upload on switch, no
// cross-interference.
//
// Assertions:
//   1. Each handle's draw() produces its own bundle's pixels at its
//      own world transform.
//   2. Drawing handle A → B → A → B in one frame produces the same
//      pixels as drawing B alone (because B is drawn last and covers
//      the canvas center).
//   3. Drawing handle A → B in one frame produces both contributions
//      (different world matrices place them in non-overlapping rects).
//   4. handle.invalidate() flips the dirty flag without breaking the
//      next draw.
//   5. handle.dispose() releases GL resources without affecting other
//      handles.
async function bundleHandle(host) {
  const url = host.url(`mantleDemo.html`);

  // Two distinct fixtures: solid red square vs solid blue square.
  // Different colors give the cross-interference assertion a clear signal.
  const SVG_RED = readFileSync(
    new URL('../examples/smoke/bundleHandle__SVG_RED.svg', import.meta.url),
    'utf8',
  );
  const SVG_BLUE = readFileSync(
    new URL('../examples/smoke/bundleHandle__SVG_BLUE.svg', import.meta.url),
    'utf8',
  );

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 200, height: 200 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });
  await openReady(page, url, { ready: 'renderer' });

  const results = await page.evaluate(
    async (svgRed, svgBlue) => {
      const { importSvg, createBundle, createRenderer, createShapeMorph, loadShaders } =
        await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');

      const bRed = createBundle(gl, await importSvg(svgRed));
      const bBlue = createBundle(gl, await importSvg(svgBlue));

      // Verify the renderer exposes createBundleHandle.
      if (typeof renderer.createBundleHandle !== 'function') {
        return { error: 'renderer.createBundleHandle is not a function' };
      }
      const hRed = renderer.createBundleHandle(bRed);
      const hBlue = renderer.createBundleHandle(bBlue);

      // Handles expose the contract.
      const surface = {
        bundle: hRed.bundle === bRed,
        draw: typeof hRed.draw === 'function',
        invalidate: typeof hRed.invalidate === 'function',
        dispose: typeof hRed.dispose === 'function',
      };

      function snap() {
        const w = cnv.width,
          h = cnv.height;
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

      // Two-handle render, blue last → center pixel is blue.
      // (Both bundles fill the full canvas at default world matrix.)
      renderer.beginFrame([1, 1, 1, 1]);
      hRed.draw();
      hBlue.draw();
      renderer.endFrame();
      const redThenBlue = snap();

      // Reverse order → center pixel is red.
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

      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const morphGl = canvas.getContext('webgl2', {
        antialias: false,
        preserveDrawingBuffer: true,
      });
      const morphRenderer = createRenderer(
        morphGl,
        await loadShaders(new URL('/src/shaders/', location.href).href),
        { aacPoints: false },
      );
      await morphRenderer.ready;
      morphRenderer.setViewport(128, 128);
      morphRenderer.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
      const a = createBundle(
        morphGl,
        await importSvg(svgRed.replace('fill=', 'fill-opacity=".5" fill=')),
      );
      const b = createBundle(
        morphGl,
        await importSvg(svgBlue.replace('fill=', 'fill-opacity=".5" fill=')),
      );
      const center = () => {
        const p = new Uint8Array(4);
        morphGl.readPixels(64, 64, 1, 1, morphGl.RGBA, morphGl.UNSIGNED_BYTE, p);
        return Array.from(p);
      };
      const draw = (paint) => {
        morphRenderer.beginFrame([1, 1, 1, 1]);
        paint();
        morphRenderer.endFrame();
        return center();
      };
      const endpointA = draw(() => morphRenderer.drawBundle(a)),
        endpointB = draw(() => morphRenderer.drawBundle(b));
      const morph = createShapeMorph(morphGl, a, b, { cpuLerp: true }),
        handle = morphRenderer.createBundleHandle(morph);
      morph.setT(0);
      const warmed = await morphRenderer.warmScene(
        [
          {
            draw() {
              draw(() => handle.draw());
            },
          },
        ],
        { maxPasses: 64, fenceTimeoutMs: 60000 },
      );
      if (!warmed.complete) throw Error('Resident morph did not warm');
      const poses = [];
      for (const t of [0, 0.5, 1, 0.5, 0]) {
        morph.setT(t);
        poses.push(draw(() => handle.draw()));
      }
      let unchangedBinds = 0;
      const bindTexture = morphGl.bindTexture;
      morphGl.bindTexture = function (...args) {
        const unit = morphGl.getParameter(morphGl.ACTIVE_TEXTURE) - morphGl.TEXTURE0;
        if (args[0] === morphGl.TEXTURE_2D && (unit <= 7 || unit === 15)) unchangedBinds++;
        return bindTexture.apply(morphGl, args);
      };
      draw(() => handle.draw());
      draw(() => handle.draw());
      morphGl.bindTexture = bindTexture;
      const morphError = morphGl.getError();
      handle.dispose();
      morph.dispose();
      a.dispose();
      b.dispose();
      morphRenderer.dispose();

      return {
        endpointA,
        endpointB,
        poses,
        morphError,
        unchangedBinds,
        surface,
        onlyRed,
        onlyBlue,
        redThenBlue,
        blueThenRed,
        alt4,
        afterInvalidate,
        blueAfterRedDispose,
      };
    },
    SVG_RED,
    SVG_BLUE,
  );

  await page.close();

  if (results.error) {
    fail(results.error);
    return 1;
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
    const dr = Math.abs(r - er),
      dg = Math.abs(g - eg),
      db = Math.abs(b - eb);
    if (dr > 16 || dg > 16 || db > 16) {
      fail(`${label}: got (${r},${g},${b}), expected ~(${er},${eg},${eb})`);
      return false;
    }
    ok(`${label}: (${r},${g},${b}) ≈ (${er},${eg},${eb})`);
    return true;
  }

  expectColor(results.onlyRed, [255, 0, 0], 'single hRed.draw center is red');
  expectColor(results.onlyBlue, [0, 0, 255], 'single hBlue.draw center is blue');
  expectColor(results.redThenBlue, [0, 0, 255], 'A → B order: center is blue (B last)');
  expectColor(results.blueThenRed, [255, 0, 0], 'B → A order: center is red (A last)');
  expectColor(results.alt4, [0, 0, 255], 'A → B → A → B: center is blue (B last)');
  expectColor(results.afterInvalidate, [255, 0, 0], 'after hRed.invalidate(): red still renders');
  expectColor(
    results.blueAfterRedDispose,
    [0, 0, 255],
    'after hRed.dispose(): hBlue still renders',
  );

  const samePixel = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  if (
    results.morphError === 0 &&
    results.unchangedBinds === 0 &&
    samePixel(results.poses[0], results.endpointA) &&
    samePixel(results.poses[2], results.endpointB) &&
    samePixel(results.poses[4], results.endpointA) &&
    samePixel(results.poses[1], results.poses[3])
  ) {
    ok(
      'resident morph handle binds the current rotated metadata and restores both authored endpoints',
    );
  } else
    fail(
      'resident morph handle pose or cached asset binding failure: ' +
        JSON.stringify({
          a: results.endpointA,
          b: results.endpointB,
          poses: results.poses,
          error: results.morphError,
          unchangedBinds: results.unchangedBinds,
        }),
    );

  if (!failures) console.log('\nbundleHandleSmoke: PASS');
  return failures;
}

// bundleHandleDimensions — guards against cross-handle
// aspect-ratio bleed in one frame.
//
// Mechanism: beginFillPass caches `(cw, ch) === fillPassCanvasW/H` to
// gate the `arScale(globalBBox, cw, ch)` recompute. The cache key
// is canvas-size only, not bundle-aware. With multiple handles
// in one frame, handle B would inherit handle A's arScale result if
// the canvas size hasn't changed — even though A and B have
// different globalBBox (different aspect ratios → different
// (sx, sy) scale).
//
// This smoke uses two bundles with deliberately different aspect
// ratios:
//   - Tall: viewBox 0 0 50 100 (taller than wide)
//   - Wide: viewBox 0 0 100 50 (wider than tall)
// Each draws a filled rectangle covering its viewBox. On a square
// canvas, the renderer aspect-fits the asset:
//   - Tall asset: fills vertical extent, leaves horizontal margins
//   - Wide asset: fills horizontal extent, leaves vertical margins
//
// Assertion: after both render via handles in any order, the
// last-rendered handle's footprint should match its own aspect
// (not inherit the previous handle's arScale).
async function bundleHandleDimensions(host) {
  const url = host.url(`mantleDemo.html`);

  // 2:1 aspect ratios, opposite orientations. The fills are
  // distinct colors so we can identify which one's pixels we're
  // reading. On a square canvas:
  //   Tall (50×100, red):   bbox at canvas center x ∈ [w/4, 3w/4], y ∈ [0, h]
  //   Wide (100×50, blue):  bbox at canvas center x ∈ [0, w], y ∈ [h/4, 3h/4]
  const SVG_TALL = readFileSync(
    new URL('../examples/smoke/bundleHandleDimensions__SVG_TALL.svg', import.meta.url),
    'utf8',
  );
  const SVG_WIDE = readFileSync(
    new URL('../examples/smoke/bundleHandleDimensions__SVG_WIDE.svg', import.meta.url),
    'utf8',
  );

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 200, height: 200 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });
  await openReady(page, url, { ready: 'renderer' });

  const results = await page.evaluate(
    async (svgTall, svgWide) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');

      const bTall = createBundle(gl, await importSvg(svgTall));
      const bWide = createBundle(gl, await importSvg(svgWide));
      const hTall = renderer.createBundleHandle(bTall);
      const hWide = renderer.createBundleHandle(bWide);

      function snapshot() {
        const w = cnv.width,
          h = cnv.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { w, h, px };
      }

      // Probe pixels in the corners + along the major axis to fingerprint
      // the actual footprint.
      function probe(snap, color) {
        const { w, h, px } = snap;
        // Color matches (within tolerance) on premult RGBA8.
        function near(idx) {
          return (
            Math.abs(px[idx] - color[0]) <= 32 &&
            Math.abs(px[idx + 1] - color[1]) <= 32 &&
            Math.abs(px[idx + 2] - color[2]) <= 32 &&
            px[idx + 3] > 200
          ); // mostly opaque
        }
        // Sample at deciles along the center column AND center row.
        const colFilled = [];
        const rowFilled = [];
        for (let i = 0; i < 10; i++) {
          const y = Math.floor(((i + 0.5) * h) / 10);
          const x = Math.floor(((i + 0.5) * w) / 10);
          colFilled.push(near((y * w + (w >> 1)) * 4)); // center column
          rowFilled.push(near(((h >> 1) * w + x) * 4)); // center row
        }
        return { colFilled, rowFilled };
      }

      // ---- Single-handle baseline: render each alone, capture footprint ----
      renderer.beginFrame([1, 1, 1, 1]);
      hTall.draw();
      renderer.endFrame();
      const tallAlone = probe(snapshot(), [255, 0, 0]);

      renderer.beginFrame([1, 1, 1, 1]);
      hWide.draw();
      renderer.endFrame();
      const wideAlone = probe(snapshot(), [0, 0, 255]);

      // ---- Multi-handle: render tall then wide; check that wide's
      // footprint matches its own aspect, not tall's ----
      renderer.beginFrame([1, 1, 1, 1]);
      hTall.draw();
      hWide.draw();
      renderer.endFrame();
      const wideAfterTall = probe(snapshot(), [0, 0, 255]);

      // ---- Reverse: render wide then tall; check tall's footprint ----
      renderer.beginFrame([1, 1, 1, 1]);
      hWide.draw();
      hTall.draw();
      renderer.endFrame();
      const tallAfterWide = probe(snapshot(), [255, 0, 0]);

      hTall.dispose();
      hWide.dispose();
      bTall.dispose();
      bWide.dispose();

      return { tallAlone, wideAlone, wideAfterTall, tallAfterWide };
    },
    SVG_TALL,
    SVG_WIDE,
  );

  await page.close();

  function fmt(probe) {
    // Render a compact "C: ##########  R: ##########" visual.
    const col = probe.colFilled.map((b) => (b ? '█' : '·')).join('');
    const row = probe.rowFilled.map((b) => (b ? '█' : '·')).join('');
    return `col=${col} row=${row}`;
  }

  function probesEqual(a, b) {
    for (let i = 0; i < 10; i++) {
      if (a.colFilled[i] !== b.colFilled[i]) return false;
      if (a.rowFilled[i] !== b.rowFilled[i]) return false;
    }
    return true;
  }

  console.log(`tall alone:        ${fmt(results.tallAlone)}`);
  console.log(`wide alone:        ${fmt(results.wideAlone)}`);
  console.log(`wide after tall:   ${fmt(results.wideAfterTall)}`);
  console.log(`tall after wide:   ${fmt(results.tallAfterWide)}`);

  if (probesEqual(results.wideAfterTall, results.wideAlone)) {
    ok('wide footprint identical whether drawn alone or after tall');
  } else {
    fail('wide footprint changed when preceded by tall — dimensions bug reproduces');
  }

  if (probesEqual(results.tallAfterWide, results.tallAlone)) {
    ok('tall footprint identical whether drawn alone or after wide');
  } else {
    fail('tall footprint changed when preceded by wide — dimensions bug reproduces');
  }

  // Cross-check: tall and wide must actually have DIFFERENT footprints
  // (else the test isn't measuring anything).
  if (probesEqual(results.tallAlone, results.wideAlone)) {
    fail(
      'tall and wide solo footprints are identical — test fixtures are not distinguishing aspect ratios',
    );
  } else {
    ok('tall and wide solo footprints differ (fixture is a meaningful test)');
  }

  if (!failures) console.log('\nbundleHandleDimensionsSmoke: PASS');
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['bundleHandle', bundleHandle],
  ['bundleHandleDimensions', bundleHandleDimensions],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nbundleHandleSmoke: persistent handles stay independent in one frame');
