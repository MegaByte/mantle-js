// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _occupancyCost.mjs — is OCCUPANCY a proven cost driver, or just a correlate?
//
// The claim: Slug and AAC walk bands per fragment, so a fragment costs the number of
// segments in its band row, and the shape costs px^2 x (segments per fragment). To
// first order that per-fragment count is
//     occupancy = sum over segments of (segment y-extent / shape height)
// which predicts that segment COUNT alone cannot explain cost: 100 segments each
// spanning 1% of the height should cost the same per fragment as ONE spanning all of
// it.
//
// Correlating occupancy against time over real assets would NOT prove that, because
// on real content occupancy moves together with segment count, area and everything
// else. So this is a CONTROLLED experiment instead: shapes matched on bounding box
// (hence covered area) and on segment count, differing only in occupancy.
//
//   comb   a zigzag whose every segment spans the FULL height  -> occupancy ~ N
//   fan    a convex outline whose segments each span ~1/N of it -> occupancy ~ 1
//
// Same N, same bbox, same area. If Slug/AAC time tracks occupancy here, occupancy is
// a proven cost driver. If it tracks N instead, the model is wrong and the metric
// must be thrown out rather than used.
//
// SYNTHETIC ON PURPOSE, and that is the right call here: synthetics mislead about
// POLICY (which engine to pick on real content — measured, they disagree with real
// assets sharply) but they are the only way to ISOLATE A MECHANISM, because real
// assets never hold three variables still. Policy comes from _engineTune; mechanism
// comes from here.
//
// LB is measured too, as a falsifiable counter-prediction: LB meshes instead of
// walking and its fragment multiplicity is exactly 1 (probes/_lbFragCount), so LB
// time should be nearly FLAT in occupancy. If LB also tracks occupancy, then
// something other than the walk is driving all of it and the model is wrong again.
//
// ── RESULT: THE EXPERIMENT IS INVALID AND THE METRIC IS NOT PROVEN ──
//
//   case        segs  minOcc     ink    slug     aac      lb
//   comb_n16      34    2.00  306432    9.24    8.52   14.55
//   fan_n16       17    2.00  452432    2.23    4.14    5.83
//   comb_n96     194    2.00  362080   47.62   52.89  133.70
//   fan_n96       97    2.00  463952    2.69    4.03    4.63
//
// Three defects, all in the design above, and each one alone is disqualifying:
//
// 1. minOcc reads 2.00 for both shapes, so occRatio is 1.0x and the experiment never
//    varied its independent variable. The metric SATURATES: the comb's hOcc is ~N but
//    its vOcc is ~2 (each tooth spans 1/N of the width, plus the closing edge), and
//    min() throws the large axis away. Taking the min assumed the walker always gets
//    the cheaper axis, which is an assumption about the shader, not a measurement of
//    it. As a discriminator minOcc is worse than useless here — it reports IDENTICAL
//    cost for shapes that differ 17x.
// 2. Segment counts are not matched: the comb emits 2 segments per tooth (34 vs 17).
// 3. Areas are not matched either: inkRatio 0.68-0.78, because the comb's teeth leave
//    gaps while the fan is solid.
//
// So what the numbers actually show is cost tracking SEGMENT COUNT, with no evidence
// for occupancy. LB degrades WORST (2.50x -> 28.90x), which also refutes the "LB is
// flat in occupancy because it meshes" prediction — LB pays per curve triangle.
//
// TO MAKE this A REAL EXPERIMENT: report hOcc and vOcc SEPARATELY (never min), and
// build shapes matched on segment count AND covered area — e.g. vary only the
// y-extent of a fixed number of segments inside a fixed silhouette, rather than
// swapping one silhouette for another. Until then hOcc/vOcc/minOcc/walkWork are
// HYPOTHESES, and the gate must not be built on them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NS = (process.env.NS || '16,48,96').split(',').map(Number);
const SIZE = Number(process.env.SIZE || 768);
const DRAWS = Number(process.env.DRAWS || 16);
const REPS = Number(process.env.REPS || 9);
const PASSES = Number(process.env.PASSES || 3);

// COMB: N teeth, every edge spanning the full 0..100 height. occupancy ~ N.
// Closed along the bottom so it fills. Kept inside the same 0..100 box as the fan.
function comb(n) {
  const w = 100 / n;
  let d = 'M0 100';
  for (let i = 0; i < n; i++) {
    const x0 = i * w,
      xm = x0 + w * 0.5,
      x1 = x0 + w;
    d += ` L${xm.toFixed(3)} 0 L${x1.toFixed(3)} 100`;
  }
  return d + ' Z';
}
// FAN: a convex polygon on the same box; each edge spans a small slice of the
// height, so occupancy stays ~1-2 however large N gets.
function fan(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([50 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)]);
  }
  return 'M' + pts.map((p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join(' L') + ' Z';
}

const CASES = {};
for (const n of NS) {
  CASES[`comb_n${n}`] = comb(n);
  CASES[`fan_n${n}`] = fan(n);
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { curveRangeToContours } from '/src/geom/lbContour.js';
const CASES = ${JSON.stringify(CASES)};
const S = ${SIZE}, DRAWS = ${DRAWS}, REPS = ${REPS}, PASSES = ${PASSES};
const cv = document.getElementById('c'); cv.width = S; cv.height = S;
const gl = cv.getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: true });
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const breathe = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svgOf = (d) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + '<path fill="#3060c0" d="' + d + '"/></svg>';

// The SAME occupancy definition the gate would use, computed here so the experiment
// reports predicted-vs-measured rather than assuming the shapes came out as intended.
function occOf(bundle) {
  const cf = bundle.curveFloats, ranges = bundle.curveRangesByShape;
  if (!cf || !ranges) return null;
  let areaSum = 0, hAcc = 0, vAcc = 0, segAcc = 0;
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s]; if (!r) continue;
    let cs = null; try { cs = curveRangeToContours(cf, r.begin, r.end); } catch (e) { continue; }
    if (!cs) continue;
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity, n = 0; const ex = [];
    for (const c of cs) for (const sg of c) {
      const ps = [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean);
      let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
      for (const p of ps) { if (p[0] < sx0) sx0 = p[0]; if (p[0] > sx1) sx1 = p[0];
                            if (p[1] < sy0) sy0 = p[1]; if (p[1] > sy1) sy1 = p[1]; }
      if (!isFinite(sx0)) continue;
      ex.push([sx1 - sx0, sy1 - sy0]); n++;
      if (sx0 < X0) X0 = sx0; if (sx1 > X1) X1 = sx1;
      if (sy0 < Y0) Y0 = sy0; if (sy1 > Y1) Y1 = sy1;
    }
    if (!n) continue;
    const W = Math.max(X1 - X0, 1e-9), H = Math.max(Y1 - Y0, 1e-9);
    let h = 0, v = 0;
    for (const [dx, dy] of ex) { h += Math.min(dy / H, 1); v += Math.min(dx / W, 1); }
    const area = W * H;
    areaSum += area; hAcc += area * h; vAcc += area * v; segAcc += area * n;
  }
  if (areaSum <= 0) return null;
  return { hOcc: hAcc / areaSum, vOcc: vAcc / areaSum,
           minOcc: Math.min(hAcc / areaSum, vAcc / areaSum), segs: segAcc / areaSum };
}

async function mk(d, eng) {
  const opts = eng === 'aac' ? { aacFill: true } : { aacFill: false };
  const r = createRenderer(gl, shaders, opts);
  await r.ready; r.setViewport(S, S);
  r.setLoopBlinnFill(eng === 'lb' ? 'on' : 'off');
  const b = createBundle(gl, await importSvg(svgOf(d)));
  try { r.prepareBundle(b); } catch (e) {}
  if (eng === 'lb' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch (e) {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch (e) {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch (e) {} }
  const frame = () => { r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let i = 0; i < 40; i++) {
    frame();
    if (eng !== 'lb' || (r.debugStats.unifiedFillDraws | 0) > 0) break;
    await breathe();
  }
  // Covered area, so "same bbox" is verified rather than assumed.
  const px = new Uint8Array(S * S * 4);
  frame(); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0;
  for (let i = 0; i < S * S; i++) { const o = i * 4;
    if (px[o] > 8 || px[o+1] > 8 || px[o+2] > 8) ink++; }
  return { r, b, ink, occ: occOf(b), uni: r.debugStats.unifiedFillDraws | 0 };
}
async function timed(s) {
  const frame = () => { s.r.beginFrame([0,0,0,1]);
    for (let k = 0; k < DRAWS; k++) s.r.drawBundle(s.b, {}); s.r.endFrame(); };
  frame(); gl.finish(); await breathe();
  const g = [];
  for (let k = 0; k < REPS; k++) {
    let q = null;
    if (timer) { q = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, q); }
    frame();
    if (timer) gl.endQuery(timer.TIME_ELAPSED_EXT);
    gl.finish();
    if (q) { for (let p = 0; p < 2000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); p++) await sleep(0);
             if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) g.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
             gl.deleteQuery(q); }
    if ((k & 1) === 1) await breathe();
  }
  g.sort((a, b) => a - b);
  return g.length ? g[Math.floor((g.length - 1) / 2)] : null;
}

const ENGINES = ['slug', 'aac', 'lb'];
const acc = {};
for (const name of Object.keys(CASES)) for (const e of ENGINES) acc[name + '|' + e] = { ms: [] };
for (let pass = 0; pass < PASSES; pass++) {
  const names = Object.keys(CASES);
  const order = (pass & 1) ? [...names].reverse() : names;
  for (const name of order) for (const e of ENGINES) {
    const s = await mk(CASES[name], e);
    const a = acc[name + '|' + e];
    a.ink = s.ink; a.occ = s.occ; a.uni = s.uni;
    const ms = await timed(s);
    if (ms != null) a.ms.push(ms);
    try { s.b.dispose(); } catch (err) {}
    await breathe();
  }
}
window.out = acc;
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    s.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
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
  protocolTimeout: 900000,
});
const pg = await br.newPage();
const logs = [];
pg.on('pageerror', (e) => logs.push(String(e.message)));
pg.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
try {
  await pg.waitForFunction('typeof window.out !== "undefined"', { timeout: 880000 });
} catch {
  console.log('never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await br.close();
  server.close();
  process.exit(1);
}
const r = await pg.evaluate(() => window.out);
await br.close();
server.close();

// Node-side copy: the browser-side ENGINES lives inside the page template and is not
// in scope out here (it crashed the report after a full 15-minute measurement run).
const ENGINES = ['slug', 'aac', 'lb'];
const med = (v) =>
  v.length ? v.slice().sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)] : null;
console.log(`  ${DRAWS} draws/frame @ ${SIZE}px, GPU timer, ${REPS} reps x ${PASSES} passes\n`);
console.log('  case          segs   minOcc    ink        slug ms     aac ms      lb ms');
const rows = {};
for (const [k, v] of Object.entries(r)) {
  const [name, eng] = k.split('|');
  (rows[name] ||= { name })[eng] = { ms: med(v.ms), ink: v.ink, occ: v.occ, uni: v.uni };
}
for (const name of Object.keys(rows)) {
  const x = rows[name],
    o = (x.slug && x.slug.occ) || (x.lb && x.lb.occ) || {};
  console.log(
    `  ${name.padEnd(12)} ${String(Math.round(o.segs || 0)).padStart(5)}` +
      ` ${(o.minOcc == null ? 0 : o.minOcc).toFixed(2).padStart(8)}` +
      ` ${String((x.slug && x.slug.ink) || 0).padStart(7)}` +
      ENGINES.map(
        (e) => `  ${(x[e] && x[e].ms != null ? x[e].ms.toFixed(2) : 'n/a').padStart(9)}`,
      ).join(''),
  );
}
// The experiment's whole point: at MATCHED N and area, does time follow occupancy?
console.log('\n  MATCHED-N COMPARISON (comb vs fan at the same segment count):');
console.log('  case      inkRatio  occRatio   slug x    aac x     lb x');
for (const n of NS) {
  const c = rows[`comb_n${n}`],
    f = rows[`fan_n${n}`];
  if (!c || !f) continue;
  const co = (c.slug && c.slug.occ) || {},
    fo = (f.slug && f.slug.occ) || {};
  const rat = (e) =>
    c[e] && f[e] && c[e].ms && f[e].ms ? (c[e].ms / f[e].ms).toFixed(2) + 'x' : 'n/a';
  const inkR = c.slug && f.slug && f.slug.ink ? (c.slug.ink / f.slug.ink).toFixed(2) : 'n/a';
  console.log(
    `  n=${String(n).padEnd(7)} ${String(inkR).padStart(8)}` +
      ` ${(fo.minOcc ? co.minOcc / fo.minOcc : 0).toFixed(1).padStart(8)}x` +
      `  ${rat('slug').padStart(7)}  ${rat('aac').padStart(7)}  ${rat('lb').padStart(7)}`,
  );
}
console.log('\n  PROVEN if: inkRatio ~1 (area really is matched, so area is not the cause),');
console.log('  segment counts equal, and slug/aac ratios rise with occRatio. LB should stay');
console.log('  near 1.00x — it meshes instead of walking, and its multiplicity is exactly 1.');
console.log('  DISPROVEN if slug/aac stay ~1.00x despite a large occRatio: then the walk is');
console.log('  not occupancy-bound and the metric must be dropped, not used.');
