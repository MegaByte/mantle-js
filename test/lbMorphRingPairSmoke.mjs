// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMorphRingPairSmoke — cubic ring morphs keep their Loop-Blinn morph mesh.
//
// Under route:'lb' a six-cubic ring whose bow grows, and a twelve-cubic ring that only SCALES (the
// simplest morph there is), must not draw Slug -- which they do when every pair builder declines and
// buildMorphBundle, the worker's entry, answers { hasSlug: true }. Two causes:
//
//   face-degenerate   The pair cuts both poses of a cubic wherever EITHER pose needs a cut. Authored
//                     at three decimals, the two poses' inflections sit 2.1e-5 apart in t, so both are
//                     cut, and the piece that starts at the destination's inflection has its first
//                     three control points collinear there (B' and B'' are parallel at an inflection).
//                     The source, cut 2.1e-5 past its own inflection, keeps those three as a sliver fan
//                     triangle; mapped to the destination it has no area, and the destination's klmn
//                     rows read over it would divide by exactly zero. The rows are one affine
//                     function over the whole piece, so they are read over a triangle of the
//                     piece's control points that spans the plane.
//   unmapped-vertex   The same merged plan puts the growing ring's two cuts on one side of a cubic
//                     2.0e-6 apart in t and 5.9e-5 apart in space: one vertex-key bucket (2^-16 of
//                     the shape). The builder keeps the first point added to a bucket; a registry that
//                     keeps only the last, with float32 rounding carrying the stored vertex into the
//                     neighboring bucket, finds nothing. So every registration in a bucket is kept
//                     and searched by identity. (The growing ring needs both: with only this one it
//                     declines on face-degenerate, as does each of its t-segment pairs.)
//
// A fan triangle that clears the bar by a hair is no better: at a sine of 8.1e-16 the destination
// rows come out 2.1% (of their scale) from the piece's own implicit on the scaling ring. So the
// destination's rows are read over the piece's widest control triangle, always.
//
// And a declined morph SAYS why: rather than a bare { hasSlug: true } that names no bail, the
// build result carries one SLUG_WHY code per shape and the declined shape's own cause, through the
// worker and the pool to the bundle, where lbMorphCensus counts them as lbMeshCensus does the static
// route's.
//
// No GPU. For each morph:
//   - buildMorphBundle returns a mesh for its one shape, not Slug;
//   - that mesh is the pack of the partition pair, and the pair at t = 0 and at t = 1 fills exactly
//     what each pose fills: on a grid over the pose, every sample farther than 0.2% of the diagonal
//     from the outline reads ink or air the way that pose's exact winding does. The same evaluator
//     reads the static partition of each pose first, the same partition with its curve faces' signs
//     flipped, and the destination against the source's outline, so a pass is not an evaluator that
//     agrees with anything;
//   - at both ends every klmn face carries its piece's own implicit: the rows at each face vertex
//     are within 1e-5 (of their scale) of the affine function a least-squares fit puts through
//     the piece's four control points' klmn values;
//   - the result reports every shape REAL and no cause.
// ...AND BETWEEN THE POSES (the exact reference is probes/morph/_morphExactRef.mjs). At t = 0.2, 0.45
// and 0.7:
//   - every pair's interior carries the static build's analytic chains on both streams;
//   - no piece is smaller than its pose's vertex quantum;
//   - every Bezout face's keep half-plane, as the vertex stage mixes it, holds its own lerped arc;
//   - every pair's lerped implicit stays within the drift oracle's bar (loopBlinnMorph MORPH_DRIFT_FRAC);
//   - the picture, through test/_lbMorphDrawEmu.mjs, loses no ink inside the fill and is off exact by
//     more than 32/255 at no more pixels than a static build of the same pose, plus a quarter and 3. The
//     static build is the floor: its quarter-pixel rings leave some antialiasing just outside a curve
//     unpainted, 26 and 19 px here at t = 0.2.
// ...AND NOT AT THE COST OF unifiedMorphSmoke's solid morph, a four-cubic circle into an irregular outline:
// the static build's chains, whose a -> m -> b stands inside a convex arc, would cost it pixels. Through the same
// evaluator, at t = 0, 0.25, 0.5, 0.75 and 1 it loses no ink inside the fill and is off exact at no more pixels than
// its recorded baseline (0/3/11/3/6). So is a flip, a dome into a dish.
// And a morph that legitimately declines (a disc into a wobble: a cubic's bulge crosses its chord
// between the poses, and no t-segmentation serves it) reports DECLINED with the pair builder's own
// cause -- from buildMorphBundle, from the real worker module, and through the pool on both of its
// paths (the synchronous fallback, and a Worker bridged to the worker module) -- and the renderer
// adopts it onto the bundle, where lbMorphCensus counts it.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { curveRangeToContours, rayWinding } = await import('../src/geom/lbContour.js');
const { cubicPt, evalBezout, cubicKLMN } = await import('../src/geom/lbCubicMath.js');
const { buildLoopBlinnPartition } = await import('../src/renderer/lbPartition.js');
const PAIR = await import('../src/renderer/lbPartitionPair.js');
const { buildMorphBundle } = await import('../src/renderer/lbMorphCore.js');
const { SLUG_WHY, lbMorphCensus } = await import('../src/renderer/lbBuildCore.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS } = await import('../src/renderer/lbPack.js');
const MORPH = await import('../src/renderer/loopBlinnMorph.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { emUnitsOf } = await import('../src/geom/lbContour.js');
/// max over an arc of n . B(t): its endpoints and the in-span roots of n . B'(t).
const support = (P, nx, ny) => {
  const b = P.map((p) => nx * p[0] + ny * p[1]);
  const A = 3 * (-b[0] + 3 * b[1] - 3 * b[2] + b[3]),
    B = 6 * (b[0] - 2 * b[1] + b[2]),
    C = 3 * (b[1] - b[0]);
  const ts =
    Math.abs(A) > 1e-12 * (Math.abs(A) + Math.abs(B) + Math.abs(C))
      ? B * B - 4 * A * C >= 0
        ? [
            (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A),
            (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A),
          ]
        : []
      : B !== 0
        ? [-C / B]
        : [];
  let hi = Math.max(b[0], b[3]);
  for (const t of ts)
    if (t > 0 && t < 1) {
      const u = 1 - t;
      hi = Math.max(
        hi,
        u * u * u * b[0] + 3 * u * u * t * b[1] + 3 * u * t * t * b[2] + t * t * t * b[3],
      );
    }
  return hi;
};
const EMU = await import('./_lbMorphDrawEmu.mjs');
/// The pose at t: every control point of the two matched outlines lerped, as the vertex stage lerps them.
const poseAt = (sc, dc, t) =>
  sc.map((c, ci) =>
    c.map((g, si) => {
      const d = dc[ci][si],
        lp = (p, q) => p && [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      return {
        type: g.type,
        w: g.w,
        p1: lp(g.p1, d.p1),
        p2: lp(g.p2, d.p2),
        p3: lp(g.p3, d.p3),
        p4: lp(g.p4, d.p4),
      };
    }),
  );

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

// The two morphs of cpatchMorphDeclineSmoke, by the same construction.
function blobPath(t, K, grow) {
  const R = 40 + 22 * t,
    cx = 100,
    cy = 100,
    f = (v) => v.toFixed(3);
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K),
    cy + R * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = '';
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = grow ? 0.3 + 0.14 * t : 0.3;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    const c1 = [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
      c2 = [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1];
    if (j === 0) d += `M${f(A[0])} ${f(A[1])}`;
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(B[0])} ${f(B[1])}`;
  }
  return d + ' Z';
}
const svgOf = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${d}"/></svg>`;
const CASES = [
  { name: '6 cubics, bow grows', a: svgOf(blobPath(0, 6, true)), b: svgOf(blobPath(1, 6, true)) },
  {
    name: '12 cubics, scale only',
    a: svgOf(blobPath(0, 12, false)),
    b: svgOf(blobPath(1, 12, false)),
  },
];

/// Both poses as the worker receives them, and each pose's contours.
async function morphInput(svgA, svgB) {
  const A = await importSvg(svgA),
    B = await importSvg(svgB);
  const pa = parseMetaBin(A.meta, A.metaFloatsPerShape),
    pb = parseMetaBin(B.meta, B.metaFloatsPerShape);
  const input = {
    srcCurve: new Float32Array(A.curves),
    dstCurve: new Float32Array(B.curves),
    srcMeta: pa.metaFloats,
    dstMeta: pb.metaFloats,
    metaStride: pa.floatsPerShape,
    ranges: A.curveRangesByShape,
    numShapes: A.numShapes,
  };
  const r = A.curveRangesByShape[0];
  input.bb = A.globalBBox; // the morph bundle's em box is its source bundle's (morphCore)
  return {
    input,
    sc: curveRangeToContours(input.srcCurve, r.begin, r.end),
    dc: curveRangeToContours(input.dstCurve, r.begin, r.end),
  };
}

// ── THE EVALUATOR: what an unpacked Loop-Blinn mesh paints at a point ──────────────────────────────
// Interior triangles are ink. A curve face is ink where its implicit is <= 0 (f > 0 is outside the fill,
// _lbCoverage.glsl): f = sign (k^3 - l m) over klmn rows interpolated across the face, sign * Bezout for a
// resultant face, sign (u^2 - v r) for a quad. A point any face calls ink is ink.
const bary = (px, py, T) => {
  const ax = T[0],
    ay = T[1],
    bx = T[2],
    by = T[3],
    cx = T[4],
    cy = T[5];
  const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (d === 0) return null;
  const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / d,
    w2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / d;
  const w0 = 1 - w1 - w2;
  return w0 >= 0 && w1 >= 0 && w2 >= 0 ? [w0, w1, w2] : null;
};
function meshInk(m, x, y, st) {
  const I = m.interior;
  for (let o = 0; o + 5 < I.length; o += 6)
    if (bary(x, y, I.subarray(o, o + 6))) {
      st.interior++;
      return true;
    }
  let face = false;
  for (const c of m.cubics || []) {
    const w = bary(x, y, c.hull);
    if (!w) continue;
    face = true;
    let f;
    if (c.klmn) {
      const K = c.klmn,
        k = w[0] * K[0] + w[1] * K[3] + w[2] * K[6];
      f =
        c.sign *
        (k * k * k -
          (w[0] * K[1] + w[1] * K[4] + w[2] * K[7]) * (w[0] * K[2] + w[1] * K[5] + w[2] * K[8]));
    } else f = c.sign * evalBezout(c.F, x, y);
    if (f <= 0) {
      st.curveInk++;
      return true;
    }
  }
  for (const q of m.quads || []) {
    const w = bary(x, y, q.tri);
    if (!w) continue;
    face = true;
    const T = q.tc,
      u = w[0] * T[0] + w[1] * T[3] + w[2] * T[6],
      v = w[0] * T[1] + w[1] * T[4] + w[2] * T[7];
    const r = (q.w || 1) !== 1 ? w[0] * T[2] + w[1] * T[5] + w[2] * T[8] : 1;
    if ((q.sign > 0 ? 1 : -1) * (u * u - v * r) <= 0) {
      st.curveInk++;
      return true;
    }
  }
  if (face) st.curveAir++;
  return false;
}
/// Every grid sample of `contours` (G x G over its control box), and four points inside every curve face
/// of `mesh`, farther than `frac` of the diagonal from its outline, read by `mesh` and by the exact
/// winding of the contours. The face samples are what make it a test of the curve faces: the grid alone
/// lands a few dozen samples in crescents this thin.
function compareFill(mesh, contours, G = 96, frac = 2e-3) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of contours)
    for (const s of c)
      for (const p of [s.p1, s.p2, s.p3, s.p4])
        if (p) {
          x0 = Math.min(x0, p[0]);
          x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]);
          y1 = Math.max(y1, p[1]);
        }
  const margin = frac * Math.hypot(x1 - x0, y1 - y0);
  // The outline (cubics and lines, all these rings have), sampled finely and binned by `margin` so "near
  // the outline" is a 3x3 cell lookup.
  const bins = new Map(),
    cell = (v, o) => Math.floor((v - o) / margin);
  for (const c of contours)
    for (const s of c)
      for (let i = 0; i <= 1000; i++) {
        const t = i / 1000;
        const p = s.p4
          ? cubicPt([s.p1, s.p2, s.p3, s.p4], t)
          : [s.p1[0] + (s.p2[0] - s.p1[0]) * t, s.p1[1] + (s.p2[1] - s.p1[1]) * t];
        const k = cell(p[0], x0) + ',' + cell(p[1], y0);
        (bins.get(k) || bins.set(k, []).get(k)).push(p);
      }
  const near = (x, y) => {
    const cx = cell(x, x0),
      cy = cell(y, y0);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of bins.get(cx + dx + ',' + (cy + dy)) || [])
          if (Math.hypot(p[0] - x, p[1] - y) < margin) return true;
      }
    return false;
  };
  const segs = contours.flat();
  const st = {
    samples: 0,
    ink: 0,
    air: 0,
    interior: 0,
    curveInk: 0,
    curveAir: 0,
    wrong: 0,
    at: [],
  };
  const pts = [];
  for (let i = 0; i < G; i++)
    for (let j = 0; j < G; j++)
      pts.push([x0 + ((x1 - x0) * (i + 0.5)) / G, y0 + ((y1 - y0) * (j + 0.5)) / G]);
  for (const T of [
    ...(mesh.cubics || []).map((c) => c.hull),
    ...(mesh.quads || []).map((q) => q.tri),
  ]) {
    for (const [a, b, c] of [
      [1 / 3, 1 / 3, 1 / 3],
      [2 / 3, 1 / 6, 1 / 6],
      [1 / 6, 2 / 3, 1 / 6],
      [1 / 6, 1 / 6, 2 / 3],
    ])
      pts.push([a * T[0] + b * T[2] + c * T[4], a * T[1] + b * T[3] + c * T[5]]);
  }
  for (const [x, y] of pts) {
    if (near(x, y)) continue;
    st.samples++;
    const truth = rayWinding(segs, x, y) !== 0,
      got = meshInk(mesh, x, y, st);
    if (truth) st.ink++;
    else st.air++;
    if (got !== truth) {
      st.wrong++;
      if (st.at.length < 3)
        st.at.push(`(${x.toFixed(2)},${y.toFixed(2)}) ${truth ? 'ink read air' : 'air read ink'}`);
    }
  }
  return st;
}
/// The worst distance, over every klmn face of `mesh`, between the rows at a face vertex and the
/// piece's own klmn there: k, l and m are one affine function over a cubic piece, fitted here by least
/// squares through all four control points so no triangle of them is privileged. Relative to the
/// largest |k|, |l|, |m| at the control points.
function worstRows(mesh) {
  let worst = 0,
    faces = 0;
  for (const c of mesh.cubics || []) {
    if (!c.klmn || !c.cp) continue;
    const K = cubicKLMN(c.cp);
    if (!K) continue;
    faces++;
    const mx = (c.cp[0][0] + c.cp[1][0] + c.cp[2][0] + c.cp[3][0]) / 4,
      my = (c.cp[0][1] + c.cp[1][1] + c.cp[2][1] + c.cp[3][1]) / 4;
    let sxx = 0,
      sxy = 0,
      syy = 0;
    for (const P of c.cp) {
      const dx = P[0] - mx,
        dy = P[1] - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const det = sxx * syy - sxy * sxy;
    let scale = 0;
    const fit = ['k', 'l', 'm'].map((q) => {
      const v = K[q],
        mv = (v[0] + v[1] + v[2] + v[3]) / 4;
      let sxv = 0,
        syv = 0;
      for (let j = 0; j < 4; j++) {
        sxv += (c.cp[j][0] - mx) * v[j];
        syv += (c.cp[j][1] - my) * v[j];
        scale = Math.max(scale, Math.abs(v[j]));
      }
      const a = (syy * sxv - sxy * syv) / det,
        b = (sxx * syv - sxy * sxv) / det;
      return (x, y) => mv + a * (x - mx) + b * (y - my);
    });
    for (let v = 0; v < 3; v++)
      for (let q = 0; q < 3; q++) {
        worst = Math.max(
          worst,
          Math.abs(fit[q](c.hull[2 * v], c.hull[2 * v + 1]) - c.klmn[3 * v + q]) / scale,
        );
      }
  }
  return { worst, faces };
}
const tell = (s) =>
  `${s.samples} samples (${s.ink} ink, ${s.air} air; curve faces ${s.curveInk} ink ${s.curveAir} air), ${s.wrong} wrong${s.at.length ? ': ' + s.at.join('; ') : ''}`;

// ── THE EVALUATOR ON THE STATIC BUILD, and against the wrong outline ────────────────────────────────
for (const cs of CASES) {
  const { sc, dc } = await morphInput(cs.a, cs.b);
  for (const [pose, C] of [
    ['source', sc],
    ['destination', dc],
  ]) {
    const own = buildLoopBlinnPartition(C, {
      fillRule: 'nonzero',
      skipCurveInterior: true,
      noReorient: true,
      keyContours: C,
    });
    const s = own ? compareFill(own, C) : null;
    ok(
      !!s && s.wrong === 0 && s.curveInk > 0 && s.curveAir > 0 && s.air > 0,
      `evaluator (${cs.name}): the static partition of the ${pose} fills its own outline (${s ? tell(s) : 'did not build'})`,
    );
    if (!own) continue;
    const flipped = compareFill(
      { ...own, cubics: own.cubics.map((c) => ({ ...c, sign: -c.sign })) },
      C,
    );
    ok(
      flipped.wrong >= s.curveInk,
      `evaluator: ...and with its curve faces' signs flipped it reads ${flipped.wrong} samples wrong`,
    );
  }
}

for (const cs of CASES) {
  console.log(`-- ${cs.name}`);
  const { input, sc, dc } = await morphInput(cs.a, cs.b);
  const res = buildMorphBundle(input);
  const mesh = res && res.meshes && res.meshes[0];
  ok(
    !!mesh &&
      !res.hasSlug &&
      mesh.mode === 'partitionPair' &&
      mesh.vertexCount > 0 &&
      !!(mesh.vbo || mesh.segments),
    `buildMorphBundle builds a morph mesh, not Slug (${mesh ? `${mesh.vertexCount} verts, ${mesh.segments ? mesh.segments.length + ' t-segments' : 'one pair'}` : JSON.stringify(Object.keys(res || {}))})`,
  );
  ok(
    !!res.why &&
      res.why.length === 1 &&
      res.why[0] === SLUG_WHY.REAL &&
      !!res.pairWhy &&
      res.pairWhy[0] === null,
    `...and reports the shape REAL with no cause (why ${res.why && Array.from(res.why)}, pairWhy ${JSON.stringify(res.pairWhy)})`,
  );
  const pair = PAIR.buildLoopBlinnPartitionPair(sc, dc, 'nonzero');
  ok(!!pair, `the partition pair builds (${pair ? 'built' : PAIR.lbPairDeclineWhy})`);
  if (!mesh || !pair) continue;
  // THE PAIRS THE MESH IS MADE OF: the whole-morph pair, or the t-segments the drift oracle cut it into.
  const refined =
    typeof MORPH.refinePairByDrift === 'function'
      ? MORPH.refinePairByDrift(sc, dc, 'nonzero', pair)
      : null;
  const parts = refined ? refined.segs : [{ tLo: 0, tHi: 1, tLoB: 0, tHiB: 1, pair }];
  const vbos = mesh.segments ? mesh.segments.map((g) => g.vbo) : [mesh.vbo];
  let same = vbos.length === parts.length;
  for (let j = 0; same && j < parts.length; j++) {
    // packed as lbMorphCore's packPair9 packs a pair (pairedTopology: a static build's klm ring carries its arc)
    const pkS = packLoopBlinnMesh(parts[j].pair.src, undefined, { pairedTopology: true }),
      pkD = packLoopBlinnMesh(parts[j].pair.dst, undefined, { pairedTopology: true }),
      F = LB_VERT_FLOATS,
      V = vbos[j];
    same = V.length === pkS.vertexCount * 2 * F && pkS.vertexCount === pkD.vertexCount;
    for (let i = 0; same && i < pkS.vertexCount; i++)
      for (let k = 0; k < F; k++) {
        if (
          !Object.is(V[i * 2 * F + k], pkS.verts[i * F + k]) ||
          !Object.is(V[i * 2 * F + F + k], pkD.verts[i * F + k])
        ) {
          same = false;
          break;
        }
      }
  }
  ok(
    same,
    `the mesh is its ${parts.length} pair(s): each stream is the pack of its pair's source and destination`,
  );
  const first = parts[0].pair,
    last = parts[parts.length - 1].pair;
  const s0 = compareFill(first.src, sc),
    s1 = compareFill(last.dst, dc);
  ok(s0.wrong === 0 && s0.curveInk > 0, `t = 0 fills the source exactly: ${tell(s0)}`);
  ok(s1.wrong === 0 && s1.curveInk > 0, `t = 1 fills the destination exactly: ${tell(s1)}`);
  const r0 = worstRows(first.src),
    r1 = worstRows(last.dst);
  ok(
    r0.faces > 0 && r0.worst <= 1e-5,
    `t = 0: every klmn face carries its piece's own implicit (${r0.faces} faces, worst ${r0.worst.toExponential(2)})`,
  );
  ok(
    r1.faces > 0 && r1.worst <= 1e-5,
    `t = 1: every klmn face carries its piece's own implicit (${r1.faces} faces, worst ${r1.worst.toExponential(2)})`,
  );
  const x = compareFill(last.dst, sc);
  ok(
    x.wrong > 0,
    `...and the destination does not fill the source's outline (${x.wrong} of ${x.samples} samples differ)`,
  );

  // ── BETWEEN THE POSES ─────────────────────────────────────────────────────────────────────────
  // What the vertex stage draws at 0 < t < 1 is a lerp of two packs, which no builder ever saw. Four properties hold
  // it to the pose, each exact, then the picture itself is scored.
  const q = (C) => emUnitsOf(C).res,
    ext = (cp) =>
      Math.max(
        ...[1, 2, 3].map((j) =>
          Math.max(Math.abs(cp[j][0] - cp[0][0]), Math.abs(cp[j][1] - cp[0][1])),
        ),
      );
  let noChain = 0,
    subQ = 0,
    fenced = 0,
    fencedWorst = 0,
    drift = 0;
  for (const g of parts) {
    const P = g.pair;
    if (!P.src.interiorChainA || !P.dst.interiorChainA) noChain++;
    const cS = poseAt(sc, dc, g.tLoB),
      cD = poseAt(sc, dc, g.tHiB),
      qS = q(cS),
      qD = q(cD);
    for (const rec of P.src.cubicRecs9 || []) if (rec.cp && ext(rec.cp) <= qS) subQ++; // every PIECE, faces or not
    for (let i = 0; i < P.src.cubics.length; i++) {
      const a = P.src.cubics[i],
        b = P.dst.cubics[i];
      if (b.cp && ext(b.cp) <= qD) subQ++;
      if (a.klmn || !a.keep) continue;
      for (const u of [0.25, 0.5, 0.75]) {
        const kb = b.keep || [0, 0, 0],
          m = [a.keep[0] + (kb[0] - a.keep[0]) * u, a.keep[1] + (kb[1] - a.keep[1]) * u];
        const c = a.keep[2] + (kb[2] - a.keep[2]) * u,
          arc = a.cp.map((p, k) => [
            p[0] + (b.cp[k][0] - p[0]) * u,
            p[1] + (b.cp[k][1] - p[1]) * u,
          ]);
        const over = support(arc, m[0], m[1]) - c;
        if (over > 1e-9 * Math.max(1, Math.abs(c))) {
          fenced++;
          fencedWorst = Math.max(fencedWorst, over / ext(arc));
        }
      }
    }
    drift = Math.max(drift, PAIR.pairImplicitDrift(P.src, P.dst, 0, 1));
  }
  ok(
    noChain === 0,
    `every pair's interior carries the static build's analytic chains on both streams (${noChain} without)`,
  );
  ok(subQ === 0, `no piece is smaller than its pose's vertex quantum (${subQ} are)`);
  ok(
    fenced === 0,
    `every Bezout face's keep half-plane holds its own arc at every t (${fenced} cut it, by up to ${fencedWorst.toExponential(2)} of the piece)`,
  );
  ok(
    drift <= 0.002 && !(refined && refined.declined),
    `every pair's lerped implicit stays within the drift bar, 0.002 of a chord (worst ${drift.toExponential(2)})`,
  );
  // THE PICTURE, scored as probes/morph/_morphExactRef.mjs scores the GPU: the morph bundle's own em box on a 256 px
  // canvas, pixels off the exact coverage of the lerped pose by more than 32/255. A static Loop-Blinn build of the same
  // pose has a floor on this metric -- its quarter-pixel rings leave some of the antialiasing just outside a curve
  // unpainted -- so the morph is held to that build's count plus a quarter, and to losing no ink inside the fill.
  const bb = input.bb;
  for (const t of [0.2, 0.45, 0.7]) {
    const pose = poseAt(sc, dc, t);
    const m = EMU.scoreExact(EMU.render(EMU.morphPacksAt(mesh, t), bb).cov, pose, bb);
    const st = EMU.scoreExact(
      EMU.render(EMU.staticPacks(buildLbShape(pose, false, false).raw), bb).cov,
      pose,
      bb,
    );
    const lim = st.off + Math.ceil(st.off / 4) + 3;
    ok(
      m.lostIn === 0 && m.off <= lim,
      `t = ${t}: ${m.off} px off exact (over ${m.over}, lost inside ${m.lostIn}, lost outside ${m.lostOut}); ` +
        `a static build of the pose ${st.off} (over ${st.over}, lost inside ${st.lostIn}, lost outside ${st.lostOut}); at most ${lim}, none lost inside`,
    );
  }
}

// ── unifiedMorphSmoke's SOLID MORPH, and a flip, no worse than the baseline at any t ─────────────────────
// `was` is the baseline: the off-exact counts this evaluator reads without the between-poses chain choice. The flip (a
// dome into a dish, probes/morphScale/_morphPairs.mjs) holds the chain choice to every t: a piece convex at the source and
// concave at the destination that takes its control polygon loses ink pixels at t = 0.75 and 1 (at 128 px).
{
  const u = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#3060c0"/></svg>`;
  for (const cs of [
    {
      name: 'unifiedMorphSmoke: a circle into an irregular outline',
      was: { 0: 0, 0.25: 3, 0.5: 11, 0.75: 3, 1: 6 },
      a: u('M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z'),
      b: u('M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z'),
    },
    {
      name: 'a dome into a dish (flip)',
      was: { 0: 3, 0.25: 0, 0.5: 8, 0.75: 2, 1: 4 },
      a: svgOf('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
      b: svgOf('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
    },
  ]) {
    console.log(`-- ${cs.name}`);
    const { input, sc, dc } = await morphInput(cs.a, cs.b);
    const res = buildMorphBundle(input),
      mesh = res && res.meshes && res.meshes[0];
    ok(
      !!mesh && !res.hasSlug && mesh.mode === 'partitionPair',
      `buildMorphBundle builds a morph mesh, not Slug`,
    );
    if (mesh)
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const pose = poseAt(sc, dc, t),
          m = EMU.scoreExact(EMU.render(EMU.morphPacksAt(mesh, t), input.bb).cov, pose, input.bb);
        ok(
          m.lostIn === 0 && m.off <= cs.was[t],
          `t = ${t}: ${m.off} px off exact (over ${m.over}, lost inside ${m.lostIn}, ` +
            `lost outside ${m.lostOut}); baseline ${cs.was[t]}; none lost inside`,
        );
      }
  }
}

// ── A DECLINE NAMES ITSELF, all the way to the bundle ───────────────────────────────────────────────
{
  console.log('-- a disc into a wobble (declines)');
  const K = 0.5522847498,
    e = (cx, cy, r) =>
      `M ${cx + r} ${cy} C ${cx + r} ${cy - K * r} ${cx + K * r} ${cy - r} ${cx} ${cy - r} ` +
      `C ${cx - K * r} ${cy - r} ${cx - r} ${cy - K * r} ${cx - r} ${cy} C ${cx - r} ${cy + K * r} ${cx - K * r} ${cy + r} ${cx} ${cy + r} ` +
      `C ${cx + K * r} ${cy + r} ${cx + r} ${cy + K * r} ${cx + r} ${cy} Z`;
  const WOBBLE =
    'M100 40 C140 10 170 50 165 100 C160 150 140 170 100 165 C55 160 30 140 35 100 C40 50 60 10 100 40 Z';
  const { input, sc, dc } = await morphInput(svgOf(e(100, 100, 60)), svgOf(WOBBLE));
  // The cause the builder itself reports for the last full-interval attempt buildMorphShape makes.
  const direct = PAIR.buildLoopBlinnPartitionPair(sc, dc, 'nonzero', { plainDstRows: true })
    ? null
    : PAIR.lbPairDeclineWhy;
  ok(
    typeof direct === 'string' && direct.length > 0,
    `the pair declines, and says why ('${direct}')`,
  );
  const said = (r) =>
    !!r &&
    !!r.why &&
    r.why.length === 1 &&
    r.why[0] === SLUG_WHY.DECLINED &&
    !!r.pairWhy &&
    r.pairWhy[0] === direct;
  const tellWhy = (r) =>
    r
      ? `hasSlug ${!!r.hasSlug}, why ${r.why && Array.from(r.why)}, pairWhy ${JSON.stringify(r.pairWhy)}`
      : 'no result';
  const res = buildMorphBundle(input);
  ok(res.hasSlug && said(res), `buildMorphBundle: Slug, DECLINED, '${direct}' (${tellWhy(res)})`);

  // The real worker module, through a stand-in `self` (lbWorkerWireParitySmoke's idiom).
  let posted = null;
  globalThis.self = {
    postMessage: (m) => {
      posted = m;
    },
  };
  await import('../src/renderer/lbBuild.worker.js');
  globalThis.self.onmessage({ data: { id: 7, kind: 'morph', ...input } });
  ok(
    !!posted && posted.kind === 'morph' && posted.hasSlug && said(posted),
    `the worker posts it (${tellWhy(posted)})`,
  );

  // The pool, both ways a build comes back: the synchronous fallback (no Worker here), and a Worker bridged to the
  // worker module above -- a fresh copy of the pool, since the first one has already settled on the fallback.
  const bundle = {
    numShapes: input.numShapes,
    _morphSrc: {
      mergedCurveF32: input.srcCurve,
      dstCurveF32: input.dstCurve,
      mergedMetaF32: input.srcMeta,
      dstMetaF32: input.dstMeta,
      metaStride: input.metaStride,
      curveRanges: input.ranges,
    },
  };
  const viaSync = await new Promise(async (resolve) =>
    (await import('../src/renderer/lbWorkerPool.js')).requestMorphBuild(bundle, resolve),
  );
  ok(said(viaSync), `the pool's synchronous build hands it back (${tellWhy(viaSync)})`);
  let bridged = 0;
  class BridgedWorker {
    constructor() {
      globalThis.self.postMessage = (m) => queueMicrotask(() => this.onmessage({ data: m }));
    }
    postMessage(m) {
      bridged++;
      queueMicrotask(() => globalThis.self.onmessage({ data: m }));
    }
    terminate() {}
  }
  globalThis.Worker = BridgedWorker;
  const pool2 = await import('../src/renderer/lbWorkerPool.js?bridged');
  const viaWorker = await new Promise((resolve) => pool2.requestMorphBuild(bundle, resolve));
  delete globalThis.Worker;
  ok(
    bridged === 1 && said(viaWorker),
    `the pool's worker path hands it back (${bridged} message through the bridge; ${tellWhy(viaWorker)})`,
  );

  // ...and the renderer adopts it onto the bundle (morphDraw's _applyMorphResult, reached through the route's own
  // _ensureBundleMorphMeshes on a stub context, lbDeclineCensusSmoke's idiom), where lbMorphCensus counts it.
  const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
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
  attachMorphDraw(R);
  const live = {
    numShapes: bundle.numShapes,
    _morphSrc: { ...bundle._morphSrc, matchedAll: true },
  };
  ok(
    lbMorphCensus(live).unknown === 1,
    'lbMorphCensus: before the build reports, the shape is unknown, not a decline',
  );
  R._ensureBundleMorphMeshes(live);
  for (let i = 0; i < 100 && !live._morphMeshesBuilt; i++)
    await new Promise((r) => setTimeout(r, 5));
  const c = lbMorphCensus(live);
  ok(
    live._morphMeshesBuilt &&
      live._morphMeshes === null &&
      c.declined === 1 &&
      c.pairWhy[direct] === 1 &&
      c.unknown === 0,
    `the bundle falls to Slug and lbMorphCensus reads why off it: ${JSON.stringify(c)}`,
  );
}

console.warn = warn;
console.log(fail ? `LB-MORPH-RING-PAIR FAIL (${fail})` : 'LB-MORPH-RING-PAIR PASS');
process.exit(fail ? 1 : 0);
