// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBuildTime — prepareBundle (LB mesh build) wall time + vertex count. The interior splitter
// dominates the build; draw time is insensitive to it (LB is not vertex-bound).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIGER = readFileSync(ROOT + '/examples/tiger.svg', 'utf8');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
window.__run=async(svg)=>{
  // The canonical-similarity cache is MODULE-level: only the FIRST build actually builds; every
  // later bundle of the same shapes is a clone. Timing a median over repeats measures the clone.
  const sec=await importSvg(svg);
  const b=createBundle(gl,sec);
  const t0=performance.now(); r.prepareBundle(b); const first=performance.now()-t0;
  let verts=0; for(const m of (b._lbMeshes||[])) if(m&&m.vertexCount) verts+=m.vertexCount;
  b.dispose();
  // a second, cached build for contrast
  const sec2=await importSvg(svg); const b2=createBundle(gl,sec2);
  const t1=performance.now(); r.prepareBundle(b2); const cached=performance.now()-t1; b2.dispose();
  return {first, cached, verts};
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
const o = await pg.evaluate((s) => window.__run(s), TIGER);
await br.close();
server.close();
console.log(
  `  tiger FIRST build ${o.first.toFixed(1)}ms   cached clone ${o.cached.toFixed(1)}ms   verts ${o.verts}`,
);
