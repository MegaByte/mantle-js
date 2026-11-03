// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _renderPng — render one SVG to PNGs, one per engine, so a defect can be LOOKED AT.
// An LB-vs-Slug audit cannot see a defect the two SHARE; an eye can.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 768);
const SRC = process.env.SVG;
const OUT = process.env.OUT || '/tmp';
const SVG = readFileSync(SRC, 'utf8');
// Extra importSvg options as JSON, merged AFTER preserveViewport, e.g.
//   OPTS='{"computeSilhouette":true,"outlineColor":[0,0,0,1]}'
// Empty (the default) leaves the call exactly as it was.
const OPTS = process.env.OPTS ? JSON.parse(process.env.OPTS) : {};
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const engines={ lb:createRenderer(gl,shaders,{cpatchFill:true}), slug:createRenderer(gl,shaders,{}) };
engines.slug.setLoopBlinnFill('off');
window.__run=async(svg,opts)=>{
  const out={}; const px={};
  // MATCH THE AUDIT: preserveViewport keeps the SVG's own viewBox (without it the
  // content is fit to its bbox, a different scale entirely), and awaitLbReady is
  // mandatory — LB meshes build off-thread, so the first frame without it renders
  // through SLUG. Both arms were silently Slug before this, which is exactly why
  // the LB-vs-Slug diff came back as zero.
  const sec=await importSvg(svg, Object.assign({ preserveViewport: true }, opts||{}));
  for(const [name,r] of Object.entries(engines)){
    const b=createBundle(gl,sec);
    if (r.prepareBundle) r.prepareBundle(b);
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    px[name]=p;
    if(name==='lb') out.__routed = (r.debugStats&&r.debugStats.loopBlinnRouteCount)|0;
    out[name]=cv.toDataURL('image/png');
    b.dispose();
  }
  // AMPLIFIED DIFF. A wedge gap is a handful of pixels wide; at 1:1 it is invisible
  // next to the shape itself, so paint any difference at full strength.
  const a=px.lb, c2=px.slug;
  let nd=0, max=0;
  const dc=document.createElement('canvas'); dc.width=N; dc.height=N;
  const ctx=dc.getContext('2d'); const img=ctx.createImageData(N,N);
  for(let i=0;i<N*N;i++){
    const d=Math.max(Math.abs(a[i*4]-c2[i*4]),Math.abs(a[i*4+1]-c2[i*4+1]),Math.abs(a[i*4+2]-c2[i*4+2]),Math.abs(a[i*4+3]-c2[i*4+3]));
    if(d){ nd++; if(d>max) max=d; }
    // LB darker than Slug (LB painted MORE) = blue; LB lighter (UNDER-fill) = red.
    const lbLum=a[i*4]+a[i*4+1]+a[i*4+2], slugLum=c2[i*4]+c2[i*4+1]+c2[i*4+2];
    const o=((N-1-(i/N|0))*N + (i%N))*4;   // flip Y for canvas order
    img.data[o]   = d ? (lbLum > slugLum ? 255 : 0) : 255;
    img.data[o+1] = d ? 0 : 255;
    img.data[o+2] = d ? (lbLum > slugLum ? 0 : 255) : 255;
    img.data[o+3] = 255;
  }
  ctx.putImageData(img,0,0);
  out.diff = dc.toDataURL('image/png');
  out.__stats = {nd, max};
  return out;
};
window.__ready=true;
</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((s, op) => window.__run(s, op), SVG, OPTS);
await br.close();
server.close();
const base = path.basename(SRC).replace(/\.svg$/, '');
if (o.__stats)
  console.log(
    `  LB routed ${o.__routed | 0} shapes · differing px ${o.__stats.nd}  max delta ${o.__stats.max}  (red = LB UNDER-fills, blue = LB over-fills)`,
  );
for (const [name, dataUrl] of Object.entries(o)) {
  if (name === '__stats' || name === '__routed') continue;
  const f = path.join(OUT, `${base}_${N}__${name}.png`);
  writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', f);
}
