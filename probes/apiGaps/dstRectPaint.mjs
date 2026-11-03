// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// dstRectPaint — does `drawBundle({ dstRect })` paint the pixels the arithmetic says it does?
//
// `test/dstRectPlacementSmoke.mjs` pins the ALGEBRA without a GPU: the clip-space affine, the
// scissor rect, the hit-test matrix. It cannot pin the one thing that matters to a caller —
// that the shader's projection is the chain the algebra mirrors, so the ink actually lands in
// the rect. That is this probe's whole job, and it is the reason `dstRect` was implemented as a
// world matrix instead of as a second projection: if the two disagree, the pixels say so here.
//
// RUN:  node probes/apiGaps/dstRectPaint.mjs          (SwiftShader — placement only)
//       GPU=1 node probes/apiGaps/dstRectPaint.mjs    (ANGLE Metal — placement AND AA)
//
// PREDICTIONS (written before the first run; a row that misses is a finding, not a tolerance):
//
//   P1  identity        dstRect = [0,0,W,H] with the default fit is BYTE-IDENTICAL to no
//                       dstRect at all. maxDelta 0, diff 0. This is the anchor: dstRect is
//                       defined as "the same fit, into a different box", so the box that IS
//                       the viewport must change nothing. A nonzero delta here means the
//                       placement matrix is not the identity it computes, or the scissor is
//                       cropping a pixel the unscissored draw kept.
//   P2  meet            dstRect [128,128,256,256] on a 2:1 asset draws ink whose bbox is
//                       [128,192]..[384,320] (+/-1 px for the AA skirt) — full width of the
//                       rect, letterboxed vertically. nothing outside the rect.
//   P3  slice           the same rect with 'xMidYMid slice' fills the rect edge to edge: ink
//                       bbox == the rect, and the rect's interior is 100% covered.
//   P4  clipToRect      slice with clipToRect:false spills OUTSIDE the rect (ink bbox wider
//                       than 256 px); with the default it does not. The difference between
//                       those two rows is the scissor doing its job — if they are equal, the
//                       scissor never reached the draw.
//   P5  none            fit:'none' puts the ink bbox exactly on the rect, at a BROKEN aspect
//                       (a circle in the asset comes out an ellipse). Distinguishes 'none'
//                       from 'slice', which also fills the rect but keeps the aspect.
//   P6  two rects       two dstRect draws in one frame both appear, neither cropped by the
//                       other's scissor. THE FAILURE this CATCHES: a scissor that is set and
//                       not restored leaves draw 2 clipped to draw 1's rect — which looks
//                       like "the second bundle didn't render" and is the single most likely
//                       bug in this feature.
//   P7  engine          every arm draws on the same engine as the no-dstRect arm. dstRect
//                       rides uWorldM, which no route gate reads, so a route change would mean
//                       something fell back — and a fallback that still paints correctly is
//                       exactly how a broken shader path reads as a triumph.
//   P9  filter + rect   a FILTERED shape drawn into the rect stays inside it. This
//                       is the one place the rect clip is not simply the draw's
//                       scissor: both filter composites set their own scissor
//                       (the filter region) on the way in, and must intersect it
//                       with the caller's rather than REPLACE it and then disable
//                       the test on the way out — otherwise a filtered shape paints
//                       to the filter region rather than to the rect, and every
//                       later draw of that bundle loses its clip too. Prediction: 0 inked pixels outside
//                       the rect, and the unfiltered arm's outside count is 0 as
//                       well (so a nonzero P9 is the filter path specifically).
//   P8  hit test        over a 64x64 grid of viewport pixels, `fillHitShape` under
//                       `renderer.bundleDrawMatrix(bundle, opts)` agrees with the rendered ink
//                       on every pixel that is not within 1 px of a drawn edge. Disagreements
//                       away from an edge are the finding; edge pixels are AA and excluded.
//
// FALSIFIABLE CLAIM: `dstRect` places and crops a bundle exactly where its documented
// arithmetic says, on the same engine as the undecorated draw, and the hit test agrees with
// the result. Concretely: P1 diff == 0; P2/P3/P5 ink bboxes within 1 px of the predicted rects;
// P4's two rows differ in ink bbox width by more than 100 px; P6's two rects each carry ink of
// their own; P7 reports one engine for every arm; P8 reports 0 non-edge disagreements; P9
// reports 0 ink outside the rect. Any single row missing falsifies it — and the report below
// prints each row's own number so the one that missed names itself.
//
// WHAT this PROBE CANNOT SETTLE, by construction: the AA skirt. The half-pixel cover-quad
// dilation is computed BEFORE uWorldM (mantle.vert's emRow0/emRow1 read uCanvasAR/uGlobalBBox),
// so shrinking a bundle into a small rect shrinks its dilation with it. That is a pre-existing
// property of every `worldMatrix` scale, not something dstRect introduced, and the +/-1 px
// tolerances above exist because of it. An AA-fidelity question needs the reach probes, not
// this one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, fillHitShape } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const W=512;
// A 2:1 asset so 'meet' and 'slice' cannot be confused with each other, with a circle in it so
// 'none' announces itself by turning the circle into an ellipse, and a hard border so the ink
// bbox is the geometry rather than an AA guess.
const SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">'
  +'<rect x="0" y="0" width="200" height="100" fill="#1b3a6b"/>'
  +'<circle cx="100" cy="50" r="40" fill="#f5c542"/>'
  +'<rect x="8" y="8" width="24" height="24" fill="#e04a3a"/></svg>';
// The same artwork under a filter, so P9 differs from P2 only in the filter.
const SVG_F='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><defs>'
  +'<filter id="f" x="-40%" y="-40%" width="180%" height="180%">'
  +'<feGaussianBlur stdDeviation="3"/></filter></defs>'
  +'<g filter="url(#f)">'
  +'<rect x="0" y="0" width="200" height="100" fill="#1b3a6b"/>'
  +'<circle cx="100" cy="50" r="40" fill="#f5c542"/></g></svg>';
const RECT=[128,128,256,256];
const shot=async(opts,extra,src)=>{
  const c=document.createElement('canvas');c.width=W;c.height=W;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(W,W);
  const b=createBundle(gl,await importSvg(src||SVG,{}));
  if(r.prepareBundle) r.prepareBundle(b);
  if(r.awaitLbReady) await r.awaitLbReady(b,20000);
  // Four frames: the first can run on a warming variant, and a result cached from one is the
  // trap that makes a blank draw read as a pass.
  for(let i=0;i<4;i++){
    gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
    r.beginFrame(null);
    r.drawBundle(b,opts);
    if(extra) r.drawBundle(b,extra);
    r.endFrame();
  }
  const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  const m=r.bundleDrawMatrix?r.bundleDrawMatrix(b,opts):null;
  return {px, bundle:b, mat:m?Array.from(m):null,
          drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
// readPixels is bottom-up; every rect below is y-down, so flip on read.
const inkAt=(px,x,y)=>{const i=(((W-1-y)*W)+x)*4; return (px[i]<240||px[i+1]<240||px[i+2]<240);};
const inkBox=(px)=>{let x0=1e9,y0=1e9,x1=-1,y1=-1,n=0;
  for(let y=0;y<W;y++)for(let x=0;x<W;x++) if(inkAt(px,x,y)){n++;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
  return {n,box:n?[x0,y0,x1-x0+1,y1-y0+1]:[0,0,0,0]};};
const diff=(a,b)=>{let mx=0,nd=0;for(let i=0;i<a.length;i+=4){
  const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
  if(d>0)nd++; if(d>mx)mx=d;} return {mx,nd};};
const outsideRect=(px,R)=>{let n=0;for(let y=0;y<W;y++)for(let x=0;x<W;x++){
  if(x>=R[0]&&x<R[0]+R[2]&&y>=R[1]&&y<R[1]+R[3])continue; if(inkAt(px,x,y))n++;} return n;};
const fillOfRect=(px,R)=>{let n=0,t=0;for(let y=R[1];y<R[1]+R[3];y++)for(let x=R[0];x<R[0]+R[2];x++){t++;if(inkAt(px,x,y))n++;} return n/t;};

window.__run=async()=>{
  const rows=[];
  const base=await shot({});
  const full=await shot({dstRect:[0,0,W,W]});
  rows.push({id:'P1 identity', ...diff(base.px,full.px), ...inkBox(full.px), outside:0, cover:1, drew:full.drew});

  const meet=await shot({dstRect:RECT});
  rows.push({id:'P2 meet', mx:0,nd:0, ...inkBox(meet.px), outside:outsideRect(meet.px,RECT),
             cover:fillOfRect(meet.px,RECT), drew:meet.drew});

  const slice=await shot({dstRect:RECT,fit:'xMidYMid slice'});
  rows.push({id:'P3 slice', mx:0,nd:0, ...inkBox(slice.px), outside:outsideRect(slice.px,RECT),
             cover:fillOfRect(slice.px,RECT), drew:slice.drew});

  const spill=await shot({dstRect:RECT,fit:'xMidYMid slice',clipToRect:false});
  rows.push({id:'P4 noclip', mx:0,nd:0, ...inkBox(spill.px), outside:outsideRect(spill.px,RECT),
             cover:fillOfRect(spill.px,RECT), drew:spill.drew});

  const none=await shot({dstRect:RECT,fit:'none'});
  rows.push({id:'P5 none', mx:0,nd:0, ...inkBox(none.px), outside:outsideRect(none.px,RECT),
             cover:fillOfRect(none.px,RECT), drew:none.drew});

  // P6: two rects in one frame. Left rect drawn first (it sets a scissor), right rect second.
  const L=[16,180,200,160], Rr=[296,180,200,160];
  const two=await shot({dstRect:L},{dstRect:Rr});
  const lBox=(()=>{let n=0;for(let y=L[1];y<L[1]+L[3];y++)for(let x=L[0];x<L[0]+L[2];x++)if(inkAt(two.px,x,y))n++;return n;})();
  const rBox=(()=>{let n=0;for(let y=Rr[1];y<Rr[1]+Rr[3];y++)for(let x=Rr[0];x<Rr[0]+Rr[2];x++)if(inkAt(two.px,x,y))n++;return n;})();
  rows.push({id:'P6 two', mx:lBox,nd:rBox, ...inkBox(two.px), outside:0, cover:0, drew:two.drew});

  const filt=await shot({dstRect:RECT},null,SVG_F);
  rows.push({id:'P9 filter', mx:0,nd:0, ...inkBox(filt.px), outside:outsideRect(filt.px,RECT),
             cover:fillOfRect(filt.px,RECT), drew:filt.drew});

  // P8: hit test vs ink, on the meet arm. Skip pixels within 1 of a drawn edge (AA).
  const m=meet.mat; const b=meet.bundle;
  let bad=0, tested=0, worst=null;
  for(let gy=0;gy<64;gy++)for(let gx=0;gx<64;gx++){
    const x=Math.floor((gx+0.5)*W/64), y=Math.floor((gy+0.5)*W/64);
    const here=inkAt(meet.px,x,y); let edge=false;
    for(let dy=-1;dy<=1&&!edge;dy++)for(let dx=-1;dx<=1;dx++){
      const nx=x+dx,ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=W)continue;
      if(inkAt(meet.px,nx,ny)!==here){edge=true;break;} }
    if(edge)continue; tested++;
    const hit=fillHitShape(b,x,y,{mode:'coverage',worldMatrix:new Float32Array(m)})>=0;
    if(hit!==here){bad++; if(!worst)worst=x+','+y+' ink='+here+' hit='+hit;}
  }
  rows.push({id:'P8 hit', mx:bad,nd:tested, n:0, box:[0,0,0,0], outside:0, cover:0, drew:worst||'-'});
  return rows.map(r=>({...r, px:undefined}));
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
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 100 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log('\n  RECT = [128,128,256,256];  predicted meet ink = [128,192,256,128]');
console.log(
  '  row           a       b   inkPx   inkBox(x,y,w,h)        outside  rectCover  engines',
);
for (const r of rows) {
  console.log(
    '  ' +
      String(r.id).padEnd(12) +
      String(r.mx).padStart(6) +
      String(r.nd).padStart(8) +
      String(r.n).padStart(8) +
      '   ' +
      String((r.box || []).join(',')).padEnd(22) +
      String(r.outside).padStart(7) +
      '   ' +
      Number(r.cover || 0)
        .toFixed(3)
        .padStart(7) +
      '   ' +
      r.drew,
  );
}
console.log('\n  P1: a=maxDelta b=diffPx (both must be 0)   P6: a=leftInk b=rightInk (both > 0)');
console.log(
  '  P8: a=disagreements (must be 0) b=pixels tested, engines column names the first miss',
);
