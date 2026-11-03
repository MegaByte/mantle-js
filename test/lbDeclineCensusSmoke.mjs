// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbDeclineCensusSmoke — a shape nobody built is not a shape that DECLINED.
//
// `bundle._lbMeshes[s]` answers a ROUTING question: "does this row draw its cover quad?" Five
// different outcomes answer it the same way — the builder attempted the shape and could not serve
// it, there was no geometry to build from, the complexity gate refused to attempt it, a vertex cap
// refused the pack it produced, or nobody asked for it at all. Counting the entries that are not a
// mesh reads all five as the first.
//
// A decline count derived exactly that way would judge the over-paint gate (lbApexClipSmoke)
// correctly only on an asset whose every shape without a mesh is a real decline; an asset with a
// shape the gate or a budget refuses reports a decline for an asset with none.
//
// So the cause travels with the answer: the sentinels carry it, it crosses the worker boundary as
// its own array, and lbMeshCensus splits it. This pins the split, and pins that lbMeshCensus refuses
// to GUESS when the cause is missing — reporting `unknown` rather than folding it into declines.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, lbMeshCensus, packLbMeshForWire, SLUG_WHY, slugFor } =
  await import('../src/renderer/lbBuildCore.js');
const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
const LB = await import('../src/renderer/loopBlinn.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Row 0: an ordinary cubic blob — builds.
// Row 1: a cubic whose four control points coincide — the partition has nothing to work with and
//        DECLINES. This is the only one of the three that is a decline.
// Row 2: a 420-segment polyline (over 4000 curve floats). It builds like any other shape; the
//        refusal exercised on it below is the caller's MEMORY BUDGET.
const zig = () => {
  let d = 'M0 260';
  for (let i = 1; i <= 420; i++) d += ` L${(i * 0.9).toFixed(2)} ${260 + (i % 2 ? 14 : 0)}`;
  return d + ' Z';
};
const SVG =
  '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/>' +
  '<path fill="#088" d="M300 100 C300 100 300 100 300 100 Z"/>' +
  `<path fill="#c33" d="${zig()}"/></svg>`;

// bundle.meta carries a 32-BYTE HEADER; parseMetaBin strips it. Wrapping it whole shifts every meta
// row by eight floats, which changes the fill rule and the stroke flag the build reads.
const sec = await importSvg(SVG, { preserveViewport: true });
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const input = {
  curveFloats: new Float32Array(sec.curves),
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: sec.numShapes,
};
ok(sec.numShapes === 3, `the fixture is three rows (${sec.numShapes})`);
const zigLen = sec.curveRangesByShape[2].end - sec.curveRangesByShape[2].begin;
ok(
  zigLen > 4000,
  `the polyline is ${zigLen} curve floats, which the removed gate would have refused`,
);

// ── 1. the split, through the build core ────────────────────────────────────
// With no budget set the polyline BUILDS: the only sentinel is the real decline.
const res = buildLbBundle(input);
const asBundle = (packed, why) => ({
  numShapes: sec.numShapes,
  _lbMeshes: packed,
  _lbSlugWhy: why,
});
const c = lbMeshCensus(asBundle(res.packed, res.why));
console.log('   lbMeshCensus:', JSON.stringify(c));
ok(c.real === 2, `two rows build, the polyline among them (${c.real})`);
ok(
  c.declined === 1,
  `one row DECLINES — the builder attempted it and could not serve it (${c.declined})`,
);
ok(c.tooComplex === 0, 'nothing is refused for complexity — there is no complexity gate');
ok(c.unknown === 0, 'and nothing is unaccounted for');

// ── 1b. the cause that replaced it: the CALLER'S memory budget ──────────────
// Same three rows, built under a budget the polyline's mesh cannot fit. It is not a decline
// either — the builder had an answer and a limit the app set refused it — so it gets its own code
// and its own number, and the build says how many bytes the shape wanted.
// 64 KB sits between the blob's mesh (10,656 B) and the polyline's (181,440 B), so exactly one
// row moves — a budget that refused both would not show that the refusal is per shape.
const resM = buildLbBundle({ ...input, shapeMemBytes: 65536 });
const cM = lbMeshCensus(asBundle(resM.packed, resM.why));
console.log('   lbMeshCensus (64 KB per-shape budget):', JSON.stringify(cM));
ok(
  cM.overMemory === 1 && cM.real === 1,
  `the budget refuses the polyline and only the polyline (${cM.overMemory} over-memory, ${cM.real} built)`,
);
ok(
  cM.declined === 1 && cM.tooComplex === 0,
  'and the refusal is not booked as a decline or as complexity',
);
ok(
  resM.memWants.length === 1 && resM.memWants[0].shape === 2 && resM.memWants[0].bytes > 65536,
  `the build reports WHICH shape and HOW MUCH it wanted: ${JSON.stringify(resM.memWants)}`,
);
ok(res.memWants.length === 0, 'and with no budget set nothing is refused for memory at all');

// ── 2. ...which a sentinel count cannot say ───────────────────────────────────
const naive = resM.packed.filter((m) => !(m && m.vertexCount)).length;
ok(
  naive === 2 && cM.declined === 1,
  `counting sentinels reports ${naive} decline(s) where there is ${cM.declined} — the conflation`,
);

// ── 3. a row with no geometry at all ────────────────────────────────────────
// Its own outcome, and also not a decline. Fed directly, because an importer will not emit one.
const noGeom = buildLbBundle({ ...input, ranges: [input.ranges[0], null, { begin: 0, end: 0 }] });
const cg = lbMeshCensus(asBundle(noGeom.packed, noGeom.why));
ok(
  cg.noGeometry === 2 && cg.declined === 0,
  `two rows with nothing to build from report as no-geometry, not as declines (${JSON.stringify(cg)})`,
);

// ── 4. the cause has to CROSS THE WORKER BOUNDARY ───────────────────────────
// The wire flattens every sentinel to `null` (packLbMeshForWire), so the reasons cannot ride the
// meshes. Without the cause array lbMeshCensus must say UNKNOWN — it may not guess, because a guess
// makes the decline count wrong on any asset with a refused shape.
// Read off the BUDGETED build, because that is the one with two different causes in it.
const wire = resM.packed.map(packLbMeshForWire);
ok(
  wire.filter((w) => w === null).length === 2,
  'the wire form carries no cause: both sentinels are null',
);
const blind = lbMeshCensus(
  asBundle(
    wire.map((w) => (w === null ? { slug: true } : w)),
    null,
  ),
);
ok(
  blind.unknown === 2 && blind.declined === 0,
  `without the cause array lbMeshCensus reports ${blind.unknown} unknown and ${blind.declined} declined — it does not guess`,
);
const carried = lbMeshCensus(
  asBundle(
    wire.map((w) => (w === null ? { slug: true } : w)),
    resM.why,
  ),
);
ok(
  carried.declined === 1 && carried.overMemory === 1,
  'with the cause array shipped beside the meshes, the wire form splits exactly as the build did',
);

// ── 5. the two build paths agree ────────────────────────────────────────────
// The main thread builds shape by shape with its own caches and budgets; the worker runs the core
// in one pass. A split that differed between them would describe the transport, not the art.
const glStub = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );
const R = {
  gl: glStub(),
  opts: {},
  draw: {},
  _lbFillMode: 'on',
  _lbSlugOnly: false,
  _lbSlugFallback: true,
};
Object.assign(R, {
  buildLoopBlinnMesh: LB.buildLoopBlinnMesh,
  buildLoopBlinnCDT: LB.buildLoopBlinnCDT,
  refreshLoopBlinnMesh: LB.refreshLoopBlinnMesh,
  packLoopBlinnMesh: LB.packLoopBlinnMesh,
  curveRangeToContours: LB.curveRangeToContours,
  lbCanonicalFrame: LB.lbCanonicalFrame,
  lbCanonicalHash: LB.lbCanonicalHash,
  lbCanonicalHashes: LB.lbCanonicalHashes,
  transformLoopBlinnRaw: LB.transformLoopBlinnRaw,
});
attachMorphDraw(R);
const live = {
  curveFloats: input.curveFloats,
  curveRangesByShape: input.ranges,
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  numShapes: sec.numShapes,
  segTypeMask: sec.segTypeMask,
  _geomGen: 0,
};
R.prepareBundle(live);
const cm = lbMeshCensus(live);
ok(
  JSON.stringify(cm) === JSON.stringify(c),
  `prepareBundle's lbMeshCensus matches the build core's (${JSON.stringify(cm)})`,
);
// The main thread keeps the cause ON the sentinel, so it needs no parallel array.
ok(
  !live._lbSlugWhy &&
    (live._lbMeshes || []).some((m) => m && m.slug && m.why === SLUG_WHY.DECLINED),
  'a main-thread sentinel carries its own cause',
);

// ── 6. a decline is a DECISION, not a crash ─────────────────────────────────
// resolveSelfOverlap answers with the same contours, a resolved set, or null for an outline it
// cannot resolve. The retry that consumes it must test for null too: `!== contours` alone is
// satisfied by null, so the partition would run on null and throw. The shape declines either way —
// but by crashing, and it spends the once-per-session swallow report that a real build failure has
// to arrive on.
const COINCIDENT =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M50 50 C50 50 150 150 150 150 C150 150 50 50 50 50 Z"/></svg>';
const cs = await importSvg(COINCIDENT, { preserveViewport: true });
const cpm = parseMetaBin(cs.meta, cs.metaFloatsPerShape);
const warned = [];
const realWarn = console.warn;
console.warn = (...a) => {
  warned.push(String(a[0]));
};
let cres;
try {
  cres = buildLbBundle({
    curveFloats: new Float32Array(cs.curves),
    metaFloats: cpm.metaFloats,
    metaFloatsPerShape: cpm.floatsPerShape,
    ranges: cs.curveRangesByShape,
    numShapes: cs.numShapes,
  });
} finally {
  console.warn = realWarn;
}
const cc = lbMeshCensus({ numShapes: cs.numShapes, _lbMeshes: cres.packed, _lbSlugWhy: cres.why });
ok(cc.declined === 1, 'a shape with coincident cubic controls declines');
ok(
  warned.length === 0,
  `...and declines without throwing: the build reported ${warned.length} swallowed failure(s)`,
);

// ── 7. the sentinels are singletons, so a per-shape array of them is free ───
ok(
  slugFor(SLUG_WHY.DECLINED) === slugFor(SLUG_WHY.DECLINED) &&
    slugFor(SLUG_WHY.DECLINED) !== slugFor(SLUG_WHY.TOO_COMPLEX) &&
    slugFor(SLUG_WHY.DECLINED).slug === true,
  'slugFor returns one frozen sentinel per cause, and every one still reads as slug',
);

console.log(fail ? `\nLB-DECLINE-CENSUS FAIL (${fail})` : '\nLB-DECLINE-CENSUS PASS');
process.exit(fail ? 1 : 0);
