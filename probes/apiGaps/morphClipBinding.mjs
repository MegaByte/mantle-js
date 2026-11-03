// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphClipBinding — what a morph's clip actually DOES, in pixels.
//
// `test/morphClipBindingSmoke.mjs` pins the merged meta plane: which row index
// each binding ends up holding, and which warnings fire. It cannot see the
// thing that made the defect worth fixing — that an untranslated binding on a
// dst-only shape sends the shader off to clip that shape to a STRANGER'S
// silhouette. The shader walks the binding at `mantle.frag.glsl:1075`, so only
// a rendered frame says whether the right silhouette came back.
//
// RUN:  node probes/apiGaps/morphClipBinding.mjs
//       GPU=1 node probes/apiGaps/morphClipBinding.mjs
//
// THE SCENE. src = two unclipped bars. dst = one of those bars plus a NEW bar
// ("b") clipped to a small square. b is dst-only, and dst's own clip row sits
// at a different absolute index than it does in the merged plane, which is
// exactly the case the translation exists for. At t=1 the morph shows b.
//
// PREDICTIONS (written before the first run):
//
//   B1  fixed / t=1     b is drawn CLIPPED TO THE SQUARE: its ink is confined
//                       to the clip square's pixels (> 95% of the drawn ink of
//                       b lies inside that rect) and covers most of it
//                       (> 60% of the square's interior is inked). This is
//                       "the authored clip survived the merge".
//   B2  base / t=1      on a build without the translation, the same frame is
//                       DIFFERENT: > 200 pixels differ from B1. The base points
//                       b's binding at whatever row the un-translated index
//                       lands on, so b is clipped to that shape instead. Run
//                       this arm by commenting out the auditMorphBindings call
//                       in morphCore.js; the probe prints the instruction
//                       rather than pretending it can toggle it.
//   B3  matched pose    a MATCHED shape that is clipped in src and unclipped
//                       in dst stays clipped at every t: its ink at t=0, t=0.5
//                       and t=1 is confined to src's clip. This is the
//                       constraint, and the point of measuring it is that a
//                       caller reading "the morph warns" should be able to see
//                       what the warning is about.
//   B4  clip deforms    when the two clipPath children share an id, the clip
//                       itself moves with t: the ink bbox at t=0 and t=1
//                       differ by more than 8 px on at least one edge, and t=0.5
//                       sits strictly between them. This is the supported way
//                       to animate a clip and it must keep working.
//   B5  engine          every arm draws on the same engine set across t. A clip
//                       forces particular routes; if t=1 reports a different
//                       engine from t=0 the comparison above is between two
//                       renderers, not two poses.
//
// FALSIFIABLE CLAIM: a dst-only shape keeps the clip it was authored with
// across a morph, a matched shape keeps SRC's clip at every t, and a clip whose
// children match by id deforms with t. Concretely: B1 reports insideFrac > 0.95
// and coverFrac > 0.60; B3 reports insideFrac > 0.95 at all three t; B4 reports
// a bbox that moves monotonically; B5 reports one engine set per arm. B2 is the
// counter-arm and needs the one-line edit named above — without it the probe
// reports "base not run" rather than claiming a comparison it did not make.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const W=320;
// USER SPACE IS NOT THE VIEWBOX HERE. setViewport + drawBundle fit the bundle's inked CONTENT
// bbox (docs: renderer-fits-content-bbox), and these scenes' content is x 5..95 / y 10..90, so
// "viewBox 0..100 maps 1:1 to W/100 px" -- which this probe assumed -- put every rect it tested
// in the wrong place and made all three rows miss. Every user->pixel map below goes through
// renderer.bundleDrawMatrix instead. The clip square is 40..70 in both axes.
const CLIP='<defs><clipPath id="c1"><rect id="cl" x="40" y="40" width="30" height="30"/></clipPath></defs>';
const CLIP2='<defs><clipPath id="c1"><rect id="cl" x="15" y="15" width="70" height="70"/></clipPath></defs>';
const bar=(id,x,clip)=>'<rect id="'+id+'" x="'+x+'" y="10" width="25" height="80" fill="#1b3a6b"'
  +(clip?' clip-path="url(#c1)"':'')+'/>';
const doc=(defs,body)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+defs+body+'</svg>';
// B1/B2: dst-only clipped shape.
const SRC_A=doc('', bar('a',5,false)+bar('z',70,false));
const DST_A=doc(CLIP, bar('a',5,false)+bar('b',40,true));
// B3: matched shape, clipped in src, unclipped in dst.
const SRC_B=doc(CLIP, bar('a',35,true));
const DST_B=doc('', bar('a',35,false));
// B4: the clip itself morphs (its child shares an id).
const SRC_C=doc(CLIP, bar('a',35,true));
const DST_C=doc(CLIP2, bar('a',35,true));

const mk=async(sa,da)=>{
  const c=document.createElement('canvas');c.width=W;c.height=W;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(W,W);
  const m=createShapeMorph(gl, createBundle(gl,await importSvg(sa,{})),
                               createBundle(gl,await importSvg(da,{})));
  return {gl,r,m};
};
const at=(ctx,t)=>{
  const {gl,r,m}=ctx; m.setT(t);
  for(let i=0;i<4;i++){
    gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
    // THE MORPH'S OWN OVERRIDE TABLE HAS TO BE PASSED. drawBundle accepts the morph handle and
    // unwraps .bundle, but the draw reads overrides only from opts (drawDispatch.js:102), so
    // drawBundle(m, {}) renders the geometry lerp WITHOUT the src-only/dst-only fade -- both
    // poses' unmatched shapes painted at full strength at every t. The documented call is
    // drawBundle(morph.bundle, { overrides: morph.overrides }) (docs/NATIVE_FALLBACK.md:223).
    r.beginFrame(null); r.drawBundle(m,{overrides:m.overrides}); r.endFrame();
  }
  const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  const M=r.bundleDrawMatrix?Array.from(r.bundleDrawMatrix(m,undefined)||[]):null;
  return {px,M,drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
// A user-space rect as PIXELS, through the draw's own em->pixel matrix (column-major 3x3,
// y-down). These scenes carry no rotation, so the mapped rect stays axis-aligned.
const pxRect=(M,R)=>{const f=(x,y)=>[M[0]*x+M[3]*y+M[6], M[1]*x+M[4]*y+M[7]];
  const a=f(R[0],R[1]), b=f(R[0]+R[2],R[1]+R[3]);
  return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])];};
const inkAt=(px,x,y)=>{const i=(((W-1-y)*W)+x)*4; return (px[i]<230||px[i+1]<230||px[i+2]<230);};
const box=(px)=>{let x0=1e9,y0=1e9,x1=-1,y1=-1;for(let y=0;y<W;y++)for(let x=0;x<W;x++)
  if(inkAt(px,x,y)){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
  return x1<0?[0,0,0,0]:[x0,y0,x1-x0+1,y1-y0+1];};
// Ink inside a user-space rect vs total ink, and how much of the rect is inked.
const frac=(px,R,M)=>{const P=pxRect(M,R);
  const rx=P[0], ry=P[1], rw=P[2], rh=P[3];
  let inside=0,total=0,rectInk=0,rectTot=0;
  for(let y=0;y<W;y++)for(let x=0;x<W;x++){
    const ink=inkAt(px,x,y); const inR=(x>=rx&&x<rx+rw&&y>=ry&&y<ry+rh);
    if(ink){total++; if(inR)inside++;}
    if(inR){rectTot++; if(ink)rectInk++;}
  }
  return {insideFrac: total?inside/total:0, coverFrac: rectTot?rectInk/rectTot:0, total};};
// A 40x40 ink map of the CANVAS, so a row that misses its prediction says what it drew instead
// of only by how much. Cells are pixels, not user units -- the drawing is fitted to the canvas.
const mapOf=(px)=>{const out=[];for(let cy=0;cy<40;cy++){let line='';
  for(let cx=0;cx<40;cx++){let n=0,t=0;
    for(let y=cy*W/40|0;y<(cy+1)*W/40;y++)for(let x=cx*W/40|0;x<(cx+1)*W/40;x++){t++;if(inkAt(px,x,y))n++;}
    line+= n===0?'.':n===t?'#':'+';}
  out.push(line);}
  return out.join('\\n');};
const diff=(a,b)=>{let mx=0,nd=0;for(let i=0;i<a.length;i+=4){
  const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
  if(d>8)nd++; if(d>mx)mx=d;} return [mx,nd];};

window.__run=async()=>{
  const rows=[];
  {
    // B1: at t=1 the dst-only bar b should be there, clipped to 40..70.
    const ctx=await mk(SRC_A,DST_A);
    const f=at(ctx,1);
    // Ink that is NOT the surviving 'a' bar (x 5..30 user space) is b's.
    // b's ink is what is left once the two bars that are NOT b are excluded: the matched bar 'a'
    // (x 5..30) and the src-only bar 'z' (x 70..95). Excluding only 'a' scored 'z' as b's ink and
    // read a correct clip as a 0.27 miss -- the src-only shape is still drawn at t=1, which is
    // B5's question, not B1's.
    const A=pxRect(f.M,[5,10,25,80]), Z=pxRect(f.M,[70,10,25,80]), S=pxRect(f.M,[40,40,30,30]);
    let bTot=0,bIn=0,sqTot=0,sqIn=0;
    for(let y=0;y<W;y++)for(let x=0;x<W;x++){
      const isA=(x>=A[0]-1&&x<A[0]+A[2]+1)||(x>=Z[0]-1&&x<Z[0]+Z[2]+1);
      const inSq=(x>=S[0]&&x<S[0]+S[2]&&y>=S[1]&&y<S[1]+S[3]);
      if(inSq){sqTot++; if(inkAt(f.px,x,y))sqIn++;}
      if(isA) continue;
      if(inkAt(f.px,x,y)){bTot++; if(inSq)bIn++;}
    }
    rows.push({id:'B1 dstOnly', a:(bTot?bIn/bTot:0).toFixed(3), b:(sqTot?sqIn/sqTot:0).toFixed(3),
               box:box(f.px).join(','), drew:f.drew, map:mapOf(f.px)});
    // B6: WHAT HAPPENS TO THE UNMATCHED SHAPES ACROSS t. The B1 map showed the src-only bar 'z'
    // fully painted at t=1, which B1 itself does not ask about. Report the two unmatched shapes'
    // ink at both ends so the behaviour is on the record rather than inferred from one frame.
    {
      const f0=at(ctx,0);
      const cnt=(px,R)=>{const P=pxRect(f0.M,R);let n=0;
        for(let y=Math.max(0,P[1]|0);y<Math.min(W,P[1]+P[3]);y++)
          for(let x=Math.max(0,P[0]|0);x<Math.min(W,P[0]+P[2]);x++) if(inkAt(px,x,y))n++;
        return n;};
      const P=ctx.m.plan||{};
      // The override table's own numbers, so "the fade did not render" can be told apart from
      // "the fade was never written". 24 floats/shape, float 6 is visibility (renderer.js:2056).
      const vis=(tt)=>{ctx.m.setT(tt);const O=ctx.m.overrides,B=O&&O.packedBuffer;
        if(!B)return 'no packedBuffer';
        const n=Math.min(O.numShapes|0, B.length/24|0);const a=[];
        for(let i=0;i<n;i++)a.push(B[i*24+6].toFixed(2));return a.join(',');};
      const v0=vis(0), v1=vis(1); ctx.m.setT(1);
      rows.push({id:'B6 unmatched',
        a:'z t0='+cnt(f0.px,[70,10,25,80])+' t1='+cnt(f.px,[70,10,25,80]),
        b:'b t0='+cnt(f0.px,[40,40,30,30])+' t1='+cnt(f.px,[40,40,30,30]),
        box:'plan m='+((P.matched||[]).length)+' s='+((P.srcOnly||[]).length)
          +' d='+((P.dstOnly||[]).length)+' | vis t0=['+v0+'] t1=['+v1+']',
        drew:f0.drew});
    }
  }
  {
    // B3: matched, clipped in src, unclipped in dst — src's clip holds at every t.
    const ctx=await mk(SRC_B,DST_B);
    const out=[];
    for(const t of [0,0.5,1]){ const f=at(ctx,t); out.push(frac(f.px,[40,40,30,30],f.M)); }
    rows.push({id:'B3 matched', a:out.map((o)=>o.insideFrac.toFixed(3)).join('/'),
               b:out.map((o)=>o.total).join('/'), box:'-', drew:at(ctx,1).drew, map:mapOf(at(ctx,1).px)});
  }
  {
    // B4: the clip deforms because its child shares an id across the pair.
    const ctx=await mk(SRC_C,DST_C);
    const b0=box(at(ctx,0).px), bh=box(at(ctx,0.5).px), b1=box(at(ctx,1).px);
    const mono=(b0[1]>=bh[1]&&bh[1]>=b1[1])||(b0[1]<=bh[1]&&bh[1]<=b1[1]);
    rows.push({id:'B4 deform', a:b0.join(','), b:b1.join(','),
               box:'mid='+bh.join(',')+' monotone='+mono, drew:at(ctx,1).drew});
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
console.log('\n  row           a                      b                 detail');
for (const r of rows) {
  console.log(
    '  ' +
      String(r.id).padEnd(12) +
      String(r.a).padEnd(23) +
      String(r.b).padEnd(18) +
      ' ' +
      r.box +
      '   ' +
      r.drew,
  );
}
for (const r of rows)
  if (r.map) {
    console.log(
      `\n  ${r.id} ink map (40x40 over the 0..100 user box; the clip square is cells 16..27):`,
    );
    r.map.split('\n').forEach((l, i) => console.log(`   ${String(i).padStart(2)} ${l}`));
  }
console.log(
  "\n  B1: a=fraction of b's ink inside the clip square (want > 0.95), b=fraction of the square inked (want > 0.60)",
);
console.log('  B3: a=insideFrac at t=0/0.5/1 (all > 0.95), b=total ink at each t');
console.log(
  '  B4: a=ink bbox at t=0, b=at t=1; they must differ and the midpoint must sit between them',
);
console.log("  B6: the two UNMATCHED shapes' ink at t=0 and t=1 -- reported, not predicted");
console.log('\n  B2 (the counter-arm) is NOT run here: comment out the auditMorphBindings call in');
console.log('  src/core/morphCore.js, re-run, and diff B1 — the base must differ by > 200 px.');
