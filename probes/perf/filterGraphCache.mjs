// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/filterGraphCache.mjs — a filter graph whose root is a sub-canvas rect is cached, so
// a STATIC graph-filtered shape evaluates its graph once, not every frame.
//
// GL-FREE. `_morphShapeFilter` is a closure over the renderer context, so a stub renderer can
// drive the real function and COUNT what it does: graph evaluations, source renders, cache
// stores and the bytes those stores hold. None of that needs a frame, and none of it can be
// faked by a fallback — an evaluation that happened is an evaluation the counter saw.
//
//   node probes/perf/filterGraphCache.mjs
//
// ── THE FALSIFIABLE CLAIM ───────────────────────────────────────────────────────────────────
//
// C1. For a static bundle drawn N times with nothing changing, the number of `evaluateGraph`
//    calls is 1, not N, for every root-rect size — including every size smaller than the
//    canvas, which is the common case.
//    Falsify by finding a root rect for which the count is still N.
//
// C2 (MEASURED HERE). The cache texture is allocated at the ROOT RECT rather than the
//    canvas, so the entry's charge against the filter cache's byte budget falls with the
//    filtered shape's size. The table below is that charge, per root rect, at a 1024x1024
//    canvas. This matters beyond memory: the byte budget is what evicts entries, and an entry
//    that over-charges by 100x evicts the working set that the same budget exists to protect.
//
// WHAT this DOES NOT SHOW. A frame time. The work removed is a graph evaluation — one pass per
// node over the root rect, plus the isolated source render that feeds it — and pricing that
// needs a GPU. The protocol is at the bottom, with the prediction written down.
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const { attachMorphDraw } = await import(path.join(JS, 'src/renderer/morphDraw.js'));

const CW = +(process.env.CW || 1024),
  CH = +(process.env.CH || 1024);
const FRAMES = +(process.env.FRAMES || 60);

const glStub = () =>
  new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null),
    },
  );

function makeRenderer(rootRect) {
  const cache = new Map();
  const log = { evals: 0, sourceRenders: 0, stores: 0, bytes: 0, composites: 0 };
  const R = {
    gl: glStub(),
    opts: {},
    draw: { overrides: null },
    _lbFillMode: 'on',
    _lbSlugOnly: false,
    _lbSlugFallback: true,
    _log: log,
    _handle: null,
    _unifiedFillDraws: 1,
    _filterEvalCount: 0,
    _lastFillVariantKey: 'v1',
    _rtPool: {},
    _svgDispatch: {},
    mainCopyTex: {},
    shapeFbo: {},
    shapeFboTex: {},
    viewportSize: () => [CW, CH],
    ensureShapeFbo: () => {},
    ensureMainCopyTex: () => {},
    bindFb: () => {},
    glViewport: () => {},
    glDepthMask: () => {},
    glEnable: () => {},
    glDisable: () => {},
    glUseProgram: () => {},
    glBindVertexArray: () => {},
    _forgetFillUnits: () => {},
    _filterRegionRectPx: () => null,
    _wmHash: () => 0,
    _recolorHash: () => 0,
    _getFilterCache: (k) => cache.get(k) || null,
    _setFilterCache: (k, v) => cache.set(k, v),
    _filterKeyMatches: (c, key) => {
      if (!c || !c.key) return false;
      for (const k of Object.keys(key)) if (c.key[k] !== key[k]) return false;
      return true;
    },
    _ensureCacheTex: (entry, field, w, h) => {
      if (entry[field] && entry.w === w && entry.h === h) return;
      entry[field] = { w, h };
      entry[field + 'Fbo'] = {};
      log.bytes = w * h * 4;
    },
    _blitTexToFbo: () => {
      log.stores++;
    },
    _compositeFilteredTex: () => {
      log.composites++;
    },
    _filterSingleKindComposite: () => {},
    _filterPxPerEm: () => [1, 1],
    _buildFilterCtx: () => ({}),
    _filterNodeRects: () => null,
    filterRecord: () => null,
    releaseRoot: () => {},
    evaluateGraph: () => {
      log.evals++;
      return { tex: {}, rect: rootRect };
    },
  };
  attachMorphDraw(R);
  R._renderSource = () => {
    log.sourceRenders++;
    return true;
  };
  return R;
}

const GRAPH = { nodes: [{ type: 'feGaussianBlur', params: {} }], rootOut: 0 };

console.log(`\n== graph evaluations over ${FRAMES} identical frames, canvas ${CW}x${CH} ==`);
console.log('  root rect            evals  srcRenders  stores  cache bytes   MB');
const rects = [
  null,
  [0, 0, CW, CH],
  [0, 0, 512, 512],
  [0, 0, 256, 256],
  [0, 0, 128, 128],
  [0, 0, 64, 64],
  [0, 0, 32, 32],
  [10, 10, 17, 23],
];
let worst = 0;
for (const rect of rects) {
  const R = makeRenderer(rect);
  const bundle = { _geomGen: 7, _filterParamGen: 0, _morphSrc: null };
  for (let i = 0; i < FRAMES; i++) R._morphShapeFilter(bundle, 0, 1, GRAPH, R._renderSource, 'c0');
  const L = R._log;
  worst = Math.max(worst, L.evals);
  const name = rect ? `[${rect.join(',')}]` : 'null (full canvas)';
  console.log(
    `  ${name.padEnd(20)} ${String(L.evals).padStart(5)} ${String(L.sourceRenders).padStart(11)}` +
      ` ${String(L.stores).padStart(7)} ${String(L.bytes).padStart(12)}  ${(L.bytes / 1048576).toFixed(3)}`,
  );
}
console.log(
  `\n  C1: the worst root rect evaluates the graph ${worst} time(s) in ${FRAMES} frames` +
    ` — ${worst === 1 ? 'PASS' : 'FAIL'}`,
);
console.log(
  `  C2: at ${CW}x${CH} a canvas-sized entry charges ${((CW * CH * 4) / 1048576).toFixed(3)} MB;` +
    ` a 64x64 root charges ${((64 * 64 * 4) / 1048576).toFixed(3)} MB (${((CW * CH) / (64 * 64)).toFixed(0)}x less).`,
);
console.log(
  '  NOTE srcRenders stays at FRAMES here because the stub always reports a draw; in the' +
    '\n       renderer the source render is inside the miss path and a hit skips it with the graph.',
);

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU A  What a per-frame graph evaluation costs on a static filtered shape.
  asset:   any SVG with a <filter> on a shape whose filter region is smaller than the canvas —
           fixtures/svg/_fgraph.svg, _fgraph_disp.svg, _fgraph_turb.svg and _filter.svg all
           qualify (a graph with nodes, and a shape that does not cover the canvas).
  route:   the UNIFIED route (this cache belongs to _morphShapeFilter, which renderer.js's
           drawList loop does not use). Force it with a bundle that has LB meshes; confirm from
           debugStats that unifiedFillDraws > 0, or the arm is measuring the classic path and
           the number means nothing.
  arms:    A = this tree;  B = this tree with storeFilterResult(rootRT.tex, rootRT.rect ...)
           replaced by if (fKey && !rootRT.rect) storeFilterResult(rootRT.tex) (canvas-only caching).
  sizes:   512 and 2048. The gap MUST widen with canvas size on B and not on A: the work B
           repeats is per-fragment over the root rect, and the root rect grows with the canvas.
  read:    steady-state frame time over >= 30 frames after warm-up, AND R.debugStats' filter
           evaluation count per frame (A must be 0, B must be 1 — if A is not 0 the cache is
           not hitting and the timing arm is measuring something else).
  control: an A/A first. Cross-run comparison is worthless here (30-40% drift); interleave.
  PREDICTION, written before the run: A is faster by roughly the cost of one full graph
  evaluation plus one isolated source render per frame, so the ratio scales with node count —
  _fgraph.svg (one node) should show the smallest gap and _fgraph_turb.svg (feTurbulence, the
  most expensive node in the set) the largest. If A and B tie on _fgraph_turb at 2048, the
  cache is not being reached at all and the first thing to check is the variant term in the
  key (_lastFillVariantKey) churning.
  fill in: A/A ____ %  |  _fgraph @512 ____ x  @2048 ____ x  |  _fgraph_turb @512 ____ x
           @2048 ____ x  |  filter evals/frame A ____ B ____

GPU B  That the rect-sized cache composites in the right place. (correctness, not speed)
  Same assets, A vs the canvas-only arm B, frames BYTE-IDENTICAL from frame 2 onward. Frame 1 is
  a miss on both and is not evidence. A misplaced rect is a whole filtered shape in the wrong
  part of the canvas, so this fails loudly or not at all.
  fill in: [ ] identical frames 2..N on each asset   [ ] at 512   [ ] at 2048
`);
