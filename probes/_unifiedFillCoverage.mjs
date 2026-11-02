// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _unifiedFillCoverage.mjs — which FEATURES can the unified fill draw serve?
//
// Step 3b wants the per-shape coverage-RT paths (_renderSplitStrokeCovRT,
// _drawComposedMorphShape, MANTLE_STROKE_COV / MANTLE_LB_FILL_COV) deleted. They
// can only go once the unified draw serves everything they serve, so this reports,
// per feature, whether the route took the bundle and — when it didn't — the gate
// that turned it away (debugStats.unifiedFillGate), plus the GL draw count and the
// pixel delta against the route that exists today.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const D = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${defs}${body}</svg>`;

const CASES = {
  solid: svg(`<path fill="#3060c0" d="${D}"/>`),
  twoShapes: svg(`<path fill="#3060c0" d="${D}"/><circle cx="28" cy="12" r="8" fill="#c04030"/>`),
  translucent: svg(`<path fill="#3060c0" fill-opacity="0.5" d="${D}"/>`),
  gradient: svg(
    `<path fill="url(#g)" d="${D}"/>`,
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#3060c0"/>' +
      '<stop offset="1" stop-color="#c04030"/></linearGradient></defs>',
  ),
  stroked: svg(`<path fill="#3060c0" stroke="#102040" stroke-width="3" d="${D}"/>`),
  strokeOnly: svg(`<path fill="none" stroke="#3060c0" stroke-width="3" d="${D}"/>`),
  dashed: svg(
    `<path fill="none" stroke="#3060c0" stroke-width="3" stroke-dasharray="4 2" d="${D}"/>`,
  ),
  // BISECTION for the dash fault. vStartDist is a prefix sum over PRECEDING
  // segments, so a ONE-SEGMENT open path has vStartDist == 0 by construction: if
  // this dashes correctly and the two-segment case does not, the prefix sum is the
  // fault rather than the dash lookup or the pattern binding.
  // CURVED, because a straight-line bundle builds no LB mesh and so never reaches
  // the unified route at all (gate 'no-meshes') — the first attempt at this
  // bisection measured nothing for exactly that reason.
  dash1seg: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="4 2" d="M6 30 Q20 2 34 30"/>',
  ),
  dash2seg: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="4 2" d="M6 30 Q13 6 20 20 Q27 34 34 10"/>',
  ),
  // dash1seg's ONE structural pixel: is it a broken path or a tie-break at a hard
  // dash boundary? Dash coverage is an in/out test, so a sub-LSB difference in
  // pathDist at a boundary flips a pixel FULLY (w192), while the same difference
  // anywhere else shows up as w1. Nudging the phase moves every boundary; if the
  // pixel comes and goes with the nudge it is a tie-break, and if it survives all
  // three it is systematic (an end cap, say).
  dash1segPhA: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="4.03 2" d="M6 30 Q20 2 34 30"/>',
  ),
  dash1segPhB: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="4 2" stroke-dashoffset="0.7" d="M6 30 Q20 2 34 30"/>',
  ),
  dash1segPhC: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="3.5 2.5" d="M6 30 Q20 2 34 30"/>',
  ),
  // Separate CLOSED-ness from CURVE TYPE: dash2seg (open quads) is correct after
  // the partition fix while `dashed` (closed cubics) is not, so one of those two
  // properties is the remaining fault.
  dashClosedQ: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="4 2" d="M8 20 Q20 4 32 20 Q20 36 8 20 Z"/>',
  ),
  dashOpenCub: svg(
    '<path fill="none" stroke="#3060c0" stroke-width="3" ' +
      'stroke-dasharray="4 2" d="M6 28 C12 6 20 6 20 20 C20 34 28 34 34 12"/>',
  ),
  clipped: svg(
    `<path fill="#3060c0" clip-path="url(#c)" d="${D}"/>`,
    '<defs><clipPath id="c"><rect x="4" y="4" width="22" height="32"/></clipPath></defs>',
  ),
  masked: svg(
    `<path fill="#3060c0" mask="url(#m)" d="${D}"/>`,
    '<defs><mask id="m"><rect x="4" y="4" width="22" height="32" fill="#fff"/></mask></defs>',
  ),
  filtered: svg(
    `<path fill="#3060c0" filter="url(#f)" d="${D}"/>`,
    '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>',
  ),
  evenOdd: svg(
    `<path fill="#3060c0" fill-rule="evenodd" d="${D} M20 12 C26 12 28 14 28 20 ` +
      `C28 26 26 28 20 28 C14 28 12 26 12 20 C12 14 14 12 20 12 Z"/>`,
  ),
};

const SIZE = Number(process.env.SEAM_SIZE || 160);
// CASES=dash1seg,dash2seg narrows the sweep. Bisecting one fault does not need all
// 15 features, and three GL contexts per case is real work for the machine.
if (process.env.CASES) {
  const keep = new Set(process.env.CASES.split(','));
  for (const k of Object.keys(CASES)) if (!keep.has(k)) delete CASES[k];
  if (!Object.keys(CASES).length) {
    console.error('CASES matched nothing');
    process.exit(2);
  }
}
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const o = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return o(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(svgSrc, mode) {
  const opts = { aacFill: false };
  if (mode === 'classic') opts.unifiedFill = false;
  const MARK = ${JSON.stringify(process.env.LB_MARK || '')};
  if (MARK && mode !== 'slug') opts.fillDefines = [MARK];
  if (${JSON.stringify(!!process.env.LB_DEPTH_CLAIM)} && mode === 'unified') opts.unifiedFillDepthClaim = true;
  // LB_NO_DEPTH_CLAIM: does the claim still earn its keep? Fragment multiplicity
  // measured 1 everywhere (probes/_lbFragCount), and healCracks asserts CDT vertices
  // are shared EXACTLY — both of which predict the double-paint it guards is gone.
  if (${JSON.stringify(!!process.env.LB_NO_DEPTH_CLAIM)} && mode === 'unified') opts.unifiedFillDepthClaim = false;
  if (${JSON.stringify(!!process.env.LB_NO_PARTITION)} && mode === 'unified') opts.unifiedStrokePartition = false;
  // Per-curve coefficients in a texture: a pure PLACEMENT change (RGBA32F is still
  // FP32), so 'unified' must stay pixel-identical to 'classic' and to Slug.
  if (${JSON.stringify(!!process.env.LB_CURVE_TEX)} && mode === 'unified') opts.unifiedFillCurveTex = true;
  const r = createRenderer(gl, shaders, opts);
  const b = createBundle(gl, await importSvg(svgSrc));
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  // NO_GATES=1 turns off the stroke band walk's saturation/reach early-outs, which
  // are asserted output-identical. If a case only agrees with gates off, that
  // assertion is false for it.
  if (${JSON.stringify(!!process.env.NO_GATES)} && r.setStrokeGates) r.setStrokeGates(false);
  try { r.prepareBundle(b); } catch {}
  if (mode !== 'slug' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  // The route waits for its variant to link and PSO-warm, both off the critical
  // path, so spin real frames until it settles rather than reading frame 2.
  for (let i = 0; i < 60; i++) {
    frame();
    if ((r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) break;
    await new Promise((res) => requestAnimationFrame(res));
  }
  const before = (r.debugStats && r.debugStats.unifiedFillDraws | 0) || 0;
  draws = 0; frame();
  const st = r.debugStats || {};
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  try { b.dispose(); } catch {}
  return { px, draws, uni: ((st.unifiedFillDraws | 0) - before), gate: st.unifiedFillGate || '?',
           rtFill: st.composedFillFromRT | 0, rtStroke: st.composedStrokeFromRT | 0,
           segs: st.unifiedStrokeEntries | 0, badFill: st.unifiedStrokeFillOnStrokeRow | 0 };
}

const out = {};
for (const [name, s] of Object.entries(${JSON.stringify(CASES)})) {
  const slug = await shoot(s, 'slug');
  const classic = await shoot(s, 'classic');
  const unified = await shoot(s, 'unified');
  // Against SLUG, not against each other: "they differ" does not say which is
  // right, and on two of these cases the classic route is the one that is wrong.
  // n counts ANY disagreement, so it is dominated by one-LSB AA noise and a big n
  // says nothing about correctness. struct counts only pixels over the 24/255
  // structural threshold, and at[] locates the first few -- the numbers that decide
  // whether a route is actually wrong.
  // (No backticks in this file's browser-side source: it lives in a template literal.)
  const vs = (a, b) => {
    let n = 0, worst = 0, sum = 0, struct = 0; const at = [];
    for (let i = 0; i < S * S; i++) {
      const o = i * 4;
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[o+k] - b[o+k]));
      if (d) { n++; sum += d; if (d > worst) worst = d; }
      if (d > 24) { struct++; if (at.length < 8) at.push((i % S) + ',' + (S - 1 - ((i / S) | 0)) + ':' + d); }
    }
    return { n, worst, struct, at, mean: n ? +(sum / n).toFixed(1) : 0 };
  };
  let ink = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    if (slug.px[o] > 8 || slug.px[o+1] > 8 || slug.px[o+2] > 8) ink++;
  }
  // DIFFMAP=1 renders WHERE the classic-vs-slug disagreement is, at 1 char per
  // 4x4 block: '#' = structural (>24), '+' = AA-only, '.' = ink that agrees.
  // "132 pixels differ" does not distinguish a whole missing dash from a shifted
  // dash phase from a bad cap, and those have different causes.
  let map = null;
  if (${JSON.stringify(!!process.env.DIFFMAP)}) {
    const B = 4, G = Math.ceil(S / B); map = [];
    for (let gy = 0; gy < G; gy++) {
      let row = '';
      for (let gx = 0; gx < G; gx++) {
        let worst = 0, anyInk = 0;
        for (let y = gy * B; y < Math.min(S, gy * B + B); y++)
          for (let x = gx * B; x < Math.min(S, gx * B + B); x++) {
            const o = ((S - 1 - y) * S + x) * 4;
            let d = 0;
            for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(slug.px[o+k] - classic.px[o+k]));
            worst = Math.max(worst, d);
            if (slug.px[o] > 8 || slug.px[o+1] > 8 || slug.px[o+2] > 8) anyInk = 1;
          }
        row += worst > 24 ? '#' : worst ? '+' : anyInk ? '.' : ' ';
      }
      map.push(row);
    }
  }
  out[name] = { map, gate: unified.gate, uni: unified.uni, ink,
                draws: { classic: classic.draws, unified: unified.draws },
                rt: { classic: classic.rtFill + '/' + classic.rtStroke,
                      unified: unified.rtFill + '/' + unified.rtStroke },
                segs: unified.segs, badFill: unified.badFill,
                uvc: vs(classic.px, unified.px),
                cvs: vs(slug.px, classic.px),
                uvs: vs(slug.px, unified.px) };
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
  await page.waitForFunction('typeof window.out !== "undefined"', { timeout: 280000 });
} catch {
  console.log('page never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

const f = (c) =>
  `${String(c.n).padStart(6)}px w${String(c.worst).padStart(4)}/s${String(c.struct).padStart(4)}`;
console.log(
  'feature       gate       draws c/u  RT c/u      ink    uni-vs-classic   classic-vs-slug  unified-vs-slug',
);
for (const [k, v] of Object.entries(r)) {
  console.log(
    `${k.padEnd(13)} ${String(v.gate).padEnd(10)}` +
      ` ${String(v.draws.classic).padStart(3)}/${String(v.draws.unified).padEnd(3)}` +
      ` ${(v.rt.classic + ' ' + v.rt.unified).padEnd(11)} ${String(v.ink).padStart(5)}` +
      `  ${f(v.uvc)}  ${f(v.cvs)}  ${f(v.uvs)}  segs=${v.segs} badFill=${v.badFill}`,
  );
}
for (const [k, v] of Object.entries(r)) {
  for (const [tag, c] of [
    ['classic-vs-slug', v.cvs],
    ['unified-vs-slug', v.uvs],
  ])
    if (c.struct) console.log(`  ${k} ${tag}: ${c.struct} structural px, first: ${c.at.join(' ')}`);
}
for (const [k, v] of Object.entries(r)) {
  if (!v.map) continue;
  console.log(`\n${k}: classic vs slug  ('#' structural, '+' AA-only, '.' agreeing ink)`);
  for (const row of v.map) console.log('  ' + row);
}
