// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleInstancedTintSmoke.mjs — per-instance COLOR on drawBundleInstanced.
//
// Asserts:
//   1. A simple fill-only bundle with ≥2 instances takes the GPU fast path
//      (debugStats.instancedFastCount bumps) and per-instance rgba `tint`
//      recolors each instance independently.
//   2. Fast path vs per-instance loop (_setInstancedFast(false)) is
//      pixel-identical for the same tinted instance list — the loop composes
//      the tint into an effective colorMatrix, the fast path rides an
//      instanced attribute; both must land on the same pixels.
//   3. Instanced+tinted output matches the naive N × drawBundle baseline
//      (per-draw colorMatrix = diag(tint)) pixel-for-pixel.
//   4. A per-instance FULL colorMatrix/offset falls back to the loop (fast
//      count does NOT bump) and applies correctly (R↔G swap, blue offset).
//   5. Per-instance tint composes UNDER the shared colorMatrix identically
//      on both routes (tint first, then shared matrix).
//   6. Per-instance alpha and tint combine on the fast path.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Simple TWO-shape fill-only bundle (fast-path eligible): white field with a
// mid-gray inner square. Two shapes exercise the compacted cover-quad +
// per-instance painter order, and tints scale both predictably.
const SIMPLE_SVG = readFileSync(
  new URL('../examples/smoke/bundleInstancedTint__SIMPLE_SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SIMPLE_SVG)}));
// clip-space scale+translate: bundle auto-fits the viewport, each instance
// scales it down to a tile then translates in post-fit clip space.
const ST = (s, tx, ty) => new Float32Array([s,0,0, 0,s,0, tx,ty,1]);
window.__T = ST;
window.__fastCount = () => renderer.debugStats.instancedFastCount;
window.__setFast = (v) => renderer._setInstancedFast(v);
window.__drawInst = (instances, shared) => {
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawBundleInstanced(bundle, instances, shared || {});
  renderer.endFrame();
  return n;
};
window.__drawSeq = (draws) => {
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  for (const d of draws) renderer.drawBundle(bundle, d);
  renderer.endFrame();
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 240-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
// Full-frame snapshot for pixel-for-pixel parity (returned as plain array
// checksum + a downsampled grid so the wire payload stays small: 24×24 grid
// of exact pixels + a full-buffer max-diff helper kept in-page).
let __snapA = null;
window.__grab = (slot) => {
  const buf = new Uint8Array(240*240*4);
  gl.readPixels(0, 0, 240, 240, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  if (slot === 0) { __snapA = buf; return 0; }
  let dmax = 0;
  for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - __snapA[i]); if (d > dmax) dmax = d; }
  return dmax;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
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
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

// The instanced program links in the background where the driver compiles in parallel; the per-instance loop draws until it is done.
await page.evaluate(`(async () => {
  for (let f = 0; f < 1200 && !(window.__fastCount() > 0); f++) {
    window.__drawInst([{ worldMatrix: window.__T(0.45, -0.5, 0) }, { worldMatrix: window.__T(0.45, 0.5, 0) }]);
    await new Promise((q) => setTimeout(q, 25));
  }
})()`);

// Two side-by-side tiles: left tinted red, right tinted green. Tile centers:
// clip x = ∓0.5 → px 60 / 180; white field sample at the tile center offset
// left 30px (outside the inner gray square), gray sample at the exact center.
const T = { s: 0.45 };
const tiles = `[
  { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1, 0, 0, 1] },
  { worldMatrix: window.__T(0.45,  0.5, 0), tint: [0, 1, 0, 1] },
]`;

// (1) fast path taken + per-instance tint applies.
const r1 = await page.evaluate(`(() => {
  const before = window.__fastCount();
  const n = window.__drawInst(${tiles});
  const after = window.__fastCount();
  return { n, dFast: after - before,
    leftWhite: window.__sample(30, 120), leftGray: window.__sample(60, 120),
    rightWhite: window.__sample(150, 120), rightGray: window.__sample(180, 120) };
})()`);
if (r1.n === 2 && r1.dFast === 1)
  ok('2 simple tinted instances take the GPU fast path (fastCount +1)');
else fail('fast path not taken: n=' + r1.n + ' dFast=' + r1.dFast);
if (
  r1.leftWhite[0] > 220 &&
  r1.leftWhite[1] < 30 &&
  r1.leftGray[0] > 90 &&
  r1.leftGray[0] < 170 &&
  r1.leftGray[1] < 30
)
  ok(
    'left instance tinted red (white→red ' + r1.leftWhite + ', gray→dark red ' + r1.leftGray + ')',
  );
else fail('left tint wrong: white=' + r1.leftWhite + ' gray=' + r1.leftGray);
if (
  r1.rightWhite[1] > 220 &&
  r1.rightWhite[0] < 30 &&
  r1.rightGray[1] > 90 &&
  r1.rightGray[1] < 170 &&
  r1.rightGray[0] < 30
)
  ok('right instance tinted green independently (' + r1.rightWhite + ' / ' + r1.rightGray + ')');
else fail('right tint wrong: white=' + r1.rightWhite + ' gray=' + r1.rightGray);

// (2) fast path vs per-instance loop: pixel-identical.
const r2 = await page.evaluate(`(() => {
  window.__drawInst(${tiles});
  window.__grab(0);
  window.__setFast(false);
  const before = window.__fastCount();
  window.__drawInst(${tiles});
  window.__setFast(true);
  return { dmax: window.__grab(1), dFast: window.__fastCount() - before };
})()`);
if (r2.dFast === 0) ok('_setInstancedFast(false) routes the same call through the loop');
else fail('toggle did not disable the fast path');
if (r2.dmax <= 2) ok('fast path ≡ per-instance loop for tinted instances (Δmax=' + r2.dmax + ')');
else fail('fast vs loop tint mismatch: Δmax=' + r2.dmax);

// (3) instanced+tint ≡ naive N × drawBundle with colorMatrix = diag(tint).
const r3 = await page.evaluate(`(() => {
  window.__drawInst(${tiles});
  window.__grab(0);
  const diag = (r,g,b,a) => new Float32Array([r,0,0,0, 0,g,0,0, 0,0,b,0, 0,0,0,a]);
  window.__drawSeq([
    { worldMatrix: window.__T(0.45, -0.5, 0), colorMatrix: diag(1,0,0,1) },
    { worldMatrix: window.__T(0.45,  0.5, 0), colorMatrix: diag(0,1,0,1) },
  ]);
  return window.__grab(1);
})()`);
if (r3 <= 2)
  ok('instanced tint ≡ sequential drawBundle diag-colorMatrix baseline (Δmax=' + r3 + ')');
else fail('instanced vs sequential baseline mismatch: Δmax=' + r3);

// (4) per-instance FULL colorMatrix/offset → loop fallback, correct output.
const r4 = await page.evaluate(`(() => {
  const swapRG = new Float32Array([0,1,0,0, 1,0,0,0, 0,0,1,0, 0,0,0,1]);
  const before = window.__fastCount();
  window.__drawInst([
    { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1,0,0,1], colorMatrix: swapRG },
    { worldMatrix: window.__T(0.45,  0.5, 0), colorMatrixOffset: new Float32Array([0,0,1,0]) },
  ]);
  const dFast = window.__fastCount() - before;
  const left = window.__sample(30, 120);            // red tint then R↔G swap → green
  const right = window.__sample(150, 120);          // white + blue offset → still white (clamped)
  const rightGray = window.__sample(180, 120);      // gray + blue offset → blue channel saturates
  window.__grab(0);
  // Baseline: sequential draws with the equivalent composed matrices.
  const eff = new Float32Array([0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]); // swapRG · diag(1,0,0,1)
  window.__drawSeq([
    { worldMatrix: window.__T(0.45, -0.5, 0), colorMatrix: eff },
    { worldMatrix: window.__T(0.45,  0.5, 0), colorMatrixOffset: new Float32Array([0,0,1,0]) },
  ]);
  const dmax = window.__grab(1);
  return { dFast, left, right, rightGray, dmax };
})()`);
if (r4.dFast === 0) ok('per-instance colorMatrix falls back to the per-instance loop');
else fail('full colorMatrix wrongly took the fast path');
if (r4.left[1] > 220 && r4.left[0] < 30)
  ok('tint→matrix compose order: red tint then R↔G swap = green (' + r4.left + ')');
else fail('tint∘matrix compose wrong: ' + r4.left);
if (r4.rightGray[2] > 220)
  ok('per-instance colorMatrixOffset applies (+blue → ' + r4.rightGray + ')');
else fail('colorMatrixOffset not applied: ' + r4.rightGray);
if (r4.dmax <= 2)
  ok('loop-path instanced CM ≡ sequential composed baseline (Δmax=' + r4.dmax + ')');
else fail('instanced CM vs baseline mismatch: Δmax=' + r4.dmax);

// (5) per-instance tint UNDER a shared colorMatrix — identical on both routes.
const r5 = await page.evaluate(`(() => {
  window.__f5 = window.__fastCount();
  const swapRG = new Float32Array([0,1,0,0, 1,0,0,0, 0,0,1,0, 0,0,0,1]);
  const insts = [
    { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1,0,0,1] },
    { worldMatrix: window.__T(0.45,  0.5, 0), tint: [0,1,0,1] },
  ];
  // (a shared matrix changes which features the program omits, so it is a new program that links in the background)
  return (async () => {
  for (let f = 0; f < 1200 && !(window.__fastCount() > window.__f5); f++) {
    window.__drawInst(insts, { colorMatrix: swapRG });
    await new Promise((q) => setTimeout(q, 25));
  }
  const before = window.__fastCount();
  window.__drawInst(insts, { colorMatrix: swapRG });
  const dFast = window.__fastCount() - before;
  const left = window.__sample(30, 120);    // white·red = red, then swap → green
  window.__grab(0);
  window.__setFast(false);
  window.__drawInst(insts, { colorMatrix: swapRG });
  window.__setFast(true);
  return { dFast, left, dmax: window.__grab(1) };
  })();
})()`);
if (r5.dFast === 1) ok('tint + SHARED colorMatrix stays on the fast path');
else fail('shared CM + tint did not take fast path');
if (r5.left[1] > 220 && r5.left[0] < 30)
  ok('shared matrix applies AFTER the instance tint (red→swap→green: ' + r5.left + ')');
else fail('shared∘tint order wrong: ' + r5.left);
if (r5.dmax <= 2) ok('shared CM + tint: fast ≡ loop (Δmax=' + r5.dmax + ')');
else fail('shared CM + tint fast vs loop mismatch: Δmax=' + r5.dmax);

// (6) alpha and tint combine per instance on the fast path (over black:
// premultiplied red at half alpha ≈ 128,0,0).
const r6 = await page.evaluate(`(() => {
  window.__drawInst([
    { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1,0,0,1], alpha: 0.5 },
    { worldMatrix: window.__T(0.45,  0.5, 0), tint: [1,0,0,1], alpha: 1.0 },
  ]);
  return { half: window.__sample(30, 120), full: window.__sample(150, 120) };
})()`);
if (r6.full[0] > 220 && r6.half[0] > 90 && r6.half[0] < 170)
  ok('per-instance alpha × tint (full=' + r6.full[0] + ', half=' + r6.half[0] + ')');
else fail('alpha×tint wrong: half=' + r6.half + ' full=' + r6.full);

await browser.close();
server.close();
if (failures === 0) console.log('\nBUNDLE-INSTANCED-TINT PASS');
else console.log(`\nBUNDLE-INSTANCED-TINT FAIL (${failures})`);
process.exit(failures ? 1 : 0);
