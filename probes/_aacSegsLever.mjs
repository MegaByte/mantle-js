// _aacSegsLever — the cubic-gate lever. The AAC vs Slug crossover is gated on px²/shape, but the
// code notes tiger-paths and CFF glyphs at the SAME px²/shape pick opposite engines. Hypothesis:
// the missing dimension is SEGMENTS per shape (AAC walks all band segments per fragment; Slug
// root-solves per ray). Hold px²/shape ~fixed, vary segment count; if the crossover moves, segs is
// the discriminant. Same disc pinned to a fixed on-screen size, K segments.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N=1024;
const cubicDisc = (K, r) => { const c=N/2; const P=(j)=>[c+r*Math.cos(2*Math.PI*j/K),c+r*Math.sin(2*Math.PI*j/K)];
  const T=(j)=>{const a=2*Math.PI*j/K; return [-Math.sin(a),Math.cos(a)];}; const h=r*2*Math.PI/K/3;
  let d=`M ${P(0)[0].toFixed(2)} ${P(0)[1].toFixed(2)} `;
  for(let j=0;j<K;j++){const A=P(j),B=P(j+1),ta=T(j),tb=T(j+1); d+=`C ${(A[0]+ta[0]*h).toFixed(2)} ${(A[1]+ta[1]*h).toFixed(2)} ${(B[0]-tb[0]*h).toFixed(2)} ${(B[1]-tb[1]*h).toFixed(2)} ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;}
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#204080" d="${d}Z"/></svg>`; };
const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rAac=createRenderer(gl,shaders,{aacFill:true}); rAac.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const measure=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let y0=N,y1=0,ink=0;
  for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(p[(y*N+x)*4]<230){ink++; if(y<y0)y0=y; if(y>y1)y1=y;} return {h:y1-y0,ink};};
const pin=(r,b,px)=>{ r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const m=measure(); if(m.h<=0) return m; const k=m.h/px,g=b.globalBBox; b.globalBBox=[g[0],g[1],g[2]*k,g[3]*k]; if(b._geomGen!=null)b._geomGen++; return m; };
const time=(r,b)=>{ r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const K=24,runs=[]; for(let rep=0;rep<9;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[4]; };
window.__run=async(shapes, sizes)=>{
  const out=[];
  for(const {K,svg} of shapes){
    const plain=await importSvg(svg);
    for(const px of sizes){
      const bS=createBundle(gl,plain), bA=createBundle(gl,plain);
      const m=pin(rSlug,bS,px); pin(rAac,bA,px);
      const px2 = Math.round(m.ink * (px/m.h)*(px/m.h));   // fragments at target size (ink scaled)
      const tS=time(rSlug,bS), tA=time(rAac,bA);
      out.push({K, px, px2:Math.round(px*px*3.14/4), tS, tA, win: tA<tS?'AAC':'Slug', ratio:tA/tS});
      bS.dispose(); bA.dispose();
    }
  }
  return out;
};
window.__ready=true;
</script></body></html>`;
const server=http.createServer((q,res)=>{try{if(q.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;}
const pp=decodeURIComponent(q.url.split('?')[0]);res.writeHead(200,{'content-type':pp.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,pp)));}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const pg=await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load',timeout:90000});
await pg.waitForFunction(()=>window.__ready===true,{timeout:180000,polling:50});
const SHAPES=[8,32,128].map(K=>({K, svg:cubicDisc(K, N*0.44)}));
const o=await pg.evaluate((sh,s)=>window.__run(sh,s), SHAPES, [48,96,192,384]);
await br.close(); server.close();
console.log('\\n  cubic disc, AAC vs Slug crossover vs SEGMENTS (px2/shape ~ px*px*0.78).\\n');
console.log('  segs | onscreen | ~px2/shape | Slug   AAC  | win | AAC/Slug');
let lastK='';
for(const r of o){ if(r.K!==lastK){ console.log('  -- '+r.K+' cubic segments --'); lastK=r.K; }
  console.log(`  ${String(r.K).padStart(4)} | ${String(r.px).padStart(5)}px  | ${String(r.px2).padStart(8)}  | ${r.tS.toFixed(3)}  ${r.tA.toFixed(3)} | ${r.win} | ${r.ratio.toFixed(2)}`); }
