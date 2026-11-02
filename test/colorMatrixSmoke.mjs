// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colorMatrixSmoke.mjs — dual-tint fill recolor.
//
// Per-draw 4×4 color matrix applied to vFill/vStroke after override
// + tint, before coverage. Verifies:
//   T1 — no matrix → identity render (passthrough; backward compat).
//   T2 — identity matrix + zero offset → same as T1 (matrix path is
//        a no-op when set to identity).
//   T3 — dualTint(primary=red, contrast=blue) on an SVG with two
//        shapes:
//          - shape with `fill="#FF0000"` (R=1, G=0, B=0) → red output.
//          - shape with `fill="#0000FF"` (R=0, G=0, B=1) → blue output.
//        i.e. the matrix maps the "channel encoding" to the per-instance
//        tint pair.
//   T4 — dualTint(primary=green, contrast=magenta) on the same SVG →
//        first shape renders green, second renders magenta. Confirms the
//        recolor is parameter-driven (not hard-coded).
//   T5 — monochrome(yellow) → all colors map to yellow-weighted luminance.
//   T6 — non-recolor draw immediately after a recolor draw on the same
//        renderer reverts to passthrough (state is per-draw, not sticky).

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'color-matrix');
mkdirSync(OUT, { recursive: true });

// Tiny SVG with two side-by-side rects: left red, right blue.
const SVG_TWO_RECTS = readFileSync(
  new URL('../examples/smoke/colorMatrix__SVG_TWO_RECTS.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import {
  importSvg, createBundle, createRenderer, loadShaders,
  colorMatrixDualTint, colorMatrixIdentity, colorMatrixMonochrome,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);

const SVG = ${JSON.stringify(SVG_TWO_RECTS)};
const sections = await importSvg(SVG);
const bundle = createBundle(gl, sections);

function readSample(x, y) {
  const buf = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return [buf[0], buf[1], buf[2], buf[3]];
}

async function drawAndSnapshot(opts) {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id, ...opts });
  renderer.endFrame();
  // sample left rect (x=25, y=50) and right rect (x=75, y=50)
  const leftPx  = readSample(25, 50);
  const rightPx = readSample(75, 50);
  return {
    leftPx, rightPx,
    pngDataUrl: cnv.toDataURL('image/png'),
  };
}

const out = {};
// T1 — no matrix
out.T1_baseline = await drawAndSnapshot({});
// T2 — identity matrix
{
  const { matrix, offset } = colorMatrixIdentity();
  out.T2_identity = await drawAndSnapshot({ colorMatrix: matrix, colorMatrixOffset: offset });
}
// T3 — dualTint(primary=red, contrast=blue) — should be identity for this SVG
{
  const { matrix, offset } = colorMatrixDualTint([1, 0, 0, 1], [0, 0, 1, 1]);
  out.T3_dualTint_id = await drawAndSnapshot({ colorMatrix: matrix, colorMatrixOffset: offset });
}
// T4 — dualTint(primary=green, contrast=magenta)
{
  const { matrix, offset } = colorMatrixDualTint([0, 1, 0, 1], [1, 0, 1, 1]);
  out.T4_dualTint_swap = await drawAndSnapshot({ colorMatrix: matrix, colorMatrixOffset: offset });
}
// T5 — monochrome(yellow)
{
  const { matrix, offset } = colorMatrixMonochrome([1, 1, 0, 1]);
  out.T5_monochrome = await drawAndSnapshot({ colorMatrix: matrix, colorMatrixOffset: offset });
}
// T6 — no matrix immediately after T4 / T5 — state must not leak.
out.T6_revert = await drawAndSnapshot({});

window.__results = out;
window.__done = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('  [console]', msg.text());
});
await page.setViewport({ width: 200, height: 200 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 });
const results = await page.evaluate(() => window.__results);
await browser.close();
server.close();

for (const k of Object.keys(results)) {
  writeFileSync(
    path.join(OUT, k + '.png'),
    Buffer.from(results[k].pngDataUrl.slice('data:image/png;base64,'.length), 'base64'),
  );
}

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const close = (a, b, tol = 6) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

// T1 — baseline: left red, right blue.
{
  const t = results.T1_baseline;
  console.log(
    `T1 baseline:    left=${t.leftPx.slice(0, 3).join(',')}  right=${t.rightPx.slice(0, 3).join(',')}`,
  );
  if (close(t.leftPx, [255, 0, 0])) ok('T1 baseline left is red');
  else fail(`T1 baseline left expected (255,0,0), got ${t.leftPx.slice(0, 3).join(',')}`);
  if (close(t.rightPx, [0, 0, 255])) ok('T1 baseline right is blue');
  else fail(`T1 baseline right expected (0,0,255), got ${t.rightPx.slice(0, 3).join(',')}`);
}

// T2 — identity matrix matches baseline.
{
  const t = results.T2_identity;
  console.log(
    `T2 identity:    left=${t.leftPx.slice(0, 3).join(',')}  right=${t.rightPx.slice(0, 3).join(',')}`,
  );
  if (close(t.leftPx, [255, 0, 0])) ok('T2 identity matrix leaves left red');
  else fail(`T2 identity left got ${t.leftPx.slice(0, 3).join(',')}`);
  if (close(t.rightPx, [0, 0, 255])) ok('T2 identity matrix leaves right blue');
  else fail(`T2 identity right got ${t.rightPx.slice(0, 3).join(',')}`);
}

// T3 — dualTint(red, blue) on red+blue SVG is effectively identity.
{
  const t = results.T3_dualTint_id;
  console.log(
    `T3 dualTint(R,B): left=${t.leftPx.slice(0, 3).join(',')}  right=${t.rightPx.slice(0, 3).join(',')}`,
  );
  if (close(t.leftPx, [255, 0, 0])) ok('T3 dualTint(red,blue): red shape → primary (red)');
  else fail(`T3 left got ${t.leftPx.slice(0, 3).join(',')}`);
  if (close(t.rightPx, [0, 0, 255])) ok('T3 dualTint(red,blue): blue shape → contrast (blue)');
  else fail(`T3 right got ${t.rightPx.slice(0, 3).join(',')}`);
}

// T4 — dualTint(green, magenta).
{
  const t = results.T4_dualTint_swap;
  console.log(
    `T4 dualTint(G,M): left=${t.leftPx.slice(0, 3).join(',')}  right=${t.rightPx.slice(0, 3).join(',')}`,
  );
  if (close(t.leftPx, [0, 255, 0])) ok('T4 dualTint(green,magenta): red shape → primary (green)');
  else fail(`T4 left expected green, got ${t.leftPx.slice(0, 3).join(',')}`);
  if (close(t.rightPx, [255, 0, 255]))
    ok('T4 dualTint(green,magenta): blue shape → contrast (magenta)');
  else fail(`T4 right expected magenta, got ${t.rightPx.slice(0, 3).join(',')}`);
}

// T5 — monochrome(yellow). Rec. 709 luminance for pure red is 0.2126;
//      multiplied by yellow=(1,1,0) gives (54, 54, 0).
//      For pure blue luminance is 0.0722 → (18, 18, 0).
{
  const t = results.T5_monochrome;
  console.log(
    `T5 monochrome(Y): left=${t.leftPx.slice(0, 3).join(',')}  right=${t.rightPx.slice(0, 3).join(',')}`,
  );
  if (close(t.leftPx, [54, 54, 0], 10))
    ok('T5 monochrome(yellow): red shape → yellow-weighted Y-luminance');
  else fail(`T5 left expected ~(54,54,0), got ${t.leftPx.slice(0, 3).join(',')}`);
  if (close(t.rightPx, [18, 18, 0], 10))
    ok('T5 monochrome(yellow): blue shape → yellow-weighted Y-luminance');
  else fail(`T5 right expected ~(18,18,0), got ${t.rightPx.slice(0, 3).join(',')}`);
}

// T6 — state revert: drawing without colorMatrix after a recolor draw
//      must return to baseline. Catches a sticky-uniform bug.
{
  const t = results.T6_revert;
  console.log(
    `T6 revert:      left=${t.leftPx.slice(0, 3).join(',')}  right=${t.rightPx.slice(0, 3).join(',')}`,
  );
  if (close(t.leftPx, [255, 0, 0])) ok('T6 state revert: left back to red');
  else fail(`T6 left expected red, got ${t.leftPx.slice(0, 3).join(',')}`);
  if (close(t.rightPx, [0, 0, 255])) ok('T6 state revert: right back to blue');
  else fail(`T6 right expected blue, got ${t.rightPx.slice(0, 3).join(',')}`);
}

console.log(`\nPNGs saved to ${OUT}`);
if (failures > 0) {
  console.error(`\nCOLOR-MATRIX FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCOLOR-MATRIX PASS');
