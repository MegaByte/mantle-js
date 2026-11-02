// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _meshConformity — audit the LB mesh for T-JUNCTIONS.
//
// earcut emits non-conforming output by design, and the CDT path is conforming; the fast mesh
// then splits crescent hulls (healCracks) to repair interior<->crescent T-junctions. A T-junction
// is a vertex lying strictly in the interior of another triangle's edge: the two triangles do not
// share that edge, so at any zoom the rasterizer can leave a sub-pixel CRACK between them.
//
// Audited primitives are the ones that TILE the shape's area: interior (kind 0), quad and cubic
// hull faces (1, 2, 11), Bezout (4) and rational-quad (5) faces. Strips (3, 9, 10), corner caps
// (8) and cubic rings deliberately overlap/extend past their neighbors — they are not a tiling,
// so a "T-junction" there is meaningless.
//
// Reported per shape: T-junction count, and which kinds the edge and the offending vertex belong
// to (interior-vs-crescent is the healCracks case; interior-vs-interior would be an earcut bug).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROBOTO = Array.from(
  new Uint8Array(readFileSync(ROOT + '/test/font/fixtures/roboto-regular.ttf')),
);
const TIGER = readFileSync(ROOT + '/examples/tiger.svg', 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
const F=24;
const TILING = new Set([0,1,2,4,5,11]);

// T-junction audit of one packed mesh. Grid-hashed vertices, so it is O(V + E*k).
function audit(m){
  const V=m.verts, n=m.vertexCount;
  // collect tiling triangles + their vertices
  const tri=[];
  for(let i=0;i+2<n;i+=3){
    const k=Math.floor(V[i*F+5]+0.001);
    if(!TILING.has(k)) continue;
    tri.push([[V[i*F],V[i*F+1]],[V[(i+1)*F],V[(i+1)*F+1]],[V[(i+2)*F],V[(i+2)*F+1]],k]);
  }
  if(!tri.length) return {tjunc:0, tris:0, pairs:{}};
  let minx=1e30,miny=1e30,maxx=-1e30,maxy=-1e30;
  for(const t of tri) for(let j=0;j<3;j++){ const p=t[j];
    if(p[0]<minx)minx=p[0]; if(p[0]>maxx)maxx=p[0];
    if(p[1]<miny)miny=p[1]; if(p[1]>maxy)maxy=p[1]; }
  const diag=Math.hypot(maxx-minx,maxy-miny)||1;
  const eps=1e-7*diag;                       // "on the edge" tolerance
  const cell=Math.max(diag/256,1e-9);
  const grid=new Map();
  const key=(x,y)=>Math.floor(x/cell)+'_'+Math.floor(y/cell);
  // unique vertices, remembering a kind for reporting
  const vk=new Map();
  for(const t of tri) for(let j=0;j<3;j++){ const p=t[j];
    const kk=Math.round(p[0]/eps)+':'+Math.round(p[1]/eps);
    if(!vk.has(kk)){ vk.set(kk,{p,k:t[3]});
      const g=key(p[0],p[1]); let a=grid.get(g); if(!a) grid.set(g,a=[]); a.push(p); } }
  let tjunc=0; const pairs={};
  for(const t of tri){
    for(let e=0;e<3;e++){
      const A=t[e], B=t[(e+1)%3];
      const dx=B[0]-A[0], dy=B[1]-A[1], L2=dx*dx+dy*dy;
      if(L2<eps*eps) continue;
      const x0=Math.min(A[0],B[0]), x1=Math.max(A[0],B[0]);
      const y0=Math.min(A[1],B[1]), y1=Math.max(A[1],B[1]);
      for(let gx=Math.floor(x0/cell); gx<=Math.floor(x1/cell); gx++)
      for(let gy=Math.floor(y0/cell); gy<=Math.floor(y1/cell); gy++){
        const arr=grid.get(gx+'_'+gy); if(!arr) continue;
        for(const P of arr){
          // strictly between the endpoints?
          const s=((P[0]-A[0])*dx+(P[1]-A[1])*dy)/L2;
          if(s<=1e-6 || s>=1-1e-6) continue;
          // perpendicular distance
          const px=A[0]+s*dx-P[0], py=A[1]+s*dy-P[1];
          if(px*px+py*py > eps*eps) continue;
          // it IS a T-junction unless P is one of this triangle's own corners
          if((Math.abs(P[0]-t[0][0])<eps&&Math.abs(P[1]-t[0][1])<eps)||
             (Math.abs(P[0]-t[1][0])<eps&&Math.abs(P[1]-t[1][1])<eps)||
             (Math.abs(P[0]-t[2][0])<eps&&Math.abs(P[1]-t[2][1])<eps)) continue;
          tjunc++;
          const kk=Math.round(P[0]/eps)+':'+Math.round(P[1]/eps);
          const vkind=(vk.get(kk)||{k:-1}).k;
          const tag='edge k'+t[3]+' <- vert k'+vkind;
          pairs[tag]=(pairs[tag]||0)+1;
        }
      }
    }
  }
  return {tjunc, tris:tri.length, pairs};
}

window.__run=async(tiger, fontBytes, forceCdt)=>{
  r.setLoopBlinnMeshOpts({ forceCdt: !!forceCdt });
  const out=[];
  const scan=(name, bun)=>{
    let tjunc=0, tris=0, shapes=0; const pairs={};
    for(const m of (bun._lbMeshes||[])){
      if(!m||!m.verts) continue;
      shapes++;
      const a=audit(m); tjunc+=a.tjunc; tris+=a.tris;
      for(const k in a.pairs) pairs[k]=(pairs[k]||0)+a.pairs[k];
    }
    out.push({name, shapes, tris, tjunc, pairs});
  };
  { const b=createBundle(gl, await importSvg(tiger)); r.prepareBundle(b); scan('tiger', b); b.dispose(); }
  { const font=new MantleFontAsset(new Uint8Array(fontBytes));
    const tb=await createTextBundle(gl,{font,text:'NAWMgo8 Hamburgefonstiv',style:{fontSize:64,fill:[0,0,0,1]}});
    const bun=tb.bundle||tb; r.prepareBundle(bun); scan('glyphs', bun); tb.dispose&&tb.dispose(); }
  r.setLoopBlinnMeshOpts({ forceCdt: false });
  return out;
};
window.__ready=true;
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });

for (const forceCdt of [false, true]) {
  const pg = await br.newPage(); // fresh page: the LB mesh cache is module-level
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 90000,
  });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const o = await pg.evaluate((t, f, fc) => window.__run(t, f, fc), TIGER, ROBOTO, forceCdt);
  console.log(
    `\n  ${forceCdt ? 'FORCE_CDT=1 (CDT path)' : 'default routing (earcut fast mesh where possible)'}`,
  );
  for (const r of o) {
    console.log(
      `    ${r.name.padEnd(7)} ${String(r.shapes).padStart(4)} shapes, ${String(r.tris).padStart(6)} tiling tris -> T-junctions: ${r.tjunc}`,
    );
    for (const [k, v] of Object.entries(r.pairs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5))
      console.log(`             ${k}: ${v}`);
  }
  await pg.close();
}
await br.close();
server.close();
