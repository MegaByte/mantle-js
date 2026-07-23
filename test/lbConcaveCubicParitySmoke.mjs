// lbConcaveCubicParitySmoke — CONCAVE / holed CUBIC shapes render on LB matching
// Slug. Guards the fixes for the reported corruption in icons and font text:
// (1) a 'C'/notch shape whose concave cubic edges the EARCUT rim mis-
// threaded (filled the mouth) now routes to the CDT partition; (2) a cubic-ring
// (holed) whose crescent hulls the CDT SUBDIVIDES — the sub-triangles are now
// ADOPTED into the crescent (buildLoopBlinnCDT) instead of dropped (under-fill);
// (3) two disjoint filled bars (a pause icon) fill both, not one. All vs Slug.
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
const cub = (cx, cy, r) => { const k = 0.5522847498 * r;
  return `M ${cx + r} ${cy} C ${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r} C ${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy} `
    + `C ${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r} C ${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy} Z`; };
const CASES = {
  // 'C'-shape: concave cubic edges + a mouth notch (earcut mis-filled the mouth)
  cShape: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#3366cc" d="M150 50 C 80 20 40 60 40 100 C 40 140 80 180 150 150 L150 120 C 100 145 70 130 70 100 C 70 70 100 55 150 80 Z"/></svg>`,
  // cubic ring (NOT arcs): outer+inner cubic circles, evenodd — CDT crescent adoption
  cubicRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#3366cc" fill-rule="evenodd" d="${cub(100, 100, 70)} ${cub(100, 100, 38)}"/></svg>`,
  // two disjoint filled bars (a pause icon) — both must fill
  pauseBars: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#3366cc" d="M60 50 h30 v100 h-30 Z M110 50 h30 v100 h-30 Z"/></svg>`,
  // ARC ring (annulus of arcs = rquads) — a mute/how-to-play ring; a MODERATE
  // width fills fully via the adopted arc crescents and stays on LB.
  arcRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#3366cc" fill-rule="evenodd" d="M50 8 a42 42 0 1 0 0.1 0 Z M50 22 a28 28 0 1 0 0.1 0 Z"/></svg>`,
  // THIN arc ring — its arc hulls subdivide heavily (inner+outer mutually
  // intrude), so every band triangle is reconstructed against BOTH its inner and
  // outer arc: each band triangle emits a crescent per straddled arc (outer arc
  // ramps the outer edge, inner arc the inner edge) plus a deep-fill solid base.
  // Renders SOLID and smooth on LB (pre-fix it was "alpha wedges" / a facetted
  // polygon), matching Slug.
  thinArcRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#3366cc" fill-rule="evenodd" d="M50 10 a40 40 0 1 0 0.1 0 Z M50 20 a30 30 0 1 0 0.1 0 Z"/></svg>`,
};
// The strict cubic audit declines cShape because one analytic piece paints air.
// The Slug fallback is exact; routing it would trade a visible overpaint for speed.
const NO_ROUTE = new Set(['cShape']);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="220" height="220"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=220,H=220;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const read=()=>{const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<200)n++;return n;};
const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])>60)n++;return n;};
function measure(b){ renderer.setLoopBlinnFill('off'); renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b); renderer.endFrame(); const slug=read();
  const c1=renderer.debugStats.loopBlinnRouteCount; renderer.setLoopBlinnFill('on'); renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b); renderer.endFrame(); const lb=read();
  return {slugInk:ink(slug),lbInk:ink(lb),diffPx:diff(slug,lb),lbRouted:renderer.debugStats.loopBlinnRouteCount>c1}; }
const out={}; const CASES=${JSON.stringify(CASES)};
try{ for(const [k,svg] of Object.entries(CASES)){ const b=createBundle(gl,await importSvg(svg)); renderer.prepareBundle(b); await renderer.awaitLbReady(b); out[k]=measure(b); } out.ok=true; }
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
else for(const k of Object.keys(CASES)){
  const v=r[k];
  console.log('  '+k+': lbRouted='+v.lbRouted+' ink lb='+v.lbInk+' slug='+v.slugInk+' diffPx='+v.diffPx);
  if(NO_ROUTE.has(k)) { if(!v.lbRouted) ok(k+': correctly falls back to Slug (gate)'); else fail(k+': routed LB but should hit the correctness gate'); }
  else if(v.lbRouted) ok(k+': routes through LB'); else fail(k+': did NOT route to LB');
  if(v.diffPx<=Math.max(160,v.slugInk*0.06)) ok(k+': renders correctly (diffPx '+v.diffPx+')');
  else fail(k+': DIVERGES from Slug (diffPx '+v.diffPx+', ink '+v.lbInk+' vs '+v.slugInk+')');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nlbConcaveCubicParitySmoke: concave/holed cubic shapes render on LB matching Slug');
