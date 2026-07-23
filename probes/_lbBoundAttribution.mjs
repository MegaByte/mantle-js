// _lbBoundAttribution — is LB fragment-bound or vertex/draw-bound?
//
// Decides whether the AAC-style compile-time kernel specialization (omit unused
// curve-kind branches from the fragment shader) can pay for LB at all. It only pays
// if the FRAGMENT stage is the bottleneck. Two independent sweeps on the same code:
//   A. hold geometry fixed, scale the viewport  → scales FRAGMENTS (16x from 256→1024)
//   B. hold the viewport fixed, scale segments  → scales TRIANGLES (10.7x from 48→512)
// Whichever axis LB's time tracks is the axis worth optimising.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function star(K){ const cx=256,cy=256,R0=200,amp=26,lobes=17; let d='';
  for(let i=0;i<K;i++){ const a=(i/K)*2*Math.PI, r=R0+amp*Math.sin(lobes*a);
    d+=(i?'L ':'M ')+(cx+r*Math.cos(a)).toFixed(3)+' '+(cy+r*Math.sin(a)).toFixed(3)+' '; }
  return d+'Z'; }
const wrap=(d)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path fill="#3366cc" d="${d}"/></svg>`;
const SEGS=[48,128,256,512], VPS=[256,512,1024];
const SVGS={}; for(const s of SEGS) SVGS['seg'+s]=wrap(star(s));
const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS=${JSON.stringify(SVGS)}, SEGS=${JSON.stringify(SEGS)}, VPS=${JSON.stringify(VPS)};
const K=12, sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const rLB=createRenderer(gl,shaders,{typeOmit:true}); rLB.setLoopBlinnFill('on');
const rSL=createRenderer(gl,shaders,{typeOmit:true}); rSL.setLoopBlinnFill('off');
const amort=(r,b)=>{const runs=[]; for(let rep=0;rep<7;rep++){
  r.beginFrame([1,1,1,1]); for(let i=0;i<2;i++) r.drawBundle(b); r.endFrame(); sync();
  const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync();
  runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[3];};
const out={};
try{
  for(const s of SEGS){
    const b=createBundle(gl, await importSvg(SVGS['seg'+s]));
    rLB.prepareBundle&&rLB.prepareBundle(b);
    out['seg'+s]={};
    for(const vp of VPS){
      rLB.setViewport(vp,vp); rSL.setViewport(vp,vp); gl.viewport(0,0,vp,vp);
      // order-corrected
      const f1=amort(rLB,b), f2=amort(rSL,b), r2=amort(rSL,b), r1=amort(rLB,b);
      out['seg'+s][vp]={lb:Math.min(f1,r1), slug:Math.min(f2,r2)};
    }
    b.dispose();
  }
}catch(e){ window.__err=String(e)+'\\n'+e.stack; }
window.__out=out; window.__ready=true;</script></body></html>`;
const server=http.createServer((q,res)=>{try{if(q.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;}const pp=decodeURIComponent(q.url.split('?')[0]);res.writeHead(200,{'content-type':pp.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,pp)));}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const pg=await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:120000});
await pg.waitForFunction(()=>window.__ready===true,{timeout:240000});
const err=await pg.evaluate(()=>window.__err); const o=await pg.evaluate(()=>window.__out);
await br.close(); server.close();
if(err){console.error('threw:',err);process.exit(1);}
console.log('LB ms/draw            viewport (fragments ->)');
console.log('segments      ' + VPS.map(v=>String(v+'²').padStart(9)).join('') + '   |  frag scaling 256->1024 (16x px)');
for(const s of SEGS){
  const r=VPS.map(v=>o['seg'+s][v].lb);
  console.log(`${String(s).padStart(8)}      ` + r.map(x=>x.toFixed(3).padStart(9)).join('') + `   |  ${(r[2]/r[0]).toFixed(2)}x`);
}
console.log('\nsegment scaling at each viewport (48->512 = 10.7x triangles):');
for(const v of VPS){
  const lo=o['seg48'][v].lb, hi=o['seg512'][v].lb;
  console.log(`  vp=${String(v).padStart(4)}²  LB ${lo.toFixed(3)} -> ${hi.toFixed(3)}  = ${(hi/lo).toFixed(2)}x`);
}
console.log('\nSlug, same sweep (for contrast — Slug IS fragment-bound):');
for(const s of SEGS){
  const r=VPS.map(v=>o['seg'+s][v].slug);
  console.log(`${String(s).padStart(8)}      ` + r.map(x=>x.toFixed(3).padStart(9)).join('') + `   |  ${(r[2]/r[0]).toFixed(2)}x`);
}
