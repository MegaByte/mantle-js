// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchWireCost — what it costs to get CPatch patches back from a worker, priced in process.
//
// The pooled build's RETURN PATH is ~300ms of tiger's ~1450ms (probes/_cpatchPoolBuild.mjs has an
// arm that reruns the identical conversion and discards the result in the worker). That number
// alone does not say what to DO about it, and the end-to-end timing cannot resolve a change worth
// less than its own run-to-run drift. This measures the pieces in one process, paired:
//
//   * cloning the FULL frames, which is what the worker returns
//   * cloning only {curves, inside}, from which everything else is derived
//   * rebuilding the rest with framePatch, which is what sending slim data costs instead
//   * encoding to one Float64Array and decoding it back, i.e. a typed-array wire format
//
// The last one is the one worth pricing before writing it: the decode has to allocate the same
// object graph the clone allocates, so the win is only the clone MACHINERY, and if that is small
// the wire format is not worth its own code.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { tigerCycles } from './_cpatchCycles.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<!doctype html><html><body><script type="module">
import { convertContour } from '/src/renderer/cpatchConvert.js';
const all = await (await fetch('/__cycles')).json();
window.__run = async () => {
  const patches = [];
  for (const c of all) { let r = null; try { r = convertContour(c, { maxCurves: 8, tolPx: 0.05, holes: null }); } catch {}
    if (r) for (const p of r.patches) patches.push(p); }
  const t0 = performance.now();
  const cloned = structuredClone(patches.map((p) => ({ curves: p.curves, inside: p.inside })));
  const cloneMs = performance.now() - t0;
  // What the worker ACTUALLY returns: the whole frame, implicits, cover and boxes included.
  const tF = performance.now();
  let fullMs = -1, fullErr = '';
  try { structuredClone(patches); fullMs = performance.now() - tF; }
  catch (e) { fullErr = String(e && e.message).slice(0, 80); }
  // And what rehydrating slim data costs instead: framePatch with the interior point supplied.
  const { framePatch } = await import('/src/renderer/cpatchConvert.js');
  const tR = performance.now();
  for (const p of patches) framePatch(p.curves, p.inside);
  const rehyMs = performance.now() - tR;
  // Encode: [nPatches][per patch: inX inY nCurves [per curve: tag nPts x y ...]]
  const t1 = performance.now();
  let n = 1;
  for (const p of patches) { n += 3; for (const c of p.curves) n += 2 + c.P.length * 2; }
  const buf = new Float64Array(n);
  let o = 0; buf[o++] = patches.length;
  for (const p of patches) {
    buf[o++] = p.inside[0]; buf[o++] = p.inside[1]; buf[o++] = p.curves.length;
    for (const c of p.curves) {
      buf[o++] = c.t === 'line' ? 0 : c.t === 'quad' ? 1 : c.t === 'cubic' ? 2 : 3;
      buf[o++] = c.P.length;
      for (const q of c.P) { buf[o++] = q[0]; buf[o++] = q[1]; }
    }
  }
  const encMs = performance.now() - t1;
  const t2 = performance.now();
  const TAG = ['line', 'quad', 'cubic', 'rquad'];
  let q2 = 0; const np = buf[q2++]; const out = new Array(np);
  for (let i = 0; i < np; i++) {
    const ix = buf[q2++], iy = buf[q2++], nc = buf[q2++];
    const curves = new Array(nc);
    for (let k = 0; k < nc; k++) {
      const tag = TAG[buf[q2++]], m = buf[q2++], P = new Array(m);
      for (let z = 0; z < m; z++) { P[z] = [buf[q2++], buf[q2++]]; }
      curves[k] = { t: tag, P };
    }
    out[i] = { curves, inside: [ix, iy] };
  }
  const decMs = performance.now() - t2;
  return { patches: patches.length, cloneMs, fullMs, fullErr, rehyMs, encMs, decMs, bytes: buf.length * 8, ok: out.length === np };
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
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log(`\n  ${o.patches} patches, ${(o.bytes / 1048576).toFixed(2)} MB encoded`);
console.log(`  clone {curves,inside}   ${o.cloneMs.toFixed(0)}ms`);
console.log(
  `  clone FULL frames       ${o.fullMs < 0 ? 'FAILED: ' + o.fullErr : o.fullMs.toFixed(0) + 'ms'}   <- what the worker returns today`,
);
console.log(
  `  rehydrate via framePatch ${o.rehyMs.toFixed(0)}ms   <- what sending slim data costs instead`,
);
console.log(`  encode            ${o.encMs.toFixed(0)}ms`);
console.log(`  decode            ${o.decMs.toFixed(0)}ms   (rebuilds the same object graph)`);
const slimTotal = o.cloneMs + o.rehyMs,
  wireTotal = o.encMs + o.decMs + o.rehyMs;
console.log('');
console.log(`  full frames over the wire   ${o.fullMs.toFixed(0)}ms   (today)`);
console.log(
  `  slim + rebuild              ${slimTotal.toFixed(0)}ms   saves ${(o.fullMs - slimTotal).toFixed(0)}ms`,
);
console.log(
  `  typed array + rebuild       ${wireTotal.toFixed(0)}ms   saves ${(slimTotal - wireTotal).toFixed(0)}ms MORE than slim`,
);
// The baseline for a wire FORMAT is the slim object form, not the fat one -- slimming is a few
// lines and gets most of it, so a binary format has to justify itself against what is left.
console.log(
  '  => a typed-array wire format is ' +
    (slimTotal - wireTotal > 40
      ? 'worth building'
      : 'NOT worth building: slimming already took the clone out'),
);
