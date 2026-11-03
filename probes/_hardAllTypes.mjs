// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _hardAllTypes — band-hard must render LINE/QUAD/CUBIC/ARC correctly (ink parity with Slug, the
// winding ground truth) and stay fast. Drift measured against Slug full-AA; anything above the AA
// band (~a couple %) means the crossing count for that type is wrong.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;
const tri = (n) => `M ${0.2 * n} ${0.25 * n} L ${0.8 * n} ${0.4 * n} L ${0.35 * n} ${0.85 * n} Z`;
const quadFlower = (n) => {
  const K = 8,
    c = n / 2,
    r = n * 0.42;
  const P = (j) => [
    c + r * Math.cos((2 * Math.PI * j) / K),
    c + r * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = `M ${P(0)[0]} ${P(0)[1]} `;
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.3,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.3;
    d += `Q ${mx} ${my} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
};
const cubicCircle = (n) => {
  const c = n / 2,
    r = n * 0.42,
    k = 0.5523 * r;
  const P = [
    [c - r, c],
    [c, c - r],
    [c + r, c],
    [c, c + r],
  ];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = P[i],
      B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), A[0] - c],
      tb = [-(B[1] - c), B[0] - c];
    d += `C ${A[0] + (ta[0] / r) * k} ${A[1] + (ta[1] / r) * k} ${B[0] - (tb[0] / r) * k} ${B[1] - (tb[1] / r) * k} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
};
const arcCircle = (n) => {
  const c = n / 2,
    r = n * 0.42;
  return `M ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} Z`;
};
const arcRing = (n) => {
  const c = n / 2,
    r = n * 0.42,
    ri = n * 0.24;
  return (
    `M ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} Z ` +
    `M ${c - ri} ${c} A ${ri} ${ri} 0 1 0 ${c + ri} ${c} A ${ri} ${ri} 0 1 0 ${c - ri} ${c} Z`
  );
};
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000" d="${d}"/></svg>`;
const CASES = {
  'lines (triangle)': tri(N),
  'quads (flower)': quadFlower(N),
  'cubics (circle)': cubicCircle(N),
  'arcs (circle)': arcCircle(N),
  'arcs (holed ring)': arcRing(N),
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rHard=createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_GWN']}); rHard.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const ink=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); let s=0; for(let i=0;i<N*N;i++) s+=(255-p[i*4])/255; return s;};
const run=(r,sec)=>{const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const nk=ink();
  const K=10, runs=[]; for(let rep=0;rep<7;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); b.dispose(); return {ms:runs[3],ink:nk};};
window.__run=async(cases)=>{const out=[];
  for(const [name,s] of Object.entries(cases)){ const sec=await importSvg(s);
    out.push({name, slug:run(rSlug,sec), hard:run(rHard,sec)});} return out;};
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
console.log('\n  band-hard correctness (ink vs Slug) + cost, @512\n');
console.log('  type                 | slug ms  hard ms | ink drift vs Slug');
for (const r of o) {
  const drift = (Math.abs(r.hard.ink - r.slug.ink) / Math.max(r.slug.ink, 1)) * 100;
  const flag = drift > 2 ? '  <-- WRONG' : '';
  console.log(
    `  ${r.name.padEnd(20)} | ${r.slug.ms.toFixed(3)}    ${r.hard.ms.toFixed(3)} | ${drift.toFixed(2)}%${flag}`,
  );
}
