// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFilterSubRectCacheSmoke — a filter graph whose root is a SUB-CANVAS rect is cached.
//
// The unified route isolates a filtered shape through `_morphShapeFilter`, which carries the
// tier-2b result cache for STATIC bundles (the morph caller passes no cacheId, because a morph's
// key misses every frame by construction). A cache that refuses any graph whose root RT is
// smaller than the canvas,
//
//     if (fKey && !rootRT.rect) storeFilterResult(rootRT.tex);
//
// misses the common case: a filter's root rect is smaller than the canvas exactly when the
// filtered shape is. A static graph-filtered shape would re-evaluate its whole GRAPH on every
// frame, forever. The classic drawList loop's `_storeFilteredTex` allocates the cache texture AT
// the rect and keeps the rect so the hit path composites it back where it belongs.
//
// The second half is the size guard on the hit path: `fEntry.w === cw && fEntry.h === ch` cannot
// pass for rect-sized entries, whose w/h are their TEXTURE's, which is the rect. A canvas resize is already a key mismatch (cw/ch are in the key), which is
// the same argument the classic loop's own comment makes.
//
// Driven from Node against a stub renderer: `_morphShapeFilter` is a closure over the renderer
// context, so this counts REAL `evaluateGraph` calls through the real function rather than
// restating the rule.
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');

const glStub = () =>
  new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null),
    },
  );

const CW = 256,
  CH = 256;

/// A renderer with just enough of the filter plumbing for _morphShapeFilter, instrumented.
/// `rootRect` is what the graph evaluation hands back: null = a full-canvas root.
function makeRenderer(rootRect) {
  const cache = new Map();
  const log = { evals: 0, composites: [], stored: [] };
  const R = {
    gl: glStub(),
    opts: {},
    draw: { overrides: null },
    _lbFillMode: 'on',
    _lbSlugOnly: false,
    _lbSlugFallback: true,
    _log: log,
    _cache: cache,
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
    _feImagePlacements: () => null,
    _wmHash: () => 0,
    _recolorHash: () => 0,
    _getFilterCache: (k) => cache.get(k) || null,
    _setFilterCache: (k, v) => cache.set(k, v),
    // Shallow structural compare — the real one lives in filterDraw and is not what changed
    // here; what changed is which results are ever OFFERED to it.
    _filterKeyMatches: (c, key) => {
      if (!c || !c.key) return false;
      for (const k of Object.keys(key)) if (c.key[k] !== key[k]) return false;
      return true;
    },
    _ensureCacheTex: (entry, field, w, h) => {
      if (entry[field] && entry.w === w && entry.h === h) return;
      entry[field] = { w, h };
      entry[field + 'Fbo'] = {};
    },
    _resultPlacement: (have, rect, cw, ch) =>
      rect
        ? { rect: rect.slice(), w: rect[2], h: rect[3], rw: rect[2], rh: rect[3], map: null }
        : { rect: null, w: cw, h: ch, rw: cw, rh: ch, map: null },
    _blitResult: (tex, fbo, pl) => {
      log.stored.push([pl.w, pl.h]);
    },
    _compositeFilteredTex: (tex, cw, ch, dst, srcRect) => {
      log.composites.push(srcRect ? srcRect.slice() : null);
    },
    _filterSingleKindComposite: () => {},
    _filterPxPerEm: () => [1, 1],
    _buildFilterCtx: () => ({}),
    _filterNodeRects: () => null,
    _filterOutputOpacity: () => 1,
    filterRecord: () => null,
    releaseRoot: () => {},
    evaluateGraph: () => {
      log.evals++;
      return { tex: { id: log.evals }, rect: rootRect };
    },
  };
  attachMorphDraw(R);
  return R;
}

const GRAPH = { nodes: [{ type: 'feGaussianBlur', params: {} }], rootOut: 0 };
const BUNDLE = { _geomGen: 7, _filterParamGen: 0, _morphSrc: null };

function frames(R, n) {
  for (let i = 0; i < n; i++) R._morphShapeFilter(BUNDLE, 0, 1, GRAPH, () => true, 'cache0');
}

console.log('\n  a sub-canvas graph root:');
{
  const RECT = [40, 40, 96, 96];
  const R = makeRenderer(RECT);
  frames(R, 3);
  ok(R._log.evals === 1, `three identical frames evaluate the graph ONCE (evals ${R._log.evals})`);
  ok(
    R._log.stored.length === 1 && R._log.stored[0][0] === 96 && R._log.stored[0][1] === 96,
    `the cached texture is allocated at the ROOT RECT, not the canvas (${JSON.stringify(R._log.stored)})`,
  );
  ok(R._log.composites.length === 3, 'all three frames still composite');
  ok(
    R._log.composites.every((c) => c && c[0] === 40 && c[1] === 40 && c[2] === 96 && c[3] === 96),
    `every composite — miss and hit alike — places the result at its rect (${JSON.stringify(R._log.composites)})`,
  );
}

console.log('\n  a full-canvas graph root is unchanged:');
{
  const R = makeRenderer(null);
  frames(R, 3);
  ok(R._log.evals === 1, `still one evaluation for three frames (evals ${R._log.evals})`);
  ok(
    R._log.stored.length === 1 && R._log.stored[0][0] === CW && R._log.stored[0][1] === CH,
    `the cached texture is canvas-sized (${JSON.stringify(R._log.stored)})`,
  );
  ok(
    R._log.composites.every((c) => c === null),
    'and no rect rides along, so the composite covers the canvas',
  );
}

console.log('\n  the key still decides:');
{
  const R = makeRenderer([40, 40, 96, 96]);
  frames(R, 2);
  const after = R._log.evals;
  BUNDLE._geomGen = 8; // the geometry moved — the key must miss
  frames(R, 1);
  BUNDLE._geomGen = 7;
  ok(
    after === 1 && R._log.evals === 2,
    `a changed geometry generation re-evaluates (${after} -> ${R._log.evals})`,
  );
}

console.log('\n  a pipeline warm never stores:');
{
  // _warmBundlePso draws this route under a 1px scissor, so what a warm renders is one pixel of
  // the shape. Stored, it is served to the real frames under the very key they ask for.
  const R = makeRenderer([40, 40, 96, 96]);
  R._psoWarming = true;
  frames(R, 1);
  R._psoWarming = false;
  ok(
    R._log.stored.length === 0,
    `the warm evaluates but stores nothing (stored ${R._log.stored.length})`,
  );
  frames(R, 2);
  ok(
    R._log.evals === 2 && R._log.stored.length === 1,
    `the first REAL frame evaluates and stores; the next hits (evals ${R._log.evals}, stores ${R._log.stored.length})`,
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
