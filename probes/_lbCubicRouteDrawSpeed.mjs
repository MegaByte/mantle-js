// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbCubicRouteDrawSpeed — does routing cubic shapes to the CDT partition instead of the fast
// path change RENDER speed, not just build speed?
//
// The two routes emit different meshes for the same shape: on a convex rounded square the fast
// path emits kinds 0:66 2:48 4:96 and the partition 0:6 2:6 4:18 12:18 — a quarter the primitives,
// with kind-12 bands standing in for crescent fans. Fewer, larger primitives is not automatically
// faster: LB is per-draw-fixed-cost and fillrate bound, and a band covers more pixels than the
// crescents it replaces. So it has to be measured, both as counts and as time.
//
// Both arms are built and drawn INSIDE ONE PAGE and interleaved A/B/A/B, because this machine's
// GPU drifts 30-40% between runs — only a within-run comparison is a measurement. The LB worker
// is suppressed: __LB_CUBIC_FASTPATH is read during the mesh BUILD and a global set here never
// reaches the worker, so the two arms would otherwise build identically.
//
// Reports wall, CPU-submit and (where EXT_disjoint_timer_query_webgl2 exists) GPU time. A GPU
// timer alone cannot see CPU work and reads inflated here (~70x against wall on this machine), so
// all three are shown and none is trusted alone.
//
// HOW TO READ IT, on 64 rounded squares (4 cubics each, pure LB, no Slug to dilute) where the two
// routes emit 3072 vs 22656 vertices — a 7.4x signal that nothing could hide:
//
//   STEADY STATE (same bundle every frame, VBO uploaded once): NO DIFFERENCE. 1.01x/1.01x/1.01x
//   across repeats, straddling 1.0, against an A/A floor of the same size. The frame is
//   fragment-bound and ink is identical, so 7.4x the vertices costs nothing.
//
//   PER-FRAME RE-UPLOAD (bundles alternating, so the shared unified VBO changes owner every
//   paint): partition is 5.5x cheaper, stable across repeats. Real for multi-bundle scenes and
//   for streaming; not what a single static bundle pays.
//
// FOUR TRAPS this PROBE AVOIDS, each of which produces a confident wrong answer:
//   1. performance.now() is clamped to 100us headless. Timing single frames and dividing by a
//      small batch leaves a grid coarser than the effect; two arms then report exactly equal.
//      Time one long run of BIG paints instead, and print the raw samples so the grid is visible.
//   2. Tiger's auto engine selection picks SLUG, so an unforced A/B times Slug against itself
//      and reports a confident 1.00x. Force the route and check debugStats.engines.
//   3. A timer query is not ready because finish() returned; it resolves on a later tick. Checked
//      once, it silently reports nothing.
//   4. A tie needs an A/A control before it means anything. On tiger the floor is +-3% and can
//      swing to 14% — bigger than the effect, which is why this uses synthetic pure-LB content
//      with a 7.4x signal rather than trying to out-sample the noise.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = process.env.ASSET || 'examples/tiger.svg';
const SVG = readFileSync(path.isAbsolute(ASSET) ? ASSET : path.join(ROOT, ASSET), 'utf8');
const N = Number(process.env.N || 8); // instances per frame (fillrate + per-draw mix)
const FRAMES = Number(process.env.FRAMES || 20);
const SIZE = Number(process.env.SIZE || 768);
const PAGE = `<!DOCTYPE html><body><canvas id=c width=${SIZE} height=${SIZE}></canvas><script type=module>
globalThis.Worker = undefined;                    // build on the main thread so the flag is seen
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${SIZE},${SIZE});
// FORCE LB. Tiger's auto selection picks Slug, and a Slug-vs-Slug A/B says nothing about two LB
// routes — the arms differed by 50x in submitted vertices and still timed identically because
// neither number was reaching the GPU as LB geometry.
renderer.setFillEngine({ route: 'lb', kernel: 'slug' });
const svgText = ${JSON.stringify(SVG)};
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

// one bundle per arm, each built under its own routing flag
const arms = {};
for (const [name, flag] of [['partition', false], ['fastpath', true]]) {
  globalThis.__MANTLE_DEBUG__ = true; globalThis.__LB_CUBIC_FASTPATH = flag;
  let draws = 0, verts = 0; const od = gl.drawArrays.bind(gl); gl.drawArrays = (m,f,c) => { draws++; verts += c; return od(m,f,c); };
  const b = createBundle(gl, await importSvg(svgText));
  renderer.prepareBundle(b); await renderer.awaitLbReady(b);
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b, { worldMatrix:[1,0,0,0,1,0,0,0,1] }); renderer.endFrame();
  gl.drawArrays = od;
  const st = renderer.debugStats || {};
  arms[name] = { bundle: b, drawsPerFrame: draws, vertsPerFrame: verts, gate: st.unifiedFillGate,
                 unified: st.unifiedFillDraws, routes: st.loopBlinnRouteCount,
                 engines: st.engines ? JSON.stringify(st.engines.draws || st.engines) : null,
                 meshes: (() => { try { const m = b._lbMeshes || b.lbMeshes; return m ? m.filter(Boolean).length + '/' + m.length : 'none'; } catch { return 'err'; } })() };
}
globalThis.__LB_CUBIC_FASTPATH = false;

const countFrame = (b) => { let draws = 0, verts = 0;
  const od = gl.drawArrays.bind(gl); gl.drawArrays = (m,f,c) => { draws++; verts += c; return od(m,f,c); };
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b, { worldMatrix:[1,0,0,0,1,0,0,0,1] }); renderer.endFrame();
  gl.drawArrays = od; return { draws, verts }; };
const paint = (b) => { renderer.beginFrame([1,1,1,1]);
  for (let i=0;i<${N};i++) renderer.drawBundle(b, { worldMatrix:[1,0,0,0,1,0, i*3, i*3, 1] });
  renderer.endFrame(); };
// ink guard: timing a blank render prices the change at the cost of the shading it skipped
const inkOf = (b) => { paint(b); const px = new Uint8Array(${SIZE}*${SIZE}*4); gl.readPixels(0,0,${SIZE},${SIZE},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0; for (let i=0;i<px.length;i+=4) if (px[i+3]>8 && !(px[i]>247&&px[i+1]>247&&px[i+2]>247)) n++; return n; };
const ink = { partition: inkOf(arms.partition.bundle), fastpath: inkOf(arms.fastpath.bundle) };
for (const k of ['partition','fastpath']) { countFrame(arms[k].bundle);            // warm, then measure
  const c = countFrame(arms[k].bundle); arms[k].drawsPerFrame = c.draws; arms[k].vertsPerFrame = c.verts; }

for (let w=0; w<20; w++) { paint(arms.partition.bundle); paint(arms.fastpath.bundle); }
gl.finish();
const BATCH = ${Number(process.env.BATCH || 25)};   // frames per sample: headless clamps performance.now() to 100us
const wall = { partition: [], fastpath: [] }, cpu = { partition: [], fastpath: [] }, gpu = { partition: [], fastpath: [] };
for (let f=0; f<${FRAMES}; f++) {
  for (const name of ['partition','fastpath']) {          // interleaved, not blocked
    let q = null; if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    const t0 = performance.now(); for (let k=0;k<BATCH;k++) paint(arms[name].bundle); const t1 = performance.now();
    if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.finish(); const t2 = performance.now();
    cpu[name].push((t1-t0)/BATCH); wall[name].push((t2-t0)/BATCH);
    if (q) { // a timer query is NOT ready just because finish() returned; it is resolved on a
             // later tick. Checking once and moving on is why the gpu row was always empty.
      for (let tries = 0; tries < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); tries++)
        await new Promise((r) => setTimeout(r, 0));
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT))
        gpu[name].push(gl.getQueryParameter(q, gl.QUERY_RESULT)/1e6/BATCH);
      gl.deleteQuery(q); }
  }
}
const paintK = (b, k) => { renderer.beginFrame([1,1,1,1]);
  for (let i=0;i<k;i++) renderer.drawBundle(b, { worldMatrix:[1,0,0,0,1,0, i*3, i*3, 1] });
  renderer.endFrame(); };
const timeK = (k) => { for (let w=0;w<10;w++) paintK(arms.partition.bundle, k); gl.finish();
  const s=[]; for (let f=0;f<12;f++){ const t0=performance.now(); for (let j=0;j<BATCH;j++) paintK(arms.partition.bundle,k); gl.finish(); s.push((performance.now()-t0)/BATCH); }
  return s.sort((a,b)=>a-b)[s.length>>1]; };
const control = { x1: timeK(${N}), x4: timeK(${N} * 4) };
// BLOCKED steady state, measured so the result can be DISBELIEVED properly.
//
// An earlier version reported 0.092ms vs 0.092ms and 0.370ms vs 0.370ms — exactly equal in two
// different configs, which is a smell, not a result. Three things can manufacture a fake tie:
//   * QUANTIZATION. performance.now() is clamped to 100us headless. Timing one frame at a time and
//     dividing by a batch of 25 leaves a 0.004ms grid; a real difference smaller than the grid
//     reads as zero. So this times ONE long run of BIG paints (0.1ms / BIG resolution).
//   * SKIPPED FRAMES. If a dirty gate elides a redundant repaint, both arms time a no-op and tie
//     at the floor. Checked by reading ink back AFTER the timed run, per arm.
//   * DILUTION. Tiger draws with lb AND slug; the arms differ only in the lb part, so a real LB
//     difference can vanish into a shared Slug cost. Reported as the per-arm engine split.
// Raw samples and the distinct-value count are reported so quantization is visible rather than
// assumed absent.
const BIG = ${Number(process.env.BIG || 400)};
const blocked = {}, blockedAll = {}, blockedRaw = {}, blockedInk = {};
const blockArm = { partition: arms.partition.bundle, fastpath: arms.fastpath.bundle,
                   aaA: arms.partition.bundle, aaB: arms.partition.bundle };
for (const pass of [0, 1]) for (const name of ['partition', 'fastpath', 'aaA', 'aaB']) {
  const b = blockArm[name];
  for (let w = 0; w < 40; w++) paint(b); gl.finish();
  const s2 = [];
  for (let f = 0; f < 5; f++) { const t0 = performance.now();
    for (let k = 0; k < BIG; k++) paint(b); gl.finish(); s2.push((performance.now() - t0) / BIG); }
  // POOL the samples; do not take min-of-mins. Best-of across passes picks each arm's luckiest
  // outlier, which is how a consistent ~5% gap got reported as 1.01x.
  (blockedAll[name] ||= []).push(...s2);
  if (pass === 1) { blockedRaw[name] = blockedAll[name].map((x) => +x.toFixed(5));
    const px = new Uint8Array(${SIZE}*${SIZE}*4); gl.readPixels(0,0,${SIZE},${SIZE},gl.RGBA,gl.UNSIGNED_BYTE,px);
    let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i+3] > 8 && !(px[i]>247&&px[i+1]>247&&px[i+2]>247)) n++;
    blockedInk[name] = n; }
}
const med = (a) => a.length ? a.slice().sort((x,y)=>x-y)[a.length>>1] : null;
for (const k of Object.keys(blockedAll)) { const a = blockedAll[k].slice().sort((x,y)=>x-y); blocked[k] = a[a.length>>1]; }
window.__out = { ink, hasGpuTimer: !!ext, control, blocked, blockedRaw, blockedInk, BIG,
  blockedMin: Object.fromEntries(Object.entries(blockedAll).map(([k,v]) => [k, Math.min(...v)])),
  arms: Object.fromEntries(Object.entries(arms).map(([k,v]) => [k, { draws: v.drawsPerFrame, verts: v.vertsPerFrame, gate: v.gate, unified: v.unified, routes: v.routes, engines: v.engines, meshes: v.meshes }])),
  wall: { partition: med(wall.partition), fastpath: med(wall.fastpath) },
  cpu:  { partition: med(cpu.partition),  fastpath: med(cpu.fastpath) },
  gpu:  { partition: med(gpu.partition),  fastpath: med(gpu.fastpath) } };
window.__ready = true;
</script></body>`;
const srv = http.createServer((q, r) => {
  try {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    r.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    r.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!r.headersSent) r.writeHead(404);
    r.end();
  }
});
await new Promise((x) => srv.listen(0, '127.0.0.1', x));
const port = srv.address().port;
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[pg]', e.message));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error('[pg]', m.text());
});
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready, { timeout: 180000 });
const o = await pg.evaluate(() => window.__out);
console.log(
  `\n  ${ASSET}  x${N} instances  ${SIZE}x${SIZE}  ${FRAMES} interleaved frame pairs  (GPU timer: ${o.hasGpuTimer ? 'yes' : 'no'})`,
);
console.log(
  `  ink: partition ${o.ink.partition}  fastpath ${o.ink.fastpath}` +
    (Math.abs(o.ink.partition - o.ink.fastpath) > 0.02 * Math.max(o.ink.partition, 1)
      ? '   <-- ARMS DRAW DIFFERENT AMOUNTS, timing is not comparable'
      : '   (comparable)'),
);
for (const k of ['partition', 'fastpath'])
  console.log(
    `  ${k.padEnd(10)} draws=${o.arms[k].draws}  VERTICES=${o.arms[k].verts}  unified=${o.arms[k].unified}  gate=${o.arms[k].gate}  lbMeshes=${o.arms[k].meshes}  engines=${o.arms[k].engines}`,
  );
if (o.arms.partition.verts === o.arms.fastpath.verts)
  console.log(
    '  <-- ARMS ARE IDENTICAL: the routing toggle did not take effect; timing below is meaningless',
  );
const scale = o.control.x4 / Math.max(o.control.x1, 1e-9);
console.log(
  `  HARNESS CHECK: ${N} instances ${o.control.x1.toFixed(3)}ms vs 4x ${o.control.x4.toFixed(3)}ms -> ${scale.toFixed(2)}x` +
    (scale > 2
      ? '  (instrument responds to load)'
      : '  <-- INSTRUMENT IS FLAT UNDER 4x LOAD; it is not measuring the draw'),
);
const row = (label, m) => {
  if (m.partition == null || m.fastpath == null) return;
  const r = m.fastpath / m.partition;
  console.log(
    `  ${label.padEnd(6)} partition ${m.partition.toFixed(3)}ms   fastpath ${m.fastpath.toFixed(3)}ms   -> partition is ${r >= 1 ? r.toFixed(2) + 'x FASTER' : (1 / r).toFixed(2) + 'x SLOWER'}`,
  );
};
row('wall', o.wall);
row('cpu', o.cpu);
row('gpu', o.gpu);
row('block', o.blocked); // steady state: same bundle many frames, no VBO owner thrash
const aa = o.blocked.aaB / o.blocked.aaA,
  ab = o.blocked.fastpath / o.blocked.partition;
console.log(
  `  A/A     ${o.blocked.aaA.toFixed(5)}ms vs ${o.blocked.aaB.toFixed(5)}ms  -> ${aa.toFixed(3)}x  == THE NOISE FLOOR (same bundle, both arms)`,
);
// The floor is never really zero: when A/A happens to land on 1.000 a 1% A/B gap would read as
// "real". Hold it to at least 3%, which is where repeated A/A runs on tiger actually sit.
const floor = Math.max(2 * Math.abs(aa - 1), 0.03);
console.log(
  `  A/B     ratio ${ab.toFixed(3)}x   ` +
    (Math.abs(ab - 1) > floor
      ? `exceeds the floor (+-${(100 * floor).toFixed(1)}%): a real difference`
      : `WITHIN the floor (+-${(100 * floor).toFixed(1)}%): not distinguishable from noise`),
);
for (const k of ['partition', 'fastpath']) {
  const r = o.blockedRaw[k],
    d = new Set(r).size;
  console.log(
    `    ${k.padEnd(10)} samples ${r.join(' ')}  distinct=${d}${d === 1 ? '  <-- ALL IDENTICAL: suspect quantization' : ''}  inkAfterTimedRun=${o.blockedInk[k]}${o.blockedInk[k] < 1000 ? '  <-- BLANK, frames were skipped' : ''}`,
  );
}
console.log(
  `    (${o.BIG} paints per timed run -> ${(0.1 / o.BIG).toFixed(5)}ms resolution against a 100us clock)`,
);
await br.close();
srv.close();
