// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchRouteWarm — CPatch BUILDS and then never DRAWS.
//
// A balance-bench row can read cpatchBuilt=1 with route=0: the converter produced its patches, the
// mesh landed in _lbMeshes, and every timed frame still went out through Slug. usable() drops such
// rows (warmFb != 0), so the tables stay right -- but an engine that cannot draw until some later
// frame is a real defect and not only a harness one.
//
// This asks the narrow question the bench cannot: frame by frame, after awaiting everything there
// is to await, which route does the draw take and is the fill variant the one the bundle needs?
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = +(process.env.SEGS || 16);
const poly = (cx, cy, r, n) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return 'M' + p.map((q, i) => (i ? 'L' : '') + q[0] + ' ' + q[1]).join(' ') + ' Z';
};
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="${poly(64, 64, 48, SEGS)}" fill="#265b9b"/></svg>`;
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SVG=${JSON.stringify(SVG)};
window.__run=async()=>{
  const c=document.createElement('canvas');c.width=256;c.height=256;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(256,256);
  // BOTH AXES, one call: the analytic ROUTE that carries the geometry and the KERNEL that shades
  // cover fragments.
  r.setFillEngine({route:'cpatch', kernel:'slug'});
  const b=createBundle(gl,await importSvg(SVG,{}));
  const steps=[];
  const snap=(tag)=>{const d=r.debugStats;const E=d.engines||{draws:{},declines:{}};steps.push({tag,
    engine:E.last||'-', drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-',
    declined:Object.entries(E.declines||{}).map(([k,v])=>k+'('+Object.keys(v).join(',')+')').join(' ')||'-',
    built:b._cpatchBuilt|0, conv:b._cpatchConv===undefined?'undef':(b._cpatchConv==='pending'?'pending':'map'),
    kindMask:b._lbKindMask|0, lbRoute:d.loopBlinnRouteCount|0, uni:d.unifiedFillDraws|0,
    warmFb:d.unifiedWarmFallbacks|0, hasLb:r._fillVariantHasLbFill?!!r._fillVariantHasLbFill(b):null,
    key:(r._lastFillVariantKey||'').split(',').filter(k=>/CPATCH|LB_FILL|CURVE_TEX/.test(k)).join('+')||'-'});};
  if(r.prepareBundle) r.prepareBundle(b);
  for(let i=0;i<600&&b._cpatchConv==='pending';i++) await new Promise(z=>setTimeout(z,5));
  if(r.prepareBundle) r.prepareBundle(b);
  snap('after prepare+conv');
  if(r.awaitLbReady) await r.awaitLbReady(b,60000);
  snap('after awaitLbReady');
  for(let f=0;f<6;f++){ r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame(); snap('frame '+f); }
  return steps;
};
window.__ready=1;
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
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
pg.on('console', (m) => {
  const t = m.text();
  if (/error|fail|link|compile|GL_|shader/i.test(t))
    console.error(' [console]', t.replace(/^[^:]*\]:/, '').slice(0, 600));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log('\n  stage               last     drew                declined');
for (const s of rows)
  console.log(
    '  ' + s.tag.padEnd(19) + String(s.engine).padEnd(9) + s.drew.padEnd(20) + s.declined,
  );
