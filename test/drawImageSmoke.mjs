// drawImageSmoke.mjs — Puppeteer proof of the direct raster-blit API
// (renderer.createImage + renderer.drawImage). Builds a 2×2 RGBA image
// with four distinct opaque quadrants:
//   TL red   TR green
//   BL blue  BR white
// and exercises: plain blit into a dstRect, tint, alpha (over a known
// backdrop), src sub-rect, and a worldMatrix translate. Reads pixels
// with gl.readPixels (bottom-up) and checks each predicate.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

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

// A bundle for the interleave regression: a blue rect in [0..100,0..100].
const __sections = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="0" y="0" width="100" height="100" fill="#0000ff"/></svg>');
window.__bundle = createBundle(gl, __sections);
window.__id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

window.__draw = (calls) => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0.5, 0.5, 0.5, 1]);  // grey backdrop (128,128,128)
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

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain'
    : (p.endsWith('.js') || p.endsWith('.mjs')) ? 'text/javascript' : 'application/octet-stream';
  try { res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };
const near = (a, b, t = 12) => Math.abs(a - b) <= t;
const rgbNear = (c, r, g, b, t = 12) => near(c[0], r, t) && near(c[1], g, t) && near(c[2], b, t);

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) {
  fail('page setup: ' + e.message);
  await browser.close(); server.close(); process.exit(1);
}

// gl.readPixels is bottom-up; the dstRect is y-down (top-left origin).
// sampleTop(x, yTop) converts a top-down pixel to the gl row.
async function run(calls, samples) {
  return page.evaluate((calls, samples) => {
    const gl = window.__gl;
    window.__draw(calls);
    const w = 200, h = 200, buf = new Uint8Array(4);
    return samples.map(([x, yTop]) => {
      gl.readPixels(x, h - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2], buf[3]];
    });
  }, calls, samples);
}

// 1) Plain blit into dstRect [20,20,80,80] → quadrants map across it.
//    Centers of the four quadrants (top-down pixels):
//      TL ~ (40,40) red   TR ~ (80,40) green
//      BL ~ (40,80) blue  BR ~ (80,80) white
{
  const s = await run([{ dstRect: [20, 20, 80, 80] }],
    [[40, 40], [80, 40], [40, 80], [80, 80], [5, 5]]);
  if (rgbNear(s[0], 255, 0, 0))   ok('blit TL quadrant red');     else fail('TL not red: ' + s[0]);
  if (rgbNear(s[1], 0, 255, 0))   ok('blit TR quadrant green');   else fail('TR not green: ' + s[1]);
  if (rgbNear(s[2], 0, 0, 255))   ok('blit BL quadrant blue');    else fail('BL not blue: ' + s[2]);
  if (rgbNear(s[3], 255, 255, 255)) ok('blit BR quadrant white'); else fail('BR not white: ' + s[3]);
  if (rgbNear(s[4], 128, 128, 128)) ok('backdrop outside dstRect intact (grey)'); else fail('backdrop clobbered: ' + s[4]);
}

// 2) Tint green → red quadrant becomes black (255,0,0)*(0,1,0)=0; green stays.
{
  const s = await run([{ dstRect: [20, 20, 80, 80], tint: [0, 1, 0, 1] }],
    [[40, 40], [80, 40]]);
  if (rgbNear(s[0], 0, 0, 0))   ok('tint green: red quadrant → black'); else fail('tinted TL: ' + s[0]);
  if (rgbNear(s[1], 0, 255, 0)) ok('tint green: green quadrant stays green'); else fail('tinted TR: ' + s[1]);
}

// 3) Alpha 0.5 over grey backdrop → red over grey = (191,64,64) premultiplied
//    src-over: out = src*1 + dst*(1-a). src premult red@0.5 = (128,0,0,128);
//    dst grey (128). out.r = 128 + 128*0.5 = 192; out.g = 0 + 128*0.5 = 64.
{
  const s = await run([{ dstRect: [20, 20, 80, 80], alpha: 0.5 }], [[40, 40]]);
  if (rgbNear(s[0], 192, 64, 64, 16)) ok('alpha 0.5: red over grey ≈ (192,64,64)'); else fail('alpha blend: ' + s[0]);
}

// 4) srcRect = just the TL texel [0,0,1,1] → whole dstRect is red.
{
  const s = await run([{ dstRect: [20, 20, 80, 80], srcRect: [0, 0, 1, 1] }],
    [[40, 40], [80, 80]]);
  if (rgbNear(s[0], 255, 0, 0) && rgbNear(s[1], 255, 0, 0)) ok('srcRect TL texel fills whole dstRect red'); else fail('srcRect: ' + s[0] + ' ' + s[1]);
}

// 5) worldMatrix translate (+100 x): the same dstRect [0,0,80,80] shifts right.
//    Column-major mat3 translate by (100,0): [1,0,0, 0,1,0, 100,0,1].
{
  // Plain array (survives puppeteer serialization; renderer coerces to
  // Float32Array). Column-major mat3 translate by (100,0).
  const m = [1, 0, 0, 0, 1, 0, 100, 0, 1];
  const s = await run([{ dstRect: [0, 0, 80, 80], worldMatrix: m }],
    [[20, 20], [120, 20]]);
  if (rgbNear(s[0], 128, 128, 128)) ok('worldMatrix: original spot empty (grey)'); else fail('translate src spot: ' + s[0]);
  if (rgbNear(s[1], 255, 0, 0))     ok('worldMatrix: image shifted +100x (red present)'); else fail('translate dst spot: ' + s[1]);
}

// 6) Interleave: drawBundle → drawImage → drawBundle (same bundle). The
//    2nd drawBundle must re-bind its asset textures (drawImage clobbered
//    TEXTURE0 + the program). If drawImage forgot to self-report
//    fillPassAssetDirty, the blue rect renders as garbage. Guards the
//    self-report contract.
{
  const r = await page.evaluate(() => window.__interleave());
  const blue = (c) => rgbNear(c, 0, 0, 255, 16);
  if (blue(r.clean)) ok('interleave: clean drawBundle blue'); else fail('clean not blue: ' + r.clean);
  if (blue(r.inter)) ok('interleave: drawBundle→drawImage→drawBundle keeps blue (no cache corruption)');
  else fail('interleave corrupted blue rect: ' + r.inter + ' (vs clean ' + r.clean + ')');
}

await browser.close();
server.close();
if (failures === 0) console.log('\nDRAW-IMAGE PASS');
else console.log(`\nDRAW-IMAGE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
