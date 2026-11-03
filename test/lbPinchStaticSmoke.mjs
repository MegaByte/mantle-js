// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPinchStaticSmoke — the static route cuts a contour that returns to a vertex into its loops.
//
// A contour that passes through the same vertex twice -- three triangles sharing an apex written as ONE
// subpath -- touches itself there, and Loop-Blinn reads two of the triangles as holes unless it is cut:
// drawn whole, the static route draws one triangle of three. So buildLbShape
// cuts such a contour into its loops before the route decision (cutPinches, lbFastResolve.js); winding is
// additive over the loops, so the fill is unchanged under either rule.
//
// The same cut applies where resolveSelfOverlap resolves a crossing outline, because its answer can come
// back pinched: an even-odd pentagram resolves to five spikes written as three contours, two of which pass
// through a crossing vertex twice -- as two float64 points a few ulps of float64 apart, one float32 vertex
// of the stored mesh. At its authored coordinates it can draw right by float luck; moved 0.1% (the move
// below) it does not.
//
// Scored by the CPU Loop-Blinn draw model (probes/lbAccuracy/_lbStaticDrawEmu.mjs) against the exact
// coverage of the outline (8x8 samples per pixel; wrong = more than 32/255 off).
//
// FAILS WITHOUT THE CUT: the pinch loses thousands of pixels, and the moved pentagram paints thousands wrong.
console.warn = () => {};
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { packLoopBlinnMesh } = await import('../src/renderer/loopBlinn.js');
const { rayWinding } = await import('../src/geom/lbContour.js');
const { cutPinches } = await import('../src/renderer/lbFastResolve.js');
const { mkLine } = await import('../src/primitives/seg.js');
const { renderStatic } = await import('../probes/lbAccuracy/_lbStaticDrawEmu.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const L = (a, b) => mkLine(a, b);

/// Whole pixels wrong and edge pixels more than 32/255 off, for the static route's mesh of `contours`.
function score(contours, evenodd) {
  const b = buildLbShape(contours, false, evenodd);
  if (!b) return null;
  const segs = contours.flat();
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs)
    for (const P of [s.p1, s.p2]) {
      x0 = Math.min(x0, P[0]);
      y0 = Math.min(y0, P[1]);
      x1 = Math.max(x1, P[0]);
      y1 = Math.max(y1, P[1]);
    }
  const N = Math.ceil(Math.max(x1 - x0, y1 - y0)) + 4,
    bb = [x0 - 2, y0 - 2, N, N];
  const pk = packLoopBlinnMesh(b.raw);
  const cov = renderStatic({ S: pk.verts, D: pk.verts, n: pk.vertexCount, lt: 0 }, bb, N).cov;
  const r = { whole: 0, edge: 0 };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let n = 0;
      for (let a = 0; a < 8; a++)
        for (let c = 0; c < 8; c++) {
          const w = rayWinding(segs, bb[0] + x + (a + 0.5) / 8, bb[1] + y + (c + 0.5) / 8);
          if (evenodd ? (w & 1) !== 0 : w !== 0) n++;
        }
      if (Math.abs(Math.max(0, cov[y * N + x]) - n / 64) <= 32 / 255) continue;
      if (n === 0 || n === 64) r.whole++;
      else r.edge++;
    }
  return r;
}

// ---- an authored pinch: three triangles sharing an apex, one subpath ----------------------------------
{
  const V = [100, 100],
    tri = (a, b) => [L(V, a), L(a, b), L(b, V)];
  const cs = [
    [...tri([160, 80], [170, 140]), ...tri([60, 170], [40, 120]), ...tri([90, 20], [140, 30])],
  ];
  const cut = cutPinches(cs);
  ok(
    cut.length === 3 && cut.every((c) => c.length === 3),
    `the pinched contour is cut into its three triangles (${cut.map((c) => c.length).join(', ')})`,
  );
  for (const evenodd of [false, true]) {
    const s = score(cs, evenodd);
    ok(
      s && s.whole === 0,
      `pinch (${evenodd ? 'evenodd' : 'nonzero'}): the static route draws all three triangles -- ${s ? s.whole : 'no mesh'} whole pixels wrong`,
    );
  }
}

// ---- a resolved crossing that comes back pinched: the even-odd pentagram, moved 0.1% ----------------------
{
  const P = [
    [100, 30],
    [140, 170],
    [10, 80],
    [190, 80],
    [60, 170],
  ];
  const move = (p) => [
    p[0] + 0.2 * Math.sin((p[1] * Math.PI) / 100),
    p[1] + 0.2 * Math.cos((p[0] * Math.PI) / 100),
  ];
  for (const [name, pts] of [
    ['authored', P],
    ['moved 0.1%', P.map(move)],
  ]) {
    const cs = [pts.map((p, i) => L(p, pts[(i + 1) % pts.length]))];
    const s = score(cs, true);
    ok(
      s && s.whole === 0,
      `pentagram, even-odd, ${name}: ${s ? s.whole : 'no mesh'} whole pixels wrong`,
    );
  }
}

// ---- nothing else moves ---------------------------------------------------------------------------------
{
  const sq = [
    [L([10, 10], [60, 10]), L([60, 10], [60, 60]), L([60, 60], [10, 60]), L([10, 60], [10, 10])],
  ];
  ok(cutPinches(sq) === sq, 'a contour set with no pinch comes back as the same array');
}

if (fail) {
  console.log(`FAIL lbPinchStaticSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbPinchStaticSmoke');
process.exit(0);
