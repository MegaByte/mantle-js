// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchStaticInk — CPatch static correctness against Slug, per family and segment count.
//
// WHAT this ESTABLISHED about CPatch's remaining structural failures:
//
//   The REGION is right. With MANTLE_CPATCH_HARD -- the kernel's own flag for this question,
//   coverage replaced by a hard step -- cubic-16 goes from 8619 structural pixels to 0 and
//   cubic-64 from 75731 to 73. The decomposition tiles the shape correctly.
//
//   The RAMP loses the ink, in one direction and by one amount: every structural pixel is
//   DARKER than Slug (8619 of 8619, no exceptions) by a signed mean of -47 against a fill whose
//   channel mean is 94.7. That is coverage 0.5 == clamp(0.5 + f/|grad f|) at f = 0: pixels lying
//   ON a bounding curve's zero set INSIDE the patch. A cubic's implicit has branches away from
//   its drawn arc, and where one sweeps through the patch it paints a half-covered REGION rather
//   than a line -- which is why the blob/thin split tracks the degree (line 2259 thin, quad
//   13938 thin, cubic 75731 blob).
//
//   It is NOT the grid cell split: GRID=1 gives the same counts to within 20 pixels.
//
// The fix belongs in the kernel -- the AA ramp should apply near a curve's own ARC and be a hard
// step elsewhere, since what bounds the patch is the half-space and not every branch of the
// implicit. isCut already draws that distinction for seams; real curves need it away from their
// arcs, which needs arc extent in the fragment shader.
//
// REJECTED, measured: a converter-side clipMargin requiring bounding curves to clear the patch
// interior. No setting works -- 0.05 changes nothing, 0.15+ makes CPatch decline every shape
// (built=0), which paints correctly only by not being CPatch.
//
// TRAP: MANTLE_CPATCH_RAMP=1 is arithmetically identical to the default and appears to fix
// everything, because the define makes the variant fall back to Slug and the arm then reports
// Slug's own ink as a perfect match. An arm whose ink equals the reference exactly should be
// suspected of not running.
//
// _balanceBench found CPatch rendering a 16-segment polygon as 217 ink pixels against Slug's
// 36452 -- blank -- and smaller structural deficits on cubics. This isolates both: same shapes,
// ink compared directly, and what the bundle built, so a decline is distinguishable from a
// wrong draw.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 384);
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
function pathFor(family, cx, cy, r, n) {
  const pts = Array.from({ length: n }, (_, i) =>
    polar(cx, cy, r, -Math.PI / 2 + (i * Math.PI * 2) / n),
  );
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n,
      b = a + (Math.PI * 2) / n,
      p = pts[(i + 1) % n];
    if (family === 'line') d += ` L${p[0]} ${p[1]}`;
    else if (family === 'arc') d += ` A${r} ${r} 0 0 1 ${p[0]} ${p[1]}`;
    else if (family === 'quad') {
      const cr = r / Math.cos((b - a) / 2),
        c = polar(cx, cy, cr, (a + b) / 2);
      d += ` Q${c[0]} ${c[1]} ${p[0]} ${p[1]}`;
    } else {
      const k = (4 / 3) * Math.tan((b - a) / 4) * r,
        p0 = pts[i];
      d += ` C${p0[0] - Math.sin(a) * k} ${p0[1] + Math.cos(a) * k} ${p[0] + Math.sin(b) * k} ${p[1] - Math.cos(b) * k} ${p[0]} ${p[1]}`;
    }
  }
  return d + ' Z';
}
const svg = (fam, n, shapes) => {
  const side = Math.ceil(Math.sqrt(shapes)),
    cell = 120 / side;
  let body = '';
  for (let i = 0; i < shapes; i++) {
    const cx = ((i % side) + 0.5) * cell + 4,
      cy = (((i / side) | 0) + 0.5) * cell + 4;
    body += `<path d="${pathFor(fam, cx, cy, cell * 0.38, n)}" fill="#265b9b"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
};
const CASES = [];
for (const fam of ['line', 'quad', 'cubic', 'arc'])
  for (const n of [4, 8, 16, 32, 64]) CASES.push({ fam, n, shapes: 1 });
for (const fam of ['line', 'cubic'])
  for (const shapes of [16, 32]) CASES.push({ fam, n: 16, shapes });

const HTML = `<!doctype html><html><body><script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const GRIDN=${+(process.env.GRID || 1)};   // 1 = what ships; GRID=4 to exercise the cell split
const TOLPX=${+(process.env.TOLPX || 0)};
const DEFS=${JSON.stringify(process.env.DEFS ? process.env.DEFS.split(',') : null)};
// SEAMW: the seam-edge cover reach as a fraction of the outline reach (cpatchPack's SEAM_W).
if (${JSON.stringify(process.env.SEAMW || '')} !== '') globalThis.__MANTLE_DEBUG__ = true;   // __CP_SEAM_W is a test hook, read only under it
if (${JSON.stringify(process.env.SEAMW || '')} !== '') globalThis.__CP_SEAM_W = +${JSON.stringify(process.env.SEAMW || '1')};
const N=${N}, CASES=${JSON.stringify(CASES)}, SVGS=${JSON.stringify(CASES.map((c) => svg(c.fam, c.n, c.shapes)))};
const mk=()=>{const c=document.createElement('canvas');c.width=N;c.height=N;document.body.appendChild(c);
  return c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});};
const arms={};
for(const [name,opts,mode] of [['slug',{},'off'],['cpatch',{cpatchFill:true,cpatchOpts:{grid:GRIDN,...(TOLPX?{tolPx:TOLPX}:{})},...(DEFS?{fillDefines:DEFS}:{})},'on']]){
  const gl=mk();const r=createRenderer(gl,shaders,{...opts,precompileFillsBudgetMs:5000});await r.ready;
  r.setViewport(N,N);r.setLoopBlinnFill(mode);arms[name]={gl,r};
}
const ink=(gl)=>{const p=new Uint8Array(N*N*4);gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
  let n=0;for(let i=0;i<p.length;i+=4)if(p[i]>8||p[i+1]>8||p[i+2]>8)n++;return n;};
window.__run=async()=>{
  const out=[];
  // MORPH FIRST. The balance bench renders a CPatch morph before its static cases and the first
  // static case then comes back blank (ink 217 against 36452); the same cases run alone are
  // correct. If that survives here it is renderer state crossing from a morph to the next
  // static bundle, not anything about the shapes.
  if (${JSON.stringify(process.env.MORPHFIRST === '1')}) {
    const {gl,r}=arms.cpatch;
    const A=SVGS[2], B=SVGS[3];
    const m=createShapeMorph(gl,createBundle(gl,await importSvg(A,{occupancyGrid:true,gwnTree:true})),
                                createBundle(gl,await importSvg(B,{occupancyGrid:true,gwnTree:true})));
    const mb=m.bundle||m;
    for (const t of [0.2,0.5,0.8]) { m.setT(t); if(r.prepareBundle){try{r.prepareBundle(mb);}catch{}}
      for(let k=0;k<600&&mb._cpatchMorphPlan==='pending';k++) await new Promise(z=>setTimeout(z,5));
      r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame(); }
  }
  for(let i=0;i<CASES.length;i++){
    const row={...CASES[i]};
    for(const name of ['slug','cpatch']){
      const {gl,r}=arms[name];
      const b=createBundle(gl,await importSvg(SVGS[i],{occupancyGrid:true,gwnTree:true}));
      if(r.prepareBundle){try{r.prepareBundle(b);}catch{}}
      for(let k=0;k<600&&b._cpatchConv==='pending';k++) await new Promise(z=>setTimeout(z,5));
      if(r.prepareBundle){try{r.prepareBundle(b);}catch{}}
      r.beginFrame([0,0,0,1]);r.drawBundle(b,{});r.endFrame();
      row[name]=ink(gl);
      row['px_'+name]=(()=>{const q=new Uint8Array(N*N*4);gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,q);return q;})();
      if(name==='cpatch'){row.built=b._cpatchBuilt|0;row.drop=b._cpatchDropped|0;row.unres=b._cpatchUnresolved|0;row.cells=b._cpatchCells|0;}
      b.dispose();
    }
    // CHARACTERISE THE DISAGREEMENT. Slug's own colour steps mark the AA band (dilated 2px);
    // outside it a >24/255 difference is structural. Whether those pixels form THIN LINES or
    // BLOBS is what separates a seam between patches from a shading error over an area.
    {
      const R=row.px_slug, G=row.px_cpatch, M=new Uint8Array(N*N), E=new Uint8Array(N*N);
      const d4=(a,b)=>Math.max(Math.abs(R[a]-R[b]),Math.abs(R[a+1]-R[b+1]),Math.abs(R[a+2]-R[b+2]),Math.abs(R[a+3]-R[b+3]));
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=y*N+x,p=i*4;
        if(x+1<N&&d4(p,p+4)>6)M[i]=1; if(y+1<N&&d4(p,p+N*4)>6)M[i]=1;}
      for(let y=0;y<N;y++)for(let x=0;x<N;x++) if(M[y*N+x])
        for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const xx=x+dx,yy=y+dy;
          if(xx>=0&&yy>=0&&xx<N&&yy<N)E[yy*N+xx]=1;}
      const S=new Uint8Array(N*N); let st=0,sum=0;
      for(let i=0;i<N*N;i++){const p=i*4;
        const d=Math.max(Math.abs(R[p]-G[p]),Math.abs(R[p+1]-G[p+1]),Math.abs(R[p+2]-G[p+2]),Math.abs(R[p+3]-G[p+3]));
        if(!E[i]&&d>24){S[i]=1;st++;sum+=d;}}
      let thin=0,blob=0;
      for(let y=1;y<N-1;y++)for(let x=1;x<N-1;x++){const i=y*N+x;if(!S[i])continue;
        const n=S[i-1]+S[i+1]+S[i-N]+S[i+N]; if(n<=2)thin++;else blob++;}
      // SIGN of the disagreement on structural pixels: is CPatch painting LESS than Slug
      // (partial coverage where Slug is solid) or MORE? Coverage totals match, so the answer
      // decides between "wrong alpha over an area" and "wrong shape".
      let darker=0, lighter=0, sSum=0;
      for(let i=0;i<N*N;i++){ if(!S[i]) continue; const p=i*4;
        const dv=(G[p]+G[p+1]+G[p+2])-(R[p]+R[p+1]+R[p+2]);
        sSum+=dv; if(dv<0)darker++; else lighter++; }
      row.structural=st; row.meanDiff=st?+(sum/st).toFixed(1):0; row.thin=thin; row.blob=blob;
      row.darker=darker; row.lighter=lighter; row.meanSigned=st?+(sSum/st/3).toFixed(1):0;
    }
    delete row.px_slug; delete row.px_cpatch;
    out.push(row);
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
await pg.waitForFunction(() => window.__ready === 1, { timeout: 180000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log('\n  family  segs  shapes |     slug |   cpatch |  ratio | built  cells | structural');
let bad = 0;
for (const r of rows) {
  const ratio = r.cpatch / Math.max(r.slug, 1);
  const flag = ratio < 0.97 || ratio > 1.03 ? '  <-- OFF' : '';
  if (flag) bad++;
  console.log(
    '  ' +
      r.fam.padEnd(7) +
      String(r.n).padStart(4) +
      String(r.shapes).padStart(8) +
      ' | ' +
      String(r.slug).padStart(8) +
      ' | ' +
      String(r.cpatch).padStart(8) +
      ' | ' +
      ratio.toFixed(3).padStart(6) +
      ' | ' +
      String(r.built).padStart(5) +
      String(r.cells).padStart(6) +
      ' | struct ' +
      String(r.structural).padStart(6) +
      ' mean ' +
      String(r.meanDiff).padStart(5) +
      ' thin ' +
      String(r.thin).padStart(6) +
      ' blob ' +
      String(r.blob).padStart(6) +
      ' | darker ' +
      String(r.darker).padStart(6) +
      ' lighter ' +
      String(r.lighter).padStart(6) +
      ' signed ' +
      String(r.meanSigned).padStart(7) +
      flag,
  );
}
console.log('\n  ' + bad + ' of ' + rows.length + ' cases off by more than 3%');
