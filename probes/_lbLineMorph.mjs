// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbLineMorph — LB under-fills a LINE morph by a third. What is the mesh doing?
//
// _balanceBench reports 6747 structural pixels and 14054 ink against Slug's 21348 on an
// 8-segment polygon morphing between two poses (radius .40 -> .26, ring rotated .55 rad). Static
// polygons are fine and curve morphs are fine, so this is specific to lines under a moving pose.
//
// Reports ink against Slug across t, plus what the LB bundle is actually carrying, so "fragmented"
// becomes a measurement: a mesh that is fine at t=0 and falls apart in the middle is a lerp
// problem, one that is wrong everywhere is a build problem.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 384);
const SEGS = +(process.env.SEGS || 8);
const FAM = process.env.FAM || 'line';
const ROT = process.env.ROT === undefined ? 0.55 : +process.env.ROT;
const RB = process.env.RB === undefined ? 0.26 : +process.env.RB;

const poly = (r, rot, family) => {
  const cx = 64,
    cy = 64,
    R = (46 * r) / 0.4;
  const n = Math.max(family === 'line' ? 3 : 4, SEGS);
  const P = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + rot + (i * Math.PI * 2) / n;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  let d = `M${P[0][0]} ${P[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p = P[(i + 1) % n];
    if (family === 'line') d += ` L${p[0]} ${p[1]}`;
    else {
      const a = -Math.PI / 2 + rot + (i * Math.PI * 2) / n,
        b = a + (Math.PI * 2) / n;
      const k = (4 / 3) * Math.tan((b - a) / 4) * R,
        p0 = P[i];
      d += ` C${p0[0] - Math.sin(a) * k} ${p0[1] + Math.cos(a) * k} ${p[0] + Math.sin(b) * k} ${p[1] - Math.cos(b) * k} ${p[0]} ${p[1]}`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="${d} Z" fill="#265b9b"/></svg>`;
};

const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const N=${N};
const A=${JSON.stringify(poly(0.4, 0, FAM))}, B=${JSON.stringify(poly(RB, ROT, FAM))};
const mk=(mode)=>{const c=document.createElement('canvas');c.width=N;c.height=N;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});return {gl,c,mode};};
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const arms={};   // module scope: __shot re-renders from these after __run
window.__run=async()=>{
  const out=[];
  for (const [name,mode,opts] of [['slug','off',{}],['lb','on',{}]]) {
    const {gl}=mk(mode);
    const r=createRenderer(gl,shaders,{...opts,precompileFillsBudgetMs:5000}); await r.ready;
    r.setViewport(N,N); r.setLoopBlinnFill(mode);
    const m=createShapeMorph(gl,createBundle(gl,await importSvg(A)),createBundle(gl,await importSvg(B)));
    const b=m.bundle||m;
    m.setT(0.5); r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame();
    if (r.awaitLbReady) { try { await r.awaitLbReady(b,20000); } catch {} }
    r.precompileFills();
    arms[name]={gl,r,m,b};
  }
  const ink=(gl)=>{const p=new Uint8Array(N*N*4);gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    let n=0;for(let i=0;i<p.length;i+=4)if(p[i]>8||p[i+1]>8||p[i+2]>8)n++;return n;};
  for (const t of [0,0.1,0.25,0.4,0.5,0.6,0.75,0.9,1]) {
    const row={t};
    for (const name of ['slug','lb']) {
      const {gl,r,m,b}=arms[name];
      m.setT(t); if(r.prepareBundle){try{r.prepareBundle(b);}catch{}}
      r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame();
      row[name]=ink(gl);
      if(name==='lb'){
        const lbm=b._lbMeshes||[];
        row.meshes=lbm.filter(Boolean).length;
        row.verts=lbm.reduce((a,x)=>a+(x&&!x.slug?(x.vertexCount|0):0),0);
        row.slugSentinels=lbm.filter(x=>x&&x.slug).length;
        row.classic=r.debugStats.loopBlinnClassicRouteCount|0;
        row.lbmorph=r.debugStats.loopBlinnMorphRouteCount|0;
        row.uni=r.debugStats.unifiedFillDraws|0;
        row.gate=r._unifiedFillGate||'-';
      }
    }
    out.push(row);
  }
  return out;
};
// WHERE the missing ink is, which is what tells a FRAGMENTED mesh from a SHRUNKEN one. A pixel
// Slug painted and LB did not is classified by whether Slug painted all four of its neighbours:
// interior misses are holes/stripes through the shape (fragmentation), rim misses are the shape
// being smaller (a lerp that shortcuts).
window.__where=(t)=>{
  const px={};
  for(const name of ['slug','lb']){ const {gl,r,m,b}=arms[name];
    m.setT(t); if(r.prepareBundle){try{r.prepareBundle(b);}catch{}}
    r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const m8=new Uint8Array(N*N); for(let i=0;i<N*N;i++) m8[i]=(p[i*4]>8||p[i*4+1]>8||p[i*4+2]>8)?1:0;
    px[name]=m8; }
  const S=px.slug, L=px.lb; let interior=0, rim=0, extra=0;
  for(let y=1;y<N-1;y++) for(let x=1;x<N-1;x++){ const i=y*N+x;
    if(S[i]&&!L[i]){ const deep=S[i-1]&&S[i+1]&&S[i-N]&&S[i+N]; if(deep) interior++; else rim++; }
    else if(!S[i]&&L[i]) extra++; }
  let sink=0; for(let i=0;i<N*N;i++) sink+=S[i];
  return {interior, rim, extra, slugInk:sink};
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
const where = await pg.evaluate(() => window.__where(0.5));
await br.close();
server.close();
console.log(`\n  ${FAM} morph, ${SEGS} segments, ${N}x${N}, poseB r=${RB} rot=${ROT}\n`);
console.log('     t |     slug |       lb |  ratio | meshes verts sentinels | uni classic gate');
console.log('\n  at t=0.5, of Slug ink ' + where.slugInk + ':');
console.log('    missing INTERIOR (holes/stripes => fragmented) : ' + where.interior);
console.log('    missing RIM      (smaller shape => lerp shortcut): ' + where.rim);
console.log('    painted where Slug did not                      : ' + where.extra);
for (const r of rows) {
  console.log(
    '  ' +
      r.t.toFixed(2).padStart(4) +
      ' | ' +
      String(r.slug).padStart(8) +
      ' | ' +
      String(r.lb).padStart(8) +
      ' | ' +
      (r.lb / Math.max(r.slug, 1)).toFixed(3).padStart(6) +
      ' | ' +
      String(r.meshes).padStart(6) +
      ' ' +
      String(r.verts).padStart(5) +
      ' ' +
      String(r.slugSentinels).padStart(9) +
      ' | ' +
      String(r.uni).padStart(3) +
      ' ' +
      String(r.classic).padStart(7) +
      ' lbMorphRoute=' +
      String(r.lbmorph).padStart(3),
  );
}
