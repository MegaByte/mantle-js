// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStreamStaticParitySmoke — a streamed shape gets the mesh the static build gives the same
// geometry.
//
// The lightweight stream (streamGeometry.js, updateBundleGeometry {lightweight:true}) rebuilds each
// moved shape through buildLbShape, on contours chained by the decoder's own rules, not by calling
// the FAST earcut builder directly. The static route -- the worker's buildLbBundle and
// prepareBundle, both through buildLbShape -- sends a concave, disjoint, multi-contour, cubic or
// translucent shape to the CDT partition, splits cusps, degree-reduces and builds in the shape's own
// frame, so a direct fast build would draw the same geometry as one mesh static and another streamed.
//
// Per fixture, a lightweight stream bundle is driven through a sequence of frames, and each frame's
// streamed meshes are compared with a STATIC build of that frame's geometry: a fresh
// buildStreamableSections bundle through buildLbBundle, the function the off-thread build runs.
// Coordinates are float32 values, so the static path's float32 curve table carries them exactly.
// Fixtures: the teleporting road bands of lbStreamTeleportParitySmoke, a band set scrolling, and the
// CDT-class shapes -- concave, disjoint, cubic, translucent, even-odd -- warping.
//
// Also: a shape moving by a relative 1% at 2^-20 is rebuilt, not kept (the stream's unchanged-shape
// skip must not hash coordinates at an absolute 1/4096 unit, which at 2^-20 reads every move as no change).
//
// THE CORRECT FAST BUILD. The stream asks buildLbShape for `fastCorrect`, which puts
// the correct fast builder (lbFastResolve.js) in front of the partition for a curved (cubic included),
// concave, disjoint or multi-contour shape. Such a shape is not byte-identical to the static build and is not meant
// to be: it is held to exact COVERAGE instead -- no whole pixel wrong, and its edge pixels, summed over
// the run, no worse than the static build's (the CPU Loop-Blinn draw model,
// probes/lbAccuracy/_lbStaticDrawEmu.mjs, against 8x8-sampled winding). It must also be what its own
// route builds fresh, so the stream's buffer reuse and frame translation change nothing. Every other
// shape -- a single straight contour, a translucent solid, or a declined shape -- is still byte-identical
// to the static build.
//
// FAILS WITH A DIRECT FAST BUILD: nearly every streamed shape differs from its static build.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { createFakeGl } = await import('./_fakeGl.mjs');
const { createBundle, buildStreamableSections, updateBundleGeometry } =
  await import('../src/index.js');
const { buildLbBundle, buildLbShape, packLbMeshForWire } =
  await import('../src/renderer/lbBuildCore.js');
const { contoursFromSegs, rayWinding } = await import('../src/geom/lbContour.js');
const { packLoopBlinnMesh } = await import('../src/renderer/loopBlinn.js');
const { renderStatic } = await import('../probes/lbAccuracy/_lbStaticDrawEmu.mjs');
const { mkLine, mkQuad, mkCubic } = await import('../src/primitives/seg.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const F = createFakeGl({ width: 256, height: 256 });
const gl = F.gl;

const f32 = (p) => [Math.fround(p[0]), Math.fround(p[1])];
const L = (a, b) => mkLine(f32(a), f32(b));
const Q = (a, c, b) => mkQuad(f32(a), f32(c), f32(b));
const C = (a, c1, c2, b) => mkCubic(f32(a), f32(c1), f32(c2), f32(b));
const bytesOf = (pk) =>
  pk && !pk.slug && (pk.vertexCount | 0) > 0
    ? Buffer.from(
        pk.verts.buffer,
        pk.verts.byteOffset,
        pk.vertexCount * (pk.verts.length / pk.vertexCount) * 4,
      ).toString('base64') +
      '/k' +
      (pk.kindMask | 0)
    : 'slug';

/// The static build of one frame: a fresh bundle, through the off-thread builder's own function.
function staticMeshes(shapes) {
  const b = createBundle(gl, buildStreamableSections(shapes));
  const res = buildLbBundle({
    curveFloats: b.curveFloats,
    metaFloats: b.metaFloats,
    metaFloatsPerShape: b.metaFloatsPerShape,
    ranges: b.curveRangesByShape,
    numShapes: b.numShapes,
  });
  return { bytes: res.packed.map(packLbMeshForWire).map(bytesOf), raw: res.raw };
}
/// A raw mesh against the exact coverage of `segs` (nonzero), one pixel per unit: whole pixels wrong, and
/// edge pixels more than 32/255 off the exact area.
function exactScore(mesh, segs) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs)
    for (const P of [s.p1, s.p2, s.p3, s.p4])
      if (P) {
        x0 = Math.min(x0, P[0]);
        y0 = Math.min(y0, P[1]);
        x1 = Math.max(x1, P[0]);
        y1 = Math.max(y1, P[1]);
      }
  const N = Math.ceil(Math.max(x1 - x0, y1 - y0)) + 4,
    bb = [x0 - 2, y0 - 2, N, N];
  const pk = packLoopBlinnMesh(mesh);
  const cov = renderStatic({ S: pk.verts, D: pk.verts, n: pk.vertexCount, lt: 0 }, bb, N).cov;
  const r = { whole: 0, edge: 0 };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let n = 0;
      for (let a = 0; a < 8; a++)
        for (let c = 0; c < 8; c++)
          if (rayWinding(segs, bb[0] + x + (a + 0.5) / 8, bb[1] + y + (c + 0.5) / 8) !== 0) n++;
      if (Math.abs(Math.max(0, cov[y * N + x]) - n / 64) <= 32 / 255) continue;
      if (n === 0 || n === 64) r.whole++;
      else r.edge++;
    }
  return r;
}

/// Stream `frames` (each an array of {segs, fill}) through one lightweight bundle; compare each frame.
function run(name, frames) {
  const b = createBundle(gl, buildStreamableSections(frames[0], null, { lightweight: true }));
  let shapes = 0,
    same = 0,
    streamed = 0,
    refreshed = 0,
    fastN = 0,
    fastFresh = 0,
    wholeWrong = 0,
    edgeFast = 0,
    edgeStatic = 0;
  const bad = [],
    badFast = [];
  for (let f = 0; f < frames.length; f++) {
    const r = updateBundleGeometry(
      gl,
      b,
      frames[f].map((s) => s.segs),
      { lightweight: true },
    );
    if (!r.ok) {
      bad.push(`frame ${f}: stream declined (${r.reason})`);
      continue;
    }
    streamed++;
    const st = staticMeshes(frames[f]);
    for (let s = 0; s < st.bytes.length; s++) {
      shapes++;
      const raw = b._lbMeshesRaw[s],
        segs = frames[f][s].segs;
      if (raw && raw._lbRefreshed) refreshed++;
      if (raw && raw._route === 'fast-correct') {
        fastN++;
        const trans = frames[f][s].fill[3] < 0.996;
        const fresh = buildLbShape(contoursFromSegs(segs), trans, false, { fastCorrect: true });
        if (fresh && bytesOf(b._lbMeshes[s]) === bytesOf(packLbMeshForWire(fresh.pk))) fastFresh++;
        else badFast.push(`frame ${f} shape ${s}: not its route's fresh build`);
        const sf = exactScore(raw, segs),
          ss = exactScore(st.raw[s], segs);
        wholeWrong += sf.whole;
        edgeFast += sf.edge;
        edgeStatic += ss.edge;
        if (sf.whole) badFast.push(`frame ${f} shape ${s}: ${sf.whole} whole px wrong`);
        continue;
      }
      if (bytesOf(b._lbMeshes[s]) === st.bytes[s]) same++;
      else
        bad.push(
          `frame ${f} shape ${s}: streamed ${bytesOf(b._lbMeshes[s]).slice(-12)} static ${st.bytes[s].slice(-12)}`,
        );
    }
  }
  ok(
    streamed === frames.length && same === shapes - fastN && shapes > 0,
    `${name}: ${same} of ${shapes - fastN} streamed shape-frames outside the correct fast build are byte-identical to the static build${bad.length ? ' -- ' + bad.slice(0, 3).join('; ') : ''}`,
  );
  if (fastN) {
    ok(
      fastFresh === fastN && wholeWrong === 0,
      `${name}: ${fastN} shape-frames took the correct fast build, ${fastFresh} as built fresh, ${wholeWrong} whole pixels wrong against exact coverage${badFast.length ? ' -- ' + badFast.slice(0, 3).join('; ') : ''}`,
    );
    ok(
      edgeFast <= edgeStatic,
      `${name}: ...and their edge pixels past 32/255 number ${edgeFast}, the static build's ${edgeStatic}`,
    );
  }
  return { refreshed, fastN };
}

// ---- road bands that teleport between structures (lbStreamTeleportParitySmoke's sequence) ------
{
  const straightQ = (a, b) => Q(a, a, b);
  const quadEdge = (n, m, f) =>
    Q(n, [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2], f);
  const band = (nL, mL, fL, nR, mR, fR) => [
    quadEdge(nL, mL, fL),
    straightQ(fL, fR),
    quadEdge(fR, mR, nR),
    straightQ(nR, nL),
  ];
  const mk = (yN, yF, rwN, rwF, sway) => {
    const yM = (yN + yF) / 2,
      rwM = (rwN + rwF) / 2,
      cx = 100;
    return band(
      [cx - rwN, yN],
      [cx + sway - rwM, yM],
      [cx - rwF, yF],
      [cx + rwN, yN],
      [cx + sway + rwM, yM],
      [cx + rwF, yF],
    );
  };
  const SEQ = [
    mk(180, 60, 70, 12, 40),
    mk(180, 60, 70, 12, -40),
    mk(120, 55, 30, 10, 45),
    mk(120, 55, 30, 10, -45),
    mk(190, 40, 80, 6, 55),
    mk(190, 40, 80, 6, -55),
    mk(175, 150, 64, 40, 30),
  ];
  const { fastN } = run(
    'teleporting road band',
    SEQ.map((segs) => [{ segs, fill: [0.3, 0.3, 0.35, 1] }]),
  );
  ok(
    fastN === SEQ.length,
    `...every road band frame took the correct fast build (${fastN} of ${SEQ.length})`,
  );
  // A set of bands scrolling: four at once, each frame a little further down the road.
  const frames = [];
  for (let t = 0; t < 6; t++) {
    const shapes = [];
    for (let k = 0; k < 4; k++) {
      const yN = 190 - k * 35 - t * 3,
        yF = yN - 30;
      shapes.push({
        segs: mk(yN, yF, 70 - k * 14, 62 - k * 14, 10 * Math.sin(0.7 * t + k)),
        fill: [0.2 + 0.1 * k, 0.4, 0.3, 1],
      });
    }
    frames.push(shapes);
  }
  run('scrolling band set', frames);
}

// ---- CDT-class shapes, warping ------------------------------------------------------------------
{
  const frames = [];
  for (let t = 0; t < 5; t++) {
    const w = 3 * Math.sin(t),
      v = 2 * Math.cos(1.3 * t);
    // concave: a C of quads (outer bulge, inner bite)
    const concave = [
      Q([20, 20 + v], [70 + w, 10], [120, 20]),
      L([120, 20], [120, 40]),
      Q([120, 40], [70 - w, 25 + v], [20, 40]),
      L([20, 40], [20, 20 + v]),
    ];
    // disjoint: two blobs in one shape
    const blob = (cx, cy, r, k) => [
      Q([cx - r, cy], [cx - r, cy - r - k], [cx, cy - r]),
      Q([cx, cy - r], [cx + r + k, cy - r], [cx + r, cy]),
      Q([cx + r, cy], [cx + r, cy + r + k], [cx, cy + r]),
      Q([cx, cy + r], [cx - r - k, cy + r], [cx - r, cy]),
    ];
    const disjoint = [...blob(40 + w, 90, 15, 4), ...blob(95, 90 + v, 12, 3)];
    // cubic: a cubic blob
    const cubic = [
      C([150, 60], [150 + w, 20], [210, 20], [210, 60]),
      C([210, 60], [210, 110 + v], [150, 95], [150, 60]),
    ];
    // translucent (partition route) and even-odd (a square with a square hole, rule-dependent)
    const trans = blob(170 + v, 150, 20, 6 + w);
    const sq = (x, y, s) => [
      L([x, y], [x + s, y]),
      L([x + s, y], [x + s, y + s]),
      L([x + s, y + s], [x, y + s]),
      L([x, y + s], [x, y]),
    ];
    const evenodd = [...sq(20 + w, 130, 60), ...sq(35, 145 + v, 30)];
    frames.push([
      { segs: concave, fill: [0.8, 0.2, 0.2, 1] },
      { segs: disjoint, fill: [0.2, 0.6, 0.2, 1] },
      { segs: cubic, fill: [0.2, 0.2, 0.8, 1] },
      { segs: trans, fill: [0.9, 0.6, 0.1, 0.5] },
      { segs: evenodd, fill: [0.4, 0.4, 0.4, 1] },
    ]);
  }
  run('CDT-class shapes (concave, disjoint, cubic, translucent, holed)', frames);
}

// ---- a straight outline bending: the one route that reuses last frame's triangulation -------------
// buildLbShape refreshes a straight single contour against `prev` when its rim structure is
// unchanged; the static build has no `prev`. A reused triangulation must still be the static one.
{
  const frames = [];
  for (let t = 0; t < 6; t++) {
    const pts = [];
    for (let j = 0; j < 10; j++) {
      const a = (2 * Math.PI * j) / 10,
        r = (j % 2 ? 22 : 50) + 2 * Math.sin(t + j);
      pts.push([100 + r * Math.cos(a + 0.02 * t), 100 + r * Math.sin(a + 0.02 * t)]);
    }
    frames.push([
      { segs: pts.map((p, j) => L(p, pts[(j + 1) % pts.length])), fill: [0.1, 0.1, 0.1, 1] },
    ]);
  }
  const { refreshed } = run('bending straight star (triangulation reuse)', frames);
  ok(
    refreshed > 0,
    `...and the stream reused last frame's triangulation on ${refreshed} of ${frames.length - 1} moved frames`,
  );
}

// ---- the unchanged-shape skip is exact at 2^-20 --------------------------------------------------
{
  const k = 2 ** -20;
  const tri = (dx) => [
    L([k * (10 + dx), k * 10], [k * (60 + dx), k * 10]),
    L([k * (60 + dx), k * 10], [k * (35 + dx), k * 50]),
    L([k * (35 + dx), k * 50], [k * (10 + dx), k * 10]),
  ];
  const b = createBundle(
    gl,
    buildStreamableSections([{ segs: tri(0), fill: [0, 0, 0, 1] }], null, { lightweight: true }),
  );
  updateBundleGeometry(gl, b, [tri(0)], { lightweight: true });
  const before = bytesOf(b._lbMeshes[0]);
  updateBundleGeometry(gl, b, [tri(0.5)], { lightweight: true }); // moved by 1% of its size
  ok(
    before !== 'slug' && bytesOf(b._lbMeshes[0]) !== before,
    'at 2^-20 a shape that moved is rebuilt, not kept',
  );
}

if (fail) {
  console.log(`FAIL lbStreamStaticParitySmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbStreamStaticParitySmoke');
process.exit(0);
