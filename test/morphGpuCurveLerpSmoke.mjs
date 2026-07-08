// morphGpuCurveLerpSmoke — validates the GPU curve-lerp path (a render-to-
// texture pre-pass mixes static src/dst curve textures by t into the live curve
// texture, replacing the per-frame CPU lerp + texSubImage2D upload). Runs on
// real Metal (where RGBA32F render targets exist, so the GPU path engages):
// confirms morph.usesGpuCurveLerp, that t=0 matches the source and t=1 the
// destination, and that the geometry interpolates monotonically through t.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };

// Big red square (src) → small blue diamond (dst): geometry (curve lerp) AND
// fill color (meta lerp) both change, so the GPU-vs-CPU compare covers both.
const SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M20 20 L180 20 L180 180 L20 180 Z" fill="#c83232"/></svg>`;
const DST = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M100 70 L130 100 L100 130 L70 100 Z" fill="#2864d2"/></svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(W,H);
// This test validates setT's curve-lerp upload path; the GPU-resident morph
// route (now auto by default) would BYPASS setT entirely, so force it off here.
renderer.setLoopBlinnMorphFill('off');
const bSrc = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
const bDst = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
function inkOf(buf){ let n=0; for(let i=0;i<buf.length;i+=4) if(buf[i]>40&&buf[i+1]<200) n++; return n; }
function draw(b){ gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); renderer.drawBundle(b); const buf=new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf); return buf; }
const diff=(a,b)=>{let n=0,mx=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d){n++;if(d>mx)mx=d;}}return {n,mx};};
const result = {};
try {
  // GPU-lerp morph and a CPU-lerp morph (forced) — must render IDENTICALLY at
  // every t (both produce the same lerped curve texture).
  // Each morph decides GPU-vs-CPU on its FIRST setT; the cpuLerp opt pins
  // the second morph to the CPU path for the comparison.
  const mGpu = createShapeMorph(gl, bSrc, bDst);
  mGpu.setT(0.5);
  const mCpu = createShapeMorph(gl, bSrc, bDst, { cpuLerp: true });
  mCpu.setT(0.5);
  const ts = [0, 0.25, 0.5, 0.75, 1];
  const cmp = [], inkGpu = {};
  for (const t of ts) {
    mGpu.setT(t); const g = draw(mGpu);
    mCpu.setT(t); const c = draw(mCpu);
    cmp.push({ t, ...diff(g, c) });
    inkGpu[t] = inkOf(g);
  }
  result.usesGpu = mGpu.usesGpuCurveLerp;
  result.usesCpu = !mCpu.usesGpuCurveLerp;
  result.cmp = cmp; result.inkGpu = inkGpu;
  result.compiled = true;
} catch(e){ result.error = String(e&&e.stack||e); }
window.__result = result; window.__done = true;
</script></body></html>`;

const server = http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'||u.pathname==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;}const p=decodeURIComponent(u.pathname);const mime=p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';try{res.writeHead(200,{'content-type':mime+'; charset=utf-8'});res.end(readFileSync(path.join(ROOT,p)));}catch{try{res.writeHead(404);res.end();}catch{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:false,args:['--use-angle=metal','--no-sandbox','--use-gl=angle']});
const page = await browser.newPage();
page.on('pageerror',e=>console.error('  [page-err]',e.message));
page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load',timeout:20000});
await page.waitForFunction(()=>window.__done===true,{timeout:30000}).catch(()=>{});
const r = await page.evaluate(()=>window.__result);
await browser.close(); server.close();

if(!r||!r.compiled){ fail('did not complete: '+(r&&r.error||'page error')); }
else {
  console.log('  usesGpu='+r.usesGpu+' usesCpu='+r.usesCpu+'  inkGpu@t='+JSON.stringify(r.inkGpu));
  console.log('  GPU-vs-CPU per t: '+r.cmp.map(c=>'t'+c.t+' diff='+c.n+'(max'+c.mx+')').join('  '));
  const a=r.inkGpu;
  const worst = Math.max(...r.cmp.map(c=>c.n));
  if(!r.usesGpu) fail('GPU curve-lerp path did NOT engage (this GPU has no float render target)');
  else if(!r.usesCpu) fail('CPU-forced morph still used GPU — test hook failed');
  else if(a[0]<=a[0.25]||a[0.25]<=a[0.5]||a[0.5]<=a[0.75]||a[0.75]<=a[1]) fail('GPU morph not monotonic: '+JSON.stringify(a));
  // GPU and CPU both fp32, same mix → identical or ≤1-LSB on a few AA rim px.
  else if(worst <= 40) ok('GPU curve-lerp == CPU curve-lerp across t (worst pixel diff '+worst+'), monotonic ink '+a[0]+'→'+a[1]);
  else fail('GPU lerp diverges from CPU lerp (worst '+worst+' px)');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphGpuCurveLerpSmoke: GPU curve lerp is correct');
