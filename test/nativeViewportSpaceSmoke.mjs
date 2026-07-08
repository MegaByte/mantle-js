// The native fallback's PIXEL-VIEWPORT coordinate mode (multi-bundle
// compositor contract).
//
// In 'viewport' mode the root <svg> viewBox is the pixel viewport
// (0 0 W H), NOT the first bundle's em-box, and each bundle is placed by
// an em→pixel worldMatrix. Proves N bundles land at distinct, correct
// pixel positions rather than all being interpreted in the first bundle's
// em-space.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A 1-unit bundle with a NON-pixel em-box (viewBox -50 0 200 100) so the
// "first bundle's em-box ≠ viewport" mismatch would be obvious if present.
const PREFAB = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 0 200 100" width="200" height="100"><rect id="r" x="-50" y="0" width="200" height="100" fill="#c0392b"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="400" height="300"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';

const prefab = await importSvg(${JSON.stringify(PREFAB)}, { retainSource: true });
const host = document.getElementById('host');
const scene = createNativeScene(host, { coordinateSpace: 'viewport' });
scene.setViewport(400, 300);

// Build an em→pixel affine that maps the bundle's bbox (-50 0 200 100)
// into a target pixel rect (px, py, pw, ph). em x in [-50,150] → [px,px+pw].
function emToPx(bbox, px, py, pw, ph) {
  const [bx, by, bw, bh] = bbox;
  const sx = pw / bw, sy = ph / bh;
  // column-major mat3: col0=(sx,0,0) col1=(0,sy,0) col2=(tx,ty,1)
  const tx = px - bx * sx, ty = py - by * sy;
  return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
}
const bbox = prefab.globalBBox;

// Two instances of the SAME prefab at two pixel rects:
//   A → top-left  (20,20, 100x60)
//   B → bottom-right (260,200, 120x80)
window.__draw = () => {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(prefab, { worldMatrix: emToPx(bbox, 20, 20, 100, 60) });
  scene.drawBundle(prefab, { worldMatrix: emToPx(bbox, 260, 200, 120, 80) });
  scene.endFrame();
  return {
    viewBox: scene.svg.getAttribute('viewBox'),
    par: scene.svg.getAttribute('preserveAspectRatio'),
    groups: scene.svg.querySelectorAll(':scope > g').length,
    space: scene.coordinateSpace,
  };
};

// Raster in viewport mode: a green block via drawImage must land at its
// dstRect (pixel space) and ALIGN with bundles (no nested-svg distortion).
const GREEN = { width: 10, height: 10, rgba: (() => { const a = new Uint8Array(400); for (let i=0;i<100;i++){a[i*4+1]=200;a[i*4+3]=255;} return a; })() };
const cctx = document.getElementById('cv').getContext('2d');
window.__rasterAlign = async () => {
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(prefab, { worldMatrix: emToPx(bbox, 20, 20, 100, 60) });   // red A top-left
  scene.drawImage(GREEN, { dstRect: [260, 200, 120, 80] });                   // green at B's spot
  scene.endFrame();
  // raster in viewport mode hosts in a <g> (no nested <svg> re-projection);
  // confirm there's no nested <svg> wrapper for the raster.
  const noNestedSvg = scene.svg.querySelector('svg image') === null && !!scene.svg.querySelector('image');
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  cctx.clearRect(0,0,400,300); cctx.drawImage(img, 0, 0, 400, 300);
  const at = (x,y) => { const p = cctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  const green = (px) => px[3] > 10 && px[1] > 150 && px[0] < 120 && px[2] < 120;
  return {
    directImage: noNestedSvg,                  // <image> straight in root (viewport mode)
    greenAtRect: green(at(320, 240)),          // center of [260,200,120,80]
    greenNotAtA: !green(at(70, 50)),           // not where the red bundle is
  };
};

const ctx = document.getElementById('cv').getContext('2d');
window.__sample = async () => {
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,400,300); ctx.drawImage(img, 0, 0, 400, 300);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  const red = (px) => px[3] > 10 && px[0] > 150 && px[1] < 100 && px[2] < 100;
  return {
    insideA: red(at(70, 50)),     // center of rect A (20..120, 20..80)
    insideB: red(at(320, 240)),   // center of rect B (260..380, 200..280)
    gapBetween: !red(at(190, 140)),// empty space between them
    cornerEmpty: !red(at(395, 5)), // top-right corner: nothing
  };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try { const b = readFileSync(path.join(ROOT, p)); res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(b); }
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

const info = await page.evaluate(() => window.__draw());
if (info.space === 'viewport') ok('scene.coordinateSpace === viewport'); else fail('space wrong: ' + info.space);
if (info.viewBox === '0 0 400 300') ok('root viewBox is the PIXEL VIEWPORT, not the bundle em-box (' + info.viewBox + ')');
else fail('viewBox is not the viewport: ' + info.viewBox);
if (info.par === 'none') ok('preserveAspectRatio=none (1:1 pixel mapping)'); else fail('par wrong: ' + info.par);
if (info.groups === 2) ok('two bundles → two <g> in one <svg>'); else fail('group count: ' + info.groups);

const s = await page.evaluate(() => window.__sample());
if (s.insideA) ok('bundle A lands at its pixel rect (top-left)'); else fail('A mispositioned');
if (s.insideB) ok('bundle B lands at its DISTINCT pixel rect (bottom-right)'); else fail('B mispositioned');
if (s.gapBetween) ok('the two bundles are separately placed (gap between)'); else fail('bundles overlap/fill — em-space mismatch not fixed');
if (s.cornerEmpty) ok('no stray fill outside the placed rects'); else fail('stray content in corner');

const ra = await page.evaluate(() => window.__rasterAlign());
if (ra.greenAtRect) ok('viewport-mode raster lands at its dstRect (aligns with bundles)');
else fail('raster mispositioned in viewport mode: ' + JSON.stringify(ra));
if (ra.greenNotAtA) ok('raster confined (not over the bundle)'); else fail('raster bled: ' + JSON.stringify(ra));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nnativeViewportSpaceSmoke: all checks passed');
