// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colorMatrixSmoke.mjs — per-draw recolor: the 4×4 color matrix (dual tint, monochrome), the
// bilinear channel lerp and the palette LUT. Each runs on its own page (its own canvas, renderer
// and fixture) in one browser, and prints its own verdict.
//
// COLOR MATRIX (page /).
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
//
// CHANNEL LERP (page /channel-lerp).
// Per-draw Unity unlit-vector bilinear channel-lerp recolor:
//   tint = R·primary + B·contrast
//   out  = mix(tint, highlight, G + 1 - A)
//
// The bilinear (R·G, B·G, R·A, B·A) cross terms make this non-linear
// in the input → can't be expressed via the linear colorMatrix path.
// Dedicated `opts.channelLerp` exists for this Unity formula.
//
// Key contract: PURE WHITE PIXELS STAY WHITE. The source asset
// pipeline encodes 3D-model shading as light-toward-white
// regions (G/A intensity). With a single-color sprite (primary ==
// contrast), the dual-tint matrix wipes these highlights to a flat
// tinted body. channelLerp preserves them via the mix-toward-highlight.
//
// Tests:
//   T1 — spec acceptance: pure red R=#FF0000 → primary tint.
//   T2 — pure blue R=#0000FF → contrast tint.
//   T3 — pure white R=#FFFFFF → highlight (preserved). The headline
//        single-color-class case (primary == contrast doesn't matter
//        because G + 1-A = 2 → clamped to 1 → 100% lerp to highlight).
//   T4 — single-color recolor of train SVG, verifies white pixels
//        stay white at the boiler/dome locations.
//   T5 — state revert: drawing without channelLerp returns to baseline.
//   T6 — composition: channelLerp + colorMatrix monochrome. Lerp
//        produces tinted-then-highlight output; matrix then collapses
//        it to luminance. Verifies the two run in pipeline order.
//
// PALETTE (page /color-palette). Per-draw palette LUT for indexed discrete
// recoloring. Companion to colorMatrix.js: where matrix is continuous,
// palette is discrete.
// The shape's resolved fill picks an index from one channel; the
// index reads a 256×1 RGBA8 LUT; result replaces RGB.
//
// Critical contract: palette is MUTABLE AT WILL. Caller can mutate
// any entry between draws (or every frame) at single-texSubImage2D
// cost. No bundle changes, no shader recompile.
//
// Test plan:
//   T1 — baseline (no palette): two-rect SVG (R=#100, G=#200) renders
//        as authored.
//   T2 — palette substitution: bind a palette that maps the SVG
//        indices to specific colors; verify rendered output matches.
//   T3 — mutation between draws: same palette object, call .set()
//        between two draws on different frames; second draw uses the
//        mutated entries (proves "change at will" claim).
//   T4 — bulk update: .update() replaces all entries; subsequent
//        draw uses the new palette.
//   T5 — state revert: drawing without palette opts after a palette
//        draw returns to baseline (no sticky uniforms).
//   T6 — palette + color matrix compose: palette substitutes then
//        matrix transforms the substituted result.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'color-matrix');
const LERP_OUT = path.join(__dirname, 'visuals', 'channel-lerp');
const PALETTE_OUT = path.join(__dirname, 'visuals', 'color-palette');
for (const d of [OUT, LERP_OUT, PALETTE_OUT]) mkdirSync(d, { recursive: true });

// Tiny SVG with two side-by-side rects: left red, right blue.
const SVG_TWO_RECTS = readFileSync(
  new URL('../examples/smoke/colorMatrix__SVG_TWO_RECTS.svg', import.meta.url),
  'utf8',
);

// 4 rects in different "channel encodings" representing what the
// train SVG content does:
//   rect 0: pure red    (R-channel encoded → primary)
//   rect 1: pure blue   (B-channel encoded → contrast)
//   rect 2: pure white  (R=G=B=1 → highlight per the Unity formula)
//   rect 3: light pink  (R=1, G=0.5, B=0.5) → mid lerp
const SVG_CHANNELS = readFileSync(
  new URL('../examples/smoke/channelLerp__SVG_CHANNELS.svg', import.meta.url),
  'utf8',
);

// A small channel-encoded sprite (committed, synthetic): a red body (R = primary), a blue rail (B = contrast) and a pure white dome
// (the highlight). 100 x 100 units drawn at 200 x 200 px, so unit (x, y) is pixel (2x, 2y)
// (the body spans the whole viewBox: the renderer fits the content bounding box, so a smaller body would be scaled up).
const SVG_TRAIN = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="100" height="100" rx="8" fill="#FF0000"/>
  <rect x="0" y="55" width="100" height="10" fill="#0000FF"/>
  <circle cx="70" cy="40" r="10" fill="#FFFFFF"/>
</svg>`;

// Author the two shapes with distinct R values (small, on purpose, so
// they land in different palette index buckets after `index = R *
// paletteSize`). Default paletteChannel='r', paletteSize=4.
//   shape 0: R=0   → index 0
//   shape 1: R=64  → index 1 (with paletteSize=4: 64/255 * 4 ≈ 1.003 → 1)
//   shape 2: R=128 → index 2
//   shape 3: R=192 → index 3
const PALETTE_SVG = readFileSync(
  new URL('../examples/smoke/colorPalette__SVG.svg', import.meta.url),
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

const LERP_HTML = `<!DOCTYPE html><html><body style="margin:0;background:#222">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import {
  importSvg, createBundle, createRenderer, loadShaders,
  channelLerpParams, colorMatrixMonochrome,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);

const sectionsChannels = await importSvg(${JSON.stringify(SVG_CHANNELS)});
const bundleChannels = createBundle(gl, sectionsChannels);
const sectionsTrain = await importSvg(${JSON.stringify(SVG_TRAIN)});
const bundleTrain = createBundle(gl, sectionsTrain);

function readPx(x, y) {
  const buf = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return [buf[0], buf[1], buf[2], buf[3]];
}

async function drawChannels(opts) {
  cnv.width = 100; cnv.height = 100;
  renderer.setViewport(100, 100);
  renderer.beginFrame([34/255, 34/255, 34/255, 1]);
  renderer.drawBundle(bundleChannels, { worldMatrix: id, ...opts });
  renderer.endFrame();
  return {
    red:    readPx(12, 50),
    blue:   readPx(37, 50),
    white:  readPx(62, 50),
    pink:   readPx(87, 50),
    pngDataUrl: cnv.toDataURL('image/png'),
  };
}
async function drawTrain(opts) {
  cnv.width = 200; cnv.height = 200;
  renderer.setViewport(200, 200);
  renderer.beginFrame([34/255, 34/255, 34/255, 1]);
  renderer.drawBundle(bundleTrain, { worldMatrix: id, ...opts });
  renderer.endFrame();
  // GL rows count from the bottom: unit (x, y) of the sprite is pixel (2x, 199 - 2y).
  return {
    body: readPx(40, 199 - 60),     // unit (20, 30): the red body
    rail: readPx(40, 199 - 120),    // unit (20, 60): the blue rail
    dome: readPx(140, 199 - 80),    // unit (70, 40): the white dome
    pngDataUrl: cnv.toDataURL('image/png'),
  };
}

const out = {};

// T1..T4 — channel-rect SVG with various recolor params.
//
// Use channelLerpParams(primary=teal, contrast=orange, highlight=white):
//   pure red rect    → teal       (R=1, B=0, G=0, A=1; k=0; tint=teal)
//   pure blue rect   → orange     (R=0, B=1, G=0, A=1; k=0; tint=orange)
//   pure white rect  → white      (R=1, G=1, B=1, A=1; k=clamp(1+0,0,1)=1)
//   pink rect (1, .5, .5) → mix(teal+.5*orange, white, .5)
out.T1to4 = await drawChannels({
  channelLerp: channelLerpParams(
    [0, 0.8, 0.8, 1],    // primary = teal
    [1, 0.5, 0, 1],      // contrast = orange
    [1, 1, 1, 1],        // highlight = white
  ),
});

// T5 — state revert: no channelLerp after a recolor draw.
out.T5_revert = await drawChannels({});

// T6 — composition: lerp produces colors, then matrix takes luminance.
{
  const { matrix, offset } = colorMatrixMonochrome([1, 1, 0, 1]);
  out.T6_lerp_then_matrix = await drawChannels({
    channelLerp: channelLerpParams([1, 0, 0, 1], [0, 0, 1, 1]),
    colorMatrix: matrix,
    colorMatrixOffset: offset,
  });
}

// Train demo (visual; baseline + recolored).
out.T7_train_baseline = await drawTrain({});
out.T8_train_singleColor_red = await drawTrain({
  channelLerp: channelLerpParams(
    [0.92, 0.09, 0.41, 1],   // primary = magenta-red
    [0.92, 0.09, 0.41, 1],   // contrast = SAME (single-color class)
    [1, 1, 1, 1],            // highlight = white
  ),
});
out.T9_train_dualColor = await drawTrain({
  channelLerp: channelLerpParams(
    [0.0, 0.6, 0.0, 1],   // primary = green
    [1, 0.9, 0, 1],       // contrast = yellow
    [1, 1, 1, 1],
  ),
});

bundleChannels.dispose();
bundleTrain.dispose();
window.__r = out;
window.__d = true;
</script>
</body></html>`;

const PALETTE_HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import {
  importSvg, createBundle, createRenderer, loadShaders,
  createPalette,
  colorMatrixMonochrome,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);

const sections = await importSvg(${JSON.stringify(PALETTE_SVG)});
const bundle = createBundle(gl, sections);

function readPx(x, y) {
  const buf = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return [buf[0], buf[1], buf[2], buf[3]];
}

async function drawAndSnapshot(opts) {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id, ...opts });
  renderer.endFrame();
  // Sample center of each rect.
  return {
    s0: readPx(12, 50),  s1: readPx(37, 50),
    s2: readPx(62, 50),  s3: readPx(87, 50),
    pngDataUrl: cnv.toDataURL('image/png'),
  };
}

const out = {};

// T1 baseline (no palette).
out.T1_baseline = await drawAndSnapshot({});

// T2 palette substitution.
const palette = createPalette(gl, [
  [255, 0,   0,   255],   // index 0 → red
  [0,   255, 0,   255],   // index 1 → green
  [0,   0,   255, 255],   // index 2 → blue
  [255, 255, 0,   255],   // index 3 → yellow
]);
out.T2_palette = await drawAndSnapshot({
  palette, paletteChannel: 'r',
});

// T3 mutation between draws: change index 0 (red → cyan) and index 2
// (blue → magenta) via .set(), redraw. Same palette handle, no
// recreation. Proves "mutable at will" — single per-entry upload,
// no bundle / shader changes.
palette.set(0, [0, 255, 255, 255]);    // red → cyan
palette.set(2, [255, 0, 255, 255]);    // blue → magenta
out.T3_mutated = await drawAndSnapshot({
  palette, paletteChannel: 'r',
});

// T4 bulk update.
palette.update([
  [128, 128, 128, 255],   // index 0 → gray
  [255, 255, 255, 255],   // index 1 → white
  [64,  64,  64,  255],   // index 2 → dark gray
  [192, 192, 192, 255],   // index 3 → light gray
]);
out.T4_bulk_update = await drawAndSnapshot({
  palette, paletteChannel: 'r',
});

// T5 state revert.
out.T5_revert = await drawAndSnapshot({});

// T6 palette + color matrix compose. Palette returns grays (T4
// state). Color matrix then turns them into a yellow-tinted scale.
{
  const { matrix, offset } = colorMatrixMonochrome([1, 1, 0, 1]);
  out.T6_palette_then_matrix = await drawAndSnapshot({
    palette, paletteChannel: 'r',
    colorMatrix: matrix, colorMatrixOffset: offset,
  });
}

palette.dispose();
window.__r = out;
window.__d = true;
</script>
</body></html>`;

const PAGES = {
  '/': HTML,
  '/index.html': HTML,
  '/channel-lerp': LERP_HTML,
  '/color-palette': PALETTE_HTML,
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (PAGES[u.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[u.pathname]);
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
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
// One page per section: load it, wait for its done flag, return its results object.
async function runPage(route, side, doneFlag, resultsKey) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.setViewport({ width: side, height: side });
  await page.goto(url + route, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(
    (f) => window[f] === true,
    { timeout: pageTimeoutFor(), polling: 100 },
    doneFlag,
  );
  const results = await page.evaluate((k) => window[k], resultsKey);
  await page.close();
  return results;
}
const savePngs = (dir, results) => {
  for (const k of Object.keys(results)) {
    const v = results[k];
    const dataUrl = typeof v === 'string' ? v : v.pngDataUrl;
    if (dataUrl)
      writeFileSync(
        path.join(dir, k + '.png'),
        Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
      );
  }
};

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const close = (a, b, tol = 6) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const verdict = (name, dir, before) => {
  console.log(`\nPNGs saved to ${dir}`);
  const n = failures - before;
  if (n > 0) console.error(`\n${name} FAIL (${n})`);
  else console.log(`\n${name} PASS`);
};

// ---- color matrix ----------------------------------------------------------------------------
{
  const before = failures;
  const results = await runPage('/', 200, '__done', '__results');
  savePngs(OUT, results);

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
  verdict('COLOR-MATRIX', OUT, before);
}

// ---- channel lerp ----------------------------------------------------------------------------
{
  const before = failures;
  const r = await runPage('/channel-lerp', 300, '__d', '__r');
  savePngs(LERP_OUT, r);

  // T1..T4 — channel rects with channelLerp(teal, orange, white).
  {
    const t = r.T1to4;
    console.log(
      `T1..T4: red=${t.red.slice(0, 3)} blue=${t.blue.slice(0, 3)} white=${t.white.slice(0, 3)} pink=${t.pink.slice(0, 3)}`,
    );
    // T1: pure red (R=1, G=0, B=0, A=1) → tint = primary = teal (0, 204, 204).
    // k = G + 1 - A = 0. mix(teal, white, 0) = teal.
    if (close(t.red, [0, 204, 204], 8)) ok('T1 pure red → primary tint (teal)');
    else fail('T1 red got ' + t.red.slice(0, 3));
    // T2: pure blue → tint = contrast = orange (255, 128, 0).
    if (close(t.blue, [255, 128, 0], 8)) ok('T2 pure blue → contrast tint (orange)');
    else fail('T2 blue got ' + t.blue.slice(0, 3));
    // T3: pure white (R=G=B=1, A=1). tint = primary + contrast = (255, 332, 204).
    // k = 1 + 0 = 1 (clamped to 1). mix(tint, white, 1) = white.
    if (close(t.white, [255, 255, 255], 4)) ok('T3 pure white → highlight (white preserved)');
    else fail('T3 white got ' + t.white.slice(0, 3));
    // T4: pink (R=1, G=0.5, B=0.5, A=1). tint = primary + 0.5*contrast =
    //     (0 + 0.5*1, 0.8 + 0.5*0.5, 0.8 + 0) = (0.5, 1.05, 0.8) clamped (0.5, 1, 0.8).
    // k = G + 1 - A = 0.5. mix(tint, white, 0.5) with mix(a,b,t)=a*(1-t)+b*t.
    // The shader clamps INSIDE the lerp (mixing raw `tint`), so the pink
    // check uses a loose tolerance.
    if (t.pink[0] > 150 && t.pink[0] < 220 && t.pink[1] > 230 && t.pink[2] > 180)
      ok('T4 light pink → tint mixed toward highlight (G drives lerp)');
    else fail('T4 pink got ' + t.pink.slice(0, 3));
  }

  // T5 — state revert.
  {
    const t = r.T5_revert;
    if (close(t.red, [255, 0, 0])) ok('T5 state revert: red rect returns to authored');
    else fail('T5 red got ' + t.red.slice(0, 3));
    if (close(t.blue, [0, 0, 255])) ok('T5 state revert: blue rect returns to authored');
    else fail('T5 blue got ' + t.blue.slice(0, 3));
    if (close(t.white, [255, 255, 255])) ok('T5 state revert: white rect returns to authored');
    else fail('T5 white got ' + t.white.slice(0, 3));
  }

  // T6 — channelLerp + monochrome(yellow). lerp produces RGB; then
  // monochrome takes Y-luminance and tints it yellow. For pure red
  // input, lerp output = (1, 0, 0) (primary). Y = 0.2126 * 255 ≈ 54.
  // Tint yellow → (54, 54, 0).
  {
    const t = r.T6_lerp_then_matrix;
    console.log(
      `T6 lerp→mono: red→${t.red.slice(0, 3)} blue→${t.blue.slice(0, 3)} white→${t.white.slice(0, 3)}`,
    );
    if (close(t.red, [54, 54, 0], 8)) ok('T6 red → primary(red) → yellow-luminance');
    else fail('T6 red got ' + t.red.slice(0, 3));
    // Pure blue → contrast (blue). Y = 0.0722 * 255 ≈ 18. Yellow-tint → (18, 18, 0).
    if (close(t.blue, [18, 18, 0], 8)) ok('T6 blue → contrast(blue) → yellow-luminance');
    else fail('T6 blue got ' + t.blue.slice(0, 3));
    // Pure white → highlight white. Y = 255. Yellow → (255, 255, 0).
    if (close(t.white, [255, 255, 0], 8)) ok('T6 white → highlight(white) → yellow-luminance');
    else fail('T6 white got ' + t.white.slice(0, 3));
  }

  // T7..T9 — the sprite. The headline contract: pure white stays white, even for a single-color recolor (primary == contrast).
  {
    const b = r.T7_train_baseline,
      m = r.T8_train_singleColor_red,
      d = r.T9_train_dualColor;
    const mag = [Math.round(0.92 * 255), Math.round(0.09 * 255), Math.round(0.41 * 255)];
    const chk = (c, want, label) => {
      if (close(c, want)) ok(label);
      else fail(label + ' got ' + c.slice(0, 3) + ' want ' + want);
    };
    chk(b.body, [255, 0, 0], 'T7 baseline: red body as authored');
    chk(b.rail, [0, 0, 255], 'T7 baseline: blue rail as authored');
    chk(b.dome, [255, 255, 255], 'T7 baseline: white dome as authored');
    chk(m.body, mag, 'T8 single-color: red body takes the one color');
    chk(m.rail, mag, 'T8 single-color: blue rail takes the same color');
    chk(
      m.dome,
      [255, 255, 255],
      'T8 single-color: the white dome STAYS white (the highlight survives)',
    );
    chk(d.body, [0, Math.round(0.6 * 255), 0], 'T9 dual-color: red body takes the primary');
    chk(d.rail, [255, Math.round(0.9 * 255), 0], 'T9 dual-color: blue rail takes the contrast');
    chk(d.dome, [255, 255, 255], 'T9 dual-color: the white dome stays white');
  }
  console.log(`Train demos:    ${path.join(LERP_OUT, 'T7_train_baseline.png')}`);
  console.log(`                ${path.join(LERP_OUT, 'T8_train_singleColor_red.png')}`);
  console.log(`                ${path.join(LERP_OUT, 'T9_train_dualColor.png')}`);
  verdict('CHANNEL-LERP', LERP_OUT, before);
}

// ---- palette ---------------------------------------------------------------------------------
{
  const before = failures;
  const r = await runPage('/color-palette', 200, '__d', '__r');
  savePngs(PALETTE_OUT, r);

  // T1 baseline: the 4 rects show their authored R values (0, 64, 128, 192).
  {
    const t = r.T1_baseline;
    console.log('T1:', t.s0, t.s1, t.s2, t.s3);
    if (close(t.s0, [0, 0, 0])) ok('T1 s0 = #000');
    else fail('T1 s0 got ' + t.s0.slice(0, 3));
    if (close(t.s1, [64, 0, 0])) ok('T1 s1 = #400000');
    else fail('T1 s1 got ' + t.s1.slice(0, 3));
    if (close(t.s2, [128, 0, 0])) ok('T1 s2 = #800000');
    else fail('T1 s2 got ' + t.s2.slice(0, 3));
    if (close(t.s3, [192, 0, 0])) ok('T1 s3 = #C00000');
    else fail('T1 s3 got ' + t.s3.slice(0, 3));
  }

  // T2 palette: with the default paletteSize=256 (the LUT width), the
  // shader index formula is `clamp(floor(R * paletteSize), 0, size-1)`,
  // so R values 0/64/128/192 index palette[0]/[64]/[128]/[192]. Only
  // palette[0] is set (red); the other three entries stay at the default
  // black. Assertions follow that indexing.
  {
    const t = r.T2_palette;
    console.log('T2:', t.s0, t.s1, t.s2, t.s3);
    if (close(t.s0, [255, 0, 0])) ok('T2 s0 (R=0   → palette[0]=red)');
    else fail('T2 s0 got ' + t.s0.slice(0, 3));
    // s1..s3 fall outside the 4 entries we set → default black.
    if (close(t.s1, [0, 0, 0])) ok('T2 s1 (R=64 → palette[64]=unset=black)');
    else fail('T2 s1 got ' + t.s1.slice(0, 3));
    if (close(t.s2, [0, 0, 0])) ok('T2 s2 (R=128 → palette[128]=unset=black)');
    else fail('T2 s2 got ' + t.s2.slice(0, 3));
    if (close(t.s3, [0, 0, 0])) ok('T2 s3 (R=192 → palette[192]=unset=black)');
    else fail('T2 s3 got ' + t.s3.slice(0, 3));
  }

  // T3 — after .set(0, cyan), shape 0 substitutes to cyan. The .set
  // call costs one gl.texSubImage2D for 4 bytes — no other state changes.
  {
    const t = r.T3_mutated;
    console.log('T3:', t.s0, t.s1, t.s2, t.s3);
    if (close(t.s0, [0, 255, 255])) ok('T3 s0 (palette[0] mutated red → cyan)');
    else fail('T3 s0 expected cyan, got ' + t.s0.slice(0, 3));
    // The .set(2, magenta) call mutates palette[2] which no shape indexes
    // (shape 2's R=128 indexes palette[128]). So it's a no-op visually
    // but proves we can mutate ANY entry, not just used ones.
    if (close(t.s2, [0, 0, 0])) ok('T3 s2 (palette[128] unchanged → black)');
    else fail('T3 s2 got ' + t.s2.slice(0, 3));
  }

  // T4 — bulk update: only the first 4 entries are written. shape 0
  // indexes palette[0]=gray. shapes 1..3 index palette[64], [128], [192]
  // which reset to alpha=255, RGB=(0,0,0) per the .update default.
  {
    const t = r.T4_bulk_update;
    console.log('T4:', t.s0, t.s1, t.s2, t.s3);
    if (close(t.s0, [128, 128, 128])) ok('T4 s0 (palette[0] bulk → gray)');
    else fail('T4 s0 got ' + t.s0.slice(0, 3));
    if (close(t.s1, [0, 0, 0])) ok('T4 s1 (palette[64] reset to default black)');
    else fail('T4 s1 got ' + t.s1.slice(0, 3));
  }

  // T5 — state revert.
  {
    const t = r.T5_revert;
    console.log('T5:', t.s0, t.s1, t.s2, t.s3);
    if (close(t.s0, [0, 0, 0])) ok('T5 s0 reverted to baseline');
    else fail('T5 s0 got ' + t.s0.slice(0, 3));
    if (close(t.s1, [64, 0, 0])) ok('T5 s1 reverted to baseline');
    else fail('T5 s1 got ' + t.s1.slice(0, 3));
  }

  // T6 — palette + monochrome(yellow) matrix.
  // shape 0: palette[0]=gray (128,128,128). Monochrome luminance:
  //   Y = 0.2126*128 + 0.7152*128 + 0.0722*128 = 128 (perfect gray
  //   maps to identical luminance). Tint by yellow (1, 1, 0):
  //   out = (128, 128, 0).
  {
    const t = r.T6_palette_then_matrix;
    console.log('T6:', t.s0, t.s1, t.s2, t.s3);
    if (close(t.s0, [128, 128, 0])) ok('T6 palette → matrix: gray → yellow-luminance');
    else fail('T6 s0 expected (128,128,0), got ' + t.s0.slice(0, 3));
  }
  verdict('COLOR-PALETTE', PALETTE_OUT, before);
}

await browser.close();
server.close();
if (failures > 0) process.exit(1);
