// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Why does a STREAMED (lightweight, cover-quad-less) bundle not take the unified
// fill route? Reports the gate and the bundle's shape rather than inferring it.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkLine } from '/src/primitives/seg.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders);
const VBOX=[0,0,100,100];
const rectSegs=(x,y,w,h)=>[mkLine([x,y],[x+w,y]),mkLine([x+w,y],[x+w,y+h]),mkLine([x+w,y+h],[x,y+h]),mkLine([x,y+h],[x,y])];
const b=createBundle(gl, buildStreamableSections([{segs:rectSegs(10,10,28,28), fill:[1,0,0,1]}], VBOX, {lightweight:true}));
const snap=(tag)=>({tag, stream:!!b._lbStream, meshArr:Array.isArray(b._lbMeshes),
  meshLen:(b._lbMeshes||[]).length, meshOk:(b._lbMeshes||[]).filter(m=>m&&!m.slug&&m.vertexCount>0).length,
  dl:b.drawList?b.drawList.length:-1, cover:!!(b.coverQuadVboFloats||b.coverQuadFloats),
  gate:r.debugStats.unifiedFillGate||'none', uni:r.debugStats.unifiedFillDraws|0,
  cache:!!b._unifiedFill, lbMode:r.debugStats.lbFillMode||'?'});
const out=[snap('after-create')];
updateBundleGeometry(gl,b,[rectSegs(10,10,28,28)]); b.globalBBox=VBOX.slice();
out.push(snap('after-update'));
r.setViewport(100,100); r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame();
out.push(snap('after-draw1'));
r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame();
out.push(snap('after-draw2'));
window.out=out;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://l');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(u.pathname))));
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 120000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 30000 });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 60000 });
} catch {
  console.log('never finished');
  await br.close();
  server.close();
  process.exit(1);
}
for (const s of await pg.evaluate(() => window.out)) console.log(JSON.stringify(s));
await br.close();
server.close();
