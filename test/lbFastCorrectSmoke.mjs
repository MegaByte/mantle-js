// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbFastCorrectSmoke — the CORRECT fast Loop-Blinn build against exact coverage, one case per way the
// plain fast build (correct = false) goes wrong.
//
// buildLoopBlinnMesh(contours, ramp, fillRule, bailOnDecline, correct = true) resolves the outline first
// (lbFastResolve.js) and gives the interior analytic chain faces on a constrained Delaunay triangulation
// of its rims. The lightweight stream builds with it (buildLbShape `fastCorrect`). Each case below is an
// outline the plain fast build draws WRONG, and asserts both halves: the plain build is wrong on it (so the
// case exercises its mechanism), and the correct build is right -- no whole pixel wrong, no error more
// than 1.5 px from an edge, and its edge pixels no worse than the static route's where that is the claim.
//
// Scored by the CPU Loop-Blinn draw model (probes/lbAccuracy/_lbStaticDrawEmu.mjs, every kind the
// builders pack) against the exact coverage of the outline under its fill rule (8x8 samples per pixel;
// a pixel is wrong when it is more than 32/255 off).
//
//   hull overlap     a road band whose concave control point reaches past the opposite edge: the rim
//                    polygon crosses itself and earcut tiles air (thousands of pixels painted outside).
//                    Halving the curves whose hulls overlap is Loop & Blinn's own remedy.
//   no side          a closed cubic teardrop: its ends coincide, so it has no chord to take a side of,
//                    and its whole control triangle is painted. Halved until every piece has a side.
//   cusp             a cubic with a cusp: cubicLoop reads a cusp as a loop and the shape falls back
//                    (a lightweight stream does not draw a fallback at all). Split at the cusp.
//   crossing         a circle crossing a ring (rational quads, which resolveSelfOverlap does not take):
//                    earcut tiles the crossing. DECLINED to the static route, which draws it.
//   ulp line         a pill: its `Z` after an arc draws a closing line a fraction of an ulp long, the
//                    arc's control edge overlaps the top edge by that fraction, and the build declines a
//                    shape it draws exactly. A line within a float32 ulp of a point is that point.
//   non-boundary     nonzero, a square inside a square wound the same way: nesting parity cuts it out as
//                    a hole. A contour with the same fill on both sides is dropped.
//   pinch            three triangles sharing an apex written as ONE subpath: the rim touches itself at the
//                    apex and two of the triangles are lost (the static route loses them too). Cut into
//                    its loops where it returns to a vertex.
//   fill side        tiger #228, a sliver whose curves bulge past each other's chords: a contour's fill
//                    side probed against the even-odd parity of the chord polygon, which crosses itself,
//                    cuts every crescent on the wrong side. Asked of the outline instead.
//   collinear curve  a quadrilateral drawn with straight quads (control point on an end): no crescent and
//                    no straight-edge strip, so the outer half of every edge goes unpainted. Such a curve
//                    is its line.
//   Bezout keep      tiger #26: a near-straight Bezout crescent (|grad| ~ 0) paints solid ink outside the
//                    path. The piece carries its keep half-plane, as the partition's do.
//   chain faces      a concave road band: faces beside a concave curve's control edges paint a flat 1.0
//                    through the inner half of the edge. Chain faces on a Delaunay triangulation.
//   cubic edge       a two-cubic blob: halving every cubic until it is flat puts the exterior ring (a
//                    quarter pixel past a hull that hugs the arc) where it leaves the pixels just outside
//                    unpainted, and the chain outgrows the face kernel's window -- softer than the static
//                    route's edge. Split only for what the crescent needs; chains of at most four segments.
//                    And an arch closed by a line (_fatcubic2): unsplit, its chord lies ON the line and the
//                    crescent paints 1.0 along it -- a curve whose chord lies on a line is split.
//   vertex economy   tiger's cubic shapes: split only as far as the crescents need, at most 1.25x the
//                    static route's vertices (an extension test that fires on the piece's own end vertex
//                    at every level, or halving every folded control polygon though only a concave
//                    piece's rim runs through it, splits far more).
//
// FAILS WITHOUT `correct`: every case (the ulp-line case: the plain build declines the pill as a
// crossing).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { buildLoopBlinnMesh, packLoopBlinnMesh } = await import('../src/renderer/loopBlinn.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { rayWinding, curveRangeToContours } = await import('../src/geom/lbContour.js');
const { mkLine, mkQuad, mkCubic } = await import('../src/primitives/seg.js');
const { renderStatic } = await import('../probes/lbAccuracy/_lbStaticDrawEmu.mjs');
const { default: importSvg } = await import('../src/svg/importer.js');
const { example, have } = await import('./_assets.mjs');
const { readFileSync } = await import('node:fs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f32 = (p) => [Math.fround(p[0]), Math.fround(p[1])];
const L = (a, b) => mkLine(f32(a), f32(b)),
  Q = (a, c, b) => mkQuad(f32(a), f32(c), f32(b));
const C = (a, c1, c2, b) => mkCubic(f32(a), f32(c1), f32(c2), f32(b));

function segPt(sg, t) {
  const u = 1 - t,
    a = sg.p1;
  if (!sg.p3) return [a[0] + (sg.p2[0] - a[0]) * t, a[1] + (sg.p2[1] - a[1]) * t];
  if (sg.p4)
    return [0, 1].map(
      (k) =>
        u * u * u * a[k] +
        3 * u * u * t * sg.p2[k] +
        3 * u * t * t * sg.p3[k] +
        t * t * t * sg.p4[k],
    );
  const w = sg.w || 1,
    d = u * u + 2 * u * t * w + t * t;
  return [0, 1].map((k) => (u * u * a[k] + 2 * u * t * w * sg.p2[k] + t * t * sg.p3[k]) / d);
}
/// Score a raw mesh over the outline `contours`: whole pixels wrong (outside / inside, and those more than
/// 1.5 px from any edge), and edge pixels more than 32/255 off the exact area. `emPerPx` sets the raster.
function score(mesh, contours, evenodd, emPerPx) {
  if (!mesh) return { none: true };
  if (mesh.fallback && mesh.fallback.length) return { declined: mesh.declined || 'fallback' };
  const segs = contours.flat();
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
  const N = Math.min(320, Math.ceil(Math.max(x1 - x0, y1 - y0) / emPerPx) + 4),
    bb = [x0 - 2 * emPerPx, y0 - 2 * emPerPx, N * emPerPx, N * emPerPx];
  const pk = packLoopBlinnMesh(mesh);
  const cov = renderStatic({ S: pk.verts, D: pk.verts, n: pk.vertexCount, lt: 0 }, bb, N).cov;
  const inside = (px, py) => {
    const w = rayWinding(segs, bb[0] + px * emPerPx, bb[1] + py * emPerPx);
    return evenodd ? (w & 1) !== 0 : w !== 0;
  };
  // The outline sampled a quarter pixel apart (its control polygon's length bounds its arc length).
  const outline = [];
  for (const s of segs) {
    const P = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
    let len = 0;
    for (let i = 1; i < P.length; i++)
      len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const n = Math.max(16, Math.ceil(len / (0.25 * emPerPx)));
    for (let i = 0; i <= n; i++) outline.push(segPt(s, i / n));
  }
  const far = (px, py) => {
    const ex = bb[0] + px * emPerPx,
      ey = bb[1] + py * emPerPx;
    for (const q of outline) if (Math.hypot(q[0] - ex, q[1] - ey) <= 1.5 * emPerPx) return false;
    return true;
  };
  const r = { out: 0, in: 0, far: 0, edgeBad: 0, verts: pk.vertexCount };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const g = Math.max(0, cov[y * N + x]);
      let n = 0;
      for (let a = 0; a < 8; a++)
        for (let b = 0; b < 8; b++) if (inside(x + (a + 0.5) / 8, y + (b + 0.5) / 8)) n++;
      if (Math.abs(g - n / 64) <= 32 / 255) continue;
      if (n === 0 || n === 64) {
        if (n === 0) r.out++;
        else r.in++;
        if (far(x + 0.5, y + 0.5)) r.far++;
      } else r.edgeBad++;
    }
  return r;
}
const fmt = (s) =>
  s.none
    ? 'no mesh'
    : s.declined
      ? `declined (${s.declined})`
      : `whole px out ${s.out} in ${s.in} (far ${s.far}), edge ${s.edgeBad}, ${s.verts} verts`;
const clean = (s) => !s.none && !s.declined && s.out === 0 && s.in === 0 && s.far === 0;

/// One case: the plain build, the correct build and the static route on the same outline.
function run(
  name,
  contours,
  { evenodd = false, emPerPx = 1, expectOldWrong, expectDecline, edgeVsStatic, expectNew } = {},
) {
  const fr = evenodd ? 'evenodd' : 'nonzero';
  let old = null,
    cor = null;
  try {
    old = buildLoopBlinnMesh(contours, true, fr);
  } catch {
    old = null;
  }
  try {
    cor = buildLoopBlinnMesh(contours, true, fr, false, true);
  } catch (e) {
    console.log(e.stack);
    cor = null;
  }
  const st = buildLbShape(contours, false, evenodd);
  const so = score(old, contours, evenodd, emPerPx),
    sc = score(cor, contours, evenodd, emPerPx),
    ss = score(st && st.raw, contours, evenodd, emPerPx);
  console.log(`${name}\n    plain: ${fmt(so)}\n  correct: ${fmt(sc)}\n   static: ${fmt(ss)}`);
  ok(
    expectOldWrong(so),
    `${name}: the plain fast build is wrong here (the case exercises its mechanism)`,
  );
  if (expectDecline)
    ok(
      sc.declined === expectDecline && !ss.none && !ss.declined && ss.far === 0,
      `${name}: the correct build declines (${expectDecline}) to the static route, which draws it`,
    );
  else if (expectNew) ok(expectNew(sc, ss), `${name}: ${expectNew.what}`);
  else ok(clean(sc), `${name}: the correct build has no whole pixel wrong`);
  if (edgeVsStatic)
    ok(
      !sc.declined && sc.edgeBad <= ss.edgeBad,
      `${name}: its edge pixels are no worse than the static route's (${sc.edgeBad} <= ${ss.edgeBad})`,
    );
  return { so, sc, ss };
}
const oldPaintsOut = (s) => s.none || s.declined || s.out > 0;

// ---- hull overlap ----------------------------------------------------------------------------------
const quadEdge = (n, m, f) => Q(n, [2 * m[0] - (n[0] + f[0]) / 2, 2 * m[1] - (n[1] + f[1]) / 2], f);
const band = (yN, yF, rwN, rwF, sway) => {
  const yM = (yN + yF) / 2,
    rwM = (rwN + rwF) / 2,
    cx = 100;
  const nL = [cx - rwN, yN],
    mL = [cx + sway - rwM, yM],
    fL = [cx - rwF, yF],
    nR = [cx + rwN, yN],
    mR = [cx + sway + rwM, yM],
    fR = [cx + rwF, yF];
  return [[quadEdge(nL, mL, fL), Q(fL, fL, fR), quadEdge(fR, mR, nR), Q(nR, nR, nL)]];
};
run('hull overlap: road band, frame 3 of the teleport', band(120, 55, 30, 10, -45), {
  expectOldWrong: oldPaintsOut,
});
run('hull overlap: road band, frame 5 of the teleport', band(190, 40, 80, 6, -55), {
  expectOldWrong: oldPaintsOut,
});

// ---- no side -------------------------------------------------------------------------------------
run(
  'no side: closed cubic teardrop (_fatcubic3)',
  [[C([200, 340], [-60, 200], [460, 200], [200, 340])]],
  { expectOldWrong: oldPaintsOut },
);

// ---- cusp ----------------------------------------------------------------------------------------
run(
  'cusp (_cusp_cuspSteep)',
  [[C([100, 320], [330, 120], [130, 120], [300, 320]), L([300, 320], [100, 320])]],
  { expectOldWrong: (s) => !!(s.none || s.declined) },
);

// ---- crossing ------------------------------------------------------------------------------------
{
  const sec = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" d="M50 8 A42 42 0 1 1 49.9 8 Z M50 26 A24 24 0 1 0 49.9 26 Z M20 50 A30 30 0 1 1 20.1 50 Z"/></svg>',
    { preserveViewport: true },
  );
  const r = sec.curveRangesByShape[0];
  const cs = curveRangeToContours(new Float32Array(sec.curves), r.begin, r.end);
  run('crossing: circles crossing a ring (rational quads)', cs, {
    emPerPx: 0.4,
    expectOldWrong: oldPaintsOut,
    expectDecline: 'crossing',
  });
}

// ---- ulp line -------------------------------------------------------------------------------------
{
  const sec = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150"><path fill="#000" d="M40.5 30.25 H140.5 A30 30 0 0 1 140.5 90.25 H40.5 A30 30 0 0 1 40.5 30.25 Z"/></svg>',
    { preserveViewport: true },
  );
  const r = sec.curveRangesByShape[0];
  const cs = curveRangeToContours(new Float32Array(sec.curves), r.begin, r.end);
  const last = cs[0][cs[0].length - 1];
  ok(
    last.p2 && Math.hypot(last.p2[0] - last.p1[0], last.p2[1] - last.p1[1]) < 2 ** -23 * 40.5,
    'ulp line: the pill decodes with a closing line shorter than a float32 ulp (the case is live)',
  );
  let m = null;
  try {
    m = buildLoopBlinnMesh(cs, true, 'nonzero', false, true);
  } catch {
    m = null;
  }
  const sc = score(m, cs, false, 1);
  console.log(`ulp line: pill\n  correct: ${fmt(sc)}`);
  ok(clean(sc), 'ulp line: the correct build draws the pill (not declined), no whole pixel wrong');
}

// ---- non-boundary contour ------------------------------------------------------------------------
{
  const sq = (x, y, s) => [
    L([x, y], [x + s, y]),
    L([x + s, y], [x + s, y + s]),
    L([x + s, y + s], [x, y + s]),
    L([x, y + s], [x, y]),
  ];
  run(
    'non-boundary: nonzero, a same-wound square inside a square',
    [sq(20.25, 30.5, 60), sq(35.5, 45.25, 30)],
    { expectOldWrong: (s) => s.none || s.declined || s.in > 0 },
  );
}

// ---- pinch ---------------------------------------------------------------------------------------
{
  const V = [100, 100],
    tri = (a, b) => [L(V, a), L(a, b), L(b, V)];
  run(
    'pinch: three triangles sharing an apex, one subpath',
    [[...tri([160, 80], [170, 140]), ...tri([60, 170], [40, 120]), ...tri([90, 20], [140, 30])]],
    { expectOldWrong: (s) => s.none || s.declined || s.in > 0 },
  );
}

// ---- fill side -----------------------------------------------------------------------------------
run(
  'fill side: tiger #228',
  [
    [
      C(
        [393.7673645019531, 473.9495544433594],
        [393.7673645019531, 473.9495544433594],
        [393.41424560546875, 470.7713928222656],
        [396.5924072265625, 472.1839294433594],
      ),
      C(
        [396.5924072265625, 472.1839294433594],
        [399.77056884765625, 473.596435546875],
        [615.5325317382812, 405.4424743652344],
        [657.2017822265625, 462.6494140625],
      ),
      C(
        [657.2017822265625, 462.6494140625],
        [657.2017822265625, 462.6494140625],
        [633.5421142578125, 419.21453857421875],
        [393.7673645019531, 473.9495544433594],
      ),
    ],
  ],
  { emPerPx: 900 / 256, expectOldWrong: oldPaintsOut },
);

// ---- collinear curve -----------------------------------------------------------------------------
{
  const P = [
    [22.3, 30.7],
    [177.1, 18.2],
    [168.6, 131.4],
    [31.9, 119.8],
  ];
  run(
    'collinear curve: a quadrilateral of straight quads',
    [[0, 1, 2, 3].map((i) => Q(P[i], P[i], P[(i + 1) % 4]))],
    { expectOldWrong: (s) => s.none || s.declined || s.edgeBad > 100, edgeVsStatic: true },
  );
}

// ---- Bezout keep ---------------------------------------------------------------------------------
if (have(example('tiger.svg'))) {
  const sec = await importSvg(readFileSync(example('tiger.svg'), 'utf8'), {
    preserveViewport: true,
  });
  const r = sec.curveRangesByShape[26];
  const cs = curveRangeToContours(new Float32Array(sec.curves), r.begin, r.end);
  const g = sec.globalBBox,
    emPerPx = Math.max(g[2], g[3]) / 256;
  // The claim is the fence: no ink outside. Inside, a near-straight Bezout crescent's own antialiasing is
  // soft along its whole length (0.8 where the path covers 1, a pixel in) on this build and the static
  // route alike -- the Bezout kernel's, not this build's.
  const fence = (c, t) => !c.none && !c.declined && c.out === 0 && c.in <= t.in;
  fence.what =
    'the correct build paints no pixel outside, and loses no more inside than the static route';
  run('Bezout keep: tiger #26', cs, { emPerPx, expectOldWrong: oldPaintsOut, expectNew: fence });
  // ---- vertex economy: every cubic shape of tiger, the correct build's vertices against the static route's ----
  {
    const { contoursHaveCubic } = await import('../src/renderer/lbBuildCore.js');
    let vf = 0,
      vs = 0,
      n = 0;
    for (let si = 0; si < sec.numShapes; si++) {
      const rr = sec.curveRangesByShape[si];
      let c1 = null;
      try {
        c1 = curveRangeToContours(new Float32Array(sec.curves), rr.begin, rr.end);
      } catch {
        c1 = null;
      }
      if (!c1 || !c1.length || !contoursHaveCubic(c1)) continue;
      let m = null;
      try {
        m = buildLoopBlinnMesh(c1, true, 'nonzero', false, true);
      } catch {
        m = null;
      }
      if (!m || m.fallback.length) continue;
      const st = buildLbShape(c1, false, false);
      if (!st || !st.pk || !st.pk.vertexCount) continue;
      vf += packLoopBlinnMesh(m).vertexCount;
      vs += st.pk.vertexCount;
      n++;
    }
    ok(
      n > 100 && vf <= 1.25 * vs,
      `vertex economy: tiger's ${n} cubic shapes take ${vf} vertices, the static route ${vs} (${(vf / vs).toFixed(2)}x, at most 1.25x)`,
    );
  }
} else console.log('  skip Bezout keep / vertex economy: examples/tiger.svg is absent');

// ---- chain faces ---------------------------------------------------------------------------------
run('chain faces: a concave road band', band(190, 40, 80, 6, 55), {
  expectOldWrong: (s) => s.none || s.declined || s.out + s.in > 0 || s.edgeBad > 10,
  edgeVsStatic: true,
});
run('chain faces: a concave band, gentle', band(180, 60, 70, 12, 40), {
  expectOldWrong: (s) => s.none || s.declined || s.edgeBad > 4,
  edgeVsStatic: true,
});

// ---- cubic edge -----------------------------------------------------------------------------------
{
  const blob = [
    [C([150, 60], [150, 20], [210, 20], [210, 60]), C([210, 60], [210, 112], [150, 95], [150, 60])],
  ];
  const { sc, ss } = run('cubic edge: a two-cubic blob', blob, {
    expectOldWrong: (s) => s.none || s.declined || s.edgeBad > 5,
    edgeVsStatic: true,
  });
  ok(
    !sc.declined && sc.verts <= ss.verts,
    `cubic edge: ...in no more vertices than the static route (${sc.verts} <= ${ss.verts})`,
  );
  const arch = [[C([60, 340], [20, 20], [380, 20], [340, 340]), L([340, 340], [60, 340])]];
  let m = null;
  try {
    m = buildLoopBlinnMesh(arch, true, 'nonzero', false, true);
  } catch {
    m = null;
  }
  const st = buildLbShape(arch, false, false),
    sa = score(m, arch, false, 1.5),
    sb = score(st && st.raw, arch, false, 1.5);
  console.log(
    `cubic edge: an arch closed on its chord (_fatcubic2)\n  correct: ${fmt(sa)}\n   static: ${fmt(sb)}`,
  );
  // Unsplit, 184 of its edge pixels read the crescent's 1.0 along the line; split, it is at the static route's level.
  ok(
    clean(sa) && sa.edgeBad <= 16,
    `cubic edge: the arch's closing line keeps its ramp (edge ${sa.edgeBad}, static ${sb.edgeBad}, unsplit 184)`,
  );
}

console.log(fail ? `\n${fail} FAILED` : '\nall ok');
process.exit(fail ? 1 : 0);
