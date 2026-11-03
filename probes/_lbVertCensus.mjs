// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbVertCensus — where do LB's triangles actually go?
// LB's per-fragment slope is ~0 (probes/_bandCost.mjs): its cost is vertex/triangle processing,
// resolution-independent. So the vertex budget IS the perf budget. Break it down by kind.
//   PAPER kinds : 0 interior · 1 quad · 2 cubic · 4 Bezout · 5 rational quad
//   AA machinery: 3 edge strip · 8 corner cap · 9 curve strip · 10 edge cap-strip · 11 crescent
//   SDF fast    : 6 circle · 7 annulus
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NAME = {
  0: 'interior',
  1: 'quad',
  2: 'cubic',
  3: 'edgeStrip',
  4: 'bezout',
  5: 'rquad',
  6: 'circleSDF',
  7: 'annulus',
  8: 'cornerCap',
  9: 'curveStrip',
  10: 'edgeCapStrip',
  11: 'crescent',
};
const PAPER = new Set([0, 1, 2, 4, 5]),
  AA = new Set([3, 8, 9, 10, 11]);
const SVGS = { 'tiger.svg': readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8') };
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
window.__run=async(svgs)=>{
  const out=[];
  for(const [name,txt] of Object.entries(svgs)){
    const b=createBundle(gl, await importSvg(txt)); r.prepareBundle(b);
    const kinds={}; let total=0, shapes=0;
    for(const m of (b._lbMeshes||[])){ if(!m||!m.verts) continue; shapes++;
      for(let i=0;i<m.vertexCount;i++){ const k=Math.floor(m.verts[i*24+5]+0.001);
        kinds[k]=(kinds[k]||0)+1; total++; } }
    out.push({name, kinds, total, shapes}); b.dispose();
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
for (const r of o) {
  console.log(
    `\n${r.name}: ${r.total} verts = ${(r.total / 3) | 0} tris over ${r.shapes} shapes (${(r.total / 3 / r.shapes).toFixed(0)} tris/shape)`,
  );
  let paper = 0,
    aa = 0,
    sdf = 0;
  for (const [k, n] of Object.entries(r.kinds).sort((a, b) => b[1] - a[1])) {
    const ki = +k,
      pct = ((100 * n) / r.total).toFixed(1);
    const cls = PAPER.has(ki) ? 'paper' : AA.has(ki) ? 'AA-machinery' : 'sdf';
    if (cls === 'paper') paper += n;
    else if (cls === 'AA-machinery') aa += n;
    else sdf += n;
    console.log(
      `  kind ${String(ki).padStart(2)} ${NAME[ki].padEnd(13)} ${String(n).padStart(7)} verts ${pct.padStart(5)}%  [${cls}]`,
    );
  }
  console.log(
    `  -> paper ${((100 * paper) / r.total).toFixed(1)}%   AA machinery ${((100 * aa) / r.total).toFixed(1)}%   sdf ${((100 * sdf) / r.total).toFixed(1)}%`,
  );
}
