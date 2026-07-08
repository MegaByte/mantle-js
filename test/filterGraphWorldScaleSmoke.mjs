// Verifies the composable filter-GRAPH path honors world scale.
//
// The single-kind fast path (one recognized primitive) folds pxPerEm —
// canvas-AR × worldMatrix scale — into blur σ / offset / etc. (covered
// by filterWorldScaleSmoke). The composable graph path (multi-primitive
// filters) must do the same: ctx.worldScale (the worldMatrix column
// norms) folds into each scale-sensitive graph primitive (blur σ, offset,
// morphology radius, convolve/displacement texel step, lighting
// gradient). Identity worldMatrix → [1,1] → unchanged.
//
// This fixture's filter is multi-primitive (feGaussianBlur + feMerge) so
// it routes through the graph path. Measures the blur extent at
// worldMatrix scale 1.0 vs 0.5 vs 0.25; the extent must scale with it.

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

// Same geometry as filterWorldScaleSmoke (white bg pins the bundle bbox
// to the viewBox so the centre rect renders at a known sub-canvas spot),
// but the filter ends in an feMerge — which the single-kind heuristic
// does NOT reduce, so the filter routes through the composable graph
// path. A one-node merge passes the blurred silhouette through unchanged.
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <filter id="b" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4" result="bl"/>
      <feMerge><feMergeNode in="bl"/></feMerge>
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
page.on('console', m => { const t = m.text(); if (/error|fail|warn/i.test(t)) console.log('  [console]', t); });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const results = await page.evaluate(async (svg) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  cnv.width = 200; cnv.height = 200;
  renderer.setViewport(200, 200);

  const bundle = createBundle(gl, await importSvg(svg));

  function readPixels() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  }
  function blurExtentX(snap) {
    const { w, h, px } = snap;
    const cy = h >> 1, cx = w >> 1;
    let r = 0;
    for (let dx = 0; dx < cx; dx++) {
      const i = ((cy * w) + (cx + dx)) * 4;
      if (px[i] > 240 && px[i+1] > 240 && px[i+2] > 240) { r = dx; break; }
    }
    return r;
  }

  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(bundle);
  renderer.endFrame();
  const extent1x = blurExtentX(readPixels());

  const h = renderer.createBundleHandle(bundle);
  renderer.beginFrame([1, 1, 1, 1]);
  h.draw({ worldMatrix: new Float32Array([0.5, 0, 0,  0, 0.5, 0,  0, 0, 1]) });
  renderer.endFrame();
  const extentHalf = blurExtentX(readPixels());

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

console.log(`graph blur extent at scale 1.0:  ${results.extent1x} px`);
console.log(`graph blur extent at scale 0.5:  ${results.extentHalf} px`);
console.log(`graph blur extent at scale 0.25: ${results.extentQuarter} px`);

if (results.extent1x < 5) {
  fail(`baseline graph-path blur extent at scale 1.0 should be >= ~5 px (got ${results.extent1x}); fixture not exercising the graph blur`);
}
const ratioHalf = results.extentHalf / (results.extent1x || 1);
if (ratioHalf > 0.60) {
  fail(`half-scale extent ratio is ${ratioHalf.toFixed(2)} — expected ~0.5 (graph blur σ didn't fold worldMatrix)`);
} else if (ratioHalf < 0.40) {
  fail(`half-scale extent ratio is ${ratioHalf.toFixed(2)} — too aggressive shrink (over-correcting)`);
} else {
  ok(`half-scale extent ratio ${ratioHalf.toFixed(2)} ≈ 0.5 (graph blur scales with worldMatrix)`);
}
const ratioQuarter = results.extentQuarter / (results.extent1x || 1);
if (ratioQuarter > 0.35) {
  fail(`quarter-scale extent ratio is ${ratioQuarter.toFixed(2)} — expected ~0.25 (graph blur ignored worldMatrix)`);
} else if (ratioQuarter < 0.15) {
  fail(`quarter-scale extent ratio is ${ratioQuarter.toFixed(2)} — too aggressive shrink`);
} else {
  ok(`quarter-scale extent ratio ${ratioQuarter.toFixed(2)} ≈ 0.25 (graph blur scales with worldMatrix)`);
}
if (results.extentQuarter > results.extentHalf || results.extentHalf > results.extent1x) {
  fail(`graph blur extent should be monotonic with scale: 1x ${results.extent1x} >= half ${results.extentHalf} >= quarter ${results.extentQuarter}`);
} else {
  ok('graph blur extent monotonic with scale');
}

if (failures) { console.error(`\n${failures} assertions failed`); process.exit(1); }
console.log('\nfilterGraphWorldScaleSmoke: PASS');
