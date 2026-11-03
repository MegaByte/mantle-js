// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gwnHybrid — "GWN classifies, AAC integrates". The tree tells a pixel whether its CELL can be
// touched by the boundary; if not, coverage is the folded winding (0/1) and no area integral runs.
// Boundary cells fall through to renderFillAAC.
//
// The claim to prove is EXACTNESS, not closeness: the hybrid must be pixel-identical to AAC,
// because AAC already returns exactly 1.0/0.0 on unambiguous cells. maxDiff must be 0.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;
const flowers = (n, count, r) => {
  const cols = Math.ceil(Math.sqrt(count)),
    cell = n / cols;
  let body = '';
  for (let i = 0; i < count; i++) {
    const cx = (i % cols) * cell + cell / 2,
      cy = Math.floor(i / cols) * cell + cell / 2,
      K = 8;
    const P = (j) => [
      cx + r * Math.cos((2 * Math.PI * j) / K),
      cy + r * Math.sin((2 * Math.PI * j) / K),
    ];
    let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
    for (let j = 0; j < K; j++) {
      const A = P(j),
        B = P(j + 1);
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
      d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
    }
    body += `<path fill="#000000" d="${d}Z"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${body}</svg>`;
};
const bigDisc = (n) => {
  const c = n / 2,
    r = n * 0.47,
    K = 64;
  const P = (j) => [
    c + r * Math.cos((2 * Math.PI * j) / K),
    c + r * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.02,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.02;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}Z"/></svg>`;
};
const CASES = {
  'bigDisc (interior-heavy)': bigDisc(N),
  'flowers x16': flowers(N, 16, 40),
  'flowers x120': flowers(N, 120, 16),
  'flowers x400 (all band)': flowers(N, 400, 7),
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rAac=createRenderer(gl,shaders,{aacFill:true}); rAac.setLoopBlinnFill('off');
const rHyb=createRenderer(gl,shaders,{aacFill:true, fillDefines:['MANTLE_GWN']}); rHyb.setLoopBlinnFill('off');
// GWN alone (tree traversal + fold, NO AA, no band walk): isolates the descent's own cost.
const rGwn=createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN']}); rGwn.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const grab=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
const run=(r,sec)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const px=grab();
  const K=6, runs=[];
  for(let rep=0;rep<7;rep++){ const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K); }
  runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[3], px};
};
window.__run=async(cases)=>{
  const out=[];
  for(const [name,svg] of Object.entries(cases)){
    const sec=await importSvg(svg), secG=await importSvg(svg,{gwnTree:true});
    const a=run(rAac,sec), h=run(rHyb,secG), g=run(rGwn,secG);
    let maxDiff=0, nDiff=0;
    for(let i=0;i<a.px.length;i++){ const d=Math.abs(a.px[i]-h.px[i]); if(d){nDiff++; if(d>maxDiff)maxDiff=d;} }
    out.push({name, aac:a.ms, hyb:h.ms, gwn:g.ms, maxDiff, nDiff});
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((c) => window.__run(c), CASES);
await br.close();
server.close();
console.log(
  '\n  case                       |   AAC    | GWN only | GWN+AAC  | descent vs walk | diff',
);
for (const r of o)
  console.log(
    `  ${r.name.padEnd(26)} | ${r.aac.toFixed(3).padStart(7)}ms | ${r.gwn.toFixed(3).padStart(7)}ms | ${r.hyb.toFixed(3).padStart(7)}ms | ${(r.gwn / r.aac).toFixed(2).padStart(6)}x | ${r.nDiff}`,
  );
