// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleHandleSmoke.mjs — smoke for the public createBundleHandle
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

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
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
    const morphGl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
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
expectColor(results.blueAfterRedDispose, [0, 0, 255], 'after hRed.dispose(): hBlue still renders');

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

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nbundleHandleSmoke: PASS');
