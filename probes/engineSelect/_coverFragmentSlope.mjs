// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _coverFragmentSlope — is the Slug/AAC cover quad's excess worth chasing?
//
//   GPU=1 node probes/engineSelect/_coverFragmentSlope.mjs
//
// The cover quad shades **1.76x the ink it covers** corpus-wide (median 1.82x per shape, 44.7% of
// shapes over 2x, max 55x) against CPatch's 1.06x. The obvious way to price the ceiling is a
// PER-SHAPE scissor, "output-identical and costing nothing to try".
//
// A per-shape scissor cannot be measured that way. Cover quads are BATCHED into one draw, so
// scissoring per shape means one draw per shape, and the batching loss would be mixed into the
// fragment saving -- the probe would price its own implementation, not the ceiling.
//
// THE CEILING IS A SLOPE, and it needs no per-shape work. If fill time is fragment-bound, then
// removing a fraction f of the fragments saves a fraction f of the time, and the 1.76x ratio
// prices directly: 1 - 1/1.76 = 43% of the cover fragments are waste. So this scissors the whole
// draw to a shrinking share of the canvas and measures how time responds:
//
//   * time proportional to scissored area  -> fragment-bound; the 1.76x is worth ~43% of fill time
//     and a cover fan is worth building.
//   * time flat as the area shrinks        -> NOT fragment-bound; the excess fragments are nearly
//     free, and the whole line of work is priced out.
//
// A scissor is the right instrument precisely because it changes nothing but which fragments
// survive: same geometry, same draws, same shader, same band walk, same batching.
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
const SIZE = +(process.env.SIZE || 1024);
const FRAMES = +(process.env.FRAMES || 60);
const REPS = +(process.env.REPS || 5);
const SHARES = (process.env.SHARES || '1,0.75,0.5,0.25').split(',').map(Number);
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

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {});
if (R.ready) await R.ready;
const cache = new Map();
window.__arm = async (url, kernel, share, frames) => {
  R.setFillEngine({ route: 'none', kernel });        // cover quads only: no LB meshes
  if (!cache.has(url)) cache.set(url, await (await fetch(url)).text());
  const sec = await importSvg(cache.get(url), { preserveViewport: true });
  const b = createBundle(gl, sec);
  if (R.prepareBundle) R.prepareBundle(b);
  const S = ${SIZE};
  R.setViewport(S, S); gl.viewport(0, 0, S, S);
  // The scissor keeps a centred share of the canvas. Everything else is identical.
  const w = Math.max(1, Math.round(S * Math.sqrt(share)));
  const o = Math.round((S - w) / 2);
  const draw = () => {
    if (share < 1) R.setScissorRect(o, o, w, w); else R.setScissorRect(0, 0, S, S);
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
  };
  for (let i = 0; i < 8; i++) draw();
  gl.finish();
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i+1] < 250 || px[i+2] < 250) ink++;
  // THROTTLED: fence-synced bursts, each followed by an idle outside the clock (window.__gpuFrames,
  // test/_gpuThrottle.mjs). One timer query per burst, summed, read after the burst's clock stopped.
  let q = null, gpuSum = 0, gpuOk = !!ext;
  const timed = await window.__gpuFrames(frames, () => { draw(); }, async () => {
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
  R.setScissorRect(0, 0, S, S);
  b.dispose();
  return { wall: wall / frames, gpu: gpuMs, ink };
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
const cap = capWallTime('_coverFragmentSlope', async () => {
  await br.close();
  server.close();
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 100 });
await installGpuThrottle(pg);
console.log(gpuThrottleBanner());

const run = (url, kernel, share) =>
  pg.evaluate((u, k, s, f) => window.__arm(u, k, s, f), url, kernel, share, FRAMES);
const best = (xs) => xs.reduce((a, b) => (b.wall < a.wall ? b : a));
await run(`/${ASSETS[0][1]}`, 'slug', 1); // discard arm

console.log(
  `COVER EXCESS — does fill time follow FRAGMENT COUNT? scissor sweep @${SIZE}, ${FRAMES} frames x ${REPS} reps, fence-synced`,
);
for (const [name, rel] of ASSETS) {
  for (const kernel of (process.env.KERNELS || 'slug,aac').split(',')) {
    console.log(`\n  ${name} / ${kernel}`);
    console.log('    share   scissored px      ms     ms/full   ink      slope');
    let full = null;
    for (const share of SHARES) {
      const rs = [];
      for (let i = 0; i < REPS; i++) rs.push(await run(`/${rel}`, kernel, share));
      const r = best(rs);
      if (full === null) full = r.wall;
      const rel2 = r.wall / full;
      // slope: fraction of time removed per fraction of area removed. 1.0 = perfectly
      // fragment-bound, 0.0 = fragments are free.
      const slope = share < 1 ? (1 - rel2) / (1 - share) : 1;
      console.log(
        `    ${share.toFixed(2)}   ${String(Math.round(SIZE * SIZE * share)).padStart(9)}  ${r.wall.toFixed(3).padStart(7)}` +
          `  ${rel2.toFixed(3).padStart(7)}  ${String(r.ink).padStart(7)}   ${share < 1 ? slope.toFixed(2) : '   —'}`,
      );
    }
  }
}
console.log('\n  slope ~1.0 => fragment-bound: the 1.76x cover excess is worth ~43% of fill time.');
console.log('  slope ~0.0 => fragments are nearly free: the cover-fan line of work is priced out.');
const duty = await pg.evaluate(() => window.__gpuDuty());
console.log(
  `gpu duty over the timed bursts: ${(duty.busy / (duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await br.close();
server.close();
process.exit(0);
