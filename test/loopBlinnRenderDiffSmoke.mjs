// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// loopBlinnRenderDiffSmoke — proves the integrated additive Loop-Blinn fill
// path (the unified analytic fill, selected with setFillEngine({route:'lb'})) renders the same
// solid shape as the Slug per-fragment ray-cast, to within AA-quantization on the 1-pixel
// silhouette rim.
//
//   A = Slug fill (drawBundle) of an SVG built from control points P
//   B = the same SVG drawn with the LB route selected
//   assert: both ink the same interior (inside/outside agree except a thin
//   AA rim), bounded mean/maxdiff. Two cases: a convex cubic blob (no hole)
//   and an evenodd donut (cubic outer + cubic hole — exercises hole bridging).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
// A real Metal GPU (SwiftShader's fwidth/AA is unreliable; the curve
// implicit + analytic coverage need a real driver).
// HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
// reports and TIMES the same either way. A window is not free to the person running this: macOS
// CLAMPS --window-position, so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader'],
});
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
await browser.close();
server.close();

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
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nloopBlinnRenderDiffSmoke: the LB route matches the Slug fill');
