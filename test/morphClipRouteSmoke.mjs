// morphClipRouteSmoke — validates that a CLIPPED morph composes with the
// GPU-resident LB route. A clip can't ride the 1-pass-direct fill (the clip
// union lives in the ubershader, below the fCov seam), so the route renders the
// morph FILL COVERAGE into a screen-space RT and draws the shape through the
// MANTLE_LB_COV fill variant — whose fCov SAMPLES that RT instead of the Slug
// ray-cast — so the ubershader's clip runs over the LB fill. Checks: the route
// engages (loopBlinnMorphRouteCount), the composed path engages
// (loopBlinnMorphComposedCount), the result is byte-≈ Slug, the clip actually
// CROPS (a point inside the ellipse but outside the clip rect is background in
// BOTH), and the center is the fill color. (Warms the RT pool first — the
// harness's first pooled-RT draw can come back empty.)
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
function ell(cx, cy, rx, ry) {
  const k = 0.5522847498;
  return `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} `
    + `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} `
    + `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} `
    + `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`;
}
// A circle→ellipse fill (fast-morphable) clipped to a rect at x=[70,160].
const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`
  + `<defs><clipPath id="cp"><rect x="70" y="20" width="90" height="160"/></clipPath></defs>`
  + `<path d="${d}" fill="#3366cc" clip-path="url(#cp)"/></svg>`;
const SRC = svg(ell(100, 100, 60, 60)), DST = svg(ell(100, 100, 80, 42));

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);   // Slug clip (no pool RT)
  renderer.setLoopBlinnMorphFill('auto'); draw(0.5);                 // warm the pool RT
  const gpu =ts.map(draw);
  // The shape maps em→screen through the bundle's TIGHT globalBBox (≈ the
  // geometry bbox), not the viewBox, so the clip's left edge (em x=70) sits well
  // inside the canvas. A far-LEFT column (screen x=8) is left of the clip on its
  // center row → must be background if the clip is genuinely cropping the fill.
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),ctrGpu:px(b,128,128),outClipGpu:px(b,8,128),outClipSlug:px(a,8,128),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
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
else {
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' composed='+p.composed+' ink '+p.inkGpu+'/'+p.inkSlug+' ctr '+JSON.stringify(p.ctrGpu)+' outClip '+JSON.stringify(p.outClipGpu)+' mx'+p.mx).join('\n  '));
  const isWhite=c=>c[0]>240&&c[1]>240&&c[2]>240;
  const isFill =c=>Math.abs(c[0]-51)<24&&Math.abs(c[1]-102)<24&&Math.abs(c[2]-204)<24;
  if(r.perT.some(p=>p.routed!==1)) fail('clipped morph did not route through LB');
  else if(r.perT.some(p=>p.composed!==1)) fail('clip did not take the composed (LB-coverage→ubershader) path');
  else if(r.perT.some(p=>!isFill(p.ctrGpu))) fail('center is not the fill color (#3366cc) — fill missing');
  else if(r.perT.some(p=>!isWhite(p.outClipGpu)||!isWhite(p.outClipSlug))) fail('clip did not crop (inside-ellipse/outside-clip point is not background)');
  else if(r.perT.some(p=>Math.abs(p.inkGpu-p.inkSlug)>Math.max(160,p.inkSlug*0.06))) fail('clipped morph diverges from Slug');
  else ok('clipped morph routes (composed), clip crops the LB fill, ≈ Slug (edge-AA only)');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphClipRouteSmoke: clip composes with the LB morph');
