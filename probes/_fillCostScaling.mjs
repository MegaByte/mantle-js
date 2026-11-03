// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _fillCostScaling — for the assets that actually set frame time, WHERE does the
// time go? Resolution is the discriminator and needs no instrumentation:
//
//   time ∝ pixels (≈4x per doubling)  → FILLRATE bound (shading every fragment)
//   time ≈ flat across resolutions    → PER-DRAW / CPU-submit bound
//
// Pairs with _fillWalkCeiling, which showed the band walk is worth 9.2% weighted
// and 3.1% on the six most expensive assets. If those are flat in resolution the
// cost is per-draw, and no fragment-side scheme — grid, finer bands, cheaper
// kernel — can touch them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS_ROOT;
const SIZES = (process.env.SIZES || '256,512,1024').split(',').map(Number);
const CASES = {};
for (const rel of (process.env.FILES || '').split(',').filter(Boolean)) {
  try {
    CASES[path.basename(rel)] = readFileSync(path.join(CORPUS, rel), 'utf8');
  } catch {
    console.error('skip:', rel);
  }
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="2048" height="2048"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{});
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const runAt=(sec,N)=>{ const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const K=4, runs=[];
  for(let rep=0;rep<7;rep++){ const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/K); }
  runs.sort((a,b)=>a-b); b.dispose(); return runs[3];
};
window.__run=async(cases,sizes)=>{
  const out=[];
  for(const [name,svg] of Object.entries(cases)){
    try{ const sec=await importSvg(svg);
      out.push({name, ms:sizes.map(N=>runAt(sec,N))});
    }catch(e){ out.push({name, err:String(e.message).slice(0,110)}); }
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
const o = await pg.evaluate((c, s) => window.__run(c, s), CASES, SIZES);
await br.close();
server.close();
console.log('\nfill cost vs RESOLUTION  (4x pixels per doubling)\n');
console.log(
  '  asset                         | ' +
    SIZES.map((s) => String(s).padStart(8)).join(' | ') +
    ' | x per doubling | verdict',
);
for (const r of o) {
  if (r.err) {
    console.log(`  ${r.name.padEnd(29)} | ERR ${r.err}`);
    continue;
  }
  const ratios = [];
  for (let i = 1; i < r.ms.length; i++) ratios.push(r.ms[i] / Math.max(r.ms[i - 1], 1e-9));
  const avg = ratios.reduce((a, b) => a + b, 0) / Math.max(ratios.length, 1);
  const verdict = avg >= 2.6 ? 'FILLRATE' : avg <= 1.5 ? 'PER-DRAW / CPU' : 'mixed';
  console.log(
    `  ${r.name.padEnd(29)} | ${r.ms.map((m) => m.toFixed(2).padStart(6) + 'ms').join(' | ')} | ${avg.toFixed(2).padStart(13)}x | ${verdict}`,
  );
}
console.log('\n4.0x = pure fillrate.  1.0x = cost is entirely independent of pixels.');
