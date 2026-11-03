// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// debugHookGateSmoke — a test hook changes output only under __MANTLE_DEBUG__, on the main thread
// AND through the worker pools.
//
// THE RULE. A global that exists so a test or probe can force a path is a TEST HOOK, and a hook
// left set on a live page must not change what ships. So every hook reads through
// mantleDebugHook (core/diagnostics.js), which answers `undefined` unless
// `globalThis.__MANTLE_DEBUG__ === true`, exactly as the boolean mantleDebugFlag hooks do.
//
// THE WORKERS. A hook read inside a pooled build is read in the WORKER's global scope, which only
// sees what the pool's forwarder copies across. If `__MANTLE_DEBUG__` did not travel with the
// hooks, every worker-side hook would read as unset whatever the page said -- the same defect
// class as module-scope reads. So the pooled arms here run the REAL pools (requestLbBuild,
// convertContoursPooled) against a stand-in `Worker` that hands each message to the worker
// module's own onmessage with the PAGE's globals hidden: whatever reaches the build got there in
// the message the pool built, and nothing else.
//
// Per hook, three runs: nothing set (the default); the hook set with debug off, which must equal
// the default; the hook set with debug on, which must differ from it (non-vacuity: the hook is
// live, so the gate is what stopped it).
//
// THE OPTION. createRenderer's `fillDefines` option is the same hook in option form, gated the same way and
// warned about once per page when it is dropped (the last section).
import path from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}

// ---- a Worker that runs the worker module in this thread, with the page's globals hidden -------
const handlers = {};
let current = null;
const posts = { lb: 0, cpatch: 0 };
globalThis.self = {
  postMessage: (m) => {
    const w = current;
    const data = structuredClone(m);
    setTimeout(() => {
      if (w && w.onmessage) w.onmessage({ data });
    }, 0);
  },
};
await import('../src/renderer/lbBuild.worker.js');
handlers.lb = self.onmessage;
await import('../src/renderer/cpatch.worker.js');
handlers.cpatch = self.onmessage;
const PAGE_GLOBAL = (k) => k.startsWith('__');
class StandInWorker {
  constructor(url) {
    this.kind = String(url).includes('lbBuild.worker') ? 'lb' : 'cpatch';
    this.onmessage = null;
  }
  postMessage(msg) {
    // THE BOUNDARY: a structured clone, as a real postMessage makes -- and it throws on a function,
    // which is the other half of what a forwarder must get right.
    const data = structuredClone(msg);
    setTimeout(() => {
      const saved = {};
      for (const k of Object.keys(globalThis))
        if (PAGE_GLOBAL(k)) {
          saved[k] = globalThis[k];
          delete globalThis[k];
        }
      posts[this.kind]++;
      current = this;
      try {
        handlers[this.kind]({ data });
      } finally {
        current = null;
        for (const k of Object.keys(globalThis)) if (PAGE_GLOBAL(k)) delete globalThis[k];
        Object.assign(globalThis, saved);
      }
    }, 0);
  }
  terminate() {}
}
globalThis.Worker = StandInWorker;

const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, packLbMeshForWire } = await import('../src/renderer/lbBuildCore.js');
const { requestLbBuild } = await import('../src/renderer/lbWorkerPool.js');
const { convertContoursPooled } = await import('../src/renderer/cpatchWorkerPool.js');
const { convertContour } = await import('../src/renderer/cpatchConvert.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const {
  headlessCPatchBundle,
  buildCPatchBundle,
  contoursToConverter,
  cpatchCurvePlane,
  shapeEvenOdd,
} = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { attachFillPass } = await import('../src/renderer/fillPass.js');
const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');

const digest = (v) =>
  createHash('sha1')
    .update(
      JSON.stringify(v, (_k, x) =>
        ArrayBuffer.isView(x)
          ? Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('base64')
          : x,
      ),
    )
    .digest('hex')
    .slice(0, 16);

/// Run `fn` with nothing set, with the hook set and debug off, and with both set. Returns the three
/// answers. The page is left clean either way.
async function arms(key, value, fn) {
  const clean = () => {
    delete globalThis[key];
    delete globalThis.__MANTLE_DEBUG__;
  };
  clean();
  const out = {};
  try {
    out.def = await fn();
    globalThis[key] = value;
    out.off = await fn();
    globalThis.__MANTLE_DEBUG__ = true;
    out.on = await fn();
  } finally {
    clean();
  }
  return out;
}
function judge(name, where, r) {
  ok(r.off === r.def, `${name} (${where}): set with debug OFF, the output is the default`);
  ok(r.on !== r.def, `${name} (${where}): set with debug ON, the hook acts (${r.def} -> ${r.on})`);
}

// ---- fixtures ------------------------------------------------------------------------------------
const svgOf = (f) => readFileSync(path.join(ROOT, 'examples/smoke', f), 'utf8');
async function lbInput(svg) {
  const sec = await importSvg(svg);
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  return {
    sec,
    curveFloats: new Float32Array(sec.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: sec.curveRangesByShape,
    numShapes: sec.numShapes,
  };
}
// Shapes each LB hook is known to move (from building the smoke corpus with the hook on).
const AUDIT = await lbInput(svgOf('gwnTreeHook__SVG.svg'));
const BLOB = await lbInput(svgOf('engineSelectionTerms__svgOf_SMALLBLOB.svg'));
// A blob with concave cubics, whose interior chains carry arcs in chain 1 and chain 2.
const CONCAVE = await lbInput(svgOf('lbComposeOrder__BLOB.svg'));
// A blob with Bezout rings, which carry their arcs.
const BEZBLOB = await lbInput(svgOf('fillBezoutOmit__BLOB.svg'));
/// One digest for both paths: the per-shape cause and the wire form of every mesh.
const lbOut = (why, packed) =>
  digest({
    why: why ? Array.from(why) : null,
    p: (packed || []).map((pk) => (pk ? pk.verts : null)),
  });
const lbMain = (inp) => {
  const r = buildLbBundle({ ...inp });
  return lbOut(r.why, r.packed.map(packLbMeshForWire));
};
const lbPooled = (inp) =>
  new Promise((resolve) => {
    const bundle = {
      curveFloats: inp.curveFloats,
      metaFloats: inp.metaFloats,
      metaFloatsPerShape: inp.metaFloatsPerShape,
      curveRangesByShape: inp.ranges,
      numShapes: inp.numShapes,
    };
    requestLbBuild(bundle, (d) => resolve(d.err ? 'error: ' + d.err : lbOut(d.why, d.packed)));
  });

const K = 6;
const cpBlob = (() => {
  const at = (j) => [
    100 + 40 * Math.cos((2 * Math.PI * j) / K),
    100 + 40 * Math.sin((2 * Math.PI * j) / K),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.44;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    out.push({
      t: 'cubic',
      P: [
        A,
        [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
        [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
        B,
      ],
    });
  }
  return out;
})();
const convOut = (r) =>
  r
    ? digest({
        n: r.patches.length,
        c: r.patches.map((p) => p.curves.map((c) => c.P)),
        norm: !!(r.stats && r.stats.normalized),
      })
    : 'declined';
const cpMain = () => {
  try {
    return convOut(convertContour(cpBlob, {}));
  } catch (ex) {
    return 'threw ' + ex.message;
  }
};
const cpPooled = async () => {
  const [r] = await convertContoursPooled([cpBlob], {});
  return r && r.patches ? convOut(r.patches) : 'none: ' + (r && r.err);
};

// A CPatch shape to pack, from an SVG through the importer, the way the build reaches the packer.
const TIGERISH =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 C120 130 190 90 150 40 Z"/></svg>';
// The pack hooks (__CP_GRID, __CP_ONLY_PATCH) act on the seam route. A polynomial shape tends to leave that route for the area
// certificate (even a cubic lens drawn twice: the arrangement keeps one of each coincident edge, so it extracts one certifiable
// cycle). That certificate is for polynomial curves only, so the
// pack arms use rational curves: a rotated ellipse's arcs, which pack as several patches. The premise is checked below, so a shape
// that stops reaching the route reads as that and not as a dead hook.
const ROTATED_ARCS =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M20 100A80 60 30 0 1 180 100A80 40 30 0 1 20 100Z"/></svg>';
const cpB = headlessCPatchBundle(await importSvg(ROTATED_ARCS));
const cpContours = curveRangeToContours(
  cpatchCurvePlane(cpB),
  cpB.curveRangesByShape[0].begin,
  cpB.curveRangesByShape[0].end,
);
const packOut = () => {
  const m = packCPatchShape(contoursToConverter(cpContours, null), 0, {
    evenOdd: shapeEvenOdd(cpB, 0),
  });
  return m ? digest({ n: m.vertexCount, v: m.verts }) : 'declined';
};

// ---- a renderer just complete enough for the fill pass (see fillBezoutOmitSmoke) -----------------
const makeGl = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? k : () => null) },
  );
function makeRenderer(calls) {
  const compiled = [];
  const R = {
    gl: makeGl(),
    opts: { aacFill: 'auto' },
    draw: {},
    _lbFillMode: 'auto',
    _compiled: compiled,
    viewportSize: () => [256, 256],
    arScale: 1,
    dummyDashTex: null,
    dummyGradientTex: null,
    dummyGradientStops: null,
    IDENTITY_COLOR_MATRIX: new Float32Array(16),
    ZERO_OFFSET: new Float32Array(4),
    fillProg: {},
    shaderSources: { fillVert: '', fillFrag: '' },
    withDefines: (s) => s,
    program: (_v, _f, tag) => {
      compiled.push(tag);
      return {};
    },
    glEnable: (c) => calls && calls.push('enable ' + c),
    glDisable: (c) => calls && calls.push('disable ' + c),
    bindFb: () => {},
    glBindVertexArray: () => {},
    glViewport: () => {},
    glBlendFunc: () => {},
    glUseProgram: () => {},
    glDepthMask: () => {},
    glDepthFunc: () => {},
    mantleError: () => {},
    mantleWarn: () => {},
  };
  attachUnifiedFillDraw(R);
  attachFillPass(R);
  return R;
}
const definesFor = (bundle) => {
  const R = makeRenderer(null);
  R.prewarmFillVariant(bundle);
  const out = new Set();
  for (const t of R._compiled)
    if (t && t.startsWith('fill:'))
      for (const d of t.replace(/^fill:(prewarm:)?/, '').split('|')) if (d) out.add(d);
  return [...out].sort().join('|');
};
const lbBundleOf = (inp, extraMask = 0) => {
  const res = buildLbBundle({ ...inp });
  const meshes = res.packed.map((pk) =>
    pk && !pk.slug && (pk.vertexCount | 0) > 0
      ? {
          verts: pk.verts,
          vertexCount: pk.vertexCount,
          hasBezout: !!pk.hasBezout,
          prim: !!pk.prim,
          kindMask: pk.kindMask | 0 | extraMask,
        }
      : null,
  );
  return {
    numShapes: inp.numShapes,
    numFillShapes: inp.numShapes,
    drawList: [{ kind: 'shape', shapeIdx: 0 }],
    segTypeMask: 0xf,
    _lbMeshes: meshes,
    _geomGen: 1,
    _lbAdoptKey: 0,
    meshes,
  };
};
const lbB = lbBundleOf(BLOB),
  cpFillB = lbBundleOf(BLOB, 1 << 14);
const depthCalls = () => {
  const calls = [];
  const R = makeRenderer(calls);
  R._handle = { bundle: lbB, triVao: null };
  try {
    R.beginFillPass();
  } catch {
    /* the stub runs out past the depth state; that is all this reads */
  }
  return calls.filter((c) => /DEPTH_TEST/.test(c)).join(',') || 'none';
};

// ---- main thread -----------------------------------------------------------------------------------
console.log('main thread:');
judge(
  '__MANTLE_FILL_DEFINES',
  'fill variant',
  await arms('__MANTLE_FILL_DEFINES', 'MANTLE_DEBUG_HOOK_PROBE', () => definesFor(lbB)),
);
judge(
  '__CP_DEFINES',
  'CPatch fill variant',
  await arms('__CP_DEFINES', 'MANTLE_DEBUG_HOOK_PROBE', () => definesFor(cpFillB)),
);
judge(
  '__MANTLE_NO_DEPTH',
  'fill pass depth state',
  await arms('__MANTLE_NO_DEPTH', true, depthCalls),
);
judge('__lbAuditOff', 'buildLbBundle', await arms('__lbAuditOff', 1, () => lbMain(AUDIT)));
judge(
  '__LB_CUBIC_FASTPATH',
  'buildLbBundle',
  await arms('__LB_CUBIC_FASTPATH', true, () => lbMain(BLOB)),
);
judge(
  '__LB_CUBIC_CHAIN',
  'buildLbBundle',
  await arms('__LB_CUBIC_CHAIN', false, () => lbMain(CONCAVE)),
);
judge(
  '__LB_CUBIC_CHAIN2',
  'buildLbBundle',
  await arms('__LB_CUBIC_CHAIN2', false, () => lbMain(CONCAVE)),
);
judge(
  '__LB_BEZ_RING_ARC',
  'buildLbBundle',
  await arms('__LB_BEZ_RING_ARC', false, () => lbMain(BEZBLOB)),
);
judge(
  '__LB_EMIT_ORDER',
  'buildLbBundle',
  await arms('__LB_EMIT_ORDER', false, () => lbMain(BEZBLOB)),
);
judge(
  '__LB_STATIC_HULL',
  'buildLbBundle',
  await arms('__LB_STATIC_HULL', true, () => lbMain(CONCAVE)),
);
{
  // A morph whose inflection moves: the serpentine pair by default, the fine t-cells with the hook.
  const { mkLine, mkCubic } = await import('../src/primitives/seg.js');
  const { buildMorphShape } = await import('../src/renderer/lbMorphCore.js');
  const sh = (a) => [
    [
      mkCubic([0, 0], [a, 100], [50, -100], [100, 0]),
      mkLine([100, 0], [100, 150]),
      mkLine([100, 150], [0, 150]),
      mkLine([0, 150], [0, 0]),
    ],
  ];
  const meta = new Float32Array(40);
  meta[28] = 1;
  meta[7] = 1;
  const morphOut = () => {
    const r = buildMorphShape(sh(50), sh(51), meta, meta, 0, 40),
      m = r && r.mesh;
    return m
      ? digest({
          n: m.segments ? m.segments.length : 1,
          v: m.segments ? m.segments.map((g) => g.vbo) : m.vbo,
        })
      : 'slug';
  };
  judge(
    '__LB_SERPENTINE_PAIR',
    'buildMorphShape',
    await arms('__LB_SERPENTINE_PAIR', false, morphOut),
  );
}
judge('__CP_OPTS', 'convertContour', await arms('__CP_OPTS', { maxCurves: 3 }, cpMain));
{
  const m = packCPatchShape(contoursToConverter(cpContours, null), 0, {
    evenOdd: shapeEvenOdd(cpB, 0),
  });
  ok(
    m && !m.cpatchAreaOnly && m.vertexCount > 0,
    "the pack arms' shape takes the seam route, where the pack hooks act, not the area route",
  );
}
judge('__CP_GRID', 'packCPatchShape', await arms('__CP_GRID', 2, packOut));
judge('__CP_ONLY_PATCH', 'packCPatchShape', await arms('__CP_ONLY_PATCH', 0, packOut));
const glStub = {
  TEXTURE_2D: 1,
  RGBA32F: 2,
  RGBA: 3,
  FLOAT: 4,
  TEXTURE_MIN_FILTER: 5,
  TEXTURE_MAG_FILTER: 6,
  TEXTURE_WRAP_S: 7,
  TEXTURE_WRAP_T: 8,
  NEAREST: 9,
  CLAMP_TO_EDGE: 10,
  bindTexture() {},
  texParameteri() {},
  texImage2D() {},
  createTexture() {
    return {};
  },
};
judge(
  '__CP_TEST_DECLINE_ALL',
  'buildCPatchBundle',
  await arms('__CP_TEST_DECLINE_ALL', true, async () => {
    const b = headlessCPatchBundle(await importSvg(TIGERISH));
    buildCPatchBundle(glStub, b, { pool: false });
    return String(b._cpatchBail || 'built');
  }),
);

// ---- through the pools -------------------------------------------------------------------------------
console.log("through the worker pools (the page's globals hidden from the worker):");
judge('__lbAuditOff', 'requestLbBuild', await arms('__lbAuditOff', 1, () => lbPooled(AUDIT)));
judge(
  '__LB_CUBIC_FASTPATH',
  'requestLbBuild',
  await arms('__LB_CUBIC_FASTPATH', true, () => lbPooled(BLOB)),
);
judge(
  '__LB_CUBIC_CHAIN',
  'requestLbBuild',
  await arms('__LB_CUBIC_CHAIN', false, () => lbPooled(CONCAVE)),
);
judge(
  '__LB_BEZ_RING_ARC',
  'requestLbBuild',
  await arms('__LB_BEZ_RING_ARC', false, () => lbPooled(BEZBLOB)),
);
judge(
  '__LB_EMIT_ORDER',
  'requestLbBuild',
  await arms('__LB_EMIT_ORDER', false, () => lbPooled(BEZBLOB)),
);
judge(
  '__LB_STATIC_HULL',
  'requestLbBuild',
  await arms('__LB_STATIC_HULL', true, () => lbPooled(CONCAVE)),
);
judge('__CP_OPTS', 'convertContoursPooled', await arms('__CP_OPTS', { maxCurves: 3 }, cpPooled));
ok(
  posts.lb >= 12 && posts.cpatch >= 3,
  `the builds ran in the stand-in workers, not a main-thread fallback (${posts.lb} LB, ${posts.cpatch} CPatch messages)`,
);
// And the pooled answer IS the main-thread answer, so the forwarder carried everything that matters.
{
  const a = await arms('__LB_CUBIC_FASTPATH', true, () => lbPooled(BLOB));
  const b = await arms('__LB_CUBIC_FASTPATH', true, () => lbMain(BLOB));
  ok(a.on === b.on && a.def === b.def, 'pooled and main-thread LB builds agree, hook on and off');
  const c = await arms('__CP_OPTS', { maxCurves: 3 }, cpPooled),
    d = await arms('__CP_OPTS', { maxCurves: 3 }, cpMain);
  ok(
    c.on === d.on && c.def === d.def,
    'pooled and main-thread CPatch conversions agree, hook on and off',
  );
}

// ---- the fillDefines option -------------------------------------------------------------------------
// createRenderer's `fillDefines` compiles arbitrary defines into every fill program: a kernel no default draw runs, an omission
// that paints wrong when the content has the feature, an experimental arm. Like `__MANTLE_FILL_DEFINES` it takes effect only
// while `globalThis.__MANTLE_DEBUG__ === true`; otherwise createRenderer warns ONCE per page and drops it. Checked on the real
// renderer over test/_fakeGl.mjs (no GPU), by the program a draw binds:
//   (a) without debug: MANTLE_HARD passed through fillDefines is absent from the bound program, and the warning is
//       said once for two renderers;
//   (b) with debug: the same option is in the bound program;
//   (c) `aacFill: true`, which the renderer itself bakes into the field, still binds MANTLE_AAC without debug;
//   (d) an empty list is not a use of the hook: no warning.
console.log('the fillDefines option:');
{
  const debugWas = globalThis.__MANTLE_DEBUG__;
  const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
  const { importSvg: importSvgApi, createBundle, createRenderer } = await import('../src/index.js');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => {
    const m = a.map(String).join(' ');
    if (/fillDefines/.test(m)) warnings.push(m);
  };

  const FD_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 20 L50 90 Z" fill="#48c"/></svg>';
  const sec = await importSvgApi(FD_SVG);
  async function boundDefs(opts, kernel = 'slug') {
    const F = createFakeGl({ width: 128, height: 128 });
    // aacPoints:false: a small draw takes the vertex-stage point route, which binds no fill variant; this is about the fill program
    const R = createRenderer(F.gl, taggedShaderSources(), { ...opts, aacPoints: false });
    R.setFillEngine({ route: 'none', kernel });
    const b = createBundle(F.gl, sec);
    R.setViewport(128, 128);
    R.prewarmBundle(b);
    // the BASE program draws until a variant warms; either one carries the renderer's fillDefines
    let key = null;
    for (let i = 0; i < 8; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      R.precompileFills();
      key = R.debugStats.drawnFillVariantKey;
      if (i >= 2 && key) break;
    }
    const defs = new Set(String(key || '').split('|'));
    try {
      R.dispose();
    } catch {
      /* headless */
    }
    return defs;
  }

  // (a)
  delete globalThis.__MANTLE_DEBUG__;
  const off1 = await boundDefs({ fillDefines: ['MANTLE_HARD', 'MANTLE_GWN'] });
  const off2 = await boundDefs({ fillDefines: ['MANTLE_HARD', 'MANTLE_GWN'] });
  ok(
    !off1.has('MANTLE_HARD') && !off2.has('MANTLE_HARD'),
    '(a) without __MANTLE_DEBUG__, fillDefines does not reach the bound program',
  );
  ok(
    warnings.length === 1,
    `(a) ...and createRenderer says so once for two renderers (${warnings.length} warning(s))`,
  );
  // (b)
  globalThis.__MANTLE_DEBUG__ = true;
  const on = await boundDefs({ fillDefines: ['MANTLE_HARD', 'MANTLE_GWN'] });
  delete globalThis.__MANTLE_DEBUG__;
  ok(
    on.has('MANTLE_HARD') && on.has('MANTLE_GWN'),
    `(b) with __MANTLE_DEBUG__ it does (bound: ${[...on].filter((d) => /HARD|GWN/.test(d)).join('+') || 'none'})`,
  );
  // (c)
  const aac = await boundDefs({ aacFill: true }, 'aac');
  ok(aac.has('MANTLE_AAC'), '(c) AAC selection compiles MANTLE_AAC without debug');
  const switched = await boundDefs({ aacFill: true }, 'slug');
  ok(!switched.has('MANTLE_AAC'), '(c) switching from initial AAC selects a Slug program');
  // (d)
  const n0 = warnings.length;
  await boundDefs({ fillDefines: [] });
  ok(warnings.length === n0, '(d) an empty fillDefines is not a use of the hook: no warning');
  console.warn = warn;
  if (debugWas === undefined) delete globalThis.__MANTLE_DEBUG__;
  else globalThis.__MANTLE_DEBUG__ = debugWas;
}

if (fail) {
  console.log(`FAIL debugHookGateSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS debugHookGateSmoke');
process.exit(0);
