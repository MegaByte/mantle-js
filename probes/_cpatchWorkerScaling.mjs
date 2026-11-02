// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchWorkerScaling — does fanning CPatch conversion across cores actually pay?
//
// Conversion is ~9ms per contour and a real asset has hundreds, so this is the one
// build step here big enough to divide. That is NOT a general claim about workers:
// a pool for LB builds does not pay, because its off-thread work is smaller than
// the serial prepareBundle it would overlap. So this
// measures rather than assumes, and reports the SERIAL baseline next to the pool.
//
// The inputs are geometrically DISTINCT (per-contour jitter). Identical contours
// would let any similarity cache dedupe the work and make the scaling vacuous —
// the trap the LB pool probe had to survive.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNT = +(process.env.COUNT || 96);
const HTML = `<!DOCTYPE html><html><body>
<script type="module">
import { convertContoursPooled, cpatchPoolSize, disposeCpatchPool } from '/src/renderer/cpatchWorkerPool.js';
import { convertContour } from '/src/renderer/cpatchConvert.js';
// A rounded-blob contour: cubics + lines, the mix real art produces. Jittered per
// index so no two contours are congruent.
function blob(i){
  const K=6, R=40+((i*7)%13), cx=100+((i*11)%17), cy=100+((i*13)%19);
  const P=(j)=>[cx+R*Math.cos(2*Math.PI*j/K+i*0.017), cy+R*Math.sin(2*Math.PI*j/K+i*0.017)];
  const out=[];
  for(let j=0;j<K;j++){
    const A=P(j), B=P(j+1);
    const mx=(A[0]+B[0])/2+(B[1]-A[1])*0.30+((i%5)*0.7), my=(A[1]+B[1])/2-(B[0]-A[0])*0.30;
    out.push({t:'cubic', P:[A,[A[0]+(mx-A[0])*0.66,A[1]+(my-A[1])*0.66],[B[0]+(mx-B[0])*0.66,B[1]+(my-B[1])*0.66],B]});
  }
  return out;
}
const CONTOURS=[]; for(let i=0;i<${COUNT};i++) CONTOURS.push(blob(i));
window.__run=async()=>{
  const poolN = cpatchPoolSize();
  // SERIAL baseline, same inputs, same code path (convertContour) on this thread.
  let t0=performance.now();
  let okSerial=0;
  for(const c of CONTOURS){ try{ const p=convertContour(c,{}); if(p) okSerial++; }catch{} }
  const serial=performance.now()-t0;
  // POOLED. Warm the workers first so spawn+module-load is not billed to the run.
  await convertContoursPooled(CONTOURS.slice(0,poolN),{});
  t0=performance.now();
  const res=await convertContoursPooled(CONTOURS,{});
  const pooled=performance.now()-t0;
  const okPool=res.filter(r=>r&&r.patches).length;
  // Patch-count agreement: a "speedup" that converts differently is not a speedup.
  let sameCount=0;
  for(let i=0;i<CONTOURS.length;i++){
    let ref=null; try{ ref=convertContour(CONTOURS[i],{}); }catch{}
    const got=res[i]&&res[i].patches;
    if(ref&&got&&ref.length===got.length) sameCount++;
  }
  disposeCpatchPool();
  return {poolN, serial, pooled, okSerial, okPool, sameCount, n:CONTOURS.length};
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
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 220)));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 200));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log(`\nCPatch conversion, ${o.n} distinct contours\n`);
console.log(`  pool size            ${o.poolN} workers`);
console.log(
  `  serial (main thread) ${o.serial.toFixed(0)} ms   (${(o.serial / o.n).toFixed(2)} ms/contour)`,
);
console.log(
  `  pooled               ${o.pooled.toFixed(0)} ms   (${(o.pooled / o.n).toFixed(2)} ms/contour)`,
);
console.log(
  `  SPEEDUP              ${(o.serial / Math.max(o.pooled, 1e-9)).toFixed(2)}x   of ${o.poolN}x ideal (${((o.serial / Math.max(o.pooled, 1e-9) / o.poolN) * 100).toFixed(0)}% efficiency)`,
);
console.log(`  converted            serial ${o.okSerial}/${o.n} · pooled ${o.okPool}/${o.n}`);
console.log(`  patch counts agree   ${o.sameCount}/${o.n}`);
if (o.sameCount !== o.n) {
  console.log('\nMISMATCH — the pool did not reproduce the serial conversion.');
  process.exit(1);
}
