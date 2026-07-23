// _perBundleClearCost — what does the PER-BUNDLE depth+stencil clear actually cost?
//
// Two prior probes disagreed by 4-36x on the SAME nominal baseline (K=64 disjoint r=22 blobs on
// 512²: 46.6 ms in _hsrDepthPrepass vs 1.30 ms in the atlas spike). Content is identical, so the
// difference is in the harness — and the leading hypothesis is the clear that _renderCanvasInner
// issues per drawBundle (renderer.js ~:1417): on a tile-based deferred GPU (Apple), a mid-pass
// clear of depth/stencil forces a tile flush / render-pass split, which is far more expensive
// than the clear itself.
//
// This isolates it: same scene, same K draws, the ONLY difference is whether DEPTH|STENCIL bits
// survive in the clears the renderer issues between bundles. Pixels are compared too — stripping
// the clear is NOT semantically free (it is exactly what renderer.js:1400-1414 documents as
// having caused cross-bundle painter-order failures), so the diff is part of the answer.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;

const shape = (cx, cy, r, fill) =>
  `<path fill="${fill}" d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 1.3} ${cx + r} ${cy - r * 1.3} ${cx + r} ${cy} C ${cx + r} ${cy + r * 1.3} ${cx - r} ${cy + r * 1.3} ${cx - r} ${cy} Z"/>`;
const svgOf = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">${p}</svg>`;
// r=22 disjoint grid — byte-for-byte the layout both prior probes used.
const disjoint = (K) => Array.from({ length: K }, (_, i) =>
  svgOf(shape(28 + (i % 8) * 60, 28 + (Math.floor(i / 8) % 8) * 60, 22, `hsl(${i * 37 % 360},60%,50%)`)));

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(${N}, ${N});
const _clear = gl.clear.bind(gl);
let clears = 0, stripped = false;
gl.clear = (m) => { clears++; _clear(stripped ? (m & ~(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)) : m); };
const fence = () => { const p = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
const read = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };

window.__run = async (K, occupancy, lb) => {
  r.setLoopBlinnFill(lb ? 'on' : 'off');
  const bundles = [];
  for (const s of disjointSvgs(K))
    bundles.push(createBundle(gl, await importSvg(s, { preserveViewport: true, occupancyGrid: occupancy })));
  for (const b of bundles) r.prepareBundle && r.prepareBundle(b);
  if (r.awaitLbReady) for (const b of bundles) await r.awaitLbReady(b);
  const paint = () => { r.beginFrame([1,1,1,1]); for (const b of bundles) r.drawBundle(b, {}); r.endFrame(); };
  // min-of-9 over runs of 20 frames; arms interleaved so GPU clock ramp hits both equally.
  const timeIt = () => { let best = 1e9;
    for (let rep = 0; rep < 9; rep++) { const t0 = performance.now(); for (let f = 0; f < 20; f++) paint(); fence();
      best = Math.min(best, (performance.now() - t0) / 20); } return best; };
  let msKeep = 1e9, msStrip = 1e9;
  stripped = false; paint(); clears = 0; paint(); const clearsPerFrame = clears;
  for (let i = 0; i < 3; i++) {
    stripped = false; msKeep = Math.min(msKeep, timeIt());
    stripped = true;  msStrip = Math.min(msStrip, timeIt());
  }
  stripped = false; paint(); const pxKeep = read();
  stripped = true;  paint(); const pxStrip = read();
  stripped = false;
  let diff = 0, maxD = 0;
  for (let i = 0; i < pxKeep.length; i += 4) {
    const d = Math.max(Math.abs(pxKeep[i]-pxStrip[i]), Math.abs(pxKeep[i+1]-pxStrip[i+1]), Math.abs(pxKeep[i+2]-pxStrip[i+2]));
    if (d) { diff++; if (d > maxD) maxD = d; }
  }
  for (const b of bundles) b.dispose();
  return { K, occupancy, lb, msKeep, msStrip, clearsPerFrame, diff, maxD };
};
window.__ready = true;
</script></body></html>`;

const page_js = HTML.replace('disjointSvgs(K)', 'DISJOINT[K]');
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      const svgs = {}; for (const K of [8, 32, 64]) svgs[K] = disjoint(K);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page_js.replace('<script type="module">', `<script type="module">\nconst DISJOINT = ${JSON.stringify(svgs)};`));
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--use-angle=metal'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
const rows = [];
for (const K of [8, 32, 64])
  for (const occ of [true, false])
    rows.push(await page.evaluate((k, o) => window.__run(k, o, false), K, occ));
rows.push(await page.evaluate(() => window.__run(64, true, true)));
await browser.close(); server.close();

console.log(`disjoint r=22 blobs, ${N}², K separate bundles, min-of-9 over 20-frame runs\n`);
console.log('    K | occupancy | LB  | clears/frame |  keep clear |  strip clear | ratio | pixel diff');
for (const o of rows) {
  console.log(`  ${String(o.K).padStart(3)} | ${String(o.occupancy).padStart(9)} | ${String(o.lb).padStart(3)} | `
    + `${String(o.clearsPerFrame).padStart(12)} | ${o.msKeep.toFixed(3).padStart(10)}ms | ${o.msStrip.toFixed(3).padStart(11)}ms | `
    + `${(o.msKeep / o.msStrip).toFixed(2)}× | ${o.diff} px (maxΔ ${o.maxD})`);
}
console.log('\n  If "strip clear" is dramatically faster, the per-drawBundle depth+stencil clear is the');
console.log('  cost — on a tile-based deferred GPU each one forces a render-pass split. A nonzero');
console.log('  pixel diff is the price: that clear is what keeps bundles from depth-rejecting each');
console.log('  other (renderer.js:1400-1414). Both numbers matter.');
