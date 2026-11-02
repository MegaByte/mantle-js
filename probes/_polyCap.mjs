// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _polyCap — at what VERTEX COUNT does a single polygon stop rendering?
// poly5000.svg (one 5000-point polygon) renders blank on all three engines.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
const COUNTS = (process.env.COUNTS || '64,256,512,1000,1024,1100,2048,5000').split(',').map(Number);
const poly = (n) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    p.push((64 + 56 * Math.cos(a)).toFixed(3) + ',' + (64 + 56 * Math.sin(a)).toFixed(3));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><polygon points="${p.join(' ')}" fill="#000"/></svg>`;
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const mk=(o,lb)=>{const r=createRenderer(gl,shaders,o); r.setViewport(${N},${N}); r.setLoopBlinnFill(lb); return r;};
const ENG=[['slug',mk({},"off")],['aac',mk({aacFill:true},"off")],['lb',mk({},"on")]];
const COUNTS=${JSON.stringify(COUNTS)};
const SVGS=${JSON.stringify(COUNTS.map(poly))};
const out=[];
for(let i=0;i<COUNTS.length;i++){
  const row={n:COUNTS[i]};
  for(const [nm,r] of ENG){
    const b=createBundle(gl, await importSvg(SVGS[i])); r.prepareBundle(b);
    if(r.awaitLbReady){try{await r.awaitLbReady(b);}catch{}}
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const px=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
    let ink=0; for(let k=0;k<px.length;k+=4) if(px[k]<250||px[k+1]<250||px[k+2]<250) ink++;
    row[nm]=ink; b.dispose();
  }
  out.push(row);
}
window.__out=out; window.__ready=true;
</${'script'}></body></html>`;
const server = http.createServer((q, res) => {
  const f = q.url.split('?')[0];
  if (f === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, f));
    const e = path.extname(f);
    res.writeHead(200, {
      'Content-Type':
        e === '.js' || e === '.mjs'
          ? 'text/javascript'
          : e === '.glsl'
            ? 'text/plain'
            : 'application/octet-stream',
    });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__ready===true', { timeout: 180000, polling: 50 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
const exp = Math.PI * 56 * 56 * (N / 128) * (N / 128);
console.log(`\n  one polygon, ${N}px canvas — expected ink ~${Math.round(exp)} px\n`);
console.log('   verts      slug       aac        lb');
for (const r of o)
  console.log(
    `   ${String(r.n).padStart(5)} ${String(r.slug).padStart(9)} ${String(r.aac).padStart(9)} ${String(r.lb).padStart(9)}` +
      (r.slug < exp * 0.5 || r.aac < exp * 0.5 || r.lb < exp * 0.5 ? '   <-- BLANK/PARTIAL' : ''),
  );
