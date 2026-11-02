// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBreakEven — build-INCLUSIVE LB audit. The LB gate (px²/seg >= 150) is a proxy for "worth
// building." The real quantity: total = build + draw*redraws. LB pays iff (a) it has a per-draw
// advantage (draw_LB < draw_bestOther) AND (b) redraws > breakeven = build / (draw_other-draw_LB).
// If draw_LB >= draw_other, LB never pays (breakeven = inf) — that must be a hard veto.
// Measures FIRST build (fresh bundle, cache cold) + draws, at true on-screen size.
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
const SIZES = [32, 128, 512];
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const R={ slug:createRenderer(gl,shaders,{}), aac:createRenderer(gl,shaders,{aacFill:true}), lb:createRenderer(gl,shaders,{}) };
R.slug.setLoopBlinnFill('off'); R.aac.setLoopBlinnFill('off'); R.lb.setLoopBlinnFill('on');
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
    for(const px of sizes){
      // FIRST LB build: fresh import each time (the canonical cache is per-shape; a fresh parse misses it)
      const plain=await importSvg(cs.svg);
      const bLb=createBundle(gl,plain); pin(R.lb,bLb,px);
      const t0=performance.now(); R.lb.prepareBundle(bLb); const buildMs=performance.now()-t0;
      const bS=createBundle(gl,plain), bA=createBundle(gl,plain); pin(R.slug,bS,px); pin(R.aac,bA,px);
      const dLb=time(R.lb,bLb), dS=time(R.slug,bS), dA=time(R.aac,bA);
      const dOther=Math.min(dS,dA), otherName=dS<dA?'Slug':'AAC';
      const adv=dOther-dLb;                                  // LB per-draw advantage (>0 = LB faster to draw)
      const be = adv>0.001 ? buildMs/adv : Infinity;         // redraws to amortize build
      out.push({name:cs.name, px, buildMs, dLb, dS, dA, dOther, otherName, adv, be});
      bLb.dispose(); bS.dispose(); bA.dispose();
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
console.log('\\n  LB break-even: redraws for build to amortize vs the best non-LB engine.\\n');
console.log('  content       size |  build   dLB   dBest(eng) | LB draw adv | break-even');
let last = '';
for (const r of o) {
  if (r.name !== last) {
    console.log('  -- ' + r.name + ' --');
    last = r.name;
  }
  const verd =
    r.adv <= 0
      ? 'NEVER (LB draw slower)'
      : r.be < 10
        ? `${r.be.toFixed(0)} redraws (static wins)`
        : `${r.be.toFixed(0)} redraws (needs heavy reuse)`;
  console.log(
    `  ${r.name.padEnd(12)} ${String(r.px).padStart(3)} | ${r.buildMs.toFixed(1).padStart(6)} ${r.dLb.toFixed(3)} ${r.dOther.toFixed(3)}(${r.otherName}) | ${(r.adv > 0 ? '+' : '') + r.adv.toFixed(3)}      | ${verd}`,
  );
}
