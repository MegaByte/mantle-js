// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _shapeEngineCost — what each fill ENGINE costs each SHAPE, over a real corpus. The data per-shape engine gates are fitted to.
//
// A bundle-level bench can only rank engines for whole assets, and the engines' costs follow different axes inside one: Slug's
// the bbox pixels it walks, AAC's the band work per fragment, Loop-Blinn's its triangles and the pixels its crescents shade. A
// per-shape choice needs per-shape costs, so this draws ONE shape at a time (drawSprite over a one-row range) with each engine,
// on the same renderer that times the whole bundle.
//
// PER SHAPE, three numbers per engine, all per DRAW:
//   ms     the shape drawn normally
//   zero   the same draw under a 1e-4 world scale: every vertex, bind and uniform, almost no fragments. ms - zero is what
//          the shape's pixels cost; zero is the per-draw fixed part a real bundle draw amortizes across its shapes.
//   rep    draws per timed frame (at least 4), calibrated on the first engine so each frame clears TARGET_MS, and reused by
//          every engine. Every number has the EMPTY frame (clear, endFrame, 1-px sync readback, no draws) subtracted before it
//          is divided by rep: at one draw per frame that fixed part would be charged whole to the draw.
// Sampled shapes are fill rows (stroke rows keep their cover quad under every engine), up to K per asset, spread over the
// asset's bbox-area distribution. Features per sampled shape come from the renderer's own shapeStats, plus bbox px2 at N
// and the LB vertex count.
//
//   CORPUS=file   one SVG path per line          SIZES=1024     ARMS=slug,aac,lb      K=12
//   FRAMES=9      TARGET_MS=4                     OUT=file.jsonl (appended; START/LIMIT slice the list)
//   PAGE_ROOT     the source tree the PAGE loads  NOSDF=1        PAGE_TIMEOUT=240 (seconds per asset/size)
//
// One JSON line per (asset, size): { asset, N, ok, err?, shapes:[{s, segs, types, cross, area, bboxPx2, lbVerts}],
// arms: { arm: { bundleMs, repB, draws, uni, shapes: { s: { ms, zero, rep } } } } }.
import { readFileSync, appendFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_ROOT = process.env.PAGE_ROOT ? path.resolve(process.env.PAGE_ROOT) : ROOT;
const LIST = readFileSync(process.env.CORPUS, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
const SIZES = (process.env.SIZES || '1024').split(',').map(Number);
const ARMS = (process.env.ARMS || 'slug,aac,lb').split(',').filter(Boolean);
const K = +(process.env.K || 12),
  FRAMES = +(process.env.FRAMES || 9),
  TARGET = +(process.env.TARGET_MS || 4);
const OUT = process.env.OUT;
const START = +(process.env.START || 0),
  LIMIT = +(process.env.LIMIT || 0);
const PAGE_TIMEOUT = 1000 * +(process.env.PAGE_TIMEOUT || 240);
const NOSDF = process.env.NOSDF ? 'true' : 'false';

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import * as _md from '/src/renderer/morphDraw.js';
import { parseMetaBin } from '/src/core/metaBin.js';
import { shapeSegStats } from '/src/renderer/shapeStats.js';
const clearLbMeshCaches = _md.clearLbMeshCaches || (() => {});
if (${NOSDF}) { try { (await import('/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false); } catch {} }
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sleepP = (ms) => new Promise((z) => setTimeout(z, ms));
const one = new Uint8Array(4);
const ZERO = [1e-4, 0, 0, 0, 1e-4, 0, 0, 0, 1];
window.__run = async (svg, N, arms, K, FRAMES, TARGET) => {
  const sec = await importSvg(svg, { preserveViewport: true });
  const mm = parseMetaBin(sec.meta, sec.metaFloatsPerShape), MF = mm.metaFloats, ST = mm.floatsPerShape | 0;
  const gbb = sec.globalBBox, fit = Math.min(N / gbb[2], N / gbb[3]);
  const rows = [];
  for (let s = 0; s < mm.numShapes; s++) {
    const o = s * ST;
    if (!(MF[o + 7] > 0) || (MF[o + 11] > 0 && MF[o + 12] > 0)) continue;
    const a = (MF[o + 2] - MF[o]) * (MF[o + 3] - MF[o + 1]);
    if (a > 0) rows.push([a, s]);
  }
  rows.sort((x, y) => x[0] - y[0]);
  const pick = [];
  for (let i = 0; i < Math.min(K, rows.length); i++) {
    const s = rows[Math.min(rows.length - 1, Math.floor((i + 0.5) * rows.length / Math.min(K, rows.length)))][1];
    if (!pick.includes(s)) pick.push(s);
  }
  const out = { N, shapes: [], arms: {} };
  const reps = new Map();
  cv.width = N; cv.height = N;
  // THE FIRST LARGE ALLOCATION IN A PAGE RUNS SLOW FOR ITS WHOLE LIFE (see _zzEnginePaint's WARM2): the page's first arm read
  // tiger's Slug at 11-16 ms a draw against 4.6 measured elsewhere. A throwaway renderer and bundle, drawn and disposed, takes it.
  { const rw = createRenderer(gl, shaders, {}); rw.setLoopBlinnFill('off');
    const bw = createBundle(gl, sec); if (rw.prepareBundle) rw.prepareBundle(bw);
    rw.setViewport(N, N); gl.viewport(0, 0, N, N);
    for (let k = 0; k < 8; k++) { rw.beginFrame([1, 1, 1, 1]); rw.drawBundle(bw); rw.endFrame(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); }
    bw.dispose(); if (rw.dispose) rw.dispose(); }
  for (const arm of arms) {
    for (const k of Object.keys(globalThis)) if (/^__(CP|MANTLE|LB|lb)/.test(k)) delete globalThis[k];
    clearLbMeshCaches();
    const opts = arm === 'aac' ? { aacFill: true } : arm === 'auto' ? { aacFill: 'auto' } : {};
    const r = createRenderer(gl, shaders, opts);
    r.setLoopBlinnFill(arm === 'lb' ? 'on' : arm === 'auto' ? 'auto' : 'off');
    if (arm === 'bandhard' && r.setFillEngine) r.setFillEngine({ kernel: 'hard-band' });
    const b = createBundle(gl, sec);
    if (r.prepareBundle) r.prepareBundle(b);
    { let w = 0; while (b._occupancyBuildPending && w < 30000) { await sleepP(5); w += 5; } }
    if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
    { let w = 0; while (b._occlusionCullPending && w < 20000) { await sleepP(20); w += 20; } }
    if (r.precompileFills) r.precompileFills();
    r.setViewport(N, N); gl.viewport(0, 0, N, N);
    // WARM like _zzEnginePaint's precompile path: yielding frames until the variant compile count holds still, so a lean
    // variant whose pipeline is still warming is not what gets timed.
    { let still = 0, last = -1, i = 0; const t0 = performance.now();
      while (i++ < 200 && (still < 12 || performance.now() - t0 < 400)) {
        r.beginFrame([1, 1, 1, 1]); r.drawBundle(b); r.endFrame(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); await sleepP(0);
        const vc = (r.debugStats && r.debugStats.variantCompiles) | 0; still = vc === last ? still + 1 : 0; last = vc; } }
    const time = (fn, rep) => {
      const ts = [];
      for (let k = 0; k < FRAMES; k++) {
        const t0 = performance.now();
        r.beginFrame([1, 1, 1, 1]); for (let q = 0; q < rep; q++) fn(); r.endFrame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
        if (k >= 2) ts.push(performance.now() - t0);
      }
      ts.sort((x, y) => x - y);
      return ts[ts.length >> 1];
    };
    const u0 = (r.debugStats && r.debugStats.unifiedFillDraws) | 0;
    const empty = time(() => {}, 1);
    const per = (ms, rep) => Math.max(0, ms - empty) / rep;
    const b1 = per(time(() => r.drawBundle(b), 4), 4);
    const repB = Math.max(4, Math.min(256, 2 ** Math.ceil(Math.log2(Math.max(1, TARGET / Math.max(b1, 0.02))))));
    const res = { bundleMs: per(time(() => r.drawBundle(b), repB), repB), repB, emptyMs: empty, shapes: {},
      uni: ((r.debugStats && r.debugStats.unifiedFillDraws) | 0) - u0,
      draws: JSON.stringify((r.debugStats && r.debugStats.engines && r.debugStats.engines.draws) || null) };
    for (const s of pick) {
      let rep = reps.get(s);
      if (!rep) {
        const m4 = per(time(() => r.drawSprite(b, [s, s]), 4), 4);
        rep = Math.max(4, Math.min(1024, 2 ** Math.ceil(Math.log2(Math.max(1, TARGET / Math.max(m4, 0.002))))));
        reps.set(s, rep);
      }
      res.shapes[s] = { ms: per(time(() => r.drawSprite(b, [s, s]), rep), rep),
        zero: per(time(() => r.drawSprite(b, [s, s], { worldMatrix: ZERO }), rep), rep), rep };
    }
    if (!out.shapes.length) {
      const st = shapeSegStats(b);
      for (const s of pick) {
        const o = s * ST;
        out.shapes.push({ s, segs: st ? st.segs[s] : -1, types: st ? st.types[s] : -1, cross: st ? +st.cross[s].toFixed(3) : -1,
          area: st && st.area ? st.area[s] * fit * fit : -1, bboxPx2: (MF[o + 2] - MF[o]) * (MF[o + 3] - MF[o + 1]) * fit * fit, lbVerts: -1 });
      }
    }
    if (arm === 'lb' && b._lbMeshes) for (const f of out.shapes) {
      const m = b._lbMeshes[f.s]; f.lbVerts = m && !m.slug ? (m.vertexCount | 0) : -1;
    }
    out.arms[arm] = res;
    b.dispose(); if (r.dispose) r.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HTML);
  }
  try {
    const p = path.join(PAGE_ROOT, u);
    if (!p.startsWith(PAGE_ROOT)) throw new Error('esc');
    const body = readFileSync(p);
    const ct =
      u.endsWith('.js') || u.endsWith('.mjs')
        ? 'text/javascript'
        : u.endsWith('.glsl')
          ? 'text/plain'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('no');
  }
});
await new Promise((z) => srv.listen(0, z));
const launch = () =>
  launchBrowser({
    headless: 'new',
    protocolTimeout: PAGE_TIMEOUT + 60000,
    args: ['--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
  });
let browser = await launch();
const list = LIST.slice(START, LIMIT ? START + LIMIT : undefined);
let done = 0;
for (const asset of list) {
  let svg;
  try {
    svg = readFileSync(asset, 'utf8');
  } catch (e) {
    continue;
  }
  for (const N of SIZES) {
    const t0 = Date.now();
    let rec;
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
    try {
      await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
      await page.waitForFunction('window.__ready === true', { timeout: 60000 });
      const got = await Promise.race([
        // ARM ORDER ROTATES per asset, so what the page's first arm still pays averages over engines instead of landing on one.
        page.evaluate(
          (s, n, a, k, f, t) => window.__run(s, n, a, k, f, t),
          svg,
          N,
          ARMS.slice(done % ARMS.length).concat(ARMS.slice(0, done % ARMS.length)),
          K,
          FRAMES,
          TARGET,
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('page timeout')), PAGE_TIMEOUT)),
      ]);
      rec = { asset, N, ok: true, ...got };
    } catch (e) {
      rec = { asset, N, ok: false, err: String((e && e.message) || e).slice(0, 300) };
      try {
        await browser.close();
      } catch {}
      browser = await launch();
    }
    try {
      await page.close();
    } catch {}
    if (OUT) appendFileSync(OUT, JSON.stringify(rec) + '\n');
    done++;
    console.log(
      `${done}/${list.length * SIZES.length} ${path.basename(asset)} @${N} ${rec.ok ? 'ok' : 'FAIL ' + rec.err} ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (rec.ok
          ? ' ' +
            Object.entries(rec.arms)
              .map(([a, v]) => `${a} ${v.bundleMs.toFixed(3)}`)
              .join(' ')
          : ''),
    );
  }
  if (done % 40 === 0) {
    try {
      await browser.close();
    } catch {}
    browser = await launch();
  }
}
try {
  await browser.close();
} catch {}
srv.close();
