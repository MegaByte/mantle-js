// lbCuspHoleParitySmoke — a CURVED-HOLED shape whose outer boundary contains a
// CUSP cubic (d1≈0, klmn undefined) now renders through LB's CDT partition via
// the exact Bezout resultant (kind 4) — the same path the non-holed static
// builder already uses — instead of dropping the whole shape to Slug. (Loops,
// which are genuinely self-intersecting, still go to Slug.) Checks: the shape
// routes through LB (not a per-shape Slug sentinel), the hole stays empty, and
// the LB render matches Slug within 5% ink.
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
// Outer contour: a CUSP cubic (d1≈0, klmn undefined, but NOT self-intersecting —
// a self-intersecting loop would still go to Slug) + straight sides. Inner
// contour: a square hole. evenodd → the hole.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill-rule="evenodd" fill="#3366cc" d="`
  + `M 50 60 C 50 160 150 10 150 110 L 150 175 L 50 175 Z `   // outer, cusp edge
  + `M 85 120 L 115 120 L 115 155 L 85 155 Z`                 // square hole
  + `"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=200,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bundle=createBundle(gl,await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const at=(u,x,y)=>{const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];};
const out={};
try{
  renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const slug=read();
  out.slugRouted = renderer.debugStats.loopBlinnRouteCount>r0;
  renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const lb=read();
  out.lbRouted = renderer.debugStats.loopBlinnRouteCount>r1;
  out.hasSlug = !!bundle._lbHasSlug;   // true → a shape fell back to a per-shape Slug sentinel
  out.slugInk=ink(slug); out.lbInk=ink(lb);
  out.holeLb=at(lb,100,137); out.holeSlug=at(slug,100,137);   // center of the hole
  out.ok=true;
}catch(e){out.err=String(e&&e.stack||e);}
window.__r=out; window.__done=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;}const p=decodeURIComponent(u.pathname);const mm=p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';try{res.writeHead(200,{'content-type':mm+'; charset=utf-8'});res.end(readFileSync(path.join(ROOT,p)));}catch{try{res.writeHead(404);res.end();}catch{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:false,args:['--use-angle=metal','--no-sandbox','--use-gl=angle']});
const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:20000});
await page.waitForFunction(()=>window.__done===true,{timeout:30000}).catch(()=>{});
const r=await page.evaluate(()=>window.__r); await browser.close(); server.close();
const isBg=c=>c[0]>240&&c[1]>240&&c[2]>240;
if(!r||!r.ok){ fail('did not complete: '+(r&&r.err)); }
else {
  console.log('  routed slug='+r.slugRouted+' lb='+r.lbRouted+' hasSlugSentinel='+r.hasSlug+'  ink lb='+r.lbInk+' slug='+r.slugInk+'  hole lb='+JSON.stringify(r.holeLb));
  if(!r.slugRouted) ok('Slug used with LB off'); else fail('LB routed with fill off');
  if(r.lbRouted) ok('cusp-holed shape routes through LB'); else fail('cusp-holed shape did NOT route to LB');
  if(!r.hasSlug) ok('served on the LB CDT path (no per-shape Slug sentinel)'); else fail('shape fell back to a per-shape Slug sentinel (cusp not served by CDT)');
  if(isBg(r.holeLb)&&isBg(r.holeSlug)) ok('hole stays empty in both'); else fail('hole filled? lb='+JSON.stringify(r.holeLb)+' slug='+JSON.stringify(r.holeSlug));
  if(Math.abs(r.lbInk-r.slugInk)<=Math.max(120,r.slugInk*0.05)) ok('LB ink matches Slug within 5% ('+r.lbInk+' vs '+r.slugInk+')');
  else fail('cusp-holed LB diverges from Slug ('+r.lbInk+' vs '+r.slugInk+')');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nlbCuspHoleParitySmoke: cusp in a curved-holed shape renders on LB (Bezout CDT)');
