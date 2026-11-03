// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillCurveTexWideIndexSmoke — the unified Loop-Blinn curve texture's index layouts at
// their boundaries (16-bit, 32-bit, and the wide vertex fallback), through the test hooks:
//   unifiedFillCurveTexWideIndex   past 65,535 blocks a bundle stays on the 32-bit layout
//   unifiedFillCurveTexIdx32Morph  a morph past the 16-bit limit draws from the 32-bit layout
//   unifiedFillCurveTexOverflow    past the 32-bit limit too: the wide vertex layout, without
//                                  MANTLE_LB_CURVE_TEX
// Each case runs on its own page (its own context, renderer and hooks) in one browser; see
// _caseHost.mjs.

import path from 'path';
import { fileURLToPath } from 'url';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// unifiedFillCurveTexWideIndex — the unified Loop-Blinn layout indexes shapes and curve blocks with 32-bit
// integers (a 16-bit index, UC_IDX_MAX 65,535, would send a bundle past it to the wide fallback). A bundle with MORE than 65,535
// distinct coefficient blocks stays on the narrow curve-texture layout and draws like Slug.
//
//   1. CPU: buildCurveTexStream builds the bundle (blocks > 65,535) in the 32-bit layout -- the 16-bit limit alone would return null.
//   2. GPU: no overflow, the bundle is NOT marked off the curve-texture layout, the program key keeps MANTLE_LB_CURVE_TEX,
//      one draw, and ink/AA equal Slug.
async function unifiedFillCurveTexWideIndex(host) {
  // 3,000 distinct blobs (about 96,000 coefficient blocks) (4 cubics each, perturbed by a seeded generator so no two coefficient blocks coincide).
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const NB = 3000,
    COLS = 60;
  const shapes = [];
  for (let i = 0; i < NB; i++) {
    const cx = 0.5 + (i % COLS),
      cy = 0.5 + Math.floor(i / COLS),
      r = 0.3 + rnd() * 0.1;
    const p = (a, k) =>
      `${(cx + Math.cos(a) * r * k).toFixed(4)} ${(cy + Math.sin(a) * r * k * (0.8 + rnd() * 0.3)).toFixed(4)}`;
    const k = 0.5523,
      a0 = rnd() * 0.4;
    let d = `M${p(a0, 1)}`;
    for (let q = 0; q < 4; q++) {
      const a = a0 + (q * Math.PI) / 2,
        b = a + Math.PI / 2;
      d +=
        ` C${(cx + Math.cos(a) * r + -Math.sin(a) * r * k + rnd() * 0.03).toFixed(4)} ${(cy + Math.sin(a) * r + Math.cos(a) * r * k + rnd() * 0.03).toFixed(4)}` +
        ` ${(cx + Math.cos(b) * r + Math.sin(b) * r * k + rnd() * 0.03).toFixed(4)} ${(cy + Math.sin(b) * r - Math.cos(b) * r * k + rnd() * 0.03).toFixed(4)}` +
        ` ${(cx + Math.cos(b) * r).toFixed(4)} ${(cy + Math.sin(b) * r * (0.8 + rnd() * 0.3)).toFixed(4)}`;
    }
    shapes.push(`<path d="${d}Z" fill="#${(0x2040a0 + i * 0x010203).toString(16).slice(-6)}"/>`);
  }
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 50">' + shapes.join('') + '</svg>';
  const OLD_LIMIT = 65535;

  let fail = 0;
  const ok = (c, m) => {
    console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
    if (!c) fail++;
  };

  // ---- 1. CPU ----
  {
    const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
    globalThis.DOMParser = DP;
    globalThis.XMLSerializer = XS;
    const { default: importSvg } = await import('../src/svg/importer.js');
    const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
    const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
    const UV = await import('../src/renderer/unifiedFillVerts.js');
    const b = await importSvg(SVG);
    const cf = new Float32Array(b.curves),
      entries = [];
    for (let s = 0; s < b.numShapes; s++) {
      const r = b.curveRangesByShape[s];
      const built = buildLbShape(curveRangeToContours(cf, r.begin, r.end), false, false);
      entries.push({
        kind: 'lb',
        verts: built.pk.verts,
        vertexCount: built.pk.vertexCount,
        shapeIdx: s,
      });
    }
    const u = UV.buildUnifiedFillVerts(entries, null, null, false);
    const t0 = UV.buildCurveTexStream(u.verts, u.vertexCount, false);
    ok(
      !!t0 && t0.blocks > OLD_LIMIT,
      `the 32-bit stream builds past the 16-bit limit (${t0 && t0.blocks} blocks, ${t0 && t0.coefW}x${t0 && t0.coefH} texels)`,
    );
    ok(!!t0 && t0.idx32 === true, 'it is the 32-bit layout');
  }

  // ---- 2. GPU ----
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="600" height="500"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W = 600, H = 500;
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) { const o = gl[m].bind(gl); gl[m] = (...a) => { draws++; return o(...a); }; }
const read = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
console.log('stage: slug ref');
const rs = createRenderer(gl, shaders, { aacFill: false });
const bs = createBundle(gl, sec);
rs.setViewport(W, H); rs.beginFrame([0, 0, 0, 1]); rs.drawBundle(bs, {}); rs.endFrame();
const slug = read();

const ru = createRenderer(gl, shaders, { aacFill: false, fillDefines: ['MANTLE_LB_FILL'] });
const bu = createBundle(gl, sec);
ru.setLoopBlinnFill('on');
try { ru.prepareBundle(bu); } catch {}
if (ru.awaitLbReady) { try { await ru.awaitLbReady(bu, 120000); } catch {} }
console.log('stage: lb ready');
let served = 0, frames = 0, last = 0;
for (; frames < 600 && !served; frames++) {
  ru.setViewport(W, H); ru.beginFrame([0, 0, 0, 1]); draws = 0; ru.drawBundle(bu, {}); last = draws; ru.endFrame();
  if (['on', 'forced'].includes((ru.debugStats || {}).unifiedFillGate) && last === 1 && !bu._noCurveTex && ((((ru.debugStats || {}).engines || {}).viaRoute || {})['lb@unified'] | 0) > 0) served = 1;
  await new Promise((r) => setTimeout(r, 16));   // not rAF: a headless page does not tick it
}
const uni = read();
let diff = 0, n = 0, inkS = 0, inkU = 0;
for (let i = 0; i < W * H; i++) { const o = i * 4; const a = slug[o] + slug[o + 1] + slug[o + 2], b = uni[o] + uni[o + 1] + uni[o + 2];
  if (a > 24) inkS++; if (b > 24) inkU++; if (a > 24 || b > 24) { n++; for (let k = 0; k < 3; k++) diff += Math.abs(slug[o + k] - uni[o + k]); } }
window.out = { served, frames, last, noCurveTex: !!bu._noCurveTex, overflow: (ru.debugStats || {}).uniCurveTexOverflow | 0, idx32: (ru.debugStats || {}).uniCurveTexIdx32 | 0, gate: (ru.debugStats || {}).unifiedFillGate,
  key: (ru.debugStats || {}).drawnFillVariantKey || '', lbUnified: (((ru.debugStats || {}).engines || {}).viaRoute || {})['lb@unified'] | 0, inkS, inkU, meanDiff: n ? +(diff / (n * 3)).toFixed(2) : 0 };
</script></body></html>`;
  const { browser } = host;
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text());
    else if (process.env.SMOKE_VERBOSE) console.log('  [page] ' + m.text());
  });
  page.on('pageerror', (e) => logs.push(String(e.message)));
  await page.goto(host.page(HTML), {
    waitUntil: 'load',
    timeout: 30000,
  });
  try {
    await page.waitForFunction('typeof window.out !== "undefined"', {
      timeout: 150000,
      polling: 100,
    });
  } catch {
    console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
    await page.close();
    return 1;
  }
  const r = await page.evaluate(() => window.out);
  await page.close();
  console.log(`  ${JSON.stringify(r)}`);
  if (logs.length) console.log('  console errors:\n    ' + logs.join('\n    '));
  ok(r.overflow === 0, `no overflow was counted (${r.overflow})`);
  ok(r.noCurveTex === false, 'the bundle stays on the curve-texture layout');
  ok(r.idx32 >= 1, `...in the 32-bit index layout (${r.idx32} build(s))`);
  ok(r.key.includes('MANTLE_LB_CURVE_TEX'), 'the selected program key keeps MANTLE_LB_CURVE_TEX');
  ok(
    r.key.includes('MANTLE_LB_FILL') && r.lbUnified > 0,
    `the drawn program is the Loop-Blinn unified variant and the engine ledger shows lb@unified (${r.lbUnified})`,
  );
  ok(
    r.served === 1 && r.last === 1,
    `served in one draw on the narrow layout after ${r.frames} frame(s)`,
  );
  ok(
    r.inkU > 3000 && Math.abs(r.inkU - r.inkS) / Math.max(r.inkS, 1) < 0.03,
    `ink within 3% of Slug (${r.inkU} vs ${r.inkS})`,
  );
  ok(r.meanDiff < 12, `mean channel difference vs Slug is AA-scale (${r.meanDiff})`);
  console.log(`\nunifiedFillCurveTexWideIndexSmoke: ${fail ? 'FAIL' : 'PASS'}`);
  return fail;
}

// unifiedFillCurveTexIdx32Morph — a MORPH whose curve-block table passes the 16-bit index is drawn from the 32-bit
// layout (the B endpoint's block index rides its own float at a different offset there), and the picture equals the 16-bit layout's.
// The 16-bit limit is lowered through the test hook, so a small morph overflows it; the default run is the reference.
async function unifiedFillCurveTexIdx32Morph(host) {
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

  const { browser } = host;
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text());
  });
  page.on('pageerror', (e) => logs.push(String(e.message)));
  await page.goto(host.page(HTML), {
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
    await page.close();
    return 1;
  }
  const r = await page.evaluate(() => window.out);
  await page.close();

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
  return fail;
}

// unifiedFillCurveTexOverflow — when the curve-block table overflows the 32-bit index too (the test hooks lower both), the draw uses the WIDE
// vertex layout AND a program without MANTLE_LB_CURVE_TEX (on a 5,000-shape asset, a program that kept the texture define
// while the stream carried coefficients in the vertex cracks every chain face).
//
//   1. CPU, no GPU: buildCurveTexStream refuses (null) a bundle whose blocks pass the limit and accepts it under the
//      default limit. The limit is lowered through the test hook, so a small synthetic bundle overflows -- no 5,000-shape fixture.
//   2. GPU render: that same bundle drawn on a renderer with the lowered limit marks bundle._noCurveTex, counts the
//      overflow, binds a program whose key LACKS MANTLE_LB_CURVE_TEX, draws LB in one call, and equals Slug within AA.
async function unifiedFillCurveTexOverflow(host) {
  // 48 distinct blobs (4 cubics each, perturbed by a seeded generator so no two coefficient blocks coincide).
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shapes = [];
  for (let i = 0; i < 48; i++) {
    const cx = 7 + (i % 8) * 12,
      cy = 8 + Math.floor(i / 8) * 14,
      r = 4 + rnd() * 1.5;
    const p = (a, k) =>
      `${(cx + Math.cos(a) * r * k).toFixed(3)} ${(cy + Math.sin(a) * r * k * (0.8 + rnd() * 0.3)).toFixed(3)}`;
    const k = 0.5523,
      a0 = rnd() * 0.4;
    let d = `M${p(a0, 1)}`;
    for (let q = 0; q < 4; q++) {
      const a = a0 + (q * Math.PI) / 2,
        b = a + Math.PI / 2;
      d +=
        ` C${(cx + Math.cos(a) * r + -Math.sin(a) * r * k + rnd() * 0.3).toFixed(3)} ${(cy + Math.sin(a) * r + Math.cos(a) * r * k + rnd() * 0.3).toFixed(3)}` +
        ` ${(cx + Math.cos(b) * r + Math.sin(b) * r * k + rnd() * 0.3).toFixed(3)} ${(cy + Math.sin(b) * r - Math.cos(b) * r * k + rnd() * 0.3).toFixed(3)}` +
        ` ${(cx + Math.cos(b) * r).toFixed(3)} ${(cy + Math.sin(b) * r * (0.8 + rnd() * 0.3)).toFixed(3)}`;
    }
    shapes.push(`<path d="${d}Z" fill="#${(0x2040a0 + i * 0x010203).toString(16).slice(-6)}"/>`);
  }
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + shapes.join('') + '</svg>';
  const LIMIT = 40; // blocks; the bundle interns far more than this

  let fail = 0;
  const ok = (c, m) => {
    console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
    if (!c) fail++;
  };

  // ---- 1. CPU ----
  {
    const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
    globalThis.DOMParser = DP;
    globalThis.XMLSerializer = XS;
    const { default: importSvg } = await import('../src/svg/importer.js');
    const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
    const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
    const UV = await import('../src/renderer/unifiedFillVerts.js');
    const b = await importSvg(SVG);
    const cf = new Float32Array(b.curves),
      entries = [];
    for (let s = 0; s < b.numShapes; s++) {
      const r = b.curveRangesByShape[s];
      const built = buildLbShape(curveRangeToContours(cf, r.begin, r.end), false, false);
      entries.push({
        kind: 'lb',
        verts: built.pk.verts,
        vertexCount: built.pk.vertexCount,
        shapeIdx: s,
      });
    }
    const u = UV.buildUnifiedFillVerts(entries, null, null, false);
    const t0 = UV.buildCurveTexStream(u.verts, u.vertexCount, false);
    ok(
      !!t0 && t0.blocks > LIMIT,
      `default limit builds the curve-texture stream (${t0 && t0.blocks} blocks, more than the test limit ${LIMIT})`,
    );
    UV._setUcIdxLimitForTest(LIMIT);
    const t32 = UV.buildCurveTexStream(u.verts, u.vertexCount, false);
    UV._setUcIdx32LimitForTest(LIMIT);
    const t1 = UV.buildCurveTexStream(u.verts, u.vertexCount, false);
    UV._setUcIdxLimitForTest(0);
    UV._setUcIdx32LimitForTest(0);
    ok(!!t32 && t32.idx32 === true, 'a lowered 16-bit limit alone takes the 32-bit layout');
    ok(t1 === null, 'both limits lowered make the builder refuse (null) the same bundle');
  }

  // ---- 2. GPU ----
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { _setUcIdxLimitForTest, _setUcIdx32LimitForTest } from '/src/renderer/unifiedFillVerts.js';
const S = 200;
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) { const o = gl[m].bind(gl); gl[m] = (...a) => { draws++; return o(...a); }; }
const read = () => { const px = new Uint8Array(S * S * 4); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
console.log('stage: slug ref');
const rs = createRenderer(gl, shaders, { aacFill: false });
const bs = createBundle(gl, sec);
rs.setViewport(S, S); rs.beginFrame([0, 0, 0, 1]); rs.drawBundle(bs, {}); rs.endFrame();
const slug = read();

_setUcIdxLimitForTest(${LIMIT});
_setUcIdx32LimitForTest(${LIMIT});
const ru = createRenderer(gl, shaders, { aacFill: false, fillDefines: ['MANTLE_LB_FILL'] });
const bu = createBundle(gl, sec);
ru.setLoopBlinnFill('on');
try { ru.prepareBundle(bu); } catch {}
if (ru.awaitLbReady) { try { await ru.awaitLbReady(bu, 20000); } catch {} }
console.log('stage: lb ready');
let served = 0, frames = 0, last = 0;
for (; frames < 120 && !served; frames++) {
  ru.setViewport(S, S); ru.beginFrame([0, 0, 0, 1]); draws = 0; ru.drawBundle(bu, {}); last = draws; ru.endFrame();
  if (['on', 'forced'].includes((ru.debugStats || {}).unifiedFillGate) && last === 1 && bu._noCurveTex && ((((ru.debugStats || {}).engines || {}).viaRoute || {})['lb@unified'] | 0) > 0) served = 1;
  await new Promise((r) => setTimeout(r, 16));   // not rAF: a headless page does not tick it
}
const uni = read();
_setUcIdxLimitForTest(0);
_setUcIdx32LimitForTest(0);
let diff = 0, n = 0, inkS = 0, inkU = 0;
for (let i = 0; i < S * S; i++) { const o = i * 4; const a = slug[o] + slug[o + 1] + slug[o + 2], b = uni[o] + uni[o + 1] + uni[o + 2];
  if (a > 24) inkS++; if (b > 24) inkU++; if (a > 24 || b > 24) { n++; for (let k = 0; k < 3; k++) diff += Math.abs(slug[o + k] - uni[o + k]); } }
window.out = { served, frames, last, noCurveTex: !!bu._noCurveTex, overflow: (ru.debugStats || {}).uniCurveTexOverflow | 0, gate: (ru.debugStats || {}).unifiedFillGate,
  key: (ru.debugStats || {}).drawnFillVariantKey || '', lbUnified: (((ru.debugStats || {}).engines || {}).viaRoute || {})['lb@unified'] | 0, inkS, inkU, meanDiff: n ? +(diff / (n * 3)).toFixed(2) : 0 };
</script></body></html>`;
  const { browser } = host;
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text());
    else if (process.env.SMOKE_VERBOSE) console.log('  [page] ' + m.text());
  });
  page.on('pageerror', (e) => logs.push(String(e.message)));
  await page.goto(host.page(HTML), {
    waitUntil: 'load',
    timeout: 30000,
  });
  try {
    await page.waitForFunction('typeof window.out !== "undefined"', {
      timeout: 120000,
      polling: 100,
    });
  } catch {
    console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
    await page.close();
    return 1;
  }
  const r = await page.evaluate(() => window.out);
  await page.close();
  console.log(`  ${JSON.stringify(r)}`);
  if (logs.length) console.log('  console errors:\n    ' + logs.join('\n    '));
  ok(r.overflow >= 1, `the overflow was counted (${r.overflow})`);
  ok(r.noCurveTex === true, 'the bundle is marked off the curve-texture layout');
  ok(!r.key.includes('MANTLE_LB_CURVE_TEX'), 'the selected program key lacks MANTLE_LB_CURVE_TEX');
  ok(
    r.key.includes('MANTLE_LB_FILL') && r.lbUnified > 0,
    `the drawn program is the Loop-Blinn unified variant and the engine ledger shows lb@unified (${r.lbUnified})`,
  );
  ok(
    r.served === 1 && r.last === 1,
    `served in one draw on the wide layout after ${r.frames} frame(s)`,
  );
  ok(
    r.inkU > 3000 && Math.abs(r.inkU - r.inkS) / Math.max(r.inkS, 1) < 0.03,
    `ink within 3% of Slug (${r.inkU} vs ${r.inkS})`,
  );
  ok(r.meanDiff < 12, `mean channel difference vs Slug is AA-scale (${r.meanDiff})`);
  console.log(`\nunifiedFillCurveTexOverflowSmoke: ${fail ? 'FAIL' : 'PASS'}`);
  return fail;
}

const host = await openCaseHost(ROOT, {
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const failures = await runCases(host, [
  ['unifiedFillCurveTexWideIndex', unifiedFillCurveTexWideIndex],
  ['unifiedFillCurveTexIdx32Morph', unifiedFillCurveTexIdx32Morph],
  ['unifiedFillCurveTexOverflow', unifiedFillCurveTexOverflow],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nunifiedFillCurveTexWideIndexSmoke: every index layout draws like its reference');
