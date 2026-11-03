// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _leanSlugBench.mjs — does SPECIALIZING the fill shader actually cut per-fragment cost?
// The #ifndef lean-variant system exists and is validated byte-identical (samplers 13→8),
// but SPEED is a separate question. Here: FULL ubershader vs LEAN (solid content: omit
// recolor/clip/mask/filter/extclip/gradient/image) on the same solid star, Slug fill
// mode, both amortized identically. This quantifies how much of Slug's cost is ubershader
// overhead the compiler carries for features a solid bundle never uses. Gentle: K=40,
// N=256, two contexts, browser closed on all paths.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256,
  cx = 128,
  cy = 128,
  Ro = 120,
  Ri = 70;
function star(P) {
  const V = [];
  for (let i = 0; i < 2 * P; i++) {
    const r = i % 2 ? Ri : Ro,
      a = (i / (2 * P)) * 2 * Math.PI - Math.PI / 2;
    V.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return V;
}
function svgOf(V) {
  let d = `M ${V[0][0].toFixed(2)} ${V[0][1].toFixed(2)} `;
  for (let i = 1; i < V.length; i++) d += `L ${V[i][0].toFixed(2)} ${V[i][1].toFixed(2)} `;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}Z"/></svg>`;
}
const CASES = [4, 16, 48, 120].map((P) => ({ edges: 2 * P, svg: svgOf(star(P)) }));

const HTML = `<!DOCTYPE html><html><body>
<canvas id="cf" width="${N}" height="${N}"></canvas><canvas id="cl" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { omitDefinesFor, FILL_FEATURES } from '/src/renderer/fillOmit.js';
const K = 40, CASES = ${JSON.stringify(CASES)};
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const sync = (ctx) => { const p=new Uint8Array(4); ctx.readPixels(0,0,1,1,ctx.RGBA,ctx.UNSIGNED_BYTE,p); return p[0]; };
const jit=(i)=>[1,0,0,0,1,0,(i%13)*1e-3,0,1];

// FULL renderer (no defines) and LEAN renderer (omit every optional feature → solid-only)
const glF = document.getElementById('cf').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const rF = createRenderer(glF, shaders); rF.setViewport(${N},${N}); rF.setLoopBlinnFill('off');
const omit = omitDefinesFor(FILL_FEATURES.slice());   // omit ALL optional features
const glL = document.getElementById('cl').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const rL = createRenderer(glL, shaders, { fillDefines: omit }); rL.setViewport(${N},${N}); rL.setLoopBlinnFill('off');

function amort(r, gl, bundle){
  r.beginFrame([1,1,1,1]); for(let i=0;i<4;i++) r.drawBundle(bundle,{worldMatrix:jit(i)}); r.endFrame(); sync(gl);
  const px=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]||px[i+1]||px[i+2]) ink++;
  const t0=performance.now();
  r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(bundle,{worldMatrix:jit(i)}); r.endFrame(); sync(gl);
  return { ms:(performance.now()-t0)/K, ink };
}
const rows=[];
for(const C of CASES){
  const bF=createBundle(glF, await importSvg(C.svg)); rF.prepareBundle(bF);
  const bL=createBundle(glL, await importSvg(C.svg)); rL.prepareBundle(bL);
  const f=amort(rF,glF,bF), l=amort(rL,glL,bL);
  rows.push({ edges:C.edges, full:f.ms, lean:l.ms, inkF:f.ink, inkL:l.ink, autoBaked:(bF._fillBakedOmit||[]).join(',') });
}
window.__out={ omit, rows };
window.__ready=true;
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

console.log(`omitted defines: ${out.omit.join(' ')}`);
console.log('  edges |  full-Slug  lean-Slug  |  speedup  | ink full/lean (parity)');
for (const r of out.rows) {
  console.log(
    `  ${String(r.edges).padStart(5)} |  ${r.full.toFixed(3)}     ${r.lean.toFixed(3)}    |  ${(r.full / r.lean).toFixed(2)}×    |  ${r.inkF}/${r.inkL}`,
  );
  console.log(
    `        auto renderer baked-omit: ${r.autoBaked || '(none)'}  (+ per-draw recolor/extclip omitted when unused)`,
  );
}
