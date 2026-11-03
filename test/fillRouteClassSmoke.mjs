// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillRouteClassSmoke — the fill route CLASS (src/renderer/fillRouteClass.js): under 'auto' a STATIC bundle draws on the cover pass and gets no
// Loop-Blinn mesh build and no MANTLE_LB_FILL variant; a morph, a streamed bundle, a forced route and a pinned mode keep the unified stream.
//
// Why: against the cover pass on identical content the unified route is slower on static art in 20 of 24 corpus cells (+10..+197 %)
// and wins only for morph (GPU lerp), streams and a pure-LB drawing at >= 2048 px. Without the class the warm would also compile
// dozens of unified programs for bundles that never draw on that route.
//
// On the real renderer over test/_fakeGl.mjs (no GPU), warmed until a variant is BOUND (prewarmBundle + precompileFills):
//   (a) the class matrix, as a pure function over option and bundle flags;
//   (b) FAILING on a tree without the class: a static bundle with curved rows large enough for the size term gets, under 'auto', no unified program
//       linked, no mesh built, route cover, gate 'static-cover';
//   (c) a PIN (setLoopBlinnFill('on')) after creation builds the meshes and takes the unified route; 'force' takes it; unifiedFill:false takes none;
//   (d) a MORPH keeps MANTLE_LB_MORPH and the unified route; its static SOURCE bundle stays on the cover pass, before and after the morph exists;
//   (e) a STREAMED (lightweight) bundle keeps the unified route;
//   (f) a static bundle later streamed, and later pinned, changes class and routes unified;
//   (g) the cases that need the cover pass's per-shape services (overrides, filters, masks, groups, hit testing) draw and answer on the cover pass without error;
//   (h) the program-count budget: a static scene's fill programs are no more than the unified-off count.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const {
  importSvg,
  createBundle,
  createRenderer,
  createShapeMorph,
  buildStreamableSections,
  updateBundleGeometry,
  createOverrideTable,
} = await import('../src/index.js');
const { fillRouteReason, fillRouteUnified } = await import('../src/renderer/fillRouteClass.js');
const { mkLine } = await import('../src/primitives/seg.js');
const warn = console.warn;
console.warn = () => {};

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy}` +
  ` C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const svg = (body, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${extra}${body}</svg>`;
const BLOBS = svg(
  [
    [30, 30],
    [70, 30],
    [30, 70],
    [70, 70],
  ]
    .map(([x, y], i) => `<path d="${blob(x, y, 18)}" fill="hsl(${i * 80},60%,45%)"/>`)
    .join(''),
);
const BLOB_A = svg(`<path d="${blob(50, 50, 20)}" fill="#c03030"/>`),
  BLOB_B = svg(`<path d="${blob(50, 50, 32)}" fill="#c03030"/>`);

// (a) the class matrix -------------------------------------------------------------------------------------------------------------------
{
  const R = (opts = {}, mode = 'auto') => ({ opts, _lbFillMode: mode });
  const cases = [
    ['static, auto', R(), {}, 'static-cover'],
    ['static, unifiedFill:false', R({ unifiedFill: false }), {}, 'opt-off'],
    ['static, force', R({ unifiedFill: 'force' }), {}, 'force'],
    ['static, staticUnified opt-in', R({ staticUnified: true }), {}, 'static-unified'],
    ['static, pinned mode on', R({}, 'on'), {}, 'pinned-mode'],
    ['static, cpatchFill', R({ cpatchFill: true }), {}, 'cpatch-pinned'],
    ['static, cpatchAuto', R({ cpatchAuto: true }), {}, 'cpatch-auto'],
    [
      'static, awaitEngine asked for lb/cpatch',
      R(),
      { _engineRequested: true },
      'engine-requested',
    ],
    [
      "static, primitives:'on' asked",
      Object.assign(R(), { _forcedPrimitivesOn: true }),
      {},
      'primitives-on',
    ],
    [
      "static, primitives:'off' asked",
      Object.assign(R(), { _forcedPrimitivesOn: false }),
      {},
      'static-cover',
    ],
    ['morph handle', R(), { _morphSrc: {} }, 'morph'],
    ['morph meshes', R(), { _morphMeshes: [] }, 'morph'],
    ['stream', R(), { _lbStream: true }, 'stream'],
    [
      'lightweight (no cover quads)',
      R(),
      { numShapes: 3, coverQuadFloats: new Float32Array(0) },
      'no-cover-quads',
    ],
    [
      'full build (cover quads)',
      R(),
      { numShapes: 3, coverQuadFloats: new Float32Array(8) },
      'static-cover',
    ],
    ['incremental stroke', R(), { _incStroke: true }, 'incremental'],
    ['stream under unifiedFill:false', R({ unifiedFill: false }), { _lbStream: true }, 'opt-off'],
    ['no bundle', R(), null, 'no-bundle'],
  ];
  for (const [name, r, b, want] of cases)
    ok(fillRouteReason(r, b === null ? null : { ...b }) === want, `(a) ${name}: ${want}`);
  ok(
    fillRouteUnified(R(), { _lbStream: true }) && !fillRouteUnified(R(), {}),
    '(a) fillRouteUnified follows the reason',
  );
}

async function scene(opts, size, build, { mode, frames = 24, world = null } = {}) {
  const F = createFakeGl({ width: size, height: size });
  const progs = new Map(),
    shDefs = new Map(),
    shKey = new Map();
  const ss = F.gl.shaderSource.bind(F.gl),
    at = F.gl.attachShader.bind(F.gl),
    lk = F.gl.linkProgram.bind(F.gl);
  F.gl.shaderSource = (sh, src) => {
    const s = String(src);
    shDefs.set(
      sh,
      [...s.matchAll(/^#define (MANTLE_[A-Z0-9_]+)/gm)].map((m) => m[1]),
    );
    const m = /\/\/ @@(\w+)/.exec(s);
    if (m) shKey.set(sh, m[1]);
    return ss(sh, src);
  };
  F.gl.attachShader = (p, sh) => {
    const e = progs.get(p) || progs.set(p, { key: null, defs: [] }).get(p);
    if (shKey.has(sh)) e.key = e.key || shKey.get(sh);
    for (const d of shDefs.get(sh) || []) if (!e.defs.includes(d)) e.defs.push(d);
    return at(p, sh);
  };
  F.gl.linkProgram = (p) => {
    const e = progs.get(p);
    if (e) e.linked = true;
    return lk(p);
  };
  const R = createRenderer(F.gl, taggedShaderSources(), { ...opts });
  if (mode) R.setLoopBlinnFill(mode);
  R.setViewport(size, size);
  const items = await build(F.gl, R);
  const draw = (n, w = world) => {
    for (let i = 0; i < n; i++) {
      R.beginFrame([1, 1, 1, 1]);
      for (const it of items) R.drawBundle(it, w ? { worldMatrix: w } : undefined);
      R.endFrame();
      R.precompileFills();
    }
  };
  for (const it of items) {
    if (R.prepareBundle) R.prepareBundle(it);
  }
  for (const it of items) {
    if (R.awaitLbReady) {
      try {
        await R.awaitLbReady(it, 20000);
      } catch {
        /* reported by the counts */
      }
    }
  }
  for (const it of items) R.prewarmBundle(it);
  draw(frames);
  const fill = () =>
    [...progs.values()].filter((e) => e.linked && (e.key === 'fillFrag' || e.key === 'fillVert'));
  const routes = () => ({ ...((R.debugStats.engines || {}).routes || {}) });
  return {
    R,
    F,
    items,
    draw,
    fill,
    lb: () => fill().filter((e) => e.defs.includes('MANTLE_LB_FILL')).length,
    lbMorph: () => fill().filter((e) => e.defs.includes('MANTLE_LB_MORPH')).length,
    routes,
    gate: () => R.debugStats.unifiedFillGate,
    reason: () => R.debugStats.fillRouteReason,
  };
}
const meshesBuilt = (b) => Array.isArray(b._lbMeshes) && b._lbMeshes.some((m) => m && !m.slug);
const mk = async (gl, text) => createBundle(gl, await importSvg(text, { preserveViewport: true }));

// (b) a static bundle in 'auto' ---------------------------------------------------------------------------------------------------------
{
  const s = await scene({}, 2048, async (gl) => [await mk(gl, BLOBS)]); // 2048 px: fit bbox ~ 2.3e6 px2, over LB_MIN_BUNDLE_PX2: a size-only policy takes meshes here
  const r = s.routes();
  ok(s.lb() === 0, `(b) static, auto, 2048 px: no MANTLE_LB_FILL program linked (${s.lb()})`);
  ok(!meshesBuilt(s.items[0]), '(b) no Loop-Blinn mesh was built for the static bundle');
  ok(
    !r.unified && s.gate() === 'static-cover' && s.reason() === 'static-cover',
    `(b) route cover, gate '${s.gate()}', reason '${s.reason()}', unified draws ${r.unified | 0}`,
  );
}
// (c) pins ------------------------------------------------------------------------------------------------------------------------------
{
  const on = await scene({}, 2048, async (gl) => [await mk(gl, BLOBS)], { mode: 'on' });
  ok(
    meshesBuilt(on.items[0]) && on.lb() > 0 && (on.routes().unified | 0) > 0,
    `(c) setLoopBlinnFill('on'): meshes built, ${on.lb()} unified program(s), unified draws ${on.routes().unified | 0}`,
  );
  const fc = await scene({ unifiedFill: 'force' }, 512, async (gl) => [await mk(gl, BLOBS)]);
  ok(
    fc.lb() > 0 && (fc.routes().unified | 0) > 0,
    `(c) unifiedFill:'force': unified (${fc.lb()} program(s))`,
  );
  const off = await scene({ unifiedFill: false }, 2048, async (gl) => [await mk(gl, BLOBS)]);
  ok(
    off.lb() === 0 && !(off.routes().unified | 0),
    '(c) unifiedFill:false: no unified program, no unified draw',
  );
  // a pin AFTER creation and the first draws
  const late = await scene({}, 2048, async (gl) => [await mk(gl, BLOBS)]);
  late.R.setLoopBlinnFill('on');
  for (const it of late.items) {
    try {
      await late.R.awaitLbReady(it, 20000);
    } catch {
      /* counts */
    }
    late.R.prewarmBundle(it);
  }
  late.draw(24);
  ok(
    meshesBuilt(late.items[0]) && late.lb() > 0,
    `(c) pin after creation: meshes built on demand, ${late.lb()} unified program(s)`,
  );
}
// (d) morph -----------------------------------------------------------------------------------------------------------------------------
{
  let a, b;
  const s = await scene({}, 512, async (gl) => {
    a = await mk(gl, BLOB_A);
    b = await mk(gl, BLOB_B);
    return [a]; // the source pose is drawn STATIC first
  });
  ok(
    s.lb() === 0 && !(s.routes().unified | 0),
    `(d) the static source pose draws on the cover pass before any morph (${s.lb()} unified programs)`,
  );
  const m = createShapeMorph(s.F.gl, a, b);
  s.items.push(m);
  s.R.prepareBundle(m);
  try {
    await s.R.awaitLbReady(m, 20000);
  } catch {
    /* counts */
  }
  s.R.prewarmBundle(m);
  m.setT(0.5);
  const unified0 = s.routes().unified | 0;
  s.draw(24);
  ok(
    s.lbMorph() > 0 && (s.routes().unified | 0) > unified0,
    `(d) static -> morph at runtime: ${s.lbMorph()} MANTLE_LB_MORPH program(s), unified draws ${unified0} -> ${s.routes().unified | 0}`,
  );
  ok(
    fillRouteReason({ opts: {}, _lbFillMode: 'auto' }, a) === 'static-cover',
    '(d) the source pose bundle itself is still the static class',
  );
}
// (e)(f) streamed -----------------------------------------------------------------------------------------------------------------------
{
  const VBOX = [0, 0, 100, 100];
  const rectSegs = (x, y, w, h) => [
    mkLine([x, y], [x + w, y]),
    mkLine([x + w, y], [x + w, y + h]),
    mkLine([x + w, y + h], [x, y + h]),
    mkLine([x, y + h], [x, y]),
  ];
  const light = (gl) =>
    createBundle(
      gl,
      buildStreamableSections([{ segs: rectSegs(10, 10, 60, 60), fill: [1, 0, 0, 1] }], VBOX, {
        lightweight: true,
      }),
    );
  const s = await scene({}, 256, async (gl) => {
    const b = light(gl);
    updateBundleGeometry(gl, b, [rectSegs(12, 12, 60, 60)]);
    return [b];
  });
  ok(
    (s.routes().unified | 0) > 0 && s.lb() > 0,
    `(e) a lightweight streamed bundle keeps the unified route (${s.lb()} program(s), unified draws ${s.routes().unified | 0})`,
  );
  // (f) a normal static bundle, drawn on the cover pass, then streamed
  const t = await scene({}, 256, async (gl) => [
    createBundle(
      gl,
      buildStreamableSections([{ segs: rectSegs(10, 10, 60, 60), fill: [1, 0, 0, 1] }], VBOX, {}),
    ),
  ]);
  const before = t.routes().unified | 0;
  updateBundleGeometry(t.F.gl, t.items[0], [rectSegs(20, 20, 50, 50)], { lightweight: true });
  try {
    await t.R.awaitLbReady(t.items[0], 20000);
  } catch {
    /* counts */
  }
  t.R.prewarmBundle(t.items[0]);
  t.draw(24);
  ok(
    before === 0 && t.reason() !== 'static-cover' && (t.routes().unified | 0) > 0,
    `(f) static bundle: cover before the stream (unified draws ${before}), after updateBundleGeometry: reason '${t.reason()}', unified draws ${t.routes().unified | 0}`,
  );
}
// (g) per-shape services stay on the cover pass and keep working -----------------------------------------------------------------------------
{
  const body =
    `<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><mask id="m"><rect width="100" height="100" fill="white"/></mask><clipPath id="c"><rect width="80" height="80"/></clipPath></defs>` +
    `<g opacity="0.8"><path d="${blob(30, 30, 18)}" fill="#3060c0" filter="url(#f)"/><path d="${blob(70, 30, 18)}" fill="#c06030" mask="url(#m)"/><path d="${blob(50, 70, 18)}" fill="#30c060" clip-path="url(#c)"/></g>`;
  let threw = null,
    s;
  try {
    s = await scene({}, 1024, async (gl) => [await mk(gl, svg(body))]);
    s.draw(4, [0.5, 0, 0, 0, 0.5, 0, 0.1, 0.1, 1]);
  } catch (e) {
    threw = e;
  }
  ok(
    !threw && s && s.lb() === 0 && !(s.routes().unified | 0),
    `(g) filter + mask + clip + group on a static bundle: cover pass, no unified program${threw ? ' (' + threw.message + ')' : ''}`,
  );
  threw = null;
  try {
    const t = await scene({}, 512, async (gl) => [await mk(gl, BLOBS)]);
    const ov = createOverrideTable(t.F.gl, t.items[0]);
    if (ov && ov.setFill) ov.setFill(1, [1, 1, 0, 1]);
    for (let i = 0; i < 3; i++) {
      t.R.beginFrame([1, 1, 1, 1]);
      t.R.drawBundle(t.items[0], ov ? { overrides: ov } : undefined);
      t.R.endFrame();
    }
    const hit = t.R.hitTest ? t.R.hitTest(t.items[0], 30, 30) : true;
    ok(
      hit !== undefined,
      '(g) override draw and hit test on a static bundle run on the cover pass',
    );
  } catch (e) {
    threw = e;
    ok(false, `(g) override / hit test threw: ${e.message}`);
  }
}
// (h) program-count budget --------------------------------------------------------------------------------------------------------------
{
  const mkScene = async (opts) =>
    scene(opts, 1024, async (gl) => [
      await mk(gl, BLOBS),
      await mk(gl, BLOB_A),
      await mk(
        gl,
        svg(
          `<rect x="10" y="10" width="80" height="80" fill="#3060c0"/><circle cx="50" cy="50" r="20" fill="#fff"/>`,
        ),
      ),
    ]);
  const a = await mkScene({}),
    o = await mkScene({ unifiedFill: false });
  ok(
    a.fill().length <= o.fill().length && a.lb() === 0,
    `(h) static scene: ${a.fill().length} fill programs under auto, ${o.fill().length} with unifiedFill:false, ${a.lb()} unified`,
  );
}
console.warn = warn;
console.log(fail ? `FAIL ${fail}` : 'PASS fillRouteClassSmoke');
process.exit(fail ? 1 : 0);
