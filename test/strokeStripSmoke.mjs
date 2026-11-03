// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { gpuIdle, installGpuThrottle } from './_gpuThrottle.mjs';
// strokeStripSmoke -- the strip cover of a stroke row (importSvg({ strokeStrip: true })) loses no ink and never
// clips a stroke the single quad would draw.
//
// A strip is built once for the AUTHORED width of the static geometry and swapped into the unified stream only where the
// draw allows it (unifiedFillDraw stripModeFor). This draws each case with and without the strip on one renderer and holds:
//   * LOST INK: no pixel where the default's coverage exceeds the strip's by more than 0.2 (the strip may add the cap's AA tail
//     the single quad clips; it may never drop ink);
//   * a width override WIDER than authored (3x, 10x) draws the single quads: byte-identical to the default, mode 0;
//   * a path that crosses itself takes the strip only where a depth attachment makes the depth claim sound: mode 2 on a
//     context with depth, mode 1 (its crossing rows keep their quad) on one without;
//   * a geometry that has moved since the import and a renderer with opts.strokeStrip false draw the quads;
//   * the strip is actually USED (mode > 0) in the cases built for it;
//   * a row whose strip FOLDS (a bend tighter than the half-width, a cusp, a near-reversal miter) is patched, takes the
//     strip under the depth claim (mode 2) and loses no ink, opaque or translucent; without depth it keeps its quad.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="0" y="0" width="256" height="256" fill="#fff"/>${body}</svg>`;
const P = (w, d, extra = '') =>
  `<path id="p" d="${d}" fill="none" stroke="#000" stroke-width="${w}" ${extra}/>`;
const DIAG = 'M12 244 C 90 20 170 250 244 14';
const CASES = [
  {
    name: 'hairline cubic, round',
    svg: svg(P(0.25, DIAG, 'stroke-linecap="round" stroke-linejoin="round"')),
    w: 0.25,
    strip: true,
  },
  { name: 'thin line, butt', svg: svg(P(1, 'M10 240 L246 14')), w: 1, strip: true },
  {
    name: 'width 8 miter polyline, square caps',
    svg: svg(
      P(8, 'M20 220 L 90 40 L 160 220 L 230 40', 'stroke-linecap="square" stroke-linejoin="miter"'),
    ),
    w: 8,
    strip: true,
  },
  {
    name: 'dashed cubic',
    svg: svg(P(3, DIAG, 'stroke-dasharray="14 7" stroke-linecap="round"')),
    w: 3,
    strip: true,
  },
  {
    name: 'crossing polyline (self-overlap)',
    svg: svg(
      P(
        2,
        'M20 20 L 236 236 L 236 20 L 20 236 L 20 100 L 200 100',
        'stroke-linejoin="round" stroke-linecap="round"',
      ),
    ),
    w: 2,
    strip: true,
    crossing: true,
  },
  // The opaque prepass (classic fill pass only, so the 'pp' context turns the unified route off) needs >= 512 certified occupancy cells over opaque fills that overlap >= 1.35x
  // (occupancyGrid on), a flat drawList and a draw with no override table; a blob stack meets the first two, only the 'none' override meets the third.
  {
    name: 'translucent crossing over opaque fills (prepass)',
    svg: svg(
      Array.from(
        { length: 6 },
        (_, i) =>
          `<path fill="hsl(${i * 50},65%,48%)" d="M ${20 + i * 4} 128 C ${20 + i * 4} 20 ${236 - i * 4} 20 ${236 - i * 4} 128 C ${236 - i * 4} 236 ${20 + i * 4} 236 ${20 + i * 4} 128 Z"/>`,
      ).join('') +
        P(6, 'M20 20 L 236 236 L 236 20 L 20 236', 'stroke-opacity="0.5" stroke-linejoin="round"'),
    ),
    w: 6,
    strip: true,
    crossing: true,
    prepass: true,
  },
  {
    name: 'translucent crossing polyline',
    svg: svg(
      P(6, 'M20 20 L 236 236 L 236 20 L 20 236', 'stroke-opacity="0.5" stroke-linejoin="round"'),
    ),
    w: 6,
    strip: true,
    crossing: true,
  },
  // FOLDS (svg/strokeStrip.js fold patches): a bend tighter than the half-width, a cusp, a near-reversal miter join within a
  // high limit; the patched row overlaps itself by construction, so it takes the strip only under the depth claim (mode 2)
  {
    name: 'fold: tight cubic loop, round',
    svg: svg(
      P(16, 'M 20 230 C 250 10 10 10 236 230', 'stroke-linecap="round" stroke-linejoin="round"'),
    ),
    w: 16,
    strip: true,
    crossing: true,
    fold: true,
  },
  {
    name: 'fold: cubic cusp, butt',
    svg: svg(P(18, 'M 30 40 C 250 240 10 240 230 40')),
    w: 18,
    strip: true,
    crossing: true,
    fold: true,
  },
  {
    name: 'fold: near-reversal miter, limit 30',
    svg: svg(P(5, 'M 20 120 L 236 128 L 20 136', 'stroke-linejoin="miter" stroke-miterlimit="30"')),
    w: 5,
    strip: true,
    crossing: true,
    fold: true,
  },
  {
    name: 'fold: translucent tight loop, square caps',
    svg: svg(
      P(
        16,
        'M 20 230 C 250 10 10 10 236 230',
        'stroke-opacity="0.5" stroke-linecap="square" stroke-linejoin="bevel"',
      ),
    ),
    w: 16,
    strip: true,
    crossing: true,
    fold: true,
  },
  {
    name: 'fold: translucent cusp, butt',
    svg: svg(P(12, 'M 20 230 C 280 60 -20 60 236 230', 'stroke-opacity="0.5"')),
    w: 12,
    strip: true,
    crossing: true,
    fold: true,
  },
];
const OVERRIDES = [
  { name: 'none', o: null },
  { name: 'width x0.05', f: 0.05 },
  { name: 'width x1', f: 1 },
  { name: 'width x3', f: 3, wide: true },
  { name: 'width x10', f: 10, wide: true },
  {
    name: 'move + rotate + scale',
    o: { localPosition: [14, -9], localRotation: 0.4, localScale: [1.2, 0.8] },
  },
];
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c0" width="${N}" height="${N}"></canvas><canvas id="c1" width="${N}" height="${N}"></canvas><canvas id="c2" width="${N}" height="${N}"></canvas><canvas id="c3" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// the time this page spends asleep between frames, so the throttle idles for the time it worked, not for its naps
let slept = 0;
const nap = async (ms) => { const t = performance.now(); await new Promise((q) => setTimeout(q, ms)); slept += performance.now() - t; };
const mk = async (id, depth, opts = {}) => {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth, stencil: depth });
  const R = createRenderer(gl, shaders, opts); if (R.ready) await R.ready;
  return { gl, R };
};
// the geometry proofs below force the strip ('on'); the DEFAULT POLICY has its own section (__policy)
const ctxs = { depth: await mk('c0', true, { strokeStrip: 'on' }), nodepth: await mk('c1', false, { strokeStrip: 'on' }), off: null };
ctxs.pp = await mk('c2', true, { strokeStrip: 'on', opaquePrepass: true }); ctxs.pp.R.setLoopBlinnFill('off');
const draw = async (c, svgText, strip, ovr, w) => {
  const { gl, R } = c;
  const b = createBundle(gl, await importSvg(svgText, { preserveViewport: true, strokeStrip: strip, occupancyGrid: c === ctxs.pp ? { grid: 24 } : undefined }));
  let ov = null;
  if (ovr) { ov = createOverrideTable(gl, b); const o = ovr.f ? { strokeWidth: ovr.f * w } : ovr.o; for (const id of new Set(b.shapeIds || [])) if (id === 'p' || id.startsWith('p_')) ov.set(id, o); }
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const raw0 = b && b.bundle && typeof b.setT === 'function' ? b.bundle : b, b0 = b;
  // THE UNIFIED PROGRAM COMPILES ASYNCHRONOUSLY: until its key is bound the draw takes the classic route and the strip is not used
  if (R.prewarmBundle) { try { R.prewarmBundle(raw0); } catch {} }
  for (let i = 0; i < 80; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b0); R.endFrame(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } if (R.debugStats && R.debugStats.drawnFillVariantKey) break; await nap(25); }
  const pp0 = (R.debugStats && R.debugStats.opaquePrepassCount) | 0;
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, ov ? { overrides: ov } : undefined); R.endFrame(); await nap(16); }
  const pp = ((R.debugStats && R.debugStats.opaquePrepassCount) | 0) - pp0;
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const raw = b && b.bundle && typeof b.setT === 'function' ? b.bundle : b;
  const mode = raw._stripModeNow | 0, has = !!raw.stripRows;
  ov && ov.dispose && ov.dispose(); b.dispose && b.dispose();
  return { px: Array.from(px), mode, has, pp };
};
window.__pair = async (which, svgText, ovr, w, o) => {
  const c = ctxs[which];
  slept = 0;
  const a = await draw(c, svgText, false, ovr, w), s = await draw(c, svgText, true, ovr, w);
  let diff = 0, lost = 0, maxd = 0, ink = 0, maxLossByte = 0;
  for (let i = 0; i < a.px.length; i += 4) {
    const ca = (255 - a.px[i]) / (255 * o), cs = (255 - s.px[i]) / (255 * o);
    if (a.px[i] !== s.px[i]) diff++;
    maxLossByte = Math.max(maxLossByte, s.px[i] - a.px[i]);
    if (ca - cs > 0.2) lost++;
    if (Math.abs(ca - cs) > maxd) maxd = Math.abs(ca - cs);
    if (ca > 0.02) ink++;
  }
  const where = [];
  if (maxd > 0.3) for (let i = 0; i < a.px.length && where.length < 12; i += 4) {
    if (Math.abs(a.px[i] - s.px[i]) > 40) where.push([(i / 4) % ${N}, Math.floor(i / 4 / ${N}), a.px[i], s.px[i]]);
  }
  return { diff, lost, maxd, ink, maxLossByte, mode: s.mode, has: s.has, where, ppQuad: a.pp, ppStrip: s.pp, slept };
};
window.__two = async (svgA, svgB) => {
  const { gl, R } = ctxs.depth;
  const run = async (strip) => {
    const A = createBundle(gl, await importSvg(svgA, { preserveViewport: true, strokeStrip: strip }));
    const B = createBundle(gl, await importSvg(svgB, { preserveViewport: true, strokeStrip: strip }));
    for (const b of [A, B]) { if (R.prepareBundle) R.prepareBundle(b); if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} } }
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    for (let i = 0; i < 80; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(A); R.drawBundle(B); R.endFrame(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } if (R.debugStats && R.debugStats.drawnFillVariantKey) break; await new Promise((q) => setTimeout(q, 25)); }
    for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(A); R.drawBundle(B); R.endFrame(); await new Promise((q) => setTimeout(q, 16)); }
    const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const modes = [A, B].map((b) => { const raw = b && b.bundle && typeof b.setT === 'function' ? b.bundle : b; return raw._stripModeNow | 0; });
    A.dispose && A.dispose(); B.dispose && B.dispose();
    return { px: Array.from(px), modes };
  };
  const a = await run(false), s = await run(true);
  let lost = 0, ink = 0;
  for (let i = 0; i < a.px.length; i += 4) { if ((255 - a.px[i]) - (255 - s.px[i]) > 51) lost++; if (a.px[i] < 250) ink++; }
  return { lost, ink, modes: s.modes };
};
window.__guards = async (svgText) => {
  // the mode the draw used, read off the bundle (the renderer's internals are not on the public object)
  const modeOf = async (R, gl, tweak) => {
    const b = createBundle(gl, await importSvg(svgText, { preserveViewport: true, strokeStrip: true }));
    const raw = b && b.bundle && typeof b.setT === 'function' ? b.bundle : b;
    if (tweak) tweak(raw);
    if (R.prepareBundle) R.prepareBundle(b);
    if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    if (R.prewarmBundle) { try { R.prewarmBundle(raw); } catch {} }
    for (let i = 0; i < 80; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } if (R.debugStats && R.debugStats.drawnFillVariantKey) break; await new Promise((q) => setTimeout(q, 25)); }
    for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); await new Promise((q) => setTimeout(q, 16)); }
    const m = raw._stripModeNow | 0; b.dispose && b.dispose(); return m;
  };
  const { gl, R } = ctxs.depth;
  const out = { control: await modeOf(R, gl, null) };
  out.moved = await modeOf(R, gl, (raw) => { raw.coverQuadFloats = new Float32Array(raw.coverQuadFloats); });
  const R2 = createRenderer(gl, shaders, { strokeStrip: false }); if (R2.ready) await R2.ready;
  out.off = await modeOf(R2, gl, null);
  return out;
};
window.__policy = async (svgText, size, ropts, imp, pin, setter) => {
  // THE DEFAULT POLICY: a fresh renderer with the given options; the mode the draw used and what debugStats says about the policy
  const gl = document.getElementById('c3').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  const R = createRenderer(gl, shaders, ropts || {}); if (R.ready) await R.ready;
  if (pin) R.setFillEngine(pin);
  if (setter) R.setStrokeStrip(setter);
  const b = createBundle(gl, await importSvg(svgText, Object.assign({ preserveViewport: true }, imp || {})));
  const raw = b && b.bundle && typeof b.setT === 'function' ? b.bundle : b;
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(size, size); gl.viewport(0, 0, size, size);
  if (R.prewarmBundle) { try { R.prewarmBundle(raw); } catch {} }
  for (let i = 0; i < 80; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } if (R.debugStats && R.debugStats.drawnFillVariantKey) break; await new Promise((q) => setTimeout(q, 25)); }
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); await new Promise((q) => setTimeout(q, 16)); }
  const out = { mode: raw._stripModeNow | 0, rows: raw.stripRows ? raw.stripRows.filter(Boolean).length : 0, stats: R.debugStats.strokeStrip };
  b.dispose && b.dispose();
  return out;
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0,
  used = 0,
  cells = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await installGpuThrottle(page);
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES)
    for (const ov of OVERRIDES)
      for (const which of ['depth', 'nodepth']) {
        if (which === 'nodepth' && !c.crossing && ov.name !== 'none') continue;
        const o = /opacity="0.5"/.test(c.svg) ? 0.5 : 1;
        const busy = performance.now();
        const r = await page.evaluate(
          (w2, s, ovr, ww, oo) => window.__pair(w2, s, ovr, ww, oo),
          which,
          c.svg,
          ov,
          c.w,
          o,
        );
        await gpuIdle(performance.now() - busy - r.slept);
        cells++;
        const tag = `${c.name} / ${ov.name} / ${which}`;
        if (r.mode > 0) used++;
        let bad = '';
        if (c.fold && (ov.f == null || ov.f >= 1) && r.maxLossByte > 1)
          bad += ` authored-width fold loses up to ${r.maxLossByte} bytes;`;
        if (r.maxd > 0.25)
          bad += ` max coverage difference ${r.maxd.toFixed(3)} is not AA-only (first px x,y,quad,strip: ${JSON.stringify(r.where)});`;
        if (r.lost > 0) bad += ` ${r.lost} px lose more than 0.2 coverage;`;
        if (ov.wide && r.mode !== 0)
          bad += ` width override ${ov.name} drew the strip (mode ${r.mode});`;
        if (ov.wide && r.diff !== 0)
          bad += ` width override ${ov.name} differs from the default by ${r.diff} px;`;
        if (c.fold && which === 'depth' && !ov.wide && ov.name !== 'none' && r.mode !== 2)
          bad += ` a folded row should keep its strip under ${ov.name} (mode ${r.mode});`;
        if (c.crossing && ov.name === 'none') {
          if (which === 'depth' && r.mode !== 2)
            bad += ` crossing path with depth should be mode 2, was ${r.mode};`;
          if (which === 'nodepth' && r.mode !== 1 && r.mode !== 0)
            bad += ` crossing path without depth should not use the overlapping strip (mode ${r.mode});`;
        }
        if (bad) fail(tag + ':' + bad);
        else
          ok(
            `${tag}: mode ${r.mode}, lost ink 0, max |dcov| ${r.maxd.toFixed(3)}, ${r.diff} px differ of ${r.ink} ink`,
          );
      }
  {
    // THE OPAQUE PREPASS under a mode-2 strip draw: the claim clears depth, which would wipe the prepass's, so the prepass declines
    const c = CASES.find((x) => x.prepass);
    const r = await page.evaluate((s, w2) => window.__pair('pp', s, null, w2, 0.5), c.svg, c.w);
    if (!(r.ppQuad > 0))
      fail(
        `the opaque prepass did not run in the quad arm (count ${r.ppQuad}): the prepass case proves nothing`,
      );
    else if (r.mode !== 2) fail(`prepass case: the strip draw was mode ${r.mode}, not 2`);
    else if (r.ppStrip !== 0)
      fail(`the prepass ran ${r.ppStrip} time(s) under a mode-2 strip draw`);
    else if (r.maxd > 0.25 || r.lost > 0)
      fail(
        `prepass case: max |dcov| ${r.maxd.toFixed(3)}, ${r.lost} px lost (not AA-only): ${JSON.stringify(r.where)}`,
      );
    else
      ok(
        `opaque prepass ran in the quad arm (${r.ppQuad}) and not under the mode-2 strip draw; max |dcov| ${r.maxd.toFixed(3)}, ${r.diff} px differ`,
      );
  }
  if (used === 0) fail('no case drew a strip: the smoke proves nothing');
  {
    // TWO claimed bundles in ONE frame: the depth claim clears the depth buffer per draw, so the second must not be blocked by the first
    const two = await page.evaluate(
      (a, b) => window.__two(a, b),
      CASES[4].svg,
      svg(
        P(
          2,
          'M236 20 L 20 236 L 20 20 L 236 236 L 236 100 L 56 100',
          'stroke-linejoin="round" stroke-linecap="round"',
        ),
      ),
    );
    if (!(two.modes[0] > 0 && two.modes[1] > 0))
      fail('the two-bundle case did not use strips (modes ' + two.modes + '): it proves nothing');
    else if (two.lost > 0)
      fail(
        'two claimed strip bundles in one frame lose ink: ' +
          two.lost +
          ' px (modes ' +
          two.modes +
          ')',
      );
    else
      ok(
        'two claimed strip bundles in one frame lose no ink (' +
          two.ink +
          ' ink px, modes ' +
          two.modes +
          ')',
      );
  }
  {
    // Default policy: tiny-fill-ratio rows at large size take the strip, a wide-fill row keeps the quad, a small canvas keeps the quad,
    // and the options restore the quad; defaults are visible in debugStats
    const hair = CASES[0].svg,
      wide = svg(P(60, 'M30 200 L 100 60 L 226 200', 'stroke-linejoin="round"'));
    const pol = (a, size, ro, imp, pin, set) =>
      page.evaluate(
        (s, z, r, i, p, st) => window.__policy(s, z, r, i, p, st),
        a,
        size,
        ro,
        imp,
        pin,
        set,
      );
    const chk = (cond, msg) => {
      if (cond) ok('policy: ' + msg);
      else fail('policy: ' + msg.replace(/^/, 'FAILED '));
    };
    const big = await pol(hair, 1024),
      small = await pol(hair, 128),
      wideBig = await pol(wide, 1024);
    chk(
      big.rows > 0 && big.mode > 0,
      `a hairline at 1024 px takes the strip by default (mode ${big.mode}, ${big.rows} strip rows)`,
    );
    chk(
      small.rows > 0 && small.mode === 0,
      `the same hairline on a 128 px canvas keeps the quad (mode ${small.mode})`,
    );
    chk(
      wideBig.mode === 0,
      `a wide-fill row (60 wide) keeps the quad at 1024 px (mode ${wideBig.mode}, ${wideBig.rows} strip rows)`,
    );
    chk(
      big.stats && big.stats.minSavedPxPerVertex === 64 && big.stats.policy === 'auto',
      'the defaults show in debugStats.strokeStrip: ' +
        JSON.stringify(big.stats && { p: big.stats.policy, t: big.stats.minSavedPxPerVertex }),
    );
    const offR = await pol(hair, 1024, { strokeStrip: false }),
      offI = await pol(hair, 1024, null, { strokeStrip: false });
    chk(
      offR.mode === 0 && offI.mode === 0 && offI.rows === 0,
      `strokeStrip false (renderer: mode ${offR.mode}; import: ${offI.rows} rows) restores the quad`,
    );
    const pinned = await pol(hair, 1024, null, null, { route: 'none' });
    chk(pinned.mode === 0, `a pinned engine keeps the quad (mode ${pinned.mode})`);
    const onSmall = await pol(hair, 128, { strokeStrip: 'on' });
    chk(onSmall.mode > 0, `policy 'on' takes the strip at 128 px (mode ${onSmall.mode})`);
    const hi = await pol(hair, 1024, null, null, null, { minSavedPxPerVertex: 1e12 }),
      lo = await pol(hair, 128, null, null, null, { minSavedPxPerVertex: 0 });
    chk(
      hi.mode === 0 && lo.mode > 0,
      `setStrokeStrip({ minSavedPxPerVertex }) moves the threshold (1e12 at 1024: mode ${hi.mode}; 0 at 128: mode ${lo.mode})`,
    );
  }
  const g = await page.evaluate((s) => window.__guards(s), CASES[0].svg);
  if (!(g.control > 0))
    fail(
      'the control draw did not use the strip (mode ' +
        g.control +
        '): the guards below prove nothing',
    );
  if (g.moved !== 0) fail('a geometry that moved draws a strip (mode ' + g.moved + ')');
  else ok('a moved geometry draws the single quads');
  if (g.off !== 0) fail('opts.strokeStrip=false still draws a strip (mode ' + g.off + ')');
  else ok('opts.strokeStrip false draws the single quads (control mode ' + g.control + ')');
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  `\nstrokeStripSmoke: the strip loses no ink and never clips a stroke (${cells} cases, ${used} drew a strip)`,
);
