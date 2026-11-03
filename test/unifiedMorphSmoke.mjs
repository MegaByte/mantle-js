// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedMorphSmoke.mjs — a MORPH through the unified draw: no coverage RT, and
// no further from the Slug morph than the route it replaces.
//
// The unified draw serves morphs without per-shape coverage render targets. This
// asserts, per feature and at several t, that the unified draw serves them with
// ZERO composed-RT draws and no loss of accuracy against the Slug morph — which
// is the exact reference, so "closer to Slug" is unambiguously better.
//
// TWO TRAPS this test exists to keep closed:
//
// 1. A morph mesh is a CONTAINER of t-segments and each segment calls its
//    interleaved array `vbo`, where a static pack calls the same thing `verts`.
//    Reading only `verts` made every morph shape look mesh-less, so each fell
//    back to its cover quad and the frame came out BYTE-IDENTICAL to the Slug
//    morph. No pixel test can flag that on its own — Slug is a correct picture —
//    which is why the assertions below also require the route to be ENTERED.
//
// 2. precompileFills must run AFTER the first draw. A morph bundle's required
//    variant is only known once its pair meshes exist, and those are built by the
//    first draw; the idle-frame gate that would otherwise catch up never accrues
//    headless.

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
  stroked: [
    svg(A, 'fill="#3060c0" stroke="#102040" stroke-width="3"'),
    svg(B, 'fill="#3060c0" stroke="#102040" stroke-width="3"'),
  ],
  strokeOnly: [
    svg(A, 'fill="none" stroke="#3060c0" stroke-width="3"'),
    svg(B, 'fill="none" stroke="#3060c0" stroke-width="3"'),
  ],
  clipped: [
    svg(
      A,
      'fill="#3060c0" clip-path="url(#c)"',
      '<defs><clipPath id="c"><rect x="4" y="4" width="22" height="32"/></clipPath></defs>',
    ),
    svg(
      B,
      'fill="#3060c0" clip-path="url(#c)"',
      '<defs><clipPath id="c"><rect x="4" y="4" width="22" height="32"/></clipPath></defs>',
    ),
  ],
};

const SIZE = Number(process.env.SEAM_SIZE || 160);
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
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
    shots.push({ t, px, draws,
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
  const slug = await shoot(sa, sb, 'slug', TS);
  const lb = await shoot(sa, sb, 'lb', TS);
  out[name] = lb.map((s, i) => ({ t: s.t, draws: s.draws, rt: s.rt, uni: s.uni, gate: s.gate, key: s.key,
                                  slugDraws: slug[i].draws, vsSlug: vs(slug[i].px, s.px) }));
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

// Worst delta from the Slug morph, per feature and t. The bar is "no worse than this", with 2/255
// of slack for rounding.
//
// The middle t is held tightly because of the drift-refined segmentation: a Bezout pair's resultant
// entries are degree 2 in t, so a linear mix of the packed frame draws that quadratic's chord, and
// the segmenter splits where the drift is worst. The bars are recorded tightly so that losing that
// segmentation fails here.
//
// The t = 1 numbers are NOT the morph. Drift at a built endpoint is identically zero, and a STATIC
// unified draw of pose B measures 86 (solid) and 43 (clipped) against Slug at this size — worse
// than the morph's own endpoint reads. So what is left at t = 1 is the unified route's static
// accuracy on this shape, which is tracked separately; no change to the morph can move it, and
// holding a morph test to it only hides the thing it does measure.
const BASELINE = {
  solid: [11, 31, 40],
  translucent: [5, 15, 20],
  stroked: [0, 0, 0],
  strokeOnly: [0, 0, 0],
  clipped: [11, 31, 34],
};

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

console.log('   feature       t     draws slug/lb  composedRT  unified  vs Slug morph');
for (const [k, rows] of Object.entries(r)) {
  for (const s of rows) {
    console.log(
      `   ${k.padEnd(13)} ${String(s.t).padEnd(5)} ${String(s.slugDraws).padStart(5)}/` +
        `${String(s.draws).padEnd(5)} ${String(s.rt).padStart(10)} ${String(s.uni).padStart(8)}` +
        `  ${String(s.vsSlug.n).padStart(6)}px w${String(s.vsSlug.worst).padStart(4)}`,
    );
  }
}
console.log('');

for (const [k, rows] of Object.entries(r)) {
  // Entered at every t, not just the first: t crossing a segment boundary
  // rebuilds the stream, and a rebuild that fails would silently fall back.
  ok(
    rows.every((s) => s.uni > 0 && s.gate === 'on'),
    `${k}: the unified route drew every t (${rows.map((s) => s.uni).join(',')})`,
  );
  ok(
    rows.every((s) => s.rt === 0),
    `${k}: no composed coverage RT at any t (${rows.map((s) => s.rt).join(',')})`,
  );
  const base = BASELINE[k];
  ok(
    rows.every((s, i) => s.vsSlug.worst <= base[i] + 2),
    `${k}: no further from the Slug morph than its recorded bar ` +
      `(${rows.map((s) => s.vsSlug.worst).join('/')} vs ${base.join('/')})`,
  );
}

console.log(
  `\nunifiedMorphSmoke: ${fail ? 'FAIL' : 'PASS'} — ` +
    `${Object.keys(r).length} morph features, 0 coverage RTs`,
);
process.exit(fail ? 1 : 0);
