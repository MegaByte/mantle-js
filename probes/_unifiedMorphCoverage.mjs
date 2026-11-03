// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _unifiedMorphCoverage.mjs — what does a MORPH cost today, and where does it
// still hit a coverage render target?
//
// The static route is the unified draw (one drawArrays, zero coverage RTs).
// Morphs are the remaining consumer of _renderPairCovRT / _renderSplitStrokeCovRT
// / _drawComposedMorphShape. This measures
// the baseline per feature at several t: GL draws, composed-RT draws, whether the
// unified route was entered at all, and the delta against the Slug morph.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

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
  // emCoord DISCRIMINATOR. The in-shader clip evaluates renderFill() at
  // transformClipCoord(emCoord, ...), so a wrong emCoord breaks the clip while the LB
  // fill still looks right (LB coverage uses klmn/texcoords, not emCoord). Gradient
  // paint reads emCoord too, through a completely different feature block — so if the
  // gradient morph ALSO breaks under the curve texture the fault is emCoord, and if it
  // is clean the fault is clip-specific.
  gradient: [
    svg(
      A,
      'fill="url(#g)"',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#3060c0"/>' +
        '<stop offset="1" stop-color="#c04030"/></linearGradient></defs>',
    ),
    svg(
      B,
      'fill="url(#g)"',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#3060c0"/>' +
        '<stop offset="1" stop-color="#c04030"/></linearGradient></defs>',
    ),
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
  const FORCE_COMPOSED = ${JSON.stringify(!!process.env.LB_NO_UNIFIED_MORPH)};
  // The morph stream has its own B-half curve index (aCurveIdxB at location 10), so the
  // curve-texture layout needs checking
  // on this path separately from the static one.
  const CURVE_TEX = ${JSON.stringify(!!process.env.LB_CURVE_TEX)};
  const r = createRenderer(gl, shaders,
    { aacFill: false, unifiedMorph: mode !== 'slug' && !FORCE_COMPOSED,
      unifiedFillCurveTex: CURVE_TEX && mode !== 'slug',
      unifiedFillCurveTexNoGuard: ${JSON.stringify(!!process.env.LB_CURVE_TEX_NOGUARD)},
      unifiedFillKeepVerts: ${JSON.stringify(!!process.env.LB_KEEP_VERTS)} });
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
  // explicit drain is the only thing that warms it here.
  for (let i = 0; i < 30; i++) {
    frame(0);
    if (r.precompileFills) { try { r.precompileFills(); } catch {} }
    if ((r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) break;
    await new Promise((res) => requestAnimationFrame(res));
  }
  const shots = [];
  for (const t of ts) {
    const st0 = r.debugStats || {};
    const uni0 = st0.unifiedFillDraws | 0, rt0 = (st0.composedFillFromRT | 0) + (st0.composedStrokeFromRT | 0);
    draws = 0; frame(t);
    const st = r.debugStats || {};
    // Read the narrow stream straight off the cache: UC_CURVEIDX is float 13 and
    // UC_CURVEIDX_B is float 19 of a 20-float morph vertex. If those are EQUAL for
    // every vertex then mix(A,B,uMorphT) is the identity and no uMorphT can move the
    // shape — which is exactly what identical frames at different t would mean.
    let abDiff = -1, nv = 0, seg = -1;
    const mb = morph._unifiedFill ? morph : (morph.bundle || morph);
    const uf = mb._unifiedFill;
    if (uf) {
      seg = uf.seg === undefined ? -1 : uf.seg;
      nv = uf.vertexCount | 0;
      if (uf.verts && uf.morph) {
        abDiff = 0;
        for (let v = 0; v < nv; v++) {
          if (uf.verts[v * 20 + 13] !== uf.verts[v * 20 + 19]) abDiff++;
        }
      }
    }
    const glErr = gl.getError();
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0;
    for (let q = 0; q < S * S; q++) { const o = q * 4;
      if (px[o] > 8 || px[o+1] > 8 || px[o+2] > 8) ink++; }
    shots.push({ t, px, draws, ink,
                 uni: (st.unifiedFillDraws | 0) - uni0,
                 rt: ((st.composedFillFromRT | 0) + (st.composedStrokeFromRT | 0)) - rt0,
                 gate: st.unifiedFillGate || '?',
                 bail: st.unifiedCurveTexBail | 0,
                 lost: st.unifiedCoefLost | 0,
                 mt: st.unifiedMorphTLast,
                 abDiff, nv, seg,
                 glErr,
                 ink,
                 usedCover: st.unifiedUsedCover,
                 skipUp: !!(morph._morphSrc && morph._morphSrc.skipUploads),
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
  // vsT0 splits the failure space: if a broken t>0 frame is IDENTICAL to its own t=0
  // frame the morph is frozen (the B endpoint is not reaching the shader), whereas a
  // large vsT0 means the geometry did move and something else (the clip) is wrong.
  out[name] = lb.map((s, i) => ({ t: s.t, draws: s.draws, rt: s.rt, uni: s.uni, gate: s.gate, bail: s.bail, key: s.key,
                                  slugDraws: slug[i].draws, vsSlug: vs(slug[i].px, s.px), lost: s.lost, mt: s.mt, abDiff: s.abDiff, nv: s.nv, seg: s.seg, glErr: s.glErr, ink: s.ink, slugInk: slug[i].ink, usedCover: s.usedCover, skipUp: s.skipUp,
                                  vsT0: vs(lb[0].px, s.px), vsSlugT0: vs(slug[0].px, slug[i].px),
                                  // vsPrev: is this frame LITERALLY the previous t's frame?
                                  vsPrev: i ? vs(lb[i-1].px, s.px) : { n: 0, worst: 0 } }));
}
window.limits = { frag: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
                  vert: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
                  comb: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) };
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
console.log('  sampler limits: ' + JSON.stringify(await page.evaluate(() => window.limits)));
await browser.close();
server.close();

console.log(
  'feature       t     draws slug/lb  composedRT  unified  gate            vs Slug morph',
);
for (const [k, rows] of Object.entries(r)) {
  for (const s of rows) {
    console.log(
      `${k.padEnd(13)} ${String(s.t).padEnd(5)} ${String(s.slugDraws).padStart(5)}/` +
        `${String(s.draws).padEnd(5)} ${String(s.rt).padStart(10)} ${String(s.uni).padStart(8)}` +
        `  ${String(s.gate).padEnd(15)} ${String(s.vsSlug.n).padStart(6)}px w${String(s.vsSlug.worst).padStart(4)}` +
        `  vsT0 ${String(s.vsT0.n).padStart(6)}px (slug moved ${String(s.vsSlugT0.n).padStart(6)}px)` +
        `  vsPrev ${String(s.vsPrev.n).padStart(6)}px uMorphT=${String(s.mt).slice(0, 6)} seg=${s.seg} nv=${s.nv} ink=${s.ink}/slug${s.slugInk} cover=${s.usedCover} skipUp=${s.skipUp} key=${String(
          s.key,
        )
          .replace(/MANTLE_/g, '')
          .slice(0, 72)}` +
        (s.t === 0 ? `\n    variant: ${s.key}` : ''),
    );
  }
}
