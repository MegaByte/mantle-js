// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMovingInflectionSmoke — a morph whose inflection moves can be served by Loop-Blinn in fine t-cells.
//
// The morph pair cuts both poses of a cubic at one set of parameters, so an inflection (which each pose places at its
// own) leaves a piece between the two cuts that bulges to opposite sides of its chord on the two poses: every pair and
// every coarse t-cell declines (`bulge-flip`, `dst-klmn-frame`), and the 60-pair S-curve family of
// probes/morphScale/_sCurveFamily.mjs would draw Slug. A cell short enough that the inflection moves less than one vertex
// quantum in each of its poses has its two cuts merged into one by the pair's own plan, and builds as an ordinary pair,
// exact at every t in it. segmentMovingInflection cuts the morph into such cells.
//
// And pairMidFlips reads a face collinear BY CONSTRUCTION at one end -- the fan triangle of a piece cut at its own
// inflection, where every cell cuts -- as degenerate there when its float32 corners leave it an area of either sign
// within what the rounding can make; a real inversion is still caught.
//
// No GPU:
//   - six members of the family build a t-segmented Loop-Blinn mesh, not Slug, with the cell count and bytes named;
//   - in the CPU model of the morph draw, one member loses no ink inside the fill at five t and is off exact at no more
//     pixels than a static build of each pose;
//   - a per-shape memory budget smaller than the cells declines the morph, naming `over-memory`;
//   - pairMidFlips: float32 noise on a collinear end is not a flip; an inverted face is.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
// THE FINE-CELLS ROUTE ALONE: a moving inflection is served first by the serpentine pair
// (lbSerpentinePairSmoke), and this smoke holds the route that serves what that cannot certify. The switch is a TEST
// HOOK, read only under __MANTLE_DEBUG__ (mantleDebugHook), so it is set with it.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__LB_SERPENTINE_PAIR = false;
const { mkLine, mkCubic } = await import('../src/primitives/seg.js');
const { buildMorphShape } = await import('../src/renderer/lbMorphCore.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { setLbShapeMemoryBudget } = await import('../src/renderer/lbPack.js');
const PAIR = await import('../src/renderer/lbPartitionPair.js');
const EMU = await import('./_lbMorphDrawEmu.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const shape = (a, b, h) => [
  [
    mkCubic([0, 0], [a, h], [100 - b, -h], [100, 0]),
    mkLine([100, 0], [100, 150]),
    mkLine([100, 150], [0, 150]),
    mkLine([0, 150], [0, 0]),
  ],
];
const meta = new Float32Array(40);
meta[28] = 1;
meta[7] = 1;

// ── six members of the family ─────────────────────────────────────────────────────────────────────
const built = [];
for (const [a0, b0, h, da] of [
  [50, 50, 100, 1],
  [50, 50, 100, -1],
  [30, 60, 60, 3],
  [60, 30, 60, -3],
  [50, 50, 60, 6],
  [30, 60, 100, -1],
]) {
  const r = buildMorphShape(shape(a0, b0, h), shape(a0 + da, b0, h), meta, meta, 0, 40),
    m = r && r.mesh;
  const cells = m && m.segments ? m.segments.length : 0,
    bytes = cells ? m.segments.reduce((t, g) => t + g.vbo.byteLength, 0) : 0;
  built.push({ a0, b0, h, da, m, cells, bytes, why: r && r.pairWhy });
}
ok(
  built.every((b) => b.m && b.cells > 1),
  `the family builds Loop-Blinn t-cells: ${built
    .map(
      (b) =>
        `P1 (${b.a0},${b.h}) ${b.da > 0 ? '+' : ''}${b.da}: ` +
        (b.m ? `${b.cells} cells, ${(b.bytes / 1024).toFixed(0)} KiB` : `Slug (${b.why})`),
    )
    .join('; ')}`,
);

// ── the picture, in the CPU model ─────────────────────────────────────────────────────────────────
{
  const b = built[0];
  if (b.m) {
    const bb = [-10, -80, 120, 240],
      rows = [];
    let good = true;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const pose = shape(b.a0 + b.da * t, b.b0, b.h);
      const s = EMU.scoreExact(EMU.render(EMU.morphPacksAt(b.m, t), bb, 192).cov, pose, bb, 192, 8);
      const st = EMU.scoreExact(
        EMU.render(EMU.staticPacks(buildLbShape(pose, false, false).raw), bb, 192).cov,
        pose,
        bb,
        192,
        8,
      );
      rows.push(`t = ${t}: ${s.off} (static ${st.off}), ${s.lostIn} lost inside`);
      if (s.lostIn || s.off > st.off) good = false;
    }
    ok(good, `P1 (${b.a0},${b.h}) +${b.da}, px off exact by >32/255: ${rows.join('; ')}`);
  } else ok(false, 'the picture needs the first member built');
}

// ── the memory budget ────────────────────────────────────────────────────────────────────────────
{
  const b = built[0];
  setLbShapeMemoryBudget(Math.max(1, Math.floor(b.bytes / 2)));
  let r = null;
  try {
    r = buildMorphShape(shape(b.a0, b.b0, b.h), shape(b.a0 + b.da, b.b0, b.h), meta, meta, 0, 40);
  } finally {
    setLbShapeMemoryBudget(null);
  }
  ok(
    !!r && !r.mesh && r.pairWhy === 'over-memory',
    `a budget of half its ${(b.bytes / 1024).toFixed(0)} KiB declines it, naming '${r && r.pairWhy}'`,
  );
}

// ── pairMidFlips and a collinear end ──────────────────────────────────────────────────────────────
{
  // the fan triangle of a cell that declines if float32 noise on a collinear end counts as a flip: 8.1e-3 of area at one end, collinear at the other,
  // where float32 left -4.8e-5
  const S = new Float32Array([49.97851, 0.01172, 43.72689, 12.50976, 37.47607, 25.00488]);
  const D = new Float32Array([49.9707, 0.01172, 43.71777, 12.50976, 37.46631, 25.00488]);
  const mesh = (h) => ({ interior: new Float32Array(0), quads: [], cubics: [{ hull: h }] });
  ok(
    PAIR.pairMidFlips(mesh(S), mesh(D)) === false,
    'a face collinear at one end, with float32 noise of the other sign there, is not a flip',
  );
  const Dinv = new Float32Array([0, 0, 1, 0, 0, -1]),
    Sok = new Float32Array([0, 0, 1, 0, 0, 1]);
  ok(PAIR.pairMidFlips(mesh(Sok), mesh(Dinv)) === true, '...and an inverted face still is');
}

console.warn = warn;
console.log(fail ? `LB-MOVING-INFLECTION FAIL (${fail})` : 'LB-MOVING-INFLECTION PASS');
process.exit(fail ? 1 : 0);
