// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// declareStreamSmoke -- renderer.declareStream(bundle): the app says an imported bundle will be streamed, and the loading call builds what its updates bind.
//
// An imported bundle's key leaves out whatever its art does not hold, so an update that brings a new segment type, or takes away a monotone certificate or a primitive, moves the key: 1 link, 1 pipeline,
// 1 blocked at its first update under the stand-in-free default. Declared, its first and later updates link and build nothing, in every warm draw state, under every policy. Undeclared, the warm is
// unchanged, key for key. CPU, driver-model stand-in (test/_pendingGl.mjs). Same picture on the GPU: streamWarmRenderSmoke.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const {
  createRenderer,
  createBundle,
  importSvg,
  buildStreamableSections,
  updateBundleGeometry,
  mkLine,
  mkCubic,
  mkQuad,
} = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const STRICT = { asyncShaderCompile: true, nonBlocking: true, standIns: false, strictPlay: true };
async function mk(o = STRICT) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const R = createRenderer(W.gl, taggedShaderSources(), o);
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(512, 512);
  return { W, R };
}
const frame = (R, fn) => {
  R.beginFrame([1, 1, 1, 1]);
  fn();
  R.endFrame();
};
const cubic = (d) => [
  mkCubic([10 + d, 10], [20 + d, 20], [40 + d, 40], [60 + d, 90]),
  mkLine([60 + d, 90], [10 + d, 90]),
  mkLine([10 + d, 90], [10 + d, 10]),
];
const lines = (d) => [
  mkLine([10 + d, 10], [60 + d, 90]),
  mkLine([60 + d, 90], [10 + d, 90]),
  mkLine([10 + d, 90], [10 + d, 10]),
];
const quad = (d) => [
  mkQuad([10 + d, 10], [40 + d, 20], [60 + d, 90]),
  mkLine([60 + d, 90], [10 + d, 90]),
  mkLine([10 + d, 90], [10 + d, 10]),
];
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const MONO = svg('<path id="a" d="M10 10 C 20 20 40 40 60 90 L 10 90 L 10 10 Z" fill="#303"/>');
const ART = {
  'monotone cubics': MONO,
  lines: svg('<path d="M10 10 L 60 90 L 10 90 Z" fill="#303"/>'),
  'a rect primitive': svg('<rect x="10" y="10" width="50" height="50" fill="#303"/>'),
  'a circle': svg('<circle cx="50" cy="50" r="30" fill="#303"/>'),
  'a gradient': svg(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 L 60 90 L 10 90 Z" fill="url(#g)"/>',
  ),
};
const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const TINT = new Float32Array([0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1]);
const STATES = {
  'as drawn': {},
  rotated: { worldMatrix: ROT },
  recolored: { colorMatrix: TINT },
  both: { worldMatrix: ROT, colorMatrix: TINT },
};
const marks = (W, R) => [W.model.links, W.model.pipelines, R.debugStats.needMiss.blocked | 0];
const moved = (W, R, m) => {
  const n = marks(W, R);
  return [n[0] - m[0], n[1] - m[1], n[2] - m[2]];
};
const none = (d) => d[0] === 0 && d[1] === 0 && d[2] === 0;
const say = (d) => `${d[0]} links, ${d[1]} pipelines, ${d[2]} blocked`;

console.log('(the premise) undeclared, the first update builds in play');
{
  const { W, R } = await mk();
  const b = createBundle(W.gl, await importSvg(MONO, { preserveViewport: true }));
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  updateBundleGeometry(W.gl, b, [cubic(2)]);
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const d = moved(W, R, m);
  ok(d[0] === 1 && d[1] === 1 && d[2] === 1, `1 link, 1 pipeline, 1 blocked (${say(d)})`);
  R.dispose();
}

console.log('(declared) the first update and the later ones build nothing');
{
  const { W, R } = await mk();
  const b = createBundle(W.gl, await importSvg(MONO, { preserveViewport: true }));
  R.declareStream(b);
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  const r = updateBundleGeometry(W.gl, b, [cubic(2)]);
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  ok(r.ok && none(moved(W, R, m)), `first update (${say(moved(W, R, m))})`);
  const m2 = marks(W, R);
  for (const [n, s] of [
    [4, cubic],
    [6, lines],
    [8, quad],
  ]) {
    updateBundleGeometry(W.gl, b, [s(n)]);
    for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  }
  ok(
    none(moved(W, R, m2)),
    `later updates, one bringing a new segment type (${say(moved(W, R, m2))})`,
  );
  ok(
    (R.debugStats.needMiss.kOutsideWarmSet | 0) === 0,
    `no key outside the warm image (${R.debugStats.needMiss.kOutsideWarmSet | 0})`,
  );
  R.dispose();
}

console.log('(declared) every art, every warm draw state, any segment type');
// One renderer per art, one declared bundle per (state, update). The bundles are the same art under the same declaration, so the loading call builds one image
// for all of them, the one a renderer holding any single one of them builds; a program one bundle's update would build in play fails that bundle's check.
for (const [name, src] of Object.entries(ART)) {
  const { W, R } = await mk();
  const cases = [];
  for (const [sn, st] of Object.entries(STATES))
    for (const [un, s] of [
      ['lines', lines],
      ['a quad', quad],
      ['a cubic', cubic],
    ]) {
      const b = createBundle(W.gl, await importSvg(src, { preserveViewport: true }));
      R.declareStream(b);
      cases.push({ sn, st, un, s, b });
    }
  await R.precompileFillsAsync({});
  for (const { sn, st, un, s, b } of cases) {
    for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b, st));
    const m = marks(W, R);
    updateBundleGeometry(W.gl, b, [s(2)]);
    for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b, st));
    const d = moved(W, R, m);
    if (!none(d)) ok(false, `${name}, ${sn}, an update with ${un} (${say(d)})`);
  }
  R.dispose();
}
ok(
  true,
  `${Object.keys(ART).length} arts x ${Object.keys(STATES).length} states x 3 updates checked`,
);

console.log('(declared) under each policy');
for (const [name, O] of [
  [
    'the stand-in policy',
    {
      asyncShaderCompile: true,
      nonBlocking: true,
      standIns: true,
      needMissPolicy: 'defer',
      strictPlay: true,
    },
  ],
  ['non-blocking', { asyncShaderCompile: true, nonBlocking: true }],
  ['blocking', {}],
]) {
  const { W, R } = await mk(O);
  const b = createBundle(W.gl, await importSvg(MONO, { preserveViewport: true }));
  R.declareStream(b);
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  updateBundleGeometry(W.gl, b, [quad(2)]);
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  ok(none(moved(W, R, m)), `${name} (${say(moved(W, R, m))})`);
  R.dispose();
}

console.log('(declared) drawn instanced');
{
  const { W, R } = await mk();
  const b = createBundle(W.gl, await importSvg(ART.lines, { preserveViewport: true }));
  R.declareStream(b);
  await R.precompileFillsAsync({});
  const insts = [
    { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
    { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 20, 0, 1]) },
  ];
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundleInstanced(b, insts));
  const m = marks(W, R);
  updateBundleGeometry(W.gl, b, [cubic(2)]);
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundleInstanced(b, insts));
  ok(none(moved(W, R, m)), `an update bringing a cubic to line art (${say(moved(W, R, m))})`);
  R.dispose();
}

console.log('(declared, lightweight) one update before the loading call');
{
  const { W, R } = await mk();
  const b = createBundle(W.gl, await importSvg(MONO, { preserveViewport: true }));
  R.declareStream(b);
  updateBundleGeometry(W.gl, b, [cubic(1)], { lightweight: true });
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R);
  for (const [n, s] of [
    [2, cubic],
    [4, quad],
    [6, lines],
  ]) {
    const r = updateBundleGeometry(W.gl, b, [s(n)], { lightweight: true });
    ok(r.ok, `update ${n / 2}`);
    for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  }
  ok(
    none(moved(W, R, m)),
    `later updates, one bringing a new segment type (${say(moved(W, R, m))})`,
  );
  R.dispose();
}

console.log('(undeclared) nothing changes, key for key');
// (every category but `morph`: one of its helper resources lands on either side of the end of the warm, between two runs of the same plain warm)
const memOf = (R) => {
  const { morph, ...rest } = R.getMemoryStats().gpu.byCategory;
  void morph;
  return JSON.stringify(rest);
};
for (const [name, src] of Object.entries(ART)) {
  const run = async (fn) => {
    const { W, R } = await mk();
    const b = createBundle(W.gl, await importSvg(src, { preserveViewport: true }));
    if (fn) fn(R, b);
    await R.precompileFillsAsync({});
    const out = {
      links: W.model.links,
      pipelines: W.model.pipelines,
      keys: R._policy
        .image(b)
        .map((e) => e.key)
        .sort()
        .join('\n'),
      mem: memOf(R),
      streamable: b.streamable,
    };
    R.dispose();
    return out;
  };
  const plain = await run(null),
    off = await run((R, b) => {
      R.declareStream(b);
      R.declareStream(b, false);
    }),
    nul = await run((R, b) => {
      R.declareStream(b);
      R.declareStream(b, null);
    });
  const stable = (x) =>
    x.links === plain.links &&
    x.pipelines === plain.pipelines &&
    x.keys === plain.keys &&
    x.mem === plain.mem &&
    x.streamable === false;
  ok(
    stable(off) && stable(nul),
    `${name}: declared and undeclared again is the plain warm (${plain.links} links, ${plain.pipelines} pipelines, the same keys and memory)`,
  );
}
{
  const { W, R } = await mk();
  const b = createBundle(
    W.gl,
    buildStreamableSections([{ segs: cubic(0), fill: [1, 0, 0, 1] }], [0, 0, 100, 100]),
  );
  R.declareStream(b, false);
  ok(
    b.streamable === true,
    'a bundle built as a stream stays one when it is "undeclared": it was not declared',
  );
  R.dispose();
}

console.log('(built as a stream) a section that cannot take a mesh moves no key');
{
  // A section with no area and a large box (a line there and back along a diagonal) has no mesh, so its row is a cover row as large as its box: the engine gate must not read a bundle the warm never
  // saw, or it asks the other kernel's program, which waits out the reuse deadline and is first built in play. Its neighbors are real meshes, so the stream stays a stream.
  const rect = (x, y, w, h) => [
    mkLine([x, y], [x + w, y]),
    mkLine([x + w, y], [x + w, y + h]),
    mkLine([x + w, y + h], [x, y + h]),
    mkLine([x, y + h], [x, y]),
  ];
  const { W, R } = await mk();
  const small = [
    { segs: rect(2, 2, 6, 6), fill: [1, 0, 0, 1] },
    { segs: rect(12, 2, 6, 6), fill: [0, 1, 0, 1] },
  ];
  const b = createBundle(W.gl, buildStreamableSections(small, [0, 0, 100, 100]));
  updateBundleGeometry(W.gl, b, [small[0].segs, small[1].segs], { lightweight: true });
  await R.precompileFillsAsync({});
  for (let i = 0; i < 2; i++) frame(R, () => R.drawBundle(b));
  const m = marks(W, R),
    builds0 = R.debugStats.playBuilds | 0;
  const fold = [mkLine([4, 4], [96, 96]), mkLine([96, 96], [4, 4])];
  const r = updateBundleGeometry(W.gl, b, [small[0].segs, fold], { lightweight: true });
  ok(
    r.ok && b._lbStream === true && b._lbHasSlug === true,
    'the premise: the stream stays a stream, with one section left out',
  );
  for (let i = 0; i < 4; i++) frame(R, () => R.drawBundle(b));
  const nm = R.debugStats.needMiss;
  ok(none(moved(W, R, m)), `no program moved (${say(moved(W, R, m))})`);
  ok(
    (R.debugStats.playBuilds | 0) === builds0 &&
      (nm.reuseDraws | 0) === 0 &&
      (nm.kOutsideWarmSet | 0) === 0,
    `no build, no reuse of a previous program, no key outside the warm image (${(R.debugStats.playBuilds | 0) - builds0} builds, ${nm.reuseDraws | 0} reuse draws, ${nm.kOutsideWarmSet | 0} outside)`,
  );
  R.dispose();
}

console.log('(cost) what the warm builds for a declared bundle, and for several');
{
  const measure = async (srcs, declare) => {
    const { W, R } = await mk();
    const base = marks(W, R);
    const bs = [];
    for (const src of srcs) {
      const b = createBundle(W.gl, await importSvg(src, { preserveViewport: true }));
      if (declare === true || (declare === 'first' && !bs.length)) R.declareStream(b);
      bs.push(b);
    }
    await R.precompileFillsAsync({});
    const d = moved(W, R, base);
    const fill = new Set(bs.flatMap((b) => R._policy.image(b).map((e) => e.key))).size;
    R.dispose();
    return { links: d[0], pipelines: d[1], fill };
  };
  for (const [name, srcs] of [
    ['one bundle', [MONO]],
    ['five different bundles', Object.values(ART)],
    ['five of the same art', [MONO, MONO, MONO, MONO, MONO]],
  ]) {
    const u = await measure(srcs, false),
      dc = await measure(srcs, true);
    console.log(
      `  ${name}: undeclared ${u.links} links, ${u.pipelines} pipelines, ${u.fill} fill keys; declared ${dc.links} links, ${dc.pipelines} pipelines, ${dc.fill} fill keys`,
    );
    ok(
      dc.links <= u.links && dc.pipelines <= u.pipelines,
      `${name}: no more programs than its art needs undeclared (${dc.links - u.links} links, ${dc.pipelines - u.pipelines} pipelines)`,
    );
  }
  // what a declared bundle does not share: the undeclared art's programs
  const two = await measure([MONO, MONO], false),
    beside = await measure([MONO, MONO], 'first');
  console.log(
    `  one declared beside one undeclared of the same art: ${beside.links} links, ${beside.pipelines} pipelines, ${beside.fill} fill keys; both undeclared: ${two.links} links, ${two.pipelines} pipelines, ${two.fill} fill keys`,
  );
  ok(
    beside.fill - two.fill === 4 &&
      beside.links - two.links <= 6 &&
      beside.pipelines - two.pipelines <= 6,
    `beside undeclared art of the same features it adds its own programs and shares nothing else (+${beside.fill - two.fill} fill keys, +${beside.links - two.links} links, +${beside.pipelines - two.pipelines} pipelines)`,
  );
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
