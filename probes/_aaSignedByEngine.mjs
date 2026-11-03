// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aaSignedByEngine — does any engine have the one-sided AA defects signed error exposes?
//
// Two coverage defects show the same way, and neither is visible in the absolute error:
//
//   a cover too tight to hold its own AA ramp   -> coverage DELETED on boundary pixels
//   a constraint that lowers coverage off-arc   -> coverage DELETED on boundary pixels
//
// Absolute mean error rises and falls with them, but what NAMES them is that the error is
// ONE-SIDED (an arc mean of 0.1020 of which -0.0994 is signed, far more pixels under than over). A
// symmetric error is antialiasing differing from the reference; a one-sided one is coverage going
// missing, and only the sign separates them.
//
// So this runs that same decomposition across every engine. Per engine per family: mean |error|,
// mean SIGNED error, the under/over split, and whether the differing pixels sit on the silhouette
// or in the interior. A one-sided deficit on any engine is the same defect class.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 256),
  SS = 4,
  SEGS = +(process.env.SEGS || 16);
const HTML = `<!doctype html><html><body><script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// The mesh builds in a WORKER, which never sees a flag set here — an earlier A/B compared two
// identical runs because of it. Suppressing Worker forces the synchronous main-thread build, where
// the flag applies. Done in BOTH arms so the band is the only variable.
globalThis.Worker = undefined;
if (${JSON.stringify(process.env.NO_FASTPATH === '1')}) globalThis.__LB_NO_FASTPATH = true;
if (${JSON.stringify(process.env.AUDIT_OFF === '1')}) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__lbAuditOff = true; }
if (${JSON.stringify(process.env.NO_BAND12 === '1')}) globalThis.__LB_NO_BAND12 = true;
const N=${N}, SS=${SS}, SEGS=${SEGS};
const poly=(cx,cy,r,n,kind)=>{
  const P=[]; for(let i=0;i<n;i++){const a=-Math.PI/2+i*2*Math.PI/n; P.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(4)+' '+P[0][1].toFixed(4);
  for(let i=0;i<n;i++){
    const q=P[(i+1)%n], p=P[i], mx=(p[0]+q[0])/2, my=(p[1]+q[1])/2;
    const bx=cx+(mx-cx)*1.18, by=cy+(my-cy)*1.18;
    if(kind==='line') d+=' L'+q[0].toFixed(4)+' '+q[1].toFixed(4);
    else if(kind==='quad') d+=' Q'+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);
    else if(kind==='cubic'){
      // TWO DISTINCT control points. The same point twice is a cubic only on
      // paper — coincident middle controls are a degree-elevated QUADRATIC, and measuring the
      // cubic path with one says nothing about real cubics.
      const c1x=p[0]+(bx-p[0])*1.35, c1y=p[1]+(by-p[1])*1.35;
      const c2x=q[0]+(bx-q[0])*1.35, c2y=q[1]+(by-q[1])*1.35;
      d+=' C'+c1x.toFixed(4)+' '+c1y.toFixed(4)+' '+c2x.toFixed(4)+' '+c2y.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);
    }
    else if(kind==='cubicDegen') d+=' C'+bx.toFixed(4)+' '+by.toFixed(4)+' '+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);
    else d+=' A'+(r*1.05).toFixed(4)+' '+(r*1.05).toFixed(4)+' 0 0 1 '+q[0].toFixed(4)+' '+q[1].toFixed(4);
  }
  return d+' Z';
};
const svgOf=(kind)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="'
  +poly(64,64,44,SEGS,kind)+'" fill="#265b9b"/></svg>';
const CLEAR=[35,44,54], FILL=[38,91,155];
const cov1=(px,i)=>{const dx=px[i]-CLEAR[0],dy=px[i+1]-CLEAR[1],dz=px[i+2]-CLEAR[2];
  const fx=FILL[0]-CLEAR[0],fy=FILL[1]-CLEAR[1],fz=FILL[2]-CLEAR[2];const d2=fx*fx+fy*fy+fz*fz;
  return Math.max(0,Math.min(1,(dx*fx+dy*fy+dz*fz)/d2));};
const shot=async(svg,sz,sel)=>{
  const c=document.createElement('canvas');c.width=sz;c.height=sz;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
  const _dfs=${JSON.stringify(process.env.LBDEFS ? process.env.LBDEFS.split(',') : null)};
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000,...(_dfs?{fillDefines:_dfs}:{})}); await r.ready;
  r.setViewport(sz,sz); r.setFillEngine(sel);
  const b=createBundle(gl,await importSvg(svg,{}));
  if(r.awaitEngine) await r.awaitEngine(b, sel.route==='none'?(sel.kernel==='aac'?'aac':'slug'):sel.route, 30000);
  for(let i=0;i<3;i++){ r.beginFrame([CLEAR[0]/255,CLEAR[1]/255,CLEAR[2]/255,1]); r.drawBundle(b,{}); r.endFrame(); }
  const px=new Uint8Array(sz*sz*4); gl.readPixels(0,0,sz,sz,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  // Count the LB vertex KINDS actually packed (stride 24, kind at slot 5) — the mesh's kindMask
  // is unset on these, and which kernel runs is the whole question.
  const kc={};
  for(const m of (b._lbMeshes||[])){
    const ms = m && m.segments ? m.segments : [m];
    for(const sg of ms){ if(!sg||!sg.verts) continue;
      for(let v=0;v<(sg.vertexCount|0);v++){ const k=sg.verts[v*24+5]|0; kc[k]=(kc[k]|0)+1; } } }
  return {px, gate:r.debugStats.unifiedFillGate||'?',
          kinds:Object.entries(kc).map(([k,v])=>k+':'+v).join(' ')||'-',
          drew:Object.entries(E.draws||{}).filter(([,v])=>v>0).map(([k])=>k).join('+')||'-'};
};
const ENGINES=[['slug',{route:'none',kernel:'slug'}],['aac',{route:'none',kernel:'aac'}],
               ['lb',{route:'lb',kernel:'slug'}],['cpatch',{route:'cpatch',kernel:'slug'}]];
window.__run=async()=>{
  const out=[];
  for (const kind of ['line','quad','cubic','cubicDegen','arc']) {
    const svg=svgOf(kind);
    const ref=(await shot(svg,N*SS,{route:'none',kernel:'slug'})).px;
    // 8x-supersampled reference coverage per output pixel
    const refCov=new Float32Array(N*N);
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      let a=0; for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++) a+=cov1(ref,((y*SS+sy)*N*SS+(x*SS+sx))*4);
      refCov[y*N+x]=a/(SS*SS);
    }
    for (const [name,sel] of ENGINES) {
      const g=await shot(svg,N,sel);
      let n=0,abs=0,sum=0,under=0,over=0,wrong=0,solid=0,soft=0,spill=0,hole=0; const solidR=[],solidRef=[],wr=[];
      for(let i=0;i<N*N;i++){
        const c=refCov[i], got=cov1(g.px,i*4);
        // WHOLE-WRONG pixels: where the reference is fully empty or fully solid, a disagreement is
        // not antialiasing — it is the wrong shape. That is the distinction between "this mesh
        // over-covers its edges" and "this mesh paints air", and only the second justifies a
        // decline to another engine.
        const yy0=(i/N)|0, xx0=i-yy0*N, rr0=Math.hypot(xx0-N/2, yy0-N/2);
        if(c<=0){ if(got>0.5){ wrong++; spill++; wr.push(rr0); } continue; }
        if(c>=1){ if(got<0.5){ wrong++; hole++; wr.push(rr0); } continue; }
        const d=got-c;
        n++; abs+=Math.abs(d); sum+=d; if(d<0) under++; else over++;
        // A SOLID fragment on a partial pixel is a different defect from a ramp that is too wide.
        // If the over-covered pixels are pinned at 1.0, some piece is painting the boundary solid
        // rather than antialiasing it; if they are spread, the coverage function is off.
        if(d>0.02){ if(got>0.985){ solid++;
            // WHERE the solid-over pixels sit, in the shape's own polar frame: a ring of them just
            // OUTSIDE the boundary means a piece paints past the curve; scattered means something else.
            const yy=(i/N)|0, xx=i-yy*N;
            const dx=xx-N/2, dy=yy-N/2, rr=Math.hypot(dx,dy);
            solidR.push(rr); solidRef.push(c);
          } else soft++; }
      }
      const mean=(a)=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
      const rMin=solidR.length?Math.min(...solidR):0, rMax=solidR.length?Math.max(...solidR):0;
      const wrMin=wr.length?Math.min(...wr):0, wrMax=wr.length?Math.max(...wr):0;
      out.push({kind, name, drew:g.drew, kinds:g.kinds, gate:g.gate, wrong, spill, hole,
                wrMin, wrMax, solid, soft,
                solidRmean:mean(solidR), solidRmin:rMin, solidRmax:rMax, solidRefMean:mean(solidRef), n, abs:abs/Math.max(n,1), signed:sum/Math.max(n,1), under, over});
    }
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
console.log(
  '\n  edge pixels only, vs an ' + SS * SS + 'x reference. signed << 0 = coverage being DELETED.',
);
console.log('\n  family  engine   drew        |err|    signed    under/over');
let flag = [];
for (const r of rows) {
  const oneSided = r.n > 50 && Math.abs(r.signed) > 0.6 * r.abs && r.abs > 0.02;
  console.log(
    '  ' +
      r.kind.padEnd(7) +
      r.name.padEnd(9) +
      r.drew.padEnd(12) +
      r.abs.toFixed(4).padStart(7) +
      (r.signed >= 0 ? '  +' : '  ') +
      r.signed.toFixed(4) +
      ('   ' + r.under + '/' + r.over).padStart(14) +
      '  over@1.0:' +
      String(r.solid).padStart(4) +
      (r.solid
        ? ' r=' +
          r.solidRmin.toFixed(0) +
          '..' +
          r.solidRmax.toFixed(0) +
          ' refCov~' +
          r.solidRefMean.toFixed(2)
        : '') +
      '  wrong:' +
      String(r.wrong).padStart(4) +
      (r.wrong
        ? '(hole ' +
          r.hole +
          ' spill ' +
          r.spill +
          ' r=' +
          r.wrMin.toFixed(0) +
          '..' +
          r.wrMax.toFixed(0) +
          ')'
        : '') +
      '  gate:' +
      (r.gate || '?') +
      '  kinds:' +
      (r.kinds || '-') +
      (oneSided ? '   <-- ONE-SIDED' : ''),
  );
  if (oneSided) flag.push(r.kind + '/' + r.name);
}
console.log(
  '\n  ' +
    (flag.length ? 'ONE-SIDED DEFICIT: ' + flag.join(', ') : 'no engine shows a one-sided deficit'),
);
