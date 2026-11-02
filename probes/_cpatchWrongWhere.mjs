// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// WHERE is CPatch wrong? "Rough exterior edges" and "missing interior lines" are two different
// defects and they need separating before either can be fixed. Against a supersampled reference
// this classifies every pixel:
//
//   MISSING  reference says solid, engine has it more off than on   — ink that should be there
//   EXTRA    reference says empty, engine has it more on than off   — ink that should not be
//   edge AA  reference strictly between                             — reported as mean/max error
//
// and splits MISSING/EXTRA by whether the pixel is INTERIOR (all 8 reference neighbours solid) or
// on the BOUNDARY, which is what says whether a defect is a seam or an outline problem.
// RUN IT AT SEGS=8 AS WELL AS 16. A fine ring's patches are small and cannot reach past their own
// boundary, so it hides the worst class outright. A COARSE one — fewer, larger patches, implicits
// reaching furthest — is three times worse and fails the other way round:
//
//     segs 16   AA mean 0.0162   max 0.240      (under-covers: ramp pixels lost to a cut)
//     segs  8   AA mean 0.0487   max 0.714      (OVER-covers: edge pixels saturate)
//
// At 8 the worst pixels read 1.000 against a reference of 0.286-0.497 and REJHARD returns 64.00 —
// nothing rejects them. The patch painting them satisfies every constraint it has, so its set
// leaves that direction open and the cover reaches into it. Narrowed: the arc-box gate is not the
// cause (OFFARC_STEP moves the mean 0.0487 -> 0.0403, max unchanged), and cover dilation is only
// part of it (at zero dilation max falls 0.714 -> 0.497, so something still paints past the
// outline with no dilation at all).
//
// SIX CANDIDATE FIXES, each of which fails on one of three axes — wrong pixels, agreement with
// Slug, or speed. Listed so none is re-attempted blind:
//
//   cover hull as linear boundaries   wrong 127 -> 0, coarse AA 0.0487 -> 0.0341, max -> 0.370
//                                     BUT 4.40ms -> 9.20ms and, against Slug, alpha 1 173px -> 531
//   the same, from the DRAWN hull     AA 0.0379 / 0.370 and still alpha 1 173 -> 523: an AA'd hull
//                                     plane ramps INSIDE the hull too, and the region reaches the
//                                     hull wherever the curve is tangent to it
//   the 4-line OBB instead            too loose — the failing points sit within a hundredth of a
//                                     pixel of it (1.000 -> 0.9765)
//   hull planes as CUT-kind           a cut admits a quarter pixel by design and these sit inside
//                                     that slack: no change at all
//   only NON-outline hull edges       nothing to enforce — a Bezier's endpoints lie ON its hull, so
//                                     every edge touches; testing the edge's MIDDLE finds 14-48
//                                     enforceable planes and moves AA 0.0487 -> 0.0480
//   forcing the depth claim on        segs 8 max 0.714 -> 0.602 but segs 16 0.240 -> 0.570 (it
//                                     z-fights between coplanar patches)
//
// The decomposition does NOT leave a patch unbounded.
// Probed on a ring 88em outside an 8-segment shape, ZERO points fall inside any patch — every one
// is closed. And the saturated pixels all sit at r = 44.00-44.35 where the on-curve radius is 44:
// they are the CORNERS, the junctions between segments, and _cpatchCoverGap finds two of the three
// claimed by no patch at all while the GPU paints them 1.000.
//
// GROUND TRUTH is computed directly in _cpatchCoverGap — the curves flattened to a fine polygon
// and the pixel BOX integrated against it, with no renderer in the loop. It says the reference is
// right and the GPU is wrong: (243,70) is 0.313 covered, (222,41) 0.480, (218,37) 0.531, and the
// GPU paints all three 1.000 (the outline sits at r = 44.29 there).
//
// The GPU over-paints for TWO separate reasons, both confirmed by splitting inPatch in half:
//
//   1. THE COVER HULL IS NOT ENFORCED IN THE SHADER. inPatch rejects on the cover's half-planes
//      AND the curve implicits; the fragment stage tests only the implicits, because the cover is
//      rasterized geometry — and that geometry is DILATED 1.5px past the hull for the AA ramp. At
//      (243,70) and (222,41), patch 15 passes every implicit and fails the cover, so the shader
//      paints a fragment the CPU calls outside. The hull is a real part of the patch's boundary
//      and nothing analytic holds it.
//
//   2. RAMPS FROM SEVERAL PATCHES COMPOSITE. At (218,37) no patch passes its implicits — all 17
//      fail one — yet the pixel still reaches 1.000, because a patch whose implicit is slightly
//      negative returns a partial ramp rather than 0, and several of those under OVER sum toward
//      full coverage.
//
// Both are over-coverage and both scale with patch size, which is why coarse shapes are three
// times worse. (1) wants the cover hull passed to the fragment stage as half-planes; (2) is the
// disjointness assumption failing in the AA band, where patches overlap by construction.
//
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 256),
  SS = +(process.env.SS || 4);
const OUT = process.env.OUT || '';
// ── IMAGE OUTPUT (OUT=<dir>) ────────────────────────────────────────────────
// Numbers said clean while real shapes showed hairline gaps, so the render itself has to be
// inspectable. Writes what CPatch drew, the reference, and a DIFF that paints every pixel off by
// more than 0.02 -- red where we are DARKER than the reference (a gap), blue where lighter.
import zlib from 'zlib';
import { writeFileSync } from 'fs';
const _png = (pix, w, h) => {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = ((h - 1 - y) * w + x) * 4;
      raw[y * (w * 3 + 1) + 1 + x * 3] = pix[i];
      raw[y * (w * 3 + 1) + 2 + x * 3] = pix[i + 1];
      raw[y * (w * 3 + 1) + 3 + x * 3] = pix[i + 2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crcT = Buffer.alloc(4);
    crcT.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crcT]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const SEGS = +(process.env.SEGS || 16),
  FAM = process.env.FAMILY || 'quad';
const ENGINE = process.env.ENGINE || 'cpatch';
const CPGRID = process.env.CPGRID ? +process.env.CPGRID : null;
const CPAA = process.env.CPAA ? +process.env.CPAA : null;
const NOGRAPH = process.env.NOGRAPH ? 1 : 0;
const DEFS = process.env.DEFS ? process.env.DEFS.split(',') : null; // bare NAMES, no values
const PAGE = `<!doctype html><body><canvas id=c width=${N * SS} height=${N * SS}></canvas><script type=module>
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
if (${JSON.stringify(process.env.BOXW || process.env.HULLW || '')}) globalThis.__MANTLE_DEBUG__ = true;   // the pack weights are test hooks, read only under it
if (${JSON.stringify(process.env.BOXW || '')}) globalThis.__CP_BOX_W = ${JSON.stringify(process.env.BOXW ? Number(process.env.BOXW) : 0)};

if (${JSON.stringify(process.env.HULLW || '')}) globalThis.__CP_HULL_W = ${JSON.stringify(process.env.HULLW ? Number(process.env.HULLW) : 1)};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const FOP=${JSON.stringify(process.env.ALPHA || '')};
const N=${N}, SS=${SS}, SEGS=${SEGS}, FAM=${JSON.stringify(FAM)}, ENGINE=${JSON.stringify(ENGINE)}, CPGRID=${JSON.stringify(CPGRID)}, CPAA=${JSON.stringify(CPAA)}, NOGRAPH=${JSON.stringify(NOGRAPH)}, DEFS=${JSON.stringify(DEFS)};
const ring=()=>{const cx=64,cy=64,r=44,P=[];
  for(let i=0;i<SEGS;i++){const a=-Math.PI/2+i*2*Math.PI/SEGS;P.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(4)+' '+P[0][1].toFixed(4);
  for(let i=0;i<SEGS;i++){const p=P[i],q=P[(i+1)%SEGS],mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,BW=(FAM==='deep'?2.6:1.18),bx=cx+(mx-cx)*BW,by=cy+(my-cy)*BW;
    if(FAM==='line')d+=' L'+q[0].toFixed(4)+' '+q[1].toFixed(4);
    else d+=' Q'+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);}
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="'+d+' Z" fill="#000000"'+(FOP?' fill-opacity="'+FOP+'"':'')+'/></svg>';};
// A THIN INTERIOR SLOT.
//
// Every family above has an OUTER boundary and nothing else, so anything that lets a patch paint
// further into a region no curve of its own bounds measures CLEAN on all of them while closing
// narrow negative space on real artwork -- a hole, a slot, the gap inside a glyph. It reads as
// missing interior lines, and no ring can show it.
const slot=()=>{const cx=64,cy=64,r=44,N=16,P=[];
  for(let i=0;i<N;i++){const a=-Math.PI/2+i*2*Math.PI/N;P.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(4)+' '+P[0][1].toFixed(4);
  for(let i=0;i<N;i++){const p=P[i],q=P[(i+1)%N],mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,
    bx=cx+(mx-cx)*1.18,by=cy+(my-cy)*1.18;
    d+=' Q'+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);}
  d+=' Z';
  const w=+(${JSON.stringify(process.env.SLOTW || '0.5')}), x0=cx-w/2, x1=cx+w/2, y0=cy-30, y1=cy+30;
  d+=' M'+x0+' '+y0+' L'+x0+' '+y1+' L'+x1+' '+y1+' L'+x1+' '+y0+' Z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="'+d+'" fill="#000000"'+(FOP?' fill-opacity="'+FOP+'"':'')+'/></svg>';};
// TWO SHAPES THAT ABUT — where a hairline gap actually comes from.
//
// A fill that is slightly THIN is invisible on its own: the outline just sits a fraction of a pixel
// inside where it should. Put two such fills edge to edge, as real artwork constantly does, and
// both pull back from the shared edge — so a light line appears between them that is in neither
// shape's own error budget. The static-ink probe already records the thinness (every structural
// pixel DARKER than Slug, 8619 of 8619), and no single-shape family here could turn it into the
// symptom people report.
const abut=()=>{const cx=64,cy=64,r=44,N=16,L=[],R=[];
  for(let i=0;i<=N;i++){const a=-Math.PI/2+i*Math.PI/N; L.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}
  for(let i=0;i<=N;i++){const a=Math.PI/2+i*Math.PI/N; R.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}
  const arc=(P)=>{let d='M'+P[0][0].toFixed(4)+' '+P[0][1].toFixed(4);
    for(let i=0;i<P.length-1;i++){const p=P[i],q=P[i+1],mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,
      bx=cx+(mx-cx)*1.06,by=cy+(my-cy)*1.06;
      d+=' Q'+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);}
    return d+' Z';};
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'+
    '<path d="'+arc(L)+'" fill="#000000"'+(FOP?' fill-opacity="'+FOP+'"':'')+'/><path d="'+arc(R)+'" fill="#000000"'+(FOP?' fill-opacity="'+FOP+'"':'')+'/></svg>';};
// THE BENCH'S DISQUALIFYING SHAPES, verbatim in geometry: a self-intersecting pentagram under
// even-odd, and a comb of seven fingers with ~1.5px gaps. CPatch is disqualified on both (star:
// 7353 structural pixels; comb: 2 wrong-pixel), and no ring family can produce either.
const star=()=>{const r=44; let d='';
  for(let i=0;i<5;i++){const a=-Math.PI/2+i*4*Math.PI/5;
    d+=(i?' L':'M')+(64+r*Math.cos(a)).toFixed(3)+' '+(64+r*Math.sin(a)).toFixed(3);}
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#000000"'+(FOP?' fill-opacity="'+FOP+'"':'')+' fill-rule="evenodd" d="'+d+' Z"/></svg>';};
// n notches separated by teeth, opening and closing with a tooth: (2n+1) bands across 2r, so the
// last notch ends INSIDE the right edge. Advancing 2w per notch off a width of 2r/(2n-1) -- the
// first try -- puts the final notch at 64+1.15r, past the closing edge, and the outline then
// CROSSES itself. CPatch declines self-intersecting contours, so the bug read as a thin-feature
// failure until the cycle count gave it away (31 segs -> 2 cycles).
const comb=()=>{const r=44,n=7,w=2*r/(2*n+1); let d='M'+(64-r)+' '+(64+r)+' L'+(64-r)+' '+(64-r);
  for(let i=0;i<n;i++){const x1=(64-r+(2*i+1)*w).toFixed(3), x2=(64-r+(2*i+2)*w).toFixed(3), yb=(64+r*0.55).toFixed(3);
    d+=' L'+x1+' '+(64-r)+' L'+x1+' '+yb+' L'+x2+' '+yb+' L'+x2+' '+(64-r);}
  d+=' L'+(64+r)+' '+(64-r)+' L'+(64+r)+' '+(64+r)+' Z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill="#000000"'+(FOP?' fill-opacity="'+FOP+'"':'')+' d="'+d+'"/></svg>';};
// SVGFILE=<path> renders a REAL asset through the shipping route instead of a synthetic family,
// so a converter-level finding can be checked against what the renderer actually paints. The
// converter probes drive convertContour directly and therefore skip the pack-level self-overlap
// retry; only a render says whether a defect survives to the screen.
const svg=${JSON.stringify(process.env.SVGFILE ? readFileSync(path.resolve(ROOT, process.env.SVGFILE), 'utf8') : null)}
  || ((FAM==='slot')?slot():(FAM==='abut')?abut():(FAM==='star')?star():(FAM==='comb')?comb():ring());
const draw=async(route,size)=>{ gl.canvas.width=size; gl.canvas.height=size;
  // WARM PIPELINES WITHOUT WAITING FOR IDLE. A fill variant is only USED once its pipeline is built,
  // and that build is gated on idle frames (_psoWarmAllowed) — a probe that draws back to back never
  // has one, so the route sits at gate=variant-warming and falls back for the whole run. psoWarmIdle
  // is the supported hook for saying "now is fine".
  const r=createRenderer(gl,shaders,route==='cpatch'?{psoWarmIdle:()=>true,fillDefines:DEFS||[],cpatchFill:true,
    ...(${JSON.stringify(process.env.NODEPTH === '1')}?{unifiedFillDepthClaim:false}:{}),cpatchOpts:Object.assign({},CPGRID?{grid:CPGRID}:{},CPAA?{gridAaPx:CPAA}:{},NOGRAPH?{graph:false}:{})}:{psoWarmIdle:()=>true,fillDefines:DEFS||[]});   // DEFS on BOTH arms: passing them only to
  // the cpatch arm meant every no-AA and GWN measurement on the Slug route silently tested the
  // ordinary kernel, and reported it as if the define had applied.
  r.setViewport(size,size); r.setFillEngine({route});
  const b=createBundle(gl,await importSvg(svg)); r.prepareBundle(b);
  if(r.awaitEngine){try{await r.awaitEngine(b,route,60000);}catch{}}
  // WARM THE VARIANT BEFORE MEASURING. A fill variant links and has its pipeline built off the
  // critical path, and until it is ready the route falls back — one frame in, a bundle carrying a
  // recognized primitive reported gate=variant-warming and drew entirely with Slug. That is a real
  // first-frame behaviour, and it is not what this probe is trying to photograph.
  for (let w = 0; w < 24; w++) { r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame(); }
  r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();
  const px=new Uint8Array(size*size*4); gl.readPixels(0,0,size,size,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const ds=r.debugStats,e=ds.engines&&ds.engines.draws||{};
  if (${JSON.stringify(process.env.DIAG === '1')}) {
    const ms=b._lbMeshes; console.log('[diag] route='+route
      +' meshes='+(ms?ms.length:'none')
      +' prim='+(ms?ms.filter(m=>m&&m.prim).length:0)
      +' slugSentinel='+(ms?ms.filter(m=>m&&m.slug).length:0)
      +' gate='+(ds.unifiedFillGate||'?')+' uni='+(ds.unifiedFillDraws|0));
  }
  // ONE PASS OR TWO? The whole case for mixing engines in a bundle is that they still draw in a
  // single pass; a mixed bundle that splits would pay exactly the switch cost mixing is meant to
  // avoid. So report the unified draw count next to which engines ran.
  return {px, uni:(ds.unifiedFillDraws|0), drew:Object.keys(e).filter(k=>e[k]>0).join('+')||'none'};};
// reference: the SAME engine-independent picture, supersampled and box-downsampled to coverage
const hi=await draw('none', N*SS);
const ref=new Float32Array(N*N);
for(let y=0;y<N;y++)for(let x=0;x<N;x++){let s=0;
  for(let j=0;j<SS;j++)for(let i=0;i<SS;i++){const p=(((y*SS+j)*N*SS)+(x*SS+i))*4; s+=(255-hi.px[p])/255;}
  ref[y*N+x]=s/(SS*SS);}
const got=await draw(ENGINE, N);
// AN ENGINE THAT DID NOT DRAW HAS NO ACCURACY. Numbers below are read off PIXELS, and pixels carry
// no engine tag: when the requested route falls back, the row still prints, and it prints the
// FALLBACK's error under the requested engine's name. That is not hypothetical -- SVGFILE mode on a
// real asset reported drew slug+lb+sdf under a run that asked for CPatch, because a second live
// renderer on this one context accepted the LB build that the CPatch renderer had declined on
// purpose (builders are a module-level list in bundle.js, walked newest-first, first non-false
// wins). The mis-measurement is what this line exists to make impossible to miss; for engine
// attribution on a real asset use _cpatchBuildTime, which runs ONE renderer and prints the engine ledger.
if (ENGINE !== 'none' && !got.drew.split('+').includes(ENGINE))
  // '[diag]' prefix: the node side forwards only lines that start with it, and a warning nobody
  // sees is not a guard. It forwards unconditionally, so this shows without DIAG=1.
  console.log('[diag] !! ' + ENGINE.toUpperCase() + ' DID NOT DRAW (drew ' + got.drew + ') -- numbers below belong to that engine, not ' + ENGINE);
const cov=new Float32Array(N*N);
for(let i=0;i<N*N;i++) cov[i]=(255-got.px[i*4])/255;
const solid=(i)=>ref[i]>0.999, empty=(i)=>ref[i]<0.001;
const interior=(x,y)=>{ if(x<1||y<1||x>=N-1||y>=N-1) return false;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) if(!solid((y+dy)*N+(x+dx))) return false; return true; };
let missInt=0,missBnd=0,extraInt=0,extraBnd=0,aaSum=0,aaN=0,aaMax=0,strayMax=0; const worst=[];
// INTERIOR SEAMS. A solid pixel counted as missing only BELOW HALF coverage, and AA error was
// measured only where the reference is fractional -- so a seam that drops a wholly-interior pixel
// from 1.00 to 0.51 fell through both and every read came back clean. That is the shape of the
// defect people actually report: lines inside the fill. Measured only on pixels the reference says
// are wholly inside, so none of this is an antialiasing question.
let inSum=0,inN=0,inMax=0,inBad=0; const inWorst=[];
for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=y*N+x;
  if(solid(i)){ if(cov[i]<0.5){ interior(x,y)?missInt++:missBnd++; }
    if(interior(x,y)){ const e=Math.abs(1-cov[i]); inSum+=e; inN++;
      if(e>inMax) inMax=e; if(e>0.02){ inBad++; if(inWorst.length<400) inWorst.push([x,y,+e.toFixed(3),+cov[i].toFixed(3)]); } } }
  else if(empty(i)){
    // ANY ink where the reference is empty, not just more-on-than-off. At >0.5 this counted 0
    // while a change was painting visible stray lines outside the shape — an implicit's far branch
    // leaking through produces a THIN line, and a thin line is faint after coverage, so the
    // half-covered threshold is exactly the wrong place to look for it.
    if(cov[i]>0.02) { interior(x,y)?extraInt++:extraBnd++; if(cov[i]>strayMax)strayMax=cov[i]; }
  }
  else { const e=Math.abs(cov[i]-ref[i]); aaSum+=e; aaN++; if(e>aaMax)aaMax=e;
         if(e>0.15) worst.push([x,y,+e.toFixed(3),+ref[i].toFixed(3),+cov[i].toFixed(3)]); } }
worst.sort((a,b)=>b[2]-a[2]);
// raw kernel value at named pixels — with MANTLE_CPATCH_REJHARD the returned value encodes
// which curve rejected: v*64 = n*8 + i + 1, and 0.015 means nothing rejected.
const AT=${JSON.stringify(
  (process.env.PROBEAT || '')
    .split(';')
    .filter(Boolean)
    .map((p) => p.split(',').map(Number)),
)};
const at=AT.map(([x,y])=>{const i=y*N+x; return {x,y,got:+cov[i].toFixed(4),ref:+ref[i].toFixed(3),
  code:+(cov[i]*64).toFixed(2)};});
inWorst.sort((a,b)=>b[2]-a[2]);
window.__out={at, uniDraws:(got.uni|0), drew:got.drew, refDrew:hi.drew, cov:Array.from(cov), ref:Array.from(ref), inMean:inN?inSum/inN:0, inMax, inN, inBad, inWorst:inWorst.slice(0,8), missInt,missBnd,extraInt,extraBnd, aaMean:aaN?aaSum/aaN:0, aaMax, aaN, strayMax, worst:worst.slice(0,14), nWorst:worst.length};
window.__ready=true;
</script></body>`;
const srv = http.createServer((q, r) => {
  try {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    r.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    r.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!r.headersSent) r.writeHead(404);
    r.end();
  }
});
await new Promise((x) => srv.listen(0, '127.0.0.1', x));
const port = srv.address().port;
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[pg]', e.message));
pg.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[diag]')) console.log(t);
});
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready, { timeout: 300000 });
const o = await pg.evaluate(() => window.__out);
// WHICH ENGINE DREW THE REFERENCE. It is rendered with the DEFAULT engine, so auto-selection can
// hand it to the very engine under test -- and then a systematic defect cancels out of every diff
// and the probe reports clean. Printed, not assumed.
console.log(`    unified draws  ${o.uniDraws}   (one pass = the mix did not split)`);
console.log(
  `\n  ${ENGINE} · ${FAM} ring, ${SEGS} segs, ${N}px vs ${SS}x reference   (drew ${o.drew}, reference drew ${o.refDrew})`,
);
console.log(
  `    MISSING  interior ${String(o.missInt).padStart(5)}   boundary ${String(o.missBnd).padStart(5)}`,
);
console.log(
  `    EXTRA    interior ${String(o.extraInt).padStart(5)}   boundary ${String(o.extraBnd).padStart(5)}   (any ink >0.02 where the reference is empty; worst ${o.strayMax.toFixed(3)})`,
);
console.log(
  `    AA       mean ${o.aaMean.toFixed(4)}   max ${o.aaMax.toFixed(3)}   over ${o.aaN} edge px`,
);
if (o.at && o.at.length) {
  console.log('    sampled pixels (got, ref, REJHARD code = n*8+i+1):');
  for (const a of o.at)
    console.log(
      `      (${String(a.x).padStart(3)},${String(a.y).padStart(3)})  got ${a.got.toFixed(4)}  ref ${a.ref.toFixed(3)}  code ${a.code.toFixed(2)}`,
    );
}
if (OUT) {
  const n = o.at ? 0 : 0;
  const W = +(process.env.N || 256);
  const mk = (f) => {
    const b = new Uint8Array(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      const v = f(i);
      b[i * 4] = v[0];
      b[i * 4 + 1] = v[1];
      b[i * 4 + 2] = v[2];
      b[i * 4 + 3] = 255;
    }
    return b;
  };
  const g = (v) => {
    const c = Math.round(255 * (1 - v));
    return [c, c, c];
  };
  writeFileSync(
    `${OUT}/cpatch_got.png`,
    _png(
      mk((i) => g(o.cov[i])),
      W,
      W,
    ),
  );
  writeFileSync(
    `${OUT}/cpatch_ref.png`,
    _png(
      mk((i) => g(o.ref[i])),
      W,
      W,
    ),
  );
  writeFileSync(
    `${OUT}/cpatch_diff.png`,
    _png(
      mk((i) => {
        const d = o.cov[i] - o.ref[i];
        if (d < -0.02) return [255, 0, 0]; // darker than the reference: a GAP
        if (d > 0.02) return [0, 80, 255]; // lighter: over-paint
        return g(o.ref[i] * 0.25);
      }),
      W,
      W,
    ),
  );
  console.log(`    wrote ${OUT}/cpatch_{got,ref,diff}.png  (red = gap, blue = over-paint)`);
}
console.log(
  `    INTERIOR ${String(o.inBad).padStart(5)} of ${o.inN} wholly-inside px off by >0.02   mean ${o.inMean.toFixed(4)}   max ${o.inMax.toFixed(3)}`,
);
if (o.inWorst && o.inWorst.length) {
  console.log(`      worst interior (x, y, err, got):`);
  for (const w of o.inWorst)
    console.log(
      `        (${String(w[0]).padStart(3)},${String(w[1]).padStart(3)})  err ${w[2].toFixed(3)}  got ${w[3].toFixed(3)}`,
    );
}
console.log(`    ${o.nWorst} edge px with error > 0.15; worst (x, y, err, ref, got):`);
for (const w of o.worst)
  console.log(
    `      (${String(w[0]).padStart(3)},${String(w[1]).padStart(3)})  err ${w[2].toFixed(3)}  ref ${w[3].toFixed(3)} -> got ${w[4].toFixed(3)}`,
  );
// PROBEAT="x,y;x,y" — the value at NAMED pixels. The page has always computed this; nothing
// printed it. The worst-list is sorted by error, so under a measurement define that moves every
// pixel it stops naming the ones under investigation, which is exactly when you need them.
if (o.at && o.at.length) {
  console.log('    named pixels:');
  for (const a of o.at)
    console.log(
      `      (${String(a.x).padStart(3)},${String(a.y).padStart(3)})  ref ${a.ref.toFixed(3)} -> got ${a.got.toFixed(4)}   (x64 = ${a.code})`,
    );
}
await br.close();
srv.close();
