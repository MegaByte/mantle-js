// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// twoTreeAB — whole source trees timed against each other IN ONE PAGE, through the public render() path.
//
//   node probes/twoTreeAB.mjs --tree base=/path/to/js.kontek.mantle --tree a=/path/a --tree b=/path/b
//   (a tree may carry options: --tree off=/path/b::prepass=0 times that tree with the opaque prepass pinned off, and
//    --tree o64=/path/b::ox=64.5,oy=-32.25 imports with that bundle origin (origin=false: none)
//    --tree ring=/path/b::g:__MANTLE_DEBUG__=true,g:__LB_BEZ_RING_ARC=false sets page globals while that tree's sides
//    are built, packed and warmed -- a switch read at build time. Each --tree is its own module instance, so a tree
//    listed twice under two names keeps two Loop-Blinn mesh caches and one arm never draws the other's meshes.)
//   --route lb|cpatch|none --kernel slug  pins the fill engine (setFillEngine) on every side that has it.
//   --path render|draw  render() after setBundle (default: svgRenderBench's regime), or beginFrame/drawBundle/endFrame
//                       at setViewport(N, N). Check the draw tally on a Loop-Blinn A/B: an older tree's render() may not draw LB.
//        [--alpha .5] (--path draw only: drawBundle(b, { alpha }), group opacity)  [--inst 64] (drawBundleInstanced of 64 instances at --alpha)  [--instscale 0.9] (the matrix scale per grid cell: 0.9 puts each instance at 1.8 cells, so neighbors OVERLAP; 0.45 tiles them at 0.9 of a cell)
//        [--svg examples/_bench/<asset>.svg,examples/tiger.svg] [--size 800] [--reps 12] [--target 150]
//        [--warmup 200] [--precompile 1] [--settle 1] [--lbready 1] [--prepass 1] [--warmidle 0] [--aa rel] [--png outdir]
//
// A cross-process comparison of two trees (svgRenderBench with BENCH_ROOT, one tree per run) drifts 30-40% between
// runs on small assets, so its A/A floor swallows most of the answers. This loads every tree's src/index.js and shaders
// under its own URL prefix (/t0/, /t1/, ...), each as its own module instance, and times them side by side on one page:
// the regime svgRenderBench times (the demo page's 800x800 canvas and context attributes, createRenderer with no
// options, setBundle + render()), so the numbers answer the same question with a within-run floor.
//
// The traps it carries:
//   * a DISCARD renderer per tree first: on ANGLE/Metal the first renderer compiled from a given shader source is slow
//     for life, and every tree's shader text differs;
//   * an A/A side (a second renderer of the --aa tree, default the last) prices the floor; nothing inside it is a
//     result;
//   * samples are fence-synced (a MessageChannel poll), sized to ~--target ms for the slowest tree and the same frame
//     count for every tree, ABBA-rotated over --reps rounds, medians;
//   * the program each tree drew (V a fill variant, U the universal program, - a tree that does not report it) and its
//     opaque depth prepasses per frame are printed, because a tree timed on the universal program is not the tree in
//     steady state;
//   * a pixel diff of every side against the first tree, so a tree that draws something else cannot pass as faster.
//   * THE GPU THROTTLE (test/_gpuThrottle.mjs): every sample, and every warm-up burst, is followed by an idle of at
//     least its own length (MANTLE_GPU_DUTY, default 0.5), outside the timed region, and the run is capped at
//     MANTLE_GPU_WALL_MS. Run it in the FOREGROUND, one GPU job at a time.
//
// --png writes every side's frame as <outdir>/<asset>.<tree>.png (top-down), to look at a pixel diff.
// --precompile 1 calls precompileFills() (a tree without it is unaffected), 2 calls it again after the settle; --settle 1 waits for the bundle's async
// builds (occupancy, occlusion cull) as svgRenderBench's BENCH_SETTLE does; --prepass 0 pins the opaque prepass off by
// pinning the bundle's cached plan to "none" (a tree without the prepass ignores it).
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const TREES = [];
for (let i = 0; i < argv.length; i++)
  if (argv[i] === '--tree') {
    // name=dir, or name=dir::key=value,... for per-tree options (prepass=0 times the same tree with the prepass off).
    const [name, spec] = argv[i + 1].split(/=(.*)/s);
    const [dir, kv] = spec.split('::');
    const topt = {};
    for (const p of (kv || '').split(',').filter(Boolean)) {
      const [k, v] = p.split('=');
      topt[k] = v;
    }
    const root = path.resolve(dir);
    if (!existsSync(path.join(root, 'src/index.js'))) {
      console.error(`tree ${name}: no src/index.js under ${root}`);
      process.exit(2);
    }
    TREES.push({ name, root, topt });
  }
if (TREES.length < 2) {
  console.error('need at least two --tree name=dir');
  process.exit(2);
}
if (argv.includes('--dry-run')) {
  console.log(
    'dry run: trees ' +
      TREES.map(
        (t) =>
          `${t.name}(${t.root}${Object.keys(t.topt).length ? ' ' + JSON.stringify(t.topt) : ''})`,
      ).join(', ') +
      ' aa=' +
      flag('aa', TREES[TREES.length - 1].name),
  );
  process.exit(0);
}
const SVGS = (
  flag('svglist', '')
    ? readFileSync(flag('svglist'), 'utf8').trim()
    : flag('svg', 'examples/tiger.svg')
)
  .split(',')
  .map((f) => {
    const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
    return { name: path.basename(f, '.svg'), text: readFileSync(p, 'utf8') };
  });
const N = +flag('size', 800),
  REPS = +flag('reps', 12),
  TARGET = +flag('target', 150),
  WARMUP = +flag('warmup', 200);
const ROUTE = flag('route', ''),
  KERNEL = flag('kernel', 'slug');
const OPT = {
  path: flag('path', 'render'),
  route: ROUTE,
  kernel: KERNEL,
  lbReady: flag('lbready', '1') === '1',
  warmIdle: flag('warmidle', '0') === '1',
  precompile: +flag('precompile', '1'),
  settle: flag('settle', '1') === '1',
  prepass: flag('prepass', '1') !== '0',
  warmup: WARMUP,
  alpha: +flag('alpha', '1'),
  inst: +flag('inst', '0'),
  instScale: +flag('instscale', '0.9'),
};
const PNG = flag('png', '');
const AA = Math.max(
  0,
  TREES.findIndex((t) => t.name === flag('aa', TREES[TREES.length - 1].name)),
);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
const N = ${N}, NT = ${TREES.length}, REPS_CPU = ${REPS};
const trees = [];
for (let i = 0; i < NT; i++) {
  const M = await import('/t' + i + '/src/index.js');
  const shaders = await M.loadShaders(new URL('/t' + i + '/src/shaders/', location.href).href);
  trees.push({ M, shaders });
}
function mkGl() {
  const c = document.createElement('canvas'); c.width = N; c.height = N; document.body.appendChild(c);
  // The demo page's attributes (mantleDemo.html): what svgRenderBench times.
  return { c, gl: c.getContext('webgl2', { premultipliedAlpha: true, antialias: false, stencil: true, depth: true }) };
}
const TOPT = ${JSON.stringify(TREES.map((t) => t.topt))};
const gval = (v) => (v === 'true' ? true : v === 'false' ? false : /^-?[0-9.]+$/.test(v) ? +v : v);
async function side(ti, svg, opt0, warmup) {
  const opt = Object.assign({}, opt0);
  if (TOPT[ti].prepass === '0') opt.prepass = false;
  // THIS TREE'S GLOBALS, set for the build, pack and warm of this side and removed before the next side starts.
  const gk = Object.keys(TOPT[ti]).filter((k) => k.startsWith('g:'));
  for (const k of gk) globalThis[k.slice(2)] = gval(TOPT[ti][k]);
  try { return await sideBody(ti, svg, opt, warmup); } finally { for (const k of gk) delete globalThis[k.slice(2)]; }
}
async function sideBody(ti, svg, opt, warmup) {
  const { M, shaders } = trees[ti];
  const { c, gl } = mkGl();
  // --warmidle 1: opts.psoWarmIdle always true, so a lean variant's pipeline warms in the first frames instead of
  // waiting for 45 consecutive frames under 20 ms -- the program an app at 60 fps ends up drawing. A tree without the
  // option ignores it.
  // a tree's o:name=value options are renderer options (createRenderer called with name: value): an experiment switch read from R.opts
  const ropts = {}; for (const k of Object.keys(TOPT[ti])) if (k.startsWith('o:')) ropts[k.slice(2)] = gval(TOPT[ti][k]);
  if (opt.warmIdle) ropts.psoWarmIdle = () => true;
  const R = M.createRenderer(gl, shaders, ropts);
  if (R.ready) await R.ready;
  if (opt.route && R.setFillEngine) R.setFillEngine({ route: opt.route, kernel: opt.kernel });
  // --path draw: beginFrame/drawBundle/endFrame at setViewport(N, N), the path an app with its own frame loop takes
  // and the only one on which a pinned Loop-Blinn route draws Loop-Blinn (render() after setBundle drew every frame
  // as Slug + stroke on tiger, route lb, lbReady true -- the tally said so and three LB trees were pixel-identical).
  const drawPath = opt.path === 'draw';
  // a tree's origin=false, or ox=<x>:oy=<y>, sets the importer's bundle origin (bundle/layout.js): the same tree listed twice, A with none, B with one,
  // times what the origin costs the draw (nothing: the draw fits the content box)
  const io = {}; if (TOPT[ti].origin === 'false') io.origin = false; else if (TOPT[ti].ox !== undefined) io.origin = [+TOPT[ti].ox, +TOPT[ti].oy];
  const sections = drawPath ? await M.importSvg(svg, { preserveViewport: true, ...io }) : await M.importSvg(svg, io);
  const b = M.createBundle(gl, sections);
  if (drawPath) { R.setViewport(N, N); gl.viewport(0, 0, N, N); } else R.setBundle(b);
  // --inst N: drawBundleInstanced of N instances on a grid, each at --alpha (the instanced fast path at alpha 1; group fades below it).
  const g = Math.ceil(Math.sqrt(opt.inst || 0)), sc = 2 / g;
  const insts = opt.inst > 0 ? Array.from({ length: opt.inst }, (_, i) => ({ worldMatrix: new Float32Array([sc * opt.instScale, 0, 0, 0, sc * opt.instScale, 0, -1 + sc * ((i % g) + 0.5), 1 - sc * (((i / g) | 0) + 0.5), 1]), alpha: opt.alpha })) : null;
  const frame = drawPath ? () => { R.beginFrame([1, 1, 1, 1]); if (insts) R.drawBundleInstanced(b, insts); else R.drawBundle(b, opt.alpha < 1 ? { alpha: opt.alpha } : undefined); R.endFrame(); } : () => R.render();
  if (opt.precompile && R.precompileFills) R.precompileFills();
  if (opt.settle) {
    const t0 = performance.now();
    const pending = () => b._occupancyBuildPending || b._occlusionCullPending
      || (sections.pendingOccupancy && sections.pendingOccupancy.length && !b.hasOccupancy && performance.now() - t0 < 3000);
    while (pending() && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 10));
  }
  // --lbready 1 (default): one frame to start the draw-time Loop-Blinn build, then wait for it (a tree with
  // awaitLbReady). Without it the build lands in the middle of the timed samples -- which yield to the event loop --
  // and the first side of a tree times a mix of Slug and Loop-Blinn frames while the next reuses the finished meshes
  // from the module-level cache (tiger: rel 12.3 ms, rel' 9.0 ms, 3 channels apart).
  let lbReady = null;
  if (opt.lbReady && R.awaitLbReady) {
    frame(); await window.__gpuFence(gl);
    try { lbReady = !!(await R.awaitLbReady(b, 20000)); } catch { lbReady = false; }
  }
  // --precompile 2: AGAIN once the async builds have landed. A build that lands after the first call can change the
  // bundle's variant key, and the new variant then waits for 45 consecutive slack frames -- which a GPU-bound frame
  // loop never gives it (tiger stayed on the universal program), though an app at 60 fps gets them in 0.75 s.
  if (opt.precompile >= 2 && R.precompileFills) R.precompileFills();
  if (!opt.prepass) Object.defineProperty(b, '_opaquePrepassPlan', { configurable: true, set() {},
    get: () => ({ none: true, geomGen: b._geomGen | 0, cullGen: b._cullGen | 0 }) });
  const sync = () => window.__gpuFence(gl);
  if (warmup > 0) await window.__gpuFrames(warmup, frame, sync, 64);
  const st = () => { try { return R.debugStats || {}; } catch { return {}; } };
  const prog = () => { const s = st(); return !('drawnFillVariantKey' in s) ? '-' : s.drawnFillVariantKey ? 'V' : 'U'; };
  // WHY a side drew the universal program: the variant the readiness check wanted, the one bound, the warm state.
  const diag = () => { const s = st(); if (!('drawnFillVariantKey' in s)) return null;
    const e = (s.engines && s.engines.draws) || {};
    return { want: s.fillVariantKey, drawn: s.drawnFillVariantKey, idle: s.idleFrames, psoPending: s.psoWarmPending,
      compiles: s.variantCompiles, draws: e, meshKind: s.meshKind || null, lbReady }; };
  // WAIT FOR THE VARIANT (a tree that reports one): a variant bound in the middle of the timed samples splits them
  // between two programs, and the A/A floor reads 27% (tiger, --warmidle 1). Throttled 16-frame bursts, up to 8 s.
  if (opt.warmIdle && 'drawnFillVariantKey' in st()) {
    const t0 = performance.now();
    while (!st().drawnFillVariantKey && performance.now() - t0 < 8000) await window.__gpuFrames(16, frame, sync, 16);
  }
  let D = 4, frames = 0;
  const cpuMs = [];
  const time = async () => {
    const t0 = performance.now();
    for (let i = 0; i < D; i++) frame();
    cpuMs.push(performance.now() - t0);                // the JS side: planning, state changes and submit, before the fence
    await window.__gpuFence(gl);
    const ms = performance.now() - t0;
    frames += D;
    await window.__gpuIdle(ms);                      // THE THROTTLE, after the clock stopped
    return ms;
  };
  const read = () => { frame(); const p = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  const pp = () => st().opaquePrepassCount;
  const dispose = () => {
    try { R.dispose && R.dispose(); } catch {}
    try { b.dispose && b.dispose(); } catch {}
    try { const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch {}
    c.remove();
  };
  return { time, read, prog, diag, pp, cpu: () => { const v = cpuMs.slice(-REPS_CPU).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0; }, dispose, setD: (d) => { D = d; } };
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
window.__run = async (svg, opt, reps, target, aa, png) => {
  // DISCARDS: one renderer per tree, compiled, drawn, disposed -- a first compile of any source is slow for life.
  for (let i = 0; i < NT; i++) { const d = await side(i, svg, opt, 8); for (let k = 0; k < 3; k++) await d.time(); d.dispose(); }
  const arms = [];
  for (let i = 0; i < NT; i++) arms.push({ name: String(i), ti: i, s: await side(i, svg, opt, opt.warmup) });
  arms.push({ name: 'aa', ti: aa, s: await side(aa, svg, opt, opt.warmup) });
  // Size one sample to ~target ms for the SLOWEST tree; every tree draws the same frame count per sample.
  let worst = 0;
  for (const a of arms) { a.s.setD(4); await a.s.time(); const t = await a.s.time(); worst = Math.max(worst, t / 4); }
  const D = Math.max(4, Math.min(2000, Math.round(target / Math.max(worst, 0.01))));
  for (const a of arms) a.s.setD(D);
  const pp0 = arms.map((a) => a.s.pp());
  const t = arms.map(() => []);
  for (let r = 0; r < reps; r++) {
    const order = (r & 1) ? arms.map((_, i) => i).reverse() : arms.map((_, i) => i);
    for (const i of order) t[i].push(await arms[i].s.time());
  }
  const pp1 = arms.map((a) => a.s.pp());
  const ref = arms[0].s.read();
  const frames = [];
  const px = arms.map((a) => { const p = a.s.read(); if (png) frames.push(b64(p)); let n = 0, mx = 0; for (let i = 0; i < p.length; i++) { const d = Math.abs(p[i] - ref[i]); if (d) n++; if (d > mx) mx = d; } return { n, mx }; });
  let ink = 0; for (let i = 0; i < ref.length; i += 4) if (ref[i] !== ref[0] || ref[i + 1] !== ref[1] || ref[i + 2] !== ref[2] || ref[i + 3] !== ref[3]) ink++;
  const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  const iqr = (v) => { const s = v.slice().sort((p, q) => p - q); return (s[Math.floor(s.length * 3 / 4)] - s[Math.floor(s.length / 4)]) / med(v); };
  const out = arms.map((a, i) => ({ ti: a.ti, ms: med(t[i]) / D, min: Math.min(...t[i]) / D, iqr: iqr(t[i]), prog: a.s.prog(), cpu: a.s.cpu() / D,
    prepass: pp0[i] == null ? '-' : ((pp1[i] - pp0[i]) / (D * reps)).toFixed(2), px: px[i], diag: a.s.diag() }));
  for (const a of arms) a.s.dispose();
  return { D, ink, out, frames };
};
window.__ready = true;
</script></body></html>`;

// A minimal RGBA PNG writer (readPixels rows are bottom-up; flipped here).
function png(px, w, h) {
  const crcT = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcT[n] = c;
  }
  const crc = (b) => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, (h - 1 - y) * w * 4, (h - y) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const m = /^\/t(\d+)(\/.*)$/.exec(u);
    if (!m || !TREES[+m[1]]) {
      res.writeHead(404);
      res.end();
      return;
    }
    const p = m[2];
    res.writeHead(200, {
      'content-type': p.endsWith('.glsl')
        ? 'text/plain'
        : p.endsWith('.json')
          ? 'application/json'
          : 'text/javascript',
    });
    res.end(readFileSync(path.join(TREES[+m[1]].root, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  protocolTimeout: 1200000,
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox', '--enable-gpu'],
});
const cap = capWallTime('twoTreeAB', async () => {
  await browser.close();
  server.close();
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
console.log(`trees: ${TREES.map((t, i) => `${i}=${t.name} (${t.root})`).join('  ')}`);
console.log(
  `${N}x${N}, ${OPT.path === 'draw' ? 'drawBundle' : 'render()'} path${ROUTE ? `, route ${ROUTE} kernel ${KERNEL}` : ''}, warmup ${OPT.warmup}, lbready ${+OPT.lbReady}, warmidle ${+OPT.warmIdle}, precompile ${+OPT.precompile}, settle ${+OPT.settle}, prepass ${+OPT.prepass}, ${REPS} reps ABBA, A/A = second ${TREES[AA].name}`,
);
for (const s of SVGS) {
  const r = await page.evaluate(
    (t, o, reps, tg, aa, png) => window.__run(t, o, reps, tg, aa, png),
    s.text,
    OPT,
    REPS,
    TARGET,
    AA,
    !!PNG,
  );
  const aaRow = r.out[r.out.length - 1],
    aaBase = r.out[AA];
  const floor = Math.abs(aaRow.ms / aaBase.ms - 1),
    floorMin = Math.abs(aaRow.min / aaBase.min - 1);
  console.log(
    `\n${s.name}: ${r.D} frames per sample, ink ${r.ink} px; ms per frame (median), vs ${TREES[0].name}, vs ${TREES[AA].name}; A/A floor ${(100 * floor).toFixed(1)}% (best-of ${(100 * floorMin).toFixed(1)}%)`,
  );
  for (let i = 0; i < r.out.length; i++) {
    const o = r.out[i],
      nm = i < TREES.length ? TREES[o.ti].name : TREES[o.ti].name + "'";
    const v0 = o.ms / r.out[0].ms,
      vA = o.ms / aaBase.ms;
    const mark = (x) => (Math.abs(1 - x) <= floor ? 'tie' : x < 1 ? 'FASTER' : 'slower');
    console.log(
      `  ${nm.padEnd(8)} ${o.ms.toFixed(4).padStart(9)} ms  iqr ${(100 * o.iqr).toFixed(1).padStart(5)}%  ` +
        `vs ${TREES[0].name} ${v0.toFixed(3)}x ${i ? mark(v0).padEnd(6) : '      '}  vs ${TREES[AA].name} ${vA.toFixed(3)}x  ` +
        `cpu ${o.cpu.toFixed(4)} best ${o.min.toFixed(4)} (${(o.min / r.out[0].min).toFixed(3)}x, ${(o.min / aaBase.min).toFixed(3)}x)  ` +
        `prog ${o.prog}  prepass ${o.prepass}  px vs ${TREES[0].name}: ${o.px.n} ch (max ${o.px.mx})`,
    );
    if (o.diag)
      console.log(
        `           want [${o.diag.want}] drawn [${o.diag.drawn}] idleFrames ${o.diag.idle} psoWarmPending ${o.diag.psoPending} ` +
          `variantCompiles ${o.diag.compiles} lbReady ${o.diag.lbReady} draws ${JSON.stringify(o.diag.draws)}`,
      );
    if (PNG) {
      mkdirSync(PNG, { recursive: true });
      const f = path.join(PNG, `${s.name}.${nm}.png`);
      writeFileSync(f, png(Buffer.from(r.frames[i], 'base64'), N, N));
    }
  }
  if (PNG) console.log(`  frames written to ${PNG}`);
}
const duty = await page.evaluate(() => window.__gpuDuty());
console.log(
  `\ngpu duty over the timed samples: ${(duty.busy / Math.max(1, duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await browser.close();
server.close();
