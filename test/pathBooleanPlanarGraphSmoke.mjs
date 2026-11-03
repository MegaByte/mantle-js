// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanPlanarGraphSmoke — the union's planar graph has to get the FACES right on the inputs
// where their structure is decided by more than a tangent direction or a vertex polygon.
//
// THE HAZARDS, each in the union's planar graph (planar/dcel.js, union.js):
//   ORDER    edges around a vertex sorted by the tangent angle at the vertex alone tie where two
//            curves TOUCH (a tangency, or two copies of one edge), rounding picks the order, and a
//            wrong order fuses a face with its neighbour: two discs touching externally come back
//            as an EMPTY union.
//   SIGN     marking a face as the unbounded one when the polygon of its VERTICES is clockwise is
//            wrong for a face whose curves bulge past that polygon, which encloses the other way: a
//            3-edge sliver of two overlapping blobs, counter-clockwise, goes unclassified and leaves
//            a notch in the union.
//   NESTING  a piece of the graph that touches nothing -- a disc wholly inside another -- has its
//            own "unbounded" cycle, which must be asked what surrounds it, or the inner disc's rim
//            comes back as a hole in the union.
//   ARCS     the face witness point reads an arc's angles by the names arc segments carry; any other
//            name reads NaN and classifies every face with an arc as its longest edge outside: a
//            circle drawn with arcs would have an EMPTY union. (Two crossing arc circles also need a
//            correct solveQuartic: see polyRootsQuarticSmoke.)
// Two more that ORDER alone cannot reach: two copies of one edge tie to every order, so they are
// merged into one edge; and vertices are matched by distance, since a rounded 1e-5 key splits one
// point whenever its two computations straddle a cell.
//
// (a) each defect's minimal case: the silhouette's even-odd region must equal the union of the
//     inputs at every grid sample, with the right number of contours
// (b) the same cases at nine scales from 1e-6 to 1e6
// (c) touching and coincident inputs that exercise ORDER harder, at 25 scales: vertex on vertex,
//     vertex on curve, internal tangency, identical shapes, a partially shared edge, an edge doubled
//     back on itself
import { unionContours } from '../src/svg/pathBoolean/union.js';
import { pointInShape } from '../src/svg/pathBoolean/planar/fillRule.js';
import { intersectSegmentsExact } from '../src/svg/pathBoolean/intersect/exact.js';
import { mkArc } from '../src/svg/segment.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const KAPPA = 0.5522847498307936;
const cub = (a, b, c, d) => ({ type: 2, p1: a, p2: b, p3: c, p4: d });
const rev = (s) => cub(s.p4, s.p3, s.p2, s.p1);
function disc(cx, cy, r, ang = 0) {
  const rot = (x, y) => [
    cx + Math.cos(ang) * (x - cx) - Math.sin(ang) * (y - cy),
    cy + Math.sin(ang) * (x - cx) + Math.cos(ang) * (y - cy),
  ];
  const P = [
      [cx + r, cy],
      [cx, cy + r],
      [cx - r, cy],
      [cx, cy - r],
    ],
    T = [
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 0],
    ];
  return [0, 1, 2, 3].map((i) => {
    const a = P[i],
      b = P[(i + 1) % 4],
      ta = T[i],
      tb = T[(i + 1) % 4];
    return cub(
      rot(...a),
      rot(a[0] + KAPPA * r * ta[0], a[1] + KAPPA * r * ta[1]),
      rot(b[0] - KAPPA * r * tb[0], b[1] - KAPPA * r * tb[1]),
      rot(...b),
    );
  });
}
const arcDisc = (cx, cy, r) => [
  mkArc(cx, cy, r, r, 0, Math.PI, 0, 0, 1),
  mkArc(cx, cy, r, r, Math.PI, 2 * Math.PI, 0, 0, 1),
];
const S = (segs, fillRule = 'nonzero') => ({ segs, fillRule });
const pts = (s) =>
  s.type === 3
    ? [
        [s.cx - s.rx, s.cy - s.ry],
        [s.cx + s.rx, s.cy + s.ry],
      ]
    : [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
function scaled(shapes, f) {
  return shapes.map((sh) => ({
    ...sh,
    segs: sh.segs.map((s) =>
      s.type === 3
        ? mkArc(
            s.cx * f,
            s.cy * f,
            s.rx * f,
            s.ry * f,
            s.theta_start,
            s.theta_end,
            s.phi,
            s.large_arc_flag,
            s.sweep_flag,
          )
        : cub(...[s.p1, s.p2, s.p3, s.p4].map((p) => [p[0] * f, p[1] * f])),
    ),
  }));
}
// The probe grid: G x G samples laid out on the inputs' padded bbox, off the cell centers.
function probeGrid(shapes, G) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sh of shapes)
    for (const s of sh.segs)
      for (const p of pts(s)) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
  const px = 0.05 * (x1 - x0),
    py = 0.05 * (y1 - y0);
  x0 -= px;
  x1 += px;
  y0 -= py;
  y1 += py;
  const out = [];
  for (let i = 0; i < G; i++)
    for (let j = 0; j < G; j++)
      out.push([x0 + ((i + 0.5013) * (x1 - x0)) / G, y0 + ((j + 0.5027) * (y1 - y0)) / G]);
  return out;
}
// The union of the inputs at each probe. The grid follows the inputs' bbox, so a scaled copy of the inputs answers
// the same at every probe: the region is computed once, at scale 1, and the union at every scale is held to it.
const inputRegion = (shapes, G) =>
  probeGrid(shapes, G).map((p) => shapes.some((sh) => pointInShape(p, sh.segs, sh.fillRule)));
function regionMismatch(shapes, silSegs, G, region) {
  let bad = 0,
    inside = 0;
  for (const [k, p] of probeGrid(shapes, G).entries()) {
    if (region[k]) inside++;
    if (pointInShape(p, silSegs, 'evenodd') !== region[k]) bad++;
  }
  return { bad, inside };
}

const blobA = [
  [
    [61.207, 54.865],
    [61.207, 71.889],
    [42.132, 77.682],
    [29.973, 70.661],
  ],
  [
    [29.973, 70.661],
    [17.813, 63.641],
    [19.033, 46.593],
    [30.496, 39.975],
  ],
  [
    [30.496, 39.975],
    [41.958, 33.357],
    [61.207, 37.841],
    [61.207, 54.865],
  ],
];
const blobB = [
  [
    [65.098, 56.888],
    [65.098, 68.419],
    [60.024, 85.507],
    [44.218, 85.507],
  ],
  [
    [44.218, 85.507],
    [28.412, 85.507],
    [23.278, 68.453],
    [23.278, 56.888],
  ],
  [
    [23.278, 56.888],
    [23.278, 45.323],
    [30.821, 32.63],
    [44.218, 32.63],
  ],
  [
    [44.218, 32.63],
    [57.615, 32.63],
    [65.098, 45.356],
    [65.098, 56.888],
  ],
];
const minimal = [
  [
    'ORDER: two discs touching externally, curve to curve',
    [S(disc(0, 0, 10, Math.PI / 4)), S(disc(20, 0, 10, Math.PI / 4))],
    null,
  ],
  [
    'SIGN: two blobs whose overlap leaves a 3-edge sliver face',
    [S(blobA.map((P) => cub(...P))), S(blobB.map((P) => cub(...P)))],
    1,
  ],
  ['NESTING: a disc wholly inside another', [S(disc(0, 0, 10, 0.3)), S(disc(1, 2, 3, 0.7))], 1],
  [
    'NESTING: a disc inside the hole of a ring',
    [
      S(disc(0, 0, 10, 0.3).concat(disc(0, 0, 6, 0.3).reverse().map(rev))),
      S(disc(0.5, -0.5, 2, 1.1)),
    ],
    3,
  ],
  [
    'NESTING: a disc inside the solid of a ring',
    [S(disc(0, 0, 10, 0.3).concat(disc(0, 0, 4, 0.3).reverse().map(rev))), S(disc(0, 7, 1.5, 1.1))],
    2,
  ],
  ['ARCS: a circle drawn as two arcs', [S(arcDisc(0, 0, 10))], 1],
  ['ARCS: two overlapping circles drawn as arcs', [S(arcDisc(0, 0, 10)), S(arcDisc(12, 3, 8))], 1],
];
const harder = [
  ['touching vertex to vertex', [S(disc(0, 0, 10)), S(disc(20, 0, 10, Math.PI))], null],
  ['touching vertex to curve', [S(disc(0, 0, 10)), S(disc(20, 0, 10, Math.PI / 4))], null],
  [
    'internal tangency, curve to curve',
    [S(disc(0, 0, 10, Math.PI / 4)), S(disc(5, 0, 5, Math.PI / 4))],
    1,
  ],
  ['identical shapes', [S(disc(0, 0, 10, 0.3)), S(disc(0, 0, 10, 0.3))], 1],
];
{
  const C = cub([-10, 0], [-5, 8], [5, -8], [10, 0]);
  const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const bl = (u, v, w) => {
    const P = [C.p1, C.p2, C.p3, C.p4];
    const a = L(P[0], P[1], u),
      b = L(P[1], P[2], u),
      c = L(P[2], P[3], u);
    return L(L(a, b, v), L(b, c, v), w);
  };
  const mid = cub(
    bl(0.25, 0.25, 0.25),
    bl(0.25, 0.25, 0.75),
    bl(0.25, 0.75, 0.75),
    bl(0.75, 0.75, 0.75),
  );
  harder.push([
    'a partially shared edge',
    [
      S([C, cub([10, 0], [10, 12], [-10, 12], [-10, 0])]),
      S([rev(mid), cub(mid.p1, [mid.p1[0], -12], [mid.p4[0], -12], mid.p4)]),
    ],
    1,
  ]);
  // Merging the two copies of an edge is only sound if both copies are cut at the same places. The
  // exact supplement must not "find" a crossing at a point of a curve against an identical copy of
  // itself, which would cut one copy and not its reversed twin.
  const D = disc(0, 0, 10, 0.2);
  harder.push([
    'a disc and one of its edges doubled back on itself',
    [S(D), S([D[0], rev(D[0])])],
    1,
  ]);
}

function runCase(name, shapes, contoursWant, G, region = inputRegion(shapes, G)) {
  const contours = unionContours(shapes, { intersect: intersectSegmentsExact });
  const { bad, inside } = regionMismatch(shapes, contours.flat(), G, region);
  // Where two pieces only TOUCH, one figure-eight cycle and two cycles bound the same region, so only
  // the region is asserted there (contoursWant null).
  const countOk = contoursWant === null ? contours.length > 0 : contours.length === contoursWant;
  return {
    ok: bad === 0 && countOk,
    msg: `${name}: ${contours.length} contour(s) (want ${contoursWant ?? 'any'}), ${bad} of ${inside}+ samples off the union`,
  };
}

console.log('(a) minimal cases');
for (const [name, shapes, want] of minimal) {
  const r = runCase(name, shapes, want, 56);
  check(r.ok, r.msg);
}

const SCALES = [1e-6, 3.7e-5, 1.1e-3, 0.043, 1, 7.3, 260, 9100, 1e6];
console.log('(b) the minimal cases across scale');
for (const [name, shapes, want] of minimal) {
  const region = inputRegion(shapes, 40);
  const bad = SCALES.filter((f) => !runCase(name, scaled(shapes, f), want, 40, region).ok);
  check(
    bad.length === 0,
    `${name}: holds at all ${SCALES.length} scales${bad.length ? ' -- fails at ' + bad.join(', ') : ''}`,
  );
}
// Touching inputs decide their structure in the last bits, so they get 25 scales, half a decade apart
// from 1e-6 to 1e6 with mantissas that are not powers of two.
const SWEEP = [];
for (let e = -6; e <= 6; e += 0.5) SWEEP.push(Math.pow(10, e) * (1 + 0.137 * ((e * 2 + 13) % 3)));
console.log('(c) touching and coincident inputs, across 25 scales');
for (const [name, shapes, want] of harder) {
  const region = inputRegion(shapes, 32);
  const bad = SWEEP.filter((f) => !runCase(name, scaled(shapes, f), want, 32, region).ok);
  check(
    bad.length === 0,
    `${name}: holds at all ${SWEEP.length} scales${bad.length ? ' -- fails at ' + bad.map((f) => f.toExponential(2)).join(', ') : ''}`,
  );
}

if (fail) {
  console.error(`PATH-BOOLEAN PLANAR-GRAPH FAIL (${fail})`);
  process.exit(1);
}
console.log('PATH-BOOLEAN PLANAR-GRAPH PASS');
