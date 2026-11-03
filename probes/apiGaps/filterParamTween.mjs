// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterParamTween — does changing a filter parameter after import change the PIXELS?
//
// `test/filterParamTweenSmoke.mjs` pins the write side without a GPU: which
// parameters are writable, where the value lands, the copy-on-write that keeps
// one bundle's tween out of another's picture, and — by reading the source —
// that four cache keys carry the write token. It cannot see the only thing a
// caller cares about: that the frame after the write looks different.
//
// It also cannot see the FAILURE MODE, which is silent by construction. The
// filter-result cache keys on generation, geometry, morph t, canvas size, world
// matrix, recolor and variant. Before this work it had no parameter term, so a
// mutated sigma re-ran nothing and frame 1's output was served for the life of
// the bundle. A probe that only checked "the tween works" would pass on a build
// where the cache was accidentally disabled, so every arm below is paired with
// its BYPASS arm: the same write made WITHOUT the token, which must NOT move.
//
// RUN:  node probes/apiGaps/filterParamTween.mjs
//       GPU=1 node probes/apiGaps/filterParamTween.mjs
//
// PREDICTIONS (written before the first run):
//
//   A1  single blur     sigma 2 -> 10 on a lone feGaussianBlur (the packed-float
//                       route) changes the frame: maxDelta > 32 and the ink
//                       bbox grows by more than 16 px on each axis. The blur is
//                       Gaussian with radius ceil(3*sigma), so 2 -> 10 is a
//                       ~24 px wider halo at this scale — well past any AA noise.
//   A2  bypass          the same float written straight into
//                       bundle.lastFilterFloats, with no token bump, changes
//                       nothing: maxDelta 0. This is the cache doing its job,
//                       and it is what makes A1 evidence rather than a
//                       coincidence. If A2 also moves, the filter cache is not
//                       engaging at all here and A1 proves nothing about the
//                       key.
//   A3  graph blur      the same tween through a drop shadow's graph node
//                       (bundle.filterGraphs[0].nodes[0].params) moves the
//                       frame, and its bypass twin does not.
//   A4  graph offset    dx/dy 3,4 -> 14,16 moves the shadow, not the shape: the
//                       DIFFERING pixels must sit outside the source rect's
//                       bbox on at least three sides, and the rect's own
//                       interior must be untouched (< 1% of its pixels differ).
//                       Distinguishes "the shadow moved" from "everything
//                       re-rendered slightly differently".
//   A5  reset           reset() returns the frame to the imported picture
//                       BIT-IDENTICALLY (maxDelta 0 against the very first
//                       frame). A nonzero delta means a tween leaves state
//                       behind — the thing that makes an animation drift.
//   A6  static cache    with the static cache forced to WholeAsset and the mount
//                       drawn past its first bake, the tween still changes the
//                       frame. This is the second cache, and it has its own key
//                       (_drawStateHash); if A6 is the only row that misses,
//                       the filter re-evaluated and a stale blit covered it.
//                       Watch for the vacuous version: enableStaticCache warns
//                       and no-ops before a bundle is bound, so a row measured
//                       with no cache at all would pass for the wrong reason —
//                       the arm binds first, on purpose.
//   A7  engine          every arm draws on the same engine set as its own
//                       first frame. A filter parameter is not a routing input,
//                       so a route change means something fell back — and a
//                       fallback that still paints is how a broken path reads
//                       as a success.
//
// FALSIFIABLE CLAIM: a filter parameter written through `createFilterParams`
// takes effect on the NEXT frame, on both storage routes, through both caches,
// and returns exactly to the imported picture on reset — and it does so BECAUSE
// of the cache key term, not in spite of it. Concretely: A1/A3/A4/A6 report
// maxDelta > 32; every *bypass* row reports maxDelta 0; A5 reports maxDelta 0
// against frame 1; A7 reports one engine set per arm. Any row missing falsifies
// it, and the per-row numbers name which.
//
// THE GRAPH ROWS DRAW WITH THE VIEWBOX PRESERVED. setViewport + drawBundle fit the bundle's CONTENT
// bbox, so with a fitted framing the drop shadow's rect fills the canvas and the shadow -- offset 3-4
// units behind it -- lies under it or off the canvas, and A3/A4 read 0 against a tween that WORKS.
// With the viewBox kept, A3 moves 18,296 px, A4 moves the shadow (5,278 px outside the rect, 0 inside)
// and A3's bypass stays 0. The packed-float rows keep the fitted framing: with a sub-rect region their
// bypass would change the region's size, which the cache's hit test compares, so a raw write would
// re-evaluate -- not a stale-cache test.
//
// WHAT AN A3/A4 ZERO WOULD MEAN with the framing right: the write token bumped and the value sitting in
// the node's params, the filter-result cache missing (its key carries the token) and re-evaluating the
// WRONG GRAPH. The unified fill route keeps a per-bundle stream across frames, and an offscreen-filtered
// entry rides it as an isolation job; a job holding the graph OBJECT, captured when the stream was built,
// would point at the pre-write graph for the life of the bundle, because a parameter write moves none of
// the stream's inputs. The packed-float route re-reads lastFilterFloats every frame (which is why A1
// works), and renderer.js's classic drawList loop looks the graph up live. The job carries the graph's
// ID. `test/filterGraphTweenReachSmoke.mjs` pins the chain without a GPU; A3/A4 are what say it reaches
// the pixels.
//
// NOT SETTLED HERE: cost. A per-frame tween re-evaluates the filter every
// frame, which is exactly what an uncached filter already does, but the RT
// pool re-buckets when the blur's rect crosses a 128 px quantum
// (filterDraw's RECT_Q) and that is an allocation. Whether a sigma sweep across
// a bucket boundary hitches is a timing question and belongs in a timing probe.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createFilterParams, CacheStrategy } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const W=384;
const RECT='<rect x="120" y="120" width="160" height="160" fill="#1b3a6b" filter="url(#f)"/>';
const SINGLE='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>'
  +'<filter id="f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2"/></filter>'
  +'</defs>'+RECT+'</svg>';
const GRAPH='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>'
  +'<filter id="f" x="-60%" y="-60%" width="220%" height="220%">'
  +'<feDropShadow dx="3" dy="4" stdDeviation="2" flood-color="#000"/></filter>'
  +'</defs>'+RECT+'</svg>';
const mk=async(svg,pv)=>{
  const c=document.createElement('canvas');c.width=W;c.height=W;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(W,W);
  const b=createBundle(gl,await importSvg(svg,pv?{preserveViewport:true}:{}));
  return {gl,r,b,h:null};
};
// enableStaticCache needs a BOUND handle (it warns and no-ops before setBundle),
// so the cache arm binds, enables with ForceWholeAsset to skip the promotion
// hysteresis, and only then measures. Enabling it before the first draw is the
// easy way to get a row that silently measures no cache at all.
const withCache=(ctx)=>{
  ctx.r.setBundle(ctx.b);
  ctx.r.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
  return ctx;
};
const frame=(ctx,n)=>{
  const {gl,r,b,h}=ctx;
  for(let i=0;i<(n||3);i++){
    gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
    r.beginFrame(null); if(h) h.draw({}); else r.drawBundle(b,{}); r.endFrame();
  }
  const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  return {px,drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
const inkAt=(px,x,y)=>{const i=(((W-1-y)*W)+x)*4; return (px[i]<246||px[i+1]<246||px[i+2]<246);};
const inkBox=(px)=>{let x0=1e9,y0=1e9,x1=-1,y1=-1;
  for(let y=0;y<W;y++)for(let x=0;x<W;x++) if(inkAt(px,x,y)){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
  return x1<0?[0,0,0,0]:[x0,y0,x1-x0+1,y1-y0+1];};
const diff=(a,b)=>{let mx=0,nd=0;for(let i=0;i<a.length;i+=4){
  const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
  if(d>0)nd++; if(d>mx)mx=d;} return [mx,nd];};

window.__run=async()=>{
  const rows=[];
  // --- A1 / A2: the packed-float route, tween vs bypass ------------------------
  {
    const ctx=await mk(SINGLE);
    const f0=frame(ctx);
    const fp=createFilterParams(ctx.b);
    fp.set('f1',{sigmaX:10,sigmaY:10});
    const f1=frame(ctx);
    const [mx,nd]=diff(f0.px,f1.px);
    rows.push({id:'A1 single', mx, nd, box0:inkBox(f0.px).join(','), box1:inkBox(f1.px).join(','), drew:f1.drew});
    // A5: reset must return to the first picture exactly.
    fp.reset();
    const f2=frame(ctx);
    const [rmx,rnd]=diff(f0.px,f2.px);
    rows.push({id:'A5 reset', mx:rmx, nd:rnd, box0:inkBox(f0.px).join(','), box1:inkBox(f2.px).join(','), drew:f2.drew});
  }
  {
    // A2: the same float, written WITHOUT the token. Must not move.
    const ctx=await mk(SINGLE);
    const f0=frame(ctx);
    ctx.b.lastFilterFloats[21]=10; ctx.b.lastFilterFloats[22]=10;   // no _filterParamGen bump
    const f1=frame(ctx);
    const [mx,nd]=diff(f0.px,f1.px);
    rows.push({id:'A2 bypass', mx, nd, box0:inkBox(f0.px).join(','), box1:inkBox(f1.px).join(','), drew:f1.drew});
  }
  // --- A3 / A4: the graph route ------------------------------------------------
  {
    const ctx=await mk(GRAPH,true);
    const f0=frame(ctx);
    const fp=createFilterParams(ctx.b);
    fp.set('f1:0',{sigmaX:10,sigmaY:10});
    const f1=frame(ctx);
    const [mx,nd]=diff(f0.px,f1.px);
    rows.push({id:'A3 graph', mx, nd, box0:inkBox(f0.px).join(','), box1:inkBox(f1.px).join(','), drew:f1.drew});
  }
  {
    const ctx=await mk(GRAPH,true);
    const f0=frame(ctx);
    const fp=createFilterParams(ctx.b);
    fp.set('f1:1',{dx:14,dy:16});
    const f1=frame(ctx);
    const [mx,nd]=diff(f0.px,f1.px);
    // Where did it change? The rect itself is viewBox 120..280 of 400 -> pixels
    // 115..269 at W=384 (the fit letterboxes nothing here: the viewBox is square).
    const R0=[Math.round(120/400*W),Math.round(120/400*W),Math.round(160/400*W),Math.round(160/400*W)];
    let inside=0,insideTot=0,outside=0;
    for(let y=0;y<W;y++)for(let x=0;x<W;x++){
      const i=(((W-1-y)*W)+x)*4;
      const d=Math.max(Math.abs(f0.px[i]-f1.px[i]),Math.abs(f0.px[i+1]-f1.px[i+1]),Math.abs(f0.px[i+2]-f1.px[i+2]));
      const inR=(x>=R0[0]+6&&x<R0[0]+R0[2]-6&&y>=R0[1]+6&&y<R0[1]+R0[3]-6);
      if(inR){insideTot++; if(d>8)inside++;} else if(d>8) outside++;
    }
    rows.push({id:'A4 offset', mx, nd, box0:'in='+inside+'/'+insideTot, box1:'out='+outside, drew:f1.drew});
  }
  {
    // A3 bypass: write the graph node directly, no token.
    const ctx=await mk(GRAPH,true);
    const f0=frame(ctx);
    ctx.b.filterGraphs[0].nodes[0].params.sigmaX=10;
    ctx.b.filterGraphs[0].nodes[0].params.sigmaY=10;
    const f1=frame(ctx);
    const [mx,nd]=diff(f0.px,f1.px);
    rows.push({id:'A3 bypass', mx, nd, box0:inkBox(f0.px).join(','), box1:inkBox(f1.px).join(','), drew:f1.drew});
  }
  // --- A6: the static cache ----------------------------------------------------
  {
    const ctx=withCache(await mk(SINGLE));
    const f0=frame(ctx,6);            // bake, then blit
    const fp=createFilterParams(ctx.b);
    fp.set('f1',{sigmaX:10,sigmaY:10});
    const f1=frame(ctx,4);
    const [mx,nd]=diff(f0.px,f1.px);
    rows.push({id:'A6 cached', mx, nd, box0:inkBox(f0.px).join(','), box1:inkBox(f1.px).join(','), drew:f1.drew});
  }
  return rows;
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
console.log(
  '\n  row           maxDelta   diffPx   before/left           after/right          engines',
);
for (const r of rows) {
  console.log(
    '  ' +
      String(r.id).padEnd(12) +
      String(r.mx).padStart(8) +
      String(r.nd).padStart(9) +
      '   ' +
      String(r.box0).padEnd(21) +
      ' ' +
      String(r.box1).padEnd(20) +
      ' ' +
      r.drew,
  );
}
console.log(
  '\n  A1/A3/A4/A6 must move (maxDelta > 32); every *bypass* row must be 0; A5 must be 0.',
);
console.log(
  '  A4 prints in=<rect-interior pixels changed>/<total> and out=<pixels changed outside it>.',
);
