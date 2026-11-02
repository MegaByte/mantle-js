// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _imagePaintRoute — is an IMAGE-painted fill correct through the unified LB route?
//
// Isolates unified IMAGE PAINT from the morph: when morphImageRouteSmoke diverges even at t=0
// (the static A pose, with uMorphT arriving as exactly 0), "the morph lerp is wrong" does not
// explain it. Is unified image paint wrong on its own, with no morph anywhere?
//
// Same drawing, route lb vs route none, pixels compared. If the static case diverges too, the
// morph smoke is reporting an image-paint bug wearing a morph's clothes.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const ic=document.createElement('canvas'); ic.width=32; ic.height=4; const ix=ic.getContext('2d');
const g=ix.createLinearGradient(0,0,32,0); g.addColorStop(0,'#ff2020'); g.addColorStop(1,'#2040ff');
ix.fillStyle=g; ix.fillRect(0,0,32,4);
const uri=ic.toDataURL('image/png');
const W=256;
const CASES={
  // the morph smoke's two endpoint poses, drawn STATICALLY
  imgA:'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200"><image xlink:href="'+uri+'" x="50" y="60" width="100" height="80"/></svg>',
  imgB:'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200"><image xlink:href="'+uri+'" x="40" y="50" width="120" height="100"/></svg>',
  // a plain rect with a solid fill, same geometry — separates "image paint" from "axis-aligned rect"
  solidRect:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect x="50" y="60" width="100" height="80" fill="#265b9b"/></svg>',
  // and a gradient, the other paint that samples by position
  gradRect:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="lg"><stop offset="0" stop-color="#ff2020"/><stop offset="1" stop-color="#2040ff"/></linearGradient></defs><rect x="50" y="60" width="100" height="80" fill="url(#lg)"/></svg>',
};
// ...and the MORPH between the two poses, at t=1, where the smoke still reports 5632 missing
// pixels after the clamp fix. Same localization: a band says geometry, scattered says paint.
const shotMorph=async(route,t)=>{
  const c=document.createElement('canvas');c.width=W;c.height=W;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(W,W); r.setFillEngine({route, kernel:'slug'});
  const m=createShapeMorph(gl, createBundle(gl,await importSvg(CASES.imgA,{})),
                               createBundle(gl,await importSvg(CASES.imgB,{})));
  const b=m.bundle||m;
  if(r.awaitEngine) await r.awaitEngine(b, route==='none'?'slug':route, 30000);
  // SEQ walks 0 -> 0.5 -> t the way the smoke does, instead of setting t on a fresh morph. If the
  // two disagree, the defect is in what the previous t leaves behind, not in t itself.
  const seq = (typeof t === 'string');
  const tv = seq ? Number(t.slice(1)) : t;
  if (seq) for (const q of [0, 0.5, tv]) {
    m.setT(q); gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    r.beginFrame(null); r.drawBundle(m,{}); r.endFrame();
  } else {
    m.setT(tv);
    for(let i=0;i<4;i++){ gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      r.beginFrame(null); r.drawBundle(m,{}); r.endFrame(); }
  }
  const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  return {px:Array.from(px), drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
const shot=async(SVG,route)=>{
  const c=document.createElement('canvas');c.width=W;c.height=W;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(W,W); r.setFillEngine({route, kernel:'slug'});
  const b=createBundle(gl,await importSvg(SVG,{}));
  if(r.awaitEngine) await r.awaitEngine(b, route==='none'?'slug':route, 30000);
  for(let i=0;i<4;i++){ gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    r.beginFrame(null); r.drawBundle(b,{}); r.endFrame(); }
  const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  return {px:Array.from(px), drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
window.__run=async()=>{
  const out=[];
  const work=[...Object.entries(CASES).map(([n,v])=>[n,v]),
              ['morph@1',null], ['morphSeq@1',null]];
  for (const [name,SVG] of work) {
    const lb = SVG ? await shot(SVG,'lb')   : await shotMorph('lb',   name==='morphSeq@1' ? 's1' : 1);
    const arg = name==='morphSeq@1' ? 's1' : 1;
    const sl = SVG ? await shot(SVG,'none') : await shotMorph('none', arg);
    let mx=0,nd=0,inkL=0,inkS=0;
    const inkAt=(u,x,y)=>{const i=(y*W+x)*4; return (u[i]<240||u[i+1]<240||u[i+2]<240)?1:0;};
    // WHERE do they differ? A border band says the paint is sampled at a coordinate the DILATED
    // AA geometry reaches and the shape does not; a spread across the interior says the mapping
    // itself is wrong. Different bugs, and the counts tell them apart.
    let edge=0, interior=0, x0=1e9,y0=1e9,x1=-1,y1=-1;
    for(let y=0;y<W;y++) for(let x=0;x<W;x++){
      const i=(y*W+x)*4;
      if(lb.px[i]<240||lb.px[i+1]<240||lb.px[i+2]<240) inkL++;
      if(sl.px[i]<240||sl.px[i+1]<240||sl.px[i+2]<240) inkS++;
      const d=Math.max(Math.abs(lb.px[i]-sl.px[i]),Math.abs(lb.px[i+1]-sl.px[i+1]),Math.abs(lb.px[i+2]-sl.px[i+2]));
      if(d>8){ nd++;
        if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
        let onEdge=false;
        for(let dy=-1;dy<=1&&!onEdge;dy++) for(let dx=-1;dx<=1;dx++){
          const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=W) continue;
          if(inkAt(sl.px,nx,ny)!==inkAt(sl.px,x,y)) { onEdge=true; break; } }
        if(onEdge) edge++; else interior++; }
      if(d>mx) mx=d; }
    out.push({name, mx, nd, edge, interior, box:(x1<0?'-':x0+','+y0+'..'+x1+','+y1), inkL, inkS, drew:lb.drew});
  }
  return out;
};
window.__ready=1;
</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log('\n  case        maxDelta  px>8   onEdge  interior  diffBox              ink lb/slug');
for (const r of rows)
  console.log(
    '  ' +
      r.name.padEnd(11) +
      String(r.mx).padStart(6) +
      String(r.nd).padStart(7) +
      String(r.edge).padStart(8) +
      String(r.interior).padStart(10) +
      '  ' +
      String(r.box).padEnd(20) +
      ' ' +
      r.inkL +
      '/' +
      r.inkS,
  );
