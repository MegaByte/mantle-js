// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aacVsSlugBench.mjs — AAC vs Slug per-draw cost in the REAL renderer, both
// auto-specialized (per-bundle lean variants), LB off. AAC's kernel (bisection
// band-find + finite-diff derivative + quadrature) is heavier per-segment than
// Slug's box filter, so this measures the true trade: exact-area AA quality vs
// per-fragment cost. Two shapes: a line polygon (cheap AAC path) and a cubic
// blob (heavy AAC path). Amortized (one clear + K draws + one sync). Gentle.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512,
  cx = 256,
  cy = 256; // 512² so the per-fragment algorithm cost dominates fixed overhead
function star(P, Ro, Ri) {
  const V = [];
  for (let i = 0; i < 2 * P; i++) {
    const r = i % 2 ? Ri : Ro,
      a = (i / (2 * P)) * 2 * Math.PI - Math.PI / 2;
    V.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = `M ${V[0][0].toFixed(2)} ${V[0][1].toFixed(2)} `;
  for (let i = 1; i < V.length; i++) d += `L ${V[i][0].toFixed(2)} ${V[i][1].toFixed(2)} `;
  return d + 'Z';
}
const SHAPES = {
  'poly-10': star(5, 110, 55),
  'poly-48': star(24, 110, 80),
  cubic: 'M60 128 C60 40 196 40 196 128 C196 216 60 216 60 128 Z',
  arc: 'M40 128 A88 70 0 1 0 216 128 A88 70 0 1 0 40 128 Z',
};
const SVGS = Object.fromEntries(
  Object.entries(SHAPES).map(([k, d]) => [
    k,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`,
  ]),
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
const K = 40;
const sync = () => { const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
const jit = (i)=>[1,0,0,0,1,0,(i%13)*1e-3,0,1];
const rAAC  = createRenderer(gl, shaders, { aacFill: true }); rAAC.setViewport(${N},${N}); rAAC.setLoopBlinnFill('off');
const rSlug = createRenderer(gl, shaders, {});               rSlug.setViewport(${N},${N}); rSlug.setLoopBlinnFill('off');
async function amort(r, svg){
  const b = createBundle(gl, await importSvg(svg)); r.prepareBundle && r.prepareBundle(b);
  let best = 1e9;
  for (let rep = 0; rep < 5; rep++) {   // min-of-5 removes scheduler/thermal noise
    r.beginFrame([1,1,1,1]); for(let i=0;i<4;i++) r.drawBundle(b,{worldMatrix:jit(i)}); r.endFrame(); sync();
    const t0=performance.now();
    r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b,{worldMatrix:jit(i)}); r.endFrame(); sync();
    best = Math.min(best, (performance.now()-t0)/K);
  }
  b.dispose(); return best;
}
const out={};
for (const k of Object.keys(SVGS)) out[k] = { slug: await amort(rSlug, SVGS[k]), aac: await amort(rAAC, SVGS[k]) };
const dbg=gl.getExtension('WEBGL_debug_renderer_info'); out.gpu = dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
window.__out=out; window.__ready=true;
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

console.log(
  'GPU:',
  out.gpu,
  `@ ${N}×${N}, real renderer, both auto-specialized, LB off, amortized (ms/draw)`,
);
console.log('  shape     |  Slug    AAC    | AAC/Slug');
for (const k of Object.keys(SHAPES)) {
  const r = out[k];
  console.log(
    `  ${k.padEnd(9)} |  ${r.slug.toFixed(3)}  ${r.aac.toFixed(3)}  |  ${(r.aac / r.slug).toFixed(2)}×`,
  );
}
