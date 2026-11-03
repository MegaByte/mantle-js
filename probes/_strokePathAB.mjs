// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokePathAB.mjs — SUPERSEDED. Use `_engineTune`'s lbSegs arm instead:
//   ENGINES=lb,lbSegs CLASSES=fill+stroke,stroke-only node probes/_engineTune.mjs 40 0.4,1 768
//
// Two reasons this one cannot answer its question:
//
// 1. Its `split stroke` arm forces `unifiedFill: false` expecting a MAX-blended
//    stroke coverage RT. The renderer has no such RT, so the arm selects the
//    non-unified route generally, not a stroke path, and the comparison is not
//    about strokes at all.
// 2. It measures SYNTHETIC stars and never checks that the treatment ENGAGED. On
//    real assets the option is inert, which a probe with no engagement counter
//    reports as a confident 1.00x.
//
// Its numbers swing 0.52-2.03x on identical code. The GPU-timing shape below is
// worth copying — EXT_disjoint_timer_query rather than wall clock (which times CPU
// submit), and arms alternated per case so neither sits permanently
// in a cold-clock slot (the mistake that made a depth-claim A/B read 3x on
// byte-identical work). What it lacks is pacing, amplification and real assets.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = (process.env.SIZES || '256,512,1024').split(',').map(Number);
const SEGS = (process.env.SEGS || '4,16,64').split(',').map(Number);
const REPS = +(process.env.REPS || 9);

function star(segs, r1 = 15, r2 = 8) {
  let d = '';
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs,
      r = i & 1 ? r1 : r2;
    d +=
      (i ? 'L' : 'M') +
      (20 + r * Math.cos(a)).toFixed(3) +
      ' ' +
      (20 + r * Math.sin(a)).toFixed(3) +
      ' ';
  }
  return d + 'Z';
}
const CASES = {};
for (const s of SEGS)
  CASES['stroked_s' + s] =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="#3060c0" stroke="#102040" stroke-width="2.5" d="${star(s)}"/></svg>`;
for (const s of SEGS)
  CASES['strokeOnly_s' + s] =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path fill="none" stroke="#3060c0" stroke-width="2.5" d="${star(s)}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const CASES = ${JSON.stringify(CASES)}, SIZES = ${JSON.stringify(SIZES)}, REPS = ${REPS};
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function mk(N, unified) {
  const c = document.createElement('canvas'); c.width = N; c.height = N;
  document.getElementById('root').appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: true });
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const r = createRenderer(gl, shaders, { aacFill: false, unifiedFill: unified });
  await r.ready; r.setViewport(N, N); r.setLoopBlinnFill('on');
  return { gl, timer, r, N };
}
async function timed(s, b, D) {
  const { gl, timer, r, N } = s;
  const frame = () => { r.beginFrame([0,0,0,1]); for (let i=0;i<D;i++) r.drawBundle(b, {}); r.endFrame(); };
  frame(); gl.finish();
  const g = [];
  for (let k = 0; k < REPS; k++) {
    let q = null;
    if (timer) { q = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, q); }
    frame();
    if (timer) gl.endQuery(timer.TIME_ELAPSED_EXT);
    gl.finish();
    if (q) { for (let p=0;p<2000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);p++) await sleep(0);
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) g.push(gl.getQueryParameter(q, gl.QUERY_RESULT)/1e6);
      gl.deleteQuery(q); }
  }
  g.sort((a,b)=>a-b); return g.length ? g[(g.length/2)|0] : null;
}
async function prep(s, svg) {
  const b = createBundle(s.gl, await importSvg(svg));
  try { s.r.prepareBundle(b); } catch {}
  if (s.r.awaitLbReady) { try { await s.r.awaitLbReady(b, 20000); } catch {} }
  const f = () => { s.r.beginFrame([0,0,0,1]); s.r.drawBundle(b, {}); s.r.endFrame(); };
  f(); if (s.r.precompileFills) s.r.precompileFills();
  f(); if (s.r.precompileFills) s.r.precompileFills();
  for (let i=0;i<8;i++){ f(); if ((s.r.debugStats.unifiedFillDraws|0)>0) break; await new Promise(res=>requestAnimationFrame(res)); }
  return b;
}
const out = [];
let flip = 0;
for (const N of SIZES) for (const [name, svg] of Object.entries(CASES)) {
  const band = await mk(N, true), split = await mk(N, false);
  const bb = await prep(band, svg), sb = await prep(split, svg);
  const st = { uni: band.r.debugStats.unifiedFillDraws|0, rt: (split.r.debugStats.composedStrokeFromRT|0) };
  // Alternate which config is timed first, so neither owns the cold slot.
  let mb, ms;
  if ((flip++ & 1) === 0) { mb = await timed(band, bb, 8); ms = await timed(split, sb, 8); }
  else { ms = await timed(split, sb, 8); mb = await timed(band, bb, 8); }
  out.push({ N, name, band: mb, split: ms, uni: st.uni, rt: st.rt });
  try { bb.dispose(); sb.dispose(); } catch {}
  band.gl.canvas.remove(); split.gl.canvas.remove();
}
window.out = out;
</script></body></html>`;
const server = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    s.writeHead(200, {
      'content-type': /\.(js|mjs)$/.test(u.pathname)
        ? 'text/javascript'
        : u.pathname.endsWith('.glsl')
          ? 'text/plain'
          : 'text/html',
    });
    s.end(b);
  } catch {
    try {
      s.writeHead(404);
    } catch {}
    s.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
const logs = [];
pg.on('pageerror', (e) => logs.push(String(e.message)));
pg.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 580000 });
} catch {
  console.log('never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await br.close();
  server.close();
  process.exit(1);
}
const r = await pg.evaluate(() => window.out);
await br.close();
server.close();
console.log('  N   case              bandWalk   splitRT   ratio   uniDraws  strokeRT');
for (const x of r) {
  const ratio = x.band && x.split ? x.split / x.band : null;
  console.log(
    String(x.N).padStart(5),
    x.name.padEnd(18),
    (x.band == null ? '   n/a' : x.band.toFixed(3)).padStart(8),
    (x.split == null ? '   n/a' : x.split.toFixed(3)).padStart(9),
    (ratio == null ? '  n/a' : ratio.toFixed(2) + 'x').padStart(8),
    String(x.uni).padStart(9),
    String(x.rt).padStart(9),
  );
}
const rs = r
  .map((x) => (x.band && x.split ? x.split / x.band : null))
  .filter(Boolean)
  .sort((a, b) => a - b);
if (rs.length)
  console.log(
    `\nmedian splitRT / bandWalk = ${rs[(rs.length / 2) | 0].toFixed(2)}x  (>1 = band walk faster)`,
  );
