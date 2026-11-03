// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchCoverCrack — the diagonal of unpainted pixels running out of a patch junction.
//
// _balanceBench found CPatch losing pixels the reference calls solid, with ZERO partial-coverage
// pixels anywhere near them -- a gap, not a ramp. Rendered here and mapped, they are a perfect
// one-pixel diagonal: (256,256), (257,257) ... (309,309) on a 512x512 render, running out of the
// exact point where the patch cuts converge.
//
// THE COVER POLYGON IS THE CAUSE. It is exact, and two patches sharing a cut derive that shared
// edge separately; where those disagree in the last bits, pixels along the seam fall in neither
// polygon and are never shaded. Growing each cover by 1% of its own size closes it -- 54 wrong
// pixels to 0 -- and cannot over-fill, because the cover only decides which fragments are
// GENERATED and every one is still tested against the patch's implicits and cut half-spaces.
//
// Ruled out first, each measured: the cut inclusion width, the cell grid, the arc-box gate, the
// depth claim, and any geometric hole (the converter's own union covers 40000 samples around
// that center with zero misses).
//
// The knobs (PRIOR, CTX, REP, TOGGLE, OCC, DEFS) exist because a benchmark can report this
// case as failing while this probe renders it perfectly, and they are the differences between
// the two to test one at a time: shared renderer, exact predecessor bundles, bundle disposal, warm-up
// frames, the LB-fill toggle, occlusionCull, live-context pressure, and kernel defines.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
const FAM = process.env.FAM || 'quad',
  n = +(process.env.SEGS || 16),
  SHAPES = +(process.env.SHAPES || 1);
const side = Math.ceil(Math.sqrt(SHAPES)),
  cell = 120 / side;
let body = '';
for (let k = 0; k < SHAPES; k++) {
  const cx = ((k % side) + 0.5) * cell + 4,
    cy = (((k / side) | 0) + 0.5) * cell + 4,
    r = cell * 0.38;
  const pts = Array.from({ length: n }, (_, i) =>
    polar(cx, cy, r, -Math.PI / 2 + (i * Math.PI * 2) / n),
  );
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n,
      b = a + (Math.PI * 2) / n,
      p = pts[(i + 1) % n];
    if (FAM === 'line') d += ` L${p[0]} ${p[1]}`;
    else if (FAM === 'arc') d += ` A${r} ${r} 0 0 1 ${p[0]} ${p[1]}`;
    else if (FAM === 'quad') {
      const cr = r / Math.cos((b - a) / 2),
        c = polar(cx, cy, cr, (a + b) / 2);
      d += ` Q${c[0]} ${c[1]} ${p[0]} ${p[1]}`;
    } else {
      const kk = (4 / 3) * Math.tan((b - a) / 4) * r,
        p0 = pts[i];
      d += ` C${p0[0] - Math.sin(a) * kk} ${p0[1] + Math.cos(a) * kk} ${p[0] + Math.sin(b) * kk} ${p[1] - Math.cos(b) * kk} ${p[0]} ${p[1]}`;
    }
  }
  body += `<path d="${d} Z" fill="#265b9b"/>`;
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const HTML = `<!doctype html><html><body><script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const OCC=${JSON.stringify(process.env.OCC === '1')};
const DEFS=${JSON.stringify(process.env.DEFS ? process.env.DEFS.split(',') : null)};
const N=${N}, SVG=${JSON.stringify(SVG)};
const polar2=(cx,cy,r,a)=>[cx+r*Math.cos(a),cy+r*Math.sin(a)];
const mk=(sz)=>{const c=document.createElement('canvas');c.width=sz;c.height=sz;document.body.appendChild(c);
  return c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});};
// ONE RENDERER, REUSED, which is how the benchmark drives it -- and the only structural
// difference left between this probe (clean) and the benchmark (54 wrong on the same shape).
const _cache={};
const draw=async(sz,opts,mode,svgOverride,wantBundle)=>{
  const key=sz+'|'+JSON.stringify(opts)+'|'+mode;
  let ent=_cache[key];
  if(!ent){ const gl=mk(sz); const r=createRenderer(gl,shaders,{...opts,precompileFillsBudgetMs:5000}); await r.ready;
    r.setViewport(sz,sz); r.setLoopBlinnFill(mode); ent=_cache[key]={gl,r}; }
  const {gl,r}=ent;
  const b=createBundle(gl,await importSvg(svgOverride||SVG,{occupancyGrid:true,gwnTree:true,occlusionCull:OCC}));
  if(r.prepareBundle) r.prepareBundle(b);
  for(let i=0;i<600&&b._cpatchConv==='pending';i++) await new Promise(z=>setTimeout(z,5));
  if(r.prepareBundle) r.prepareBundle(b);
  if(r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
  r.precompileFills();
  const cov={worldMatrix:[Math.sqrt(0.72),0,0,0,Math.sqrt(0.72),0,0,0,1]};
  // The benchmark captures after a dozen warm-up frames, not after one.
  // The benchmark's configure() sets EVERY renderer's LB fill to 'off' and the active one back
  // to its mode before each draw. If that toggle invalidates anything, it shows here.
  if(${JSON.stringify(process.env.TOGGLE === '1')}){ r.setLoopBlinnFill('off'); r.setLoopBlinnFill(mode); }
  const REP=${+(process.env.REP || 1)};
  // DID CPATCH ACTUALLY DRAW? Everything below compares pixels, and pixels cannot tell you which
  // engine produced them -- so a CPatch arm that silently fell back to Slug reads as a CPatch
  // result. That is not hypothetical: a duplicate declaration in the coverage kernel made the
  // MANTLE_CPATCH variant fail to COMPILE, every frame fell back, and this probe reported the
  // fallback's antialiasing as a four-fold improvement in CPatch's. Route counters are the only
  // witness, so read them across the draws and refuse to return pixels that CPatch did not paint.
  const d0=r.debugStats, c0=d0.loopBlinnRouteCount|0, w0=d0.unifiedWarmFallbacks|0;
  for(let i=0;i<REP;i++){ r.beginFrame([.137,.173,.211,1]); r.drawBundle(b,cov); r.endFrame(); }
  const route=(r.debugStats.loopBlinnRouteCount|0)-c0, warmFb=(r.debugStats.unifiedWarmFallbacks|0)-w0;
  if(opts.cpatchFill===true && !wantBundle && (!route || warmFb))
    throw new Error('CPatch did NOT draw: route='+route+' warmFallbacks='+warmFb
      +' built='+(b._cpatchBuilt|0)+' conv='+(b._cpatchConv===undefined?'undef':b._cpatchConv));
  const p=new Uint8Array(sz*sz*4); gl.readPixels(0,0,sz,sz,gl.RGBA,gl.UNSIGNED_BYTE,p); return wantBundle?b:p;
};
window.__run=async()=>{
  const SS=4;
  // THE BENCHMARK KEEPS 10+ LIVE WEBGL CONTEXTS in one page (one per engine arm, plus a 2048px
  // reference). Browsers cap live contexts and evict the oldest; an evicted context renders
  // garbage or nothing. This is the last structural difference between the two harnesses.
  if (${JSON.stringify(process.env.CTX === '1')}) {
    for (let i = 0; i < 9; i++) mk(i === 0 ? N * SS : N);
  }
  // PRIOR BUNDLE IN THE SAME CONTEXT. The benchmark draws many cases through one renderer and
  // still loses this diagonal after the cover fix; drawn alone it does not. If that is state
  // crossing between bundles it will show here.
  // Draw OTHER shapes through that same renderer first, as the benchmark's earlier cases do.
  if (${JSON.stringify(process.env.PRIOR === '1')}) {
    // EXACTLY the cases the benchmark draws before this one: line polygons at 1, 16 and 128
    // shapes. The 128-shape bundle is far larger and is the one that would force the shared
    // unified-fill VBO to grow.
    for (const shapes of [1, 16, 128]) {
      const sd=Math.ceil(Math.sqrt(shapes)), cl=120/sd; let body='';
      for(let k=0;k<shapes;k++){
        const bx=(k%sd+.5)*cl+4, by=((k/sd|0)+.5)*cl+4, br=cl*.38;
        const pp=Array.from({length:16},(_,i)=>polar2(bx,by,br,-Math.PI/2+i*Math.PI*2/16));
        let dd='M'+pp[0][0]+' '+pp[0][1];
        for(let i=0;i<16;i++){const q=pp[(i+1)%16]; dd+=' L'+q[0]+' '+q[1];}
        body+='<path d="'+dd+' Z" fill="#265b9b"/>';
      }
      const pb = await draw(N,{cpatchFill:true},'on','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'+body+'</svg>', true);
      if (pb && pb.dispose) pb.dispose();   // the benchmark disposes every bundle after its case
    }
  }
  const ref=await draw(N*SS,{},'off');
  const gb=await draw(N,{cpatchFill:true,...(DEFS?{fillDefines:DEFS}:{})},'on',null,true);
  const cpCells=gb._cpatchCells|0, cpBuilt=gb._cpatchBuilt|0, cpPatches=gb._cpatchPatches|0;
  if(gb.dispose) gb.dispose();
  const got=await draw(N,{cpatchFill:true,...(DEFS?{fillDefines:DEFS}:{})},'on');
  const CLEAR=[35,44,54], F=[38,91,155];
  const cov1=(px,i)=>{const dx=px[i]-CLEAR[0],dy=px[i+1]-CLEAR[1],dz=px[i+2]-CLEAR[2];
    const fx=F[0]-CLEAR[0],fy=F[1]-CLEAR[1],fz=F[2]-CLEAR[2];const d2=fx*fx+fy*fy+fz*fz;
    return Math.max(0,Math.min(1,(dx*fx+dy*fy+dz*fz)/d2));};
  const wrong=[];
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){
    let a=0; for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++) a+=cov1(ref,((y*SS+sy)*N*SS+(x*SS+sx))*4);
    const c=a/(SS*SS), g=cov1(got,(y*N+x)*4);
    if((c>=1&&g<0.5)||(c<=0&&g>0.5)) wrong.push([x,y,+c.toFixed(3),+g.toFixed(3)]);
  }
  // Signed AA error on EDGE pixels: bias says a fixable model term, symmetric says noise.
  let aaN=0,aaSum=0,aaAbs=0,over=0,under=0;
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){
    let a=0; for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++) a+=cov1(ref,((y*SS+sy)*N*SS+(x*SS+sx))*4);
    const c=a/(SS*SS); if(c<=0||c>=1) continue;
    const g=cov1(got,(y*N+x)*4), d=g-c;
    aaN++; aaSum+=d; aaAbs+=Math.abs(d); if(d>0)over++; else under++;
  }
  const inkOf=(px,sz)=>{let n=0;for(let i=0;i<sz*sz;i++){const p=i*4;
    if(Math.max(Math.abs(px[p]-35),Math.abs(px[p+1]-44),Math.abs(px[p+2]-54))>2)n++;}return n;};
  return {wrong, cpCells, cpBuilt, cpPatches, aaN, aaSigned:aaSum/Math.max(aaN,1), aaAbs:aaAbs/Math.max(aaN,1), over, under, gotInk:inkOf(got,N), refInk:Math.round(inkOf(ref,N*SS)/(SS*SS))};
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
await pg.waitForFunction(() => window.__ready === 1, { timeout: 180000, polling: 50 });
const R = await pg.evaluate(() => window.__run());
const w = R.wrong;
await br.close();
server.close();
console.log(
  '\n  cells ' +
    R.cpCells +
    ' shapes ' +
    R.cpBuilt +
    '   wrong ' +
    w.length +
    '   edgePx ' +
    R.aaN +
    '   |err| ' +
    R.aaAbs.toFixed(4) +
    '   signed ' +
    (R.aaSigned >= 0 ? '+' : '') +
    R.aaSigned.toFixed(4) +
    '   over ' +
    R.over +
    ' / under ' +
    R.under,
);
if (w.length) {
  const xs = w.map((a) => a[0]),
    ys = w.map((a) => a[1]);
  console.log(
    '  bbox x[' +
      Math.min(...xs) +
      ',' +
      Math.max(...xs) +
      ']  y[' +
      Math.min(...ys) +
      ',' +
      Math.max(...ys) +
      ']   canvas ' +
      N,
  );
  console.log('  samples (x,y,refCov,gotCov):');
  for (const a of w.slice(0, 12)) console.log('     ' + a.join(', '));
}
