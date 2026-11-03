// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbRingCost — LB draw cost + mesh size for cubic-heavy bundles: prices the cubic
// exterior rings (in place of a relative hull dilation) against a mesh without them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;
const SVGS = {};
for (const f of ['tiger.svg', 'fish.svg']) {
  try {
    SVGS[f] = readFileSync(path.join(ROOT, 'examples', f), 'utf8');
  } catch {}
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
window.__run=async(svgs)=>{
  const out=[];
  for(const [name,txt] of Object.entries(svgs)){
    const b=createBundle(gl, await importSvg(txt)); r.prepareBundle(b);
    let verts=0; for(const m of (b._lbMeshes||[])) if(m&&m.vertexCount) verts+=m.vertexCount;
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    const K=8, runs=[];
    for(let rep=0;rep<7;rep++){
      r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
      const t0=performance.now(); r.beginFrame([1,1,1,1]);
      for(let i=0;i<K;i++) r.drawBundle(b);
      r.endFrame(); sync(); runs.push((performance.now()-t0)/K);
    }
    runs.sort((a,b)=>a-b);
    out.push({name, verts, ms:runs[3], routed:r.debugStats.loopBlinnRouteCount});
    b.dispose();
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
const o = await pg.evaluate((s) => window.__run(s), SVGS);
await br.close();
server.close();
for (const r of o)
  console.log(
    `  ${r.name.padEnd(12)} verts=${String(r.verts).padStart(7)}  draw=${r.ms.toFixed(3)}ms`,
  );
