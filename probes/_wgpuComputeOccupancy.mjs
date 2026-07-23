// _wgpuComputeOccupancy — can the occupancy-grid build (occupancy.worker.js) move to a
// WebGPU compute shader for a real win?
//
// The hypothesis under test: buildOccupancyGrid is O(G²·segs) point-in-shape testing, which is
// embarrassingly parallel, so it should be the strongest GPU-offload candidate of our worker jobs.
//
// This probe prices that honestly, which means pricing the ROUND TRIP, not the kernel:
//
//   1. FLOOR      — an empty compute dispatch + mapAsync readback. Fixed latency any offload
//                   must beat. If a whole CPU job costs less than the floor, the answer is no
//                   before a single kernel is written.
//   2. CORRECTNESS— the GPU grid must be BIT-IDENTICAL to the real JS buildOccupancyGrid (it is
//                   imported here, not reimplemented, so the two cannot drift). The renderer's
//                   interior-skip is only output-identical because every SOLID_IN cell is proven
//                   interior AND 1-cell-eroded; a GPU grid that differs by one bit is a rendering
//                   bug, not a rounding detail. Gated loudly.
//   3. WALL TIME  — CPU vs GPU including CPU prep + upload + dispatch + readback. A build job's
//                   result is needed to draw, so kernel-only time is a fiction.
//
// Sweeps G and segment count over the ranges the real code uses (see _occG=24 in
// svg/bundleFinalize.js, _GWN_GRID_BASE=24 clamped to 64 in svg/textures.js; segment counts
// measured off examples/tiger.svg: min 4 / median 18 / max 168 over its 37 eligible shapes).
//
// Also runs a BATCHED case: the real worker gets an ARRAY of ~37 independent small grids. One
// dispatch per grid would pay the floor 37 times, so the only GPU design worth measuring packs
// every shape into a single dispatch. That is the best case, and it is the one reported.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HTML = String.raw`<!DOCTYPE html><html><body><canvas id="c" width="8" height="8"></canvas>
<script type="module">
import { buildOccupancyGrid } from '/src/svg/occupancy.js';
import { mkQuad } from '/src/svg/segment.js';
import { pathBbox } from '/src/svg/bbox.js';

// ---- content: a closed quadratic star ring, seg count = the sweep knob. Genuine curves, so
//      the flatten produces the same variable-length runs the real importer's shapes do.
function makeSegs(nSeg) {
  const cx = 500, cy = 500, R = 460, r = 300;
  const P = (a, rad) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const rr = (j) => (j % 2 ? r : R);
  const segs = [];
  for (let i = 0; i < nSeg; i++) {
    const a0 = (i / nSeg) * 2 * Math.PI, a1 = ((i + 1) / nSeg) * 2 * Math.PI, am = (a0 + a1) / 2;
    const p0 = P(a0, rr(i)), p2 = P(a1, rr(i + 1));
    const mid = P(am, (rr(i) + rr(i + 1)) / 2 * 1.08);
    const p1 = [2 * mid[0] - (p0[0] + p2[0]) / 2, 2 * mid[1] - (p0[1] + p2[1]) / 2];
    segs.push(mkQuad(p0, p1, p2));
  }
  return segs;
}

// ---- CPU-side prep shared by the GPU path: per-seg sample count + prefix offsets.
// This MIRRORS occupancy.js segSpan()/flattenInto()'s n exactly (same formula, same caps) so the
// GPU flattens the identical point set. It is O(segs) (a few hundred), and it is charged to the
// GPU's wall time because the GPU cannot produce the offsets without a prefix sum of its own.
function prep(segs, bbox, G) {
  const x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3];
  const cw = (x1 - x0) / G, ch = (y1 - y0) / G;
  const minCell = Math.min(cw, ch);
  // segSpan for a QUAD: |p1-p2| + |p2-p3| (occupancy.js walks p1..p4, skipping nulls)
  const packed = [];      // per seg: [n, offset, x1,y1, x2,y2, x3,y3]  (stride 8)
  let off = 0;
  for (const s of segs) {
    const L = Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1])
            + Math.hypot(s.p3[0] - s.p2[0], s.p3[1] - s.p2[1]);
    const n = Math.max(1, Math.min(4096, Math.ceil(L / (minCell * 0.5))));
    packed.push(n, off, s.p1[0], s.p1[1], s.p2[0], s.p2[1], s.p3[0], s.p3[1]);
    off += n + 1;                                   // flattenInto emits n+1 samples
  }
  return { segData: Float32Array.from(packed), nSeg: segs.length, nPts: off, cw, ch, x0, y0 };
}

// ---- WGSL: three kernels, mirroring occupancy.js phase for phase.
//   flattenK  — one workgroup per seg; emits the n+1 De Casteljau samples. Fully parallel.
//   boundK    — one workgroup per seg; each chord atomicOr's the cells its bbox spans.
//   cellK     — one thread per cell; 3x3 erosion gate, then the ray-crossing walk over every
//               chord. THIS is the O(G²·segs) kernel the whole hypothesis rests on.
const WGSL = ` + '`' + `
struct P {
  x0: f32, y0: f32, cw: f32, ch: f32,
  G: u32, nSeg: u32, nPts: u32, evenOdd: u32,
  nJobs: u32,
};
@group(0) @binding(0) var<uniform> U: P;
@group(0) @binding(1) var<storage, read>       segData: array<f32>;
@group(0) @binding(2) var<storage, read_write> pts:     array<f32>;      // xy interleaved
@group(0) @binding(3) var<storage, read_write> bnd:     array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> bits:    array<u32>;

@compute @workgroup_size(64)
fn flattenK(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let s = wg.x;
  if (s >= U.nSeg) { return; }
  let b = s * 8u;
  let n = u32(segData[b]); let off = u32(segData[b + 1u]);
  let ax = segData[b+2u]; let ay = segData[b+3u];
  let bx = segData[b+4u]; let by = segData[b+5u];
  let cx = segData[b+6u]; let cy = segData[b+7u];
  var i = li.x;
  loop {
    if (i > n) { break; }
    let t = f32(i) / f32(n); let u = 1.0 - t;
    let px = u*u*ax + 2.0*u*t*bx + t*t*cx;
    let py = u*u*ay + 2.0*u*t*by + t*t*cy;
    pts[(off + i) * 2u] = px; pts[(off + i) * 2u + 1u] = py;
    i = i + 64u;
  }
}

@compute @workgroup_size(64)
fn boundK(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let s = wg.x;
  if (s >= U.nSeg) { return; }
  let b = s * 8u;
  let n = u32(segData[b]); let off = u32(segData[b + 1u]);
  let G = i32(U.G);
  var i = li.x;
  loop {
    if (i >= n) { break; }                      // n chords between n+1 samples
    let ax = pts[(off+i)*2u]; let ay = pts[(off+i)*2u+1u];
    let bx = pts[(off+i+1u)*2u]; let by = pts[(off+i+1u)*2u+1u];
    var gx0 = i32(floor((min(ax,bx) - U.x0) / U.cw)); var gx1 = i32(floor((max(ax,bx) - U.x0) / U.cw));
    var gy0 = i32(floor((min(ay,by) - U.y0) / U.ch)); var gy1 = i32(floor((max(ay,by) - U.y0) / U.ch));
    gx0 = max(gx0, 0); gy0 = max(gy0, 0);
    gx1 = min(gx1, G - 1); gy1 = min(gy1, G - 1);
    var gy = gy0;
    loop {
      if (gy > gy1) { break; }
      var gx = gx0;
      loop {
        if (gx > gx1) { break; }
        atomicOr(&bnd[u32(gy * G + gx)], 1u);
        gx = gx + 1;
      }
      gy = gy + 1;
    }
    i = i + 64u;
  }
}

fn clearAt(gx: i32, gy: i32) -> bool {
  let G = i32(U.G);
  if (gx < 0 || gx >= G || gy < 0 || gy >= G) { return false; }
  return atomicLoad(&bnd[u32(gy * G + gx)]) == 0u;
}

@compute @workgroup_size(64)
fn cellK(@builtin(global_invocation_id) gid: vec3<u32>) {
  let G = U.G;
  if (gid.x >= G * G) { return; }
  let gx = i32(gid.x % G); let gy = i32(gid.x / G);
  bits[gid.x] = 0u;
  if (!clearAt(gx, gy)) { return; }
  if (!clearAt(gx-1,gy) || !clearAt(gx+1,gy) || !clearAt(gx,gy-1) || !clearAt(gx,gy+1)
   || !clearAt(gx-1,gy-1) || !clearAt(gx+1,gy-1) || !clearAt(gx-1,gy+1) || !clearAt(gx+1,gy+1)) { return; }
  let px = U.x0 + (f32(gx) + 0.5) * U.cw;
  let py = U.y0 + (f32(gy) + 0.5) * U.ch;
  // insideRuns: chords stay WITHIN a run, exactly as the JS does.
  var cross: i32 = 0; var wind: i32 = 0;
  for (var s: u32 = 0u; s < U.nSeg; s = s + 1u) {
    let b = s * 8u;
    let n = u32(segData[b]); let off = u32(segData[b + 1u]);
    for (var i: u32 = 0u; i < n; i = i + 1u) {
      let ax = pts[(off+i)*2u]; let ay = pts[(off+i)*2u+1u];
      let bx = pts[(off+i+1u)*2u]; let by = pts[(off+i+1u)*2u+1u];
      if ((ay > py) == (by > py)) { continue; }
      let t = (py - ay) / (by - ay);
      if (ax + t * (bx - ax) > px) { cross = cross + 1; wind = wind + select(-1, 1, by > ay); }
    }
  }
  var inside: bool;
  if (U.evenOdd == 1u) { inside = (cross & 1) == 1; } else { inside = wind != 0; }
  if (inside) { bits[gid.x] = 1u; }
}

@compute @workgroup_size(64)
fn nopK() { }

// ---- BATCHED variant: every shape's grid in ONE dispatch. This is the only GPU design that
// could ever pay, because it amortises the round-trip floor across the whole job list instead
// of paying it per shape. Layout is SoA: jobs[] holds each shape's bbox/cell size, segData is
// stride 12 with a jobId per segment, and bits is N*G*G.
struct J { x0: f32, y0: f32, cw: f32, ch: f32, segOff: u32, nSeg: u32, evenOdd: u32, pad: u32 };
@group(0) @binding(5) var<storage, read> jobs: array<J>;

@compute @workgroup_size(64)
fn flattenB(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let s = wg.x;
  if (s >= U.nSeg) { return; }                 // U.nSeg = TOTAL segs across all jobs
  let b = s * 12u;
  let n = u32(segData[b]); let off = u32(segData[b + 1u]);
  let ax = segData[b+2u]; let ay = segData[b+3u];
  let bx = segData[b+4u]; let by = segData[b+5u];
  let cx = segData[b+6u]; let cy = segData[b+7u];
  var i = li.x;
  loop {
    if (i > n) { break; }
    let t = f32(i) / f32(n); let u = 1.0 - t;
    pts[(off + i) * 2u]      = u*u*ax + 2.0*u*t*bx + t*t*cx;
    pts[(off + i) * 2u + 1u] = u*u*ay + 2.0*u*t*by + t*t*cy;
    i = i + 64u;
  }
}

@compute @workgroup_size(64)
fn boundB(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let s = wg.x;
  if (s >= U.nSeg) { return; }
  let b = s * 12u;
  let n = u32(segData[b]); let off = u32(segData[b + 1u]);
  let jid = u32(segData[b + 8u]);
  let J0 = jobs[jid];
  let G = i32(U.G);
  let base = i32(jid) * G * G;
  var i = li.x;
  loop {
    if (i >= n) { break; }
    let ax = pts[(off+i)*2u]; let ay = pts[(off+i)*2u+1u];
    let bx = pts[(off+i+1u)*2u]; let by = pts[(off+i+1u)*2u+1u];
    var gx0 = i32(floor((min(ax,bx) - J0.x0) / J0.cw)); var gx1 = i32(floor((max(ax,bx) - J0.x0) / J0.cw));
    var gy0 = i32(floor((min(ay,by) - J0.y0) / J0.ch)); var gy1 = i32(floor((max(ay,by) - J0.y0) / J0.ch));
    gx0 = max(gx0, 0); gy0 = max(gy0, 0);
    gx1 = min(gx1, G - 1); gy1 = min(gy1, G - 1);
    var gy = gy0;
    loop {
      if (gy > gy1) { break; }
      var gx = gx0;
      loop {
        if (gx > gx1) { break; }
        atomicOr(&bnd[u32(base + gy * G + gx)], 1u);
        gx = gx + 1;
      }
      gy = gy + 1;
    }
    i = i + 64u;
  }
}

fn clearB(base: i32, gx: i32, gy: i32) -> bool {
  let G = i32(U.G);
  if (gx < 0 || gx >= G || gy < 0 || gy >= G) { return false; }
  return atomicLoad(&bnd[u32(base + gy * G + gx)]) == 0u;
}

@compute @workgroup_size(64)
fn cellB(@builtin(global_invocation_id) gid: vec3<u32>) {
  let G = U.G;
  let cellsPer = G * G;
  if (gid.x >= cellsPer * U.nJobs) { return; }
  let jid = gid.x / cellsPer;
  let c = gid.x % cellsPer;
  let gx = i32(c % G); let gy = i32(c / G);
  let J0 = jobs[jid];
  let base = i32(jid) * i32(cellsPer);
  bits[gid.x] = 0u;
  if (!clearB(base, gx, gy)) { return; }
  if (!clearB(base,gx-1,gy) || !clearB(base,gx+1,gy) || !clearB(base,gx,gy-1) || !clearB(base,gx,gy+1)
   || !clearB(base,gx-1,gy-1) || !clearB(base,gx+1,gy-1) || !clearB(base,gx-1,gy+1) || !clearB(base,gx+1,gy+1)) { return; }
  let px = J0.x0 + (f32(gx) + 0.5) * J0.cw;
  let py = J0.y0 + (f32(gy) + 0.5) * J0.ch;
  var cross: i32 = 0; var wind: i32 = 0;
  for (var s: u32 = 0u; s < J0.nSeg; s = s + 1u) {
    let b = (J0.segOff + s) * 12u;
    let n = u32(segData[b]); let off = u32(segData[b + 1u]);
    for (var i: u32 = 0u; i < n; i = i + 1u) {
      let ax = pts[(off+i)*2u]; let ay = pts[(off+i)*2u+1u];
      let bx = pts[(off+i+1u)*2u]; let by = pts[(off+i+1u)*2u+1u];
      if ((ay > py) == (by > py)) { continue; }
      let t = (py - ay) / (by - ay);
      if (ax + t * (bx - ax) > px) { cross = cross + 1; wind = wind + select(-1, 1, by > ay); }
    }
  }
  var inside: bool;
  if (J0.evenOdd == 1u) { inside = (cross & 1) == 1; } else { inside = wind != 0; }
  if (inside) { bits[gid.x] = 1u; }
}
` + '`' + `;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const out = { iso: self.crossOriginIsolated };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const device = await adapter.requestDevice();
  out.adapter = (adapter.info && (adapter.info.description || adapter.info.architecture)) || '?';
  const mod = device.createShaderModule({ code: WGSL });
  const ci = await mod.getCompilationInfo();
  const errs = ci.messages.filter((m) => m.type === 'error');
  if (errs.length) throw new Error('WGSL: ' + errs.map((m) => m.lineNum + ':' + m.message).join(' | '));

  // ---------- 1) round-trip FLOOR: trivial dispatch + mapAsync readback ----------
  {
    const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'nopK' } });
    const dst = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = () => device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const once = async () => {
      const r = rb();
      const enc = device.createCommandEncoder();
      const p = enc.beginComputePass(); p.setPipeline(pipe); p.dispatchWorkgroups(1); p.end();
      enc.copyBufferToBuffer(dst, 0, r, 0, 256);
      device.queue.submit([enc.finish()]);
      await r.mapAsync(GPUMapMode.READ); r.unmap(); r.destroy();
    };
    for (let i = 0; i < 20; i++) await once();          // warm
    const ts = [];
    for (let i = 0; i < 200; i++) { const t0 = performance.now(); await once(); ts.push(performance.now() - t0); }
    ts.sort((a, b) => a - b);
    out.floor = { min: ts[0], p50: ts[100], p90: ts[180] };
    // submit-only (no readback): isolates how much of the floor is the map round trip
    const ts2 = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      const p = enc.beginComputePass(); p.setPipeline(pipe); p.dispatchWorkgroups(1); p.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      ts2.push(performance.now() - t0);
    }
    ts2.sort((a, b) => a - b);
    out.floorNoReadback = { min: ts2[0], p50: ts2[100] };
  }

  // ---------- GPU grid build (one shape) ----------
  // EXPLICIT bind-group layout, not layout:'auto'. Auto-layout derives the layout from the
  // bindings a kernel actually references, so flattenK (which never touches bnd/bits) would get
  // a 3-entry layout and the 5-entry bind group below would be a validation error — which
  // WebGPU reports asynchronously, leaving the readback silently all-zero. That failure mode
  // looks exactly like "the GPU disagrees with the CPU", so it must be designed out.
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
  ] });
  const plo = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipes = {};
  for (const k of ['flattenK', 'boundK', 'cellK', 'flattenB', 'boundB', 'cellB'])
    pipes[k] = device.createComputePipeline({ layout: plo, compute: { module: mod, entryPoint: k } });
  // The single-shape path never reads the jobs[] buffer, but the shared pipeline layout declares
  // it, so it needs a placeholder to satisfy the bind group.
  const dummyJobs = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE });
  // Any validation/OOM error must fail the probe loudly rather than corrupt a timing number.
  device.addEventListener('uncapturederror', (e) => { window.__gpuErr = String(e.error && e.error.message || e.error); });

  async function gpuGrid(segs, bbox, evenOdd, G, timed) {
    const t0 = performance.now();
    const P = prep(segs, bbox, G);
    const uni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mk = (bytes, extra) => device.createBuffer({ size: Math.max(bytes, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (extra || 0) });
    const segB = mk(P.segData.byteLength);
    const ptsB = mk(P.nPts * 8);
    const bndB = mk(G * G * 4);
    const bitB = mk(G * G * 4, GPUBufferUsage.COPY_SRC);
    const rbB = device.createBuffer({ size: G * G * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeBuffer(segB, 0, P.segData);
    const ub = new ArrayBuffer(48);
    new Float32Array(ub, 0, 4).set([P.x0, P.y0, P.cw, P.ch]);
    new Uint32Array(ub, 16, 5).set([G, P.nSeg, P.nPts, evenOdd ? 1 : 0, 1]);
    device.queue.writeBuffer(uni, 0, ub);
    const bg = device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: uni } }, { binding: 1, resource: { buffer: segB } },
      { binding: 2, resource: { buffer: ptsB } }, { binding: 3, resource: { buffer: bndB } },
      { binding: 4, resource: { buffer: bitB } }, { binding: 5, resource: { buffer: dummyJobs } }] });
    const enc = device.createCommandEncoder();
    enc.clearBuffer(bndB);
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, bg);
    // Three dispatches in ONE pass: boundK reads flattenK's points and cellK reads boundK's
    // grid, so each needs the previous complete. WebGPU orders dispatches within a pass, so
    // this is the correct (and cheapest) barrier — no extra submits, no extra round trips.
    pass.setPipeline(pipes.flattenK); pass.dispatchWorkgroups(P.nSeg);
    pass.setPipeline(pipes.boundK);   pass.dispatchWorkgroups(P.nSeg);
    pass.setPipeline(pipes.cellK);    pass.dispatchWorkgroups(Math.ceil(G * G / 64));
    pass.end();
    enc.copyBufferToBuffer(bitB, 0, rbB, 0, G * G * 4);
    device.queue.submit([enc.finish()]);
    await rbB.mapAsync(GPUMapMode.READ);
    const u32 = new Uint32Array(rbB.getMappedRange().slice(0));
    rbB.unmap();
    const ms = performance.now() - t0;
    const bits = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) bits[i] = u32[i] ? 1 : 0;
    for (const b of [uni, segB, ptsB, bndB, bitB, rbB]) b.destroy();
    return { bits, ms, nPts: P.nPts };
  }

  // ---------- 2) sweep: G x segs, correctness + wall time ----------
  const GS = [16, 24, 32, 48, 64];              // real: _occG=24; GWN tier-3 clamps to 64
  const SEGS = [8, 18, 64, 168, 512];           // real tiger: min 4 / med 18 / max 168
  out.sweep = [];
  for (const nSeg of SEGS) {
    const segs = makeSegs(nSeg);
    const bbox = pathBbox(segs);
    for (const G of GS) {
      // CPU: the REAL implementation. minInteriorFrac 0 so it always returns bits (the 0.15
      // gate is a post-hoc reject, not part of the math under test).
      const cpuOnce = () => buildOccupancyGrid(segs, bbox, false, { grid: G, minInteriorFrac: 0 });
      cpuOnce();
      const cts = [];
      for (let r = 0; r < 25; r++) { const t0 = performance.now(); cpuOnce(); cts.push(performance.now() - t0); }
      cts.sort((a, b) => a - b);
      const cpu = cts[0];
      const ref = cpuOnce();
      await gpuGrid(segs, bbox, false, G, false);      // warm
      const gts = [];
      let g = null;
      for (let r = 0; r < 15; r++) { g = await gpuGrid(segs, bbox, false, G, true); gts.push(g.ms); }
      gts.sort((a, b) => a - b);
      let diff = 0;
      for (let i = 0; i < G * G; i++) if ((ref.bits[i] | 0) !== (g.bits[i] | 0)) diff++;
      let solid = 0; for (let i = 0; i < G * G; i++) solid += ref.bits[i];
      out.sweep.push({ nSeg, G, nPts: g.nPts, cpu, gpu: gts[0], gpuP50: gts[7], diff, solid, cells: G * G });
    }
  }

  // ---------- 3) batched: the real worker's job list in ONE dispatch ----------
  // 37 shapes is what examples/tiger.svg actually queues. Per-shape dispatch pays the floor 37
  // times; the batched number below is the GPU's best case.
  {
    const N = 37, G = 24;
    const jobs = [];
    for (let i = 0; i < N; i++) jobs.push(makeSegs(18));     // tiger's median seg count
    const bbox = pathBbox(jobs[0]);
    let cpuTot = 0;
    for (const s of jobs) { const t0 = performance.now(); buildOccupancyGrid(s, bbox, false, { grid: G, minInteriorFrac: 0 }); cpuTot += performance.now() - t0; }
    // (a) GPU, one dispatch per job — the naive port. Pays the floor N times.
    let gpuSeq = 0;
    for (const s of jobs) { const r = await gpuGrid(s, bbox, false, G, true); gpuSeq += r.ms; }
    // (b) GPU, ALL jobs in ONE dispatch — the best case the design can reach.
    const gpuBatch = async (jobList, bbox, G) => {
      const t0 = performance.now();
      const seg = [], jt = [], jtU = [];
      let ptOff = 0, segOff = 0;
      for (let j = 0; j < jobList.length; j++) {
        const P = prep(jobList[j], bbox, G);
        for (let s = 0; s < P.nSeg; s++) {
          const b = s * 8;
          seg.push(P.segData[b], P.segData[b + 1] + ptOff, P.segData[b + 2], P.segData[b + 3],
                   P.segData[b + 4], P.segData[b + 5], P.segData[b + 6], P.segData[b + 7], j, 0, 0, 0);
        }
        jt.push(P.x0, P.y0, P.cw, P.ch);
        jtU.push(segOff, P.nSeg, 0, 0);
        ptOff += P.nPts; segOff += P.nSeg;
      }
      const nSegTot = segOff, nCells = jobList.length * G * G;
      const segData = Float32Array.from(seg);
      // jobs[] is a mixed f32/u32 struct — build it as one ArrayBuffer with two views.
      const jb = new ArrayBuffer(jobList.length * 32);
      for (let j = 0; j < jobList.length; j++) {
        new Float32Array(jb, j * 32, 4).set([jt[j * 4], jt[j * 4 + 1], jt[j * 4 + 2], jt[j * 4 + 3]]);
        new Uint32Array(jb, j * 32 + 16, 4).set([jtU[j * 4], jtU[j * 4 + 1], 0, 0]);
      }
      const uni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const mk = (bytes, extra) => device.createBuffer({ size: Math.max(bytes, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (extra || 0) });
      const segB = mk(segData.byteLength), ptsB = mk(ptOff * 8), bndB = mk(nCells * 4);
      const bitB = mk(nCells * 4, GPUBufferUsage.COPY_SRC), jobB = mk(jb.byteLength);
      const rbB = device.createBuffer({ size: nCells * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.queue.writeBuffer(segB, 0, segData); device.queue.writeBuffer(jobB, 0, jb);
      const ub = new ArrayBuffer(48);
      new Uint32Array(ub, 16, 5).set([G, nSegTot, ptOff, 0, jobList.length]);
      device.queue.writeBuffer(uni, 0, ub);
      const bg = device.createBindGroup({ layout: bgl, entries: [
        { binding: 0, resource: { buffer: uni } }, { binding: 1, resource: { buffer: segB } },
        { binding: 2, resource: { buffer: ptsB } }, { binding: 3, resource: { buffer: bndB } },
        { binding: 4, resource: { buffer: bitB } }, { binding: 5, resource: { buffer: jobB } }] });
      const enc = device.createCommandEncoder();
      enc.clearBuffer(bndB);
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, bg);
      pass.setPipeline(pipes.flattenB); pass.dispatchWorkgroups(nSegTot);
      pass.setPipeline(pipes.boundB);   pass.dispatchWorkgroups(nSegTot);
      pass.setPipeline(pipes.cellB);    pass.dispatchWorkgroups(Math.ceil(nCells / 64));
      pass.end();
      enc.copyBufferToBuffer(bitB, 0, rbB, 0, nCells * 4);
      device.queue.submit([enc.finish()]);
      await rbB.mapAsync(GPUMapMode.READ);
      const u32 = new Uint32Array(rbB.getMappedRange().slice(0));
      rbB.unmap();
      const ms = performance.now() - t0;
      for (const b of [uni, segB, ptsB, bndB, bitB, jobB, rbB]) b.destroy();
      return { u32, ms };
    };
    await gpuBatch(jobs, bbox, G);                       // warm
    const bts = []; let bres = null;
    for (let r = 0; r < 10; r++) { bres = await gpuBatch(jobs, bbox, G); bts.push(bres.ms); }
    bts.sort((a, b) => a - b);
    // batched correctness: every job's sub-grid must still match the CPU exactly
    let bdiff = 0;
    for (let j = 0; j < N; j++) {
      const ref = buildOccupancyGrid(jobs[j], bbox, false, { grid: G, minInteriorFrac: 0 });
      for (let i = 0; i < G * G; i++) if ((ref.bits[i] | 0) !== (bres.u32[j * G * G + i] ? 1 : 0)) bdiff++;
    }
    out.batch = { N, G, cpuTot, gpuSeq, gpuBatch: bts[0], bdiff };
  }
  out.gpuErr = window.__gpuErr || null;
  return out;
}

try { window.__out = await run(); window.__ready = true; }
catch (e) { window.__err = e.message + String.fromCharCode(10) + (e.stack || ''); window.__ready = true; }
</script></body></html>`;

// COOP/COEP → crossOriginIsolated → performance.now() at ~5µs instead of the 100µs clamp.
// Without this every number below quantizes to 100µs and the whole probe is junk.
const server = http.createServer((q, res) => {
  const H = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  try {
    if (q.url === '/') { res.writeHead(200, { ...H, 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { ...H, 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// navigator.gpu is absent on about:blank — the page MUST be served over http://127.0.0.1.
const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 480000, polling: 50 });
const err = await page.evaluate(() => window.__err);
const out = await page.evaluate(() => window.__out);
await browser.close(); server.close();
if (err) { console.error('FAILED:\n' + err); process.exit(1); }

const f3 = (n) => n.toFixed(3);
if (out.gpuErr) console.error('*** WebGPU device error: ' + out.gpuErr);
console.log(`adapter: ${out.adapter}    crossOriginIsolated(5µs timer)=${out.iso}`);
console.log('');
console.log('── 1) GPU round-trip FLOOR (empty dispatch) ─────────────────────────');
console.log(`  dispatch + mapAsync readback   min ${f3(out.floor.min)}ms   p50 ${f3(out.floor.p50)}ms   p90 ${f3(out.floor.p90)}ms`);
console.log(`  dispatch + onSubmittedWorkDone min ${f3(out.floorNoReadback.min)}ms   p50 ${f3(out.floorNoReadback.p50)}ms`);
console.log('');
console.log('── 2) occupancy grid: CPU (real occupancy.js) vs GPU (WGSL), full round trip ──');
console.log('  segs    G   cells   pts  |   CPU ms    GPU ms   speedup |  bit-diff');
let anyDiff = 0;
for (const r of out.sweep) {
  anyDiff += r.diff;
  const sp = r.cpu / r.gpu;
  console.log(`  ${String(r.nSeg).padStart(4)} ${String(r.G).padStart(4)} ${String(r.cells).padStart(6)} ${String(r.nPts).padStart(6)}  |  ${f3(r.cpu).padStart(7)}  ${f3(r.gpu).padStart(8)}   ${(sp).toFixed(2).padStart(6)}× |  ${String(r.diff).padStart(4)}${r.diff ? '  <-- MISMATCH' : ''}`);
}
console.log('');
console.log(anyDiff === 0
  ? '  CORRECTNESS: PASS — GPU grid bit-identical to occupancy.js on every sweep point.'
  : `  CORRECTNESS: **FAIL** — ${anyDiff} cell(s) differ. Any timing below is meaningless.`);
console.log('');
console.log('── 3) batched: tiger.svg\'s real job list (37 grids, G=24, 18 segs each) ──');
console.log(`  CPU total (off-thread, real impl)     ${f3(out.batch.cpuTot)}ms`);
console.log(`  GPU, one dispatch per grid (naive)    ${f3(out.batch.gpuSeq)}ms   (${(out.batch.cpuTot / out.batch.gpuSeq).toFixed(2)}×)`);
console.log(`    ^ floor paid ${out.batch.N}× =                  ${f3(out.floor.p50 * out.batch.N)}ms  <- irreducible for a per-grid dispatch`);
console.log(`  GPU, ALL 37 grids in ONE dispatch     ${f3(out.batch.gpuBatch)}ms   (${(out.batch.cpuTot / out.batch.gpuBatch).toFixed(2)}×)   bit-diff ${out.batch.bdiff}${out.batch.bdiff ? '  <-- MISMATCH' : ''}`);
console.log('');
console.log(`  Absolute stake: the ENTIRE occupancy workload for tiger.svg (the heaviest asset in`);
console.log(`  examples/) is ${f3(out.batch.cpuTot)}ms of off-thread, deferred, once-per-load work.`);
