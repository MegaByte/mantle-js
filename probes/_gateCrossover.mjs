// _gateCrossover — the selection-gate validation. Render the SAME content at a range of ON-SCREEN
// pixel sizes (pinned via globalBBox, not fit-to-viewport) and find where each engine wins. This
// covers BOTH regimes the earlier benches missed: small-on-screen (few fragments, fixed cost
// dominates) and large (fragment-bound). All 4 engines; LB draw-only (prepared once).
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N=1024;
const CONTENT = [];
for (const f of ['icon_rotate', 'quad_torso', 'cubic_onion', 'detail_fish']) {
  try { CONTENT.push({ name: f, svg: readFileSync(path.join(ROOT,'examples/_bench',f+'.svg'),'utf8') }); } catch {}
}
try { CONTENT.push({ name:'tiger', svg: readFileSync(path.join(ROOT,'examples/tiger.svg'),'utf8') }); } catch {}
const SIZES = [16, 32, 64, 128, 256, 512];   // on-screen px of the content's bbox height

const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const Rf={ slug:createRenderer(gl,shaders,{}), aac:createRenderer(gl,shaders,{aacFill:true}),
  gwn:createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}), lb:createRenderer(gl,shaders,{}) };
Rf.slug.setLoopBlinnFill('off'); Rf.aac.setLoopBlinnFill('off'); Rf.gwn.setLoopBlinnFill('off'); Rf.lb.setLoopBlinnFill('on');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const measure=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let s=0,y0=N,y1=0;
  for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(p[(y*N+x)*4]<230){s++; if(y<y0)y0=y; if(y>y1)y1=y;} return {ink:s,h:y1-y0};};
// pin so the content's rendered bbox height == target px (2-pass calibrate).
const pin=(r,b,px)=>{ r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const h0=measure().h; if(h0<=0) return h0;
  const k=h0/px, g=b.globalBBox; b.globalBBox=[g[0],g[1],g[2]*k,g[3]*k]; if(b._geomGen!=null) b._geomGen++; return h0; };
const timeDraw=(r,b)=>{ r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const K=16, runs=[]; for(let rep=0;rep<7;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[3]; };
window.__run=async(content, sizes)=>{
  const out=[];
  for(const cs of content){
    const plain=await importSvg(cs.svg), tree=await importSvg(cs.svg,{gwnTree:true});
    for(const px of sizes){
      const bs={ slug:createBundle(gl,plain), aac:createBundle(gl,plain), gwn:createBundle(gl,tree), lb:createBundle(gl,plain) };
      pin(Rf.slug,bs.slug,px); pin(Rf.aac,bs.aac,px); const ah=pin(Rf.gwn,bs.gwn,px); pin(Rf.lb,bs.lb,px);
      Rf.lb.prepareBundle(bs.lb);
      out.push({name:cs.name, px, actualH:ah, slug:timeDraw(Rf.slug,bs.slug), aac:timeDraw(Rf.aac,bs.aac), gwn:timeDraw(Rf.gwn,bs.gwn), lb:timeDraw(Rf.lb,bs.lb)});
      for(const k in bs) bs[k].dispose();
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
const o=await pg.evaluate((c,s)=>window.__run(c,s), CONTENT, SIZES); await br.close(); server.close();
const win=(r)=>{const e={Slug:r.slug,AAC:r.aac,GWN:r.gwn,LB:r.lb}; let b='AAC',v=1e9; for(const k in e) if(e[k]<v){v=e[k];b=k;} return b;};
console.log('\\n  DRAW ms at ON-SCREEN size (content bbox height = px). LB draw-only. WIN=fastest.\\n');
let last='';
for(const r of o){ if(r.name!==last){ console.log(`  -- ${r.name} --`); console.log('   size |  Slug    AAC    GWN     LB   | WIN'); last=r.name; }
  console.log(`   ${String(r.px).padStart(3)}px | ${r.slug.toFixed(3)}  ${r.aac.toFixed(3)}  ${r.gwn.toFixed(3)}  ${r.lb.toFixed(3)} | ${win(r)}`); }
