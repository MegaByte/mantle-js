// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// PARTIAL ALPHA over OVERLAPPING PATCHES. CPatch decomposes a shape into patches that overlap by
// construction. At alpha 1 an overlap is invisible — painting opaque twice looks like painting it
// once. At partial alpha it is not: two OVER composites of a=0.5 give 0.75, not 0.5, so every
// overlap darkens. The depth claim exists to make each pixel accept exactly one patch; this checks
// whether it actually does, at a range of alphas, against Slug drawing the same shape.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALPHAS = (process.env.ALPHAS || '1,0.75,0.5,0.25').split(',').map(Number);
const SEGS = +(process.env.SEGS || 16);
const CPAA = process.env.CPAA ? +process.env.CPAA : null;
const PAGE = `<!doctype html><body><canvas id=c width=320 height=320></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
${(process.env.CPGLOBALS || '')
  .split(';')
  .filter(Boolean)
  .map((kv) => {
    const [k, v] = kv.split('=');
    return `globalThis[${JSON.stringify(k)}]=${v === 'true' || v === 'false' || !isNaN(+v) ? v : JSON.stringify(v)};`;
  })
  .join('')}
const SEGS=${SEGS}, ALPHAS=${JSON.stringify(ALPHAS)}, N=320;
const CPAA=${JSON.stringify(CPAA)};
const ring=(a)=>{const cx=64,cy=64,r=44,P=[];
  for(let i=0;i<SEGS;i++){const t=-Math.PI/2+i*2*Math.PI/SEGS;P.push([cx+r*Math.cos(t),cy+r*Math.sin(t)]);}
  let d='M'+P[0][0].toFixed(4)+' '+P[0][1].toFixed(4);
  for(let i=0;i<SEGS;i++){const p=P[i],q=P[(i+1)%SEGS],mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,bx=cx+(mx-cx)*1.18,by=cy+(my-cy)*1.18;
    d+=' Q'+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);}
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="'+d+' Z" fill="#265b9b" fill-opacity="'+a+'"/></svg>';};
const shot=async(route,a,depth)=>{
  const opts = route==='cpatch' ? {cpatchFill:true,cpatchOpts:(CPAA?{gridAaPx:CPAA}:{}), ...(depth===false?{unifiedFillDepthClaim:false}:{})} : {};
  const r=createRenderer(gl,shaders,opts); r.setViewport(N,N); r.setFillEngine({route});
  const b=createBundle(gl,await importSvg(ring(a))); r.prepareBundle(b);
  if(r.awaitEngine){try{await r.awaitEngine(b,route,60000);}catch{}}
  r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();
  const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const ds=r.debugStats,e=ds.engines&&ds.engines.draws||{};
  return {px, built:b._cpatchBuilt|0, drew:Object.keys(e).filter(k=>e[k]>0).join('+')||'none'};};
const cmp=(A,B)=>{let n=0,worst=0,sum=0,cnt=0;
  for(let i=0;i<A.length;i+=4){let d=0; for(let k=0;k<3;k++) d=Math.max(d,Math.abs(A[i+k]-B[i+k]));
    if(d>worst)worst=d; if(d>8){n++;} if(A[i+3]>8||B[i+3]>8){sum+=d;cnt++;} }
  return {n,worst,mean:cnt?sum/cnt:0};};
const out=[];
for(const a of ALPHAS){ const ref=await shot('none',a);
  const cpOn=await shot('cpatch',a,true), cpOff=await shot('cpatch',a,false);
  out.push({a, on:{...cmp(ref.px,cpOn.px),built:cpOn.built,drew:cpOn.drew},
               off:{...cmp(ref.px,cpOff.px),built:cpOff.built,drew:cpOff.drew}}); }
window.__out=out; window.__ready=true;
</script></body>`;
const srv = http.createServer((q, r) => {
  try {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    r.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    r.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!r.headersSent) r.writeHead(404);
    r.end();
  }
});
await new Promise((x) => srv.listen(0, '127.0.0.1', x));
const port = srv.address().port;
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[pg]', e.message));
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready, { timeout: 300000 });
const o = await pg.evaluate(() => window.__out);
console.log(
  `\n  ${SEGS}-segment quad ring vs Slug, by fill-opacity  (wrong = >8/255 on any channel)\n`,
);
console.log('  alpha   depthClaim ON              depthClaim OFF');
console.log('          wrong   worst   mean       wrong   worst   mean    drew');
for (const r of o)
  console.log(
    '  ' +
      String(r.a).padEnd(7) +
      String(r.on.n).padStart(6) +
      String(r.on.worst).padStart(8) +
      r.on.mean.toFixed(2).padStart(8) +
      '   ' +
      String(r.off.n).padStart(6) +
      String(r.off.worst).padStart(8) +
      r.off.mean.toFixed(2).padStart(8) +
      '    ' +
      r.on.drew +
      '/' +
      r.off.drew,
  );
await br.close();
srv.close();
