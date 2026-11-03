// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _treeInterior — does the tree lose to the band on FILL because of INTERIOR pixels?
// The tree's far-field collapse fires when a pixel is OUTSIDE a run's bounding circle. A solid
// shape is mostly interior pixels (inside high-level nodes' circles → forced descent); a thin
// annulus is mostly boundary/exterior. If interior pixels are the tree's cost, band-hard should
// dominate on the disc and the gap should SHRINK on the annulus.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ring = (K, cx, cy, ro, ri) => {
  // outer CCW + inner CW = annulus (nonzero)
  const arc = (r, dir) => {
    const P = (j) => [
      cx + r * Math.cos((dir * 2 * Math.PI * j) / K),
      cy + r * Math.sin((dir * 2 * Math.PI * j) / K),
    ];
    let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
    for (let j = 0; j < K; j++) {
      const A = P(j),
        B = P(j + 1);
      const mx = (A[0] + B[0]) / 2 + dir * (B[1] - A[1]) * 0.02,
        my = (A[1] + B[1]) / 2 - dir * (B[0] - A[0]) * 0.02;
      d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
    }
    return d + 'Z ';
  };
  return arc(ro, 1) + (ri > 0 ? arc(ri, -1) : '');
};
const svg = (n, d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000" d="${d}"/></svg>`;
const CASES = (n) => ({
  'solid disc (all interior)': svg(n, ring(64, n / 2, n / 2, n * 0.47, 0)),
  'thin annulus (little inner)': svg(n, ring(64, n / 2, n / 2, n * 0.47, n * 0.42)),
});
const HTML = (
  SZ,
) => `<!DOCTYPE html><html><body><canvas id="c" width="${SZ}" height="${SZ}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${SZ};
const R={band:createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_GWN']}),
         tree:createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_HARD_TREE','MANTLE_GWN']})};
for(const k in R) R[k].setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const ink=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let s=0; for(let i=0;i<N*N;i++) s+=(255-p[i*4])/255; return s;};
const run=(r,sec)=>{const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const nk=ink();
  const K=12, runs=[]; for(let rep=0;rep<7;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[3],ink:nk};};
window.__run=async(cases)=>{const out=[];
  for(const [name,s] of Object.entries(cases)){ const tree=await importSvg(s,{gwnTree:true}), plain=await importSvg(s);
    out.push({name, band:run(R.band,plain), tree:run(R.tree,tree)});}
  return out;};
window.__ready=true;
</script></body></html>`;
const serve = (SZ) => {
  const HH = HTML(SZ);
  return http.createServer((q, res) => {
    try {
      if (q.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(HH);
        return;
      }
      const pp = decodeURIComponent(q.url.split('?')[0]);
      res.writeHead(200, {
        'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript',
      });
      res.end(readFileSync(path.join(ROOT, pp)));
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
};
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
console.log('\n  ms/draw @1024, interior-fraction test  (band = no-AA band, tree = no-AA tree)\n');
console.log('  shape                        | band   tree  | tree/band | ink (px2)');
for (const SZ of [1024]) {
  const server = serve(SZ);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 90000,
  });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const o = await pg.evaluate((c) => window.__run(c), CASES(SZ));
  await pg.close();
  server.close();
  for (const r of o)
    console.log(
      `  ${r.name.padEnd(28)} | ${r.band.ms.toFixed(3)}  ${r.tree.ms.toFixed(3)} | ${(r.tree.ms / r.band.ms).toFixed(2)}x | ${(r.band.ink / 1000).toFixed(0)}k`,
    );
}
await br.close();
