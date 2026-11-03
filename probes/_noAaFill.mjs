// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _noAaFill — for an OPAQUE, UNDASHED stroked shape the fill needs only inside/outside; the stroke
// hides the fill's 1px AA band. So compare the three engines with AA turned OFF, to find where a
// containment-only fill would want to trade structures.
//   band-AA (Slug/AAC full)  vs  band-hard (crossing count over the band)
//   tree-AA (GWN+SDF)         vs  tree-hard (renderFillGWN, folded winding)
// Quad/line content only (the hard band kernel's domain), so all engines are apples-to-apples.
// Cost is readback-synced amortized draws; ink cross-check guards against timing a broken render.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flower = (K, cx, cy, r, bulge) => {
  const P = (j) => [
    cx + r * Math.cos((2 * Math.PI * j) / K),
    cy + r * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
};
const grid = (nShapes, n, K) => {
  const cols = Math.ceil(Math.sqrt(nShapes)),
    cell = n / cols;
  let b = '';
  for (let i = 0; i < nShapes; i++)
    b += `<path fill="#000" d="${flower(K, (i % cols) * cell + cell / 2, Math.floor(i / cols) * cell + cell / 2, cell * 0.42, 0.15)}"/>`;
  return b;
};
const svg = (n, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${body}</svg>`;
const CASES = (n) => ({
  'quads-8   1shape': svg(n, `<path fill="#000" d="${flower(8, n / 2, n / 2, n * 0.44, 0.12)}"/>`),
  'quads-128 1shape': svg(
    n,
    `<path fill="#000" d="${flower(128, n / 2, n / 2, n * 0.44, 0.02)}"/>`,
  ),
  'quads-8   x64shapes': svg(n, grid(64, n, 8)),
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
const R = {
  'slug-AA' : createRenderer(gl,shaders,{}),
  'aac-AA'  : createRenderer(gl,shaders,{aacFill:true}),
  'sdf-AA'  : createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}),
  'band-hard': createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_GWN']}),
  'tree-hard': createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_HARD_TREE','MANTLE_GWN']}),
};
for(const k in R) R[k].setLoopBlinnFill('off');
const NEEDTREE = new Set(['sdf-AA','tree-hard']);
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const ink=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
  let s=0; for(let i=0;i<N*N;i++) s+=(255-p[i*4])/255; return s;};
const run=(r,sec)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const nk=ink();
  const K=12, runs=[];
  for(let rep=0;rep<7;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K);}
  runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[3], ink:nk}; };
window.__run=async(cases)=>{
  const out=[];
  for(const [name,s] of Object.entries(cases)){
    const plain=await importSvg(s), tree=await importSvg(s,{gwnTree:true});
    const row={name};
    for(const k in R) row[k]=run(R[k], NEEDTREE.has(k)?tree:plain);
    out.push(row);
  }
  return out;
};
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
console.log(
  '\n  ms/draw (readback-synced). AA columns produce sub-pixel coverage; HARD columns produce 0/1.\n',
);
console.log(
  '  case                @sz  |  slug-AA  aac-AA  sdf-AA | band-hard tree-hard | hard save vs best-AA',
);
for (const SZ of [256, 1024]) {
  const server = serve(SZ);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [pageerror]', e.message.slice(0, 300)));
  pg.on('console', (m) => {
    if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 300));
  });
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 90000,
  });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const o = await pg.evaluate((c) => window.__run(c), CASES(SZ));
  await pg.close();
  server.close();
  for (const r of o) {
    // ink cross-check: hard vs its AA counterpart must be within the AA band (~a few %)
    const bh = r['band-hard'],
      th = r['tree-hard'],
      aa = Math.min(r['slug-AA'].ink, r['aac-AA'].ink);
    const bestAA = Math.min(r['slug-AA'].ms, r['aac-AA'].ms, r['sdf-AA'].ms);
    const bestHard = Math.min(bh.ms, th.ms);
    const drift = (Math.abs(bh.ink - aa) / Math.max(aa, 1)) * 100;
    console.log(
      `  ${r.name.padEnd(19)} ${String(SZ).padStart(4)} | ${r['slug-AA'].ms.toFixed(3)}  ${r['aac-AA'].ms.toFixed(3)}  ${r['sdf-AA'].ms.toFixed(3)} |   ${bh.ms.toFixed(3)}    ${th.ms.toFixed(3)} | ${((1 - bestHard / bestAA) * 100).toFixed(0)}%  (ink drift ${drift.toFixed(1)}%)`,
    );
  }
}
await br.close();
