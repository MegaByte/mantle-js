// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Render a multi-shape corpus asset LB vs Slug on the REAL GPU, diff, and save a
// magnified crop of the densest internal-boundary region — to SEE whether LB's
// residual is abutting-shape AA seams (background showing through a shared edge)
// or something more systematic/fixable.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
if (!process.env.SVG) throw new Error('SVG must name the asset to inspect');
const SVGPATH = path.resolve(process.env.SVG);
const SVG = readFileSync(SVGPATH, 'utf8');
const N = 256;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${N}, ${N});
const parsed = await importSvg(${JSON.stringify(SVG)});
const bundle = createBundle(gl, parsed);
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);
const bundleNoCull = createBundle(gl, await importSvg(${JSON.stringify(SVG)}), { occlusionCull:false });
renderer.prepareBundle(bundleNoCull);
await renderer.awaitLbReady(bundleNoCull);
const readAll = () => { const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const draw = (mode, b) => { renderer.setLoopBlinnFill(mode);
  renderer.beginFrame([0,0.8,0,1]); renderer.drawBundle(b||bundle); renderer.endFrame(); return readAll(); };
const slug = draw('off'); const lb = draw('on');
const lbNoCull = draw('on', bundleNoCull);
globalThis.__LB_NO_DEPTH=true; const lbNoDepth = draw('on'); globalThis.__LB_NO_DEPTH=false;
// seam pixels (LB vs Slug) with cull on vs off
const seamCount = (a)=>{ let n=0; for(let i=0;i<${N}*${N};i++){const o=i*4;
  const d=Math.abs(a[o]-slug[o])+Math.abs(a[o+1]-slug[o+1])+Math.abs(a[o+2]-slug[o+2]); if(d>12)n++;} return n; };
const seamOn = seamCount(lb), seamOff = seamCount(lbNoCull), seamNoDepth = seamCount(lbNoDepth);
// locate the densest diff cell (16x16) — internal boundaries cluster there
let best=[0,0,-1]; const CELL=16;
for(let cy=0;cy<${N};cy+=CELL)for(let cx=0;cx<${N};cx+=CELL){ let n=0;
  for(let y=cy;y<cy+CELL;y++)for(let x=cx;x<cx+CELL;x++){ const o=(y*${N}+x)*4;
    const d=Math.abs(lb[o]-slug[o])+Math.abs(lb[o+1]-slug[o+1])+Math.abs(lb[o+2]-slug[o+2]); if(d>12)n++; }
  if(n>best[2]) best=[cx,cy,n]; }
const [bx,by]=best;
// magnify a 40px window around the densest cell, 10x, three panels: LB | Slug | ref-white-diff
const WIN=48, MZ=10, ox=112, oy=0;
function panel(get){ const cv=document.createElement('canvas'); cv.width=WIN*MZ; cv.height=WIN*MZ; const ct=cv.getContext('2d');
  const id=ct.createImageData(WIN*MZ,WIN*MZ);
  for(let y=0;y<WIN*MZ;y++)for(let x=0;x<WIN*MZ;x++){ const sx=ox+((x/MZ)|0), sy=oy+((y/MZ)|0);
    const o=((${N}-1-sy)*${N}+sx)*4; const dd=(y*WIN*MZ+x)*4; const c=get(o); id.data[dd]=c[0];id.data[dd+1]=c[1];id.data[dd+2]=c[2];id.data[dd+3]=255; }
  ct.putImageData(id,0,0); return cv.toDataURL('image/png'); }
const lbUrl=panel(o=>[lb[o],lb[o+1],lb[o+2]]);
const slugUrl=panel(o=>[slug[o],slug[o+1],slug[o+2]]);
const diffUrl=panel(o=>{ const d=Math.abs(lb[o]-slug[o])+Math.abs(lb[o+1]-slug[o+1])+Math.abs(lb[o+2]-slug[o+2]); return d>12?[255,0,0]:[lb[o],lb[o+1],lb[o+2]]; });
// numeric: on a scanline through the densest cell, dump LB vs Slug where they differ
const scan=[]; const sy=Math.min(${N}-1, by+8);
for(let x=ox;x<ox+WIN;x++){ const o=((${N}-1-sy)*${N}+x)*4;
  scan.push([x, [lb[o],lb[o+1],lb[o+2]], [slug[o],slug[o+1],slug[o+2]]]); }
window.__out={ best, ox, oy, sy, scan, seamOn, seamOff, numShapes: bundle.numShapes, seamNoDepth, hasOcc: !!bundle.hasOccupancy, lbUrl, slugUrl, diffUrl };
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
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
const o = await page.evaluate(() => window.__out);
console.log(
  'SEAM vs Slug: cull-on=' +
    o.seamOn +
    ' cull-off=' +
    o.seamOff +
    ' numShapes=' +
    o.numShapes +
    ' hasOcc=' +
    o.hasOcc +
    ' SEAM-no-depth=' +
    o.seamNoDepth,
);
console.log('densest diff cell @', o.best, ' window origin', o.ox, o.oy);
console.log('scanline y=%d (x: LB rgb | Slug rgb):', o.sy);
for (const [x, l, s] of o.scan)
  console.log('  x=%d  LB=[%s]  Slug=[%s]', x, l.join(','), s.join(','));
for (const [k, f] of [
  ['lbUrl', 'conf_lb.png'],
  ['slugUrl', 'conf_slug.png'],
  ['diffUrl', 'conf_diff.png'],
])
  if (o[k]) writeFileSync('probes/_hudCaptureOut/' + f, Buffer.from(o[k].split(',')[1], 'base64'));
console.log('wrote conf_lb.png conf_slug.png conf_diff.png');
await browser.close();
server.close();
