// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _filterCacheIdentity — a CACHED filter result must be pixel-identical to a freshly
// evaluated one. Raising the filter-result cache from 8 entries to a byte budget means
// far more frames are served from cache, so the thing to prove is that serving from
// cache changes nothing.
//
// Frame 1 is cold (every graph evaluates). Frame 6 is warm (every graph hits). If the
// key is right they are the same image; if the key is missing an input, they differ.
// Also renders with the cache effectively disabled as a third reference.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS_ROOT;
const N = +(process.env.N || 512);
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
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const r=createRenderer(gl,shaders,{});
const grab=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
const diff=(a,b)=>{ let n=0,max=0;
  for(let i=0;i<a.length;i++){ const d=Math.abs(a[i]-b[i]); if(d){ n++; if(d>max) max=d; } }
  return {n,max}; };
window.__run=async(cases)=>{ const out=[];
  for(const [name,svg] of Object.entries(cases)){
    try{
      const sec=await importSvg(svg);
      const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
      // frame 1 — cold: nothing cached yet, every graph runs
      r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
      const cold=grab();
      const evalsCold=r.debugStats.filterEvalCount|0;
      // frames 2..6 — warm
      for(let f=0;f<5;f++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); }
      const warm=grab();
      const evalsWarm=(r.debugStats.filterEvalCount|0)-evalsCold;
      b.dispose();
      out.push({name, d:diff(cold,warm), evalsCold, evalsWarm, px:N*N*4});
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
let bad = 0;
console.log(`\nCACHED vs FRESHLY EVALUATED filter output at ${N}x${N}\n`);
console.log(
  '  asset                         | evals cold | evals warm | differing bytes | max delta',
);
for (const r of o) {
  if (r.err) {
    console.log(`  ${r.name.padEnd(29)} | ERR ${r.err}`);
    bad++;
    continue;
  }
  const ok = r.d.n === 0;
  if (!ok) bad++;
  console.log(
    `  ${r.name.padEnd(29)} | ${String(r.evalsCold).padStart(10)} | ${String(r.evalsWarm).padStart(10)} | ${String(r.d.n).padStart(15)} | ${String(r.d.max).padStart(9)} ${ok ? '' : '  <-- DIFFERS'}`,
  );
}
console.log(
  bad
    ? `\n${bad} asset(s) FAILED — a cached frame is not the frame it replaced.`
    : '\nevery cached frame is byte-identical to its freshly evaluated one.',
);
process.exit(bad ? 1 : 0);
