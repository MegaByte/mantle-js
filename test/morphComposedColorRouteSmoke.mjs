// morphComposedColorRouteSmoke — validates that PAINT morphs under the composed
// path (clip/mask/filter/stroke). The composed draw reads fill/stroke colour
// from uMetaTex; the route uploads the lerped bbox+fill+stroke meta texels per
// frame, so a colour-morphing CLIPPED shape shows the interpolated colour.
// Checks: route + composed engage, the centre colour MORPHS red→blue across t
// (not frozen), and GPU ≈ Slug.
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
// Same clip; the FILL colour differs between src (#cc3333 red) and dst (#3366cc blue).
const svg = (d, fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`
  + `<defs><clipPath id="cp"><rect x="55" y="20" width="120" height="160"/></clipPath></defs>`
  + `<path d="${d}" fill="${fill}" clip-path="url(#cp)"/></svg>`;
const SRC = svg(ell(100, 100, 60, 60), '#cc3333'), DST = svg(ell(100, 100, 80, 42), '#3366cc');

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
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto'); draw(0.5);
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,ctrGpu:px(b,128,128),ctrSlug:px(a,128,128),mx}); }
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
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' composed='+p.composed+' ctr '+JSON.stringify(p.ctrGpu)+'/'+JSON.stringify(p.ctrSlug)+' mx'+p.mx).join('\n  '));
  const ceq=(a,b)=>Math.abs(a[0]-b[0])<=4&&Math.abs(a[1]-b[1])<=4&&Math.abs(a[2]-b[2])<=4;
  const t0=r.perT[0], t1=r.perT[2];
  const red=c=>c[0]>140&&c[2]<100, blue=c=>c[2]>140&&c[0]<100;
  if(r.perT.some(p=>p.routed!==1||p.composed!==1)) fail('clipped colour-morph did not route/compose');
  else if(!red(t0.ctrGpu)) fail('t0 centre is not red (paint frozen / wrong): '+JSON.stringify(t0.ctrGpu));
  else if(!blue(t1.ctrGpu)) fail('t1 centre is not blue (paint did NOT morph — frozen at t0): '+JSON.stringify(t1.ctrGpu));
  else if(r.perT.some(p=>!ceq(p.ctrGpu,p.ctrSlug))) fail('composed colour ≠ Slug');
  else ok('composed paint morphs red→blue under clip, byte-≈ Slug');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphComposedColorRouteSmoke: paint morphs under the composed path');
