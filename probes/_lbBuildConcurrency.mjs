// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbBuildConcurrency — where does multi-bundle load time actually go?
//
// Written to test whether lbWorkerPool's SINGLE worker serializes N bundles' LB
// builds, on the theory that a worker pool would parallelise them. It does not,
// and the split timer below is why:
//
//   n   total ms   prepare(main)   lb-wait(off)
//   1     1009.0         813.3          195.7
//   2     1941.9        1838.9          103.0
//   4     3156.5        3156.3            0.2
//
// The cost is the SYNCHRONOUS main-thread prepareBundle, not the worker queue. By
// n=4 the off-thread builds have already finished during the prepare loop, so the
// LB wait is 0.2ms and a worker pool has nothing left to overlap: a pool gains
// nothing and would pay for 4 module graphs.
//
// Keep this probe: it is how to re-answer "should the LB build fan out across
// cores?" and, more usefully, it isolates prepareBundle as the real serial cost.
//
// Bundles are made DISTINCT (per-copy coordinate jitter) so lbPack's
// similarity-invariant mesh reuse cannot dedupe the work and fake a win.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TIGER = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
// Hook Worker BEFORE any import can construct one. The pool is module-level and
// persists across iterations, so a worker made during an earlier n would be reused
// invisibly and read as "0 spawned".
window.__wk=0; const _OW=window.Worker;
window.Worker=function(...a){ window.__wk++; return new _OW(...a); };
window.Worker.prototype=_OW.prototype;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');

// Jitter every numeric coordinate slightly so each copy is geometrically distinct.
function variant(svg, k){
  if(k===0) return svg;
  let i=0;
  return svg.replace(/-?\\d+\\.?\\d*/g, (m)=>{
    const v=parseFloat(m); if(!isFinite(v)) return m;
    i++; return (v + ((i*37+k*101)%17)*0.001*k).toFixed(3);
  });
}

window.__run=async(svg, counts)=>{
  const out=[];
  for(const n of counts){
    // Build n distinct bundles, kick all their LB builds, wait for all.
    const bundles=[];
    for(let k=0;k<n;k++) bundles.push(createBundle(gl, await importSvg(variant(svg,k))));
    const t0=performance.now();
    // prepareBundle is SYNCHRONOUS main-thread work (occupancy, cull, cover packing,
    // GL uploads). Split it from the off-thread LB wait: only the wait can be
    // parallelised by a worker pool, so if prepare dominates the pool is irrelevant.
    for(const b of bundles) r.prepareBundle(b);
    const tPrep=performance.now()-t0;
    await Promise.all(bundles.map(b=>r.awaitLbReady(b, 120000)));
    const ms=performance.now()-t0;
    for(const b of bundles) b.dispose();
    out.push({n, ms:+ms.toFixed(1), per:+(ms/n).toFixed(1), workers:window.__wk, prep:+tPrep.toFixed(1), wait:+(ms-tPrep).toFixed(1)});
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
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => console.log('[' + m.type() + ']', m.text()));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const rows = await pg.evaluate((s, c) => window.__run(s, c), TIGER, [1, 2, 4]);
console.log('bundles   total ms   prepare(main)   lb-wait(off)   scaling');
const base = rows[0];
for (const r of rows) {
  const sc = (r.ms / base.ms).toFixed(2) + 'x';
  console.log(
    `${String(r.n).padStart(7)} ${String(r.ms).padStart(10)} ${String(r.prep).padStart(15)} ${String(r.wait).padStart(14)} ${sc.padStart(9)}`,
  );
}
console.log('\nprepare(main) is the serial cost; lb-wait shrinks as n grows because the');
console.log('off-thread builds overlap the main-thread prepare loop.');
console.log(`cores reported: ${await pg.evaluate(() => navigator.hardwareConcurrency)}`);
await br.close();
server.close();
