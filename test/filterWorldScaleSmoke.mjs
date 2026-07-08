// Verifies the single-kind filter path honors world scale: filter σ
// folds the per-draw worldMatrix scale into pxPerEm, so a 50%-scaled
// draw produces a 50%-sized blur (rather than keeping its full
// canvas-relative σ and a proportionally too-large halo).
//
// Renders a bundle with a feGaussianBlur and a known σ at scale 1.0 vs
// 0.5 vs 0.25. The blur extent (distance from silhouette to where alpha
// drops below a threshold) should scale with the world matrix.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/mantleDemo.html`;

// A small filled square in the centre with a large blur, plus a
// white "background" rect filling the whole viewBox. The background
// pins the bundle's globalBBox to the viewBox extent so the centre
// rect renders at a known sub-canvas position. Without it, Mantle's
// globalBBox would be the rect's tight bbox (40,40,20,20) → the rect
// would end up fitted to fill the entire canvas, defeating the
// blur-extent measurement.
//
// White background matches the canvas clear color, so the visible
// effect is the same as if there were no background.
//
// With the background in place, the bundle bbox is (0,0,100,100) and
// the small centre rect renders at canvas pixels ~80..120 on a
// 200×200 canvas (2× scale). σ=4 viewBox → 8 px → ~24 px halo extent
// at scale 1.0.
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <filter id="b" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="#ffffff"/>
  <rect filter="url(#b)" x="40" y="40" width="20" height="20" fill="#000000"/>
</svg>`;

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const results = await page.evaluate(async (svg) => {
  const { importSvg, createBundle } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  // Resize the demo canvas to a small known size. mantleDemo.html
  // ships an 800×800 default; we want a small canvas so our extent
  // measurements have meaningful precision per pixel.
  cnv.width = 200;
  cnv.height = 200;
  renderer.setViewport(200, 200);

  const bundle = createBundle(gl, await importSvg(svg));


  function readPixels() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  }

  // Blur extent = how far from the centre the row sample stays
  // "noticeably dark" (i.e. alpha contribution from the blurred fill).
  // We walk the centre row from x=cw/2 outward and stop at the first
  // pixel whose RGB is brighter than 240 (close-to-white background).
  function blurExtentX(snap) {
    const { w, h, px } = snap;
    const cy = h >> 1;
    const cx = w >> 1;
    let r = 0;
    for (let dx = 0; dx < cx; dx++) {
      const i = ((cy * w) + (cx + dx)) * 4;
      if (px[i] > 240 && px[i+1] > 240 && px[i+2] > 240) {
        r = dx;
        break;
      }
    }
    return r;
  }

  // Native scale: render bundle as drawBundle (worldMatrix=identity).
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(bundle);
  renderer.endFrame();
  const extent1x = blurExtentX(readPixels());

  // Half-scale: render via handle.draw with worldMatrix = scale 0.5.
  // Column-major mat3: [sx 0 0 ; 0 sy 0 ; tx ty 1] flat-array means
  // [sx, 0, 0,  0, sy, 0,  tx, ty, 1].
  const h = renderer.createBundleHandle(bundle);
  renderer.beginFrame([1, 1, 1, 1]);
  h.draw({ worldMatrix: new Float32Array([0.5, 0, 0,  0, 0.5, 0,  0, 0, 1]) });
  renderer.endFrame();
  const extentHalf = blurExtentX(readPixels());

  // Quarter-scale: extra sanity that smaller scale → smaller extent.
  renderer.beginFrame([1, 1, 1, 1]);
  h.draw({ worldMatrix: new Float32Array([0.25, 0, 0,  0, 0.25, 0,  0, 0, 1]) });
  renderer.endFrame();
  const extentQuarter = blurExtentX(readPixels());

  h.dispose();
  bundle.dispose();
  return { extent1x, extentHalf, extentQuarter };
}, SVG);

await browser.close();
server.close();

// ---- Assertions ----

console.log(`blur extent at scale 1.0:  ${results.extent1x} px`);
console.log(`blur extent at scale 0.5:  ${results.extentHalf} px`);
console.log(`blur extent at scale 0.25: ${results.extentQuarter} px`);

if (results.extent1x < 5) {
  fail(`baseline blur extent at scale 1.0 should be >= ~5 px (got ${results.extent1x}); test fixture not exercising blur`);
}

// Half-scale should halve the extent (within a couple pixels of
// discrete-threshold noise): folded σ gives ~16/33 = ~0.48; a σ that
// stayed canvas-relative would give ~22/33 = ~0.67. Tolerance band
// 0.40-0.60 distinguishes.
const ratioHalf = results.extentHalf / results.extent1x;
if (ratioHalf > 0.60) {
  fail(`half-scale extent ratio is ${ratioHalf.toFixed(2)} — expected ~0.5 (bug repros: σ didn't shrink with worldMatrix)`);
} else if (ratioHalf < 0.40) {
  fail(`half-scale extent ratio is ${ratioHalf.toFixed(2)} — too aggressive shrink (over-correcting)`);
} else {
  ok(`half-scale extent ratio ${ratioHalf.toFixed(2)} ≈ 0.5 (blur scales with worldMatrix)`);
}

// Quarter-scale: folded σ gives ~8/33 = ~0.24; a canvas-relative σ
// gives ~14/33 = ~0.42. Tolerance band 0.15-0.35 distinguishes.
const ratioQuarter = results.extentQuarter / results.extent1x;
if (ratioQuarter > 0.35) {
  fail(`quarter-scale extent ratio is ${ratioQuarter.toFixed(2)} — expected ~0.25 (bug repros)`);
} else if (ratioQuarter < 0.15) {
  fail(`quarter-scale extent ratio is ${ratioQuarter.toFixed(2)} — too aggressive shrink`);
} else {
  ok(`quarter-scale extent ratio ${ratioQuarter.toFixed(2)} ≈ 0.25 (blur scales with worldMatrix)`);
}

// And the monotonic check.
if (results.extentQuarter > results.extentHalf || results.extentHalf > results.extent1x) {
  fail(`blur extent should be monotonic with scale: 1x ${results.extent1x} >= half ${results.extentHalf} >= quarter ${results.extentQuarter}`);
} else {
  ok('blur extent monotonic with scale');
}

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nfilterWorldScaleSmoke: PASS');
