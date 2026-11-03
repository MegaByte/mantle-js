// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _linkCost — how long does the FIRST draw take, i.e. the fill program's link?
// One tiny bundle, fresh browser: everything else is noise. This is what a game pays at
// scene start before anything appears.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><path fill="#3366cc" d="M10 10 L90 20 L50 90 Z"/></svg>';
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const t0=performance.now();
const r=createRenderer(gl,shaders,{}); r.setViewport(256,256); r.setLoopBlinnFill('off');
const tCreate=performance.now()-t0;
const b=createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
const t1=performance.now();
r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
const tFirst=performance.now()-t1;
const t2=performance.now();
for(let i=0;i<5;i++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); } sync();
const tNext=(performance.now()-t2)/5;
window.__out={tCreate:+tCreate.toFixed(1), tFirst:+tFirst.toFixed(1), tNext:+tNext.toFixed(2)};
window.__ready=true;</script></body></html>`;
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
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu-shader-disk-cache'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 240000 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log(
  `[${process.env.TAG || ''}] createRenderer ${o.tCreate}ms | FIRST draw ${o.tFirst}ms | steady ${o.tNext}ms`,
);
