// morphOpenStrokeRouteSmoke — verifies open-path support: a morph of an open
// stroked path (fill=none). The fill-mesh build fails for an open contour, so the
// route allows a null fill mesh (fCov=0) and renders the GPU-resident stroke from
// the morphed control points. Round caps (the natural distance-field result).
// Checks: route + composed engage, a stroke is rendered (red pixels), and ink ≈
// Slug across t. Metal headful.
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
// open cubic path (no Z), fill=none, stroked.
const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`
  + `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SRC = svg('M 40 100 C 80 30 120 170 160 100');
const DST = svg('M 40 120 C 90 60 110 140 160 70');

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
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto'); draw(0.5);
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx}); }
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
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' composed='+p.composed+' red '+p.redGpu+'/'+p.redSlug+' mx'+p.mx).join('\n  '));
  if(r.perT.some(p=>p.routed!==1)) fail('open stroked morph did not route through LB (fell to Slug)');
  else if(r.perT.some(p=>p.composed!==1)) fail('open stroke did not take the composed path');
  else if(r.perT.some(p=>p.redGpu < 600)) fail('no stroke rendered for the open path');
  else if(r.perT.some(p=>Math.abs(p.redGpu-p.redSlug) > Math.max(700,p.redSlug*0.22))) fail('open stroke diverges from Slug');
  else ok('open-path stroked morph routes (composed), GPU-resident stroke ≈ Slug');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphOpenStrokeRouteSmoke: open-path stroke composes with the LB morph');
