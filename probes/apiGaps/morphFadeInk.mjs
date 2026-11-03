// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFadeInk — does `drawBundle(morph, {})` paint the morph's FADE?
//
// `test/drawMorphOverridesSmoke.mjs` pins the resolution rule without a GPU: which table a draw
// binds for each spelling of `opts`, that a bare bundle fades too, and that the three modules
// still agree on the field name. It cannot see the only thing a caller cares about — that the
// unmatched shapes are GONE from the frame.
//
// THE DEFECT IT GUARDS. drawBundle accepts an animation handle and unwraps it to its bundle on purpose
// ("consumers never have to manually unwrap"). A morph's src-only / dst-only visibility does not live
// in the geometry it unwraps to: it lives in the morph's own private table on the bundle (shapeMorph.js,
// `bundle._morphOverrides`). A draw that reads the override table only from `opts.overrides` renders
// the geometry lerp with both poses' unmatched shapes at full strength at every t, while the table is
// written correctly the whole time: visibility [1,1,0,0] at t=0 and [1,0,1,1] at t=1, and tens of
// thousands of device px of src-only ink painted at both ends, which go to 0 when the call passes
// `{ overrides: morph.overrides }`.
//
// RUN:  node probes/apiGaps/morphFadeInk.mjs
//       GPU=1 node probes/apiGaps/morphFadeInk.mjs
//
// THE SCENE. src = bar "a" (matched) + bar "s" (src-only, at x 70). dst = bar "a" + bar "d"
// (dst-only, at x 40). At t=1 "s" must be gone and "d" fully there; at t=0 the reverse. All
// three arms draw the same morph at the same t and differ only in how `opts` spells the table,
// so every number below is a within-run comparison (docs: cross-run-variance-invalid).
//
// PREDICTIONS (written before the first run):
//
//   C1  implicit t=1    `drawBundle(morph, {})` paints NO src-only ink: the pixels inside "s"'s
//                       user rect number < 1% of what the same rect holds at t=0. With the defect
//                       that ratio is ~1.00 — the whole bar, at full strength.
//   C2  explicit == implicit
//                       `drawBundle(morph, { overrides: morph.overrides })` and
//                       `drawBundle(morph, {})` produce BYTE-IDENTICAL frames (0 bytes differ)
//                       at t=0, t=0.5 and t=1. This is the claim: the handle's table is the
//                       same table, resolved at the same point in the draw, not a re-derivation
//                       that could drift. If C2 is nonzero while C1 passes, the draw is binding
//                       SOMETHING, but not what the caller would have passed.
//   C3  explicit null   `drawBundle(morph, { overrides: null })` still paints both poses'
//                       unmatched shapes: "s"'s rect at t=1 comes back to within 1% of its t=0
//                       count. That is the no-fade picture, and keeping one spelling for it is
//                       deliberate — it is the only way to ask for the lerp without the fade.
//   C4  the other end   the same three rows at t=0 for the DST-only bar "d": 0 under C1/C2 and
//                       full under C3. A fade that only works at one end is a t-indexing bug and
//                       would read as a pass on C1 alone.
//   C5  A/A             `drawBundle(morph, {})` twice into the same context differs by 0 bytes.
//                       An arm-to-arm difference smaller than this floor is the harness talking.
//   C6  engine          every arm reports the same engine set. An override table is not a routing
//                       input, so a route change means something fell back — and a fallback that
//                       still paints is how a broken path reads as a success
//                       (docs: probe-must-check-draw-tally).
//   C7  the table       the visibility floats the morph wrote, printed at t=0 and t=1. Reported,
//                       not predicted: it is what separates "the fade did not render" from "the
//                       fade was never written", which is the distinction that cost this defect
//                       its discovery.
//
// FALSIFIABLE CLAIM: after this fix `drawBundle(morph, {})` is byte-for-byte the frame
// `drawBundle(morph, { overrides: morph.overrides })` draws, at every t, and both hide the
// unmatched shapes that `{ overrides: null }` still shows. Concretely: C1 < 0.01, C2 = 0 at all
// three t, C3 > 0.99, C4 matching C1/C3 at the other end, C5 = 0, C6 one engine set. Any row
// missing falsifies it and the per-row numbers name which.
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
const bar=(id,x,fill)=>'<rect id="'+id+'" x="'+x+'" y="10" width="20" height="80" fill="'+fill+'"/>';
const doc=(body)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+body+'</svg>';
// The MATCHED bar is at the same place in both poses, so it never moves and cannot contribute to
// either unmatched rect. "s" (src-only) and "d" (dst-only) sit in disjoint columns.
const SRC=doc(bar('a',5,'#1b3a6b')+bar('s',70,'#8b1b1b'));
const DST=doc(bar('a',5,'#1b3a6b')+bar('d',40,'#1b6b2b'));
const S_RECT=[70,10,20,80], D_RECT=[40,10,20,80];

const mk=async()=>{
  const c=document.createElement('canvas');c.width=W;c.height=W;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(W,W);
  const m=createShapeMorph(gl, createBundle(gl,await importSvg(SRC,{})),
                               createBundle(gl,await importSvg(DST,{})));
  return {gl,r,m};
};
// 'implicit' = drawBundle(m,{}); 'explicit' = the documented hand-threaded call; 'none' = the
// deliberate opt-out. Same handle, same t, same context: only the spelling changes.
const at=(ctx,t,how)=>{
  const {gl,r,m}=ctx; m.setT(t);
  for(let i=0;i<4;i++){
    gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
    r.beginFrame(null);
    if(how==='implicit') r.drawBundle(m,{});
    else if(how==='instanced') r.drawBundleInstanced(m,[{worldMatrix:new Float32Array([1,0,0,0,1,0,0,0,1])}],{});
    else if(how==='handle') (ctx.h||(ctx.h=r.createBundleHandle(m))).draw({});
    else if(how==='explicit') r.drawBundle(m,{overrides:m.overrides});
    else r.drawBundle(m,{overrides:null});
    r.endFrame();
  }
  const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  const M=r.bundleDrawMatrix?Array.from(r.bundleDrawMatrix(m,undefined)||[]):null;
  return {px,M,drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
// USER SPACE IS NOT THE VIEWBOX. setViewport + drawBundle fit the bundle's inked CONTENT bbox
// (docs: renderer-fits-content-bbox), so every user->pixel map goes through bundleDrawMatrix.
const pxRect=(M,R)=>{const f=(x,y)=>[M[0]*x+M[3]*y+M[6], M[1]*x+M[4]*y+M[7]];
  const a=f(R[0],R[1]), b=f(R[0]+R[2],R[1]+R[3]);
  return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])];};
const inkAt=(px,x,y)=>{const i=(((W-1-y)*W)+x)*4; return (px[i]<230||px[i+1]<230||px[i+2]<230);};
const cnt=(f,R)=>{const P=pxRect(f.M,R);let n=0;
  for(let y=Math.max(0,P[1]|0);y<Math.min(W,(P[1]+P[3])|0);y++)
    for(let x=Math.max(0,P[0]|0);x<Math.min(W,(P[0]+P[2])|0);x++) if(inkAt(f.px,x,y))n++;
  return n;};
const bytesDiff=(a,b)=>{let n=0;for(let i=0;i<a.length;i++) if(a[i]!==b[i])n++;return n;};

window.__run=async()=>{
  const rows=[];
  const ctx=await mk();
  // The reference counts: each unmatched bar at the end where it IS supposed to be solid, drawn
  // the documented way. Everything below is a ratio against these, so the probe never depends on
  // a placement constant it would have to keep in step with the fit.
  const sFull=cnt(at(ctx,0,'explicit'), S_RECT);
  const dFull=cnt(at(ctx,1,'explicit'), D_RECT);

  // C1 / C3 / C4: the two unmatched bars at the end where they must be GONE.
  const sImp=cnt(at(ctx,1,'implicit'), S_RECT);
  const sNone=cnt(at(ctx,1,'none'), S_RECT);
  const dImp=cnt(at(ctx,0,'implicit'), D_RECT);
  const dNone=cnt(at(ctx,0,'none'), D_RECT);
  rows.push({id:'C1 s@t=1', a:(sImp/Math.max(1,sFull)).toFixed(4), b:sImp+'/'+sFull,
             note:'implicit: want < 0.01', drew:at(ctx,1,'implicit').drew});
  rows.push({id:'C3 s null', a:(sNone/Math.max(1,sFull)).toFixed(4), b:sNone+'/'+sFull,
             note:'overrides:null: want > 0.99', drew:at(ctx,1,'none').drew});
  rows.push({id:'C4 d@t=0', a:(dImp/Math.max(1,dFull)).toFixed(4)+' / '+(dNone/Math.max(1,dFull)).toFixed(4),
             b:dImp+' / '+dNone+' of '+dFull, note:'implicit / null: want < 0.01 and > 0.99',
             drew:at(ctx,0,'implicit').drew});

  // C8 / C9: the OTHER two entry points that must resolve the morph's table, drawBundleInstanced and a bundle handle's draw,
  // each asked for the src-only bar at t=1 (must be gone) with no override table named.
  const sInst=cnt(at(ctx,1,'instanced'), S_RECT), sHand=cnt(at(ctx,1,'handle'), S_RECT);
  rows.push({id:'C8 instanced', a:(sInst/Math.max(1,sFull)).toFixed(4), b:sInst+'/'+sFull,
             note:'drawBundleInstanced: want < 0.01', drew:at(ctx,1,'instanced').drew});
  rows.push({id:'C9 handle', a:(sHand/Math.max(1,sFull)).toFixed(4), b:sHand+'/'+sFull,
             note:'handle.draw(): want < 0.01', drew:at(ctx,1,'handle').drew});
  // C10: the handle FOLLOWS THE POSE -- the same handle drawn at each t must match drawBundle's frame
  // at that t byte for byte (a handle caches state; a morph's bundle changes every setT).
  const c10=[];
  for(const t of [0,0.5,1,0]) c10.push(bytesDiff(at(ctx,t,'handle').px, at(ctx,t,'implicit').px));
  rows.push({id:'C10 handle=draw', a:c10.join(' / '), b:'t=0 / 0.5 / 1 / 0', note:'want 0 0 0 0', drew:'-'});

  // C2: the implicit table IS the explicit one — whole frames, not counts.
  const c2=[];
  for(const t of [0,0.5,1]) c2.push(bytesDiff(at(ctx,t,'implicit').px, at(ctx,t,'explicit').px));
  rows.push({id:'C2 identical', a:c2.join(' / '), b:'t=0 / 0.5 / 1', note:'want 0 0 0',
             drew:at(ctx,1,'explicit').drew});

  // C5: the floor.
  rows.push({id:'C5 A/A', a:String(bytesDiff(at(ctx,1,'implicit').px, at(ctx,1,'implicit').px)),
             b:'bytes', note:'the harness floor', drew:at(ctx,1,'implicit').drew});

  // C7: what the morph actually wrote. 24 floats/shape, float 6 is visibility (renderer.js:2056).
  const vis=(tt)=>{ctx.m.setT(tt);const O=ctx.m.overrides,B=O&&O.packedBuffer;
    if(!B)return 'no packedBuffer';
    const n=Math.min(O.numShapes|0, (B.length/24)|0);const a=[];
    for(let i=0;i<n;i++)a.push(B[i*24+6].toFixed(2));return a.join(',');};
  const P=ctx.m.plan||{};
  rows.push({id:'C7 table', a:'t0=['+vis(0)+']', b:'t1=['+vis(1)+']',
             note:'plan m='+((P.matched||[]).length)+' s='+((P.srcOnly||[]).length)
                  +' d='+((P.dstOnly||[]).length)+' — reported, not predicted', drew:'-'});
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
console.log('\n  row            value                      counts                  note');
for (const r of rows) {
  console.log(
    '  ' +
      String(r.id).padEnd(14) +
      String(r.a).padEnd(26) +
      String(r.b).padEnd(23) +
      ' ' +
      r.note +
      '   ' +
      r.drew,
  );
}
console.log('\n  C1 must be < 0.01, C3 > 0.99, C4 < 0.01 then > 0.99, C2 all zero, C5 zero.');
console.log(
  '  Every row draws the SAME morph handle at the SAME t; only the spelling of opts changes.',
);
console.log(
  '  A draw that drops the fade reads ~1.00 on C1 and C4-implicit and a nonzero C2 at every t.',
);
