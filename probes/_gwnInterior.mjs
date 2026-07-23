// _gwnInterior — the REAL driver of GWN's cost on filled content. Type-mixing is not it (GWN is
// type-flat, _gwnMixed). Hypothesis: INTERIOR pixels. A filled disc's interior forces tree descent
// (the pixel sits inside many nodes' bounding circles), while AAC's band walk is O(few) for
// interior. Test: same 64-seg cubic disc at increasing RADIUS (more interior area, same boundary
// complexity). If GWN scales with interior area MORE than AAC, interior descent is the cost.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 1024;
const disc = (rFrac) => { const c=N/2, r=N*rFrac, K=64;
  const P=(j)=>[c+r*Math.cos(2*Math.PI*j/K), c+r*Math.sin(2*Math.PI*j/K)];
  const T=(j)=>{const a=2*Math.PI*j/K; return [-Math.sin(a),Math.cos(a)];}; const h=r*2*Math.PI/K/3;
  let d=`M ${P(0)[0].toFixed(2)} ${P(0)[1].toFixed(2)} `;
  for(let j=0;j<K;j++){const A=P(j),B=P(j+1),ta=T(j),tb=T(j+1); d+=`C ${(A[0]+ta[0]*h).toFixed(2)} ${(A[1]+ta[1]*h).toFixed(2)} ${(B[0]-tb[0]*h).toFixed(2)} ${(B[1]-tb[1]*h).toFixed(2)} ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;}
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#204080" d="${d}Z"/></svg>`; };
const CASES = { 'r=0.12 (tiny interior)':disc(0.12), 'r=0.25':disc(0.25), 'r=0.37':disc(0.37), 'r=0.48 (huge interior)':disc(0.48) };
const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rAac=createRenderer(gl,shaders,{aacFill:true}); rAac.setLoopBlinnFill('off');
const rGwn=createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rGwn.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const ink=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let s=0; for(let i=0;i<N*N;i++) s+=(255-p[i*4])/255; return s;};
const run=(r,sec)=>{const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const nk=ink();
  const KK=16, runs=[]; for(let rep=0;rep<9;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<KK;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/KK);} runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[4],ink:nk};};
window.__run=async(cases)=>{const out=[];
  for(const [name,s] of Object.entries(cases)){ const p=await importSvg(s,{preserveViewport:true}), t=await importSvg(s,{preserveViewport:true,gwnTree:true});
    const a=run(rAac,p), g=run(rGwn,t); out.push({name, aac:a.ms, gwn:g.ms, ink:a.ink});} return out;};
window.__ready=true;
</script></body></html>`;
const server=http.createServer((q,res)=>{try{if(q.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;}
const pp=decodeURIComponent(q.url.split('?')[0]);res.writeHead(200,{'content-type':pp.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,pp)));}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const pg=await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load',timeout:90000});
await pg.waitForFunction(()=>window.__ready===true,{timeout:120000,polling:50});
const o=await pg.evaluate((c)=>window.__run(c), CASES); await br.close(); server.close();
console.log('\\n  64-seg cubic disc, increasing interior area @1024. ns/interior-px = ms/ink slope.\\n');
console.log('  radius                   |  AAC    GWN  | interior(k px) | AAC ns/px  GWN ns/px');
for(const r of o) console.log(`  ${r.name.padEnd(24)} | ${r.aac.toFixed(3)}  ${r.gwn.toFixed(3)} | ${(r.ink/1000).toFixed(0).padStart(5)}k  | ${(r.aac*1e6/r.ink).toFixed(2)}  ${(r.gwn*1e6/r.ink).toFixed(2)}`);
