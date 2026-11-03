// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _fillWalkCeiling — how much is the Slug band walk actually WORTH?
//
// A 2-D cell grid (Dobbie/gllabel), a finer band split, a per-cell curve list:
// every one of them buys the same currency — FEWER CURVES WALKED PER FRAGMENT.
// None can buy more than the walk costs in the first place. So before building
// one, price the ceiling: render the same content with the walk truncated to K
// segments per band sub-loop (MANTLE_WALK_CAP, measurement-only, WRONG output)
// and compare. Cap 1 is the floor of "walk almost nothing" — the limit no
// curve-count-reduction scheme can beat, and it still pays every other cost:
// the band-header fetch, the paint, the blend, the per-draw fixed cost.
//
// This is deliberately generous to the grid: a real grid also pays a cell
// lookup and a coarser early-out, so the true ceiling is BELOW what cap 1 shows.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 1024);
const CORPUS = process.env.CORPUS_ROOT;

// Synthetic content that maximizes band occupancy — many curves crossing one
// band is exactly the case a 2-D grid is supposed to rescue.
const bigFlower = (n, K) => {
  const cx = n / 2,
    cy = n / 2,
    r = n * 0.42;
  const P = (j) => [
    cx + r * Math.cos((2 * Math.PI * j) / K),
    cy + r * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.12,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.12;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"><path fill="#000" d="${d}Z"/></svg>`;
};
const CASES = {
  '1 shape,  32 quads': bigFlower(N, 32),
  '1 shape, 128 quads': bigFlower(N, 128),
  '1 shape, 512 quads': bigFlower(N, 512),
};
if (CORPUS) {
  for (const rel of (process.env.FILES || '').split(',').filter(Boolean)) {
    try {
      CASES['asset: ' + path.basename(rel)] = readFileSync(path.join(CORPUS, rel), 'utf8');
    } catch {
      console.error('skip (unreadable):', rel);
    }
  }
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
// Slug fill on every arm — LB off, so we are timing the band walk, not the engine choice.
const rFull=createRenderer(gl,shaders,{});                              rFull.setLoopBlinnFill('off');
const rCap8=createRenderer(gl,shaders,{fillDefines:['MANTLE_WALK_CAP 8']}); rCap8.setLoopBlinnFill('off');
const rCap1=createRenderer(gl,shaders,{fillDefines:['MANTLE_WALK_CAP 1']}); rCap1.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const inkOf=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
  let ink=0; for(let i=0;i<N*N;i++) ink += (255-p[i*4])/255; return ink;};
const run=(r,sec)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const ink=inkOf();
  const K=6, runs=[];
  for(let rep=0;rep<9;rep++){ const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K); }
  runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[4], ink};
};
window.__run=async(cases)=>{
  const out=[];
  for(const [name,svg] of Object.entries(cases)){
    try{ const sec=await importSvg(svg);
      out.push({name, full:run(rFull,sec), cap8:run(rCap8,sec), cap1:run(rCap1,sec)});
    }catch(e){ out.push({name, err:String(e.message).slice(0,120)}); }
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

console.log(`\nfill band-walk CEILING at ${N}x${N} (Slug fill, LB off)`);
console.log('cap N = walk at most N segs per band sub-loop; output is WRONG, that is the point.\n');
console.log(
  '  case                  |   full   |   cap8   |   cap1   | cap1 saves | ink cap1/full',
);
for (const r of o) {
  if (r.err) {
    console.log(`  ${r.name.padEnd(21)} | ERR ${r.err}`);
    continue;
  }
  const saves = (1 - r.cap1.ms / r.full.ms) * 100;
  console.log(
    `  ${r.name.padEnd(21)} | ${r.full.ms.toFixed(3).padStart(7)}ms | ${r.cap8.ms.toFixed(3).padStart(7)}ms | ${r.cap1.ms.toFixed(3).padStart(7)}ms | ${saves.toFixed(1).padStart(8)}% | ${(r.cap1.ink / Math.max(r.full.ink, 1e-9)).toFixed(3)}`,
  );
}
console.log(
  '\n"cap1 saves" is the CEILING for any curve-count-reduction scheme (2-D grid included).',
);
console.log('A real grid pays a cell lookup on top, so its true ceiling is BELOW this.');
