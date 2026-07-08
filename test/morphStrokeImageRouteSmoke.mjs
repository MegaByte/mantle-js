// morphStrokeImageRouteSmoke — verifies image-painted strokes (bitmap stroke,
// strokeImageId): stroke="url(#p)" where <pattern> contains an <image> maps to a
// bitmap-fill stroke (the pattern's image over the shape bbox; reuses the fill's
// texel 9/10 since the fill here is solid). A solid-filled, image-stroked path
// morph. The stroke is painted by a red→blue horizontal gradient image, so the
// stroke ring shows multiple hues (vs a solid stroke's one) — proving the bitmap
// is sampled, not a flat color.
// Checks: route + composed engage, the stroke ring carries image hues, and the
// bitmap stays in tight visual parity with Slug across all t — the composed path
// lerps the stroke imageRect into the uLBImageRect uniform per frame (like the
// gradient bbox), so the bitmap mapping morphs with the silhouette. Metal
// headful; warms the pool first.
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

const SRC = ell(100, 100, 60, 60), DST = ell(100, 100, 78, 42);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
// red→blue horizontal gradient image (32×4) → an image stroke shows both hues.
const ic=document.createElement('canvas'); ic.width=32; ic.height=4; const ix=ic.getContext('2d');
const g=ix.createLinearGradient(0,0,32,0); g.addColorStop(0,'#ff2020'); g.addColorStop(1,'#2040ff'); ix.fillStyle=g; ix.fillRect(0,0,32,4);
const uri=ic.toDataURL('image/png');
const svg=d=>'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200">'
  +'<defs><pattern id="p" patternUnits="userSpaceOnUse" width="200" height="200"><image xlink:href="'+uri+'" x="0" y="0" width="200" height="200"/></pattern></defs>'
  +'<path d="'+d+'" fill="#cce6ff" stroke="url(#p)" stroke-width="14"/></svg>';
// control: same shape, SOLID red stroke (one hue) — to contrast hue counts.
const svgSolid=d=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="'+d+'" fill="#cce6ff" stroke="#cc3333" stroke-width="14"/></svg>';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(svg(${JSON.stringify(SRC)}))), bDst=createBundle(gl,await importSvg(svg(${JSON.stringify(DST)})));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// stroke pixels = NOT the light-blue fill (B high & R moderate) and not white.
// Count distinct hue buckets among them (image gradient → several; solid → ~1).
const isFill=(r,g2,b)=>b>200&&g2>200&&r>150&&r<240;
const strokeHues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4){const r=u[i],g2=u[i+1],b=u[i+2];if((r<240||g2<240||b<240)&&!isFill(r,g2,b))s.add((r>>6)*4+(b>>6));}return s.size;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto'); draw(0.5);                 // warm pool
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0, hi=0, sum=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;if(v>90)hi++;sum+=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,huesGpu:strokeHues(b),inkGpu:ink(b),inkSlug:ink(a),mx,hi,mean:sum/a.length}); }
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
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' composed='+p.composed+' strokeHues='+p.huesGpu+' ink '+p.inkGpu+'/'+p.inkSlug+' mx'+p.mx+' hi'+p.hi+' mean'+p.mean.toFixed(3)).join('\n  '));
  if(r.perT.some(p=>p.routed!==1)) fail('image-stroked morph did not route through LB');
  else if(r.perT.some(p=>p.composed!==1)) fail('image stroke did not take the composed path');
  else if(r.perT.some(p=>p.huesGpu < 3)) fail('stroke is not the image (too few hues — rendered solid?)');
  else if(r.perT.some(p=>Math.abs(p.inkGpu-p.inkSlug) > Math.max(120,p.inkSlug*0.04))) fail('image-stroked morph silhouette diverges from Slug');
  else if(r.perT.some(p=>p.mx > 128 || p.hi > 512 || p.mean > 0.25)) fail('image stroke diverges from Slug — bitmap mapping/coverage drift (mx'+Math.max(...r.perT.map(p=>p.mx))+')');
  else ok('image stroke (strokeImageId via SVG pattern) composes with the LB morph, samples the bitmap, close parity vs Slug across t');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphStrokeImageRouteSmoke: SVG image-pattern strokes → strokeImageId, render + compose');
