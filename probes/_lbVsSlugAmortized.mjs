// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbVsSlugAmortized.mjs — the CORRECTED bench: LB vs Slug per-draw cost with the
// per-FRAME overhead AMORTIZED (one beginFrame + one clear + one fill-pass setup,
// then K draws, then one readback sync). My earlier bench did beginFrame+draw+endFrame
// per iteration, so every iteration paid the frame clear + fill-pass setup that
// production amortizes across all bundles in a frame — inflating the per-draw cost.
// This isolates the algorithm: does the per-pixel renderer (Slug) rival LB's cached
// mesh on a curved holed shape? Gentle: K=50 fixed, N=256, browser closed in all paths.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256;
// holed "O" (cubic arcs) — both LB (CDT partition) and Slug render it.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${N}" height="${N}">
<path fill="#3366cc" d="M50 6 A44 44 0 1 0 50 94 A44 44 0 1 0 50 6 Z M50 30 A20 20 0 1 1 50 70 A20 20 0 1 1 50 30 Z"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${N}, ${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);   // build LB mesh once (build-once amortized, like production)
const K = 50;
const jit = (i)=>[1,0,0,0,1,0,(i%13)*1e-3,0,1];
const sync = ()=>{ const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
// AMORTIZED: one beginFrame (clear + setup), K draws, one readback sync.
function amortized(mode){
  renderer.setLoopBlinnFill(mode);
  // warmup
  renderer.beginFrame([1,1,1,1]); for(let i=0;i<5;i++) renderer.drawBundle(bundle,{worldMatrix:jit(i)}); renderer.endFrame(); sync();
  const t0=performance.now();
  renderer.beginFrame([1,1,1,1]);
  for(let i=0;i<K;i++) renderer.drawBundle(bundle,{worldMatrix:jit(i)});
  renderer.endFrame();
  sync();                              // hard GPU sync (drains all K draws)
  return (performance.now()-t0)/K;     // amortized per-draw
}
// Also measure the pure per-FRAME overhead (empty frame: clear + nothing).
function frameOverhead(){
  renderer.beginFrame([1,1,1,1]); renderer.endFrame(); sync();
  const t0=performance.now();
  for(let i=0;i<K;i++){ renderer.beginFrame([1,1,1,1]); renderer.endFrame(); }
  sync();
  return (performance.now()-t0)/K;
}
const routed = (mode)=>{ renderer.setLoopBlinnFill(mode); const r=renderer.debugStats.loopBlinnRouteCount; renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return renderer.debugStats.loopBlinnRouteCount-r; };
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
window.__out = {
  gpu: dbg? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL): gl.getParameter(gl.RENDERER),
  frameMs: frameOverhead(),
  lbMs: amortized('on'), lbRouted: routed('on'),
  slugMs: amortized('off'), slugRouted: routed('off'),
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal'],
});
let out;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  out = await page.evaluate(() => window.__out);
} catch (e) {
  console.error('setup failed:', e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();

console.log('GPU:', out.gpu, `@ ${N}×${N}, holed cubic O, AMORTIZED per-draw (frame setup shared)`);
console.log(`  per-frame overhead (empty clear): ${out.frameMs.toFixed(3)} ms`);
console.log(`  LB  (routed ${out.lbRouted}): ${out.lbMs.toFixed(3)} ms/draw`);
console.log(`  Slug(routed ${out.slugRouted}): ${out.slugMs.toFixed(3)} ms/draw`);
console.log(
  `  → Slug/LB algorithm ratio: ${(out.slugMs / out.lbMs).toFixed(2)}× (per-pixel vs cached-mesh, overhead removed)`,
);
