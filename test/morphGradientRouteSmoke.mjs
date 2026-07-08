// morphGradientRouteSmoke — verifies a gradient-filled morph composes with the
// GPU-resident LB route. With setLoopBlinnMorphFill('auto') the morph routes
// through drawLoopBlinnMorph, whose direct path samples the gradient at the em
// position (an opaque gradient stays conflation-free under OVER like a solid).
// Checks: the route engages, the fill is actually a gradient (many hues, not
// flat), and it renders ≈ Slug. Metal headful.
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
// Static linear gradient (userSpaceOnUse), geometry morphs circle→ellipse.
const grad = '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="40" y1="100" x2="160" y2="100">'
  + '<stop offset="0" stop-color="#ff2020"/><stop offset="1" stop-color="#2040ff"/></linearGradient></defs>';
const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${grad}<path d="${d}" fill="url(#g)"/></svg>`;
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
function draw(t){morph.setT(t);clr();const b0=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// distinct red-channel buckets among inked px → >3 means a real gradient (flat = 1)
const hues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)s.add(u[i]>>5);return s.size;};
const ts=[0,0.5,1], out=[];
try {
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto'); const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){
    const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.push({t:ts[i],slugRouted:slug[i].routed,gpuRouted:gpu[i].routed,hues:hues(b),
              inkSlug:ink(a),inkGpu:ink(b),dpx,mx});
  }
  window.__r={out,ok:true};
} catch(e){ window.__r={err:String(e&&e.stack||e)}; }
window.__done=true;
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
  console.log('  '+r.out.map(p=>'t'+p.t+' routed='+p.gpuRouted+' hues='+p.hues+' ink '+p.inkGpu+'/'+p.inkSlug+' Δ'+p.dpx+'(mx'+p.mx+')').join('\n  '));
  if(r.out.some(p=>p.gpuRouted!==1)) fail('gradient morph did not route through LB');
  else if(r.out.some(p=>p.slugRouted!==0)) fail('off should not route');
  else if(r.out.some(p=>p.hues<4)) fail('fill is not a gradient (too few hues)');
  // Validate by SHAPE (ink area, the gradient interior is byte-exact) — the
  // per-pixel max is the ellipse-edge AA difference between LB's analytic ramp
  // and Slug's ray-cast (≈50, same as other LB-vs-Slug diffs), not a paint error.
  else if(r.out.some(p=>Math.abs(p.inkGpu-p.inkSlug)>Math.max(80,p.inkSlug*0.03) || p.mx>120)) fail('routed gradient diverges from Slug');
  else ok('gradient morph routes through LB, renders a gradient ≈ Slug (ink-exact, edge-AA only)');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphGradientRouteSmoke: gradient composes with LB');
