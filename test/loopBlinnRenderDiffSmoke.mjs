// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// loopBlinnRenderDiffSmoke — the Loop-Blinn (analytic) fill route against the Slug fill,
// feature by feature. Every case draws its fixture with LB on and off, checks the route counter
// and checks the pixels against Slug:
//   loopBlinnRenderDiff    blob, evenodd donut, triangle, drawBundle route, arcs, streamed refresh
//   lbBlendParity          a blended shape falls back to Slug per shape, the rest stays analytic
//   lbFilterParity         an inline feColorMatrix runs over the LB fill (composed path)
//   lbTextParity           glyph contours from per-shape curve ranges; 'auto' keeps text off LB
//   lbStrokeParity         a filled and stroked shape: fill interior and stroke band
//   lbRecolorParity        a per-draw colorMatrix composes over the LB fill
//   lbMaskParity           a luminance mask runs over the LB fill (composed path)
//   lbClipParity           a clip union runs over the LB fill (composed path)
//   lbTransformOverride... a per-shape transform override falls back to Slug for that shape
//   lbImageBatch           <image> shapes ride the batched route with their own rect and atlas slot
//   lbGradientParity       gradient fills, not just solid
//   lbGradientBatch        many different gradients ride the one-draw batched route
//   lbComposeOrder         the combined route resets uGradId/uImageId after a gradient draw
//   lbPerShapeFallback...  an unservable shape falls back to Slug per shape, in painter order
//   lbLoopParity           a self-intersecting cubic falls back to Slug, nonzero and evenodd
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { fontFixture, optionalAsset } from './_assets.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// loopBlinnRenderDiff — proves the integrated additive Loop-Blinn fill
// path (the unified analytic fill, selected with setFillEngine({route:'lb'})) renders the same
// solid shape as the Slug per-fragment ray-cast, to within AA-quantization on the 1-pixel
// silhouette rim.
//
//   A = Slug fill (drawBundle) of an SVG built from control points P
//   B = the same SVG drawn with the LB route selected
//   assert: both ink the same interior (inside/outside agree except a thin
//   AA rim), bounded mean/maxdiff. Two cases: a convex cubic blob (no hole)
//   and an evenodd donut (cubic outer + cubic hole — exercises hole bridging).
async function loopBlinnRenderDiff(host) {
  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
// Engine internals, imported from the module that owns them. They are deliberately NOT on the
// public surface: Loop-Blinn is chosen with setFillEngine({route:'lb'}), and a mesh builder that
// only tests call has no business in the barrel.
import { buildLoopBlinnMesh, refreshLoopBlinnMesh, packLoopBlinnMesh } from '/src/renderer/loopBlinn.js';
import { mkCubic, mkLine } from '/src/primitives/seg.js';
const W = 256, H = 256;
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(W, H);
const BBOX = [0, 0, 200, 200];
const COLOR = [0.196, 0.588, 0.784, 1.0];   // #3296c8

// One circle as 4 cubic quarter-arcs (kappa). Returns { segs, d } from the
// SAME control points so the Slug SVG and the LB mesh are geometrically
// identical. dir=+1 CCW(em y-down), -1 reversed (for the evenodd hole).
const K = 0.5522847498307936;
function circle(cx, cy, r, dir) {
  let pts = [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
  let ctrl = [
    [[cx + r, cy + r*K], [cx + r*K, cy + r]],
    [[cx - r*K, cy + r], [cx - r, cy + r*K]],
    [[cx - r, cy - r*K], [cx - r*K, cy - r]],
    [[cx + r*K, cy - r], [cx + r, cy - r*K]],
  ];
  if (dir < 0) { pts = [pts[0], pts[3], pts[2], pts[1]]; ctrl = ctrl.map(c => [c[1], c[0]]).reverse(); }
  const segs = [], dParts = ['M ' + pts[0][0] + ' ' + pts[0][1]];
  for (let i = 0; i < 4; i++) {
    const p0 = pts[i], p3 = pts[(i + 1) % 4], c1 = ctrl[i][0], c2 = ctrl[i][1];
    segs.push(mkCubic(p0, c1, c2, p3));
    dParts.push('C ' + c1[0] + ' ' + c1[1] + ' ' + c2[0] + ' ' + c2[1] + ' ' + p3[0] + ' ' + p3[1]);
  }
  dParts.push('Z');
  return { segs, d: dParts.join(' ') };
}

function svgFor(paths, evenodd) {
  const d = paths.map(p => p.d).join(' ');
  const fr = evenodd ? ' fill-rule="evenodd"' : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
    + '<path d="' + d + '" fill="#3296c8"' + fr + '/></svg>';
}

function clear() { gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); }
function readback() { const b = new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b); return b; }

let _lastBBox = BBOX;
async function renderSlug(svg) {
  const sec = await importSvg(svg);
  const bundle = createBundle(gl, sec); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
  // drawBundle projects with bundle.globalBBox (the CONTENT bbox, not the
  // viewBox). LB must use the SAME frame for an apples-to-apples diff.
  _lastBBox = Array.from(bundle.globalBBox);
  clear();
  // Ground TRUTH is the Slug ray-cast — force it off. LB fill defaults to
  // 'auto', so a bare drawBundle would otherwise route the reference through LB.
  renderer.setLoopBlinnFill(false);
  renderer.drawBundle(bundle);
  const buf = readback();
  bundle.dispose();
  return buf;
}
// THROUGH THE SETTING, not a direct call. renderer.drawLoopBlinnMesh() is gone: the engine is
// selected with setFillEngine({route}) and the renderer decides how to draw, which is the only way
// a caller can reach Loop-Blinn. The mesh is built here — buildLoopBlinnMesh is a
// public DATA helper — but only to report what the geometry contains (fallbacks, triangle and
// curve counts), which is what the assertions below read.
async function renderLB(svg, contours) {
  const mesh = buildLoopBlinnMesh(contours);
  const sec = await importSvg(svg);
  const bundle = createBundle(gl, sec); renderer.prepareBundle(bundle);
  renderer.setFillEngine({ route: 'lb' });
  await renderer.awaitEngine(bundle, 'lb', 30000);
  clear();
  const before = renderer.debugStats.unifiedFillDraws | 0;
  renderer.drawBundle(bundle);
  const drew = ((renderer.debugStats.unifiedFillDraws | 0) - before) > 0;
  const buf = readback();
  bundle.dispose();
  return { buf, drew, fallback: mesh.fallback.length,
           tris: mesh.interior.length/2, cubics: mesh.cubics.length, quads: mesh.quads.length };
}

// "inked" = not (near-)white background. Compare inside/outside agreement.
function diff(A, B) {
  let inkA = 0, inkB = 0, xor = 0, both = 0, sum = 0, maxd = 0;
  for (let p = 0; p < W*H; p++) {
    const i = p*4;
    const a = A[i] < 240 || A[i+1] < 240 || A[i+2] < 240;
    const b = B[i] < 240 || B[i+1] < 240 || B[i+2] < 240;
    if (a) inkA++; if (b) inkB++;
    if (a !== b) xor++;
    if (a && b) {
      both++;
      for (let k = 0; k < 3; k++) { const d = Math.abs(A[i+k] - B[i+k]); sum += d; if (d > maxd) maxd = d; }
    }
  }
  return { inkA, inkB, xor, both, meanInterior: both ? sum/(both*3) : 0, maxInterior: maxd };
}

const result = { cases: [] };
try {
  // Case 1: convex cubic blob (single contour, no hole).
  {
    const c = circle(100, 100, 80, 1);
    const SV = svgFor([c], false);
    const A = await renderSlug(SV);
    const B = await renderLB(SV, [c.segs]);
    result.cases.push({ name: 'cubic-blob', ...diff(A, B.buf), drew: B.drew, fallback: B.fallback, cubics: B.cubics, tris: B.tris });
  }
  // Case 2: evenodd donut (cubic outer + cubic hole).
  {
    const outer = circle(100, 100, 85, 1);
    const inner = circle(100, 100, 42, -1);
    const SV = svgFor([outer, inner], true);
    const A = await renderSlug(SV);
    const B = await renderLB(SV, [outer.segs, inner.segs]);
    // Edge transitions along the center scanline y=128 (white↔ink crossings).
    const scan = buf => { const y = 128, out = []; let prev = false; for (let x = 0; x < W; x++) { const i = (y*W+x)*4; const ink = buf[i] < 240 || buf[i+1] < 240 || buf[i+2] < 240; if (ink !== prev) out.push(x); prev = ink; } return out; };
    result.scan = { A: scan(A), B: scan(B.buf) };
    result.cases.push({ name: 'donut', ...diff(A, B.buf), drew: B.drew, fallback: B.fallback, cubics: B.cubics, tris: B.tris });
  }
  // Case 3: straight-edged polygon (triangle — no curves, hard silhouette).
  // Measures how far hard LB edges sit from Slug's antialiased edges.
  {
    const P = [[40, 40], [165, 80], [80, 170]];
    const segs = [mkLine(P[0], P[1]), mkLine(P[1], P[2]), mkLine(P[2], P[0])];
    const d = 'M ' + P[0][0] + ' ' + P[0][1] + ' L ' + P[1][0] + ' ' + P[1][1] + ' L ' + P[2][0] + ' ' + P[2][1] + ' Z';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="' + d + '" fill="#3296c8"/></svg>';
    const A = await renderSlug(svg);
    const B = await renderLB(svg, [segs]);
    result.cases.push({ name: 'triangle', ...diff(A, B.buf), drew: B.drew, fallback: B.fallback, cubics: B.cubics, tris: B.tris });
  }
  // Case 4: drawBundle ROUTE — same multi-shape SVG through the Slug path
  // (setLoopBlinnFill off) vs the routed Loop-Blinn path (on). Exercises the
  // per-shape eligibility gate + curve-buffer→mesh decode + painter order.
  {
    // All <path> (no <circle>/<rect> — those import as closed-form primKind,
    // which the route intentionally leaves on Slug). Curves + straight edges.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + '<path d="M30 100 C30 40 90 30 120 55 C160 85 150 160 100 175 C55 188 30 150 30 100 Z" fill="#c83232"/>'
      + '<path d="M120 30 L175 45 L160 110 L110 80 Z" fill="#3296c8"/></svg>';
    const sec = await importSvg(svg);
    const renderRoute = async (lb) => {
      renderer.setLoopBlinnFill(lb);
      const bundle = createBundle(gl, sec); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
      const before = renderer.debugStats.loopBlinnRouteCount;
      clear();
      renderer.drawBundle(bundle);
      const buf = readback();
      const routed = renderer.debugStats.loopBlinnRouteCount > before;
      bundle.dispose();
      return { buf, routed };
    };
    const A = await renderRoute(false);
    const B = await renderRoute(true);
    renderer.setLoopBlinnFill(false);
    result.cases.push({ name: 'drawBundle-route', ...diff(A.buf, B.buf), drew: B.routed, fallback: 0, cubics: 0, tris: 0, routed: B.routed });
  }
  // Case 4b: a path with ARC commands routes through LB (arcs → cubics in the
  // decode), matching Slug (which renders arcs exactly) within the cubic-arc
  // approximation (sub-pixel for fills).
  {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + '<path d="M40 100 A60 60 0 0 1 160 100 A60 60 0 0 1 40 100 Z" fill="#3296c8"/></svg>';
    const sec = await importSvg(svg);
    const r = async (lb) => {
      renderer.setLoopBlinnFill(lb);
      const bundle = createBundle(gl, sec); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
      const before = renderer.debugStats.loopBlinnRouteCount; clear(); renderer.drawBundle(bundle);
      const buf = readback(); const routed = renderer.debugStats.loopBlinnRouteCount > before;
      bundle.dispose(); return { buf, routed };
    };
    const A = await r(false); const B = await r(true); renderer.setLoopBlinnFill(false);
    result.cases.push({ name: 'arc-route', ...diff(A.buf, B.buf), drew: B.routed, fallback: 0, cubics: 0, tris: 0, routed: B.routed });
  }
  // Case 5: streaming refresh — build a mesh at one shape, refresh it to a
  // DEFORMED shape (same topology, new coords), and prove the refreshed mesh
  // renders identically to a fresh build of the deformed shape (refresh reuses
  // the cached earcut topology; build re-triangulates). build is already
  // validated vs Slug, so refresh==build (rendered) transitively validates it.
  {
    const base = circle(100, 100, 80, 1);
    const squash = s => mkCubic(
      [s.p1[0], 100 + (s.p1[1] - 100) * 0.55], [s.p2[0], 100 + (s.p2[1] - 100) * 0.55],
      [s.p3[0], 100 + (s.p3[1] - 100) * 0.55], [s.p4[0], 100 + (s.p4[1] - 100) * 0.55]);
    const deformed = base.segs.map(squash);
    _lastBBox = BBOX;
    const mesh0 = buildLoopBlinnMesh([base.segs]);
    const meshR = refreshLoopBlinnMesh(mesh0, [deformed]);   // streamed
    const meshB = buildLoopBlinnMesh([deformed]);            // fresh build
    // COMPARED AS GEOMETRY, not as pixels. This case asks "does the streamed refresh produce the
    // same mesh as a fresh build". There is no direct Loop-Blinn draw call (Loop-Blinn is selected
    // with setFillEngine, and the renderer decides how to draw), so it compares the PACKED VERTICES.
    // That is what the question is about, and it is strictly stronger than pixels: two meshes that
    // pack to the same floats cannot rasterize differently, while two that differ slightly might
    // still land on the same pixels and pass.
    const pB = packLoopBlinnMesh(meshB), pR = packLoopBlinnMesh(meshR);
    const nB = pB.vertexCount | 0, nR = pR.vertexCount | 0;
    let nd = 0, sum = 0, mx = 0;
    const n = Math.min(pB.verts.length, pR.verts.length);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(pB.verts[i] - pR.verts[i]);
      if (d > 1e-5) nd++;
      sum += d; if (d > mx) mx = d;
    }
    result.cases.push({ name: 'refresh-vs-build', inkA: nB, inkB: nR,
      xor: nd + Math.abs(pB.verts.length - pR.verts.length), both: n || 1,
      meanInterior: n ? sum / n : 0, maxInterior: mx,
      drew: nB > 0 && nB === nR, fallback: meshR.fallback.length,
      cubics: meshR.cubics.length, tris: meshR.interior.length / 2 });
  }
  result.compiled = true;
} catch (e) { result.error = String(e && e.stack || e); }
window.__result = result;
window.__done = true;
</script></body></html>`;

  const url = host.page(HTML);
  // A real Metal GPU (SwiftShader's fwidth/AA is unreliable; the curve
  // implicit + analytic coverage need a real driver).
  // HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
  // reports and TIMES the same either way. A window is not free to the person running this: macOS
  // CLAMPS --window-position, so a headful run cannot be put out of the way and lands
  // on whichever desktop is in front.
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__result);
  await page.close();

  if (r && r.scan)
    console.log(
      '  donut scan y=128  Slug:',
      JSON.stringify(r.scan.A),
      ' LB:',
      JSON.stringify(r.scan.B),
    );
  if (!r || !r.compiled) {
    fail('LB render-diff did not complete: ' + ((r && r.error) || 'page error'));
  } else
    for (const c of r.cases) {
      const rimFrac = c.xor / Math.max(1, c.inkA);
      const info =
        `ink ${c.inkA}/${c.inkB}, xor=${c.xor} (${(rimFrac * 100).toFixed(1)}% rim), ` +
        `meanInt=${c.meanInterior.toFixed(2)}, maxInt=${c.maxInterior}, ` +
        `cubics=${c.cubics}, tris=${c.tris}, fallback=${c.fallback}`;
      if (!c.drew)
        fail(`${c.name}: the LB route did not draw (or refresh/build vertex counts differ)`);
      else if (c.inkA === 0 || c.inkB === 0) fail(`${c.name}: nothing rendered (${info})`);
      else if (c.fallback !== 0)
        fail(`${c.name}: ${c.fallback} arcs fell back to Slug (expected 0) — ${info}`);
      // Interior must match closely (same flat color); inside/outside may disagree
      // only on the thin AA rim (~0.4% of ink measured) where the analytic-coverage
      // ramp lands a sub-quantization step off the Slug ray-cast ramp.
      else if (c.meanInterior <= 2 && rimFrac <= 0.02) ok(`${c.name}: LB matches Slug — ${info}`);
      else fail(`${c.name}: LB diverges from Slug — ${info}`);
    }
  if (!failures) console.log('loopBlinnRenderDiff: the LB route matches the Slug fill');
  return failures;
}

// lbBlendParity — per-shape blend via Slug fallback. A blend
// mode needs the backdrop, which the analytic fill can't sample — so a blended
// shape renders via Slug per-shape (Slug blends against the canvas) while the
// rest of the bundle stays analytic. Result must match an all-Slug render.
async function lbBlendParity(host) {
  // A solid green diamond (analytic) overlapped by a red diamond with
  // mix-blend-mode:multiply (→ Slug fallback). The overlap multiplies to a darker
  // color; the red-only region is red·white.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbBlendParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// Parity over pixels inked in both, and confirm the multiply region (where the
// red shape overlaps green) is DARK (g·r blend) in both — i.e. blend was applied.
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n };
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted)
    ok('blend bundle routes through the analytic path (blended shape → Slug fallback)');
  else fail('blend bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shapes render (' + o.inkPx + ' ink px)');
  else fail('barely rendered: ' + o.inkPx);
  if (o.maxDiff <= 6)
    ok(
      'render parity: LB + per-shape-Slug blend matches all-Slug (mean channel diff ' +
        o.maxDiff +
        ')',
    );
  else fail('blend interior != all-Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbBlendParity: all assertions passed');
  return failures;
}

// lbFilterParity — the analytic (Loop-Blinn) route renders a
// STATIC fill with an inline feColorMatrix filter through the composed path
// (LB coverage RT → MANTLE_LB_COV ubershader, where the inline color matrix
// runs over the LB fill), matching Slug. The matrix maps the #3366cc fill to
// pure green, so the test also confirms the filter is actually APPLIED.
async function lbFilterParity(host) {
  // feColorMatrix forcing R=0, G=1, B=0, A=A → the diamond renders pure green.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbFilterParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n, ctrLB: at(lb, 50, 50), ctrSlug: at(slug, 50, 50) };
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  const isGreen = (c) => c[1] > 150 && c[0] < 60 && c[2] < 60;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('filtered bundle routes through the analytic composed path (LB on)');
  else fail('filtered bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (isGreen(o.ctrLB))
    ok('inline feColorMatrix applied (center green ' + JSON.stringify(o.ctrLB) + ')');
  else fail('filter not applied: center=' + JSON.stringify(o.ctrLB));
  if (o.maxDiff <= 6)
    ok('render parity: analytic filtered fill matches Slug (mean channel diff ' + o.maxDiff + ')');
  else fail('analytic filtered interior != Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbFilterParity: all assertions passed');
  return failures;
}

// lbTextParity — a text run renders through the LB route matching Slug.
// Text bundles carry authoritative per-shape curve ranges (each glyph's
// _curveStartF) so curveRangeToContours reconstructs glyph contours correctly.
// Without them createBundle falls back to buildCurveRangesByShape (glyphLoc = a
// BAND index, not a curve offset) → the first glyphs come out unfilled /
// garbled and multi-glyph ranges corrupt.
//
// Explicit LB validates support and parity; automatic mode remains free to keep
// this high-coverage text on the faster coverage renderer.
async function lbTextParity(host) {
  const FONT = optionalAsset(fontFixture('roboto-regular.ttf'));
  if (!FONT) return 0;
  const ttf = Array.from(new Uint8Array(readFileSync(FONT)));
  const W = 900,
    H = 200;

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(${W}, ${H});
// The coverage reference: the plain cover pass (router A*: 'auto' draws a static bundle there; setLoopBlinnFill('off') is a pinned unified-family program, 1/255 apart).
const plain = createRenderer(gl, shaders, { unifiedFill: false });
plain.setViewport(${W}, ${H});
window.__run = async (ttf, word) => {
  const font = new MantleFontAsset(new Uint8Array(ttf));
  const tb = await createTextBundle(gl, { font, text: word, style: { fontSize: 1, fill: [0,0,0,1] } }); renderer.prepareBundle(tb.bundle); await renderer.awaitLbReady(tb.bundle);
  const readCols = () => { const px = new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px);
    const b = 14, bw = Math.floor(${W}/b), o = new Array(b).fill(0);
    for (let i=0;i<b;i++){ let s=0; for(let x=i*bw;x<(i+1)*bw;x++) for(let y=0;y<${H};y++){ const q=(y*${W}+x)*4; if(px[q]<200) s++; } o[i]=s; } return o; };
  const routed = () => renderer.debugStats.loopBlinnRouteCount + renderer.debugStats.loopBlinnMorphRouteCount;
  const draw = async (mode) => { const R = mode === 'off' ? plain : renderer; R.setLoopBlinnFill(mode); if (mode === 'on') { renderer.prepareBundle(tb.bundle); await renderer.awaitLbReady(tb.bundle); } const r0 = routed();   // (a static bundle builds its meshes when a pin asks, so wait for them before the measured draw)
    // Both arms are measured on their settled (lean) programs, not one on the general stand-in and the other on its variant: draw, build the variants, draw again.
    const frame = () => { R.beginFrame([1,1,1,1]); R.drawBundle(tb); R.endFrame(); };
    frame(); frame(); if (R.precompileFills) R.precompileFills(); frame();
    R.beginFrame([1,1,1,1]); R.drawBundle(tb); R.endFrame();
    return { cols: readCols(), routed: routed() - r0 }; };
  const slug = await draw('off');
  const auto = await draw('auto');
  const on = await draw('on');
  const tot = a => a.reduce((x,y)=>x+y,0);
  // per-band relative diff of on vs slug
  let maxBandRel = 0;
  for (let i=0;i<slug.cols.length;i++){ const s=slug.cols[i], l=on.cols[i]; if (s>50) maxBandRel = Math.max(maxBandRel, Math.abs(l-s)/s); }
  return { numShapes: tb.bundle.numShapes, slugTot: tot(slug.cols), autoTot: tot(auto.cols), onTot: tot(on.cols),
    autoRouted: auto.routed, onRouted: on.routed, maxBandRel: +maxBandRel.toFixed(3) };
};
window.__ready = true;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 20000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  for (const word of ['Reading files', 'oo']) {
    const o = await page.evaluate((t, w) => window.__run(t, w), ttf, word);
    console.log(`  [${word}] ` + JSON.stringify(o));
    // Correctness ('on' routes + matches Slug).
    if (o.onRouted > 0) ok(`[${word}] routes through LB on 'on'`);
    else fail(`[${word}] did not route LB on 'on'`);
    if (Math.abs(o.onTot - o.slugTot) <= o.slugTot * 0.03)
      ok(`[${word}] LB total ink matches Slug (${o.onTot} vs ${o.slugTot})`);
    else fail(`[${word}] LB total != Slug (${o.onTot} vs ${o.slugTot}) — glyph reconstruction`);
    if (o.maxBandRel <= 0.15)
      ok(`[${word}] every glyph band matches Slug (max band rel ${o.maxBandRel})`);
    else
      fail(
        `[${word}] a glyph band diverges (max band rel ${o.maxBandRel}) — first-glyph unfill / garble`,
      );
    if (o.autoRouted === 0 && o.autoTot === o.slugTot)
      ok(`[${word}] 'auto' keeps high-coverage text on the coverage fallback`);
    else
      fail(
        `[${word}] unexpected auto route/output (routes=${o.autoRouted}, ink=${o.autoTot}/${o.slugTot})`,
      );
  }

  await page.close();
  if (!failures)
    console.log('lbTextParity: text reconstructs correctly under forced LB and auto fallback');
  return failures;
}

// lbStrokeParity — the analytic (Loop-Blinn) route renders a filled +
// STROKED static shape. The fill interior and the stroke band must match Slug.
//
// The ubershader computes both in one draw (the stroke via its own band walk),
// with no coverage render target for either.
async function lbStrokeParity(host) {
  // A diamond with a blue fill and a thick red stroke.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbStrokeParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
const topInkY = (px) => { for (let y = 0; y < 100; y++) { const c = at(px, 50, y);
  if (c[0] > 20 || c[1] > 20 || c[2] > 20) return y; } return -1; };
// One row IN from the boundary so the sample is stroke body, not its AA ramp.
const topInk = (px) => at(px, 50, Math.min(99, topInkY(px) + 1));

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// Interior fill parity: pixels BLUE-dominant in both (the fill core), away from
// the red stroke band, so edge-AA differences don't pollute the comparison.
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbFill = lb[o + 2] > 120 && lb[o] < 120, slugFill = slug[o + 2] > 120 && slug[o] < 120;
  if (lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20) n++;
  if (lbFill && slugFill) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const fillDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, fillDiff, inkPx: n,
  ctrLB: at(lb, 50, 50), ctrSlug: at(slug, 50, 50),
  // Top vertex, FOUND rather than assumed: the first ink pixel scanning down the
  // center column. A hardcoded row silently stops sampling the stroke the moment
  // anything changes the asset's framing.
  edgeLB: topInk(lb), edgeSlug: topInk(slug),
  edgeYLB: topInkY(lb), edgeYSlug: topInkY(slug),
};
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  const isFill = (c) => c[2] > 120 && c[0] < 120;
  const isStroke = (c) => c[0] > 120 && c[2] < 120;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('stroked bundle routes through the analytic composed path (LB on)');
  else fail('stroked bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (isFill(o.ctrLB) && isFill(o.ctrSlug))
    ok('center is the blue fill in both ' + JSON.stringify(o.ctrLB));
  else
    fail('center not fill: LB=' + JSON.stringify(o.ctrLB) + ' Slug=' + JSON.stringify(o.ctrSlug));
  if (isStroke(o.edgeLB) && isStroke(o.edgeSlug))
    ok('top vertex shows the red stroke in both ' + JSON.stringify(o.edgeLB));
  else
    fail(
      'stroke missing at edge: LB=' +
        JSON.stringify(o.edgeLB) +
        ' Slug=' +
        JSON.stringify(o.edgeSlug),
    );
  if (o.fillDiff <= 6)
    ok('render parity: analytic fill interior matches Slug (mean channel diff ' + o.fillDiff + ')');
  else fail('analytic fill interior != Slug (mean channel diff ' + o.fillDiff + ')');

  await page.close();
  if (!failures) console.log('lbStrokeParity: all assertions passed');
  return failures;
}

// lbRecolorParity — a per-draw colorMatrix recolor composes
// over the analytic fill (the composed MANTLE_LB_COV variant keeps the recolor
// block; _drawBundleLB forces solid shapes through the composite path under
// recolor), matching Slug. The matrix forces the #3366cc fill to pure green.
async function lbRecolorParity(host) {
  const SVG = readFileSync(
    new URL('../examples/smoke/lbRecolorParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);

// Column-major mat4: out = M*in + offset. M zeroes RGB, passes A; offset forces G=1
// → any fill renders pure green (alpha preserved).
const M = new Float32Array([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]);
const OFF = new Float32Array([0,1,0,0]);
const opts = { colorMatrix: M, colorMatrixOffset: OFF };

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, opts); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
// STEADY STATE. A RECOLORED draw selects its own fill variant (drawUsesRecolor
// changes the defines), and while a variant links the bundle falls to the best
// non-LB engine rather than into the classic coverage-RT routes — so frame 1 routes
// nothing to LB by design. Spin until the recolor variant is warm; that is what an
// application sees after the first handful of frames.
//
// A pipeline warm that runs with whatever R.draw last held never warms the recolored
// variant, and the gate never clears. The warm replays the draw state that was found
// mismatched, which is what makes this converge at all.
// the analytic meshes are built off-thread: wait for them (bounded) rather than give the build a fixed number of draws
await renderer.awaitLbReady(bundle);
const r1 = renderer.debugStats.loopBlinnRouteCount;
for (let i = 0; i < 20; i++) {
  const c = renderer.debugStats.loopBlinnRouteCount;
  draw();
  if (renderer.debugStats.loopBlinnRouteCount - c > 0) break;
  if (renderer.precompileFills) { try { renderer.precompileFills(); } catch {} }
  // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
      await new Promise((res) => { const _t = setTimeout(res, 100); requestAnimationFrame(() => { clearTimeout(_t); res(); }); });
}
draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n, ctrLB: at(lb, 50, 50), ctrSlug: at(slug, 50, 50) };
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  const isGreen = (c) => c[1] > 150 && c[0] < 60 && c[2] < 60;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('recolored bundle routes through the analytic composite path (LB on)');
  else fail('recolored bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (isGreen(o.ctrLB))
    ok('colorMatrix recolor applied (center green ' + JSON.stringify(o.ctrLB) + ')');
  else fail('recolor not applied: center=' + JSON.stringify(o.ctrLB));
  if (o.maxDiff <= 6)
    ok('render parity: analytic recolored fill matches Slug (mean channel diff ' + o.maxDiff + ')');
  else fail('analytic recolored interior != Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbRecolorParity: all assertions passed');
  return failures;
}

// lbMaskParity — the analytic (Loop-Blinn) route renders a
// MASKED STATIC fill through the composed path (LB coverage RT → MANTLE_LB_COV
// ubershader, where the luminance mask walk runs over the LB fill), matching Slug.
async function lbMaskParity(host) {
  // A diamond PATH masked by a white rect over its RIGHT half (luminance mask:
  // white = visible). The left half must be hidden; the right stays the fill color.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbMaskParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n,
  leftLB: at(lb, 20, 50), leftSlug: at(slug, 20, 50), rightLB: at(lb, 70, 50),
};
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  const isBg = (c) => c[0] < 20 && c[1] < 20 && c[2] < 20;
  const isFill = (c) =>
    Math.abs(c[0] - 51) < 30 && Math.abs(c[1] - 102) < 30 && Math.abs(c[2] - 204) < 30;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('masked bundle routes through the analytic composed path (LB on)');
  else fail('masked bundle did NOT route to the analytic fill');
  if (o.inkPx > 500) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (isBg(o.leftLB) && isBg(o.leftSlug)) ok('mask hides the left half (background in both)');
  else
    fail(
      'mask did not hide: leftLB=' +
        JSON.stringify(o.leftLB) +
        ' leftSlug=' +
        JSON.stringify(o.leftSlug),
    );
  if (isFill(o.rightLB)) ok('right half is the fill color ' + JSON.stringify(o.rightLB));
  else fail('right half not fill: ' + JSON.stringify(o.rightLB));
  if (o.maxDiff <= 6)
    ok('render parity: analytic masked fill matches Slug (mean channel diff ' + o.maxDiff + ')');
  else fail('analytic masked interior != Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbMaskParity: all assertions passed');
  return failures;
}

// lbClipParity — the analytic (Loop-Blinn) route renders a
// CLIPPED STATIC fill through the composed path (LB coverage RT → MANTLE_LB_COV
// ubershader, where the clip union runs over the LB fill), matching Slug.
//
// A clip can't ride the 1-pass direct fill (the clip union lives in the
// ubershader below the fCov seam). This is the canary for the static/streamed
// composed path — the same machinery the morph route uses (_drawComposedMorphShape).
async function lbClipParity(host) {
  // A diamond PATH clipped to a rect covering only its RIGHT half (x>=50). The
  // left half must be cropped away; the right half stays the fill color.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbClipParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// INTERIOR parity over pixels inked in BOTH (excludes silhouette AA edge).
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
// The clip crops the LEFT half: a point well inside the left of the diamond
// (x=20, center row) must be BACKGROUND in both. The right (x=75) is fill.
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n,
  leftLB: at(lb, 20, 50), leftSlug: at(slug, 20, 50),
  rightLB: at(lb, 70, 50), rightSlug: at(slug, 70, 50),
};
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  const isBg = (c) => c[0] < 20 && c[1] < 20 && c[2] < 20;
  const isFill = (c) =>
    Math.abs(c[0] - 51) < 30 && Math.abs(c[1] - 102) < 30 && Math.abs(c[2] - 204) < 30;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('clipped bundle routes through the analytic composed path (LB on)');
  else fail('clipped bundle did NOT route to the analytic fill');
  if (o.inkPx > 500) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (isBg(o.leftLB) && isBg(o.leftSlug)) ok('clip crops the left half (background in both)');
  else
    fail(
      'clip did not crop: leftLB=' +
        JSON.stringify(o.leftLB) +
        ' leftSlug=' +
        JSON.stringify(o.leftSlug),
    );
  if (isFill(o.rightLB)) ok('right half is the fill color ' + JSON.stringify(o.rightLB));
  else fail('right half not fill: ' + JSON.stringify(o.rightLB));
  if (o.maxDiff <= 6)
    ok('render parity: analytic clipped fill matches Slug (mean channel diff ' + o.maxDiff + ')');
  else fail('analytic clipped interior != Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbClipParity: all assertions passed');
  return failures;
}

// lbTransformOverrideParity — per-shape TRANSFORM overrides.
// Loop-Blinn can't cheaply apply a per-shape affine, so a transformed shape
// falls back to Slug per-shape (Slug applies the override transform) while the
// untransformed shapes stay analytic. Result must match an all-Slug render.
async function lbTransformOverrideParity(host) {
  // Two diamonds. Shape 1 (right) gets a translate override (moved up 40em); shape
  // 0 (left) is untransformed → analytic.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbTransformOverrideParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const ovr = createOverrideTable(gl, bundle);
ovr.set(1, { localPosition: [0, -60] });   // move the right (blue) diamond up

const draw = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, { overrides: ovr }); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((199 - yTop) * 200 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

const drawNoOvr = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;
drawNoOvr(); const lbNoOvr = readAll();   // LB, same bundle, NO override (transform absent)

// (a) Parity over pixels inked in BOTH the LB-with-override and Slug-with-override
//     renders. (b) The override must actually CHANGE the render vs no-override.
let sumDiff = 0, both = 0, n = 0, ovrChanged = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
  if (Math.abs(lb[o] - lbNoOvr[o]) > 40 || Math.abs(lb[o + 2] - lbNoOvr[o + 2]) > 40) ovrChanged++;
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n, ovrChanged };
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('bundle with a transform override routes through the analytic path (LB on)');
  else fail('bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shapes render (' + o.inkPx + ' ink px)');
  else fail('barely rendered: ' + o.inkPx);
  if (o.ovrChanged > 300)
    ok(
      'the transform override visibly changed the render (' +
        o.ovrChanged +
        ' px moved vs no-override)',
    );
  else
    fail('transform override had no effect (only ' + o.ovrChanged + ' px differ from no-override)');
  if (o.maxDiff <= 6)
    ok(
      'render parity: LB+per-shape-Slug transform matches all-Slug (mean channel diff ' +
        o.maxDiff +
        ')',
    );
  else fail('transform-override interior != all-Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbTransformOverrideParity: all assertions passed');
  return failures;
}

// lbImageBatch — <image> shapes must ride the batched analytic fill, each with its
// own rect + atlas slot, and match Slug.
//
// Per-shape paint (gradient id, image id, shape bbox, image rect, atlas slot) rides a
// 4-texel/shape texture indexed by the aShapeRow the batched route already carries, so an
// image needs no per-shape route.
//
// GOTCHA this pins: an image shape's paint is the atlas sample TINTED by (1,1,1,opacity).
// Baking the shape's FILL color into the combined VBO's aColor (black for a plain <image>)
// multiplies the image to black — it renders solid. The VBO writes white for image shapes.
async function lbImageBatch(host) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const N = 256;
  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, K=10;
// distinct 16x16 PNG tiles, drawn in-page
const tile=(hue)=>{const c=document.createElement('canvas'); c.width=c.height=16; const x=c.getContext('2d');
  x.fillStyle='hsl('+hue+',80%,50%)'; x.fillRect(0,0,16,16);
  x.fillStyle='hsl('+((hue+180)%360)+',80%,35%)'; x.beginPath(); x.arc(8,8,5,0,7); x.fill();
  return c.toDataURL('image/png'); };
const sheet=(Kn)=>{ const cols=Math.round(Math.sqrt(Kn)), cell=N/cols; let body='';
  for(let i=0;i<Kn;i++){ const x=(i%cols)*cell, y=Math.floor(i/cols)*cell;
    body+='<image xlink:href="'+tile((i*61)%360)+'" x="'+(x+2)+'" y="'+(y+2)+'" width="'+(cell-4)+'" height="'+(cell-4)+'"/>'; }
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 '+N+' '+N+'" width="'+N+'" height="'+N+'">'+body+'</svg>'; };
// Images go through the unified draw. What is asserted below is that each <image>
// shape samples its OWN rect + atlas slot in one batched draw and matches Slug.
const r=createRenderer(gl,shaders);
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const readAll=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
const amort=(b)=>{const runs=[]; for(let rep=0;rep<5;rep++){
  r.beginFrame([1,1,1,1]); for(let i=0;i<2;i++) r.drawBundle(b); r.endFrame(); sync();
  const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync();
  runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[2];};
const out=[];
try{
for(const Kn of [4,16]){
  const b=createBundle(gl, await importSvg(sheet(Kn))); r.prepareBundle(b);
  const draw=()=>{r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();};
  r.setLoopBlinnFill('off'); draw(); const s=readAll(); const off=amort(b);
  const c0=r.debugStats.loopBlinnRouteCount;
  // awaitLbReady, not just prepareBundle: the latter is non-blocking, and an
  // unwarmed bundle falls to the best non-LB engine instead of the classic
  // coverage-RT routes — which would make the routed count 0 and the diffs vacuous.
  r.setLoopBlinnFill('on'); await r.awaitLbReady(b); draw(); const l=readAll(); const on=amort(b);
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  let mx=0,sum=0; for(let i=0;i<s.length;i++){const d=Math.abs(s[i]-l[i]); if(d>mx)mx=d; sum+=d;}
  out.push({name:'images x'+Kn, hasAtlas:!!b.imageAtlasTex, mfps:b.metaFloatsPerShape|0,
    routed, maxDiff:mx, meanDiff:sum/s.length, off, on});
  b.dispose();
}}catch(e){ window.__err=String(e)+'\\n'+e.stack; }
window.__out=out; window.__ready=true;</script></body></html>`;
  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  // polling:50 (not the default 'raf'): headless Chrome stops producing animation frames for
  // this page once the GL work is done, so an rAF-polled wait hangs even though __ready is true.
  await pg.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(180000),
    polling: 50,
  });
  const err = await pg.evaluate(() => window.__err);
  const o = await pg.evaluate(() => window.__out);
  await pg.close();
  if (err) {
    console.error('threw:', err);
    return 1;
  }
  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
  for (const r of o) {
    ok(r.hasAtlas, `${r.name}: bundle has an image atlas`);
    ok(r.routed > 0, `${r.name}: takes the LB route`);
    // a black render (image x fill color) would blow this up, not just shift AA edges
    ok(
      r.meanDiff <= 3.0,
      `${r.name}: matches all-Slug (meanDiff=${r.meanDiff.toFixed(3)}, maxDiff=${r.maxDiff})`,
    );
  }
  console.log(fail ? `\nLB-IMAGE-BATCH FAIL (${fail})` : '\nLB-IMAGE-BATCH PASS');
  return fail;
}

// lbGradientParity — the analytic (Loop-Blinn) route renders
// GRADIENT fills, not just solid, and matches the Slug fill.
//
// A gradient-filled path drawn with setLoopBlinnFill(true) (→ analytic route)
// must pixel-match the same bundle drawn with it OFF (→ Slug), and show the
// gradient (left red → right green).
async function lbGradientParity(host) {
  // A diamond PATH (not a <rect>, so it's not the primKind-excluded rect) with a
  // horizontal linear gradient red→green in objectBoundingBox units.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbGradientParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
window.__hasGrad = !!bundle.gradientTex;

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// INTERIOR parity: mean RGB diff over pixels inked in BOTH (excludes the
// silhouette AA edge, where LB and Slug antialias differently — that's a few
// px of mismatch, not a paint difference). The gradient interior must match.
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 30 || lb[o + 1] > 30, slugInk = slug[o] > 30 || slug[o + 1] > 30;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;   // mean channel diff over interior
// Gradient direction (center row): left should be red-dominant, right green.
const left = at(lb, 25, 50), right = at(lb, 75, 50);
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n,
  left, right,
};
window.__ready = true;
var out_slugRouted, out_lbRouted;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  const hasGrad = await page.evaluate(() => window.__hasGrad);

  if (hasGrad) ok('bundle carries a gradient texture');
  else fail('no gradientTex');
  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('gradient bundle routes through the analytic per-shape path (LB on)');
  else fail('gradient bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (o.maxDiff <= 6)
    ok(
      'render parity: analytic gradient interior matches Slug (mean channel diff ' +
        o.maxDiff +
        ')',
    );
  else fail('analytic gradient interior != Slug (mean channel diff ' + o.maxDiff + ')');
  if (o.left[0] > o.left[1] + 40 && o.right[1] > o.right[0] + 40)
    ok(
      'gradient direction correct (left red ' +
        JSON.stringify(o.left) +
        ', right green ' +
        JSON.stringify(o.right) +
        ')',
    );
  else fail('gradient wrong: left=' + JSON.stringify(o.left) + ' right=' + JSON.stringify(o.right));

  await page.close();
  if (!failures) console.log('lbGradientParity: all assertions passed');
  return failures;
}

// lbGradientBatch — many DIFFERENT gradients must ride LB's one-draw batched route.
//
// The per-vertex aColor attribute carries a solid color only, so a gradient shape would
// otherwise need a per-shape route (one draw + one uniform set per shape). Vertex-attribute
// locations are exhausted (loc 15 is taken; GL guarantees only 16), so per-shape paint
// rides a TEXTURE indexed by the aShapeRow the route already carries:
//     texel (0,row) = (gradientId, 0, 0, 0)     texel (1,row) = shape em bbox
//
// A single uGradId uniform cannot serve a bundle whose shapes have DIFFERENT gradients —
// that is exactly what this pins, together with pixel parity against Slug. Both linear and
// radial, because objectBoundingBox units are resolved from the per-shape bbox texel.
//
// This removes a structural reason a bundle falls off the batched route.
async function lbGradientBatch(host) {
  const N = 256;

  // K discs, each with its own gradient. Tangent-control circles (k = 0.5523r) so the
  // cubics are kind-2 and exact — corner controls would trip degree reduction, unrelated.
  function sheet(K, kind) {
    const cols = Math.round(Math.sqrt(K)),
      cell = N / cols,
      r = cell * 0.4;
    let defs = '',
      body = '';
    for (let i = 0; i < K; i++) {
      const cx = (i % cols) * cell + cell / 2,
        cy = Math.floor(i / cols) * cell + cell / 2;
      const h1 = (i * 53) % 360,
        h2 = (i * 53 + 140) % 360;
      defs +=
        kind === 'linear'
          ? `<linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},70%,55%)"/><stop offset="1" stop-color="hsl(${h2},70%,45%)"/></linearGradient>`
          : `<radialGradient id="g${i}" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="hsl(${h1},70%,60%)"/><stop offset="1" stop-color="hsl(${h2},70%,40%)"/></radialGradient>`;
      const k = 0.5523 * r;
      const P = [
        [cx - r, cy],
        [cx, cy - r],
        [cx + r, cy],
        [cx, cy + r],
      ];
      let d = `M ${P[0][0]} ${P[0][1]} `;
      for (let j = 0; j < 4; j++) {
        const A = P[j],
          B = P[(j + 1) % 4];
        const ta = [-(A[1] - cy), A[0] - cx],
          tb = [-(B[1] - cy), B[0] - cx];
        d += `C ${(A[0] + (ta[0] / r) * k).toFixed(3)} ${(A[1] + (ta[1] / r) * k).toFixed(3)} ${(B[0] - (tb[0] / r) * k).toFixed(3)} ${(B[1] - (tb[1] / r) * k).toFixed(3)} ${B[0]} ${B[1]} `;
      }
      body += `<path fill="url(#g${i})" d="${d}Z"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><defs>${defs}</defs>${body}</svg>`;
  }
  const CASES = { 'linear x16': sheet(16, 'linear'), 'radial x16': sheet(16, 'radial') };

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(CASES)}, N = ${N};
// This bundle takes the unified draw, which puts gradients through the ubershader in
// one drawArrays. What is asserted below: many DIFFERENT gradients in one batched
// draw, each sampling its own, matching Slug.
const r = createRenderer(gl, shaders);
const readAll = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const out = [];
for (const [name, svg] of Object.entries(CASES)) {
  const b = createBundle(gl, await importSvg(svg));
  r.prepareBundle(b);
  const draw = () => { r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); };
  r.setLoopBlinnFill('off'); draw(); const s = readAll();
  const c0 = r.debugStats.loopBlinnRouteCount;
  // Asks for LB EXPLICITLY. This smoke is about the LB machinery, not about
  // whether 'auto' would choose it, and keeping the two apart means a future
  // routing change cannot silently make it vacuous.
  // ...and WAITS for it. prepareBundle is non-blocking by contract, so on frame 1
  // the LB-hosting fill variant may still be linking — and an unwarmed bundle
  // falls to the best non-LB engine rather than into the classic coverage-RT
  // routes, which would make every LB assertion below vacuous. awaitLbReady is the
  // call that resolves once the bundle can actually be drawn analytically.
  r.setLoopBlinnFill('on'); await r.awaitLbReady(b); draw(); const l = readAll();
  const autoRouted = r.debugStats.loopBlinnRouteCount - c0;
  let mx = 0, sum = 0;
  for (let i = 0; i < s.length; i++) { const d = Math.abs(s[i]-l[i]); if (d>mx) mx=d; sum+=d; }
  // color VARIETY: if every shape wrongly sampled the same gradient (a single uniform),
  // the distinct colors at disc centers would collapse. Sample each disc's center.
  const cols = Math.round(Math.sqrt(16)), cell = N/cols;
  const centers = [];
  for (let i = 0; i < 16; i++) {
    const cx = Math.round((i%cols)*cell + cell/2), cyTop = Math.round(Math.floor(i/cols)*cell + cell/2);
    const o = ((N-1-cyTop)*N + cx)*4;
    centers.push(l[o] + ',' + l[o+1] + ',' + l[o+2]);
  }
  out.push({ name, autoRouted, maxDiff: mx, meanDiff: sum/s.length,
             distinct: new Set(centers).size });
  b.dispose();
}
window.__out = out; window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  const o = await pg.evaluate(() => window.__out);
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
  for (const r of o) {
    ok(r.autoRouted > 0, `${r.name}: gradient bundle takes the LB route`);
    ok(
      r.distinct >= 14,
      `${r.name}: each shape keeps its OWN gradient (${r.distinct}/16 distinct centers)`,
    );
    ok(
      r.meanDiff <= 3.0,
      `${r.name}: matches all-Slug (meanDiff=${r.meanDiff.toFixed(3)}, maxDiff=${r.maxDiff})`,
    );
  }
  console.log(fail ? `\nLB-GRADIENT-BATCH FAIL (${fail})` : '\nLB-GRADIENT-BATCH PASS');
  return fail;
}

// lbComposeOrder — guards a cross-shape uniform-leak in the analytic
// fill: lbProg's uGradId/uImageId are shared between the per-shape DIRECT path
// (_drawLBShapeDirect, sets them for gradient/image shapes) and the all-solid
// COMBINED route (_drawBundleLoopBlinn). The combined route must RESET them, or
// a solid bundle drawn after a gradient one in the same frame samples the stale
// gradient and renders blank. Reproduces what a real multi-bundle scene does
// (gradient scenery + solid shapes composed per frame) — LB 'on' so both route.
async function lbComposeOrder(host) {
  const MESA = readFileSync(
    new URL('../examples/smoke/lbComposeOrder__MESA.svg', import.meta.url),
    'utf8',
  );
  const BLOB = readFileSync(
    new URL('../examples/smoke/lbComposeOrder__BLOB.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(200, 200);
const hMesa = renderer.createBundleHandle(createBundle(gl, await importSvg(${JSON.stringify(MESA)})));
const hBlob = renderer.createBundleHandle(createBundle(gl, await importSvg(${JSON.stringify(BLOB)})));
const read = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
// Count pixels close to the solid blob color (#3366cc = 51,102,204).
const bluePx = (px) => { let n = 0; for (let i = 0; i < 200 * 200; i++) { const o = i * 4;
  if (Math.abs(px[o] - 51) < 40 && Math.abs(px[o + 1] - 102) < 40 && Math.abs(px[o + 2] - 204) < 40) n++; } return n; };
// ONE frame: gradient mesa first, then the solid blob ON TOP. LB 'on' → both route.
const compose = (lbMode) => {
  renderer.setLoopBlinnFill(lbMode);
  renderer.beginFrame([1, 1, 1, 1]); hMesa.draw({}); hBlob.draw({}); renderer.endFrame();
  return bluePx(read());
};
window.__out = { slug: compose('off'), lbOn: compose('on') };
window.__ready = true;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));
  if (o.slug < 2000) fail('reference (Slug) blob did not render: ' + o.slug + ' blue px');
  else ok('Slug composes the solid blob over the gradient mesa (' + o.slug + ' blue px)');
  // The bug rendered the blob blank (0 blue). Require it within 15% of the Slug ref.
  if (o.lbOn >= o.slug * 0.85)
    ok('LB solid bundle survives a prior gradient draw (' + o.lbOn + ' vs ' + o.slug + ' blue px)');
  else
    fail(
      'LB solid bundle vanished/shrank after a gradient draw (' +
        o.lbOn +
        ' vs ' +
        o.slug +
        ' blue px) — uGradId leak',
    );

  await page.close();
  if (!failures)
    console.log(
      'lbComposeOrder: solid combined route resets uGradId/uImageId after a gradient draw',
    );
  return failures;
}

// lbPerShapeFallbackParity — per-shape Slug fallback. A bundle
// mixes a Loop-Blinn-servable shape (a diamond) with one LB CANNOT serve (a
// loop/cusp cubic). The analytic route renders the diamond via LB and the
// loop/cusp shape via Slug — in painter order, on the same canvas — instead of
// dropping the whole bundle to Slug. Result must match an all-Slug render.
async function lbPerShapeFallbackParity(host) {
  // Shape 0: a red diamond (LB-servable). Shape 1: a SELF-INTERSECTING (loop) cubic → Loop-Blinn
  // fallback → per-shape Slug. (Not a CUSP cubic: svg/path.js splits cubics at their cusp, so
  // a cusp is a segment endpoint and LB builds a real mesh for it. A loop defeats the CDT, so
  // the per-shape fallback this guards stays reachable.)
  const SVG = readFileSync(
    new URL('../examples/smoke/lbPerShapeFallbackParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const blueInk = (px) => { let n = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i+3] > 128 && px[i+2] > 150 && px[i+2] - px[i] > 60) n++;   // #3366cc, not the red diamond
  return n; };
const at = (px, x, yTop) => { const o = ((199 - yTop) * 200 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;
out_hasSlug = !!bundle._lbHasSlug;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, hasSlug: out_hasSlug, maxDiff, inkPx: n,
  diamondLB: at(lb, 150, 90), diamondSlug: at(slug, 150, 90),    // shape 0 (LB)
  // Shape 1's ink, COUNTED rather than sampled at a fixed pixel: the bundle fits its bbox to
  // the CONTENT, so a hardcoded coordinate silently stops being inside the shape the moment the
  // fixture's geometry changes (it did, and reported the shape "missing").
  cuspInkLB: blueInk(lb), cuspInkSlug: blueInk(slug),
};
window.__ready = true;
var out_slugRouted, out_lbRouted, out_hasSlug;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  const isRed = (c) => c[0] > 150 && c[1] < 90 && c[2] < 90;
  const isBlue = (c) => c[2] > 120 && c[0] < 110;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('mixed bundle routes through the analytic path (LB on)');
  else fail('mixed bundle did NOT route to the analytic fill');
  if (o.hasSlug) ok('per-shape Slug fallback engaged (bundle has a loop/cusp shape)');
  else fail('expected a slug sentinel — the loop/cusp shape should need the per-shape fallback');
  if (isRed(o.diamondLB) && isRed(o.diamondSlug))
    ok('LB-served diamond renders red in both ' + JSON.stringify(o.diamondLB));
  else
    fail(
      'diamond wrong: LB=' + JSON.stringify(o.diamondLB) + ' Slug=' + JSON.stringify(o.diamondSlug),
    );
  if (o.cuspInkLB > 200 && Math.abs(o.cuspInkLB - o.cuspInkSlug) <= 8)
    ok(
      `Slug-fallback loop shape renders in both (LB ink=${o.cuspInkLB}, Slug ink=${o.cuspInkSlug})`,
    );
  else
    fail(
      `loop/cusp shape missing under fallback: LB ink=${o.cuspInkLB}, Slug ink=${o.cuspInkSlug}`,
    );
  if (o.maxDiff <= 6)
    ok(
      'render parity: per-shape mixed LB+Slug matches all-Slug (mean channel diff ' +
        o.maxDiff +
        ')',
    );
  else fail('per-shape fallback interior != all-Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbPerShapeFallbackParity: all assertions passed');
  return failures;
}

// lbLoopParity — a SELF-INTERSECTING (loop) cubic fill correctly FALLS BACK
// to Slug (LB doesn't serve it) and renders IDENTICALLY, under both nonzero and
// evenodd. Loops are the one geometry class LB deliberately leaves on Slug:
// reconstructing a self-intersecting fill from a double-point split doesn't match
// Slug (verified), and the nonzero-vs-evenodd loop-interior rule isn't threaded
// to the LB path. This guards that the fallback stays correct (no wrong LB fill).
async function lbLoopParity(host) {
  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  // a fat self-crossing cubic loop; controls splay out and cross → a loop near the top
  const D = 'M 60 150 C 250 20 -10 20 180 150 Z';
  const svg = (rule) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 200"><path fill="#3366cc" fill-rule="${rule}" d="${D}"/></svg>`;

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="220" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=220,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const read=()=>{const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;};
const clr=()=>{gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<248||u[i+1]<248||u[i+2]<248)n++;return n;};
const SVGS={nonzero:${JSON.stringify(svg('nonzero'))}, evenodd:${JSON.stringify(svg('evenodd'))}};
async function run(rule){
  const b=createBundle(gl,await importSvg(SVGS[rule]));
  renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(b); const slug=read(); const sRouted=renderer.debugStats.loopBlinnRouteCount>r0;
  renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(b); const lb=read(); const lRouted=renderer.debugStats.loopBlinnRouteCount>r1;
  let diff=0; for(let i=0;i<slug.length;i+=4){ if(Math.abs(slug[i]-lb[i])>40||Math.abs(slug[i+1]-lb[i+1])>40||Math.abs(slug[i+2]-lb[i+2])>40) diff++; }
  return { rule, sRouted, lRouted, slugInk:ink(slug), lbInk:ink(lb), diffPx:diff, hasSlug:!!b._lbHasSlug };
}
const out={};
try{ out.nz=await run('nonzero'); out.eo=await run('evenodd'); out.ok=true; }
catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  // HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
  // reports and TIMES the same either way. A window is not free to the person running this: macOS
  // CLAMPS --window-position, so a headful run cannot be put out of the way and lands
  // on whichever desktop is in front.
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(host.page(HTML), {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__r);
  await page.close();
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else
    for (const k of ['nz', 'eo']) {
      const x = r[k];
      console.log(
        '  ' +
          x.rule +
          ': lbRouted=' +
          x.lRouted +
          ' fellBackToSlug=' +
          !x.lRouted +
          ' ink lb=' +
          x.lbInk +
          ' slug=' +
          x.slugInk +
          ' diffPx=' +
          x.diffPx,
      );
      if (!x.lRouted) ok(x.rule + ': loop shape falls back to Slug (LB does not serve it)');
      else
        fail(x.rule + ': loop shape routed through LB (should fall back — LB renders loops wrong)');
      if (x.diffPx <= Math.max(200, x.slugInk * 0.03))
        ok(x.rule + ': renders identically to Slug (diffPx ' + x.diffPx + ')');
      else
        fail(
          x.rule +
            ': loop render DIFFERS from Slug (diffPx ' +
            x.diffPx +
            ', ink ' +
            x.lbInk +
            ' vs ' +
            x.slugInk +
            ')',
        );
    }
  if (!failures) console.log('lbLoopParity: self-intersecting loop fills match Slug');
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['loopBlinnRenderDiff', loopBlinnRenderDiff],
  ['lbBlendParity', lbBlendParity],
  ['lbFilterParity', lbFilterParity],
  ['lbTextParity', lbTextParity],
  ['lbStrokeParity', lbStrokeParity],
  ['lbRecolorParity', lbRecolorParity],
  ['lbMaskParity', lbMaskParity],
  ['lbClipParity', lbClipParity],
  ['lbTransformOverrideParity', lbTransformOverrideParity],
  ['lbImageBatch', lbImageBatch],
  ['lbGradientParity', lbGradientParity],
  ['lbGradientBatch', lbGradientBatch],
  ['lbComposeOrder', lbComposeOrder],
  ['lbPerShapeFallbackParity', lbPerShapeFallbackParity],
  ['lbLoopParity', lbLoopParity],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nloopBlinnRenderDiffSmoke: the LB route matches the Slug fill, feature by feature');
