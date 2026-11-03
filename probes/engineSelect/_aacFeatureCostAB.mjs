// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aacFeatureCostAB — WHICH FEATURE makes AAC expensive on layered art.
//
//   GPU=1 node probes/engineSelect/_aacFeatureCostAB.mjs
//
// The claim: "clipped art costs AAC 4.6-5.5x Slug". `aacClipConfoundSmoke` shows the premise is
// inverted, with no GPU: the clip and mask CHILDREN are sampled with `renderFill`
// (Slug's walker) at all 11 call sites in mantle.frag.glsl and never with `renderFillAAC`, so a
// clip's own work is a cost both arms pay and pushes an aac/slug ratio toward 1; and a clip moves
// the cover fragments, the mean depth, the tile proxy and the band walk by exactly 0.0%, because
// the clip's carrier rows are never drawn. Counting those rows as cover quads is the trap that
// makes it look otherwise.
//
// What is left is WHICH feature does cost. The corpus cannot say -- `clipPath with no
// mask/opacity/filter` is ZERO cells and `mask with no clipPath` is ZERO cells, so every cell that
// produced the claim carries all of them at once.
//
// SO THE ARMS TURN ONE FEATURE OFF AT A TIME, on a fixture built here rather than on the
// proprietary art the claim came from -- which also makes this reproducible:
//
//   A0 as authored   A1 -clip   A2 -mask   A3 -group opacity   A4 gradients->solid   A5 all off
//
// PREDICTION (from the smoke): A1 barely moves the ratio, while A2 and A3 move it a lot, because a
// mask and a group opacity force per-shape draws and RT round trips, and AAC's cost there is per
// DRAW rather than per fragment. FALSIFIER: A1 collapsing the ratio toward A5's, which would mean
// the clip is the cause after all.
//
// The metric is the aac/slug RATIO within each arm, so anything both kernels pay cancels. The
// engine is pinned with setFillEngine (the only pin that survives the route) and the bound kernel
// is read back per arm, because a pin that silently fell back reads as a triumph.
// THROTTLED (test/_gpuThrottle.mjs): the timed frames run in fence-synced bursts of <= MANTLE_GPU_BURST_MS, each
// followed by an idle of at least its own length (MANTLE_GPU_DUTY, default 0.5) outside the clock; wall/frame is the
// bursts' summed time over the frame count, the GPU timer one query per burst, summed. The fence is polled with a
// MessageChannel yield (window.__gpuFence), not setTimeout(1): after an idle every timer is nested and clamps to 4 ms,
// paid once per burst. The run is capped at MANTLE_GPU_WALL_MS. Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIZES = (process.env.SIZES || '256,512,1024').split(',').map(Number);
const FRAMES = +(process.env.FRAMES || 60);
const REPS = +(process.env.REPS || 5);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="2048" height="2048"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {});
if (R.ready) await R.ready;

// A LAYERED FIXTURE with every feature the claim's art carries at once, so each can be removed
// independently. The discs overlap on purpose: overdraw is what the original explanation blamed,
// and it is held FIXED across arms (a clip/mask/opacity change moves no cover quad).
const discs = (n) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, cx = 80 + 34 * Math.cos(a), cy = 80 + 34 * Math.sin(a);
    s += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="42" fill="FILL"/>';
  }
  return s;
};
const build = (arm) => {
  const useClip = arm !== 'A1' && arm !== 'A5';
  const useMask = arm !== 'A2' && arm !== 'A5';
  const useOpa  = arm !== 'A3' && arm !== 'A5';
  const useGrad = arm !== 'A4' && arm !== 'A5';
  const fill = useGrad ? 'url(#g)' : '#3a6ea5';
  const defs = '<linearGradient id="g"><stop offset="0" stop-color="#3a6ea5"/><stop offset="1" stop-color="#c04030"/></linearGradient>'
    + '<clipPath id="c"><rect x="14" y="14" width="132" height="132"/></clipPath>'
    + '<mask id="m"><rect x="0" y="0" width="160" height="160" fill="#fff"/><circle cx="80" cy="80" r="26" fill="#000"/></mask>';
  const attr = (useClip ? ' clip-path="url(#c)"' : '') + (useMask ? ' mask="url(#m)"' : '')
    + (useOpa ? ' opacity="0.75"' : '');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><defs>' + defs + '</defs>'
    + '<g' + attr + '>' + discs(14).replaceAll('FILL', fill) + '</g></svg>';
};

window.__arm = async (armId, size, kernel, frames) => {
  R.setFillEngine({ route: 'auto', kernel });
  const sec = await importSvg(build(armId), { preserveViewport: true });
  const b = createBundle(gl, sec);
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b); } catch {} }
  R.setViewport(size, size); gl.viewport(0, 0, size, size);
  for (let i = 0; i < 8; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  if (R.precompileFills) { try { R.precompileFills(); } catch {} }
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
  const variant = (R.debugStats && R.debugStats.drawnFillVariantKey) || '';
  b.dispose();
  return { wall: wall / frames, ink, drew, variant };
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
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
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
const cap = capWallTime('_aacFeatureCostAB', async () => {
  await br.close();
  server.close();
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 100 });
await installGpuThrottle(pg);
console.log(gpuThrottleBanner());

const run = (arm, size, kernel) =>
  pg.evaluate((a, s, k, f) => window.__arm(a, s, k, f), arm, size, kernel, FRAMES);
const best = (xs) => xs.reduce((a, b) => (b.wall < a.wall ? b : a));
const ARMS = [
  ['A0', 'as authored'],
  ['A1', '-clip'],
  ['A2', '-mask'],
  ['A3', '-group opacity'],
  ['A4', 'gradients->solid'],
  ['A5', 'all off'],
];
await run('A0', SIZES[0], 'slug'); // discard arm

for (const size of SIZES) {
  console.log(
    `\nAAC2 @${size} — aac/slug within each arm, ${FRAMES} frames x ${REPS} reps, fence-synced`,
  );
  console.log('  arm  feature             slug      aac   aac/slug  |  A/A     ink   kernels');
  let base = null,
    baseK = null;
  for (const [id, label] of ARMS) {
    const S = [],
      A = [],
      S2 = [];
    for (let i = 0; i < REPS; i++) {
      S.push(await run(id, size, 'slug'));
      A.push(await run(id, size, 'aac'));
      A.push(await run(id, size, 'aac'));
      S2.push(await run(id, size, 'slug'));
    }
    const s = best(S),
      a = best(A),
      s2 = best(S2);
    if (!s.ink || !a.ink) {
      console.log(`  ${id}   ${label.padEnd(18)} BLANK FRAME (ink ${s.ink}/${a.ink}) — not timed`);
      continue;
    }
    const floor = Math.abs(s2.wall - s.wall) / Math.min(s.wall, s2.wall);
    const r = a.wall / Math.min(s.wall, s2.wall);
    if (id === 'A0') {
      base = r;
      baseK = Object.keys(a.drew).sort().join(',');
    }
    // AN ARM THAT BOUND A DIFFERENT KERNEL SET IS NOT this ARM. With every feature off the discs
    // are recognized CIRCLES and take the SDF primitive route, so the "aac" arm never binds AAC
    // and its ratio is an SDF-vs-Slug number wearing an AAC label.
    const armK = Object.keys(a.drew).sort().join(',');
    const bad = baseK && armK !== baseK;
    const moved = base ? ` (A0 ${base.toFixed(2)} -> ${r.toFixed(2)})` : '';
    console.log(
      `  ${id}   ${label.padEnd(18)}${s.wall.toFixed(3).padStart(7)}${a.wall.toFixed(3).padStart(9)}` +
        `${r.toFixed(3).padStart(10)}  | ${(100 * floor).toFixed(1).padStart(5)}% ${String(s.ink).padStart(7)}` +
        `  ${armK || '-'}${id === 'A0' ? '' : moved}`,
    );
    if (bad)
      console.log(
        `       !! KERNEL SET DIFFERS from A0 (${baseK} -> ${armK}) — this arm changed the ENGINE, not just the feature; its ratio is not comparable`,
      );
  }
}
const duty = await pg.evaluate(() => window.__gpuDuty());
console.log(
  `gpu duty over the timed bursts: ${(duty.busy / (duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await br.close();
server.close();
process.exit(0);
