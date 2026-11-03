// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _maskCostProbe -- draw anatomy, pixel identity and ABBA timing of group-mask assets across source trees.
//
//   MODE=trace|ident|time  ARMS="a=/abs/root,b=/abs/root,c=/abs/root" FILES=list.txt [N=512] [REPS=8] [BATCH=] [GPU=1] [OUT=out.jsonl] node probes/_maskCostProbe.mjs
//
// ARMS: name=ROOT, ROOT holds src/ (a git archive of a commit, or a checkout). FILES: one SVG path per line.
//   trace  per arm: draws, clears, fbo switches, painted pixels (viewport x scissor per draw), RT sizes -- one warm frame, counted at the GL boundary
//   ident  per arm: FNV-1a hash of the N x N read-back after a warm frame + the draw count (identical hash = identical pixels)
//   time   ABBA rounds (A B B A ...), each arm timed per batch of frames with cpu / wall / gpu(TIME_ELAPSED) / sync (readPixels 1x1 = what scores:
//          gl.finish() does not sync here, the TIME_ELAPSED timer over-reports render-target passes -- see probes/_balanceBench.mjs)
//   GPU=1 -> ANGLE Metal; otherwise SwiftShader (counts and identity only, never timing)
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { launchBrowser } from '../test/_launch.mjs';

const MODE = process.env.MODE || 'trace',
  N = +(process.env.N || 512),
  REPS = +(process.env.REPS || 8),
  OUT = process.env.OUT || null;
const ARMS = Object.fromEntries(
  (process.env.ARMS || '')
    .split(',')
    .filter(Boolean)
    .map((a) => {
      const i = a.indexOf('=');
      return [a.slice(0, i), path.resolve(a.slice(i + 1))];
    }),
);
const FILES = readFileSync(process.env.FILES, 'utf8').split('\n').filter(Boolean);
const names = Object.keys(ARMS);
if (!names.length) throw new Error('ARMS=name=root,...');

const PAGE = `<!DOCTYPE html><html><body style="margin:0"><div id="root"></div>
<script type="module">
const N = ${N}, ARMS = ${JSON.stringify(names)};
// ---- GL boundary counters
const P = WebGL2RenderingContext.prototype, st = new WeakMap(); let fbIds = new WeakMap(), nextFb = 1, log = null;
const S = (gl) => { let s = st.get(gl); if (!s) { s = { fb: 0, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], scOn: false }; st.set(gl, s); } return s; };
const wrap = (name, f) => { const o = P[name]; P[name] = function (...a) { f(this, a); return o.apply(this, a); }; };
wrap('bindFramebuffer', (gl, a) => { const s = S(gl); s.fb = a[1] ? (fbIds.get(a[1]) || (fbIds.set(a[1], nextFb++), fbIds.get(a[1]))) : 0; if (log) log.fbSw++; });
wrap('viewport', (gl, a) => { S(gl).vp = a.slice(); });
wrap('scissor', (gl, a) => { S(gl).sc = a.slice(); });
wrap('enable', (gl, a) => { if (a[0] === gl.SCISSOR_TEST) S(gl).scOn = true; });
wrap('disable', (gl, a) => { if (a[0] === gl.SCISSOR_TEST) S(gl).scOn = false; });
const area = (s) => { let [x, y, w, h] = s.vp; if (s.scOn) { const [sx, sy, sw, sh] = s.sc; const x0 = Math.max(x, sx), y0 = Math.max(y, sy), x1 = Math.min(x + w, sx + sw), y1 = Math.min(y + h, sy + sh); w = Math.max(0, x1 - x0); h = Math.max(0, y1 - y0); } return Math.max(0, w) * Math.max(0, h); };
for (const d of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'])
  wrap(d, (gl) => { if (!log) return; const s = S(gl); log.draws++; log.px += area(s); log.list.push(['d', s.fb, s.vp.join('x'), s.scOn ? s.sc.join('x') : '-', area(s)]); });
wrap('clear', (gl) => { if (!log) return; const s = S(gl); log.clears++; log.clearPx += area(s); log.list.push(['c', s.fb, s.vp.join('x'), s.scOn ? s.sc.join('x') : '-', area(s)]); });
const startLog = () => { log = { draws: 0, clears: 0, px: 0, clearPx: 0, fbSw: 0, list: [] }; };
const endLog = () => { const l = log; log = null; return l; };

const CLEAR = [1, 1, 1, 1];
const arms = {};
for (const a of ARMS) {
  console.log('init ' + a);
  const m = await import('/' + a + '/src/index.js');console.log('imported');
  const shaders = await m.loadShaders(new URL('/' + a + '/src/shaders/', location.href).href);
  const c = document.createElement('canvas'); c.width = N; c.height = N; document.getElementById('root').appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  console.log('shaders');const r = m.createRenderer(gl, shaders, {}); console.log('renderer'); if (r.ready) await r.ready; console.log('ready'); r.setViewport(N, N);
  arms[a] = { m, gl, r, c, timer: gl.getExtension('EXT_disjoint_timer_query_webgl2'), b: null, cur: null };
}
const gi = (() => { const gl = arms[ARMS[0]].gl, d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })();
window.__gpu = gi;
const PX = new Uint8Array(4);
const sync = (gl) => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, PX);
const frame = (A) => { A.r.beginFrame(CLEAR); A.r.drawBundle(A.b); A.r.endFrame(); };
const hashOf = (A) => { const p = new Uint8Array(N * N * 4); A.gl.readPixels(0, 0, N, N, A.gl.RGBA, A.gl.UNSIGNED_BYTE, p);
  let h = 0x811c9dc5; for (let i = 0; i < p.length; i++) { h ^= p[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
// SETTLE: the engine route (worker-built Loop-Blinn meshes, specialized fill pipelines) arrives over several frames; a read taken before it
// lands compares two different routes. Warm, then draw until the picture and the draw count repeat three times running.
const settle = async (A) => {
  if (A.r.prepareBundle) { try { A.r.prepareBundle(A.b); } catch {} }
  if (A.r.awaitLbReady) { try { await A.r.awaitLbReady(A.b, 60000); } catch {} }
  await A.r.warmScene([{ draw: () => frame(A) }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  let last = '', same = 0;
  for (let i = 0; i < 80 && same < 3; i++) { frame(A); sync(A.gl); await new Promise((q) => setTimeout(q, 16)); const h = hashOf(A); if (h === last) same++; else { same = 0; last = h; } }
  A.stable = same >= 3;
};
window.__load = async (svg) => {
  const dbg = (x) => true && console.log('load ' + x);
  for (const a of ARMS) { const A = arms[a]; if (A.b) { try { A.b.dispose(); } catch {} A.b = null; }
    try { dbg('import ' + a); const imp = await A.m.importSvg(svg, {}); dbg('bundle'); A.b = A.m.createBundle(A.gl, imp); dbg('made'); } catch (e) { A.err = String(e.message || e); return { err: a + ': ' + A.err }; } }
  for (const a of ARMS) { await settle(arms[a]); dbg('settled ' + a); }
  return { ok: true };
};
window.__pix = (a) => { const A = arms[a]; frame(A); sync(A.gl); frame(A); const p = new Uint8Array(N * N * 4); A.gl.readPixels(0, 0, N, N, A.gl.RGBA, A.gl.UNSIGNED_BYTE, p); return p; };
window.__diff = (a, b) => { const p = window.__pix(a), q = window.__pix(b); let n = 0, mx = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < p.length; i += 4) { let d = 0; for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(p[i + k] - q[i + k])); if (d) { n++; mx = Math.max(mx, d); const x = (i >> 2) % N, y = ((i >> 2) / N) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  return { n, mx, bbox: n ? [x0, y0, x1, y1] : null }; };
window.__trace = (a) => { const A = arms[a]; frame(A); sync(A.gl); startLog(); frame(A); sync(A.gl); const l = endLog(); return l; };
window.__ident = (a) => { const A = arms[a]; frame(A); sync(A.gl); frame(A); return hashOf(A) + (A.stable ? '' : '!unstable'); };
const med = (x) => { x = x.slice().sort((p, q) => p - q); return x[x.length >> 1]; };
window.__time = async (reps, batchOpt) => {
  const rows = {}; for (const a of ARMS) rows[a] = { cpu: [], wall: [], sync: [], gpu: [] };
  let batch = batchOpt | 0;
  if (!batch) { const A = arms[ARMS[0]]; for (batch = 1; batch < 256; batch *= 2) { const t = performance.now(); for (let f = 0; f < batch; f++) frame(A); sync(A.gl); if (performance.now() - t >= 8) break; } }
  const once = async (a) => { const A = arms[a], gl = A.gl, ext = A.timer; let q = null; if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    const t = performance.now(); for (let f = 0; f < batch; f++) frame(A); const cpu = (performance.now() - t) / batch; if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.finish(); const wall = (performance.now() - t) / batch; sync(gl); const sy = (performance.now() - t) / batch;
    if (q) { for (let p = 0; p < 1000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); p++) await new Promise((r) => setTimeout(r, 0)); const ns = gl.getQueryParameter(q, gl.QUERY_RESULT); if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) rows[a].gpu.push(ns / 1e6 / batch); gl.deleteQuery(q); }
    rows[a].cpu.push(cpu); rows[a].wall.push(wall); rows[a].sync.push(sy); };
  for (let k = 0; k < reps; k++) { const ord = k % 2 ? ARMS.slice().reverse() : ARMS; for (const a of ord) await once(a); for (const a of ord.slice().reverse()) await once(a); }
  const out = {}; for (const a of ARMS) { const r = rows[a]; out[a] = { sync: med(r.sync), cpu: med(r.cpu), wall: med(r.wall), gpu: r.gpu.length ? med(r.gpu) : null }; }
  return { batch, out };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    const arm = u.split('/')[1];
    if (!ARMS[arm]) throw new Error('no arm');
    const file = path.resolve(ARMS[arm], '.' + u.slice(arm.length + 1));
    if (!file.startsWith(ARMS[arm] + path.sep)) throw new Error('bad path');
    res.writeHead(200, { 'content-type': u.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(file));
  } catch (e) {
    if (process.env.DEBUG) console.error('404', req.url, e.message);
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await launchBrowser(
  process.env.GPU === '1'
    ? {
        headless: 'new',
        protocolTimeout: 600000,
        defaultViewport: { width: N, height: N, deviceScaleFactor: 1 },
        args: ['--no-sandbox', '--use-angle=metal', '--use-gl=angle', '--enable-gpu'],
      }
    : {
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
      },
);
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
if (process.env.DEBUG)
  page.on('console', (m) => console.error('[console]', m.text().slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready===true', { timeout: 300000, polling: 250 });
const gpu = await page.evaluate(() => window.__gpu);
if (process.env.GPU === '1' && /swiftshader|llvmpipe|software/i.test(gpu))
  throw new Error('GPU=1 but renderer is ' + gpu);
console.log(`# ${MODE} N=${N} arms=${names.join(',')} gpu=${gpu}`);
if (OUT) writeFileSync(OUT, '');
for (const f of FILES) {
  const svg = readFileSync(f, 'utf8');
  const row = { file: f, mode: MODE };
  const l = await page.evaluate((s) => window.__load(s), svg);
  if (l.err) {
    row.err = l.err;
  } else if (MODE === 'trace') {
    for (const a of names) {
      const t = await page.evaluate((x) => window.__trace(x), a);
      row[a] = {
        draws: t.draws,
        clears: t.clears,
        fbSw: t.fbSw,
        mpx: +(t.px / 1e6).toFixed(3),
        clearMpx: +(t.clearPx / 1e6).toFixed(3),
        list: process.env.LIST ? t.list : undefined,
      };
    }
  } else if (MODE === 'diff') {
    const ref = process.env.REF || names[0];
    for (const a of names.filter((n) => n !== ref))
      row[a] = await page.evaluate((x, y) => window.__diff(x, y), ref, a);
  } else if (MODE === 'ident') {
    for (const a of names) {
      row[a] = { hash: await page.evaluate((x) => window.__ident(x), a) };
      const t = await page.evaluate((x) => window.__trace(x), a);
      row[a].draws = t.draws;
    }
    row.same = names.every((a) => row[a].hash === row[names[0]].hash);
  } else {
    const t = await page.evaluate((r, b) => window.__time(r, b), REPS, +(process.env.BATCH || 0));
    row.batch = t.batch;
    for (const a of names) row[a] = t.out[a];
  }
  const line = JSON.stringify(row);
  console.log(line);
  if (OUT) appendFileSync(OUT, line + '\n');
}
await browser.close();
server.close();
