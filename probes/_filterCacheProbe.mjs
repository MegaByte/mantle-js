// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Is the STORE blank or the HIT blank? Reads the center of the cache texture and of
// the source right after the store, with the cache forced on.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const S = 160;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
<defs><filter id="b"><feGaussianBlur stdDeviation="1.2"/></filter></defs>
<circle cx="20" cy="20" r="12" fill="#3060c0" filter="url(#b)"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S=${S};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{aacFill:false,unifiedFilterCache:true,unifiedFilterCacheProbe:true});
const b=createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
r.setLoopBlinnFill('on'); try{r.prepareBundle(b);}catch{}
if(r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
const frame=()=>{r.setViewport(S,S); r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame();};
for(let i=0;i<6;i++){frame(); if(r.precompileFills){try{r.precompileFills();}catch{}}}
const st=r.debugStats;
const shots=[];
for(let i=0;i<3;i++){ frame();
  const px=new Uint8Array(S*S*4); gl.readPixels(0,0,S,S,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let k=0;k<S*S;k++){const o=k*4; if(px[o]>8||px[o+1]>8||px[o+2]>8) ink++;}
  shots.push({ink, store:r.debugStats.unifiedFilterStorePx, src:r.debugStats.unifiedFilterSrcPx,
               hits:r.debugStats.unifiedFilterCacheHits|0, filt:r.debugStats.unifiedFilterDraws|0, blitProg:r.debugStats.unifiedFilterBlitProg});
}
window.out={shots, gate:r.debugStats.unifiedFillGate};
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
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 30000 });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 200000 });
} catch {
  console.log('never finished');
  await br.close();
  server.close();
  process.exit(1);
}
console.log(JSON.stringify(await pg.evaluate(() => window.out), null, 1));
await br.close();
server.close();
