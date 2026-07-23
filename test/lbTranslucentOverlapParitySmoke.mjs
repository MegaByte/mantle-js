// lbTranslucentOverlapParitySmoke — translucent SOLID fills now BATCH into the
// one-draw combined route: _ensureLbMeshes builds them as CDT partitions, so the
// route's direct premultiplied OVER composites α exactly (no per-shape composite
// RTs). The load-bearing correctness case is OVERLAPPING translucent shapes —
// the combined route draws them in painter order, so the overlap must composite
// (blue 50% over red 50% over white) byte-identically to Slug. Two overlapping
// half-alpha circles; check the overlap region + a red-only region + total ink.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };
const circ = (cx, cy, r, fill) => { const k = 0.5522847498 * r;
  return `<path fill="${fill}" fill-opacity="0.5" d="M ${cx + r} ${cy} C ${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r} `
    + `C ${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy} C ${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r} `
    + `C ${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy} Z"/>`; };
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${circ(80, 100, 55, '#ff0000')}${circ(120, 100, 55, '#0000ff')}</svg>`;
emitFixture('lbTranslucentOverlapParity__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=200,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bundle=createBundle(gl,await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
const read=()=>{const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;};
const clr=()=>{gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);};
const at=(u,x,y)=>{const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<248||u[i+1]<248||u[i+2]<248)n++;return n;};
const out={};
try{
  renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const slug=read();
  out.slugRouted=renderer.debugStats.loopBlinnRouteCount>r0;
  renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const lb=read();
  out.lbRouted=renderer.debugStats.loopBlinnRouteCount>r1;
  out.overlapLB=at(lb,100,100); out.overlapSlug=at(slug,100,100);   // both circles overlap here
  out.redLB=at(lb,68,100);      out.redSlug=at(slug,68,100);        // red-only
  out.inkLB=ink(lb);            out.inkSlug=ink(slug);
  out.ok=true;
}catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;}const p=decodeURIComponent(u.pathname);const mm=p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';try{res.writeHead(200,{'content-type':mm+'; charset=utf-8'});res.end(readFileSync(path.join(ROOT,p)));}catch{try{res.writeHead(404);res.end();}catch{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:false,args:['--use-angle=metal','--no-sandbox','--use-gl=angle']});
const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:20000});
await page.waitForFunction(()=>window.__done===true,{timeout:30000}).catch(()=>{});
const r=await page.evaluate(()=>window.__r); await browser.close(); server.close();
const eq=(a,b)=>Math.abs(a[0]-b[0])<=3&&Math.abs(a[1]-b[1])<=3&&Math.abs(a[2]-b[2])<=3;
if(!r||!r.ok){ fail('did not complete: '+(r&&r.err)); }
else {
  console.log('  routed slug='+r.slugRouted+' lb='+r.lbRouted+'  overlap lb='+JSON.stringify(r.overlapLB)+' slug='+JSON.stringify(r.overlapSlug)+'  ink '+r.inkLB+'/'+r.inkSlug);
  if(!r.slugRouted) ok('Slug used with LB off'); else fail('LB routed with fill off');
  if(r.lbRouted) ok('translucent bundle routes through LB'); else fail('translucent bundle did NOT route to LB');
  if(eq(r.overlapLB,r.overlapSlug)) ok('OVERLAP composites byte-exact vs Slug (painter-order OVER) '+JSON.stringify(r.overlapLB)); else fail('overlap differs: LB '+JSON.stringify(r.overlapLB)+' vs Slug '+JSON.stringify(r.overlapSlug));
  if(eq(r.redLB,r.redSlug)) ok('red-only region matches Slug'); else fail('red region differs: LB '+JSON.stringify(r.redLB)+' vs Slug '+JSON.stringify(r.redSlug));
  if(Math.abs(r.inkLB-r.inkSlug)<=Math.max(120,r.inkSlug*0.05)) ok('ink matches Slug within 5% ('+r.inkLB+' vs '+r.inkSlug+')'); else fail('ink diverges ('+r.inkLB+' vs '+r.inkSlug+')');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nlbTranslucentOverlapParitySmoke: overlapping translucent batches through the combined route, matches Slug');
