// morphIntervalSplitSmoke — a CLASSIFICATION-CHANGING morph (a cubic edge that
// inverts convexity mid-morph) is now served on the GPU LB path by INTERVAL-
// SPLITTING: buildLoopBlinnMorph partitions [0,1] at the flip time into
// classification-stable sub-meshes, and drawLoopBlinnMorph selects + t-remaps the
// right one per frame. Checks:
//   • buildLoopBlinnMorph returns a multi-SEGMENT mesh (>=2) for the flip morph,
//     and a single mesh (no segments) for a stable morph.
//   • across a FINE t sweep (including the flip seam) the routed LB render tracks
//     Slug within the SAME tolerance everywhere — the seam is exact (the draw
//     extrapolates the linear VS lerp across it), so no special seam bound.
//   • every frame routes through drawLoopBlinnMorph (no per-frame Slug rebuild).
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
const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc"/></svg>`;
// top cubic bulges UP (convex) at t=0, DOWN (concave) at t=1 → flips at t≈0.571
const FLIP_SRC = svg('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z');
const FLIP_DST = svg('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z');
const FLIP_T = (90 - 50) / (120 - 50);   // control y: 50→120 crosses the chord (90) here
// a classification-STABLE morph (circle→ellipse) → single mesh, no segments
const ell = (cx, cy, rx, ry) => { const k = 0.5522847498;
  return `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} `
    + `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} `
    + `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} `
    + `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`; };
const STABLE_SRC = svg(ell(100, 100, 60, 60)), STABLE_DST = svg(ell(100, 100, 80, 40));

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
import { segmentPartitionPairMorph } from '/src/renderer/loopBlinnMorph.js';
import { curveRangeToContours } from '/src/renderer/loopBlinn.js';
const W=256,H=256, FLIP_T=${FLIP_T};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
function contoursOf(b){const r=b.curveRangesByShape[0];return curveRangeToContours(b.curveFloats,r.begin,r.end);}
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
function draw(morph,t){morph.setT(t);clr();const b=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b};}
const out={};
try{
  const bFS=createBundle(gl,await importSvg(${JSON.stringify(FLIP_SRC)})), bFD=createBundle(gl,await importSvg(${JSON.stringify(FLIP_DST)}));
  const bSS=createBundle(gl,await importSvg(${JSON.stringify(STABLE_SRC)})), bSD=createBundle(gl,await importSvg(${JSON.stringify(STABLE_DST)}));
  // structural: a flip morph splits into t-segments on the PARTITION PAIR; a
  // stable morph needs no partition (the plain pair serves it → partition null)
  const flipSegs=segmentPartitionPairMorph(contoursOf(bFS),contoursOf(bFD),'nonzero');
  const stableSegs=segmentPartitionPairMorph(contoursOf(bSS),contoursOf(bSD),'nonzero');
  out.flipSegs = flipSegs ? flipSegs.length : 0;
  out.flipBounds = flipSegs ? flipSegs.map(s=>[+s.tLo.toFixed(3),+s.tHi.toFixed(3)]) : null;
  out.stableSegs = stableSegs ? stableSegs.length : 0;
  out.stableIsMesh = !stableSegs;
  // render sweep: LB vs Slug across t (fine, spanning the seam)
  const morph=createShapeMorph(gl,bFS,bFD);
  const ts=[]; for(let i=0;i<=20;i++) ts.push(i/20);
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(t=>draw(morph,t));
  renderer.setLoopBlinnMorphFill('auto');
  // The pair build is deliberately ASYNC-friendly: heavy segmentation yields
  // out of a draw slice to the idle prepare queue (games draw Slug until it
  // lands). Pump a settle window so routing reflects the built state.
  for (let w=0; w<200 && !(morph.bundle||morph)._morphMeshesBuilt; w++) {
    draw(morph, 0);
    await new Promise(r=>setTimeout(r,10));
  }
  const gpu =ts.map(t=>draw(morph,t));
  out.rows=ts.map((t,i)=>({t:+t.toFixed(2), routed:gpu[i].routed, slugInk:ink(slug[i].buf), gpuInk:ink(gpu[i].buf)}));
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
if(!r||!r.ok){ fail('did not complete: '+(r&&r.err)); }
else {
  // structure
  if(r.flipSegs>=2) ok('flip morph interval-split into '+r.flipSegs+' segments '+JSON.stringify(r.flipBounds)); else fail('flip morph did NOT interval-split (segs='+r.flipSegs+')');
  if(r.stableIsMesh && r.stableSegs===0) ok('stable morph stays a single mesh (no needless split)'); else fail('stable morph unexpectedly split (segs='+r.stableSegs+')');
  // render sweep
  let bad=0, worst=0;
  for(const p of r.rows){
    if(p.routed!==1){ fail('t'+p.t+' did not route (routed='+p.routed+')'); bad++; continue; }
    if(p.gpuInk===0||p.slugInk===0){ fail('t'+p.t+' empty render'); bad++; continue; }
    const tol = Math.max(130, p.slugInk*0.05);         // SAME bound everywhere — seam is exact
    const d = Math.abs(p.gpuInk-p.slugInk); if(d>worst) worst=d;
    if(d>tol){ fail('t'+p.t+' LB ink '+p.gpuInk+' vs Slug '+p.slugInk+' (Δ'+d+' > '+Math.round(tol)+')'); bad++; }
  }
  if(!bad) ok('classification-changing morph tracks Slug across a 21-step t sweep (worst Δ'+worst+' px, all routed)');
}
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphIntervalSplitSmoke: classification-changing morphs route via interval-split');
