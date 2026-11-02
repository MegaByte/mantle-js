// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pointInShapeSeamRaySmoke — the union's point-in-shape test on the ray through a closed contour's SEAM.
//
// pathBoolean/planar/fillRule.js casts a horizontal ray and counts signed crossings. A crossing AT a segment
// endpoint needs care; a guard that asks whether both of the segment's ENDPOINTS sit on the ray, and if so skips
// the segment as "a horizontal sub-segment along the ray itself", is wrong.
//
// THAT IS THE CHORD STANDING IN FOR THE CURVE. It is true of a LINE and of nothing else:
//   - a cubic that leaves the ray and comes back has both ends on it (a blob drawn as two cubics meeting left
//     and right is exactly this);
//   - and a CLOSED contour's seam has the start and the end at the same point, so a `<circle>` -- one full-turn
//     SEG_ARC whose seam sits at theta = pi, i.e. at (cx - r, cy) -- would have its seam crossing skipped outright.
//     One crossing counted instead of two puts every point on the ray y = cy INSIDE the circle, out to infinity
//     on the seam side: `pointInShape([10, 70], circle(170, 70, 26))` would be true.
//
// WHY IT MATTERS TO THE UNION. If unionPaths classified each face only by "inside ANY original shape", a face
// claimed by the shape it belongs to could not be made wrong by a second shape claiming it too. A shape that
// carries a visible region (a clipped silhouette) needs more than being inside a shape, and a wrong ray lets a
// circle elsewhere in the drawing claim the faces the clip removed: a plate clipped to a band comes out with its
// whole unclipped outline again whenever a <circle> is on the page.
//
// A Bezier lies inside its control hull, so it is along the ray exactly when ALL of its control points are; an
// arc with both ends on the ray still bulges off it, and a full turn has both ends at the same point.
//
// No GPU. Five readings: a circle, an ellipse, a two-cubic blob, a shape with REAL horizontal edges on the ray
// (the case the guard exists for, which must not move), and the union that exposes it.
//
// Mutation, required to FAIL: restore `if (|segY0 - y0| <= tolY && |segY1 - y0| <= tolY) continue;`.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { parseShape } = await import('../src/svg/shape.js');
const { elementChildren } = await import('../src/svg/utils.js');
const { pointInShape } = await import('../src/svg/pathBoolean/planar/fillRule.js');
const { unionContours } = await import('../src/svg/pathBoolean/union.js');
const { intersectSegmentsExact } = await import('../src/svg/pathBoolean/intersect/exact.js');
const { mkLine, mkCubic, segStart } = await import('../src/svg/segment.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const parse = (markup) => {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
    'image/svg+xml',
  );
  return elementChildren(doc.documentElement).map((el) => parseShape(el));
};
const rectSegs = (x, y, w, h) => [
  mkLine([x, y], [x + w, y]),
  mkLine([x + w, y], [x + w, y + h]),
  mkLine([x + w, y + h], [x, y + h]),
  mkLine([x, y + h], [x, y]),
];
/// Every sample answered against a closed-form oracle, at every size.
const sweep = (label, segs, oracle, xs, y, rule = 'nonzero') => {
  const bad = [];
  for (const x of xs) {
    const got = pointInShape([x, y], segs, rule);
    if (got !== oracle(x, y)) bad.push(`(${x}, ${y}) reads ${got}`);
  }
  ok(
    bad.length === 0,
    `${label}: ${xs.length} samples on the seam ray${bad.length ? ' -- ' + bad.join(', ') : ''}`,
  );
};

// ------------------------------------------------------------------------------------------------
// (a) a <circle>: one full-turn arc, seam at (cx - r, cy). The ray through the center passes through it.
console.log('(a) a circle, on the ray through its center (which is its seam)');
{
  const [circ] = parse('<circle cx="170" cy="70" r="26"/>');
  const inCircle = (x, y) => Math.hypot(x - 170, y - 70) < 26;
  sweep(
    'circle',
    circ,
    inCircle,
    [-1000, 0, 10, 25, 120, 143, 143.9, 146, 160, 170, 180, 195, 196.1, 250, 1000],
    70,
  );
  // ...and off the seam ray, so the seam handling does not trade one error for another.
  sweep('circle off the seam ray', circ, inCircle, [120, 143, 150, 170, 190, 197, 250], 60);
  sweep('circle, evenodd', circ, inCircle, [0, 120, 150, 170, 190, 250], 70, 'evenodd');
}

// ------------------------------------------------------------------------------------------------
// (b) an <ellipse>: the same seam, non-circular radii.
console.log('(b) an ellipse');
{
  const [ell] = parse('<ellipse cx="50" cy="50" rx="30" ry="12"/>');
  const inEll = (x, y) => ((x - 50) / 30) ** 2 + ((y - 50) / 12) ** 2 < 1;
  sweep('ellipse', ell, inEll, [-100, 0, 19, 19.9, 22, 40, 50, 60, 79, 80.1, 100], 50);
}

// ------------------------------------------------------------------------------------------------
// (c) a blob drawn as two cubics meeting left and right: both ends of both segments sit on the ray.
console.log('(c) a two-cubic blob whose joints are on the ray');
{
  const BLOB = [
    mkCubic([20, 60], [20, 10], [100, 10], [100, 60]),
    mkCubic([100, 60], [100, 110], [20, 110], [20, 60]),
  ];
  // Strictly between the joints is inside; strictly outside them is not. (The joints themselves are boundary.)
  sweep(
    'blob',
    BLOB,
    (x) => x > 20 && x < 100,
    [-50, 0, 10, 19.5, 30, 60, 90, 100.5, 110, 200],
    60,
  );
}

// ------------------------------------------------------------------------------------------------
// (d) the case the guard exists for: REAL horizontal edges lying on the ray must still be skipped, or a shape
//     with a flat side reads its own parity wrong. A cross, whose arms' top and bottom edges are horizontal.
console.log('(d) real horizontal edges on the ray still skip');
{
  const CROSS = [
    [-10, -30],
    [10, -30],
    [10, -10],
    [30, -10],
    [30, 10],
    [10, 10],
    [10, 30],
    [-10, 30],
    [-10, 10],
    [-30, 10],
    [-30, -10],
    [-10, -10],
  ];
  const segs = CROSS.map((p, i) => mkLine(p, CROSS[(i + 1) % CROSS.length]));
  const inCross = (x, y) =>
    (Math.abs(x) < 10 && Math.abs(y) < 30) || (Math.abs(y) < 10 && Math.abs(x) < 30);
  // y = -10 runs ALONG the arms' lower edges; y = -9.9 is just inside them.
  sweep('cross, along the arm edges', segs, inCross, [-50, -40, -31, 0, 31, 40, 50], -10);
  sweep(
    'cross, just inside the arms',
    segs,
    inCross,
    [-50, -40, -29, -20, 0, 20, 29, 40, 50],
    -9.9,
  );
  sweep('cross, through the bar', segs, inCross, [-50, -20, -9, 0, 9, 20, 50], -20);
}

// ------------------------------------------------------------------------------------------------
// (e) the union that exposes it: a plate clipped to a band, with a disc elsewhere on the page. The disc must
//     not claim the faces the clip removed.
console.log('(e) the union: a disc elsewhere does not claim a clipped-away face');
{
  const [circ] = parse('<circle cx="170" cy="70" r="26"/>');
  const plate = {
    segs: rectSegs(10, 40, 220, 60),
    fillRule: 'nonzero',
    regions: [[{ segs: rectSegs(40, 0, 60, 140), fillRule: 'nonzero' }]],
  };
  const cs = unionContours([plate, { segs: circ, fillRule: 'nonzero' }], {
    intersect: intersectSegmentsExact,
  });
  let x0 = Infinity,
    x1 = -Infinity;
  for (const c of cs)
    for (const s of c) {
      const p = segStart(s);
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
    }
  ok(
    cs.length === 2 && Math.abs(x0 - 40) < 1e-6,
    `${cs.length} contours, leftmost x ${x0} (want 40, the band's edge)`,
  );
}

// ------------------------------------------------------------------------------------------------
// (f) and the same answers at every size: the "on the ray" tolerance is relative, so a circle at 2^-20 and at
//     2^20 must read the same.
console.log('(f) the same answers at 2^-20 and 2^20');
for (const e of [-20, 0, 20]) {
  const S = 2 ** e;
  const [circ] = parse(`<circle cx="${170 * S}" cy="${70 * S}" r="${26 * S}"/>`);
  const inCircle = (x, y) => Math.hypot(x - 170 * S, y - 70 * S) < 26 * S;
  sweep(
    `circle at 2^${e}`,
    circ,
    inCircle,
    [-1000, 10, 143, 150, 170, 190, 197, 1000].map((x) => x * S),
    70 * S,
  );
}

console.log(fail ? `pointInShapeSeamRaySmoke FAIL (${fail})` : 'pointInShapeSeamRaySmoke PASS');
process.exit(fail ? 1 : 0);
