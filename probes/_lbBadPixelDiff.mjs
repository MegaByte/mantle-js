// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Locate the worst-disagreeing pixels between the LB fill and AAC on tiger, and dump
// enough context to decide whether they are a DEFECT or an isolated AA disagreement.
// Run once per code state; compare the coordinate lists.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHICH = process.argv[3] || 'tiger';
const TIGER =
  WHICH === 'tiger'
    ? readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8')
    : readFileSync(path.join(ROOT, '../fixtures/svg/' + WHICH + '.svg'), 'utf8');
const TAG = process.argv[2] || 'state';
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const rLb=createRenderer(gl,shaders,{}); rLb.setLoopBlinnFill('on');
const rRef=createRenderer(gl,shaders,{aacFill:true});
async function shot(r,sec,n){
  const b=createBundle(gl,sec,{preferBezout:(new URL(location.href)).searchParams.get('bez')==='1'});
  r.prepareBundle&&r.prepareBundle(b);
  if(r.awaitLbReady) await r.awaitLbReady(b,20000).catch(()=>{});
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px=new Uint8Array(n*n*4); gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,px); b.dispose(); return px;
}
window.__run=async(svg,n)=>{
  const sec=await importSvg(svg);
  const A=await shot(rLb,sec,n), B=await shot(rRef,sec,n);
  const hits=[];
  // full RGB distance, not just the red channel: a hue-only error would hide in luminance
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=(y*n+x)*4;
    const d=Math.max(Math.abs(A[i]-B[i]),Math.abs(A[i+1]-B[i+1]),Math.abs(A[i+2]-B[i+2]));
    if(d>200) hits.push({x,y:n-1-y,d,lb:[A[i],A[i+1],A[i+2]],aac:[B[i],B[i+1],B[i+2]]});
  }
  hits.sort((p,q)=>q.d-p.d);
  // mean |LB-AAC| over pixels either engine inks: if the AA band were MISSING the
  // curve would be hard-edged against an antialiased reference and this would be large.
  let sum=0,cnt=0;
  for(let i=0;i<A.length;i+=4){ const a=255-A[i], b=255-B[i];
    if(a>4||b>4){ sum+=Math.abs(a-b); cnt++; } }
  const meanErr=+(sum/Math.max(cnt,1)).toFixed(3);
  // neighborhood of the worst hit, LB minus AAC per pixel — a lone spike vs a seam
  let nb=[];
  if(hits.length){
    const {x,y}=hits[0], gy=n-1-y;
    for(let dy=-2;dy<=2;dy++){ const row=[];
      for(let dx=-2;dx<=2;dx++){ const xx=x+dx, yy=gy+dy;
        if(xx<0||yy<0||xx>=n||yy>=n){row.push('  --');continue;}
        const i=(yy*n+xx)*4;
        row.push(String(Math.max(Math.abs(A[i]-B[i]),Math.abs(A[i+1]-B[i+1]),Math.abs(A[i+2]-B[i+2]))).padStart(4));
      } nb.push(row.join('')); }
  }
  return {meanErr, count:hits.length, top:hits.slice(0,8), nb, all:hits.map(h=>h.x+','+h.y)};
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': mime(pp) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/?bez=${process.env.BEZ || '0'}`, {
  waitUntil: 'load',
  timeout: 60000,
});
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const r = await pg.evaluate((s) => window.__run(s, 512), TIGER);
console.log(`[${TAG}] bad>200: ${r.count}   mean|LB-AAC| over inked px: ${r.meanErr}/255`);
for (const h of r.top)
  console.log(
    `  (${String(h.x).padStart(3)},${String(h.y).padStart(3)}) d=${h.d}  LB=${h.lb.join(',')}  AAC=${h.aac.join(',')}`,
  );
if (r.nb.length) {
  console.log('  5x5 neighborhood of worst (channel-diff):');
  for (const row of r.nb) console.log('   ' + row);
}
writeFileSync(`/tmp/maxpx.${TAG}.json`, JSON.stringify(r.all));
await br.close();
server.close();
