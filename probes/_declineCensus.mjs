// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Which unified-route declines actually FIRE on real morph content?
// The remaining reasons classic LB is still reachable are morph-seg-mismatch and
// colr-graph; this counts them across a morph sweep rather than reasoning about them.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const S = 200;
const A = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="#3060c0" d="M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z"/><circle cx="12" cy="12" r="6" fill="#c04030"/></svg>`;
const B = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="#30a040" d="M20 8 C28 8 32 14 32 20 C32 28 26 34 20 34 C12 34 8 26 8 20 C8 12 14 8 20 8 Z"/><circle cx="28" cy="28" r="9" fill="#d08020"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const S=${S};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders); r.setViewport(S,S);
const bA=createBundle(gl,await importSvg(${JSON.stringify(A)})), bB=createBundle(gl,await importSvg(${JSON.stringify(B)}));
const m=createShapeMorph(gl,bA,bB);
if(r.awaitLbReady){try{await r.awaitLbReady(m);}catch{}}
const gates={};
for(let i=0;i<=20;i++){ const t=i/20; m.setT(t);
  r.beginFrame([0,0,0,1]); r.drawBundle(m); r.endFrame();
  const g=r.debugStats.unifiedFillGate||'?'; gates[g]=(gates[g]|0)+1; }
const st=r.debugStats;
window.out={gates, colr:st.unifiedColrDeclines|0, uni:st.unifiedFillDraws|0};
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
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 150000 });
} catch {
  console.log('never finished');
  await br.close();
  server.close();
  process.exit(1);
}
console.log(JSON.stringify(await pg.evaluate(() => window.out)));
await br.close();
server.close();
