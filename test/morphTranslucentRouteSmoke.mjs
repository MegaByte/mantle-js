// morphTranslucentRouteSmoke — verifies a translucent-fill morph composes with
// the GPU-resident LB route. The additive earcut fast path can't composite α
// (overlapping crescents self-conflate under OVER unless α=1), so a translucent
// fill routes through the CDT partition instead: a NON-overlapping tessellation
// whose 1-pass-direct draw is exact even at α<1 (this replaced the old signed
// 2-pass Kokojima path — see [[lb-cdt-proper-fill]]). Checks: a mesh builds, the
// route engages, and the blended fill color is byte-exact vs Slug (#3366cc @ 50%
// over white = (153,178,229)). Metal headful; warms the RT pool first.
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
const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc" fill-opacity="0.5"/></svg>`;
const SRC = svg(ell(100, 100, 60, 60)), DST = svg(ell(100, 100, 80, 42));

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders, buildLoopBlinnMorph } from '/src/index.js';
import { curveRangeToContours } from '/src/renderer/loopBlinn.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
// a translucent fill forces the CDT partition (forceSigned=true skips the additive
// fast path); the resulting mesh is 1-pass-direct (mode 'fast') but non-overlapping
const ra=bSrc.curveRangesByShape[0], rb=bDst.curveRangesByShape[0];
const built=buildLoopBlinnMorph(curveRangeToContours(bSrc.curveFloats,ra.begin,ra.end), curveRangeToContours(bDst.curveFloats,rb.begin,rb.end), true);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const b0=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b0};}
const ctr=u=>{const i=(128*W+128)*4;return [u[i],u[i+1],u[i+2]];};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={mode:built&&built.mode,perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);  // Slug first (no RT)
  renderer.setLoopBlinnMorphFill('auto'); draw(0.5);                // warm the signed RT
  const gpu =ts.map(draw);                                          // GPU draws from the static mesh
  for(let i=0;i<ts.length;i++) out.perT.push({t:ts[i], routed:gpu[i].routed,
    cSlug:ctr(slug[i].buf), cGpu:ctr(gpu[i].buf), inkSlug:ink(slug[i].buf), inkGpu:ink(gpu[i].buf)});
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
  console.log('  mesh mode='+r.mode);
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' ctr '+JSON.stringify(p.cGpu)+'/'+JSON.stringify(p.cSlug)+' ink '+p.inkGpu+'/'+p.inkSlug).join('\n  '));
  const ceq=(a,b)=>Math.abs(a[0]-b[0])<=2&&Math.abs(a[1]-b[1])<=2&&Math.abs(a[2]-b[2])<=2;
  if(!r.mode) fail('translucent morph is not GPU-morphable (mesh returned null)');
  else if(r.perT.some(p=>p.routed!==1)) fail('translucent morph did not route through LB');
  else if(r.perT.some(p=>!ceq(p.cGpu,p.cSlug))) fail('blended fill color ≠ Slug (alpha compositing wrong)');
  else if(r.perT.some(p=>Math.abs(p.inkGpu-p.inkSlug)>Math.max(120,p.inkSlug*0.05))) fail('translucent shape diverges from Slug');
  else ok('translucent morph routes (1-pass CDT partition), alpha composites byte-exact vs Slug');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphTranslucentRouteSmoke: translucent composes with LB');
