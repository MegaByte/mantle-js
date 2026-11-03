// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _fillVertexBound — the expensive assets are ONE draw, ~11 GL calls, 0 redundant
// (_glCallAudit) and FLAT in resolution (_fillCostScaling). Not draw count, not GL
// overhead, not fillrate. That leaves the VERTEX side: the unified stream's per-vertex
// Loop-Blinn payload, which is independent of pixels and paid once per vertex.
//
// Test: same asset, same resolution, LB ON vs LB OFF (Slug fill draws cover quads —
// 6 verts a shape — instead of an LB triangle mesh). At 256x256 fragments are cheap, so
// a large gap there is vertex-side cost, and `verts` says whether it tracks vertex count.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS_ROOT;
const N = +(process.env.N || 256);
const STUB = (process.env.STUB || 'MANTLE_FRAG_STUB').split(',');
const CASES = {};
for (const rel of (process.env.FILES || '').split(',').filter(Boolean)) {
  try {
    CASES[path.basename(rel)] = readFileSync(path.join(CORPUS, rel), 'utf8');
  } catch {
    console.error('skip:', rel);
  }
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rLb =createRenderer(gl,shaders,{});
// RASTERIZATION FLOOR: the fragment shader returns immediately, so the frame costs
// only vertex work + the fragments the cover geometry emits + blending. The gap to
// rLb is everything the ubershader does per fragment.
const rNo =createRenderer(gl,shaders,{fillDefines:${JSON.stringify(STUB)}});
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const vertsOf=(b)=>{ let v=0;
  const m=b._lbMeshes||[]; for(const s of m){ if(!s) continue;
    for(const e of (Array.isArray(s)?s:[s])){ if(e && e.verts && e.verts.length) v += e.verts.length/24; } }
  return v; };
// Split CPU SUBMIT from GPU. drawBundle returning is pure CPU (the driver has only
// been TOLD to draw); the sync that follows is where the GPU is waited on. Timing
// them separately is the only way to tell "the shader is slow" from "building the
// draw is slow" — they look identical end to end.
const run=(r,sec)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const K=4, tot=[], cpu=[];
  for(let rep=0;rep<7;rep++){
    const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b);
    r.endFrame(); const t1=performance.now();   // returned: CPU work done, GPU may still be busy
    sync(); const t2=performance.now();          // GPU drained
    cpu.push((t1-t0)/K); tot.push((t2-t0)/K);
  }
  tot.sort((a,b)=>a-b); cpu.sort((a,b)=>a-b);
  const v=vertsOf(b); b.dispose(); return {ms:tot[3], cpu:cpu[3], verts:v};
};
// Per-FRAME offscreen work. A mask bake or filter eval that reruns every frame is
// GPU cost at the RT's own size — invisible to a main-pass draw count and flat in
// canvas resolution, which is exactly the signature measured here.
const offscreenPerFrame=(r,sec)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const d0=r.debugStats, a0=(d0.maskBakeCount|0), b0=(d0.filterEvalCount|0);

  const F=5;
  for(let f=0;f<F;f++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); }
  const d1=r.debugStats;
  const st=r.debugStats;
  b.dispose();
  return { masks:((d1.maskBakeCount|0)-a0)/F, filters:((d1.filterEvalCount|0)-b0)/F,
           entries: st.filterCacheEntries|0, mb: +((st.filterCacheBytes|0)/1048576).toFixed(2) };
};
window.__run=async(cases)=>{ const out=[];
  for(const [name,svg] of Object.entries(cases)){
    try{ const sec=await importSvg(svg);
      const lb=run(rLb,sec), no=run(rNo,sec);
      out.__floor=no.ms;
      const off=offscreenPerFrame(rLb,sec);
      out.push({name, lb, no, off});
    }catch(e){ out.push({name, err:String(e.message).slice(0,110)}); }
  } return out; };
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((c) => window.__run(c), CASES);
await br.close();
server.close();
console.log(`\nvertex-side cost at ${N}x${N} (fragments deliberately cheap)\n`);
console.log('  asset                         |    total | stubbed | DELTA | delta share');
for (const r of o) {
  if (r.err) {
    console.log(`  ${r.name.padEnd(29)} | ERR ${r.err}`);
    continue;
  }
  const gpu = r.lb.ms - r.lb.cpu;
  const shade = r.lb.ms - r.no.ms;
  console.log(
    `  ${r.name.padEnd(29)} | ${r.lb.ms.toFixed(2).padStart(6)}ms | ${r.no.ms.toFixed(2).padStart(10)}ms | ${shade.toFixed(2).padStart(5)}ms | ${((shade / Math.max(r.lb.ms, 1e-9)) * 100).toFixed(0).padStart(11)}%`,
  );
}
console.log('\nHigh CPU share = the cost is BUILDING the draw. Nonzero masks/filters PER FRAME');
console.log('= offscreen GPU work redone every frame, at the RT size, not the canvas size.');
