// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSplitScopesGpuSmoke -- the ordered area/seam split draws every scope of the unified stream, and its pixels are the
// combined program's.
//
// A complete cubic area paint needs the native-cubic integral, which is presence on every fragment of a combined CPatch program.
// The split draws such a paint in a program that has only the area walk and everything else in a program with none, as ordered
// runs of the one vertex stream. The scopes that draw a RANGE of that stream -- a group's children, a run between blend leaves
// and filters, a filtered shape's isolated source render, a sprite subset, a draw under overrides -- must take the same runs, and
// must be the combined draw's picture (<= 1 byte). Each scope is drawn twice on one renderer pinned to CPatch: split (the default)
// and combined (debug hook __CP_AREA_SPLIT = false). The engine ledger proves both: the split arm counts area runs and CPatch rows, the
// combined arm counts none.
//
// The PRIMITIVE scope (its own page) attributes every run of the split to the engine that actually draws it: a translucent cubic
// area paint and a translucent stroked circle that SDF recognition keeps as a primitive, at identity and under an affine map, with
// primitives on. The split draws exactly two runs -- the area-only program, then the program with no area walk that carries the
// primitive and the stroke -- and the engine ledger credits CPatch to the first run only and the SDF and the stroke to the second
// only, through the unified route, with no unused fill engine. It is the combined picture to 1 byte, and so is every frame drawn
// while its programs warm.
import path from 'path';
import { fileURLToPath } from 'url';
import { openPageSuite } from './_pageSuite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 160;
// Cubic area paints plus a stroked rectangle that requires the seam program.
const loop = (dx, dy, fill, op, extra = '') =>
  `<path fill="${fill}" fill-opacity="${op}" ${extra} d="M${20 + dx} ${50 + dy}C${20 + dx} ${dy - 10} ${100 + dx} ${dy - 10} ${100 + dx} ${50 + dy}C${100 + dx} ${80 + dy} ${70 + dx} ${85 + dy} ${60 + dx} ${70 + dy}L${54 + dx} ${100 + dy}L${46 + dx} ${100 + dy}L${40 + dx} ${70 + dy}C${30 + dx} ${85 + dy} ${20 + dx} ${80 + dy} ${20 + dx} ${50 + dy}Z"/>`;
const lens = (dx, dy, fill, op, extra = '') =>
  `<path fill="${fill}" fill-opacity="${op}" ${extra} d="M${20 + dx} ${50 + dy}C${20 + dx} ${dy} ${100 + dx} ${dy} ${100 + dx} ${50 + dy}C${100 + dx} ${90 + dy} ${20 + dx} ${90 + dy} ${20 + dx} ${50 + dy}Z"/>`;
const rect = (dx, dy, fill) =>
  `<path fill="${fill}" fill-opacity=".5" stroke="#222" stroke-opacity=".5" stroke-width="2" d="M${30 + dx} ${30 + dy}H${90 + dx}V${70 + dy}H${30 + dx}Z"/>`;
// The stroked rectangle guarantees both area and seam runs as certification improves.
const content = (dx = 0, dy = 0) =>
  lens(dx, dy, '#d433a9', 0.5) +
  loop(dx + 14, dy + 6, '#348bc4', 0.5) +
  lens(dx + 22, dy + 12, '#42c452', 0.45) +
  loop(dx + 30, dy + 4, '#e08a1e', 0.5) +
  rect(dx + 10, dy + 20, '#2b4acb');
const wrap = (body, defs = '', vb = `0 0 ${N} ${N}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${vb.split(' ')[2]}" height="${N}">${defs}${body}</svg>`;
const SCOPES = [
  { name: 'plain', svg: wrap(content()), draw: 'bundle' },
  {
    name: 'group-opacity',
    svg: wrap(
      loop(0, 0, '#888', 0.5) +
        `<g opacity=".6">${content(10, 10)}</g>` +
        lens(30, 40, '#a22', 0.5),
    ),
    draw: 'bundle',
  },
  {
    name: 'blend-leaf',
    svg: wrap(
      content() +
        loop(20, 20, '#7aa', 0.8, 'style="mix-blend-mode:multiply"') +
        lens(40, 40, '#ca3', 0.5),
    ),
    draw: 'bundle',
  },
  {
    name: 'filter',
    svg: wrap(
      lens(0, 0, '#d433a9', 0.5) +
        `<g filter="url(#f)">${loop(10, 10, '#348bc4', 0.6)}${lens(20, 20, '#42c452', 0.5)}${rect(15, 12, '#2b4acb')}</g>` +
        loop(40, 30, '#e08a1e', 0.5),
      '<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter></defs>',
    ),
    draw: 'bundle',
  },
  {
    name: 'sprite',
    svg: wrap(
      `<g id="s0">${content(0, 0)}</g><g id="s1">${content(160, 0)}</g>`,
      '',
      `0 0 ${2 * N} ${N}`,
    ),
    draw: 'sprite',
    sprite: 's1',
  },
  { name: 'overrides', svg: wrap(content()), draw: 'overrides' },
];
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// Exercise filtered child draws on every arm rather than reusing their raster.
const r = createRenderer(gl, shaders, { cpatchFill: true, aacPoints: false, groupFilterCache: false, unifiedFilterCache: false });
r.setFillEngine({ route: 'cpatch', kernel: 'slug' });
const SCOPES = ${JSON.stringify(SCOPES)};
const sleep = (ms) => new Promise((f) => setTimeout(f, ms));
const read = () => { const w = gl.canvas.width, px = new Uint8Array(w * ${N} * 4); gl.readPixels(0, 0, w, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px); };
const out = [];
for (const sc of SCOPES) {
  globalThis.__CP_AREA_SPLIT = undefined;
  const w = sc.draw === 'sprite' ? ${2 * N} : ${N};
  gl.canvas.width = w; gl.canvas.height = ${N};
  r.setViewport(w, ${N});
  const bundle = createBundle(gl, await importSvg(sc.svg, { preserveViewport: true }));
  r.prepareBundle(bundle);
  if (!await r.awaitEngine(bundle, 'cpatch', 30000)) throw Error(sc.name + ': CPatch preparation did not complete');
  const ovr = sc.draw === 'overrides' ? createOverrideTable(gl, bundle) : null;
  if (ovr) { ovr.set(1, { localPosition: [0, -14] }); ovr.set(3, { localPosition: [10, 6] }); }
  const frame = () => {
    r.beginFrame([1, 1, 1, 1]);
    if (sc.draw === 'sprite') r.drawSprite(bundle, sc.sprite, {});
    else r.drawBundle(bundle, ovr ? { overrides: ovr } : {});
    r.endFrame();
  };
  const stats = () => { const s = r.debugStats; return { split: s.cpatchAreaSplitDraws | 0, area: s.cpatchAreaSplitAreaDraws | 0, uni: s.unifiedFillDraws | 0, eng: s.engines ? JSON.parse(JSON.stringify(s.engines)) : null, gate: s.unifiedFillGate }; };
  // SPLIT arm (the default): warm until both run variants are ready and a frame draws split runs.
  globalThis.__CP_AREA_SPLIT = undefined;
  const warming = await r.warmScene([{name:sc.name, bundle, engine:'cpatch', draw:frame}], {maxPasses:12, readyTimeoutMs:30000});
  if (!warming.complete) throw Error(sc.name + ': scene warming incomplete ' + JSON.stringify(warming));
  let a0 = stats(), warm = 0, a1;
  for (; warm < 200; warm++) {
    frame(); r.precompileFills && r.precompileFills(); gl.finish();
    a1 = stats(); if (a1.split > a0.split) { a0 = a1; frame(); gl.finish(); a1 = stats(); break; }
    a0 = a1; await sleep(30);
  }
  const split = read(), splitD = { split: a1.split - a0.split, area: a1.area - a0.area, uni: a1.uni - a0.uni, gate: a1.gate };
  // COMBINED arm.
  globalThis.__CP_AREA_SPLIT = false;
  frame(); gl.finish();
  const b0 = stats(); frame(); gl.finish(); const b1 = stats();
  const comb = read(), combD = { split: b1.split - b0.split, area: b1.area - b0.area, uni: b1.uni - b0.uni, gate: b1.gate };
  let maxd = 0, ink = 0, nd = 0;
  for (let i = 0; i < split.length; i++) { const d = Math.abs(split[i] - comb[i]); if (d > maxd) maxd = d; if (d > 1) nd++; if (i % 4 === 0 && (split[i] !== 255 || split[i + 1] !== 255 || split[i + 2] !== 255)) ink++; }
  out.push({ name: sc.name, warm, splitD, combD, maxd, nd, ink, engSplit: a1.eng && a1.eng.cpatch, engComb: b1.eng && b1.eng.cpatch, engines: b1.eng });
}
window.__out = out; window.__ready = true;
</script></body></html>`;
// The primitive scope: what the engine ledger credits to each run, on a renderer set up as the analytic-area probe sets one up
// (warming when idle, CPatch with primitives on, the instanced fast path off). A draw-call hook records each draw's program defines.
function primitiveScopePage() {
  const PRIM_SIZE = 128;
  const PRIM_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#d433a9" fill-opacity=".4" d="M10 70C10 10 70 10 70 70L70 85L10 85Z"/><circle cx="65" cy="55" r="25" fill="#348bc4" fill-opacity=".5" stroke="#42c452" stroke-opacity=".35" stroke-width="2"/></svg>';
  const PRIM_CASES = [
    { name: 'primitive-identity', drawOptions: {} },
    {
      name: 'primitive-affine',
      drawOptions: { worldMatrix: [0.8, 0.15, 0, -0.1, 0.75, 0, 0.05, -0.03, 1] },
    },
  ];
  return `<!DOCTYPE html><html><body><canvas id="c" width="${PRIM_SIZE}" height="${PRIM_SIZE}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_INSTANCED_FAST = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const SIZE = ${PRIM_SIZE}, SVG = ${JSON.stringify(PRIM_SVG)}, CASES = ${JSON.stringify(PRIM_CASES)};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const device = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
// Each program's MANTLE_* defines, and which programs are fills (a fragment shader that reads uCurveData, or the AAC point vertex shader).
const defsOf = (src) => [...String(src).matchAll(/^\\s*#define\\s+(MANTLE_\\w+)/gm)].map((x) => x[1]);
const shaderDefs = new WeakMap(), programDefs = new WeakMap(), fillShaders = new WeakSet(), fillPrograms = new WeakSet();
const ss = gl.shaderSource.bind(gl), at = gl.attachShader.bind(gl);
gl.shaderSource = (sh, src) => {
  shaderDefs.set(sh, defsOf(src));
  if ((gl.getShaderParameter(sh, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER && src.includes('uniform sampler2D uCurveData;')) ||
      (gl.getShaderParameter(sh, gl.SHADER_TYPE) === gl.VERTEX_SHADER && defsOf(src).includes('MANTLE_AAC') &&
       /uniform\\s+sampler2D\\s+uCurveData\\s*;/.test(src) && src.includes('gl_PointSize')))
    fillShaders.add(sh);
  ss(sh, src);
};
gl.attachShader = (pr, sh) => {
  if (fillShaders.has(sh)) fillPrograms.add(pr);
  programDefs.set(pr, [...new Set([...(programDefs.get(pr) || []), ...(shaderDefs.get(sh) || [])])]);
  at(pr, sh);
};
// While a tally is open, every draw is counted under the engine its program is (a non-fill program is auxiliary) and listed with its defines.
let tally = null;
for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const f = gl[name].bind(gl);
  gl[name] = (...args) => {
    if (tally) {
      const pr = gl.getParameter(gl.CURRENT_PROGRAM), d = programDefs.get(pr) || [];
      const key = !fillPrograms.has(pr) ? 'auxiliary' : d.includes('MANTLE_CPATCH') ? 'cpatch' : d.includes('MANTLE_AAC') ? 'aac' : d.includes('MANTLE_LB_FILL') ? 'lb' : 'slug';
      tally.drawCalls.push({ method: name, defines: d });
      tally[key] = (tally[key] || 0) + 1;
      tally.defines = [...new Set([...(tally.defines || []), ...d])];
    }
    return f(...args);
  };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href));
const r = createRenderer(gl, shaders, { psoWarmIdle: () => true, cpatchFill: true, aacPoints: false });
r.setViewport(SIZE, SIZE);
const select = (split) => {
  globalThis.__CP_AREA_SPLIT = split;
  r.setFillEngine({ route: 'cpatch', commit: false, primitives: 'on', kernel: 'slug' });
};
const draw = (b, c, split) => { select(split); gl.disable(gl.SCISSOR_TEST); r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, c.drawOptions); r.endFrame(); };
const frame = (b, c, split) => { draw(b, c, split); gl.finish(); };
const read = () => { const px = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const maxDelta = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
// One frame under an open tally, plus the draws and route counts that frame added to the engine ledger.
const pin = (b, c, split) => {
  const before = r.debugStats.engines, draws0 = { ...before.draws }, route0 = { ...before.viaRoute };
  tally = { drawCalls: [] };
  draw(b, c, split);
  const p = tally;
  tally = null;
  p.ledger = {};
  for (const [k, n] of Object.entries(r.debugStats.engines.draws)) { const d = n - (draws0[k] || 0); if (d) p.ledger[k] = d; }
  p.routeLedger = {};
  for (const [k, n] of Object.entries(r.debugStats.engines.viaRoute)) { const d = n - (route0[k] || 0); if (d) p.routeLedger[k] = d; }
  return p;
};
const META = new Set(['defines', 'ledger', 'auxiliary', 'routeLedger', 'drawCalls']);
const fillsOf = (p) => Object.keys(p).filter((x) => !META.has(x));
const out = [];
for (const c of CASES) {
  select(false); // the build reads the engine policy: primitives on keeps the circle recognized
  const b = createBundle(gl, await importSvg(SVG, { preserveViewport: true, analyticArea: false, normalizeFill: true }));
  b.globalBBox = [0, 0, 100, 100];
  const arms = {};
  // The combined arm first, on the same bundle, so the split arm's warming frames are the first frames of its programs.
  for (const [name, split] of [['combined', false], ['split', true]]) {
    select(split);
    r.prepareBundle(b);
    const t0 = performance.now();
    const ready = await r.awaitEngine(b, 'cpatch', 15000);
    const t1 = performance.now();
    let pinned, w = 0;
    const warming = [];
    for (; w < 24; w++) {
      frame(b, c, split);
      if (split) warming.push(read());
      r.precompileFills();
      pinned = pin(b, c, split);
      gl.finish();
      const fills = fillsOf(pinned), defs = pinned.defines || [];
      if (fills.length === 1 && fills[0] === 'cpatch' && defs.includes('MANTLE_LB_FILL') &&
          (!split || (defs.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY') && defs.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'))) && w >= 3)
        break;
    }
    for (let w = 0; w < 3; w++) frame(b, c, split);
    frame(b, c, split);
    const px = read();
    let ink = 0;
    for (let i = 3; i < px.length; i += 4) ink += px[i];
    arms[name] = { ready, pin: pinned, fills: fillsOf(pinned), px, ink, warming: warming.map((wp) => maxDelta(wp, px)),
      prepareMs: Math.round(t1 - t0), warmFrames: w + 1, warmMs: Math.round(performance.now() - t1) };
  }
  const maxByte = maxDelta(arms.split.px, arms.combined.px);
  delete arms.split.px;
  delete arms.combined.px;
  out.push({ name: c.name, ...arms, maxByte, glError: gl.getError() });
  b.dispose();
}
window.__prim = { device, out };
window.__ready = true;
</script></body></html>`;
}

const suite = await openPageSuite({ root: ROOT });
let out, prim;
try {
  const page = await suite.page({ logs: false });
  page.on('pageerror', (e) => console.error('[page-err]', e.message));
  const tScopes = Date.now();
  await suite.goto(page, HTML, { name: 'cpatchSplitScopesGpuSmoke scopes' });
  out = await page.evaluate(() => window.__out);
  await page.close();
  console.log(`scopes page: ${((Date.now() - tScopes) / 1000).toFixed(1)} s`);
  const primPage = await suite.page({ logs: false });
  primPage.on('pageerror', (e) => console.error('[page-err]', e.message));
  await suite.goto(primPage, primitiveScopePage(), {
    name: 'cpatchSplitScopesGpuSmoke primitive scope',
  });
  prim = await primPage.evaluate(() => window.__prim);
  await primPage.close();
  console.log(
    `primitive scope page: ${((Date.now() - tScopes) / 1000).toFixed(1)} s since the scopes page began`,
  );
} finally {
  await suite.close();
}
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const o of out) {
  console.log(
    `${o.name}: split ${JSON.stringify(o.splitD)} combined ${JSON.stringify(o.combD)} maxDiff ${o.maxd} (${o.nd} px > 1), ink ${o.ink}, warm ${o.warm}`,
  );
  ok(o.ink > 500, `${o.name}: it painted (${o.ink} px)`);
  ok(
    o.splitD.area >= 1 && o.splitD.split >= 2,
    `${o.name}: the split arm drew ordered runs (${o.splitD.split} runs, ${o.splitD.area} area) through the unified route`,
  );
  ok(
    o.combD.split === 0 && o.combD.uni >= 1,
    `${o.name}: the combined arm drew the unified route with no split runs`,
  );
  ok(o.maxd <= 1, `${o.name}: split is the combined picture to 1 byte (max ${o.maxd})`);
}
// The primitive scope. Both arms must reach their programs (CPatch only, through the unified stream) and paint; the split arm's
// pinned frame is the attribution under test.
ok(
  !/software|swiftshader|llvmpipe/i.test(prim.device),
  `primitive scope: physical GPU (${prim.device})`,
);
ok(prim.out.length === 2, `primitive scope: ${prim.out.length} of 2 maps drawn`);
for (const o of prim.out) {
  const pin = o.split.pin,
    calls = pin.drawCalls;
  console.log(
    `${o.name}: maxByte ${o.maxByte}; combined ${JSON.stringify(o.combined.pin.ledger)}; split runs ${JSON.stringify(calls.map((d) => d.defines.filter((x) => /CPATCH_(QUADRATIC_AREA_ONLY|NO_QUADRATIC_AREA)$/.test(x))))} ledger ${JSON.stringify(pin.ledger)} routes ${JSON.stringify(pin.routeLedger)}; warming frames ${JSON.stringify(o.split.warming)}; prepare/warm ms ${[o.combined, o.split].map((x) => `${x.prepareMs}/${x.warmMs} (${x.warmFrames} frames)`).join(', ')}`,
  );
  ok(o.glError === 0, `${o.name}: no GL error (${o.glError})`);
  for (const [arm, a] of [
    ['combined', o.combined],
    ['split', o.split],
  ]) {
    ok(a.ready, `${o.name}, ${arm}: CPatch preparation completed`);
    ok(
      a.fills.length === 1 && a.fills[0] === 'cpatch',
      `${o.name}, ${arm}: every fill draw is a CPatch program (${a.fills.join(', ')})`,
    );
    ok(
      (a.pin.defines || []).includes('MANTLE_LB_FILL'),
      `${o.name}, ${arm}: it draws the unified stream`,
    );
    ok(a.pin.ledger.cpatch > 0, `${o.name}, ${arm}: the engine ledger credits CPatch`);
    ok(a.ink > 0, `${o.name}, ${arm}: it painted (alpha sum ${a.ink})`);
  }
  ok(o.maxByte <= 1, `${o.name}: ordered primitive output parity (max ${o.maxByte})`);
  ok(
    (pin.defines || []).includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY') &&
      (pin.defines || []).includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'),
    `${o.name}: both split programs drew`,
  );
  ok(
    calls.length === 2,
    `${o.name}: actual area and primitive/stroke runs (${calls.length} draw calls)`,
  );
  ok(
    calls.length === 2 &&
      calls[0].defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY') &&
      calls[1].defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'),
    `${o.name}: the area-only run draws first, then the run with no area walk`,
  );
  ok(
    pin.ledger.cpatch === 1,
    `${o.name}: only the area run contains CPatch (${pin.ledger.cpatch})`,
  );
  ok(pin.ledger.sdf === 1, `${o.name}: only the second run contains SDF (${pin.ledger.sdf})`);
  ok(
    pin.ledger.stroke === 1,
    `${o.name}: only the second run contains stroke (${pin.ledger.stroke})`,
  );
  ok(
    !pin.ledger.lb && !pin.ledger.slug && !pin.ledger.aac,
    `${o.name}: no unused fill engine credited (${JSON.stringify(pin.ledger)})`,
  );
  ok(
    pin.routeLedger['cpatch@unified'] === 1 && pin.routeLedger['sdf@unified'] === 1,
    `${o.name}: one CPatch and one SDF draw through the unified route (${JSON.stringify(pin.routeLedger)})`,
  );
  ok(
    o.split.warming.length > 0 && o.split.warming.every((d) => d <= 1),
    `${o.name}: first warming frames preserve translucent primitive output (max ${Math.max(...o.split.warming)})`,
  );
}
console.log(
  fail ? `\ncpatchSplitScopesGpuSmoke FAIL (${fail})` : '\ncpatchSplitScopesGpuSmoke PASS',
);
process.exit(fail ? 1 : 0);
