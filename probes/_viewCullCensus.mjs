// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _viewCullCensus — how many LB vertices does the unified route submit for shapes
// that are ENTIRELY off-viewport?
//
// LB's per-fragment slope is ~0 (probes/_bandCost.mjs), so the vertex budget IS the
// perf budget (probes/_lbVertCensus.mjs). Offscreen cover quads are free — the
// rasterizer clips them — but their VERTICES still run the vertex shader, which for
// an LB vert is lbVertexSetup plus meta/override texelFetches.
//
// Reports, per pan offset:
//   subm   total verts the single drawArrays submits
//   off    verts belonging to shapes whose padded em bbox maps fully outside NDC
//   runs   contiguous visible spans (draws a fragmenting cull would cost)
//   trim   verts saved by TRIM-only culling (narrow the one draw to
//          [firstVisible..lastVisible]) — costs zero extra draws by construction
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TIGER = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');
// A "road": many shapes spread along x, the streaming case the cull targets.
const ROAD = (() => {
  const n = 160,
    parts = [];
  for (let i = 0; i < n; i++) {
    const x = i * 40;
    parts.push(
      `<path d="M${x} 60 Q${x + 20} ${i % 2 ? 10 : 110} ${x + 40} 60 L${x + 40} 100 L${x} 100 Z" fill="#${((i * 7919) % 4096).toString(16).padStart(3, '0')}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n * 40} 120">${parts.join('')}</svg>`;
})();

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');

function arScale(bb, vw, vh){ const cAR=vw/vh, sAR=bb[2]/bb[3];
  return (sAR>cAR) ? [1, cAR/sAR] : [sAR/cAR, 1]; }

// Mirror of mantle.vert.glsl: em -> uv -> plane -> worldM -> ndc.
function emToNdc(ex, ey, gbb, ar, wm){
  const ux=(ex-gbb[0])/gbb[2], uy=(ey-gbb[1])/gbb[3];
  const px=(ux*2-1)*ar[0], py=(uy*2-1)*ar[1];
  const qx=px, qy=-py;
  if(!wm) return [qx, qy];
  return [wm[0]*qx + wm[3]*qy + wm[6], wm[1]*qx + wm[4]*qy + wm[7]];
}

window.__run=async(cases)=>{
  const out=[];
  for(const cs of cases){
    const b=createBundle(gl, await importSvg(cs.svg)); r.prepareBundle(b);
    r.setViewport(512,512);
    // The LB program variant links asynchronously; until it does, the route
    // reports 'variant-warming' and falls to the second-best engine, so the span
    // cache never appears. Warm it, then draw a few frames to populate.
    await r.awaitLbReady(b, 20000);
    for(let k=0;k<4;k++){ r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame(); await new Promise(res=>requestAnimationFrame(res)); }
    const cache=b._unifiedFill;
    if(!cache||!cache.spanN){ out.push({name:cs.name, err:'no unified cache, gate='+(r.debugStats.unifiedFillGate||'?')}); b.dispose(); continue; }
    const gbb=b.globalBBox, ar=arScale(gbb,512,512);
    const meta=b.metaFloats, stride=b.metaFloatsPerShape;
    const rows=[];
    for(const pan of cs.pans){
      // Column-major mat3: scale s about origin then translate by (tx,0) in NDC.
      const s=pan.s||1;
      const wm=[s,0,0, 0,s,0, pan.tx,0,1];
      const {spanN,spanS}=cache;
      let subm=0, off=0, runs=0, firstVis=-1, lastVis=-1, inRun=false;
      const vis=[];
      for(let i=0;i<spanN.length;i++){
        const n=spanN[i]; if(n<=0){vis.push(null);continue;}
        subm+=n;
        const sIdx=spanS[i], bs=sIdx*stride;
        const sw=meta[bs+12]||0, pad=sw*0.5 + 0.02*Math.max(gbb[2],gbb[3]);
        const x0=meta[bs+0]-pad, y0=meta[bs+1]-pad, x1=meta[bs+2]+pad, y1=meta[bs+3]+pad;
        let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
        for(const [cx,cy] of [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]){
          const [nx,ny]=emToNdc(cx,cy,gbb,ar,wm);
          if(nx<minx)minx=nx; if(nx>maxx)maxx=nx;
          if(ny<miny)miny=ny; if(ny>maxy)maxy=ny;
        }
        const visible=!(maxx<-1||minx>1||maxy<-1||miny>1);
        vis.push(visible);
        if(visible){ if(firstVis<0)firstVis=i; lastVis=i; if(!inRun){runs++;inRun=true;} }
        else { off+=n; inRun=false; }
      }
      // TRIM-ONLY: keep everything between the first and last visible entry.
      let trim=0;
      if(firstVis>=0){ for(let i=0;i<spanN.length;i++){ if(i<firstVis||i>lastVis) trim+=spanN[i]; } }
      else trim=subm;
      rows.push({tx:pan.tx, s, subm, off, offPct:+(100*off/Math.max(subm,1)).toFixed(1),
                 trim, trimPct:+(100*trim/Math.max(subm,1)).toFixed(1), runs});
    }
    out.push({name:cs.name, entries:cache.spanN.length, rows});
    b.dispose();
  }
  return out;
};
window.__ready=true;
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': mime(pp) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 180000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const PANS = [{ tx: 0 }, { tx: 0.5 }, { tx: 1.0 }, { tx: 1.5 }, { tx: 0, s: 3 }, { tx: 1.0, s: 3 }];
const res = await pg.evaluate(
  (t, rd, pans) =>
    window.__run([
      { name: 'tiger', svg: t, pans },
      { name: 'road160', svg: rd, pans },
    ]),
  TIGER,
  ROAD,
  PANS,
);
for (const c of res) {
  if (c.err) {
    console.log(c.name.padEnd(9), 'ERR', c.err);
    continue;
  }
  console.log(`\n${c.name}  (${c.entries} entries)`);
  console.log('   tx    s |    subm |     off  off% |    trim trim% | runs');
  for (const r of c.rows)
    console.log(
      `  ${String(r.tx).padStart(4)} ${String(r.s).padStart(4)} | ${String(r.subm).padStart(7)} | ${String(r.off).padStart(7)} ${String(r.offPct).padStart(5)} | ${String(r.trim).padStart(7)} ${String(r.trimPct).padStart(5)} | ${r.runs}`,
    );
}
await br.close();
server.close();
