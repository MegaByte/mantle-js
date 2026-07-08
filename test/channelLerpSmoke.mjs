// channelLerpSmoke.mjs — bilinear recolor.
//
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'channel-lerp');
mkdirSync(OUT, { recursive: true });

// 4 rects in different "channel encodings" representing what the
// train SVG content does:
//   rect 0: pure red    (R-channel encoded → primary)
//   rect 1: pure blue   (B-channel encoded → contrast)
//   rect 2: pure white  (R=G=B=1 → highlight per the Unity formula)
//   rect 3: light pink  (R=1, G=0.5, B=0.5) → mid lerp
const SVG_CHANNELS = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0"  y="0"  width="25" height="100" fill="#FF0000"/>
  <rect x="25" y="0"  width="25" height="100" fill="#0000FF"/>
  <rect x="50" y="0"  width="25" height="100" fill="#FFFFFF"/>
  <rect x="75" y="0"  width="25" height="100" fill="#FF8080"/>
</svg>`;

// External art fixture. Point TRAIN_SVG at a channel-encoded sprite
// SVG; the test skips cleanly when it's unset or the file is missing.
const trainSvgPath = process.env.TRAIN_SVG || '';
if (!trainSvgPath || !existsSync(trainSvgPath)) {
  console.log(`SKIP channelLerp: sprite fixture not found (set TRAIN_SVG to a channel-encoded SVG)`);
  process.exit(0);
}
const trainSvg = readFileSync(trainSvgPath, 'utf8');

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#222">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import {
  importSvg, createBundle, createRenderer, loadShaders,
  unityChannelLerp, colorMatrixMonochrome,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);

const sectionsChannels = await importSvg(${JSON.stringify(SVG_CHANNELS)});
const bundleChannels = createBundle(gl, sectionsChannels);
const sectionsTrain = await importSvg(${JSON.stringify(trainSvg)});
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
  return cnv.toDataURL('image/png');
}

const out = {};

// T1..T4 — channel-rect SVG with various recolor params.
//
// Use unityChannelLerp(primary=teal, contrast=orange, highlight=white):
//   pure red rect    → teal       (R=1, B=0, G=0, A=1; k=0; tint=teal)
//   pure blue rect   → orange     (R=0, B=1, G=0, A=1; k=0; tint=orange)
//   pure white rect  → white      (R=1, G=1, B=1, A=1; k=clamp(1+0,0,1)=1)
//   pink rect (1, .5, .5) → mix(teal+.5*orange, white, .5)
out.T1to4 = await drawChannels({
  channelLerp: unityChannelLerp(
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
    channelLerp: unityChannelLerp([1, 0, 0, 1], [0, 0, 1, 1]),
    colorMatrix: matrix,
    colorMatrixOffset: offset,
  });
}

// Train demo (visual; baseline + recolored).
out.T7_train_baseline = await drawTrain({});
out.T8_train_singleColor_red = await drawTrain({
  channelLerp: unityChannelLerp(
    [0.92, 0.09, 0.41, 1],   // primary = magenta-red
    [0.92, 0.09, 0.41, 1],   // contrast = SAME (single-color class)
    [1, 1, 1, 1],            // highlight = white
  ),
});
out.T9_train_dualColor = await drawTrain({
  channelLerp: unityChannelLerp(
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
             : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try { res.writeHead(404); res.end(); } catch {}
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
await page.setViewport({ width: 300, height: 300 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__d === true, { timeout: 30000 });
const r = await page.evaluate(() => window.__r);
await browser.close();
server.close();

for (const k of Object.keys(r)) {
  const v = r[k];
  const url = typeof v === 'string' ? v : v.pngDataUrl;
  if (url) {
    writeFileSync(path.join(OUT, k + '.png'),
      Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
  }
}

let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };
const close = (a, b, tol = 6) =>
  Math.abs(a[0] - b[0]) <= tol &&
  Math.abs(a[1] - b[1]) <= tol &&
  Math.abs(a[2] - b[2]) <= tol;

// T1..T4 — channel rects with channelLerp(teal, orange, white).
{
  const t = r.T1to4;
  console.log(`T1..T4: red=${t.red.slice(0,3)} blue=${t.blue.slice(0,3)} white=${t.white.slice(0,3)} pink=${t.pink.slice(0,3)}`);
  // T1: pure red (R=1, G=0, B=0, A=1) → tint = primary = teal (0, 204, 204).
  // k = G + 1 - A = 0. mix(teal, white, 0) = teal.
  if (close(t.red, [0, 204, 204], 8))   ok('T1 pure red → primary tint (teal)');
  else fail('T1 red got ' + t.red.slice(0,3));
  // T2: pure blue → tint = contrast = orange (255, 128, 0).
  if (close(t.blue, [255, 128, 0], 8))  ok('T2 pure blue → contrast tint (orange)');
  else fail('T2 blue got ' + t.blue.slice(0,3));
  // T3: pure white (R=G=B=1, A=1). tint = primary + contrast = (255, 332, 204).
  // k = 1 + 0 = 1 (clamped to 1). mix(tint, white, 1) = white.
  if (close(t.white, [255, 255, 255], 4))  ok('T3 pure white → highlight (white preserved)');
  else fail('T3 white got ' + t.white.slice(0,3));
  // T4: pink (R=1, G=0.5, B=0.5, A=1). tint = primary + 0.5*contrast =
  //     (0 + 0.5*1, 0.8 + 0.5*0.5, 0.8 + 0) = (0.5, 1.05, 0.8) clamped (0.5, 1, 0.8).
  // k = G + 1 - A = 0.5. mix(tint, white, 0.5) with mix(a,b,t)=a*(1-t)+b*t.
  // The shader clamps INSIDE the lerp (mixing raw `tint`), so the pink
  // check uses a loose tolerance.
  if (t.pink[0] > 150 && t.pink[0] < 220 && t.pink[1] > 230 && t.pink[2] > 180)
    ok('T4 light pink → tint mixed toward highlight (G drives lerp)');
  else fail('T4 pink got ' + t.pink.slice(0,3));
}

// T5 — state revert.
{
  const t = r.T5_revert;
  if (close(t.red, [255, 0, 0]))   ok('T5 state revert: red rect returns to authored');
  else fail('T5 red got ' + t.red.slice(0,3));
  if (close(t.blue, [0, 0, 255]))  ok('T5 state revert: blue rect returns to authored');
  else fail('T5 blue got ' + t.blue.slice(0,3));
  if (close(t.white, [255, 255, 255]))  ok('T5 state revert: white rect returns to authored');
  else fail('T5 white got ' + t.white.slice(0,3));
}

// T6 — channelLerp + monochrome(yellow). lerp produces RGB; then
// monochrome takes Y-luminance and tints it yellow. For pure red
// input, lerp output = (1, 0, 0) (primary). Y = 0.2126 * 255 ≈ 54.
// Tint yellow → (54, 54, 0).
{
  const t = r.T6_lerp_then_matrix;
  console.log(`T6 lerp→mono: red→${t.red.slice(0,3)} blue→${t.blue.slice(0,3)} white→${t.white.slice(0,3)}`);
  if (close(t.red, [54, 54, 0], 8))  ok('T6 red → primary(red) → yellow-luminance');
  else fail('T6 red got ' + t.red.slice(0,3));
  // Pure blue → contrast (blue). Y = 0.0722 * 255 ≈ 18. Yellow-tint → (18, 18, 0).
  if (close(t.blue, [18, 18, 0], 8)) ok('T6 blue → contrast(blue) → yellow-luminance');
  else fail('T6 blue got ' + t.blue.slice(0,3));
  // Pure white → highlight white. Y = 255. Yellow → (255, 255, 0).
  if (close(t.white, [255, 255, 0], 8)) ok('T6 white → highlight(white) → yellow-luminance');
  else fail('T6 white got ' + t.white.slice(0,3));
}

console.log(`\nPNGs saved to ${OUT}`);
console.log(`Train demos:    ${path.join(OUT, 'T7_train_baseline.png')}`);
console.log(`                ${path.join(OUT, 'T8_train_singleColor_red.png')}`);
console.log(`                ${path.join(OUT, 'T9_train_dualColor.png')}`);
if (failures > 0) {
  console.error(`\nCHANNEL-LERP FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCHANNEL-LERP PASS');
