// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchCombineAB — what exact COMBINE costs CPatch, and whether it is more accurate.
//
//   GPU=1 node probes/engineSelect/_cpatchCombineAB.mjs
//
// The claim under test: "exact combine doubles CPatch frame time". This prices it.
//
// WHAT exact COMBINE IS. CPatch combines four ramped hull planes with min(). min() is right about
// OWNERSHIP and wrong as an AREA at a corner: two planes that each cover half the pixel return
// 0.5, where the true intersection is a quarter. `exactBoxCov2` is the exact answer for two
// half-planes -- and it is NOT cheap arithmetic, it is a Sutherland-Hodgman clip of the pixel box
// over two passes, which is the "register-bound loop" the row names. The arm keeps the TWO
// TIGHTEST planes live (a corner is where two boundaries meet) and leaves out-of-span planes on
// min(), where they are a hard ownership test carrying no area.
//
// SPEED IS only HALF THE QUESTION. A combiner that is cheaper and wrong is not a win, so the arms
// are compared on PIXELS too: `sum` is the summed channel value of the whole frame, and the arms
// MUST differ. A define that failed to compile, or a branch no fragment reaches, reads
// byte-identical -- and byte-identical would mean this measured nothing.
// THROTTLED (test/_gpuThrottle.mjs): the timed frames run in fence-synced bursts of <= MANTLE_GPU_BURST_MS, each
// followed by an idle of at least its own length (MANTLE_GPU_DUTY, default 0.5) outside the clock; wall/frame is the
// bursts' summed time over the frame count, the GPU timer one query per burst, summed. The fence is polled with a
// MessageChannel yield (window.__gpuFence), not setTimeout(1): after an idle every timer is nested and clamps to 4 ms,
// paid once per burst. The run is capped at MANTLE_GPU_WALL_MS. Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync, existsSync } from 'fs';
import { benchNames, BENCH_UNSET } from '../../test/_assets.mjs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIZES = (process.env.SIZES || '512,1024').split(',').map(Number);
const FRAMES = +(process.env.FRAMES || 60);
const REPS = +(process.env.REPS || 3);
// STROKE-HEAVY assets: the branch under test is the stroke kernel's closest point on a CUBIC, so
// an asset with no stroked cubic cannot move and would only dilute the result.
const CANDIDATES = [
  ['tiger', 'examples/tiger.svg'],
  ...benchNames().map((n) => [n, `examples/_bench/${n}.svg`]),
];
if (!benchNames().length) console.log(BENCH_UNSET);
const only = process.env.ASSETS ? new Set(process.env.ASSETS.split(',')) : null;
const ASSETS = CANDIDATES.filter(
  ([n, rel]) => (!only || only.has(n)) && existsSync(path.join(ROOT, rel)),
);
if (!ASSETS.length) {
  console.error('no assets found');
  process.exit(2);
}

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="a" width="2048" height="2048"></canvas><canvas id="b" width="2048" height="2048"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const opts = { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true };
const GA = document.getElementById('a').getContext('webgl2', opts);
const GB = document.getElementById('b').getContext('webgl2', opts);
const base = await loadShaders(new URL('/src/shaders/', location.href).href);

// INJECT THE DEFINE after the #version line, which must stay first in a GLSL ES 3.00 source.
const withDefine = (srcs, def) => {
  const out = {};
  for (const k of Object.keys(srcs)) {
    const s = srcs[k];
    if (typeof s !== 'string') { out[k] = s; continue; }
    out[k] = s.replace(/^(#version[^\\n]*\\n)/, (m) => m + '#define ' + def + ' 1\\n');
    if (out[k] === s) out[k] = '#define ' + def + ' 1\\n' + s;
  }
  return out;
};
const mk = async (g, srcs) => { const R = createRenderer(g, srcs, {}); if (R.ready) await R.ready; return R; };
const T = {
  shipped: await mk(GA, base),
  exact: await mk(GB, withDefine(base, 'MANTLE_CPATCH_EXACT_COMBINE')),
};
const srcCache = new Map();
const getSvg = async (u) => { if (!srcCache.has(u)) srcCache.set(u, await (await fetch(u)).text()); return srcCache.get(u); };

window.__arm = async (url, size, which, frames) => {
  const R = T[which];
  R.setFillEngine({ route: 'cpatch', kernel: 'auto' });
  const gl = which === 'shipped' ? GA : GB;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const sec = await importSvg(await getSvg(url), { preserveViewport: true });
  const b = createBundle(gl, sec);
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b); } catch {} }
  R.setViewport(size, size); gl.viewport(0, 0, size, size);
  for (let i = 0; i < 8; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  gl.finish();
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) ink++;
  const before = Object.assign({}, ((R.debugStats && R.debugStats.engines || {}).draws) || {});
  // THROTTLED: fence-synced bursts, each followed by an idle outside the clock (window.__gpuFrames,
  // test/_gpuThrottle.mjs). One timer query per burst, summed, read after the burst's clock stopped.
  let q = null, gpuSum = 0, gpuOk = !!ext;
  const timed = await window.__gpuFrames(frames, () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }, async () => {
    if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
    await window.__gpuFence(gl, 15000);   // a MessageChannel poll: a setTimeout poll clamps to 4 ms per burst
  }, {
    begin: () => { if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); } },
    end: async () => {
      if (!q) return;
      for (let i = 0; i < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); i++) await new Promise((r) => setTimeout(r, 5));
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuSum += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      else gpuOk = false;
      gl.deleteQuery(q); q = null;
    },
  });
  const wall = timed.ms;
  const gpuMs = gpuOk ? gpuSum / frames : -1;
  const after = ((R.debugStats && R.debugStats.engines || {}).draws) || {};
  const drew = {};
  for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  b.dispose();
  let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i+1] + px[i+2];
  return { wall: wall / frames, gpu: gpuMs, ink, drew, sum };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, {
      'content-type': pp.endsWith('.glsl')
        ? 'text/plain'
        : pp.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/javascript',
    });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const cap = capWallTime('_cpatchCombineAB', async () => {
  await br.close();
  server.close();
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 200));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 100 });
await installGpuThrottle(pg);
console.log(gpuThrottleBanner());

const run = (url, size, which) =>
  pg.evaluate((u, s, w, f) => window.__arm(u, s, w, f), url, size, which, FRAMES);
const best = (xs) => xs.reduce((a, b) => (b.wall < a.wall ? b : a));
await run(`/${ASSETS[0][1]}`, SIZES[0], 'shipped'); // discard arm

console.log(
  `EXACT COMBINE — exact combine against min(), CPatch route, ${FRAMES} frames x ${REPS} reps, fence-synced`,
);
console.log(
  "  asset        size   min()     exact     min()'  |  A/A    exact/min()   pixels differ?",
);
let over = 0,
  rows = 0;
for (const [name, rel] of ASSETS) {
  for (const size of SIZES) {
    const S = [],
      D = [],
      S2 = [];
    for (let i = 0; i < REPS; i++) {
      S.push(await run(`/${rel}`, size, 'shipped'));
      D.push(await run(`/${rel}`, size, 'exact'));
      D.push(await run(`/${rel}`, size, 'exact'));
      S2.push(await run(`/${rel}`, size, 'shipped'));
    }
    const s = best(S),
      d = best(D),
      s2 = best(S2);
    if (!s.ink || !d.ink) {
      console.log(`  ${name} @${size}: BLANK FRAME (ink ${s.ink}/${d.ink}) — not timed`);
      continue;
    }
    // An arm whose shader did not compile falls back; its engine set gives it away.
    const same =
      JSON.stringify(Object.keys(s.drew).sort()) === JSON.stringify(Object.keys(d.drew).sort());
    const floor = Math.abs(s2.wall - s.wall) / Math.min(s.wall, s2.wall);
    const r = d.wall / Math.min(s.wall, s2.wall);
    rows++;
    if (r > 1.2) over++;
    const moved = s.sum !== d.sum;
    console.log(
      `  ${name.padEnd(12)}${String(size).padStart(4)}${s.wall.toFixed(3).padStart(10)}${d.wall.toFixed(3).padStart(10)}${s2.wall.toFixed(3).padStart(10)}` +
        `  | ${(100 * floor).toFixed(1).padStart(5)}%  ${r.toFixed(3)}x  ${moved ? 'yes' : 'NO — IDENTICAL'}`,
    );
    if (!moved)
      console.log(
        '    !! the two arms produced the SAME pixels: the define did not take, or no fragment reaches that branch. This cell measured nothing.',
      );
    if (!same)
      console.log(
        `    !! ENGINE SET DIFFERS ${JSON.stringify(s.drew)} -> ${JSON.stringify(d.drew)} — an arm fell back; not a kernel comparison`,
      );
  }
}
console.log(
  `\nCP1: ${over} of ${rows} cell(s) over 1.2x (the row claims exact combine DOUBLES the frame time)`,
);
const duty = await pg.evaluate(() => window.__gpuDuty());
console.log(
  `gpu duty over the timed bursts: ${(duty.busy / (duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await br.close();
server.close();
process.exit(0);
