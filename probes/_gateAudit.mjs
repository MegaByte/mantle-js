// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gateAudit — does the gate's PICK match the measured FASTEST? For each (content, on-screen size)
// read the auto selector's decision (debugStats.autoEngine for AAC/Slug; loopBlinnRouteCount for
// LB-vs-not) and compare to the per-engine timing truth. Flags every mismatch: the gate said X but
// engine Y was faster. Content pinned to true on-screen size (globalBBox), all regimes covered.
import { readFileSync } from 'fs';
import { benchNames, BENCH_UNSET } from '../test/_assets.mjs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 1024;
const CONTENT = [];
if (!benchNames().length) console.log(BENCH_UNSET);
for (const f of benchNames()) {
  try {
    CONTENT.push({
      name: f,
      svg: readFileSync(path.join(ROOT, 'examples/_bench', f + '.svg'), 'utf8'),
    });
  } catch {}
}
try {
  CONTENT.push({ name: 'tiger', svg: readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8') });
} catch {}
const SIZES = [16, 32, 64, 128, 256, 512];
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
// pure engines for TRUTH, plus AUTO renderers whose picks we read
const Rf={ slug:createRenderer(gl,shaders,{}), aac:createRenderer(gl,shaders,{aacFill:true}),
  lb:createRenderer(gl,shaders,{}),
  autoAac:createRenderer(gl,shaders,{aacFill:'auto'}),   // AAC-vs-Slug gate
  autoLb:createRenderer(gl,shaders,{aacFill:'auto'}) };  // LB gate (loopBlinn auto)
Rf.slug.setLoopBlinnFill('off'); Rf.aac.setLoopBlinnFill('off'); Rf.lb.setLoopBlinnFill('on');
Rf.autoAac.setLoopBlinnFill('off'); Rf.autoLb.setLoopBlinnFill('auto');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const measure=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let y0=N,y1=0;
  for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(p[(y*N+x)*4]<230){ if(y<y0)y0=y; if(y>y1)y1=y;} return y1-y0;};
const pin=(r,b,px)=>{ r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const h0=measure(); if(h0<=0) return; const k=h0/px,g=b.globalBBox; b.globalBBox=[g[0],g[1],g[2]*k,g[3]*k]; if(b._geomGen!=null)b._geomGen++; };
const time=(r,b)=>{ r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const K=16,runs=[]; for(let rep=0;rep<7;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[3]; };
window.__run=async(content, sizes)=>{
  const out=[];
  for(const cs of content){
    const plain=await importSvg(cs.svg);
    for(const px of sizes){
      const b={ slug:createBundle(gl,plain), aac:createBundle(gl,plain), lb:createBundle(gl,plain), aa:createBundle(gl,plain), al:createBundle(gl,plain) };
      for(const k in b) pin(Rf[{slug:'slug',aac:'aac',lb:'lb',aa:'autoAac',al:'autoLb'}[k]], b[k], px);
      Rf.lb.prepareBundle(b.lb); Rf.autoLb.prepareBundle && Rf.autoLb.prepareBundle(b.al);
      // measured truth
      const tSlug=time(Rf.slug,b.slug), tAac=time(Rf.aac,b.aac), tLb=time(Rf.lb,b.lb);
      // AAC-gate decision
      Rf.autoAac.beginFrame([1,1,1,1]); Rf.autoAac.drawBundle(b.aa); Rf.autoAac.endFrame(); sync();
      const aacPick=Rf.autoAac.debugStats.autoEngine, px2=Rf.autoAac.debugStats.autoMeanShapePx2;
      // LB-gate decision: did loopBlinn route?
      const c0=Rf.autoLb.debugStats.loopBlinnRouteCount; Rf.autoLb.beginFrame([1,1,1,1]); Rf.autoLb.drawBundle(b.al); Rf.autoLb.endFrame(); sync();
      const lbRouted=(Rf.autoLb.debugStats.loopBlinnRouteCount-c0)>0, lbPx2Seg=Rf.autoLb.debugStats.lbAutoPx2PerSeg;
      out.push({name:cs.name, px, px2:Math.round(px2), lbPx2Seg:Math.round(lbPx2Seg), aacPick, lbRouted,
        tSlug, tAac, tLb });
      for(const k in b) b[k].dispose();
    }
  }
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
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 50 });
const o = await pg.evaluate((c, s) => window.__run(c, s), CONTENT, SIZES);
await br.close();
server.close();
// The effective auto pick = LB if it routed AND lb is fastest-of-slug/aac path chosen... actually the
// DEFAULT router: aacFill 'auto' picks Slug/AAC; LB 'auto' overrides to LB when eligible. Effective
// engine = LB (if lbRouted) else aacPick. Compare to measured fastest of {Slug,AAC,LB}.
console.log(
  '\\n  GATE AUDIT: pick vs measured fastest. MISMATCH = default router chose a slower engine.\\n',
);
console.log('  content       size | px2/sh px2/seg | aacGate lbRoute -> PICK | fastest | verdict');
let last = '';
for (const r of o) {
  if (r.name !== last) {
    console.log('  -- ' + r.name + ' --');
    last = r.name;
  }
  const eng = { Slug: r.tSlug, AAC: r.tAac, LB: r.tLb };
  let fastest = 'Slug',
    fv = 1e9;
  for (const k in eng)
    if (eng[k] < fv) {
      fv = eng[k];
      fastest = k;
    }
  const pick = r.lbRouted ? 'LB' : r.aacPick === 'aac' ? 'AAC' : 'Slug';
  const pickMs = pick === 'LB' ? r.tLb : pick === 'AAC' ? r.tAac : r.tSlug;
  const slow = (pickMs / fv - 1) * 100;
  const verdict =
    pick === fastest
      ? 'ok'
      : `MISMATCH picked ${pick} (${pickMs.toFixed(2)}) vs ${fastest} (${fv.toFixed(2)}) +${slow.toFixed(0)}%`;
  console.log(
    `  ${r.name.padEnd(12)} ${String(r.px).padStart(3)} | ${String(r.px2).padStart(6)} ${String(r.lbPx2Seg).padStart(6)} | ${(r.aacPick || '?').padEnd(4)}  ${r.lbRouted ? 'yes' : 'no '}  -> ${pick.padEnd(4)} | ${fastest.padEnd(4)} | ${verdict}`,
  );
}
