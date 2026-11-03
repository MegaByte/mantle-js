// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillCancelledGeometrySmoke -- what the builders answer for geometry that cancels or coincides, read without a raster.
// A path of one straight line has no Loop-Blinn mesh. CPatch packs nothing where the winding is zero everywhere and walks each
// coincident boundary edge once. The fast resolver stops on coincident curves instead of halving them to its depth limit.
// The pictures are lbCancelledWindingSmoke (the kernel's CPU twin) and fillCancelledWindingRenderSmoke (Chrome at 8x).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape, meshAreaUpperBound } = await import('../src/renderer/lbBuildCore.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

// The whole path has no fill: Loop-Blinn leaves it to the cover route, which draws nothing, and paints no hairline itself.
{
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M10 10L118 118"/></svg>`,
    { preserveViewport: true },
  );
  const r = b.curveRangesByShape[0];
  const m = buildLbShape(
    curveRangeToContours(new Float32Array(b.curves), r.begin, r.end),
    false,
    false,
  );
  ok(!m, 'a path of one straight line has no Loop-Blinn mesh');
}

// The area guard on a fast mesh reads triangles. Read as coordinates too, six straight edges make the bound NaN, and `NaN < want` says the mesh covers.
{
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M40 10H88L118 40V88L88 118H40L10 88V40Z"/></svg>`,
    { preserveViewport: true },
  );
  const r = b.curveRangesByShape[0];
  const m = buildLbShape(
    curveRangeToContours(new Float32Array(b.curves), r.begin, r.end),
    false,
    false,
  );
  const bound = meshAreaUpperBound(m.raw);
  ok(
    m.raw.edges.length >= 6 && Number.isFinite(bound) && Math.abs(bound - 9864) < 1,
    `an octagon's fast mesh bounds its own area (${bound})`,
  );
}

// The crack healer splits a face at a vertex lying on its edge. With "on" as a share of the edge's length, 3 units on a 30000-unit edge, a
// vertex merely near a long edge bends the edge through itself: the first polygon loses 73% of its fill, and the second, at 3000 units, paints past its outline.
{
  const area = (A) => {
    let s = 0;
    for (let i = 0; i + 5 < A.length; i += 6)
      s +=
        Math.abs(
          (A[i + 2] - A[i]) * (A[i + 5] - A[i + 1]) - (A[i + 4] - A[i]) * (A[i + 3] - A[i + 1]),
        ) / 2;
    return s;
  };
  for (const [d, want] of [
    ['M-15000 90L0 88.7L15000 90L15000 91L-15000 91Z', 49500],
    ['M0 0H3000V9.1H0V9L1500 8.9Z', 20550],
  ]) {
    const b = await importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="${d}"/></svg>`,
      { preserveViewport: true },
    );
    const r = b.curveRangesByShape[0];
    const m = buildLbShape(
      curveRangeToContours(new Float32Array(b.curves), r.begin, r.end),
      false,
      false,
    );
    const got = area(m.raw.interior);
    ok(
      Math.abs(got - want) < 1e-5 * want,
      `a long thin polygon's mesh keeps its area: ${d}: ${got} of ${want}`,
    );
  }
}

// CPatch: the arrangement finds the winding zero everywhere, and the pack must keep that answer, not decompose the raw contours.
{
  const L = (a, b) => ({ t: 'line', P: [a, b] });
  const sq = () => [
    L([20, 20], [108, 20]),
    L([108, 20], [108, 108]),
    L([108, 108], [20, 108]),
    L([20, 108], [20, 20]),
  ];
  const rev = () =>
    sq()
      .reverse()
      .map((s) => L(s.P[1], s.P[0]));
  const quads = (m) => (m ? m.vertexCount | 0 : -1);
  ok(
    quads(packCPatchShape([sq(), rev()], 0, { evenOdd: false })) === 0,
    'CPatch: a contour and its reverse under nonzero pack nothing',
  );
  ok(
    quads(packCPatchShape([sq(), sq()], 0, { evenOdd: true })) === 0,
    'CPatch: a contour twice under even-odd packs nothing',
  );
  ok(
    quads(packCPatchShape([sq(), sq()], 0, { evenOdd: false })) > 0,
    'CPatch: a contour twice under nonzero still fills',
  );
}

// CPatch's skirt welds to its fan. A fan corner a seam slides along the outline keeps its place on the outline too, and the rim runs between the unslid corners: two triangles on
// one line with different ends round differently, and a pixel center exactly on that line would land in neither. A rim that slid would paint into its neighbor's skirt.
{
  const L = (a, b) => ({ t: 'line', P: [a, b] });
  const tri = () => [L([64, 10], [118, 100]), L([118, 100], [10, 100]), L([10, 100], [64, 10])];
  const hole = () => [
    L([40, 60], [88, 60]),
    L([88, 60], [88, 90]),
    L([88, 90], [40, 90]),
    L([40, 90], [40, 60]),
  ];
  const m = packCPatchShape([tri(), tri(), tri(), hole()], 0, { evenOdd: true });
  const V = m.verts,
    fan = new Set();
  const at = (o) => [V[o + 19], V[o], V[o + 1], V[o + 2], V[o + 3]].join(); // the patch, the position and its slide
  for (let o = 0; o < V.length; o += 24) if (V[o + 4] > 0) fan.add(at(o));
  let rim = 0,
    off = 0,
    slidRim = 0,
    slid = 0;
  for (let o = 0; o < V.length; o += 24) if (V[o + 4] > 0 && (V[o + 2] || V[o + 3])) slid++;
  for (let o = 0; o < V.length; o += 24)
    if (V[o + 4] === 0) {
      rim++;
      if (V[o + 2] || V[o + 3]) slidRim++;
      if (!fan.has(at(o))) off++;
    }
  ok(
    rim > 0 && slid > 0 && off === 0 && slidRim === 0,
    `CPatch: every skirt rim vertex is a fan vertex and none slides (${off} of ${rim} are not, ${slidRim} slide), while ${slid} fan vertices do`,
  );
}

// The arrangement keeps one of each coincident boundary edge, or its walk goes round them once per copy.
{
  const { pathToCycles } = await import('../src/geom/cpatchGraph.js');
  const L = (a, b) => ({ t: 'line', P: [a, b] });
  const poly = (...p) => p.map((q, i) => L(q, p[(i + 1) % p.length]));
  const tri = () => poly([64, 10], [118, 100], [10, 100]),
    hole = () => poly([40, 60], [88, 60], [88, 90], [40, 90]);
  // No walk takes the same directed edge twice.
  const repeats = (cy) => {
    const seen = new Set();
    let n = 0;
    for (const c of cy)
      for (const g of c) {
        const k = g.P[0].join() + '>' + g.P[g.P.length - 1].join();
        if (seen.has(k)) n++;
        seen.add(k);
      }
    return n;
  };
  ok(
    repeats(pathToCycles([tri(), tri(), tri(), hole()], true)) === 0,
    'a triangle three times with a hole under even-odd: each edge once',
  );
  ok(
    pathToCycles(
      [poly([20, 20], [60, 20], [60, 60]), poly([20, 20], [100, 20], [100, 60])],
      false,
    )[0].length === 6,
    'two triangles sharing an apex and a stretch of edge: 6 edges, no spur',
  );
}

// Coincident curves never separate, so the stream's fast resolver must not halve them to its depth limit. It reports what it had built.
{
  const { resolveFastContours } = await import('../src/renderer/lbFastResolve.js');
  const { SEG_CUBIC } = await import('../src/primitives/seg.js');
  const ring = (o) => [
    { type: SEG_CUBIC, p1: [20 + o, 64], p2: [20 + o, 20], p3: [108 + o, 20], p4: [108 + o, 64] },
    { type: SEG_CUBIC, p1: [108 + o, 64], p2: [108 + o, 108], p3: [20 + o, 108], p4: [20 + o, 64] },
  ];
  for (const o of [0, 1e-9, 1e-6]) {
    const r = resolveFastContours([ring(0), ring(o)], 'nonzero', true, true);
    ok(
      r.decline === 'crossing' && r.pieces <= 2048,
      `fast resolve of two copies offset by ${o}: ${r.decline}, ${r.pieces} pieces`,
    );
  }
}

console.warn = warn;
if (fail) {
  console.log(`fillCancelledGeometrySmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('fillCancelledGeometrySmoke: PASS');
