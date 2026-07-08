// lbLoopParitySmoke — a SELF-INTERSECTING (loop) cubic fill correctly FALLS BACK
// to Slug (LB doesn't serve it) and renders IDENTICALLY, under both nonzero and
// evenodd. Loops are the one geometry class LB deliberately leaves on Slug:
// reconstructing a self-intersecting fill from a double-point split doesn't match
// Slug (verified), and the nonzero-vs-evenodd loop-interior rule isn't threaded
// to the LB path. This guards that the fallback stays correct (no wrong LB fill).
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
// a fat self-crossing cubic loop; controls splay out and cross → a loop near the top
const D = 'M 60 150 C 250 20 -10 20 180 150 Z';
const svg = rule => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 200"><path fill="#3366cc" fill-rule="${rule}" d="${D}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="220" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=220,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const read=()=>{const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;};
const clr=()=>{gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<248||u[i+1]<248||u[i+2]<248)n++;return n;};
const SVGS={nonzero:${JSON.stringify(svg('nonzero'))}, evenodd:${JSON.stringify(svg('evenodd'))}};
async function run(rule){
  const b=createBundle(gl,await importSvg(SVGS[rule]));
  renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(b); const slug=read(); const sRouted=renderer.debugStats.loopBlinnRouteCount>r0;
  renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(b); const lb=read(); const lRouted=renderer.debugStats.loopBlinnRouteCount>r1;
  let diff=0; for(let i=0;i<slug.length;i+=4){ if(Math.abs(slug[i]-lb[i])>40||Math.abs(slug[i+1]-lb[i+1])>40||Math.abs(slug[i+2]-lb[i+2])>40) diff++; }
  return { rule, sRouted, lRouted, slugInk:ink(slug), lbInk:ink(lb), diffPx:diff, hasSlug:!!b._lbHasSlug };
}
const out={};
try{ out.nz=await run('nonzero'); out.eo=await run('evenodd'); out.ok=true; }
catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;}const p=decodeURIComponent(u.pathname);const mm=p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';try{res.writeHead(200,{'content-type':mm+'; charset=utf-8'});res.end(readFileSync(path.join(ROOT,p)));}catch{try{res.writeHead(404);res.end();}catch{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:false,args:['--use-angle=metal','--no-sandbox','--use-gl=angle']});
const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:20000});
await page.waitForFunction(()=>window.__done===true,{timeout:30000}).catch(()=>{});
const r=await page.evaluate(()=>window.__r); await browser.close(); server.close();
if(!r||!r.ok){ fail('did not complete: '+(r&&r.err)); }
else for(const k of ['nz','eo']){
  const x=r[k];
  console.log('  '+x.rule+': lbRouted='+x.lRouted+' fellBackToSlug='+(!x.lRouted)+' ink lb='+x.lbInk+' slug='+x.slugInk+' diffPx='+x.diffPx);
  if(!x.lRouted) ok(x.rule+': loop shape falls back to Slug (LB does not serve it)');
  else fail(x.rule+': loop shape routed through LB (should fall back — LB renders loops wrong)');
  if(x.diffPx <= Math.max(200, x.slugInk*0.03)) ok(x.rule+': renders identically to Slug (diffPx '+x.diffPx+')');
  else fail(x.rule+': loop render DIFFERS from Slug (diffPx '+x.diffPx+', ink '+x.lbInk+' vs '+x.slugInk+')');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nlbLoopParitySmoke: self-intersecting loop fills match Slug');
