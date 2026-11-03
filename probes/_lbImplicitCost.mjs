// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Is the kind-4 Bezout crescent actually slower than the klmn one? 1299 of 2141 corpus
// cubics are endpoint-degenerate (P1==P0 or P2==P3) and take Bezout. Timing follows
// probes/_bandCost.mjs: readPixels-synced so the GPU is drained, K draws/frame, median of 9.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHICH = process.argv[3] || 'tiger';
const TIGER =
  WHICH === 'tiger'
    ? readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8')
    : readFileSync(path.join(ROOT, '../fixtures/svg/' + WHICH + '.svg'), 'utf8');
const TAG = process.argv[2] || 'state';
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import * as WP from '/src/renderer/lbWorkerPool.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
const sync=()=>{const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};
window.__run=async(svg,n)=>{
  const sec=await importSvg(svg);
  const b=createBundle(gl,sec,{preferBezout:(new URL(location.href)).searchParams.get('bez')==='1'});
  r.prepareBundle&&r.prepareBundle(b);
  await r.awaitLbReady(b,30000).catch(()=>{});
  // The canvas must TRACK n: a viewport larger than the drawable just clips, and the
  // bigger resolution then reads as FASTER (2048 beat 1024 before this).
  const cv=document.getElementById('c'); cv.width=n; cv.height=n;
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  // count the mesh: how many cubic crescents carry a Bezout F vs klmn coords
  let bez=0, klm=0, verts=0;
  for(const m of (b._lbMeshes||[])) if(m&&m.vertexCount) verts+=m.vertexCount;
  const K=6, runs=[];
  for(let rep=0;rep<9;rep++){
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b);
    r.endFrame(); sync(); runs.push((performance.now()-t0)/K);
  }
  runs.sort((a,b)=>a-b);
  const st={dbg:'pb='+b._preferBezout, ms:+runs[4].toFixed(3), verts, meshes:(b._lbMeshes||[]).filter(m=>m&&!m.slug&&m.vertexCount>0).length,
             fallback:(b._lbMeshes||[]).filter(m=>m&&m.slug).length};
  b.dispose(); return st;
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': mime(pp) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/?bez=${process.env.BEZ || '0'}`, {
  waitUntil: 'load',
  timeout: 60000,
});
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
for (const N of [1024]) {
  const s = await pg.evaluate((t, n) => window.__run(t, n), TIGER, N);
  console.log(
    `[${TAG}] tiger@${String(N).padStart(4)}  ${String(s.ms).padStart(7)} ms   LBverts ${s.verts}   req=${s.dbg}`,
  );
}
await br.close();
server.close();
