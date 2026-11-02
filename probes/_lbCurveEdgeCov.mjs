// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Measure a SINGLE curved shape's edge coverage, LB vs Slug, over green (no
// compositing). Coverage c = 1 - greenFraction. If LB under-covers vs Slug by a
// CONSTANT amount → fixable bias; if it varies with slope/curvature → the
// fundamental curve-AA gap. This is the root of the internal conflation (two
// under-covering curved edges leave a bg seam).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 300;
// one solid shape with a slanted CURVED right edge, filled dark, over green.
const SHAPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <path d="M40 40 L150 40 C210 110 150 190 180 260 L40 260 Z" fill="#603018"/></svg>`;
// a diagonal STRAIGHT edge for comparison (should already match after #11).
const DIAG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
  <path d="M40 40 L200 40 L120 260 L40 260 Z" fill="#603018"/></svg>`;
const CASES = { CURVE: SHAPE, DIAG };
const HTML = (
  svg,
) => `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(${N},${N});
const bundle=createBundle(gl,await importSvg(${JSON.stringify(svg)}));
renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read=()=>{const px=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px;};
const draw=(m)=>{renderer.setLoopBlinnFill(m); renderer.beginFrame([0,0.8,0,1]); renderer.drawBundle(bundle); renderer.endFrame(); return read();};
const slug=draw('off'), lb=draw('on');
// coverage from green fraction: bg=[0,204,0], fill=[96,48,24]. Use the BLUE channel:
// bg B=0, fill B=24. c = B/24 is noisy; instead c = 1 - g_excess where pure bg g=204.
// cleanest: coverage = 1 - (green_g - r - b contribution). Use: cov = clamp(1 - G/204) is wrong
// since fill has G=48. Solve per-pixel: pixel = c*fill + (1-c)*bg. From R (fill R=96,bg R=0): c=R/96.
const cov=(px,x,y)=>{const o=((${N}-1-y)*${N}+x)*4; return Math.min(1, px[o]/96);};
// scan several horizontal lines crossing the right (curved/diagonal) edge; at each,
// find the edge (cov crosses 0.5) and record LB vs Slug coverage in a ±3px band.
const rows=[80,120,160,200,240], out=[];
for(const y of rows){ // find approx edge x where slug cov ~0.5
  let ex=-1; for(let x=40;x<${N}-1;x++){ if(cov(slug,x,y)>=0.5 && cov(slug,x+1,y)<0.5){ ex=x; break; } }
  if(ex<0) continue;
  const band=[]; for(let x=ex-3;x<=ex+3;x++) band.push([x, +cov(lb,x,y).toFixed(3), +cov(slug,x,y).toFixed(3)]);
  // integrated coverage difference across the band (LB - Slug); negative = LB under-covers
  let sd=0; for(const [,l,s] of band) sd+=l-s;
  out.push({ y, ex, band, covDelta:+sd.toFixed(3) });
}
window.__out={ out };
window.__ready=true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url.startsWith('/case')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML(CASES[req.url.slice(5)]));
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
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
for (const c of Object.keys(CASES)) {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[' + c + ']', m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/case${c}`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  const o = await page.evaluate(() => window.__out);
  console.log(`\n=== ${c} ===`);
  for (const r of o.out) {
    console.log(`  y=${r.y} edge@${r.ex} covDelta(LB-Slug)=${r.covDelta}`);
    console.log('    ' + r.band.map(([x, l, s]) => `x${x}:${l}/${s}`).join('  '));
  }
  await page.close();
}
await browser.close();
server.close();
