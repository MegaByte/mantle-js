// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzPair — a fragment one shape paints correctly ALONE and loses in the COMPOSITE. Render an
// arbitrary SUBSET of the shapes and read the pixel, so the interaction can be narrowed to the
// shapes actually responsible instead of guessed at.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;
const SVG = readFileSync(path.join(ROOT, '../MantleSamples/Assets/Mantle/tiger.svg'), 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const SETS = (process.env.SETS || '35|12,35|0-35|all').split('|');
const PX = process.env.PXY || '145,102';
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { parseMetaBin } from '/src/core/metaBin.js';
import { clearLbMeshCaches } from '/src/renderer/morphDraw.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__run=async(svg,sets,pix)=>{
  const out=[];
  for (const set of sets) {
    clearLbMeshCaches();
    const sec=await importSvg(svg,{preserveViewport:true});
    const mm=parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    const MF=mm.metaFloats, ST=mm.floatsPerShape|0;
    if (set !== 'all') {
      const keep=new Set();
      for (const part of set.split(',')) {
        if (part.includes('-')) { const [a,b]=part.split('-').map(Number); for (let k=a;k<=b;k++) keep.add(k); }
        else keep.add(+part);
      }
      for (let s=0;s<mm.numShapes;s++) if (!keep.has(s)) MF[s*ST+7]=0;
    }
    const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
    const b=createBundle(gl,sec); if (r.prepareBundle) r.prepareBundle(b);
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    b.dispose(); if (r.dispose) r.dispose();
    const [i,jTop]=pix.split(',').map(Number);
    const j=jTop;                                  // the probe already reports bottom-up rows
    const o=(j*N+i)*4;
    out.push({set, rgb:[p[o],p[o+1],p[o+2]]});
  }
  return out;
};
</script></body></html>`;
const srv = http.createServer((q, s) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/') {
    s.writeHead(200, { 'content-type': 'text/html' });
    return s.end(HTML);
  }
  try {
    const p = path.join(ROOT, u);
    if (!p.startsWith(ROOT)) throw 0;
    const body = readFileSync(p);
    s.writeHead(200, {
      'content-type': u.endsWith('.js') || u.endsWith('.mjs') ? 'text/javascript' : 'text/plain',
    });
    s.end(body);
  } catch {
    s.writeHead(404);
    s.end('no');
  }
});
await new Promise((z) => srv.listen(0, z));
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'networkidle0' });
await pg.waitForFunction('!!window.__run', { timeout: 120000 });
for (const r of await pg.evaluate((s, a, p) => window.__run(s, a, p), SVG, SETS, PX))
  console.log(`  shapes ${r.set.padEnd(10)} -> rgb(${r.rgb.join(',')})`);
await br.close();
srv.close();
