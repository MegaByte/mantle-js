// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _sceneKernelMix — does a kernel's presence cost amortize when a GAME draws many different bundles?
//
// A fill program pays for the kernels compiled into it on every fragment it shades, whether a fragment uses them or not:
// an unused AAC kernel in an all-LB unified draw measured +15-30% of the frame (tiger, mixed64, a cubic star). One bundle on
// its own cannot say what that means for a scene, where the alternative to one big program is a lean program PER BUNDLE and
// a program switch between them. This draws a scene of several real bundles, as many small instances, three ways:
//   auto       the renderer's own choice per bundle (per-shape LB + its cover kernel): a lean program per bundle
//   leanslug   Slug on the plain fill pass, lean variants per bundle (type masks, feature strips): switches, no LB
//   universal  Slug on the plain fill pass through ONE program for every bundle (disableFillVariants): no switches
// Scenes: D draws per frame (8, 32, 128) over the bundle set, BLOCKED (every instance of one bundle, then the next) and
// INTERLEAVED (round robin), tiled over the canvas with world matrices. Per arm and scene: synced frame (best, median), JS
// submit (median), program switches and draws in one counted frame, and variant compiles DURING the timed frames (must be 0).
//
//   SVGS=a.svg,b.svg,...  (default: the engine corpus assets)   N=1024   FRAMES=24   REPS=2   PAGE_ROOT   OUT=file.json
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_ROOT = process.env.PAGE_ROOT ? path.resolve(process.env.PAGE_ROOT) : ROOT;
const REPO = path.resolve(ROOT, '..');
const DEFAULT = [path.join(REPO, 'MantleSamples/Assets/Mantle/tiger.svg')];
const SVGS = (process.env.SVGS ? process.env.SVGS.split(',') : DEFAULT).map((p) => path.resolve(p));
const N = +(process.env.N || 1024),
  FRAMES = +(process.env.FRAMES || 24),
  REPS = +(process.env.REPS || 2);
const DRAWS = (process.env.DRAWS || '8,32,128').split(',').map(Number);
const ARMS = (process.env.ARMS || 'auto,leanslug,universal').split(',');
const TEXTS = SVGS.map((p) => readFileSync(p, 'utf8'));

const HTML = `<!doctype html><body style="margin:0"><canvas id=c width=${N} height=${N}></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
try { const m = await import('/src/geom/shapeRecognize.js'); if (m.setSdfPrimitivesEnabled) m.setSdfPrimitivesEnabled(false); } catch {}
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true });
const counts = { prog: 0, draw: 0, on: false };
{ const up = gl.useProgram.bind(gl); let last = null;
  gl.useProgram = (p) => { if (counts.on && p !== last) counts.prog++; last = p; return up(p); };
  for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const o = gl[fn].bind(gl); gl[fn] = (...a) => { if (counts.on) counts.draw++; return o(...a); };
  } }
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const TEXTS = ${JSON.stringify(TEXTS)};
const secs = [];
for (const t of TEXTS) secs.push(await importSvg(t, { preserveViewport: true }));
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const one = new Uint8Array(4);
window.__arm = async (arm, drawsList, FRAMES) => {
  const opts = arm === 'auto' ? { aacFill: 'auto' } : arm === 'universal' ? { disableFillVariants: true } : {};
  const r = createRenderer(gl, shaders, opts);
  r.setLoopBlinnFill(arm === 'auto' ? 'auto' : 'off');
  r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const bundles = secs.map((s) => createBundle(gl, s));
  for (const b of bundles) { if (r.prepareBundle) r.prepareBundle(b); }
  for (const b of bundles) { let w = 0; while (b._occupancyBuildPending && w < 30000) { await sleep(5); w += 5; }
    if (arm === 'auto' && r.awaitLbReady) { try { await r.awaitLbReady(b, 30000); } catch {} }
    let c = 0; while (b._occlusionCullPending && c < 20000) { await sleep(20); c += 20; } }
  if (r.precompileFills) r.precompileFills();
  const out = {};
  for (const D of drawsList) {
    const g = Math.ceil(Math.sqrt(D)), sc = 1 / g;
    const cell = (i) => [sc, 0, 0, 0, sc, 0, -1 + (2 * (i % g) + 1) / g, -1 + (2 * Math.floor(i / g) + 1) / g, 1];
    const per = Math.ceil(D / bundles.length);
    const blocked = [], inter = [];
    for (let k = 0; k < bundles.length; k++) for (let m = 0; m < per; m++) blocked.push(k);
    for (let m = 0; m < per; m++) for (let k = 0; k < bundles.length; k++) inter.push(k);
    for (const [name, order] of [['blocked', blocked.slice(0, D)], ['interleaved', inter.slice(0, D)]]) {
      const mats = order.map((_, i) => cell(i));
      const frame = () => { r.beginFrame([1, 1, 1, 1]); for (let i = 0; i < order.length; i++) r.drawBundle(bundles[order[i]], { worldMatrix: mats[i] }); r.endFrame(); };
      for (let w = 0; w < 40; w++) { frame(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); if (w % 8 === 7) await sleep(0); }
      const c0 = (r.debugStats && r.debugStats.variantCompiles) | 0;
      const ts = [], cs = [];
      for (let k = 0; k < FRAMES; k++) {
        const t0 = performance.now(); frame(); const tc = performance.now() - t0;
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
        if (k >= 4) { ts.push(performance.now() - t0); cs.push(tc); }
      }
      const compiles = ((r.debugStats && r.debugStats.variantCompiles) | 0) - c0;
      counts.prog = 0; counts.draw = 0; counts.on = true; frame(); counts.on = false;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      ts.sort((a, b) => a - b); cs.sort((a, b) => a - b);
      out[D + ':' + name] = { best: ts[0], med: ts[ts.length >> 1], cpu: cs[cs.length >> 1], progs: counts.prog, draws: counts.draw, compiles,
        engines: JSON.stringify((r.debugStats && r.debugStats.engines && r.debugStats.engines.draws) || null) };
    }
  }
  for (const b of bundles) b.dispose && b.dispose();
  if (r.dispose) r.dispose();
  return out;
};
window.__ready = true;
</script></body>`;

const srv = http.createServer((q, res) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HTML);
  }
  try {
    const p = path.join(PAGE_ROOT, u);
    if (!p.startsWith(PAGE_ROOT)) throw new Error('esc');
    res.writeHead(200, { 'content-type': u.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(p));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((z) => srv.listen(0, '127.0.0.1', z));
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 900000,
  args: ['--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
});
const res = {};
const order = [];
for (let i = 0; i < REPS; i++) order.push(...(i % 2 ? [...ARMS].reverse() : ARMS));
for (const arm of order) {
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(`[${arm}]`, e.message));
  await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 600000 });
  const o = await pg.evaluate((a, d, f) => window.__arm(a, d, f), arm, DRAWS, FRAMES);
  await pg.close();
  for (const [k, v] of Object.entries(o)) {
    const key = arm + '|' + k;
    if (!res[key] || v.best < res[key].best) res[key] = v;
  }
}
await br.close();
srv.close();
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(res, null, 1));
console.log(
  `${SVGS.length} bundles: ${SVGS.map((p) => path.basename(p, '.svg')).join(', ')}   N=${N}, best of ${REPS} pages per arm`,
);
console.log(
  'draws order        | ' +
    ARMS.map((a) => `${a}: best/med ms, cpu ms, programs/frame`).join(' | '),
);
for (const D of DRAWS)
  for (const name of ['blocked', 'interleaved']) {
    const cells = ARMS.map((a) => {
      const v = res[a + '|' + D + ':' + name];
      return v
        ? `${a} ${v.best.toFixed(2)}/${v.med.toFixed(2)} cpu ${v.cpu.toFixed(2)} prog ${v.progs} draws ${v.draws}${v.compiles ? ' COMPILES ' + v.compiles : ''}`
        : `${a} -`;
    });
    console.log(`${String(D).padStart(4)} ${name.padEnd(12)} | ${cells.join(' | ')}`);
  }
console.log(
  '\nengines (auto arm, 128 interleaved): ' + ((res['auto|128:interleaved'] || {}).engines || '-'),
);
