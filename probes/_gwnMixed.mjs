// _gwnMixed — hypothesis: GWN wins on PURE curve types, loses on MIXED. Likely cause: GWN's tree
// leaf iterates segments in tree order (mixed types → GPU warp runs every type branch), while
// Slug/AAC use type-GROUPED monomorphic sub-loops. Controlled test: one big shape, N segments,
// either all-one-type or evenly-mixed L/Q/C/A. If GWN degrades MORE than AAC going pure→mixed, the
// divergence hypothesis holds.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;
const ring = (K, cx, cy, r) => Array.from({length:K}, (_,j)=>[cx+r*Math.cos(2*Math.PI*j/K), cy+r*Math.sin(2*Math.PI*j/K)]);
const seg = { // edge from A to B of a given type; T = tangent for cubic
  line: (A,B)=>`L ${B[0].toFixed(2)} ${B[1].toFixed(2)} `,
  quad: (A,B)=>{const mx=(A[0]+B[0])/2+(B[1]-A[1])*0.1, my=(A[1]+B[1])/2-(B[0]-A[0])*0.1; return `Q ${mx.toFixed(2)} ${my.toFixed(2)} ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;},
  cubic: (A,B)=>{const dx=B[0]-A[0],dy=B[1]-A[1]; return `C ${(A[0]+dx*0.3-dy*0.1).toFixed(2)} ${(A[1]+dy*0.3+dx*0.1).toFixed(2)} ${(B[0]-dx*0.3-dy*0.1).toFixed(2)} ${(B[1]-dy*0.3+dx*0.1).toFixed(2)} ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;},
  arc: (A,B)=>{const rr=Math.hypot(B[0]-A[0],B[1]-A[1])*0.7; return `A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;},
};
const shape = (K, types) => { const P = ring(K, N/2, N/2, N*0.44); let d=`M ${P[0][0].toFixed(2)} ${P[0][1].toFixed(2)} `;
  for(let j=0;j<K;j++){ const t = types[j % types.length]; d += seg[t](P[j], P[(j+1)%K]); } return d+'Z'; };
const svg = (d)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#204080" d="${d}"/></svg>`;
const K = 128;
const CASES = {
  'pure line':  svg(shape(K, ['line'])),
  'pure quad':  svg(shape(K, ['quad'])),
  'pure cubic': svg(shape(K, ['cubic'])),
  'pure arc':   svg(shape(K, ['arc'])),
  'mixed LQCA': svg(shape(K, ['line','quad','cubic','arc'])),
  'mixed QC':   svg(shape(K, ['quad','cubic'])),
};
const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rAac=createRenderer(gl,shaders,{aacFill:true}); rAac.setLoopBlinnFill('off');
const rGwn=createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rGwn.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const ink=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let s=0; for(let i=0;i<N*N;i++) s+=(255-p[i*4])/255; return s;};
const run=(r,sec)=>{const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const nk=ink();
  const KK=24, runs=[]; for(let rep=0;rep<9;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<KK;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/KK);} runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[4],ink:nk};};
window.__run=async(cases)=>{const out=[];
  for(const [name,s] of Object.entries(cases)){ const p=await importSvg(s), t=await importSvg(s,{gwnTree:true});
    const sl=run(rSlug,p), a=run(rAac,p), g=run(rGwn,t);
    out.push({name, slug:sl.ms, aac:a.ms, gwn:g.ms, drift:Math.abs(g.ink-sl.ink)/Math.max(sl.ink,1)*100});} return out;};
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
console.log('\\n  '+K+'-segment shape, pure vs mixed types (ms/draw). GWN/AAC = ratio to that engine pure-quad.\\n');
console.log('  case         |  Slug    AAC    GWN  | GWN/AAC | drift');
const aQ=o.find(r=>r.name==='pure quad'), gQ=aQ;
for(const r of o) console.log(`  ${r.name.padEnd(12)} | ${r.slug.toFixed(3)}  ${r.aac.toFixed(3)}  ${r.gwn.toFixed(3)} |  ${(r.gwn/r.aac).toFixed(2)}x  | ${r.drift.toFixed(1)}%`);
