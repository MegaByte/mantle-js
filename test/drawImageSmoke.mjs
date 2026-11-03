// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// drawImageSmoke.mjs — Puppeteer proof of the direct raster-blit API
// (renderer.createImage + renderer.drawImage). Builds a 2×2 RGBA image
// with four distinct opaque quadrants:
//   TL red   TR green
//   BL blue  BR white
// and exercises: plain blit into a dstRect, tint, alpha (over a known
// backdrop), src sub-rect, and a worldMatrix translate. Reads pixels
// with gl.readPixels (bottom-up) and checks each predicate.
//
// drawImageInstanced (WebGL GPU instancing), on its own page in the same browser.
// Upload ONE 1×1 white image, then stamp it at N transforms in a SINGLE
// drawArraysInstanced call. Asserts:
//   1. Each instance lands at its own dstRect (distinct screen positions).
//   2. Per-instance tint colors the shared white source independently.
//   3. Per-instance alpha attenuates independently.
//   4. A per-instance worldMatrix (translate) offsets that instance only.
//   5. Empty / zero-length instance list is a safe no-op (returns 0).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders, importSvg, createBundle } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
window.__gl = gl; window.__renderer = renderer;

// 2×2 straight-alpha RGBA. Row 0 = top in image space.
//   (0,0)=red (1,0)=green / (0,1)=blue (1,1)=white
const px = new Uint8Array([
  255,0,0,255,   0,255,0,255,
  0,0,255,255,   255,255,255,255,
]);
window.__img = renderer.createImage({ width: 2, height: 2, data: px }, { filter: 'nearest' });

// A bundle for the interleave check: a blue rect in [0..100,0..100].
const __sections = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="0" y="0" width="100" height="100" fill="#0000ff"/></svg>');
window.__bundle = createBundle(gl, __sections);
window.__id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

window.__draw = (calls) => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0.5, 0.5, 0.5, 1]);  // gray backdrop (128,128,128)
  for (const c of calls) renderer.drawImage(window.__img, c);
  renderer.endFrame();
};

// Interleave: drawBundle → drawImage → drawBundle (SAME bundle). If
// drawImage failed to self-report fillPassAssetDirty, the 2nd drawBundle
// would skip rebinding curveTex (drawImage left its texture on TEXTURE0)
// and the blue rect would render as garbage. Returns the blue-rect
// interior pixel for both the clean and interleaved sequences.
window.__interleave = () => {
  const blueAt = () => { const b = new Uint8Array(4); gl.readPixels(20, 200-1-20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
  renderer.setViewport(200, 200);
  renderer.beginFrame([0.5,0.5,0.5,1]);
  renderer.drawBundle(window.__bundle, { worldMatrix: window.__id });
  renderer.endFrame();
  const clean = blueAt();
  renderer.beginFrame([0.5,0.5,0.5,1]);
  renderer.drawBundle(window.__bundle, { worldMatrix: window.__id });
  renderer.drawImage(window.__img, { dstRect: [120,120,40,40] });
  renderer.drawBundle(window.__bundle, { worldMatrix: window.__id });  // same handle
  renderer.endFrame();
  const inter = blueAt();
  return { clean, inter };
};
window.__ready = true;
</script></body></html>`;

const INSTANCED_HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
// 1×1 white opaque source (premultiplied upload).
const px = new Uint8Array([255,255,255,255]);
const img = renderer.createImage({ data: px, width: 1, height: 1 });
window.__hasImg = !!(img && img.texture);
window.__hasFn = typeof renderer.drawImageInstanced === 'function';
window.__draw = (instances, opts) => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawImageInstanced(img, instances, opts || {});
  renderer.endFrame();
  return n;
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 200-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.url === '/instanced') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INSTANCED_HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl')
    ? 'text/plain'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const near = (a, b, t = 12) => Math.abs(a - b) <= t;
const rgbNear = (c, r, g, b, t = 12) => near(c[0], r, t) && near(c[1], g, t) && near(c[2], b, t);

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
  if (m.type() === 'error') console.error('  [console]', m.text());
});

try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('page setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

// gl.readPixels is bottom-up; the dstRect is y-down (top-left origin).
// sampleTop(x, yTop) converts a top-down pixel to the gl row.
async function run(calls, samples) {
  return page.evaluate(
    (calls, samples) => {
      const gl = window.__gl;
      window.__draw(calls);
      const w = 200,
        h = 200,
        buf = new Uint8Array(4);
      return samples.map(([x, yTop]) => {
        gl.readPixels(x, h - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return [buf[0], buf[1], buf[2], buf[3]];
      });
    },
    calls,
    samples,
  );
}

// 1) Plain blit into dstRect [20,20,80,80] → quadrants map across it.
//    Centers of the four quadrants (top-down pixels):
//      TL ~ (40,40) red   TR ~ (80,40) green
//      BL ~ (40,80) blue  BR ~ (80,80) white
{
  const s = await run(
    [{ dstRect: [20, 20, 80, 80] }],
    [
      [40, 40],
      [80, 40],
      [40, 80],
      [80, 80],
      [5, 5],
    ],
  );
  if (rgbNear(s[0], 255, 0, 0)) ok('blit TL quadrant red');
  else fail('TL not red: ' + s[0]);
  if (rgbNear(s[1], 0, 255, 0)) ok('blit TR quadrant green');
  else fail('TR not green: ' + s[1]);
  if (rgbNear(s[2], 0, 0, 255)) ok('blit BL quadrant blue');
  else fail('BL not blue: ' + s[2]);
  if (rgbNear(s[3], 255, 255, 255)) ok('blit BR quadrant white');
  else fail('BR not white: ' + s[3]);
  if (rgbNear(s[4], 128, 128, 128)) ok('backdrop outside dstRect intact (gray)');
  else fail('backdrop clobbered: ' + s[4]);
}

// 2) Tint green → red quadrant becomes black (255,0,0)*(0,1,0)=0; green stays.
{
  const s = await run(
    [{ dstRect: [20, 20, 80, 80], tint: [0, 1, 0, 1] }],
    [
      [40, 40],
      [80, 40],
    ],
  );
  if (rgbNear(s[0], 0, 0, 0)) ok('tint green: red quadrant → black');
  else fail('tinted TL: ' + s[0]);
  if (rgbNear(s[1], 0, 255, 0)) ok('tint green: green quadrant stays green');
  else fail('tinted TR: ' + s[1]);
}

// 3) Alpha 0.5 over gray backdrop → red over gray = (191,64,64) premultiplied
//    src-over: out = src*1 + dst*(1-a). src premult red@0.5 = (128,0,0,128);
//    dst gray (128). out.r = 128 + 128*0.5 = 192; out.g = 0 + 128*0.5 = 64.
{
  const s = await run([{ dstRect: [20, 20, 80, 80], alpha: 0.5 }], [[40, 40]]);
  if (rgbNear(s[0], 192, 64, 64, 16)) ok('alpha 0.5: red over gray ≈ (192,64,64)');
  else fail('alpha blend: ' + s[0]);
}

// 4) srcRect = just the TL texel [0,0,1,1] → whole dstRect is red.
{
  const s = await run(
    [{ dstRect: [20, 20, 80, 80], srcRect: [0, 0, 1, 1] }],
    [
      [40, 40],
      [80, 80],
    ],
  );
  if (rgbNear(s[0], 255, 0, 0) && rgbNear(s[1], 255, 0, 0))
    ok('srcRect TL texel fills whole dstRect red');
  else fail('srcRect: ' + s[0] + ' ' + s[1]);
}

// 5) worldMatrix translate (+100 x): the same dstRect [0,0,80,80] shifts right.
//    Column-major mat3 translate by (100,0): [1,0,0, 0,1,0, 100,0,1].
{
  // Plain array (survives puppeteer serialization; renderer coerces to
  // Float32Array). Column-major mat3 translate by (100,0).
  const m = [1, 0, 0, 0, 1, 0, 100, 0, 1];
  const s = await run(
    [{ dstRect: [0, 0, 80, 80], worldMatrix: m }],
    [
      [20, 20],
      [120, 20],
    ],
  );
  if (rgbNear(s[0], 128, 128, 128)) ok('worldMatrix: original spot empty (gray)');
  else fail('translate src spot: ' + s[0]);
  if (rgbNear(s[1], 255, 0, 0)) ok('worldMatrix: image shifted +100x (red present)');
  else fail('translate dst spot: ' + s[1]);
}

// 6) Interleave: drawBundle → drawImage → drawBundle (same bundle). The
//    2nd drawBundle must re-bind its asset textures (drawImage clobbered
//    TEXTURE0 + the program). If drawImage forgot to self-report
//    fillPassAssetDirty, the blue rect renders as garbage. Guards the
//    self-report contract.
{
  const r = await page.evaluate(() => window.__interleave());
  const blue = (c) => rgbNear(c, 0, 0, 255, 16);
  if (blue(r.clean)) ok('interleave: clean drawBundle blue');
  else fail('clean not blue: ' + r.clean);
  if (blue(r.inter))
    ok('interleave: drawBundle→drawImage→drawBundle keeps blue (no cache corruption)');
  else fail('interleave corrupted blue rect: ' + r.inter + ' (vs clean ' + r.clean + ')');
}

// 7) Per-draw colorMatrix / colorMatrixOffset. Two blits of the same image
//    handle with different offsets must differ — a raster path that drops
//    the recolor (color only from the per-ASSET tint) would give every
//    mount sharing an asset one color. Identity matrix +
//    offset shifts channels; the third (plain) draw proves the uniform is
//    reset and does not leak into the next call.
{
  const s = await run(
    [
      { dstRect: [0, 0, 80, 80], colorMatrixOffset: [0, 1, 0, 0] },
      { dstRect: [100, 0, 80, 80], colorMatrixOffset: [0, 0, 1, 0] },
      { dstRect: [0, 100, 80, 80] },
    ],
    [
      [20, 20],
      [120, 20],
      [20, 120],
    ],
  );
  if (rgbNear(s[0], 255, 255, 0)) ok('colorMatrixOffset +G: red quadrant → yellow');
  else fail('offset +G: ' + s[0]);
  if (rgbNear(s[1], 255, 0, 255)) ok('colorMatrixOffset +B: red quadrant → magenta');
  else fail('offset +B: ' + s[1]);
  if (!rgbNear(s[0], s[1][0], s[1][1], s[1][2]))
    ok('two mounts of one asset recolor independently');
  else fail('offsets produced identical pixels: ' + s[0]);
  if (rgbNear(s[2], 255, 0, 0)) ok('recolor does not leak to the next drawImage');
  else fail('leaked recolor: ' + s[2]);
}

// 8) A colorMatrix that swaps R→B (column-major mat4: column j = where
//    input channel j lands). Red texel must come out blue.
{
  const swapRB = [
    0,
    0,
    1,
    0, // in.r → out.b
    0,
    1,
    0,
    0,
    1,
    0,
    0,
    0, // in.b → out.r
    0,
    0,
    0,
    1,
  ];
  const s = await run(
    [{ dstRect: [20, 20, 80, 80], colorMatrix: swapRB }],
    [
      [40, 40],
      [40, 80],
    ],
  );
  if (rgbNear(s[0], 0, 0, 255)) ok('colorMatrix R↔B: red quadrant → blue');
  else fail('swap TL: ' + s[0]);
  if (rgbNear(s[1], 255, 0, 0)) ok('colorMatrix R↔B: blue quadrant → red');
  else fail('swap BL: ' + s[1]);
}

const drawImageFailures = failures;
if (drawImageFailures === 0) console.log('\nDRAW-IMAGE PASS');
else console.log(`\nDRAW-IMAGE FAIL (${drawImageFailures})`);

// ---- drawImageInstanced: one 1×1 white image stamped at N transforms in a single instanced draw ----
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  let ready = true;
  try {
    await openReady(page, `http://127.0.0.1:${port}/instanced`, { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    if (await page.evaluate(() => window.__hasFn)) ok('renderer.drawImageInstanced exists');
    else fail('drawImageInstanced not exported');
    if (await page.evaluate(() => window.__hasImg)) ok('1×1 source image uploaded');
    else fail('source image upload failed');

    // (1) Three instances at distinct dstRects → three filled squares.
    const r1 = await page.evaluate(() => {
      const n = window.__draw([
        { dstRect: [10, 10, 20, 20] }, // top-left  → center (20,20)
        { dstRect: [90, 90, 20, 20] }, // center    → center (100,100)
        { dstRect: [160, 160, 20, 20] }, // bot-right → center (170,170)
      ]);
      return {
        n,
        a: window.__sample(20, 20),
        b: window.__sample(100, 100),
        c: window.__sample(170, 170),
        gap: window.__sample(60, 60),
      }; // between instances → background
    });
    if (r1.n === 3) ok('drew 3 instances (single instanced call)');
    else fail('instance count: ' + r1.n);
    if (r1.a[0] > 200 && r1.b[0] > 200 && r1.c[0] > 200)
      ok('all 3 instances rendered at their dstRects (white)');
    else fail('missing instance(s): a=' + r1.a + ' b=' + r1.b + ' c=' + r1.c);
    if (r1.gap[0] < 30 && r1.gap[1] < 30) ok('background between instances is clear (no stretch)');
    else fail('unexpected fill between instances: ' + r1.gap);

    // (2) Per-instance tint: red, green, blue squares from one white source.
    const r2 = await page.evaluate(() => {
      window.__draw([
        { dstRect: [10, 90, 20, 20], tint: [1, 0, 0, 1] },
        { dstRect: [90, 90, 20, 20], tint: [0, 1, 0, 1] },
        { dstRect: [170, 90, 20, 20], tint: [0, 0, 1, 1] },
      ]);
      return {
        r: window.__sample(20, 100),
        g: window.__sample(100, 100),
        b: window.__sample(180, 100),
      };
    });
    if (r2.r[0] > 200 && r2.r[1] < 40 && r2.r[2] < 40) ok('instance 0 tinted red');
    else fail('tint red: ' + r2.r);
    if (r2.g[1] > 200 && r2.g[0] < 40 && r2.g[2] < 40) ok('instance 1 tinted green');
    else fail('tint green: ' + r2.g);
    if (r2.b[2] > 200 && r2.b[0] < 40 && r2.b[1] < 40) ok('instance 2 tinted blue');
    else fail('tint blue: ' + r2.b);

    // (3) Per-instance alpha: full vs ~half over a black background.
    const r3 = await page.evaluate(() => {
      window.__draw([
        { dstRect: [40, 90, 20, 20], alpha: 1.0 },
        { dstRect: [140, 90, 20, 20], alpha: 0.5 },
      ]);
      return { full: window.__sample(50, 100), half: window.__sample(150, 100) };
    });
    if (r3.full[0] > 230) ok('alpha=1 instance fully opaque (' + r3.full[0] + ')');
    else fail('alpha=1: ' + r3.full);
    if (near(r3.half[0], 128, 30)) ok('alpha=0.5 instance ~half over black (' + r3.half[0] + ')');
    else fail('alpha=0.5: ' + r3.half);

    // (4) Per-instance worldMatrix translate moves ONE instance only.
    const r4 = await page.evaluate(() => {
      const T = [1, 0, 0, 0, 1, 0, 60, 0, 1]; // column-major translate +60 in x
      window.__draw([
        { dstRect: [20, 90, 20, 20] }, // stays at x≈30
        { dstRect: [20, 90, 20, 20], worldMatrix: T }, // shifts to x≈90
      ]);
      return {
        base: window.__sample(30, 100),
        shifted: window.__sample(90, 100),
        origOfShift: window.__sample(30, 100),
      };
    });
    if (r4.base[0] > 200) ok('untransformed instance at origin');
    else fail('base instance missing: ' + r4.base);
    if (r4.shifted[0] > 200) ok('worldMatrix-translated instance shifted +60px');
    else fail('shifted instance missing: ' + r4.shifted);

    // (5) Empty list → safe no-op.
    const r5 = await page.evaluate(() => window.__draw([]));
    if (r5 === 0) ok('empty instance list is a no-op (returns 0)');
    else fail('empty list returned: ' + r5);
  }
  await page.close();
  const n = failures - drawImageFailures;
  if (n === 0) console.log('\nINSTANCED-BLIT PASS');
  else console.log(`\nINSTANCED-BLIT FAIL (${n})`);
}

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
