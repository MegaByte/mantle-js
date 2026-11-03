// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gwnFillBench — the GWN fill priced on real hardware. Renders the same quad-only content with the Slug
// ray-cast walk, the AAC signed-area walk, and the closed-form GWN kernel (opt-in define).
//
// GWN has NO anti-aliasing (coverage is the folded winding), so it is compared on INK — the count
// of covered pixels — not on AA error. A correct GWN must agree with Slug's ink to within the AA
// band; a mismatch beyond that means the winding itself is wrong (usually a band-claim bug).
//
// Quad-only content on purpose: the GWN kernel implements LINE + QUAD. A cubic's lune test needs
// its implicit, which the Slug curve buffer does not carry.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROBOTO = Array.from(
  new Uint8Array(readFileSync(ROOT + '/test/font/fixtures/roboto-regular.ttf')),
);
const N = 512;
// quad flowers: K quadratic arcs per shape, no cubics, no arcs
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
// one BIG shape, K quads — isolates "segments per shape", which is what GWN pays per pixel and
// Slug does not (Slug walks only the band containing the pixel).
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}Z"/></svg>`;
};
const CASES = {
  'flowers x16 (8 quads ea)': flowers(N, 16, 40),
  'flowers x120 (8 quads ea)': flowers(N, 120, 16),
  'flowers x400 (8 quads ea)': flowers(N, 400, 7),
  '1 shape, 8 quads': bigFlower(N, 8),
  '1 shape, 32 quads': bigFlower(N, 32),
  '1 shape, 128 quads': bigFlower(N, 128),
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rSlug=createRenderer(gl,shaders,{});                       rSlug.setLoopBlinnFill('off');
const rAac =createRenderer(gl,shaders,{aacFill:true});           rAac.setLoopBlinnFill('off');
const rGwn =createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN']}); rGwn.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const inkOf=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
  let ink=0; for(let i=0;i<N*N;i++) ink += (255-p[i*4])/255; return ink;};
const run=(r,sec)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const ink=inkOf();
  const K=6, runs=[];
  for(let rep=0;rep<7;rep++){ const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K); }
  runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[3], ink};
};
window.__run=async(cases)=>{
  const out=[];
  for(const [name,svg] of Object.entries(cases)){
    const sec=await importSvg(svg);
    // GWN needs its own bundle: the run tree is opt-in (bands cannot prune a winding number).
    const secG=await importSvg(svg,{gwnTree:true});
    out.push({name, slug:run(rSlug,sec), aac:run(rAac,sec), gwn:run(rGwn,secG)});
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
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 200));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((c) => window.__run(c), CASES);
await br.close();
server.close();
console.log(
  '\n  case                      |   Slug   |   AAC    |   GWN    | GWN/Slug | ink GWN/Slug',
);
for (const r of o) {
  console.log(
    `  ${r.name.padEnd(25)} | ${r.slug.ms.toFixed(3).padStart(7)}ms | ${r.aac.ms.toFixed(3).padStart(7)}ms | ${r.gwn.ms.toFixed(3).padStart(7)}ms | ${(r.gwn.ms / r.slug.ms).toFixed(2).padStart(7)}x | ${(r.gwn.ink / r.slug.ink).toFixed(4)}`,
  );
}
