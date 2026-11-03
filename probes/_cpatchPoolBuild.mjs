// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchPoolBuild — what the POOLED contour conversion actually buys, end to end.
//
// The claim under test is not "the pool converts faster" (it does, trivially: the work divides).
// It is that the conversion produces THE same DECOMPOSITION, because a build that is fast and
// geometrically different is not a speedup, it is a regression with a good stopwatch.
//
// IN THE BROWSER, because the pool is DOM Workers. Under Node `typeof Worker === 'undefined'`
// and convertContoursPooled degrades to a synchronous in-thread conversion by design -- so a
// Node run of this probe measures serial against serial and reports a truthful, useless 1.0x.
//
// The result shape is a trap worth naming: convertContour returns {patches, stats}, and both the
// worker and the sync fallback put that whole object in a field they call `patches`. The cache
// consumer unwraps it correctly, so the pipeline is right; a reader who assumes `.patches` is an
// array gets 0 and concludes the pool is broken.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { tigerCycles } from './_cpatchCycles.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = +(process.env.LIMIT || 0);

const HTML = `<!doctype html><html><body><script type="module">
// The cycles are built in NODE and fetched as data: _cpatchCycles.mjs reads the SVG with fs,
// so importing it here kills the module and the page never signals ready.
import { convertContour } from '/src/renderer/cpatchConvert.js';
import { convertContoursPooled, cpatchPoolSize } from '/src/renderer/cpatchWorkerPool.js';
const LIMIT = ${LIMIT};
const all = await (await fetch('/__cycles')).json();
const contours = LIMIT ? all.slice(0, LIMIT) : all;
const OPTS = { maxCurves: 8, tolPx: 0.05, holes: null };
const nOf = (r) => (r && r.patches && r.patches.patches && r.patches.patches.length) || 0;
window.__run = async () => {
  const t0 = performance.now();
  const serialEach = [];
  for (const cs of contours) {
    let r = null; try { r = convertContour(cs, OPTS); } catch { r = null; }
    serialEach.push((r && r.patches && r.patches.length) || 0);
  }
  const serialMs = performance.now() - t0;
  // WARM THE POOL OUTSIDE THE TIMED REGION. Spawning 8 workers and compiling the converter
  // module in each is a one-time cost that would otherwise be charged to the parallel speedup.
  const tw = performance.now();
  await convertContoursPooled([contours[0]], OPTS);
  const warmMs = performance.now() - tw;
  const t1 = performance.now();
  const res = await convertContoursPooled(contours, OPTS);
  const pooledMs = performance.now() - t1;
  // Same conversion, results DISCARDED in the worker: the difference is what marshalling costs.
  const t3 = performance.now();
  await convertContoursPooled(contours, { ...OPTS, __countOnly: true });
  const countMs = performance.now() - t3;
  const pooledEach = (res || []).map(nOf);
  let agree = 0; const bad = [];
  for (let i = 0; i < serialEach.length; i++) {
    if (serialEach[i] === pooledEach[i]) agree++;
    else if (bad.length < 6) bad.push('#'+i+' '+serialEach[i]+'vs'+pooledEach[i]);
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return { n: contours.length, workers: cpatchPoolSize(), serialMs, pooledMs, countMs, warmMs,
           serialPatches: sum(serialEach), pooledPatches: sum(pooledEach), agree, bad };
};
window.__ready = true;
</script></body></html>`;
const CYCLES = JSON.stringify(tigerCycles().cycles);
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/__cycles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(CYCLES);
      return;
    }
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
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 240)));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 220));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log(`\ncontours ${o.n}, pool ${o.workers} workers\n`);
console.log(`  serial  ${o.serialMs.toFixed(0).padStart(6)}ms   ${o.serialPatches} patches`);
console.log(`  pooled  ${o.pooledMs.toFixed(0).padStart(6)}ms   ${o.pooledPatches} patches`);
console.log(`  speedup ${(o.serialMs / Math.max(o.pooledMs, 1e-9)).toFixed(2)}x`);
console.log(
  `  no-return ${o.countMs.toFixed(0)}ms  (same work, patches discarded in the worker => marshalling is ${(o.pooledMs - o.countMs).toFixed(0)}ms)`,
);
console.log(
  `  warm-up ${o.warmMs.toFixed(0)}ms (spawn + module compile, outside the timed region)`,
);
console.log(
  `  patch counts agree ${o.agree}/${o.n}` + (o.bad.length ? `  MISMATCH ${o.bad.join(' ')}` : ''),
);
const ok = o.agree === o.n && o.pooledPatches === o.serialPatches;
console.log(
  '\n' +
    (ok
      ? 'PASS: pooled == serial, ' + (o.serialMs / Math.max(o.pooledMs, 1e-9)).toFixed(2) + 'x'
      : 'FAIL: pooled conversion differs from serial'),
);
if (!ok) process.exit(1);
