#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// probes/_corpusLbSvgAudit.mjs — LB vs Slug pixel audit on an external SVG corpus.
// Flags hard ink disagreements (LB-only / Slug-only) on shapes that actually
// routed through Loop-Blinn. Soft (mean) diffs are reported but not fatal.
import { readFileSync, readdirSync, statSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MANTLE_ROOT ? path.resolve(process.env.MANTLE_ROOT) : HERE_ROOT;
const CORPUS_ROOT = process.env.CORPUS_ROOT && path.resolve(process.env.CORPUS_ROOT);
if (!CORPUS_ROOT) throw new Error('CORPUS_ROOT must name an external SVG corpus');
const N = +(process.env.N || 256);
const MAX_BYTES = +(process.env.MAX_BYTES || 180_000);
const LIMIT = +(process.env.LIMIT || 48);
const HARD_FAIL = +(process.env.HARD_FAIL || 12); // solid-xor px (ink vs empty)
const MEAN_INK_FAIL = +(process.env.MEAN_INK_FAIL || 0.02); // mean |Δ|/255 on inked px
const XOR_PCT_FAIL = +(process.env.XOR_PCT_FAIL || 0.5); // solid-xor as % of max(ink)

function walkSvg(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|trains-3d|\.git/.test(e.name)) continue;
      walkSvg(p, out);
    } else if (e.isFile() && /\.svg$/i.test(e.name)) {
      try {
        const st = statSync(p);
        if (st.size > 400 && st.size <= MAX_BYTES) out.push(p);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// Diverse sample: up to K per game, prefer smaller/mid files, skip near-duplicates by basename.
function pickAssorted(all, limit) {
  const byGame = new Map();
  for (const p of all) {
    const rel = path.relative(CORPUS_ROOT, p);
    const game = rel.split(path.sep)[0] || 'other';
    if (!byGame.has(game)) byGame.set(game, []);
    byGame.get(game).push(p);
  }
  const per = Math.max(2, Math.ceil(limit / Math.max(1, byGame.size)));
  const picked = [];
  const seenBase = new Set();
  for (const [, files] of [...byGame.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    files.sort((a, b) => statSync(a).size - statSync(b).size);
    let n = 0;
    for (const f of files) {
      const base = path.basename(f).toLowerCase().replace(/\d+/g, '#');
      if (seenBase.has(base)) continue;
      seenBase.add(base);
      picked.push(f);
      if (++n >= per || picked.length >= limit) break;
    }
    if (picked.length >= limit) break;
  }
  return picked.slice(0, limit);
}

const all = walkSvg(CORPUS_ROOT);
const FILES = pickAssorted(all, LIMIT);
if (!FILES.length) {
  console.error('no SVGs found under', CORPUS_ROOT);
  process.exit(2);
}
console.log(`corpus LB audit: ${FILES.length} SVGs (of ${all.length} ≤${MAX_BYTES}B) @ ${N}px`);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
if (${process.env.DISABLE_WORKERS === '1'}) globalThis.Worker = undefined;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const N = ${N};
const gl = document.getElementById('c').getContext('webgl2', {
  antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true,
});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const grab = () => {
  const p = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p);
  return p;
};
const inkish = (p, i) => {
  // Not near-white background — works for colored fills on white clear.
  return !(p[i] > 245 && p[i + 1] > 245 && p[i + 2] > 245);
};
const solid = (p, i) => (p[i] + p[i + 1] + p[i + 2]) / 3 < 40;
const empty = (p, i) => (p[i] + p[i + 1] + p[i + 2]) / 3 > 250;
async function paint(svgTxt, lbMode) {
  const r = createRenderer(gl, shaders, {});
  r.setLoopBlinnFill(lbMode);
  let sec;
  try { sec = await importSvg(svgTxt, { preserveViewport: true }); }
  catch (e) { return { err: String(e && e.message || e) }; }
  const bun = createBundle(gl, sec);
  r.prepareBundle && r.prepareBundle(bun);
  if (r.awaitLbReady) await r.awaitLbReady(bun);
  r.setViewport(N, N); gl.viewport(0, 0, N, N);
  const c0 = (r.debugStats && r.debugStats.loopBlinnRouteCount) || 0;
  r.beginFrame([1, 1, 1, 1]);
  r.drawBundle(bun);
  r.endFrame();
  const routed = ((r.debugStats && r.debugStats.loopBlinnRouteCount) || 0) - c0;
  const px = grab();
  let verts = 0, slugSent = 0, kinds = {};
  for (const m of (bun._lbMeshes || [])) {
    if (!m) continue;
    if (m.slug) { slugSent++; continue; }
    if (!m.verts) continue;
    verts += m.vertexCount | 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const k = Math.floor(m.verts[i * 24 + 5] + 0.001);
      kinds[k] = (kinds[k] || 0) + 1;
    }
  }
  bun.dispose && bun.dispose();
  return { px: Array.from(px), routed, verts, slugSent, kinds };
}
window.__run = async (svgTxt) => {
  const slug = await paint(svgTxt, 'off');
  if (slug.err) return { err: 'slug:' + slug.err };
  const lb = await paint(svgTxt, 'on');
  if (lb.err) return { err: 'lb:' + lb.err };
  let lbOnly = 0, slugOnly = 0, softSum = 0, softN = 0, maxD = 0, inkS = 0, inkL = 0;
  const A = slug.px, B = lb.px;
  for (let i = 0; i < A.length; i += 4) {
    const aInk = inkish(A, i), bInk = inkish(B, i);
    if (aInk) inkS++;
    if (bInk) inkL++;
    // Hard: one side solid-ink, the other empty — AA fringe alone must not trip this.
    if (solid(B, i) && empty(A, i)) lbOnly++;
    if (solid(A, i) && empty(B, i)) slugOnly++;
    const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    if (d > maxD) maxD = d;
    if (aInk || bInk) { softSum += d; softN++; }
  }
  const hard = lbOnly + slugOnly;
  const inkMax = Math.max(1, Math.max(inkS, inkL));
  return {
    routed: lb.routed, verts: lb.verts, slugSent: lb.slugSent, kinds: lb.kinds,
    lbOnly, slugOnly, hard, xorPct: 100 * hard / inkMax,
    mean: softN ? softSum / softN / 255 : 0, maxD, softN, inkS, inkL,
  };
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
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[page]', String(e.message).slice(0, 240)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });

const bad = [];
let routedN = 0,
  skipN = 0,
  errN = 0;
for (const f of FILES) {
  const rel = path.relative(CORPUS_ROOT, f);
  let txt;
  try {
    txt = readFileSync(f, 'utf8');
  } catch (e) {
    console.log(`SKIP ${rel} read:${e.message}`);
    skipN++;
    continue;
  }
  let o;
  try {
    o = await pg.evaluate((s) => window.__run(s), txt);
  } catch (e) {
    console.log(`ERR  ${rel} evaluate:${String(e.message || e).slice(0, 120)}`);
    errN++;
    continue;
  }
  if (o.err) {
    console.log(`ERR  ${rel} ${o.err.slice(0, 120)}`);
    errN++;
    continue;
  }
  const usedLb = o.routed > 0 && o.verts > 0;
  if (usedLb) routedN++;
  const hardBad = usedLb && (o.hard > HARD_FAIL || o.xorPct > XOR_PCT_FAIL);
  const softBad = usedLb && o.mean > MEAN_INK_FAIL;
  const tag = hardBad ? ' BAD' : softBad ? ' soft' : '';
  if (hardBad || softBad || process.env.VERBOSE) {
    console.log(
      `${hardBad ? 'FAIL' : 'ok  '} ${rel}` +
        ` route=${o.routed} v=${o.verts} hard=+${o.lbOnly}/-${o.slugOnly}` +
        ` (${o.xorPct.toFixed(2)}%) mean=${o.mean.toFixed(4)} maxD=${o.maxD}` +
        ` k12=${o.kinds[12] | 0} k10=${o.kinds[10] | 0}${tag}`,
    );
  } else {
    process.stdout.write('.');
  }
  if (hardBad) bad.push({ rel, ...o });
}
console.log('');
console.log(
  `done: ${FILES.length} files, LB-routed ${routedN}, err ${errN}, skip ${skipN}, hard-fail ${bad.length} (thresh hard>${HARD_FAIL} or xor%>${XOR_PCT_FAIL})`,
);
if (bad.length) {
  console.log('HARD FAILURES:');
  for (const b of bad) {
    console.log(
      `  ${b.rel} hard=+${b.lbOnly}/-${b.slugOnly} (${b.xorPct.toFixed(2)}%) mean=${b.mean.toFixed(4)} verts=${b.verts}`,
    );
  }
}
// KEEP_OPEN=1 leaves the browser and the server up so the rendered page can be
// inspected by hand. The process stays alive until it is killed.
if (process.env.KEEP_OPEN === '1') {
  console.log(
    '\n[KEEP_OPEN] browser left open — inspect the canvas; Ctrl-C or kill this process to close.',
  );
  await new Promise(() => {});
}
await br.close();
server.close();
process.exit(bad.length ? 1 : 0);
