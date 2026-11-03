// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanFaceClassifySmoke: the union keeps every face its fill rule keeps, whatever the face is made of.
//
// (a) unionContours keeps a contour that encloses area only through an arc: an arc counted as its chord would make a half disc
//     read as zero area, also through importSvg({ computeSilhouette }).
// (b) The canonical extent includes an arc's radii: without them a full turn reads as zero extent, or as the rounding of its seam.
// (c) A cubic's own double point is cut; uncut, the arrangement keeps a crossing inside its edges and classifies a face that is
//     really two.
// (d) A ray through a vertex where a curve's tangent is horizontal gives that crossing a direction, so nonzero counts it.
// (e) A face narrower than a ten-thousandth of its length is classified by a point inside it, not one past its far side.
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { unionContours } = await import('../src/svg/pathBoolean/union.js');
const { intersectSegmentsExact } = await import('../src/svg/pathBoolean/intersect/exact.js');
const { pointInShape } = await import('../src/svg/pathBoolean/planar/fillRule.js');
const { mkLine: L, mkQuad: Q, mkCubic: C, mkArc } = await import('../src/svg/segment.js');
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-300);
const pts = (s, n = 256) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      u = 1 - t;
    if (s.type === 0) out.push([u * s.p1[0] + t * s.p2[0], u * s.p1[1] + t * s.p2[1]]);
    else if (s.type === 1)
      out.push([0, 1].map((k) => u * u * s.p1[k] + 2 * u * t * s.p2[k] + t * t * s.p3[k]));
    else if (s.type === 2)
      out.push(
        [0, 1].map(
          (k) =>
            u * u * u * s.p1[k] +
            3 * u * u * t * s.p2[k] +
            3 * u * t * t * s.p3[k] +
            t * t * t * s.p4[k],
        ),
      );
    else {
      const th = s.theta_start + (s.theta_end - s.theta_start) * t;
      out.push([s.cx + s.rx * Math.cos(th), s.cy + s.ry * Math.sin(th)]);
    }
  }
  return out;
};
const areaOf = (contours) => {
  let sum = 0;
  for (const c of contours) {
    let a = 0;
    for (const s of c) {
      const P = pts(s);
      for (let i = 0; i + 1 < P.length; i++) a += P[i][0] * P[i + 1][1] - P[i + 1][0] * P[i][1];
    }
    sum += Math.abs(a) / 2;
  }
  return sum;
};
const union = (shapes) => unionContours(shapes, { intersect: intersectSegmentsExact });
const rect = (x, y, w, h) => [
  L([x, y], [x + w, y]),
  L([x + w, y], [x + w, y + h]),
  L([x + w, y + h], [x, y + h]),
  L([x, y + h], [x, y]),
];
const circleSeg = (cx, cy, r) =>
  mkArc(cx, cy, r, r, 0, 2 * Math.PI, 0, 1, 1, [cx + r, cy], [cx + r, cy]);

// (a) A half disc: one arc and its chord.
{
  const arc = mkArc(0, 10, 10, 10, -Math.PI / 2, Math.PI / 2, 0, 0, 1, [0, 0], [0, 20]);
  const u = union([{ segs: [arc, L([0, 20], [0, 0])], fillRule: 'nonzero' }]);
  ok(
    u.length === 1 && near(areaOf(u), Math.PI * 50, 1e-3),
    `half disc keeps its contour: ${u.length} contour(s), area ${areaOf(u).toFixed(2)}`,
  );
  const b = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0A10 10 0 0 1 0 20Z"/></svg>',
    { computeSilhouette: true },
  );
  const ids = b.shapeIds || [];
  ok(
    Array.from(ids).includes('__silhouette__') || b.numShapes === 2,
    `the silhouette of a half disc exists: ${b.numShapes} row(s)`,
  );
}

// (b) A circle alone, at every size, and with the rounded seam of an angle pair at the origin.
for (const r of [1e-7, 1e-3, 1, 1e4]) {
  const u = union([{ segs: [circleSeg(0, 0, r)], fillRule: 'nonzero' }]);
  ok(
    u.length === 1 && near(areaOf(u), Math.PI * r * r, 1e-3),
    `circle r=${r} survives: area ${areaOf(u)}`,
  );
}
{
  const u = union([{ segs: [mkArc(0, 0, 1, 1, -Math.PI, Math.PI, 0, 1, 1)], fillRule: 'nonzero' }]);
  ok(
    u.length === 1 && near(areaOf(u), Math.PI, 1e-3),
    `a seam open by rounding survives: ${u.length} contour(s)`,
  );
}

// (c) A looped cubic in a contour with other crossings.
{
  const shape = {
    fillRule: 'evenodd',
    segs: [
      Q(
        [57.007705073028745, 23.944077785126865],
        [16.751407785341144, 60.65069225151092],
        [48.70753133459569, 36.96030120742758],
      ),
      L([48.70753133459569, 36.96030120742758], [34.061594979117395, 33.61476844504779]),
      L([34.061594979117395, 33.61476844504779], [25.1906196716012, 23.94407778512687]),
      Q(
        [25.1906196716012, 23.94407778512687],
        [36.406973958946764, 41.93581314757466],
        [34.552454611165224, 14.441952777548517],
      ),
      L([34.552454611165224, 14.441952777548517], [47.983025150654434, 14.616130201273728]),
      C(
        [47.983025150654434, 14.616130201273728],
        [63.64077285397798, 81.04156497865915],
        [34.55289991106838, 89.33126837946475],
        [57.007705073028745, 23.944077785126865],
      ),
    ],
  };
  const out = union([shape]).flat();
  let wrong = 0,
    total = 0;
  for (let y = 12.3; y < 80; y += 1.37)
    for (let x = 20.1; x < 62; x += 1.37) {
      total++;
      if (pointInShape([x, y], shape.segs, 'evenodd') !== pointInShape([x, y], out, 'evenodd'))
        wrong++;
    }
  ok(wrong === 0, `looped cubic: ${wrong} of ${total} samples differ from the input's rule`);
}

// (d) One curved side ending level, and the midpoint of the straight side on that level.
{
  const segs = [
    L([70, 30], [20, 60]),
    L([20, 60], [20, 0]),
    C([20, 0], [50, 30], [60, 30], [70, 30]),
  ];
  ok(
    pointInShape([25, 30], segs, 'nonzero') === true,
    'a ray through a level curve end counts that crossing',
  );
  ok(pointInShape([25, 30], segs, 'evenodd') === true, 'even-odd agrees');
  ok(pointInShape([100, 30], segs, 'nonzero') === false, 'past the vertex is outside');
  const u = union([{ segs, fillRule: 'nonzero' }]);
  ok(u.length === 1, `that shape has a union: ${u.length} contour(s)`);
  // A curve that leaves the ray at its start, turns, and crosses it again: counted once.
  const hump = [
    Q([0, 30], [10, 60], [20, 0]),
    L([20, 0], [-10, 0]),
    L([-10, 0], [-10, 30]),
    L([-10, 30], [0, 30]),
  ];
  ok(
    pointInShape([-5, 30], hump, 'nonzero') === true,
    'a curve leaving the ray and crossing it later is one crossing (nonzero)',
  );
  ok(pointInShape([-5, 30], hump, 'evenodd') === true, 'and one crossing (even-odd)');
}

// (e) Thin faces, 1/20000 and 1/4000 of their length, and the wall of a frame.
{
  const thin = union([{ segs: rect(0, 0, 1000, 0.05), fillRule: 'nonzero' }]);
  ok(
    thin.length === 1 && near(areaOf(thin), 50, 1e-6),
    `hairline rect: ${thin.length} contour(s), area ${areaOf(thin)}`,
  );
  const thin2 = union([{ segs: rect(0, 0, 1000, 0.25), fillRule: 'nonzero' }]);
  ok(thin2.length === 1 && near(areaOf(thin2), 250, 1e-6), `thin rect: area ${areaOf(thin2)}`);
  const frame = union([
    { segs: [...rect(0, 0, 1000, 1000), ...rect(0.05, 0.05, 999.9, 999.9)], fillRule: 'evenodd' },
  ]);
  ok(frame.length === 2, `a thin frame's two rims: ${frame.length} contour(s)`);
}

if (fail) {
  console.log(`pathBooleanFaceClassifySmoke: FAIL (${fail})`);
  process.exit(1);
}
console.log('pathBooleanFaceClassifySmoke: PASS');
process.exit(0);
