// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// turbulenceStitchSmoke — feTurbulence stitchTiles="stitch" makes the noise
// join itself at the tile border.
//
// What stitching does, per the spec's feTurbulence pseudo-code: the base
// frequency is snapped to whichever nearby value fits a whole number of lattice
// cells across the tile, then lattice coordinates at or past the tile's far edge
// are pulled back by that period. The gradient at the tile's right edge becomes
// the gradient at its left edge, so repeating the tile produces no seam.
//
// Note what that is NOT: it does not make neighboring tiles render the same
// pixels. Each tile wraps around ITS own origin, so two tiles side by side still
// hold different noise — they just meet without a discontinuity. Asserting that
// adjacent tiles match is a plausible-looking test that fails against a correct
// implementation.
//
// So the measurement is seam continuity. Under tiling, the column one past the
// tile's right edge IS the tile's first column, which makes the last and first
// columns neighbors. Their mean difference is compared against the mean
// difference of ordinary horizontally-adjacent columns inside the tile:
//
//   stitch   → seam step ≈ interior step (they are genuinely adjacent)
//   noStitch → seam step >> interior step (two unrelated noise values)
//
// A filter's output REPLACES its shape rather than being clipped to it, so the
// tile's edge columns are pure noise and carry none of the rect's own edge AA.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL ' + m);
};

// The tile is the primitive's subregion. A ROOT feTurbulence has no consumers,
// so its bbox propagates to the whole canvas — that is the tile here, and the
// seam to inspect is the canvas's own left/right edges. (An explicit
// filterUnits="userSpaceOnUse" region does NOT narrow it: node bboxes come from
// the shape silhouette propagated through the graph, not from the stated filter
// region, so a test written against that region measures a boundary that is
// not a tile edge and cannot tell stitch from noStitch.)
const SIDE = 160,
  TX = 0,
  TW = 160; // canvas side; tile origin + width in px

const svgFor = (stitch) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIDE} ${SIDE}">
  <defs>
    <filter id="t">
      <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="11" stitchTiles="${stitch}"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="${SIDE}" height="${SIDE}" fill="#fff" filter="url(#t)"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${SIDE}" height="${SIDE}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIDE}, TX = ${TX}, TW = ${TW};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders);

const measure = (px) => {
  const at = (x, y, k) => px[(((y * S) + x) * 4) + k];
  let seam = 0, seamN = 0, interior = 0, interiorN = 0, ink = 0;
  // Rows well inside the tile vertically, so the top/bottom tile edges never
  // enter the horizontal measurement.
  for (let y = TX + 8; y < TX + TW - 8; y++) {
    for (let k = 0; k < 3; k++) {
      // Under tiling, column TX+TW-1 is immediately left of column TX.
      seam += Math.abs(at(TX + TW - 1, y, k) - at(TX, y, k));
    }
    seamN += 3;
    for (let x = TX + 1; x < TX + TW - 1; x++) {
      for (let k = 0; k < 3; k++) interior += Math.abs(at(x, y, k) - at(x + 1, y, k));
      interiorN += 3;
    }
    for (let x = TX; x < TX + TW; x++) if (at(x, y, 3) !== 0) ink++;
  }
  return { seam: seam / Math.max(seamN, 1), interior: interior / Math.max(interiorN, 1), ink };
};

window.__run = async (svgStitch, svgNo) => {
  const draw = async (svg) => {
    const sec = await importSvg(svg);
    const b = createBundle(gl, sec);
    r.setViewport(S, S);
    r.beginFrame([0, 0, 0, 0]); r.drawBundle(b); r.endFrame();
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    b.dispose();
    return px;
  };
  return { stitch: measure(await draw(svgStitch)), noStitch: measure(await draw(svgNo)) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    const mime = /\.(js|mjs)$/.test(p)
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

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
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 30000,
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 });
  const r = await page.evaluate((a, b) => window.__run(a, b), svgFor('stitch'), svgFor('noStitch'));

  const ratio = (m) => m.seam / Math.max(m.interior, 1e-6);
  console.log(
    `   stitch  : seam step ${r.stitch.seam.toFixed(2)}, interior step ` +
      `${r.stitch.interior.toFixed(2)}, ratio ${ratio(r.stitch).toFixed(2)}x, ink ${r.stitch.ink}`,
  );
  console.log(
    `   noStitch: seam step ${r.noStitch.seam.toFixed(2)}, interior step ` +
      `${r.noStitch.interior.toFixed(2)}, ratio ${ratio(r.noStitch).toFixed(2)}x, ink ${r.noStitch.ink}`,
  );

  if (r.stitch.ink === 0) {
    fail('nothing rendered inside the tile — the turbulence never reached the canvas');
  } else if (r.stitch.interior < 0.5) {
    fail(
      `the pattern is nearly flat (interior step ${r.stitch.interior.toFixed(3)}); a constant ` +
        'has no seam either and would pass without any stitching',
    );
  } else {
    ok(
      `turbulence rendered and varies (ink ${r.stitch.ink}, interior step ${r.stitch.interior.toFixed(2)})`,
    );
    // A perfect join gives ratio ~1. Allow slack: the snapped frequency puts a
    // whole number of CELLS across the tile, not a whole number of PIXELS, so
    // the two columns sit at slightly different phases within their cell.
    if (ratio(r.stitch) < 3) {
      ok(
        `stitch: the tile joins itself (seam step ${r.stitch.seam.toFixed(2)} vs ` +
          `interior ${r.stitch.interior.toFixed(2)}, ${ratio(r.stitch).toFixed(2)}x)`,
      );
    } else {
      fail(
        `stitch: seam step is ${ratio(r.stitch).toFixed(2)}x the interior step — the lattice ` +
          'wrap or the base-frequency snap is not taking effect',
      );
    }
    if (ratio(r.noStitch) > ratio(r.stitch) * 1.5) {
      ok(
        `noStitch seams as expected (${ratio(r.noStitch).toFixed(2)}x) — stitch is doing the work`,
      );
    } else {
      fail(
        `noStitch shows no seam either (${ratio(r.noStitch).toFixed(2)}x vs stitch ` +
          `${ratio(r.stitch).toFixed(2)}x); this fixture cannot tell stitching apart, so a ` +
          'passing stitch result would prove nothing',
      );
    }
  }
} catch (e) {
  fail('drive failed: ' + e.message);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'TURBULENCE-STITCH PASS' : `TURBULENCE-STITCH FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
