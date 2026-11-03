// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gwnAaCeiling — what is the ENTIRE budget for making GWN's AA cheaper?
//
// GWN's AA keeps the two nearest candidate segments (GwnSdfCand c1, c2) across the
// whole traversal: every leaf within cellR gets a full gwnSegEval (implicit,
// gradient, slab, travel frame, fill sign) and is ranked. That also defeats subtree
// culling — winding-only can substitute a FAR node's chord for its whole run, the
// AA path cannot. fillPass records the GWN kernel at ~+15-70% occupancy.
//
// Any cheaper AA (e.g. Li 2016-style sampled winding) wins at most what removing
// c1/c2 + the ranking recovers. GWN_WINDING_ONLY already compiles exactly that
// kernel, so the SDF-vs-winding-only delta IS the ceiling — measurable today,
// without writing a sampled variant.
//
// Timing follows probes/_bandCost.mjs: readPixels sync so the GPU is actually
// drained (a bare submit loop measures CPU submit, not shading), K draws per
// timed frame, median of 9.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIGER = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');
// Curve-dense, interior-heavy: where GWN is chosen and where AA cost concentrates.
const PETALS = (() => {
  const K = 10,
    c = 200,
    r = 150,
    P = (j) => [c + r * Math.cos((2 * Math.PI * j) / K), c + r * Math.sin((2 * Math.PI * j) / K)];
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 1; j <= K; j++) {
    const m = [
      c + r * 1.7 * Math.cos((2 * Math.PI * (j - 0.5)) / K),
      c + r * 1.7 * Math.sin((2 * Math.PI * (j - 0.5)) / K),
    ];
    d += `Q ${m[0].toFixed(3)} ${m[1].toFixed(3)} ${P(j % K)[0].toFixed(3)} ${P(j % K)[1].toFixed(3)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}Z" fill="#2a6"/></svg>`;
})();

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// SDF arm = the shipping GWN AA kernel. WIND arm = the same traversal with
// MANTLE_HARD_TREE, which compiles GWN_WINDING_ONLY: no c1/c2, no ranking, no ramp.
//
// EVERY ARM CARRIES ITS DEFINES. createRenderer(gl,shaders,{}) with no MANTLE_GWN, no
// MANTLE_GWN_SDF, and Loop-Blinn left on 'auto' compares SLUG (or LB) against GWN's winding-only
// tree route, and "the AA share of GWN fill" is then not about GWN's AA at all. An arm is named
// by what it COMPILES, so both arms pin the engine (LB off)
// and __run refuses to report a row whose drawn variant key is not the one the arm asked for.
const rSdf =createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rSdf.setLoopBlinnFill('off');
const rWind=createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_HARD_TREE','MANTLE_GWN']}); rWind.setLoopBlinnFill('off');
// The define every arm's DRAWN program must carry, and the one that tells the two apart.
const WANT={sdf:['MANTLE_GWN','MANTLE_GWN_SDF'], wind:['MANTLE_GWN','MANTLE_HARD_TREE']};
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
window.__run=async(cases,n)=>{
  const out=[];
  for(const cs of cases){
    const sec=await importSvg(cs.svg,{gwnTree:true});
    const row={name:cs.name};
    for(const [tag,r] of [['sdf',rSdf],['wind',rWind]]){
      const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
      r.setViewport(n,n); gl.viewport(0,0,n,n);
      const K=6, runs=[];
      for(let rep=0;rep<9;rep++){
        r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
        const t0=performance.now(); r.beginFrame([1,1,1,1]);
        for(let i=0;i<K;i++) r.drawBundle(b);
        r.endFrame(); sync(); runs.push((performance.now()-t0)/K);
      }
      runs.sort((a,b)=>a-b); row[tag]=+runs[4].toFixed(3);
      row[tag+'Gate']=r.debugStats.unifiedFillGate||'-';
      // THE DRAW PROOF. debugStats.fillVariantKey is the UNIFIED route's readiness query and is
      // empty on unstroked art; drawnFillVariantKey is the variant the fill pass last BOUND.
      const key=r.debugStats.drawnFillVariantKey||'';
      row[tag+'Key']=key;
      row[tag+'Ok']=WANT[tag].every(d=>key.split('|').includes(d));
      b.dispose();
    }
    row.delta=+(row.sdf-row.wind).toFixed(3);
    row.pct=+(100*(row.sdf-row.wind)/row.sdf).toFixed(1);
    out.push(row);
  }
  return out;
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
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
pg.on('console', (m) => {
  if (m.type() !== 'log') console.log('[' + m.type() + ']', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
console.log(
  `renderer: ${await pg.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2');
    const d = g.getExtension('WEBGL_debug_renderer_info');
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?';
  })}`,
);
const rows = await pg.evaluate(
  (t, p) =>
    window.__run(
      [
        { name: 'tiger', svg: t },
        { name: 'petals', svg: p },
      ],
      1024,
    ),
  TIGER,
  PETALS,
);
console.log('\nasset     sdf ms   wind ms    delta   AA share of GWN fill   arms proved');
for (const r of rows)
  console.log(
    `${r.name.padEnd(9)} ${String(r.sdf).padStart(6)} ${String(r.wind).padStart(9)} ${String(r.delta).padStart(8)}   ${String(r.pct + '%').padStart(7)}` +
      `                ${r.sdfOk && r.windOk ? 'yes' : 'NO — ' + (r.sdfOk ? '' : 'sdf drew ' + (r.sdfKey || '(none)') + ' ') + (r.windOk ? '' : 'wind drew ' + (r.windKey || '(none)'))}`,
  );
const proved = rows.every((r) => r.sdfOk && r.windOk);
console.log('\nThe AA share is the CEILING: no cheaper AA can recover more than this.');
if (!proved)
  console.log(
    'DO NOT READ THE TABLE: an arm did not draw the kernel it names. Every row above is about some other shader.',
  );
await br.close();
server.close();
