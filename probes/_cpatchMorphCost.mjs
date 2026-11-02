// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMorphCost — what does a CPatch morph cost PER FRAME, against the engines it replaces?
//
// A CPatch morph does not mix two packs in the vertex shader the way a Loop-Blinn morph does. Its
// coefficients ARE the geometry, so every frame re-poses on the CPU: layoutAt -> applyLayout ->
// framePatch -> packCPatchMorphFrame -> one texSubImage2D. That is real main-thread work the
// other engines do not do, and it is the number this exists to put on record. The certificate
// that makes the pose legal is NOT measured here — it runs once, in a worker (see
// _cpatchMorphRender for that figure).
//
// Three traps this shares with _balanceBench and does the same thing about:
//   * a single frame is below the clock's resolution, so frames are batched and the batch is
//     sized from a probe frame;
//   * wall time is CPU + submit, not shading. EXT_disjoint_timer_query_webgl2 gives the GPU
//     number where the driver has it, and GPU_DISJOINT invalidates a sample rather than
//     averaging a lie into the result;
//   * t MOVES every frame. Holding it still measures a cache, not a morph — and for CPatch
//     specifically it would skip the re-pose entirely.
//
// The GPU medians move between RUNS by about a factor of two on this machine even at 60 reps, so
// the spread is printed rather than a single number: a ratio taken from two medians one run apart
// is not a measurement, and three consecutive runs of an earlier version of this probe reported
// 1.68x, 3.00x and 4.33x for the same pair.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const REPS = +(process.env.REPS || 60);
// PAIR=quad is here because Loop-Blinn declines the cubic pair: its morph worker returns nothing
// usable for four-cubic circles, which is a capability decline and not an economic one, so the
// only honest way to get LB into the comparison is to give it geometry it can serve.
const PAIRS = {
  near: [
    'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z',
    'M20 5 C30 5 35 10 35 20 C35 30 30 35 20 35 C10 35 5 30 5 20 C5 10 10 5 20 5 Z',
  ],
  wide: [
    'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z',
    'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z',
  ],
  quad: [
    'M20 4 Q36 4 36 20 Q36 36 20 36 Q4 36 4 20 Q4 4 20 4 Z',
    'M20 7 Q33 3 34 20 Q35 33 20 34 Q7 35 6 20 Q5 7 20 7 Z',
  ],
};
const [A, B] = PAIRS[process.env.PAIR || 'near'] || PAIRS.near;
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#fff"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const S = ${N}, REPS = ${REPS};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null);

// A STATIC CPatch arm on the same geometry, to price what the morph packer gives up. The morph
// frame turns the CELL SPLIT off — the structure has to stay fixed across a segment, and cell
// counts move with the geometry — so every fragment evaluates every curve of its patch, where the
// static route evaluates only the curves a bound proves can still matter.
async function staticArm() {
  const r = createRenderer(gl, shaders, { cpatchFill: true, cpatchOpts: { interiorN: 8 }, aacFill: false });
  r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(${JSON.stringify(svg(A))}));
  if (r.prepareBundle) { try { r.prepareBundle(b); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  frame();
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  for (let i = 0; i < 40; i++) { frame(); if (r.precompileFills) { try { r.precompileFills(); } catch {} } await sleep(0); }
  gl.finish();
  globalThis.__lp = 0; globalThis.__lpCpu = 0; globalThis.__fr = 0;
  const t0 = performance.now(); frame(); gl.finish();
  const probe = Math.max(0.02, performance.now() - t0);
  const batch = Math.max(1, Math.min(8, Math.ceil(2 / probe)));
  const gpu = [];
  for (let rep = 0; rep < REPS; rep++) {
    let q = null;
    if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    for (let f = 0; f < batch; f++) frame();
    if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.finish();
    if (q) {
      for (let p2 = 0; p2 < 2000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); p2++) await sleep(0);
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT))
        gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / batch);
      gl.deleteQuery(q);
    }
    await sleep(1);
  }
  const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  return { mode: 'cpatch-static', wall: 0, gpu: median(gpu), gpuLo: pct(gpu, 0.1), gpuHi: pct(gpu, 0.9), batch: 0,
           patches: 0, kind: 0, planMs: 0, ufPerFrame: 1, lbPerFrame: 0, forced: true,
           cells: b._cpatchCells | 0, built: b._cpatchBuilt | 0, stats: '-',
           morphMeshes: -1, lbGate: '-', aacEngine: '-', aacDraws: 0, matchedAll: false,
           mmBuilt: false, mmInFlight: false, memDenied: false, segs: '-', curvesAB: '-' };
}

async function arm(mode) {
  // FORCE each engine rather than let it choose. 'auto' declines on economics, and an arm that
  // declined is not a comparison — it is Slug wearing another name. Only a genuine inability to
  // render should remove an arm, and that shows up as its route count staying zero.
  const opt = mode === 'cpatch'
    ? { cpatchFill: true, cpatchOpts: { interiorN: 8, gpuBlend: ${JSON.stringify(process.env.BLEND === '1')} }, aacFill: false, unifiedMorph: true }
    : mode === 'aac' ? { aacFill: true, unifiedMorph: false }
    : { aacFill: false, unifiedMorph: mode === 'lb' };
  const r = createRenderer(gl, shaders, opt);
  r.setLoopBlinnFill(mode === 'slug' || mode === 'aac' ? 'off' : 'on');
  const morph = createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(svg(A))})),
                                     createBundle(gl, await importSvg(${JSON.stringify(svg(B))})));
  const b = morph.bundle || morph;
  let k = 0;
  const frame = () => {
    globalThis.__fr = (globalThis.__fr | 0) + 1;
    k = (k + 1) & 1023;
    // HOLD: t never moves, so the draw is identical frame to frame and only the per-frame
    // machinery around it varies. Held-with-blend minus held-without prices the blend PASS with
    // nothing else changing.
    // HOLD  t never moves: setT returns early, so NO per-frame morph machinery runs at all.
    // MICRO t moves by 1e-9: setT runs in full — every lerp pass, every upload — but the pose,
    //       the segment and the fill are the same as HOLD's. MICRO minus HOLD is therefore the
    //       per-frame machinery ALONE, with the draw held constant, and moving minus MICRO is
    //       what actually depends on the pose changing.
    // SETDUP prices setT itself. Extra calls at t values a nanometre apart do the SAME work and
    // the last call always lands on 0.5, so the pose, the segment and the draw are identical to
    // MICRO's — only the number of setT invocations changes. Delta over DUP is one setT.
    const DUP = ${JSON.stringify(+(process.env.SETDUP || 0))};
    for (let d = 0; d < DUP; d++) morph.setT(0.5 + 1e-9 * (d + 2));
    morph.setT(${JSON.stringify(process.env.HOLD === '1')} ? 0.5
             : ${JSON.stringify(process.env.MICRO === '1' || +(process.env.SETDUP || 0) > 0)} ? 0.5 + 1e-9 * (k & 1)
             : 0.15 + 0.7 * (k / 1023));
    if (r.prepareBundle) { try { r.prepareBundle(b); } catch {} }
    r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(morph, {}); r.endFrame();
  };
  // WAIT FOR THE ENGINE TO ENGAGE. Both analytic morph routes build off-thread and render with
  // something else until they land — LB's pair meshes in the LB worker, CPatch's certificate in
  // the CPatch pool. Measuring before either arrives measures the fallback, and an "LB" number
  // is then Slug's.
  if (mode === 'cpatch') {
    morph.setT(0);
    if (r.prepareBundle) { try { r.prepareBundle(b); } catch {} }
    for (let i = 0; i < 1200 && b._cpatchMorphPlan === 'pending'; i++) await sleep(25);
  }
  frame();
  if (mode === 'lb') {
    for (let i = 0; i < 600 && !b._morphMeshes; i++) { frame(); await sleep(10); }
  }
  if (r.awaitLbReady) { try { await r.awaitLbReady(morph, 20000); } catch {} }
  for (let i = 0; i < 40; i++) { frame(); if (r.precompileFills) { try { r.precompileFills(); } catch {} } await sleep(0); }
  gl.finish();

  const t0 = performance.now(); frame(); gl.finish();
  const probe = Math.max(0.02, performance.now() - t0);
  const batch = Math.max(1, Math.min(8, Math.ceil(2 / probe)));
  const wall = [], gpu = [];
  for (let rep = 0; rep < REPS; rep++) {
    let q = null;
    if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    const t = performance.now();
    for (let f = 0; f < batch; f++) frame();
    if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.finish();
    wall.push((performance.now() - t) / batch);
    if (q) {
      for (let p = 0; p < 2000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); p++) await sleep(0);
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT))
        gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / batch);
      gl.deleteQuery(q);
    }
    await sleep(1);
  }
  // EVERY ARM MUST PROVE IT RAN ITS OWN ENGINE. An arm that silently fell back to Slug reports
  // Slug's number under another name, and the comparison then says nothing — which is exactly
  // what "LB 1.300 vs Slug 1.368" looked like on the first run of this probe.
  // loopBlinnRouteCount is the counter that exists; r._lbRouteCount is an internal field the
  // probe cannot see, and reading it gave 0 for an arm that was routing perfectly well.
  const armLp = globalThis.__lp | 0, armLpCpu = globalThis.__lpCpu | 0, armFr = globalThis.__fr | 0;
  const D = () => (r.debugStats || {});
  const before = { uf: D().unifiedFillDraws | 0, lb: (D().loopBlinnRouteCount | 0) + (D().loopBlinnMorphRouteCount | 0) };
  frame(); frame(); gl.finish();
  const after = { uf: D().unifiedFillDraws | 0, lb: (D().loopBlinnRouteCount | 0) + (D().loopBlinnMorphRouteCount | 0) };
  const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  const out = { mode, wall: median(wall), gpu: median(gpu), batch,
                lp: armFr ? +(armLp / armFr).toFixed(2) : -1, lpCpu: armLpCpu,
                gpuLo: pct(gpu, 0.1), gpuHi: pct(gpu, 0.9),
                ufPerFrame: (after.uf - before.uf) / 2, lbPerFrame: (after.lb - before.lb) / 2,
                // WHY an arm declined, in the terms the route itself uses.
                morphMeshes: b._morphMeshes ? b._morphMeshes.filter(Boolean).length : -1,
                // AAC is a hard shader switch: aacFill true means draw with AAC, not eventually.
                // It has no route counter to prove, so the option itself is the evidence.
                forced: mode === 'aac',
                matchedAll: !!(b._morphSrc && b._morphSrc.matchedAll),
                mmBuilt: !!b._morphMeshesBuilt,
                mmInFlight: !!(b._morphWorkerSrc && b._morphWorkerSrc === b._morphSrc),
                memDenied: !!b._lbMemDenied,
                lbGate: r._lbClassicLastGate || r._unifiedFillGate || '-',
                aacEngine: (r.debugStats && r.debugStats.autoEngine) || '-',
                aacDraws: (r.debugStats && (r.debugStats.aacDraws | 0)) || 0,
                stats: r.debugStats ? JSON.stringify(Object.fromEntries(
                  Object.entries(r.debugStats).filter(([, v]) => typeof v === 'number' && v)
                )).slice(0, 400) : '-',
                planMs: b._cpatchPlanMs | 0, built: b._cpatchBuilt | 0,
                patches: (b._lbMeshes && b._lbMeshes[0]) ? (b._lbMeshes[0].vertexCount / 6) : 0,
                kind: (b._lbMeshes && b._lbMeshes[0]) ? (b._lbMeshes[0].kindMask | 0) : 0 };
  try { morph.dispose(); } catch {}
  return out;
}
const out = [];
for (const m of ['slug', 'lb', 'aac', 'cpatch']) out.push(await arm(m));
out.push(await staticArm());
window.__out = { arms: out, timer: !!ext };
window.__ready = 1;
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const fs = await import('fs');
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const body = fs.readFileSync(p);
    const ext2 = path.extname(p);
    res.writeHead(200, {
      'Content-Type':
        ext2 === '.js'
          ? 'text/javascript'
          : ext2 === '.glsl'
            ? 'text/plain'
            : 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--use-angle=metal', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === 1', { timeout: 600000 });
const o = await page.evaluate('window.__out');
await browser.close();
server.close();

console.log(
  `\nCPatch MORPH per-frame cost, ${N}x${N}, t moving every frame` +
    (o.timer ? '' : '  (no GPU timer on this driver)') +
    '\n',
);
console.log(
  '  lerp passes/frame: ' +
    o.arms.map((a) => a.mode + ' ' + a.lp + (a.lpCpu ? ' (CPU!)' : '')).join('  '),
);
console.log(
  '  engine |  wall ms |      gpu ms (p10..p90) | patches | kind | plan ms | unified/frame',
);
for (const a of o.arms) {
  const g =
    a.gpu == null
      ? '          -           '
      : (a.gpu.toFixed(3) + ' (' + a.gpuLo.toFixed(3) + '..' + a.gpuHi.toFixed(3) + ')').padStart(
          22,
        );
  console.log(
    '  ' +
      a.mode.padEnd(6) +
      ' | ' +
      a.wall.toFixed(3).padStart(8) +
      ' | ' +
      g +
      ' | ' +
      String(a.patches).padStart(7) +
      ' | ' +
      String(a.kind).padStart(4) +
      ' | ' +
      (a.planMs ? String(a.planMs) : '-').padStart(7) +
      ' | ' +
      String(a.ufPerFrame).padStart(13) +
      (a.cells ? '  cells ' + a.cells : '') +
      (a.mode !== 'slug' && !a.forced && !a.ufPerFrame && !a.lbPerFrame
        ? '  <-- DID NOT ROUTE (Slug under another name)'
        : ''),
  );
}
const cp = o.arms.find((a) => a.mode === 'cpatch');
const sl = o.arms.find((a) => a.mode === 'slug');
if (!cp || !cp.built || !(cp.kind & (1 << 14))) {
  console.log('\nCPATCH ARM DID NOT RUN — the numbers above compare something else.');
} else if (cp.gpu && sl && sl.gpu) {
  console.log(
    '\n  CPatch morph draws ' +
      (sl.gpu / cp.gpu).toFixed(2) +
      'x faster than the Slug morph' +
      ' on the GPU this run (' +
      (sl.gpuLo / cp.gpuHi).toFixed(2) +
      'x..' +
      (sl.gpuHi / cp.gpuLo).toFixed(2) +
      'x across the spread), for ' +
      ((cp.wall - sl.wall) * 1000).toFixed(0) +
      ' microseconds more CPU a frame — the re-pose: layout, frame, pack, upload.',
  );
  for (const a of o.arms) console.log('   ' + a.mode.padEnd(6) + ' stats ' + a.stats);
  for (const a of o.arms) {
    if (a.mode === 'slug' || a.mode === 'cpatch') continue;
    if (a.ufPerFrame || a.lbPerFrame || a.forced) {
      console.log('  vs ' + a.mode + ': ' + (a.gpu / cp.gpu).toFixed(2) + 'x on the GPU medians.');
    } else {
      console.log(
        '  ' +
          a.mode +
          ' DECLINED — morphMeshes ' +
          a.morphMeshes +
          ', matchedAll ' +
          a.matchedAll +
          ', buildLatched ' +
          a.mmBuilt +
          ', workerInFlight ' +
          a.mmInFlight +
          ', memDenied ' +
          a.memDenied +
          '. Not a comparison.',
      );
    }
  }
}
