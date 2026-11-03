// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeSmoke.mjs — the dynamic paint-stroke path (incrementalStroke.js).
//
//   1. INCREMENTAL == whole: a stroke appended point-by-point with draws
//      interleaved (exercising the partial prim-row texSubImage2D uploads, the
//      vert-tail bufferSubData, the join patches and the texture realloc)
//      renders BYTE-IDENTICAL to the same polyline handed to
//      createIncrementalStroke in one call.
//   2. PARITY vs LOADED-whole: the appended stroke matches a full
//      importSvg→createBundle render of the same polyline (round caps/joins)
//      within AA tolerance — the "loaded whole" reference is the default
//      (Slug) stroke route vectorPaint renders through today.
//   3. handle.draw (the engine's mount path) matches drawBundle byte-for-byte.
//   4. A single point renders a round-cap dot; alpha modulates the composite.
//   5. PERF: append cost is O(1) per point — appending the LAST 1000 points of
//      a 6000-point stroke costs no more than a few× the SECOND 1000 (per-point
//      re-tessellation of the whole stroke would be ~5-10×).
//
// Each case below runs on its own page (its own canvas and renderer) in the same browser.
//
// NATIVE SEGMENT TYPES (page /types): the paint stroke accepts LINE, QUAD and CUBIC natively.
//
// The path writes the main renderer's segment format (encodeSeg: header, native control
// points, join texel), not a degree-elevated cubic in a private layout, so a segment is
// stored as what it IS — which is what lets the fragment
// shader run the right solve (a quad's closest point has a closed form; only a cubic needs the
// seeded Newton on a quintic).
//
// The check is EQUIVALENCE against the same curves as a dense POLYLINE, through the same path and
// the same bbox. Comparing against importSvg instead looks natural and is wrong: setViewport fits
// the CONTENT bbox, so a loaded path is scaled to its own extent while the incremental stroke uses
// the box it was handed — different scales, and an ink gap that is entirely framing. Sampling the
// curves and feeding them through the same api
// holds everything fixed except the thing under test: whether a natively stored quad and cubic
// describe the curve their control points say they do.
//
// ARC MITER (page /arc-miter): a miter join at a NATIVE arc keeps its tip on the paint stroke.
//
// The split-stroke vertex stage sizes each segment's band quad by the miter its joins actually
// need, from the segment's end directions P1 - P0 and P3 - P2. For an arc those four slots are
// not a hull: they carry the center, the radii, (phi, th0) and (th1, 0). Read as directions they
// give (radii - center) and (th1 - phi, -th0) -- whatever angle those make with the neighbor
// would decide the quad, and a sharp miter could run past it and be cut off.
//
// The case: two arcs meeting at a 7.3-degree peak with miter limit 20, so the miter (15.8 x the
// half-width) is drawn and its tip sits ~90 px outside both arcs' whole-ellipse boxes. The
// reference is the same two arcs sampled as a dense polyline through the same API and bbox, whose
// line segments size their quads from true directions (the native-types method: the
// same path, the same framing, only the thing under test differs). Measured in the band above the
// ellipse boxes, where only the miter spike paints.
//
// EXACT AA (page /exact-aa): the paint stroke draws the exact-area AA edge the static stroke
// does, and follows the renderer's setStrokeExactAa toggle.
//
// The split-stroke frag has mantle.frag's exact-area branch behind uStrokeExactAa, "so a single
// renderer toggle moves both stroke paths". incrementalStroke, its one caller, must set the
// uniform on every draw: unset, it reads 0 and the paint stroke falls back to the isotropic ramp
// (morphDraw's composed program has the same trap).
//
// THE REFERENCE IS exact: a straight 30-degree butt-capped stroke, whose coverage of each pixel is
// the area of the unit box inside the stroke's strip, computed here by clipping the box. Scored on
// edge pixels away from the caps. Two arms: the default (exact area, must match the box to within
// quantization) and setStrokeExactAa(false) (the ramp, which must NOT -- or the arms are the same
// program and the first one proves nothing).
//
// LINE EXACT (page /line-exact): a paint stroke's LINE segments are solved as lines.
//
// Lines take the clamped projection. Solved through strokeQuadAccum on a recovered midpoint,
// rounding leaves the quadratic term slightly nonzero and quadClosestT takes its degenerate
// branch: on a jittered spiral gesture that is up to 29/255 off the true coverage at a joint on
// the stroke's outer edge.
//
// THE REFERENCE IS exact: the stroke is a union of round-capped capsules, so each pixel's coverage
// is the fraction of its box within halfW of the polyline, supersampled here on the CPU. Scored on
// every pixel near the joints of a 31-point stretch of that gesture around its worst joint.
//
// NOT ZERO, AND WHY. The AA edge is one half-plane per pixel, and a pixel holding the concave
// corner where two capsules meet is not a half-plane: those read up to 13.9/255 off with either
// solve. The quadratic solve adds its own error on top (worst 29.5/255), so the bar sits between
// the two.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const W = 200,
  H = 200;
const PTS = [
  [30, 40],
  [80, 60],
  [60, 120],
  [140, 100],
  [170, 160],
  [120, 170],
];
const COLOR = [0.8, 0.15, 0.1, 1];
const WIDTH = 12;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <path d="M${PTS.map((p) => p.join(' ')).join('L')}" fill="none" stroke="rgba(204,38,26,1)" stroke-width="${WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
emitFixture('incrementalStroke__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const PTS = ${JSON.stringify(PTS)};
const COLOR = ${JSON.stringify(COLOR)};
const BBOX = [0, 0, ${W}, ${H}];

const clear = () => { renderer.setViewport(${W}, ${H}); renderer.beginFrame([0, 0, 0, 1]); };
const readAll = () => { const px = new Uint8Array(${W * H * 4}); gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

// ── 1. incremental (interleaved draws) vs whole-at-once ──────────────
const inc = renderer.createIncrementalStroke({ color: COLOR, width: ${WIDTH}, bbox: BBOX });
// Dense polyline: resample PTS into ~300 points so the prim texture crosses
// row boundaries (512 texels/row, 6/seg) and the realloc path runs.
const dense = [];
for (let i = 0; i + 1 < PTS.length; i++) {
  const [ax, ay] = PTS[i], [bx, by] = PTS[i + 1];
  for (let k = 0; k < 60; k++) dense.push([ax + (bx - ax) * k / 60, ay + (by - ay) * k / 60]);
}
dense.push(PTS[PTS.length - 1]);
for (let i = 0; i < dense.length; i += 10) {
  inc.appendPoints(dense.slice(i, i + 10));
  clear(); renderer.drawBundle(inc.bundle, {}); renderer.endFrame();   // interleaved partial uploads
}
clear(); renderer.drawBundle(inc.bundle, {}); renderer.endFrame();
const pxInc = readAll();

const whole = renderer.createIncrementalStroke({ color: COLOR, width: ${WIDTH}, bbox: BBOX, points: dense });
clear(); renderer.drawBundle(whole.bundle, {}); renderer.endFrame();
const pxWhole = readAll();
let diffIncWhole = 0;
for (let i = 0; i < pxInc.length; i++) if (pxInc[i] !== pxWhole[i]) diffIncWhole++;

// ── 2. parity vs the polyline loaded whole (importSvg → default route) ──
// preserveViewport pins globalBBox to the viewBox — the vectorPaint loadSvg
// configuration, and the same mapping as the incremental stroke's pinned bbox.
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true }));
renderer.prepareBundle(bundle);
clear(); renderer.drawBundle(bundle, {}); renderer.endFrame();
const pxRef = readAll();
// Sparse-vertex incremental stroke of the SAME 6 points (the reference SVG's
// own vertices — dense resampling is geometrically identical but AA-dithers).
const sparse = renderer.createIncrementalStroke({ color: COLOR, width: ${WIDTH}, bbox: BBOX, points: PTS });
clear(); renderer.drawBundle(sparse.bundle, {}); renderer.endFrame();
const pxSparse = readAll();
let inkRef = 0, inkInc = 0, hardDiff = 0, sumDiff = 0, cmpN = 0;
for (let i = 0; i < ${W * H}; i++) {
  const o = i * 4;
  const refInk = pxRef[o] > 20, incInk = pxSparse[o] > 20;
  if (refInk) inkRef++;
  if (incInk) inkInc++;
  const d = Math.abs(pxSparse[o] - pxRef[o]);
  sumDiff += d; cmpN++;
  if (d > 64) hardDiff++;   // strong disagreement (beyond AA dither)
}
const meanDiff = +(sumDiff / cmpN).toFixed(3);

// ── 3. handle.draw (engine mount path) == drawBundle ─────────────────
const handle = renderer.createBundleHandle(sparse.bundle);
clear(); handle.draw({}); renderer.endFrame();
const pxHandle = readAll();
let diffHandle = 0;
for (let i = 0; i < pxSparse.length; i++) if (pxHandle[i] !== pxSparse[i]) diffHandle++;
handle.dispose();

// ── 4. dot + alpha ────────────────────────────────────────────────────
const dot = renderer.createIncrementalStroke({ color: [0, 0.5, 1, 1], width: 20, bbox: BBOX, points: [[100, 100]] });
clear(); renderer.drawBundle(dot.bundle, {}); renderer.endFrame();
const pxDot = readAll();
const at = (px, x, yTop) => px[((${H - 1} - yTop) * ${W} + x) * 4 + 2];   // blue channel
const dotCenter = at(pxDot, 100, 100), dotOut = at(pxDot, 100, 116), dotIn = at(pxDot, 100, 106);
clear(); renderer.drawBundle(dot.bundle, { alpha: 0.5 }); renderer.endFrame();
const dotHalf = at(readAll(), 100, 100);

// ── 5. perf: append cost must not scale with stroke length ───────────
const perf = renderer.createIncrementalStroke({ color: COLOR, width: 4, bbox: BBOX });
const chunkMs = [];
let px9 = 10, py9 = 10;
for (let c = 0; c < 6; c++) {
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    px9 += Math.sin(i * 0.37) * 0.9; py9 += Math.cos(i * 0.29) * 0.9;
    perf.appendPoints([[px9, py9]]);
  }
  chunkMs.push(performance.now() - t0);
}
perf.flush();
clear(); renderer.drawBundle(perf.bundle, {}); renderer.endFrame();
const perfDrew = readAll().some((v, i) => (i & 3) === 0 && v > 0);
// Compare MIN of the late chunks against MIN of the early chunks (skipping
// chunk 0's JIT warmup; min-of-two shrugs off a stray GC spike). O(1) per
// append keeps late chunks flat; O(total) per append makes them ~5-10×.
const early = Math.max(Math.min(chunkMs[1], chunkMs[2]), 0.05);
const late = Math.min(chunkMs[4], chunkMs[5]);
const perfRatio = +(late / early).toFixed(2);

const fin = sparse.finalize();
window.__out = {
  diffIncWhole, meanDiff, hardDiff, inkRef, inkInc, diffHandle,
  dotCenter, dotIn, dotOut, dotHalf,
  chunkMs: chunkMs.map(v => +v.toFixed(2)), perfRatio, perfDrew,
  finalizeHasPath: /^M30 40L80 60/.test(fin.pathD), finalizeHasSvg: fin.svg.includes('stroke-linecap="round"'),
  segs: sparse.segmentCount, drawCount: sparse.drawCount,
};
window.__ready = true;
</script></body></html>`;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// ---- native segment types ----
const typesCase = (() => {
  const N = 256,
    WIDTH = 11;

  // One gesture, three segment kinds, continuing from each other as a paint tool would fit them.
  const START = [30, 200];
  const SEGS = [
    { type: 'line', to: [80, 200] },
    { type: 'quad', c1: [110, 120], to: [150, 170] },
    { type: 'cubic', c1: [175, 205], c2: [190, 90], to: [225, 130] },
  ];
  // A quarter-circle stated AS an arc — the type that cannot be a cubic without drifting 8.9e-3 of
  // the radius. Center/radii/angles, exactly as encodeSeg stores it.
  const ARC = { type: 'arc', center: [128, 80], radii: [55, 55], theta: [Math.PI, Math.PI * 1.5] };
  const D = `M30 200L80 200Q110 120 150 170C175 205 190 90 225 130`;
  // The same three segments sampled densely, as points — the shape both arms must agree on.
  const SAMPLES = 400;

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true });
  r.setViewport(${N}, ${N});
  const read = () => { const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
  const clear = () => { r.beginFrame([1,1,1,1]); };

  // ── the incremental path, fed NATIVE segments ────────────────────────────
  const inc = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
  inc.appendPoints([${JSON.stringify(START)}]);
  inc.appendSegments(${JSON.stringify(SEGS)});
  const arcS = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
  const A = ${JSON.stringify(ARC)};
  arcS.appendPoints([[A.center[0] + A.radii[0]*Math.cos(A.theta[0]), A.center[1] + A.radii[1]*Math.sin(A.theta[0])]]);
  arcS.appendSegments([A]);
  clear(); r.drawBundle(arcS.bundle, {}); r.endFrame();
  const arcPx = read();
  // the same arc, sampled — the shape a native arc must agree with
  const arcPoly = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
  const ap = [];
  for (let i = 0; i <= 400; i++) { const th = A.theta[0] + (A.theta[1]-A.theta[0]) * i/400;
    ap.push([A.center[0] + A.radii[0]*Math.cos(th), A.center[1] + A.radii[1]*Math.sin(th)]); }
  arcPoly.appendPoints(ap);
  clear(); r.drawBundle(arcPoly.bundle, {}); r.endFrame();
  const arcRefPx = read();
  let arcInk = 0, arcRefInk = 0, arcHard = 0;
  for (let i = 0; i < arcPx.length; i += 4) {
    const a = 255 - arcPx[i], c = 255 - arcRefPx[i];
    if (a > 40) arcInk++; if (c > 40) arcRefInk++;
    if (Math.abs(a - c) > 64) arcHard++;
  }
  clear(); r.drawBundle(inc.bundle, {}); r.endFrame();
  const gotPx = read();
  const gotD = inc.pathD;

  // ── the same curves, densely sampled, through the SAME api ───────────────
  const qAt = (a,b,c,t) => { const m=1-t; return [m*m*a[0]+2*m*t*b[0]+t*t*c[0], m*m*a[1]+2*m*t*b[1]+t*t*c[1]]; };
  const cAt = (a,b,c,d,t) => { const m=1-t; return [
    m*m*m*a[0]+3*m*m*t*b[0]+3*m*t*t*c[0]+t*t*t*d[0],
    m*m*m*a[1]+3*m*m*t*b[1]+3*m*t*t*c[1]+t*t*t*d[1]]; };
  const dense = [${JSON.stringify(START)}];
  dense.push([80,200]);
  for (let i=1;i<=${SAMPLES};i++) dense.push(qAt([80,200],[110,120],[150,170], i/${SAMPLES}));
  for (let i=1;i<=${SAMPLES};i++) dense.push(cAt([150,170],[175,205],[190,90],[225,130], i/${SAMPLES}));
  const poly = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
  poly.appendPoints(dense);
  clear(); r.drawBundle(poly.bundle, {}); r.endFrame();
  const refPx = read();

  let inkGot = 0, inkRef = 0, hard = 0, sum = 0;
  for (let i = 0; i < gotPx.length; i += 4) {
    const a = 255 - gotPx[i], c = 255 - refPx[i];
    if (a > 40) inkGot++; if (c > 40) inkRef++;
    const d = Math.abs(a - c); sum += d; if (d > 64) hard++;
  }
  window.__out = { inkGot, inkRef, hard, mean: sum / (gotPx.length / 4), pathD: gotD, arcInk, arcRefInk, arcHard, arcD: arcS.pathD };
  window.__ready = true;
  </script></body></html>`;

  return {
    route: '/types',
    html: HTML,
    key: '__out',
    failOnPageError: false,
    check(o) {
      console.log('  ', JSON.stringify(o));

      // Not vacuous: the curves have to have painted before agreement means anything.
      if (o.inkRef > 2000) ok(`the sampled reference has ink (${o.inkRef}px)`);
      else fail(`reference painted almost nothing (${o.inkRef}px)`);
      if (Math.abs(o.inkGot - o.inkRef) <= 0.04 * o.inkRef)
        ok(
          `native line+quad+cubic match the sampled curve within 4% (${((100 * Math.abs(o.inkGot - o.inkRef)) / o.inkRef).toFixed(2)}%)`,
        );
      else fail(`ink differs: native ${o.inkGot} vs sampled ${o.inkRef}`);
      if (o.hard < 0.03 * o.inkRef) ok(`hard pixel disagreements ${o.hard} < 3% of ink`);
      else fail(`${o.hard} hard disagreements against ${o.inkRef} ink`);
      if (o.mean < 3) ok(`mean |diff| ${o.mean.toFixed(3)} < 3`);
      else fail(`mean |diff| ${o.mean.toFixed(3)}`);
      // pathD must round-trip the TYPES, or a persisted stroke comes back as a polyline.
      if (/Q/.test(o.pathD) && /C/.test(o.pathD) && /L/.test(o.pathD))
        ok(`pathD round-trips the segment types (${o.pathD.slice(0, 44)}…)`);
      else fail(`pathD lost the curve types: ${o.pathD}`);

      if (o.arcRefInk > 1000) ok(`the sampled arc has ink (${o.arcRefInk}px)`);
      else fail(`sampled arc painted almost nothing (${o.arcRefInk}px)`);
      if (Math.abs(o.arcInk - o.arcRefInk) <= 0.04 * o.arcRefInk)
        ok(
          `a NATIVE arc matches the sampled arc within 4% (${((100 * Math.abs(o.arcInk - o.arcRefInk)) / o.arcRefInk).toFixed(2)}%)`,
        );
      else fail(`native arc differs: ${o.arcInk} vs sampled ${o.arcRefInk}`);
      if (o.arcHard < 0.03 * o.arcRefInk) ok(`arc hard disagreements ${o.arcHard} < 3% of ink`);
      else fail(`arc hard disagreements ${o.arcHard} against ${o.arcRefInk} ink`);
      if (/A/.test(o.arcD)) ok(`pathD round-trips the arc (${o.arcD.slice(0, 40)}…)`);
      else fail(`pathD lost the arc: ${o.arcD}`);

      console.log('\nnative segment types: the paint stroke stores segments in their native form');
    },
  };
})();

// ---- arc miter ----
const arcMiterCase = (() => {
  const N = 256,
    WIDTH = 20,
    LIMIT = 20;

  // Two circles of radius 50 whose centers are 99.8 apart meet at J = (128, 183.16). Arc A runs
  // along circle A's bottom from its left end up into J; arc B leaves J down along circle B's bottom.
  // J is a peak: the interior angle is 2 asin(3.16 / 50) = 7.3 degrees.
  const R = 50,
    CY = 180,
    CA = [128 - 49.9, CY],
    CB = [128 + 49.9, CY];
  const H = Math.sqrt(R * R - 49.9 * 49.9);
  const thA = [Math.PI, Math.atan2(H, 49.9)]; // decreasing through the bottom (y down)
  const thB = [Math.atan2(H, -49.9), 0]; // likewise, from J to the right end
  const ARCS = [
    { type: 'arc', center: CA, radii: [R, R], theta: thA },
    { type: 'arc', center: CB, radii: [R, R], theta: thB },
  ];
  // The miter tip: J minus 15.8 half-widths straight up; the ellipse boxes end at CY - R.
  const TOP_OF_BOXES = CY - R;

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
  <script type="module">
  import { createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true });
  r.setViewport(${N}, ${N});
  const read = () => { const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
  const ARCS = ${JSON.stringify(ARCS)};
  const at = (a, th) => [a.center[0] + a.radii[0] * Math.cos(th), a.center[1] + a.radii[1] * Math.sin(th)];
  const mk = () => r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}],
                                               capStyle: 'butt', joinStyle: 'miter', miterLimit: ${LIMIT} });
  const draw = (s) => { r.beginFrame([1,1,1,1]); r.drawBundle(s.bundle, {}); r.endFrame(); return read(); };

  const nat = mk();
  nat.appendPoints([at(ARCS[0], ARCS[0].theta[0])]);
  nat.appendSegments(ARCS);
  const natPx = draw(nat);
  const poly = mk();
  const pts = [];
  // Uniform samples, stopped 1.5 px short of J on each side, and J approached along the exact
  // tangent from 1 px out. The chords at the joint then point exactly along the arcs' tangents: a
  // uniform chord at J turns the polyline's joint by half its own angle, and a clustered one ~1e-3 px
  // long takes a fp32 direction error of ~0.3 degrees -- either moves a 15.8x miter's tip by pixels.
  const dirAt = (a, th) => { const s = Math.sign(a.theta[1] - a.theta[0]);
    return [-Math.sin(th) * a.radii[0] * s, Math.cos(th) * a.radii[1] * s].map((v, _, w) => v / Math.hypot(w[0], w[1])); };
  const J = at(ARCS[0], ARCS[0].theta[1]), tA = dirAt(ARCS[0], ARCS[0].theta[1]), tB = dirAt(ARCS[1], ARCS[1].theta[0]);
  const M = 400, SKIP = 4;                                    // 4 of 400 samples: 1.5 px of arc
  for (let i = 0; i <= M - SKIP; i++) pts.push(at(ARCS[0], ARCS[0].theta[0] + (ARCS[0].theta[1] - ARCS[0].theta[0]) * i / M));
  pts.push([J[0] - tA[0], J[1] - tA[1]], J, [J[0] + tB[0], J[1] + tB[1]]);
  for (let i = SKIP; i <= M; i++) pts.push(at(ARCS[1], ARCS[1].theta[0] + (ARCS[1].theta[1] - ARCS[1].theta[0]) * i / M));
  poly.appendPoints(pts);
  const refPx = draw(poly);

  // Ink above the ellipse boxes (canvas rows are bottom-up), and ink overall.
  let spikeNat = 0, spikeRef = 0, inkNat = 0, inkRef = 0, hard = 0;
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
    const i = ((${N} - 1 - y) * ${N} + x) * 4, a = 255 - natPx[i], c = 255 - refPx[i];
    if (a > 127) inkNat++; if (c > 127) inkRef++;
    if (Math.abs(a - c) > 64) hard++;
    if (y < ${TOP_OF_BOXES - WIDTH / 2 - 4}) { if (a > 127) spikeNat++; if (c > 127) spikeRef++; }
  }
  window.__out = { spikeNat, spikeRef, inkNat, inkRef, hard, svg: nat.bundle.svgSource };
  window.__ready = true;
  </script></body></html>`;

  return {
    route: '/arc-miter',
    html: HTML,
    key: '__out',
    failOnPageError: true,
    check(o) {
      if (o) {
        console.log('  ', JSON.stringify({ ...o, svg: undefined }));
        // Not vacuous: the reference has to paint the spike, or agreement proves nothing.
        if (o.spikeRef > 150)
          ok(
            `the sampled reference paints the miter spike above the arcs' boxes (${o.spikeRef} px)`,
          );
        else
          fail(
            `the reference paints no spike above the boxes (${o.spikeRef} px) — the case proves nothing`,
          );
        if (Math.abs(o.spikeNat - o.spikeRef) <= Math.max(8, 0.05 * o.spikeRef))
          ok(`native arcs paint the same spike (${o.spikeNat} vs ${o.spikeRef} px)`);
        else
          fail(
            `native arcs paint ${o.spikeNat} spike px where the sampled arcs paint ${o.spikeRef} — the miter is cut off`,
          );
        if (o.hard < 0.02 * o.inkRef)
          ok(`hard disagreements overall ${o.hard} < 2% of ${o.inkRef} ink px`);
        else fail(`${o.hard} hard disagreements against ${o.inkRef} ink px`);
        // finalize()/svgSource re-hosts the stroke through importSvg. Without its miter limit it comes
        // back at SVG's default 4, and this 15.8x miter becomes a bevel.
        if (o.svg.includes(`stroke-miterlimit="${LIMIT}"`))
          ok(`svgSource carries the miter limit (stroke-miterlimit="${LIMIT}")`);
        else
          fail(
            `svgSource drops the miter limit — a re-hosted stroke bevels this join: ${o.svg.slice(o.svg.indexOf('stroke='), o.svg.indexOf('/>'))}`,
          );
      }

      console.log('\narc miter: a miter join at a native arc keeps its tip');
    },
  };
})();

// ---- exact aa ----
const exactAaCase = (() => {
  const N = 256,
    WIDTH = 12;
  const A = [40, 60],
    B = [216, 60 + 176 * Math.tan(Math.PI / 6)];

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
  <script type="module">
  import { createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true, strokeExactEdges: true });
  r.setViewport(${N}, ${N});
  const s = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}], capStyle: 'butt' });
  s.appendPoints([${JSON.stringify(A)}, ${JSON.stringify(B)}]);
  const shot = () => { r.beginFrame([1,1,1,1]); r.drawBundle(s.bundle, {}); r.endFrame();
    const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
    // coverage per pixel, rows top-down to match em y
    const cov = new Float32Array(${N}*${N});
    for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) cov[y*${N}+x] = (255 - px[((${N}-1-y)*${N}+x)*4]) / 255;
    return Array.from(cov); };
  const exact = shot();
  r.setStrokeExactAa(false);
  const ramp = shot();
  window.__out = { exact, ramp };
  window.__ready = true;
  </script></body></html>`;

  // Area of the unit box [x,x+1]x[y,y+1] where lo <= n.p <= hi: clip the box polygon by both lines.
  function clip(poly, n, c, keepBelow) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length];
      const dp = n[0] * p[0] + n[1] * p[1] - c,
        dq = n[0] * q[0] + n[1] * q[1] - c;
      const ip = keepBelow ? dp <= 0 : dp >= 0,
        iq = keepBelow ? dq <= 0 : dq >= 0;
      if (ip) out.push(p);
      if (ip !== iq) {
        const t = dp / (dp - dq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    return out;
  }
  const area = (poly) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  };
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]),
    T = [(B[0] - A[0]) / L, (B[1] - A[1]) / L],
    Nrm = [-T[1], T[0]];
  const c0 = Nrm[0] * A[0] + Nrm[1] * A[1];
  function score(cov) {
    let n = 0,
      max = 0,
      sum = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const cx = x + 0.5,
          cy = y + 0.5,
          along = (cx - A[0]) * T[0] + (cy - A[1]) * T[1];
        if (along < 15 || along > L - 15) continue; // away from the butt caps
        let poly = [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
        ];
        poly = clip(poly, Nrm, c0 + WIDTH / 2, true);
        poly = clip(poly, Nrm, c0 - WIDTH / 2, false);
        const want = area(poly);
        if (want <= 0 || want >= 1) continue; // edge pixels only
        const d = Math.abs(cov[y * N + x] - want);
        n++;
        sum += d;
        if (d > max) max = d;
      }
    return { n, max: +(max * 255).toFixed(2), mean: +((sum / Math.max(n, 1)) * 255).toFixed(3) };
  }

  return {
    route: '/exact-aa',
    html: HTML,
    key: '__out',
    failOnPageError: true,
    check(o) {
      if (o) {
        const ex = score(o.exact),
          rp = score(o.ramp);
        console.log(
          `   default: ${JSON.stringify(ex)}   setStrokeExactAa(false): ${JSON.stringify(rp)}   (max and mean in /255)`,
        );
        if (ex.n > 300) ok(`${ex.n} edge pixels scored`);
        else fail(`only ${ex.n} edge pixels scored — the stroke did not draw where expected`);
        // 2/255: one unit of 8-bit quantization each way, plus float rounding in the box area.
        if (ex.max <= 2)
          ok(`by default the paint stroke's edge is the exact box coverage (max ${ex.max}/255)`);
        else
          fail(
            `by default the paint stroke's edge is off the exact box coverage by up to ${ex.max}/255 — it is drawing the ramp`,
          );
        if (rp.max > ex.max + 3)
          ok(`setStrokeExactAa(false) moves this pass to the ramp (max ${rp.max}/255)`);
        else
          fail(
            `setStrokeExactAa(false) left the edge at max ${rp.max}/255 — the toggle does not reach this pass, or the arms are one program`,
          );
      }

      console.log('\nexact AA: the paint stroke draws the exact-area edge and follows the toggle');
    },
  };
})();

// ---- line exact ----
const lineExactCase = (() => {
  const N = 1024,
    HW = 4.5;
  const all = [];
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const a = i * 0.05,
      r = 60 + i * 0.2;
    all.push([512 + r * Math.cos(a) + rnd() * 3, 512 + r * Math.sin(a) + rnd() * 3]);
  }
  const PTS = all.slice(860, 891);

  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
  <script type="module">
  import { createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const R = createRenderer(gl, shaders, { psoWarmIdle: () => true }); R.setViewport(${N}, ${N});
  const st = R.createIncrementalStroke({ color: [0, 0, 0, 1], width: ${2 * HW}, bbox: [0, 0, ${N}, ${N}] });
  st.appendPoints(${JSON.stringify(PTS)});
  R.beginFrame([1, 1, 1, 1]); R.drawBundle(st.bundle, {}); R.endFrame();
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cov = [];
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) cov.push(px[((${N} - 1 - y) * ${N} + x) * 4]);
  window.__red = cov; window.__ready = true;
  </script></body></html>`;

  // Exact coverage by supersampling the distance to the polyline.
  function dist(x, y) {
    let m = Infinity;
    for (let k = 0; k + 1 < PTS.length; k++) {
      const [ax, ay] = PTS[k],
        [bx, by] = PTS[k + 1],
        dx = bx - ax,
        dy = by - ay,
        dd = dx * dx + dy * dy;
      let t = dd > 0 ? ((x - ax) * dx + (y - ay) * dy) / dd : 0;
      t = Math.max(0, Math.min(1, t));
      m = Math.min(m, Math.hypot(ax + dx * t - x, ay + dy * t - y));
    }
    return m;
  }
  const S = 32;

  return {
    route: '/line-exact',
    html: HTML,
    key: '__red',
    failOnPageError: true,
    check(red) {
      if (red) {
        // Every pixel within halfW + 2 of an interior joint: the edge ring where the two solves differ.
        let n = 0,
          max = 0,
          worst = null,
          over = 0;
        const hist = [0, 0, 0, 0];
        const seen = new Set();
        for (let k = 1; k + 1 < PTS.length; k++) {
          const [jx, jy] = PTS[k],
            R = Math.ceil(HW + 2);
          for (let y = Math.floor(jy) - R; y <= Math.floor(jy) + R; y++)
            for (let x = Math.floor(jx) - R; x <= Math.floor(jx) + R; x++) {
              const key = y * N + x;
              if (seen.has(key)) continue;
              seen.add(key);
              let c = 0;
              for (let i = 0; i < S; i++)
                for (let j = 0; j < S; j++)
                  if (dist(x + (i + 0.5) / S, y + (j + 0.5) / S) <= HW) c++;
              const want = 255 * (1 - c / (S * S)),
                got = red[key],
                d = Math.abs(got - want);
              if (c === 0 || c === S * S) continue; // edge pixels only
              n++;
              if (d > 4) over++;
              hist[d > 20 ? 3 : d > 12 ? 2 : d > 8 ? 1 : 0]++;
              if (d > max) {
                max = d;
                worst = `(${x},${y}) exact ${want.toFixed(1)} drawn ${got}`;
              }
            }
        }
        console.log(
          `   ${n} edge pixels near ${PTS.length - 2} joints; worst ${max.toFixed(1)}/255 at ${worst}; ${over} off by more than 4; <=8 / 8-12 / 12-20 / >20: ${hist.join(' / ')}`,
        );
        if (n > 500) ok(`${n} edge pixels scored`);
        else fail(`only ${n} edge pixels scored`);
        if (max <= 16)
          ok(
            `no edge pixel is further from exact than the corner model allows (worst ${max.toFixed(1)}/255, bar 16)`,
          );
        else
          fail(
            `an edge pixel is ${max.toFixed(1)}/255 off the exact coverage at ${worst} — past the corner model's 13.9`,
          );
      }

      console.log('\nline exact: paint-stroke lines are solved as lines');
    },
  };
})();
const CASES = [typesCase, arcMiterCase, exactAaCase, lineExactCase];

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const c = CASES.find((k) => k.route === req.url);
    if (c) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(c.html);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const out = await page.evaluate(() => window.__out);
console.log('  stats:', JSON.stringify(out));

// 1. incremental uploads == whole-at-once, byte-identical.
if (out.diffIncWhole === 0) ok('incremental (interleaved draws) == whole-at-once: byte-identical');
else fail(`incremental vs whole differ in ${out.diffIncWhole} bytes`);

// 2. parity vs the loaded-whole reference (AA tolerance).
if (out.inkRef > 2000) ok(`reference stroke has ink (${out.inkRef}px)`);
else fail(`reference stroke barely rendered (${out.inkRef}px)`);
const inkRel = Math.abs(out.inkInc - out.inkRef) / out.inkRef;
if (inkRel < 0.04)
  ok(`ink coverage matches loaded-whole within 4% (${(inkRel * 100).toFixed(2)}%)`);
else
  fail(
    `ink coverage off by ${(inkRel * 100).toFixed(2)}% (inc ${out.inkInc} vs ref ${out.inkRef})`,
  );
if (out.hardDiff < out.inkRef * 0.03) ok(`hard pixel disagreements ${out.hardDiff} < 3% of ink`);
else fail(`too many hard pixel disagreements: ${out.hardDiff} (ink ${out.inkRef})`);
if (out.meanDiff < 3) ok(`mean |diff| ${out.meanDiff} < 3`);
else fail(`mean |diff| too high: ${out.meanDiff}`);

// 3. handle.draw parity.
if (out.diffHandle === 0) ok('handle.draw == drawBundle: byte-identical');
else fail(`handle.draw differs in ${out.diffHandle} bytes`);

// 4. dot + alpha.
if (out.dotCenter > 200 && out.dotIn > 200 && out.dotOut < 30)
  ok(
    `single point renders a round dot (center ${out.dotCenter}, r8 ${out.dotIn}, r16 ${out.dotOut})`,
  );
else fail(`dot wrong: center ${out.dotCenter}, in ${out.dotIn}, out ${out.dotOut}`);
if (out.dotHalf > out.dotCenter * 0.35 && out.dotHalf < out.dotCenter * 0.65)
  ok(`alpha 0.5 modulates composite (${out.dotHalf} vs ${out.dotCenter})`);
else fail(`alpha 0.5 composite off: ${out.dotHalf} vs full ${out.dotCenter}`);

// 5. perf scaling.
if (out.perfDrew) ok('6000-point stroke draws');
else fail('6000-point stroke rendered nothing');
if (out.perfRatio < 3.5)
  ok(
    `append cost flat: last-1000/second-1000 chunk ratio ${out.perfRatio} < 3.5 (${out.chunkMs.join(', ')}ms)`,
  );
else
  fail(
    `append cost scales with stroke length: chunk ratio ${out.perfRatio} (${out.chunkMs.join(', ')}ms)`,
  );

// finalize surface.
if (out.finalizeHasPath && out.finalizeHasSvg && out.segs === 5 && out.drawCount > 0)
  ok('finalize() returns pathD + svg; segment/draw counts sane');
else
  fail(
    `finalize surface wrong: ${JSON.stringify({ p: out.finalizeHasPath, s: out.finalizeHasSvg, segs: out.segs, dc: out.drawCount })}`,
  );

await page.close();

// The cases on their own pages.
for (const c of CASES) {
  const page = await browser.newPage();
  page.on('pageerror', (e) =>
    c.failOnPageError ? fail('page: ' + e.message) : console.error('  [page-err]', e.message),
  );
  let o = null;
  try {
    await page.goto(`http://127.0.0.1:${port}${c.route}`, {
      waitUntil: 'load',
      timeout: pageTimeoutFor(),
    });
    await page.waitForFunction(() => window.__ready === true, {
      timeout: pageTimeoutFor(),
      polling: 100,
    });
    o = await page.evaluate((k) => window[k], c.key);
  } catch (e) {
    fail('setup: ' + e.message);
  }
  await page.close();
  if (o) c.check(o);
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nINCREMENTAL-STROKE SMOKE PASS');
