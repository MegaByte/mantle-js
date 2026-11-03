// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// ledgerCostAB -- what does the GPU memory ledger (src/renderer/memoryLedger.js) cost on upload-heavy work?
//
//   node probes/ledgerCostAB.mjs --tree base=/path/base/js.kontek.mantle --tree new=/path/current/js.kontek.mantle
//        [--work stream,streamFull,override,morph,filterZoom,filterFresh,create,prepare,atlas,tiger]  [--size 512]
//        [--reps 12] [--target 120] [--assets examples/tiger.svg,...] [--census 1]
//
// Two whole source trees in ONE page (module instances under /t0/ and /t1/), ABBA-rotated, plus an A/A side (a second
// context of the FIRST tree) that prices the floor: nothing inside the floor is a result. Every side owns its own canvas and
// WebGL2 context, so the memory ledger of the tree that has one wraps only its own context.
//
// A workload is setup() -> step(i); a sample is D steps then a fence. Per sample three readings:
//   cpu   JS time of the D steps, before the fence       (the wrapper cost lives here)
//   wall  until the fence signals                        (cpu + whatever the GPU still owed)
//   gpu   EXT_disjoint_timer_query_webgl2 TIME_ELAPSED over the D steps, when the context exposes it
// Programs are compiled FRESH per tree first (a discarded side), because the first renderer compiled from a shader source
// is slow for life on ANGLE/Metal. The last frame of every draw workload is read back with the same step index and diffed
// against the first tree, so an arm that draws something else cannot pass as cheaper. --census 1 prints, instead of
// timing, how many times each wrapped GL entry point (and getParameter) is called per step and during setup.
//
// THE GPU THROTTLE (test/_gpuThrottle.mjs) applies: run it in the FOREGROUND, one GPU job at a time.
import { readFileSync, existsSync } from 'fs';
import { benchNames, BENCH_UNSET } from '../test/_assets.mjs';
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
    const [name, dir] = argv[i + 1].split(/=(.*)/s);
    const root = path.resolve(dir);
    if (!existsSync(path.join(root, 'src/index.js'))) {
      console.error(`tree ${name}: no src/index.js under ${root}`);
      process.exit(2);
    }
    TREES.push({ name, root });
  }
if (TREES.length < 2) {
  console.error('need at least two --tree name=dir');
  process.exit(2);
}
const N = +flag('size', 512),
  REPS = +flag('reps', 12),
  TARGET = +flag('target', 120),
  CENSUS = flag('census', '0') === '1';
const WORK = flag(
  'work',
  'stream,streamFull,override,morph,filterZoom,filterFresh,create,prepare,atlas,tiger',
).split(',');
if (!flag('assets', '') && !benchNames().length) console.log(BENCH_UNSET);
const ASSETS = flag(
  'assets',
  ['examples/tiger.svg', ...benchNames().map((n) => `examples/_bench/${n}.svg`)].join(','),
)
  .split(',')
  .map((f) => ({ name: path.basename(f, '.svg'), text: readFileSync(path.join(ROOT, f), 'utf8') }));
const AA = 0; // the A/A side is a second context of tree 0

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
const N = ${N}, NT = ${TREES.length};
const trees = [];
for (let i = 0; i < NT; i++) {
  const M = await import('/t' + i + '/src/index.js');
  const shaders = await M.loadShaders(new URL('/t' + i + '/src/shaders/', location.href).href);
  trees.push({ M, shaders });
}
function mkGl() {
  const c = document.createElement('canvas'); c.width = N; c.height = N; document.body.appendChild(c);
  return { c, gl: c.getContext('webgl2', { premultipliedAlpha: true, antialias: false, stencil: true, depth: true }) };
}
// ---- scenes --------------------------------------------------------------------------------------------------------------
let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const f2 = (x) => x.toFixed(2);
function blob(cx, cy, r, k) {   // a closed cubic blob
  const pts = []; const n = 6 + (k % 3);
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, rr = r * (0.7 + 0.6 * rnd()); pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  let d = 'M' + f2(pts[0][0]) + ' ' + f2(pts[0][1]);
  for (let i = 0; i < n; i++) { const p0 = pts[i], p1 = pts[(i + 1) % n], q = pts[(i + 2) % n];
    d += ' C' + f2(p0[0] + (p1[0] - pts[(i + n - 1) % n][0]) / 6) + ' ' + f2(p0[1] + (p1[1] - pts[(i + n - 1) % n][1]) / 6) + ' '
      + f2(p1[0] - (q[0] - p0[0]) / 6) + ' ' + f2(p1[1] - (q[1] - p0[1]) / 6) + ' ' + f2(p1[0]) + ' ' + f2(p1[1]); }
  return d + ' Z';
}
function blobs(n, sd) {
  seed = sd; let s = '';
  const g = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const cx = ((i % g) + 0.5) * 1000 / g, cy = (((i / g) | 0) + 0.5) * 1000 / g;
    const c = '#' + [0, 0, 0].map(() => (40 + (rnd() * 180 | 0)).toString(16)).join('');
    s += '<path id="s' + i + '" d="' + blob(cx, cy, 380 / g, i) + '" fill="' + c + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + s + '</svg>';
}
const filterSvg = (n) => {
  seed = 7; let s = '<defs><filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>'
    + '<filter id="d" x="-30%" y="-30%" width="170%" height="170%"><feDropShadow dx="10" dy="10" stdDeviation="9" flood-color="#000" flood-opacity=".6"/></filter></defs>';
  const g = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const cx = ((i % g) + 0.5) * 1000 / g, cy = (((i / g) | 0) + 0.5) * 1000 / g;
    s += '<g filter="url(#' + (i & 1 ? 'b' : 'd') + ')"><path id="s' + i + '" d="' + blob(cx, cy, 300 / g, i) + '" fill="#' + (i & 1 ? 'c04040' : '3060c0') + '"/></g>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + s + '</svg>';
};
const atlasSvg = (n) => {
  seed = 11; let s = ''; const g = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const cx = ((i % g) + 0.5) * 1000 / g, cy = (((i / g) | 0) + 0.5) * 1000 / g;
    s += '<g opacity="0.6"><path d="' + blob(cx, cy, 300 / g, i) + '" fill="#c04040"/><path d="' + blob(cx + 10, cy + 10, 300 / g, i + 1) + '" fill="#3060c0"/></g>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">' + s + '</svg>';
};
// ---- counting (census) ------------------------------------------------------------------------------------------------
const COUNTED = ['texImage2D', 'texImage3D', 'texStorage2D', 'texStorage3D', 'generateMipmap', 'bufferData', 'renderbufferStorage', 'renderbufferStorageMultisample',
  'deleteTexture', 'deleteBuffer', 'deleteRenderbuffer', 'getParameter', 'texSubImage2D', 'bufferSubData', 'bindTexture', 'bindBuffer', 'drawArrays', 'drawElements'];
function countGl(gl) {
  const cnt = {};
  for (const m of COUNTED) { const o = gl[m]; if (typeof o !== 'function') continue; gl[m] = function (...a) { cnt[m] = (cnt[m] | 0) + 1; return o.apply(gl, a); }; }
  return cnt;
}
// ---- workloads: ({M, gl, R, shaders, ti}, asset) -> { step(i), draw, dispose() } --------------------------------------------
const frame = (R, b, o) => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, o); R.endFrame(); };
const scaleM = (s) => new Float32Array([s, 0, 0, 0, s, 0, 0, 0, 1]);
const W = {
  async stream({ M, gl, R, ti }, a, light = true) {
    const VB = [0, 0, 1000, 1000], NS = 160;
    const { mkQuad } = await import('/t' + ti + '/src/primitives/seg.js');
    const g = Math.ceil(Math.sqrt(NS));
    // road-like bands: two curved edges, two straight, swaying with the step
    const per = (sway) => { const out = [];
      for (let k = 0; k < NS; k++) {
        const cx = ((k % g) + 0.5) * 1000 / g, cy = (((k / g) | 0) + 0.5) * 1000 / g, w = 30, h = 55, s = sway * (1 + (k % 5) * 0.2);
        const nL = [cx - w, cy + h], mL = [cx - w / 2 + s, cy], fL = [cx - w / 4, cy - h], fR = [cx + w / 4, cy - h], mR = [cx + w / 2 + s, cy], nR = [cx + w, cy + h];
        const edge = (n, m, f) => mkQuad(n, [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2], f);
        const st = (p, q) => mkQuad(p, p, q);
        out.push([edge(nL, mL, fL), st(fL, fR), edge(fR, mR, nR), st(nR, nL)]);
      } return out; };
    const shapes = per(0).map((segs) => ({ segs, fill: [0.5, 0.5, 0.6, 1] }));
    const b = M.createBundle(gl, M.buildStreamableSections(shapes, VB, light ? { lightweight: true } : {}));
    R.setViewport(N, N); gl.viewport(0, 0, N, N);
    const step = (i) => { const r = M.updateBundleGeometry(gl, b, per(Math.sin(i * 0.37) * 6), light ? { lightweight: true } : undefined);
      if (r && r.ok === false) throw new Error('stream rejected'); b.globalBBox = VB.slice(); frame(R, b, {}); };
    return { step, draw: true, dispose() { b.dispose && b.dispose(); } };
  },
  streamFull(c, a) { return W.stream(c, a, false); },
  async override({ M, gl, R }) {
    const NS = 300;
    const b = M.createBundle(gl, await M.importSvg(blobs(NS, 3))); const T = M.createOverrideTable(gl, b);
    R.setViewport(N, N); gl.viewport(0, 0, N, N);
    const step = (i) => { for (let k = 0; k < NS; k++) T.set('s' + k, { localPosition: [Math.sin(i * 0.3 + k) * 8, Math.cos(i * 0.2 + k) * 8], fill: [(k % 7) / 7, ((i + k) % 10) / 10, 0.5, 1] });
      frame(R, b, { overrides: T }); };
    return { step, draw: true, dispose() { try { T.dispose && T.dispose(); } catch {} b.dispose && b.dispose(); } };
  },
  async morph({ M, gl, R }) {
    const NS = 60;
    const A = M.createBundle(gl, await M.importSvg(blobs(NS, 21))), B = M.createBundle(gl, await M.importSvg(blobs(NS, 22)));
    const mo = M.createShapeMorph(gl, A, B);
    R.setViewport(N, N); gl.viewport(0, 0, N, N);
    const step = (i) => { mo.setT(0.5 + 0.45 * Math.sin(i * 0.31)); frame(R, mo, {}); };
    if (R.awaitLbReady) { step(0); try { await R.awaitLbReady(mo, 20000); } catch {} }
    return { step, draw: true, dispose() { try { mo.dispose(); } catch {} } };
  },
  async filterZoom({ M, gl, R }) {
    const b = M.createBundle(gl, await M.importSvg(filterSvg(16)));
    R.setViewport(N, N); gl.viewport(0, 0, N, N);
    // the world scale changes every step: filter results cannot be reused, targets are acquired at new sizes
    const step = (i) => frame(R, b, { worldMatrix: scaleM(0.7 + 0.3 * ((i % 8) / 8)) });
    return { step, draw: true, dispose() { b.dispose && b.dispose(); } };
  },
  async filterFresh({ M, gl, shaders }) {
    // a renderer created, drawn and disposed each step: every filter target is created and released
    const b = M.createBundle(gl, await M.importSvg(filterSvg(8)));
    const step = () => { const r2 = M.createRenderer(gl, shaders); r2.setViewport(N, N); gl.viewport(0, 0, N, N); frame(r2, b, {}); r2.dispose && r2.dispose(); };
    return { step, draw: true, dispose() { b.dispose && b.dispose(); } };
  },
  async create({ M, gl }, a) {
    const sections = await M.importSvg(a.text);
    const step = () => { const b = M.createBundle(gl, sections); b.dispose && b.dispose(); };
    return { step, draw: false, dispose() {} };
  },
  async prepare({ M, gl, R }, a) {
    const sections = await M.importSvg(a.text);
    R.setViewport(N, N);
    const step = () => { const b = M.createBundle(gl, sections); R.prepareBundle(b); b.dispose && b.dispose(); };
    return { step, draw: false, dispose() {} };
  },
  async atlas({ M, gl, R }) {
    const b = M.createBundle(gl, await M.importSvg(atlasSvg(24)));
    R.setViewport(N, N); gl.viewport(0, 0, N, N);
    const step = (i) => frame(R, b, { worldMatrix: scaleM(0.8 + 0.2 * ((i % 6) / 6)) });
    return { step, draw: true, dispose() { b.dispose && b.dispose(); } };
  },
  async allocLoop({ gl }) {
    // the micro bound: 100 texImage2D + 100 bufferData per step on unregistered objects (the wrapper still reads the binding back)
    const tex = gl.createTexture(), buf = gl.createBuffer(), px = new Uint8Array(64), data = new Float32Array(256);
    const step = () => { gl.bindTexture(gl.TEXTURE_2D, tex); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (let i = 0; i < 100; i++) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); } };
    return { step, draw: false, dispose() { gl.deleteTexture(tex); gl.deleteBuffer(buf); } };
  },
  async tiger({ M, gl, R }, a) {
    const b = M.createBundle(gl, await M.importSvg(a.text));
    R.setViewport(N, N); gl.viewport(0, 0, N, N);
    return { step: () => frame(R, b, {}), draw: true, dispose() { b.dispose && b.dispose(); } };
  },
};
async function side(ti, work, asset, census) {
  const { M, shaders } = trees[ti];
  const { c, gl } = mkGl();
  const cnt = census ? countGl(gl) : null;
  const R = M.createRenderer(gl, shaders);
  if (R.ready) await R.ready;
  const w = await W[work]({ M, gl, R, shaders, ti }, asset);
  const setup = cnt ? Object.assign({}, cnt) : null;
  for (let i = 0; i < 6; i++) w.step(i + 1);          // steady state: programs, caches, meshes
  if (R.precompileFills) R.precompileFills();
  for (let i = 0; i < 4; i++) w.step(i + 7);
  await window.__gpuFence(gl);
  const dispose = () => { try { w.dispose(); R.dispose && R.dispose(); } catch {} try { const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch {} c.remove(); };
  if (cnt) {
    for (const k of Object.keys(cnt)) cnt[k] = 0;
    const K = 8; for (let i = 0; i < K; i++) w.step(i + 20);
    await window.__gpuFence(gl);
    const per = {}; for (const k of Object.keys(cnt)) per[k] = +(cnt[k] / K).toFixed(2);
    return { per, setup, dispose };
  }
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let D = 4, k = 0;
  const time = async () => {
    const q = timer ? gl.createQuery() : null;
    if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    for (let i = 0; i < D; i++) w.step(100 + (k++));
    const t1 = performance.now();
    if (q) gl.endQuery(timer.TIME_ELAPSED_EXT);
    await window.__gpuFence(gl);
    const t2 = performance.now();
    let g = NaN;
    if (q) { for (let s = 0; s < 50; s++) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { g = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; break; } await window.__gpuYield(); }
      gl.deleteQuery(q); if (gl.getParameter(timer.GPU_DISJOINT_EXT)) g = NaN; }
    await window.__gpuIdle(t2 - t0);
    return { cpu: t1 - t0, wall: t2 - t0, gpu: g };
  };
  const read = () => { w.step(3); const p = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  return { time, read, draw: w.draw, setD: (d) => { D = d; }, dispose };
}
window.__steps = async (ti, work, asset, n) => { const s = await side(ti, work, asset, false); s.setD(n); const t = await s.time(); s.dispose(); return t; };
window.__census = async (work, asset) => { const s = await side(1, work, asset, true); const r = { per: s.per, setup: s.setup }; s.dispose(); return r; };
window.__run = async (work, asset, reps, target) => {
  for (let i = 0; i < NT; i++) { const d = await side(i, work, asset, false); for (let k = 0; k < 3; k++) await d.time(); d.dispose(); }   // fresh compile per tree
  const arms = [];
  for (let i = 0; i < NT; i++) arms.push({ ti: i, s: await side(i, work, asset, false) });
  arms.push({ ti: ${AA}, s: await side(${AA}, work, asset, false) });
  let worst = 0;
  for (const a of arms) { a.s.setD(2); await a.s.time(); const t = await a.s.time(); worst = Math.max(worst, t.wall / 2); }
  const D = Math.max(1, Math.min(400, Math.round(target / Math.max(worst, 0.01))));
  for (const a of arms) a.s.setD(D);
  const t = arms.map(() => []);
  for (let r = 0; r < reps; r++) {
    const order = (r & 1) ? arms.map((_, i) => i).reverse() : arms.map((_, i) => i);
    for (const i of order) t[i].push(await arms[i].s.time());
  }
  let px = null;
  if (arms[0].s.draw) { const ref = arms[0].s.read(); px = arms.map((a) => { const p = a.s.read(); let n = 0, mx = 0; for (let i = 0; i < p.length; i++) { const d = Math.abs(p[i] - ref[i]); if (d) n++; if (d > mx) mx = d; } return { n, mx }; }); }
  const med = (v) => { const s = v.filter((x) => x === x).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
  const out = arms.map((a, i) => ({ ti: a.ti, cpu: med(t[i].map((x) => x.cpu)) / D, wall: med(t[i].map((x) => x.wall)) / D, gpu: med(t[i].map((x) => x.gpu)) / D,
    wallMin: Math.min(...t[i].map((x) => x.wall)) / D, cpuMin: Math.min(...t[i].map((x) => x.cpu)) / D,
    iqr: (() => { const s = t[i].map((x) => x.wall).sort((p, q) => p - q); return (s[Math.floor(s.length * 3 / 4)] - s[Math.floor(s.length / 4)]) / med(s); })(),
    px: px && px[i] }));
  for (const a of arms) a.s.dispose();
  return { D, out };
};
window.__ready = true;
</script></body></html>`;

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
const cap = capWallTime('ledgerCostAB', async () => {
  await browser.close();
  server.close();
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300));
});
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
console.log(
  `trees: ${TREES.map((t, i) => `${i}=${t.name} (${t.root})`).join('  ')}  A/A = second context of ${TREES[AA].name}`,
);
console.log(
  `${N}x${N}, ${CENSUS ? 'CENSUS (tree 1)' : REPS + ' reps ABBA, target ' + TARGET + ' ms/sample'}`,
);
if (flag('profile', '')) {
  // CDP sampling profile of N steps of one tree: top self-time functions
  const ti = +flag('profile'),
    n = +flag('steps', 300);
  const cdp = await page.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  for (const w of WORK) {
    await cdp.send('Profiler.start');
    const t = await page.evaluate(
      (ti, w, n) => window.__steps(ti, w, { name: '-', text: '' }, n),
      ti,
      w,
      n,
    );
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map((x) => [x.id, x]));
    const dt = profile.timeDeltas;
    profile.samples.forEach((id, i) => {
      const nd = byId.get(id),
        k =
          nd.callFrame.functionName +
          ' ' +
          nd.callFrame.url.split('/').slice(-2).join('/') +
          ':' +
          nd.callFrame.lineNumber;
      self.set(k, (self.get(k) || 0) + (dt[i] || 0));
    });
    console.log(`\nprofile tree ${ti} ${w}: ${n} steps cpu ${t.cpu.toFixed(1)} ms`);
    {
      let tot = 0;
      for (const [k, v] of self)
        if (/memoryLedger|memoryStats|preparation\.js|contextResources/.test(k)) {
          tot += v;
          console.log(`  LEDGER ${(v / 1000).toFixed(2).padStart(8)} ms  ${k}`);
        }
      console.log(`  memory ledger files, self time total ${(tot / 1000).toFixed(2)} ms`);
    }
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25))
      console.log(`  ${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`);
  }
  cap.clear();
  await browser.close();
  server.close();
  process.exit(0);
}
const jobs = [];
for (const w of WORK) {
  if (w === 'create' || w === 'prepare' || w === 'tiger') for (const a of ASSETS) jobs.push([w, a]);
  else jobs.push([w, { name: '-', text: '' }]);
}
const pct = (x) => ((x - 1) * 100).toFixed(1).padStart(6) + '%';
for (const [w, a] of jobs) {
  const label = w + (a.name !== '-' ? '/' + a.name : '');
  try {
    if (CENSUS) {
      const r = await page.evaluate((w, a) => window.__census(w, a), w, a);
      console.log(
        `\n${label}: per steady step ${JSON.stringify(r.per)}\n   setup ${JSON.stringify(r.setup)}`,
      );
      continue;
    }
    const r = await page.evaluate(
      (w, a, reps, tg) => window.__run(w, a, reps, tg),
      w,
      a,
      REPS,
      TARGET,
    );
    const base = r.out[0],
      aaRow = r.out[r.out.length - 1];
    const floor = (k) => Math.abs(aaRow[k] / base[k] - 1);
    console.log(
      `\n${label} @${N}: ${r.D} steps per sample; A/A floor wall ${(100 * floor('wall')).toFixed(1)}% cpu ${(100 * floor('cpu')).toFixed(1)}% (best-of wall ${(100 * Math.abs(aaRow.wallMin / base.wallMin - 1)).toFixed(1)}% cpu ${(100 * Math.abs(aaRow.cpuMin / base.cpuMin - 1)).toFixed(1)}%)`,
    );
    for (let i = 0; i < r.out.length; i++) {
      const o = r.out[i],
        nm = i < TREES.length ? TREES[o.ti].name : TREES[o.ti].name + "'";
      const verdict = (k) =>
        i === 0
          ? ''
          : Math.abs(o[k] / base[k] - 1) <= floor(k)
            ? 'tie'
            : o[k] < base[k]
              ? 'FASTER'
              : 'SLOWER';
      console.log(
        `  ${nm.padEnd(6)} wall ${o.wall.toFixed(4).padStart(9)} ms ${i ? pct(o.wall / base.wall) : '       '} ${verdict('wall').padEnd(6)}  cpu ${o.cpu.toFixed(4).padStart(9)} ms ${i ? pct(o.cpu / base.cpu) : '       '} ${verdict('cpu').padEnd(6)}  ` +
          `gpu ${o.gpu === o.gpu ? o.gpu.toFixed(4).padStart(9) : '      n/a'} ms ${i && o.gpu === o.gpu ? pct(o.gpu / base.gpu) : '       '}  iqr ${(100 * o.iqr).toFixed(1)}%  px ${o.px ? o.px.n + ' ch (max ' + o.px.mx + ')' : '-'}`,
      );
    }
  } catch (e) {
    console.log(`\n${label}: FAILED ${String(e.message).split('\n')[0]}`);
  }
}
const duty = await page.evaluate(() => window.__gpuDuty());
console.log(
  `\ngpu duty over the timed samples: ${(duty.busy / Math.max(1, duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await browser.close();
server.close();
