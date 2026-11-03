// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _renderDeterminism.mjs — do two IDENTICAL renderers draw the same pixels?
//
// Found as a side observation: probes/_streamBandwidth's CONTROL state (the baseline
// rebuilt, byte-identical by construction) reported 85 max px diff on
// examples/_dash_cubic.svg while reporting 0-1 on other assets. The control exists to
// measure the noise floor, so a large control diff is not noise in the measurement —
// it means two runs of the same code disagree, and that is worth a name.
//
// Method: build N renderers over the same asset, one at a time, and diff each frame
// against the first. Also diff the FIRST renderer against ITSELF across repeated
// frames, which separates the two candidate causes:
//   - instance-to-instance divergence (setup order, async readiness, warm state)
//   - frame-to-frame divergence within one renderer (genuinely unstable output)
// Reports where the differing pixels are, since a rim-only pattern is AA tie-breaking
// while a scattered or solid-region pattern is something worse.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = (process.env.ASSETS || 'examples/_dash_cubic.svg,examples/_arcs_circle.svg').split(
  ',',
);
const N = Number(process.env.N || 4);
const SIZE = Number(process.env.SIZE || 768);
const FRAMES = Number(process.env.FRAMES || 3);

const svgs = {};
for (const a of ASSETS) svgs[a] = readFileSync(path.join(ROOT, a), 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="c"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const SVGS = ${JSON.stringify(svgs)}, N = ${N}, S = ${SIZE}, FRAMES = ${FRAMES};
const cv = document.getElementById('c'); cv.width = S; cv.height = S;
const gl = cv.getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const breathe = () => new Promise((r) => requestAnimationFrame(() => r()));

async function shots(svg) {
  const r = createRenderer(gl, shaders, { aacFill: false });
  await r.ready; r.setViewport(S, S); r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(svg));
  try { r.prepareBundle(b); } catch (e) {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch (e) {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch (e) {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch (e) {} }
  const frame = () => { r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let i = 0; i < 60; i++) { frame(); if ((r.debugStats.unifiedFillDraws | 0) > 0) break; await breathe(); }
  // Several frames from the SAME renderer: intra-instance stability.
  const out = [];
  for (let f = 0; f < FRAMES; f++) {
    frame();
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.push(px);
  }
  const gate = r.debugStats.unifiedFillGate, uni = r.debugStats.unifiedFillDraws | 0;
  const key = r.debugStats.fillVariantKey || '(base)';
  try { b.dispose(); } catch (e) {}
  return { px: out, gate, uni, key };
}
const cmp = (a, b) => {
  let n = 0, worst = 0, rim = 0, solid = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[o+k] - b[o+k]));
    if (!d) continue;
    n++; if (d > worst) worst = d;
    // A differing pixel whose NEIGHBORS are all inked is interior; one with a
    // background neighbor is on a rim. Interior disagreement is the serious kind.
    const x = i % S, y = (i / S) | 0;
    let bgNeighbor = false;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) { bgNeighbor = true; continue; }
      const no = (ny * S + nx) * 4;
      if (a[no] < 8 && a[no+1] < 8 && a[no+2] < 8) bgNeighbor = true;
    }
    if (bgNeighbor) rim++; else solid++;
  }
  return { n, worst, rim, solid };
};
// WARMUP=1 builds and discards one renderer BEFORE run 0. If that makes all runs
// agree, the divergence is state a previous renderer leaves in the shared GL context
// (run 0 alone starts from pristine defaults) rather than anything random.
const out = {};
if (${JSON.stringify(!!process.env.WARMUP)}) { await shots(Object.values(SVGS)[0]); await breathe(); }
for (const [name, svg] of Object.entries(SVGS)) {
  const runs = [];
  for (let i = 0; i < N; i++) { runs.push(await shots(svg)); await breathe(); }
  const intra = runs.map((r) => cmp(r.px[0], r.px[r.px.length - 1]));
  const inter = runs.slice(1).map((r) => cmp(runs[0].px[0], r.px[0]));
  out[name] = {
    gates: runs.map((r) => r.gate), unis: runs.map((r) => r.uni),
    keysEqual: runs.every((r) => r.key === runs[0].key),
    intra, inter,
  };
}
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
await br.close();
server.close();

const f = (c) =>
  `${String(c.n).padStart(6)}px w${String(c.worst).padStart(4)} rim ${String(c.rim).padStart(5)} interior ${String(c.solid).padStart(5)}`;
for (const [name, v] of Object.entries(r)) {
  console.log(
    `\n  ${name}   gates ${v.gates.join(',')}   uni ${v.unis.join(',')}   sameVariant=${v.keysEqual}`,
  );
  console.log(`    INTRA (frame 0 vs frame ${FRAMES - 1}, same renderer):`);
  v.intra.forEach((c, i) => console.log(`      run ${i}: ${f(c)}`));
  console.log(`    INTER (run 0 frame 0 vs run i frame 0):`);
  v.inter.forEach((c, i) => console.log(`      run ${i + 1}: ${f(c)}`));
}
console.log('\n  INTRA nonzero  -> one renderer is unstable frame to frame.');
console.log('  INTER nonzero only -> instances diverge at SETUP (readiness, warm, order).');
console.log('  interior>0 is the serious column: rim-only differences are AA tie-breaks.');
