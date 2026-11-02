// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillCurveTexIdx32MorphSmoke.mjs -- a MORPH whose curve-block table passes the 16-bit index is drawn from the 32-bit
// layout (the B endpoint's block index rides its own float at a different offset there), and the picture equals the 16-bit layout's.
// The 16-bit limit is lowered through the test hook, so a small morph overflows it; the default run is the reference.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';
const svg = (d, attrs, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${defs}` +
  `<path d="${d}" ${attrs}/></svg>`;

const CASES = {
  solid: [svg(A, 'fill="#3060c0"'), svg(B, 'fill="#3060c0"')],
  translucent: [
    svg(A, 'fill="#3060c0" fill-opacity="0.5"'),
    svg(B, 'fill="#3060c0" fill-opacity="0.5"'),
  ],
};

const SIZE = Number(process.env.SEAM_SIZE || 160);
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
import { _setUcIdxLimitForTest } from '/src/renderer/unifiedFillVerts.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const o = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return o(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(srcSvg, dstSvg, mode, ts) {
  _setUcIdxLimitForTest(mode === 'idx32' ? 3 : 0);
  const r = createRenderer(gl, shaders, { aacFill: false, unifiedMorph: mode !== 'slug' });
  const morph = createShapeMorph(gl, createBundle(gl, await importSvg(srcSvg)),
                                     createBundle(gl, await importSvg(dstSvg)));
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  const frame = (t) => { morph.setT(t); r.setViewport(S, S);
    r.beginFrame([0, 0, 0, 1]); r.drawBundle(morph, {}); r.endFrame(); };
  frame(0);
  if (mode !== 'slug' && r.awaitLbReady) { try { await r.awaitLbReady(morph, 20000); } catch {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  // The PSO warm needs 45 consecutive slack frames before fillWarmTick will drain
  // it, and a morph bundle's variant is only KNOWN once its pair meshes exist —
  // which happens at the first draw, after precompileFills already ran. So spin
  // real frames until the route engages rather than assuming a fixed count.
  // precompileFills has to run AFTER the first draw, not before: a morph bundle's
  // required variant is only known once its pair meshes exist, and those are built
  // by the first draw. The idle-frame gate that would otherwise catch up never
  // accrues headless (frames run slower than the 20ms slack threshold), so the
  // explicit drain is the only thing that warms it here — but ONCE, not per
  // iteration: it force-links every pending program and builds Metal pipelines.
  // precompileFills force-links every pending program and builds Metal
  // pipelines, so it is expensive: call it ONCE after the first draw (which is
  // what makes the required variant known) and then just spin frames. Calling it
  // per iteration made this smoke slow enough to time out other tests in the
  // suite while still passing on its own.
  // TWO drains, not one and not thirty. The first draw is what makes the required
  // variant known (the LB mesh arrives off-thread), and finding it mismatched is
  // what re-enqueues the bundle — so the SECOND drain is the one that warms the
  // right program. Draining per-iteration instead made this smoke slow enough to
  // time other suite tests out while still passing on its own.
  frame(0);
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  frame(0);
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  for (let i = 0; i < 8; i++) {
    frame(0);
    if (mode === 'slug' || (r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) break;
    // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
      await new Promise((res) => { const _t = setTimeout(res, 100); requestAnimationFrame(() => { clearTimeout(_t); res(); }); });
  }

  const shots = [];
  for (const t of ts) {
    const st0 = r.debugStats || {};
    const uni0 = st0.unifiedFillDraws | 0, rt0 = (st0.composedFillFromRT | 0) + (st0.composedStrokeFromRT | 0);
    draws = 0; frame(t);
    const st = r.debugStats || {};
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    shots.push({ t, px, draws, idx32: st.uniCurveTexIdx32 | 0, overflow: st.uniCurveTexOverflow | 0,
                 uni: (st.unifiedFillDraws | 0) - uni0,
                 rt: ((st.composedFillFromRT | 0) + (st.composedStrokeFromRT | 0)) - rt0,
                 gate: st.unifiedFillGate || '?',
                 lb: (st.loopBlinnMorphRouteCount | 0),
                 key: st.fillVariantKey || '(base)' });
  }
  try { morph.dispose(); } catch {}
  return shots;
}

const vs = (a, b) => {
  let n = 0, worst = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[o+k] - b[o+k]));
    if (d) { n++; if (d > worst) worst = d; }
  }
  return { n, worst };
};

const TS = [0, 0.5, 1];
const out = {};
for (const [name, [sa, sb]] of Object.entries(${JSON.stringify(CASES)})) {
  const ref = await shoot(sa, sb, 'lb', TS);
  const big = await shoot(sa, sb, 'idx32', TS);
  _setUcIdxLimitForTest(0);
  out[name] = big.map((s, i) => ({ t: s.t, uni: s.uni, gate: s.gate, idx32: s.idx32, overflow: s.overflow, refIdx32: ref[i].idx32, refUni: ref[i].uni, vsRef: vs(ref[i].px, s.px) }));
}
window.out = out;
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', {
    timeout: pageTimeoutFor(280000),
    polling: 100,
  });
} catch {
  console.log('page never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const [k, rows] of Object.entries(r)) {
  ok(
    rows.every((s) => s.refUni > 0 && s.refIdx32 === 0),
    `${k}: the reference morph draws from the 16-bit layout`,
  );
  ok(
    rows.every((s) => s.uni > 0 && s.gate === 'on' && s.idx32 >= 1 && s.overflow === 0),
    `${k}: the lowered limit draws the morph from the 32-bit layout, on the unified route (${rows.map((s) => s.idx32).join(',')} builds)`,
  );
  ok(
    rows.every((s) => s.vsRef.n === 0),
    `${k}: the picture equals the 16-bit layout's at every t (${rows.map((s) => s.vsRef.n + 'px').join(', ')})`,
  );
}
console.log(`\nunifiedFillCurveTexIdx32MorphSmoke: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
