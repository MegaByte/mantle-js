// _lbImageBatch — do <image> shapes ride LB's one-draw combined route, each with its OWN
// rect + atlas slot? Images used to force the per-shape route, like gradients did.
// Images are ~0% of the corpus; this closes the paint-batching story (gradient + image).
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const N=256;
const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, K=10;
// distinct 16x16 PNG tiles, drawn in-page
const tile=(hue)=>{const c=document.createElement('canvas'); c.width=c.height=16; const x=c.getContext('2d');
  x.fillStyle='hsl('+hue+',80%,50%)'; x.fillRect(0,0,16,16);
  x.fillStyle='hsl('+((hue+180)%360)+',80%,35%)'; x.beginPath(); x.arc(8,8,5,0,7); x.fill();
  return c.toDataURL('image/png'); };
const sheet=(Kn)=>{ const cols=Math.round(Math.sqrt(Kn)), cell=N/cols; let body='';
  for(let i=0;i<Kn;i++){ const x=(i%cols)*cell, y=Math.floor(i/cols)*cell;
    body+='<image xlink:href="'+tile((i*61)%360)+'" x="'+(x+2)+'" y="'+(y+2)+'" width="'+(cell-4)+'" height="'+(cell-4)+'"/>'; }
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 '+N+' '+N+'" width="'+N+'" height="'+N+'">'+body+'</svg>'; };
const r=createRenderer(gl,shaders);
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const readAll=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
const amort=(b)=>{const runs=[]; for(let rep=0;rep<5;rep++){
  r.beginFrame([1,1,1,1]); for(let i=0;i<2;i++) r.drawBundle(b); r.endFrame(); sync();
  const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync();
  runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[2];};
const out=[];
try{
for(const Kn of [4,16]){
  const b=createBundle(gl, await importSvg(sheet(Kn))); r.prepareBundle(b);
  const draw=()=>{r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();};
  r.setLoopBlinnFill('off'); draw(); const s=readAll(); const off=amort(b);
  const c0=r.debugStats.loopBlinnRouteCount;
  r.setLoopBlinnFill('on'); draw(); const l=readAll(); const on=amort(b);
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  let mx=0,sum=0; for(let i=0;i<s.length;i++){const d=Math.abs(s[i]-l[i]); if(d>mx)mx=d; sum+=d;}
  out.push({name:'images x'+Kn, hasAtlas:!!b.imageAtlasTex, mfps:b.metaFloatsPerShape|0,
    combined:!!b._lbCombined, routed, maxDiff:mx, meanDiff:sum/s.length, off, on});
  b.dispose();
}}catch(e){ window.__err=String(e)+'\\n'+e.stack; }
window.__out=out; window.__ready=true;</script></body></html>`;
const server=http.createServer((q,res)=>{try{if(q.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;}const pp=decodeURIComponent(q.url.split('?')[0]);res.writeHead(200,{'content-type':pp.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,pp)));}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const pg=await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load',timeout:90000});
await pg.waitForFunction(()=>window.__ready===true,{timeout:180000});
const err=await pg.evaluate(()=>window.__err); const o=await pg.evaluate(()=>window.__out);
await br.close(); server.close();
if(err){console.error('threw:',err);process.exit(1);}
console.log('case         atlas mfps combined routed | lbOff  lbOn  speedup | meanDiff maxDiff');
for(const r of o) console.log(`${r.name.padEnd(12)} ${String(r.hasAtlas).padStart(5)} ${String(r.mfps).padStart(4)} ${String(r.combined).padStart(8)} ${String(r.routed).padStart(6)} | ${r.off.toFixed(3)} ${r.on.toFixed(3)} ${(r.off/r.on).toFixed(2)}x  | ${r.meanDiff.toFixed(3).padStart(8)} ${String(r.maxDiff).padStart(7)}`);
