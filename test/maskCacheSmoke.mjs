// maskCacheSmoke.mjs — mask result cache proof.
// A bundle with a MULTI-shape <mask> (forces the offscreen region bake,
// maskRegions.length > 0) is rendered several frames. Asserts:
//   1. The masked output is correct (blue shows only inside the mask).
//   2. The mask is baked ONCE — re-renders reuse _maskRTArray
//      (renderer.debugStats.maskBakeCount stays 1), proving the bake is
//      skipped when geometry + canvas are unchanged (a sibling animating
//      would re-render but not re-bake the mask).
//   3. A canvas resize re-bakes (key includes canvas size).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Multi-shape mask: two white rects in the mask → a real mask region.
// Masked blue square; mask reveals the left+right thirds (a gap in the
// middle), so centre is hidden, sides shown.
const SVG = readFileSync(new URL('../examples/smoke/maskCache__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sections = await importSvg(${JSON.stringify(SVG)});
const bundle = createBundle(gl, sections);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__gl = gl; window.__renderer = renderer; window.__bundle = bundle; window.__id = id;
window.__frame = (w, h) => {
  if (w) { cnv.width = w; cnv.height = h; }
  renderer.setViewport(cnv.width, cnv.height);
  renderer.beginFrame([0.5,0.5,0.5,1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
};
window.__sample = (x, yTop) => {
  const b = new Uint8Array(4);
  gl.readPixels(x, cnv.height - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
  return [b[0], b[1], b[2], b[3]];
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try { res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

// Render frame 1, check correctness + bake happened once. (If the
// fixture produced no mask region the bake count would stay 0 — the
// `bakes === 1` assertion below doubles as the not-vacuous guard.)
const r1 = await page.evaluate(() => {
  window.__frame();
  return {
    left:   window.__sample(30, 100),   // inside left mask reveal → blue
    centre: window.__sample(100, 100),  // mask gap → hidden → backdrop grey
    right:  window.__sample(170, 100),  // inside right reveal → blue
    bakes:  window.__renderer.debugStats.maskBakeCount,
  };
});
const isBlue = (c) => c[2] > 180 && c[0] < 80 && c[1] < 80;
const isGrey = (c) => Math.abs(c[0]-128) < 40 && Math.abs(c[1]-128) < 40 && Math.abs(c[2]-128) < 40;
if (isBlue(r1.left) && isBlue(r1.right)) ok('mask reveals left+right (blue)'); else fail('reveal wrong: L=' + r1.left + ' R=' + r1.right);
if (isGrey(r1.centre)) ok('mask hides centre (backdrop)'); else fail('centre not hidden: ' + r1.centre);
if (r1.bakes === 1) ok('frame 1 baked the mask once (count=1)'); else fail('unexpected bake count after frame 1: ' + r1.bakes);

// Render 4 more frames at the SAME canvas size → no additional bakes
// (re-render reuses the baked mask).
const r2 = await page.evaluate(() => {
  for (let i = 0; i < 4; i++) window.__frame();
  return {
    centre: window.__sample(100, 100), left: window.__sample(30, 100),
    bakes: window.__renderer.debugStats.maskBakeCount,
  };
});
if (r2.bakes === 1) ok('4 more frames: mask NOT re-baked (count still 1 — cache hit)'); else fail('mask re-baked on static re-render: ' + r2.bakes);
if (isBlue(r2.left) && isGrey(r2.centre)) ok('output still correct after cache hits'); else fail('cached output wrong: L=' + r2.left + ' C=' + r2.centre);

// Resize the canvas → the key (canvas size) changes → re-bake.
const r3 = await page.evaluate(() => {
  window.__frame(300, 300);
  return { bakes: window.__renderer.debugStats.maskBakeCount, left: window.__sample(45, 150) };
});
if (r3.bakes === 2) ok('canvas resize re-bakes (count=2)'); else fail('resize did not re-bake: ' + r3.bakes);

await browser.close();
server.close();
if (failures === 0) console.log('\nMASK-CACHE PASS');
else console.log(`\nMASK-CACHE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
