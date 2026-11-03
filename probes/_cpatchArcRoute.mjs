// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchArcRoute — does the CPatch route actually take ARCS, or does it decline to Slug?
//
// The converter harness returns null for every arc ring, and the static-ink audit's arc rows come
// back at ink ratio exactly 1.000 with 0 structural pixels at every segment count -- which is what
// a DECLINE looks like, because then Slug is drawing both arms. A row that passes because the
// engine under test never ran is worse than a failing row.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = +(process.env.SEGS || 16);
const ring = (fam) => {
  const cx = 64,
    cy = 64,
    r = 44,
    P = [];
  for (let i = 0; i < SEGS; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SEGS;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = 'M' + P[0][0].toFixed(4) + ' ' + P[0][1].toFixed(4);
  for (let i = 0; i < SEGS; i++) {
    const p = P[i],
      q = P[(i + 1) % SEGS],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2,
      bx = cx + (mx - cx) * 1.18,
      by = cy + (my - cy) * 1.18;
    d +=
      fam === 'arc'
        ? ' A' + r + ' ' + r + ' 0 0 1 ' + q[0].toFixed(4) + ' ' + q[1].toFixed(4)
        : fam === 'line'
          ? ' L' + q[0].toFixed(4) + ' ' + q[1].toFixed(4)
          : ' Q' +
            bx.toFixed(4) +
            ' ' +
            by.toFixed(4) +
            ' ' +
            q[0].toFixed(4) +
            ' ' +
            q[1].toFixed(4);
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="' +
    d +
    ' Z" fill="#265b9b"/></svg>'
  );
};
const PAGE = `<!doctype html><body><canvas id=c width=256 height=256></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SV=${JSON.stringify({ arc: ring('arc'), quad: ring('quad'), line: ring('line') })};
const out={};
for (const fam of ['line','quad','arc']) {
  const r=createRenderer(gl,shaders,{cpatchFill:true});
  r.setViewport(256,256); r.setFillEngine({route:'cpatch'});
  const b=createBundle(gl,await importSvg(SV[fam])); r.prepareBundle(b);
  if(r.awaitEngine){try{await r.awaitEngine(b,'cpatch',60000);}catch{}}
  r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();
  const e=r.debugStats.engines&&r.debugStats.engines.draws||{};
  out[fam]={drew:Object.keys(e).filter(k=>e[k]>0).join('+')||'none',
            built:b._cpatchBuilt|0, bail:b._cpatchBail||null,
            dropped:b._cpatchDropped|0, unres:b._cpatchUnresolved|0};
}
window.__out=out;
</script>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser({ headless: 'new', args, protocolTimeout: 600000 });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__out', { timeout: 300000 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log(`\n  ${SEGS}-segment ring, renderer asked for CPatch:\n`);
for (const f of ['line', 'quad', 'arc'])
  console.log(
    `    ${f.padEnd(5)} drew ${String(o[f].drew).padEnd(8)} cpatchBuilt ${String(o[f].built).padEnd(4)} dropped ${String(o[f].dropped).padEnd(4)} unresolved ${String(o[f].unres).padEnd(4)} ${o[f].bail ? 'bail: ' + o[f].bail.slice(0, 90) : ''}`,
  );
