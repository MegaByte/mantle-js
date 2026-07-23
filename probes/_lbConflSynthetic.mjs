// Minimal conflation repro: two adjacent filled shapes over a GREEN background,
// LB vs Slug. Tests ABUTTING (shared edge) vs OVERLAPPING (one over the other) to
// pin whether the seam is abutting-conflation (1-ab) or an overlap edge-placement
// gap. Green bg makes any background bleed unmistakable.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200;
// CASE A: two rects sharing the vertical edge x=100 exactly (ABUT).
const ABUT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="20" y="20" width="80" height="160" fill="#e0b080"/>
  <rect x="100" y="20" width="80" height="160" fill="#603018"/></svg>`;
// CASE B: two rects OVERLAPPING by 4px around x=100 (dark on top, over peach).
const OVERLAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="20" y="20" width="84" height="160" fill="#e0b080"/>
  <rect x="100" y="20" width="80" height="160" fill="#603018"/></svg>`;
// CASE C: two overlapping CIRCLES (curved shared boundary), dark over peach.
const CIRCLES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="80" cy="100" r="55" fill="#e0b080"/>
  <circle cx="120" cy="100" r="55" fill="#603018"/></svg>`;
// CASE D: two paths sharing the SAME curved edge (100,20)->(100,180) — abut along a CURVE.
const CURVEABUT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <path d="M20 20 L100 20 C130 73 70 127 100 180 L20 180 Z" fill="#e0b080"/>
  <path d="M100 20 C130 73 70 127 100 180 L180 180 L180 20 Z" fill="#603018"/></svg>`;
// CASE E: same shared curve but dark's edge OVERLAPS peach's by shifting its curve +3px right.
const CURVEOVL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <path d="M20 20 L103 20 C133 73 73 127 103 180 L20 180 Z" fill="#e0b080"/>
  <path d="M100 20 C130 73 70 127 100 180 L180 180 L180 20 Z" fill="#603018"/></svg>`;
// CASE F: a sub-pixel GAP between the two rects (peach ends 99.6, dark starts 100.4 → ~0.8px gap).
const GAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="20" y="20" width="79.6" height="160" fill="#e0b080"/>
  <rect x="100.4" y="20" width="79.6" height="160" fill="#603018"/></svg>`;
// CASE G: a shared CURVED edge with a sub-pixel gap (curves offset by 0.8px).
const CURVEGAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <path d="M20 20 L99.6 20 C129.6 73 69.6 127 99.6 180 L20 180 Z" fill="#e0b080"/>
  <path d="M100.4 20 C130.4 73 70.4 127 100.4 180 L180 180 L180 20 Z" fill="#603018"/></svg>`;
const CASES = { ABUT, OVERLAP, CIRCLES, CURVEABUT, CURVEOVL, GAP, CURVEGAP };
const HTML = (svg) => `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${N}, ${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(svg)}));
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);
const readAll = () => { const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const draw = (m) => { renderer.setLoopBlinnFill(m); renderer.beginFrame([0,0.8,0,1]); renderer.drawBundle(bundle); renderer.endFrame(); return readAll(); };
const slug = draw('off'), lb = draw('on');
// scan a horizontal line through the middle, report where green bleeds (G high) per engine
const G=(px,x,y)=>px[((${N}-1-y)*${N}+x)*4+1];
const greenBleed = (px)=>{ let n=0, worst=0, wx=0; for(let y=40;y<160;y++)for(let x=40;x<160;x++){
  const o=((${N}-1-y)*${N}+x)*4; const r=px[o],g=px[o+1],b=px[o+2];
  // "green showing" = g notably exceeds both r and b (bg is [0,204,0])
  const gExc = g - Math.max(r,b); if(gExc>25){ n++; if(gExc>worst){worst=gExc;wx=x;} } } return {n,worst,wx}; };
const sy=100, prof=[]; for(let x=90;x<=112;x++) prof.push([x,[lb[((${N}-1-sy)*${N}+x)*4],lb[((${N}-1-sy)*${N}+x)*4+1],lb[((${N}-1-sy)*${N}+x)*4+2]],[slug[((${N}-1-sy)*${N}+x)*4],slug[((${N}-1-sy)*${N}+x)*4+1],slug[((${N}-1-sy)*${N}+x)*4+2]]]);
window.__out={ lbBleed:greenBleed(lb), slugBleed:greenBleed(slug), prof };
window.__ready=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{ try{
  if(req.url.startsWith('/case')){ const c=req.url.slice(5); res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); res.end(HTML(CASES[c])); return; }
  const p=decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,p)));
}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:false,args:['--no-sandbox','--use-angle=metal','--enable-gpu']});
for(const c of Object.keys(CASES)){
  const page=await browser.newPage();
  page.on('console',m=>{if(m.type()==='error')console.error('['+c+' err]',m.text());});
  await page.goto(`http://127.0.0.1:${port}/case${c}`,{waitUntil:'load',timeout:20000});
  await page.waitForFunction(()=>window.__ready===true,{timeout:15000});
  const o=await page.evaluate(()=>window.__out);
  console.log(`\n=== ${c} ===  LB green-bleed=${o.lbBleed.n}px (worst ${o.lbBleed.worst}@x${o.lbBleed.wx})  Slug=${o.slugBleed.n}px (worst ${o.slugBleed.worst})`);
  console.log('  profile y=100 (x: LB | Slug):');
  for(const [x,l,s] of o.prof) if(Math.abs(l[0]-s[0])+Math.abs(l[1]-s[1])+Math.abs(l[2]-s[2])>10) console.log(`    x=${x}  LB=[${l}]  Slug=[${s}]`);
  await page.close();
}
await browser.close(); server.close();
