// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// turbulenceChromeSmoke — feTurbulence is the spec at pixel centers, and as close to Chrome as Chrome is to it.
//
// feTurbulence.frag.glsl evaluates the Filter Effects 1 reference algorithm from the spec's own seeded tables (a sin()
// hash for the lattice gradients keeps the spec's structure without its tables, so no seed would produce the pattern
// any browser draws); test/turbulenceSpecSmoke.mjs
// proves the math against a float64 transcription of the spec's C code. This checks the pixels against Chrome, whose
// Skia implementation runs the same algorithm (same Park-Miller tables, same noise2, same stitching) at lower precision.
//
// THE REFERENCE IS CHROME'S rendering of the same SVG, read back through a 2D canvas: the whole 128 x 128 canvas, on
// a TRANSPARENT ground on the Mantle side and as premultiplied values from two grounds on Chrome's (over black the
// color IS the premultiplied color; over white it is color + 255 - alpha) -- turbulence's alpha is its fourth noise
// channel, and a single ground would fold it into the color. color-interpolation-filters="sRGB": this renderer runs
// filters in sRGB, and the default linearRGB would add a color-space conversion that is not the question. The filter
// region is the canvas at the origin, so the stitch tile is the same in both (Skia takes the tile origin as 0, the
// spec as the subregion's x/y; they agree there).
//
// WHAT CAN HOLD. Chrome is not the spec to the level: on the first GPU run its output sat 1.65-6.10 levels (mean)
// from the float64 spec sampled at pixel CENTERS, and 3.20-10.64 from it at corners -- it samples centers, at reduced
// GPU precision (Skia's GPU path stores gradients at 16 bits and computes at half precision). So the criteria are:
//   * Mantle vs the float64 spec oracle at pixel centers (test/_turbulenceSpecOracle.mjs), max <= 1 level: the
//     spec's algorithm, to the rounding of the final byte;
//   * Mantle vs Chrome, mean <= (Chrome vs the spec at centers, mean) + 0.5: no further from Chrome than Chrome is
//     from the spec. The sin() hash sat ~30 levels from the spec on average.
// Both are printed per case, with Chrome against the spec at corners as the control that says where Chrome samples.
//
// STITCHING (second page). stitchTiles="stitch" makes the noise join itself at the tile border. Per the spec's
// pseudo-code the base frequency is snapped to whichever nearby value fits a whole number of lattice cells across
// the tile, then lattice coordinates at or past the tile's far edge are pulled back by that period. The gradient at
// the tile's right edge becomes the gradient at its left edge, so repeating the tile produces no seam.
//
// Note what that is NOT: it does not make neighboring tiles render the same pixels. Each tile wraps around ITS own
// origin, so two tiles side by side still hold different noise -- they just meet without a discontinuity. Asserting
// that adjacent tiles match is a plausible-looking test that fails against a correct implementation.
//
// So the measurement is seam continuity. Under tiling, the column one past the tile's right edge IS the tile's first
// column, which makes the last and first columns neighbors. Their mean difference is compared against the mean
// difference of ordinary horizontally-adjacent columns inside the tile:
//
//   stitch   -> seam step ~ interior step (they are genuinely adjacent)
//   noStitch -> seam step >> interior step (two unrelated noise values)
//
// A filter's output REPLACES its shape rather than being clipped to it, so the tile's edge columns are pure noise and
// carry none of the rect's own edge AA.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { specInit, specTurbulence, specColor } from './_turbulenceSpecOracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;
// [type, baseFrequency, numOctaves, seed, stitchTiles]
const CASES = [
  ['fractalNoise', '0.05', 1, 0, false],
  ['fractalNoise', '0.05', 4, 7, false],
  ['turbulence', '0.03 0.07', 4, -3.5, false],
  ['turbulence', '0.05', 1, 42, false],
  ['fractalNoise', '0.047', 2, 5, true], // 6.02 cells across the tile: the stitch snaps the frequency
  ['turbulence', '0.06', 4, 11.9, true],
];
const svg = ([type, bf, oct, seed, stitch]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<filter id="t" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">` +
  `<feTurbulence type="${type}" baseFrequency="${bf}" numOctaves="${oct}" seed="${seed}" stitchTiles="${stitch ? 'stitch' : 'noStitch'}"/>` +
  `</filter><rect width="${N}" height="${N}" fill="#fff" filter="url(#t)"/></svg>`;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const N = ${N};
// Both renderings as premultiplied RGBA, top-down rows.
window.__case = async (svg) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.setViewport(N, N); gl.viewport(0, 0, N, N);
  for (let i = 0; i < 2; i++) { R.beginFrame([0, 0, 0, 0]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const mantle = new Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N * 4; x++) mantle[y * N * 4 + x] = px[(N - 1 - y) * N * 4 + x];
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const on = (ground) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const ctx = cv.getContext('2d'); ctx.fillStyle = ground; ctx.fillRect(0, 0, N, N); ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, N, N).data;
  };
  const k = on('#000'), w = on('#fff');
  const chrome = new Array(N * N * 4);
  for (let i = 0; i < N * N * 4; i += 4) { chrome[i] = k[i]; chrome[i + 1] = k[i + 1]; chrome[i + 2] = k[i + 2]; chrome[i + 3] = k[i] + 255 - w[i]; }
  return { mantle, chrome };
};
window.__ready = true;
</script></body></html>`;

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

const STITCH_HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${SIDE}" height="${SIDE}"></canvas>
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

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/stitch') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(u === '/' ? HTML : STITCH_HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// The spec's premultiplied bytes for pixel (i, j) sampled at (i + d, j + d): the straight float color times the
// float alpha, rounded once -- what the shader's fragColor becomes in an RGBA8 target.
function oracleImage(c, d) {
  const [type, bf, oct, seed, stitch] = c;
  const [bx, by = bx] = bf.split(' ').map(Number);
  const T = specInit(Math.trunc(seed));
  const fractal = type === 'fractalNoise';
  const out = new Float64Array(N * N * 4);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const s = [0, 1, 2, 3].map((ch) =>
        specColor(
          specTurbulence(T, ch, [i + d, j + d], bx, by, oct, fractal, stitch, 0, 0, N, N),
          fractal,
        ),
      );
      const o = (j * N + i) * 4;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round((s[ch] * s[3]) / 255);
      out[o + 3] = Math.round(s[3]);
    }
  return out;
}
const stats = (a, b) => {
  let sum = 0,
    max = 0;
  for (let i = 0; i < a.length; i++) {
    const e = Math.abs(a[i] - b[i]);
    sum += e;
    if (e > max) max = e;
  }
  return { mean: sum / a.length, max };
};
const fmt = (s) => `mean ${s.mean.toFixed(2)} max ${s.max}`;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
// The stitch seam, on its own page (its own canvas size and renderer).
async function stitchSection() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/stitch`, {
    waitUntil: 'load',
    timeout: pageTimeoutFor(),
  });
  await page.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
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
  await page.close();
}
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES) {
    const name = `${c[0]} ${c[1]}, ${c[2]} octave${c[2] > 1 ? 's' : ''}, seed ${c[3]}${c[4] ? ', stitch' : ''}`;
    const { mantle, chrome } = await page.evaluate((s) => window.__case(s), svg(c));
    const corner = oracleImage(c, 0),
      center = oracleImage(c, 0.5);
    const mc = stats(mantle, chrome),
      ms = stats(mantle, center),
      cs = stats(chrome, center);
    console.log(
      `  ${name}: mantle vs spec@center ${fmt(ms)} | mantle vs chrome ${fmt(mc)} | chrome vs spec@center ${fmt(cs)}` +
        ` | chrome vs spec@corner ${fmt(stats(chrome, corner))}`,
    );
    // A flat or empty Chrome image would match anything flat; the noise must vary.
    let varied = 0;
    for (let i = 4; i < chrome.length; i += 4)
      if (Math.abs(chrome[i] - chrome[i - 4]) > 2) varied++;
    if (varied < (N * N) / 20) {
      fail(`${name}: Chrome's image hardly varies (${varied} steps) — the case measures nothing`);
      continue;
    }
    if (ms.max <= 1) ok(`${name}: the spec at pixel centers, to the byte (${fmt(ms)})`);
    else fail(`${name}: off the spec at pixel centers (${fmt(ms)})`);
    const lim = cs.mean + 0.5;
    if (mc.mean <= lim)
      ok(
        `${name}: no further from Chrome (mean ${mc.mean.toFixed(2)}) than Chrome is from the spec + 0.5 (${lim.toFixed(2)})`,
      );
    else
      fail(
        `${name}: mean ${mc.mean.toFixed(2)} from Chrome, past Chrome's own distance from the spec + 0.5 (${lim.toFixed(2)})`,
      );
  }
} catch (e) {
  fail('setup: ' + e.message);
}
{
  const before = failures;
  try {
    await stitchSection();
  } catch (e) {
    fail('drive failed: ' + e.message);
  }
  console.log(
    failures === before
      ? 'TURBULENCE-STITCH PASS'
      : `TURBULENCE-STITCH FAIL (${failures - before})`,
  );
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nturbulenceChromeSmoke: feTurbulence is the spec at pixel centers, and as close to Chrome as Chrome is to the spec;' +
    ' stitchTiles joins the tile to itself',
);
