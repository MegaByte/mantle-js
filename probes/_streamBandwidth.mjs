// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _streamBandwidth.mjs — IS the unified fill draw vertex-fetch bound?
//
// 28.8% of the unified vertex stream is per-curve data repeated across a
// triangle's three vertices (probes/_dataPlacementAudit.mjs). The candidate
// fix is a per-curve texture plus one index attribute: a real change to the builder,
// the VAO and the vertex shader, against a codebase precedent of a vertex texture
// fetch LOSING to a plain attribute.
//
// So measure the SENSITIVITY before building anything. `unifiedFillPadFloats: N`
// widens the stride by N unused floats after every attribute, producing a
// proportionally bigger buffer and PIXEL-IDENTICAL output. If +55% of stream costs
// nothing, then -29% saves nothing and the optimization is dead unwritten. If it
// costs in proportion, the per-curve texture is worth writing.
//
// Pixel-identity is asserted, not assumed: if a pad changed the image the pad is
// broken and its timing would be meaningless.
//
// GPU timer queries, not wall clock (wall clock times CPU submit — the trap that
// invalidated an earlier engine bench). Pad states are visited in an alternating
// order so no state permanently owns a cold-clock slot, and the page breathes
// between cells so the compositor is not starved (unpaced loops on this branch took
// down the window server twice).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = (process.env.ASSETS || 'examples/tiger.svg').split(',');
const PADS = (process.env.PADS || '0,16,48').split(',').map(Number);
const SIZE = Number(process.env.SIZE || 768);
const DRAWS = Number(process.env.DRAWS || 24);
const REPS = Number(process.env.REPS || 9);

const svgs = {};
for (const a of ASSETS) svgs[a] = readFileSync(path.join(ROOT, a), 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="c"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const SVGS = ${JSON.stringify(svgs)}, PADS = ${JSON.stringify(PADS)};
const S = ${SIZE}, DRAWS = ${DRAWS}, REPS = ${REPS}, PASSES = ${Number(process.env.PASSES || 4)};
const cv = document.getElementById('c'); cv.width = S; cv.height = S;
const gl = cv.getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: true });
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const breathe = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mk(svg, pad, curveTex) {
  const r = createRenderer(gl, shaders,
    { aacFill: false, unifiedFillPadFloats: pad, unifiedFillCurveTex: !!curveTex });
  await r.ready; r.setViewport(S, S); r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(svg));
  try { r.prepareBundle(b); } catch (e) {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch (e) {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch (e) {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch (e) {} }
  const frame = () => { r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let i = 0; i < 60; i++) { frame(); if ((r.debugStats.unifiedFillDraws | 0) > 0) break; await breathe(); }
  // vertBytes, not verts.byteLength: the CPU copy is released after upload.
  const bytes = (b._unifiedFill && b._unifiedFill.vertBytes) | 0;
  const verts = (b._unifiedFill && b._unifiedFill.vertexCount) | 0;
  const px = new Uint8Array(S * S * 4);
  frame(); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { r, b, bytes, verts, px, uni: r.debugStats.unifiedFillDraws | 0 };
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
    if (q) {
      for (let p = 0; p < 2000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); p++) await sleep(0);
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) g.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    if ((k & 1) === 1) await breathe();
  }
  g.sort((a, b) => a - b);
  return g.length ? g[(g.length / 2) | 0] : null;
}

// Stride has a hard cap, and exceeding it makes vertexAttribPointer fail, the draw
// paint NOTHING, and the "timing" read 0.025ms of nothing — which is exactly what
// pad 48 did before this clamp. So clamp, and report where the cap came from:
// queried vs FALLBACK must not be conflated. (No backticks in this browser-side
// source: it lives inside a template literal, and one here silently ends it.)
// GLES3 requires
// MAX_VERTEX_ATTRIB_STRIDE >= 2048, so if this prints 255 (our WebGL-1-era fallback)
// the query failed and the real reason pad 48 broke is NOT established.
const RAW_STRIDE = gl.getParameter(gl.MAX_VERTEX_ATTRIB_STRIDE);
const MAX_STRIDE = RAW_STRIDE || 255;
const STRIDE_SRC = RAW_STRIDE ? 'queried' : 'FALLBACK (query returned ' + RAW_STRIDE + ')';
const STATIC_BASE = 29 * 4;
const legal = PADS.filter((p) => STATIC_BASE + p * 4 <= MAX_STRIDE);
const dropped = PADS.filter((p) => !legal.includes(p));

// ONE STATE LIVE AT A TIME. Building every pad up front left five renderers and
// five tiger bundles resident during timing, so states competed for GPU memory and
// whichever was built first was penalised — the first attempt read pad 0 at 142ms
// against ~100ms for every other pad, i.e. "more bytes is faster", which is not a
// thing. Create, measure, dispose, repeat.
//
// The 'ctl' state is pad 0 built a SECOND time. It is the control: it shares every
// property with pad 0 except identity, so whatever it reports is pure
// instance-to-instance noise in both pixels and time. Without it, neither a 1-LSB
// pixel difference nor a 5% timing difference can be attributed to the pad.
// PADS drives the bandwidth-elasticity question; 'ctex' is the per-curve-coefficient
// TEXTURE arm (a 46.7% smaller footprint whose only open question is whether the
// vertex texture fetch costs more than the bytes it saves), and 'ctl' is pad 0 rebuilt
// — the noise floor both are judged against.
const PLAN = [...legal.map((p) => ({ pad: p, tag: String(p) })),
              { pad: 0, curveTex: true, tag: 'ctex' },
              { pad: 0, tag: 'ctl' }];
// WARM-UP INSTANCE, DISCARDED. The FIRST renderer in a pristine GL context renders
// slightly differently from every later one — measured on _dash_cubic as 7px (w85,
// 5 rim / 2 interior), with runs 2..N all agreeing with each other and only run 1
// odd, and a throwaway renderer beforehand making them all agree
// (probes/_renderDeterminism.mjs). So the renderer inherits some state a previous
// renderer leaves set. Without this, pad 0 is measured as that odd first instance and
// its pixel diff against the others gets blamed on the treatment.
await mk(Object.values(SVGS)[0], 0, false);
await breathe();

const out = [];
for (const [name, svg] of Object.entries(SVGS)) {
  const acc = new Map(PLAN.map((p) => [p.tag, { ...p, ms: [], bytes: 0, verts: 0, uni: 0, diff: null }]));
  let refPx = null;
  for (let pass = 0; pass < PASSES; pass++) {
    const order = (pass & 1) ? [...PLAN].reverse() : PLAN;
    for (const p of order) {
      const s = await mk(svg, p.pad, p.curveTex);
      const a = acc.get(p.tag);
      a.bytes = s.bytes; a.verts = s.verts; a.uni = s.uni;
      if (p.tag === '0' && !refPx) refPx = s.px;
      else if (refPx) {
        // COUNT as well as max: a max of 85 could be one tie-break pixel or a
        // thousand, and those have opposite implications.
        let d = 0, n = 0;
        for (let i = 0; i < refPx.length; i += 4) {
          let p = 0;
          for (let k = 0; k < 3; k++) p = Math.max(p, Math.abs(refPx[i+k] - s.px[i+k]));
          if (p) { n++; if (p > d) d = p; }
        }
        a.diff = a.diff == null ? d : Math.max(a.diff, d);
        a.diffN = a.diffN == null ? n : Math.max(a.diffN, n);
      }
      const ms = await timed(s);
      if (ms != null) a.ms.push(ms);
      try { s.b.dispose(); } catch (e) {}
      await breathe();
    }
  }
  out.push({ name, rows: [...acc.values()].map((a) => ({ ...a, ms: a.ms.sort((x, y) => x - y) })) });
}
window.meta = { maxStride: MAX_STRIDE, strideSrc: STRIDE_SRC, dropped };
window.out = out;
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
  await pg.waitForFunction('typeof window.out !== "undefined"', { timeout: 580000 });
} catch {
  console.log('never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await br.close();
  server.close();
  process.exit(1);
}
const r = await pg.evaluate(() => window.out);
const meta = await pg.evaluate(() => window.meta);
await br.close();
server.close();

console.log(`  ${DRAWS} draws/frame @ ${SIZE}px, GPU timer, ${REPS} reps x 2 passes`);
console.log(
  `  MAX_VERTEX_ATTRIB_STRIDE ${meta.maxStride}B (${meta.strideSrc}); static base 116B` +
    (meta.dropped.length ? `; pads dropped as illegal: ${meta.dropped.join(',')}` : '') +
    '\n',
);
for (const a of r) {
  console.log(`  ${a.name}`);
  console.log(
    '    pad   stream bytes   vs pad0   uniDraws  maxPxDiff     min ms  median ms   vs pad0',
  );
  const base = a.rows.find((x) => x.tag === '0');
  const med = (row) => (row.ms.length ? row.ms[Math.floor((row.ms.length - 1) / 2)] : null);
  const bmed = base ? med(base) : null;
  for (const row of a.rows) {
    const m = med(row);
    console.log(
      `    ${row.tag.padStart(3)}  ${String(row.bytes).padStart(12)}` +
        `  ${base ? (row.bytes / base.bytes).toFixed(2) + 'x' : '   -'}`.padStart(10) +
        `  ${String(row.uni).padStart(8)}  ${String(row.diff == null ? '-' : row.diff + '/' + (row.diffN | 0)).padStart(9)}` +
        `  ${(row.ms.length ? row.ms[0].toFixed(3) : 'n/a').padStart(9)}` +
        `  ${(m == null ? 'n/a' : m.toFixed(3)).padStart(9)}` +
        `  ${(m != null && bmed ? (m / bmed).toFixed(3) + 'x' : '   -').padStart(8)}`,
    );
  }
  const ctl = a.rows.find((x) => x.tag === 'ctl'),
    cm = ctl ? med(ctl) : null;
  const noise = cm != null && bmed ? Math.abs(cm / bmed - 1) : null;
  if (noise != null)
    console.log(
      `\n    CONTROL (pad 0 rebuilt): ${(100 * noise).toFixed(1)}% timing spread, ` +
        `${ctl.diff} max px diff — this is the FLOOR. Nothing smaller than it is a result.`,
    );
  if (ctl && ctl.diff > 0)
    console.log('    A nonzero control diff means renderer instances are not bit-identical to');
  console.log('    each other, so a same-sized pixel difference on a padded state is not the pad.');
  if (a.rows.some((x) => !x.uni))
    console.log('    ** some states never took the unified route — those rows say nothing');
}
console.log('\n  Read it as an elasticity, against the control floor: if stream x2 costs ~x1.00');
console.log('  time, the draw is not fetch bound and removing 29% of the stream cannot pay.');
console.log('  If it tracks the byte ratio, the per-curve texture is worth building.');
