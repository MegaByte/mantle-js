// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanCoincidentArcLineSmoke — lines on one line and arcs on one ellipse get the same defined
// answer pathBooleanCoincidentSmoke pins for curves: the ends of the shared stretch, the one point
// where two stretches meet end to end, or nothing when they are apart.
//
// THE HAZARDS. lineLine must answer for two collinear segments (an absolute 1e-9 "parallel" test on
// the determinant returns nothing for them, and also calls two crossing segments parallel whenever
// one is short). arcArc must not substitute one ellipse into the other's implicit, which vanishes
// identically on a shared ellipse and yields a root of rounding noise. Either way the planar graph
// would get two edges overlapping in their interiors and no cut where the overlap begins.
//
// (a) stretches of one line, of one ellipse arc, and of an arc that wraps past theta = 2*pi, in every
//     configuration (identical, reversed, contained, overlapping, end to end, disjoint), through
//     intersectSegments in both argument orders
// (b) arcs whose ellipses are the same but are WRITTEN differently -- radii swapped with the axis
//     turned a quarter, a circle with another phi, theta shifted by whole turns -- and full ellipses,
//     whose shared stretch is the other's whole arc or, for two full ellipses, runs seam to seam
// (c) near, not coincident: a parallel line offset, a line turned by 1e-7 radians (it crosses once),
//     an ellipse 1e-6 and 1e-8 wider; and a short segment crossing a long one
// (d) all of (a) and (b) at 1e-6..1e6, with and without an origin offset
// (e) the consumers: intersectAndSplit cuts at the overlap's ends; the union of shapes that share part
//     of a straight or elliptical edge matches the region of its inputs
import { intersectSegments } from '../src/svg/pathBoolean/intersect/index.js';
import { sameEllipse } from '../src/svg/pathBoolean/intersect/coincident.js';
import { intersectAndSplit } from '../src/svg/pathBoolean/planar/segmentSet.js';
import { unionContours } from '../src/svg/pathBoolean/union.js';
import { pointInShape } from '../src/svg/pathBoolean/planar/fillRule.js';
import { intersectSegmentsExact } from '../src/svg/pathBoolean/intersect/exact.js';
import { mkArc } from '../src/svg/segment.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const TWO_PI = 2 * Math.PI;
const line = (a, b) => ({ type: 0, p1: a, p2: b });
const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Expected (tA, tB): the overlap of parameter intervals [a0,a1] and [b0,b1] of one curve, mapped into
// each stretch's own parameter. `seam` marks a closed curve whose t = 0 and t = 1 are one point.
function expected(a0, a1, b0, b1) {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1)),
    hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  if (lo > hi) return [];
  const pa = (g) => (g - a0) / (a1 - a0),
    pb = (g) => (g - b0) / (b1 - b0);
  return lo === hi
    ? [[pa(lo), pb(lo)]]
    : [
        [pa(lo), pb(lo)],
        [pa(hi), pb(hi)],
      ];
}
function sameSet(got, want, seamA = false, seamB = false, eps = 1e-7) {
  if (got.some((h) => !Number.isFinite(h.tA) || !Number.isFinite(h.tB))) return false;
  if (got.length !== want.length) return false;
  const near = (x, y, seam) =>
    Math.abs(x - y) <= eps || (seam && Math.abs(Math.abs(x - y) - 1) <= eps);
  const used = new Set();
  for (const [a, b] of want) {
    const i = got.findIndex((h, k) => !used.has(k) && near(h.tA, a, seamA) && near(h.tB, b, seamB));
    if (i < 0) return false;
    used.add(i);
  }
  return true;
}
const fmt = (hits) =>
  hits
    .map(
      (h) =>
        `(${Number.isFinite(h.tA) ? h.tA.toFixed(4) : h.tA},${Number.isFinite(h.tB) ? h.tB.toFixed(4) : h.tB})`,
    )
    .join(' ') || 'none';
const swap = (w) => w.map(([s, u]) => [u, s]);

const CONFIGS = [
  ['identical', 0, 1, 0, 1],
  ['reversed', 0, 1, 1, 0],
  ['contained', 0, 1, 0.25, 0.75],
  ['contained, reversed', 0, 1, 0.8, 0.3],
  ['overlapping', 0, 0.6, 0.4, 1],
  ['end to end', 0, 0.5, 0.5, 1],
  ['end to end, reversed', 0, 0.5, 1, 0.5],
  ['disjoint', 0, 0.3, 0.6, 1],
];
// A family is a way to build the stretch [t0, t1] of one base curve at a given scale and offset.
const FAMILIES = [
  [
    'line',
    (t0, t1, f, o) => {
      const a = [-10, -3],
        b = [10, 4];
      const p = L(a, b, t0),
        q = L(a, b, t1);
      return line([p[0] * f + o[0], p[1] * f + o[1]], [q[0] * f + o[0], q[1] * f + o[1]]);
    },
  ],
  [
    'ellipse arc',
    (t0, t1, f, o) => {
      const s = 0.3,
        w = 2.2;
      return mkArc(3 * f + o[0], -2 * f + o[1], 10 * f, 6 * f, s + w * t0, s + w * t1, 0.4, 0, 1);
    },
  ],
  [
    'arc wrapping past 2*pi',
    (t0, t1, f, o) => {
      const s = 5.5,
        w = 2.0;
      return mkArc(3 * f + o[0], -2 * f + o[1], 10 * f, 6 * f, s + w * t0, s + w * t1, 0.4, 0, 1);
    },
  ],
  [
    'circle arc',
    (t0, t1, f, o) => {
      const s = -0.8,
        w = 4.0;
      return mkArc(o[0], o[1], 7 * f, 7 * f, s + w * t0, s + w * t1, 1.1, 0, 1);
    },
  ],
];
function runConfigs(f, o, log) {
  let bad = 0;
  for (const [kind, make] of FAMILIES)
    for (const [name, a0, a1, b0, b1] of CONFIGS) {
      const A = make(a0, a1, f, o),
        B = make(b0, b1, f, o);
      const want = expected(a0, a1, b0, b1);
      const ab = intersectSegments(A, B),
        ba = intersectSegments(B, A);
      const good = sameSet(ab, want) && sameSet(ba, swap(want));
      if (!good) bad++;
      if (log || !good)
        check(
          good,
          `${kind}, ${name}: ${fmt(ab)} (expected ${want.map(([s, u]) => `(${s.toFixed(4)},${u.toFixed(4)})`).join(' ') || 'none'})`,
        );
    }
  return bad;
}

console.log('(a) stretches of one line and one ellipse');
runConfigs(1, [0, 0], true);

// Arcs written differently. Each returns [A, B, expected, seamA, seamB].
function arcRewrites(f, o) {
  const E = (cx, cy, rx, ry, t0, t1, phi) =>
    mkArc(cx * f + o[0], cy * f + o[1], rx * f, ry * f, t0, t1, phi, 0, 1);
  const out = [];
  // The ellipse (3,-2) radii 10 x 6 at phi 0.4 is also radii 6 x 10 at phi 0.4 + pi/2, where the
  // parameter runs pi/2 behind.
  out.push([
    'radii swapped, axis turned a quarter',
    E(3, -2, 10, 6, 0.3, 2.5, 0.4),
    E(3, -2, 6, 10, 1.0 - Math.PI / 2, 3.0 - Math.PI / 2, 0.4 + Math.PI / 2),
    expected(0.3, 2.5, 1.0, 3.0).map(([s, u]) => [s, u]),
    false,
    false,
  ]);
  out.push([
    'axis turned a half, theta a whole turn on',
    E(3, -2, 10, 6, 0.3, 2.5, 0.4),
    E(3, -2, 10, 6, 1.0 - Math.PI + TWO_PI, 3.0 - Math.PI + TWO_PI, 0.4 + Math.PI),
    expected(0.3, 2.5, 1.0, 3.0),
    false,
    false,
  ]);
  out.push([
    'circle with another phi',
    E(0, 0, 7, 7, -0.8, 3.2, 1.1),
    E(0, 0, 7, 7, 1.0 - 0.7, 2.0 - 0.7, 1.8),
    expected(-0.8, 3.2, 1.0, 2.0),
    false,
    false,
  ]);
  out.push([
    'full ellipse against an arc of it',
    E(3, -2, 10, 6, 0, TWO_PI, 0.4),
    E(3, -2, 10, 6, 1.0, 2.5, 0.4),
    [
      [1.0 / TWO_PI, 0],
      [2.5 / TWO_PI, 1],
    ],
    true,
    false,
  ]);
  // The arc covers the full ellipse's seam, so the seam -- the full ellipse's own endpoint -- is a cut
  // on the arc as well as the two ends of the shared stretch.
  out.push([
    'full ellipse against an arc across its seam',
    E(3, -2, 10, 6, 0, TWO_PI, 0.4),
    E(3, -2, 10, 6, -0.5, 0.7, 0.4),
    [
      [(TWO_PI - 0.5) / TWO_PI, 0],
      [0.7 / TWO_PI, 1],
      [0, 0.5 / 1.2],
    ],
    true,
    false,
  ]);
  out.push([
    'two full ellipses, seams apart',
    E(3, -2, 10, 6, 0, TWO_PI, 0.4),
    E(3, -2, 10, 6, 1.0, 1.0 + TWO_PI, 0.4),
    [
      [1.0 / TWO_PI, 0],
      [0, (TWO_PI - 1.0) / TWO_PI],
    ],
    true,
    true,
  ]);
  out.push([
    'two full ellipses, one reversed',
    E(3, -2, 10, 6, 0, TWO_PI, 0.4),
    E(3, -2, 10, 6, TWO_PI, 0, 0.4),
    [[0, 0]],
    true,
    true,
  ]);
  out.push([
    'two arcs overlapping at BOTH ends, around the back',
    E(3, -2, 10, 6, 0, 5, 0.4),
    E(3, -2, 10, 6, 4, 9, 0.4),
    [
      [4 / 5, 0],
      [1, 1 / 5],
      [(9 - TWO_PI) / 5, 1],
      [0, (TWO_PI - 4) / 5],
    ],
    false,
    false,
  ]);
  return out;
}
console.log('(b) one ellipse written differently, full ellipses, seams');
for (const [name, A, B, want, sa, sb] of arcRewrites(1, [0, 0])) {
  const ab = intersectSegments(A, B),
    ba = intersectSegments(B, A);
  check(
    sameSet(ab, want, sa, sb) && sameSet(ba, swap(want), sb, sa),
    `${name}: ${fmt(ab)} (expected ${want.map(([s, u]) => `(${s.toFixed(4)},${u.toFixed(4)})`).join(' ')})`,
  );
}

console.log('(c) near, not coincident');
{
  const A = line([-10, -3], [10, 4]);
  const n = [-7 / Math.hypot(20, 7), 20 / Math.hypot(20, 7)];
  for (const d of [1e-6, 1e-8]) {
    const B = line(
      [-4 + n[0] * d * 21, -0.9 + n[1] * d * 21],
      [6 + n[0] * d * 21, 2.6 + n[1] * d * 21],
    );
    const h = intersectSegments(A, B);
    check(h.length === 0, `a parallel line ${d} of its length away: ${fmt(h)} (expected none)`);
  }
  const m = L([-10, -3], [10, 4], 0.55),
    th = 1e-7,
    c = Math.cos(th),
    s = Math.sin(th);
  const rot = (p) => [
    m[0] + c * (p[0] - m[0]) - s * (p[1] - m[1]),
    m[1] + s * (p[0] - m[0]) + c * (p[1] - m[1]),
  ];
  const Bt = line(rot(L([-10, -3], [10, 4], 0.3)), rot(L([-10, -3], [10, 4], 0.8)));
  const ht = intersectSegments(A, Bt);
  check(
    ht.length === 1 && Math.abs(ht[0].tA - 0.55) < 1e-6 && Math.abs(ht[0].tB - 0.5) < 1e-6,
    `a line turned 1e-7 rad about a point of the other crosses it there once: ${fmt(ht)}`,
  );
  // 2e-8 long at one degree: a determinant of 7e-10, under an absolute 1e-9, on a segment longer
  // than the dispatcher's own 1e-9 "this segment is a point" guard.
  const deg = Math.PI / 180,
    sl = 2e-8;
  const short = line(
      [0.2, 0.3 - (sl * Math.sin(deg)) / 2],
      [0.2 + sl * Math.cos(deg), 0.3 + (sl * Math.sin(deg)) / 2],
    ),
    long = line([-1, 0.3], [1, 0.3]);
  const hs = intersectSegments(long, short);
  check(
    hs.length === 1 && Math.abs(hs[0].tB - 0.5) < 1e-6,
    `a segment 2e-8 long crossing a 2-unit one at one degree: ${hs.length} crossing(s)`,
  );
  const E = mkArc(3, -2, 10, 6, 0.3, 2.5, 0.4, 0, 1);
  for (const d of [1e-6, 1e-8]) {
    const W = mkArc(3, -2, 10 * (1 + d), 6, 0.3, 2.5, 0.4, 0, 1);
    check(
      !sameEllipse(E, W) && sameEllipse(E, mkArc(3, -2, 10, 6, 1.0, 2.0, 0.4, 0, 1)),
      `an ellipse ${d} wider is not the same ellipse (and a stretch of it is)`,
    );
  }
}

console.log('(d) scale and offset');
for (const f of [1e-6, 1e-3, 1e3, 1e6])
  for (const o of [
    [0, 0],
    [7.3e3 * f, -2.9e4 * f],
  ]) {
    let bad = runConfigs(f, o, false);
    for (const [name, A, B, want, sa, sb] of arcRewrites(f, o)) {
      const ok =
        sameSet(intersectSegments(A, B), want, sa, sb) &&
        sameSet(intersectSegments(B, A), swap(want), sb, sa);
      if (!ok) {
        bad++;
        check(false, `${name} at scale ${f}, offset (${o})`);
      }
    }
    check(bad === 0, `scale ${f}, offset (${o[0]}, ${o[1]}): every configuration answers the same`);
  }

console.log('(e) consumers');
{
  const tag = (seg) => ({ seg, shapeIdx: 0, subpathIdx: 0, origDirection: 1, fillRule: 'nonzero' });
  const a = [-10, -3],
    b = [10, 4];
  const pieces = intersectAndSplit([
    tag(line(L(a, b, 0), L(a, b, 0.6))),
    tag(line(L(a, b, 0.4), L(a, b, 1))),
  ]);
  check(
    pieces.length === 4,
    `intersectAndSplit cuts two overlapping collinear lines at the overlap's ends: ${pieces.length} pieces`,
  );
  const arcs = intersectAndSplit([
    tag(mkArc(3, -2, 10, 6, 0.3, 1.62, 0.4, 0, 1)),
    tag(mkArc(3, -2, 10, 6, 1.18, 2.5, 0.4, 0, 1)),
  ]);
  check(
    arcs.length === 4,
    `intersectAndSplit cuts two overlapping arcs at the overlap's ends: ${arcs.length} pieces`,
  );

  const sq = (x0, y0, x1, y1) => [
    line([x0, y0], [x1, y0]),
    line([x1, y0], [x1, y1]),
    line([x1, y1], [x0, y1]),
    line([x0, y1], [x0, y0]),
  ];
  const half = (cx, cy, r, t0) => [
    mkArc(cx, cy, r, r, t0, t0 + Math.PI, 0, 0, 1),
    line(
      [cx + r * Math.cos(t0 + Math.PI), cy + r * Math.sin(t0 + Math.PI)],
      [cx + r * Math.cos(t0), cy + r * Math.sin(t0)],
    ),
  ];
  const S = (segs) => ({ segs, fillRule: 'nonzero' });
  const cases = [
    [
      'two squares sharing part of an edge',
      [S(sq(0, 0, 10, 10)), S(sq(10, 3, 18, 7))],
      [-1, -1, 19, 11],
    ],
    ['a square and its duplicate', [S(sq(0, 0, 10, 10)), S(sq(0, 0, 10, 10))], [-1, -1, 11, 11]],
    [
      'a square and one written from another corner',
      [
        S(sq(0, 0, 10, 10)),
        S([
          line([10, 10], [0, 10]),
          line([0, 10], [0, 0]),
          line([0, 0], [10, 0]),
          line([10, 0], [10, 10]),
        ]),
      ],
      [-1, -1, 11, 11],
    ],
    [
      'a disc and a half-disc on the same circle',
      [S([mkArc(0, 0, 8, 8, 0, TWO_PI, 0, 0, 1)]), S(half(0, 0, 8, 0.7))],
      [-9, -9, 9, 9],
    ],
    [
      'two half-discs of one circle overlapping',
      [S(half(0, 0, 8, 0.2)), S(half(0, 0, 8, 1.4))],
      [-9, -9, 9, 9],
    ],
    [
      'a disc and a duplicate starting elsewhere',
      [S([mkArc(0, 0, 8, 8, 0, TWO_PI, 0, 0, 1)]), S([mkArc(0, 0, 8, 8, 2, 2 + TWO_PI, 0, 0, 1)])],
      [-9, -9, 9, 9],
    ],
  ];
  for (const [name, shapes, box] of cases) {
    const contours = unionContours(shapes, { intersect: intersectSegmentsExact });
    let bad = 0,
      inside = 0;
    const G = 48;
    for (let i = 0; i < G; i++)
      for (let j = 0; j < G; j++) {
        const p = [
          box[0] + ((i + 0.5013) * (box[2] - box[0])) / G,
          box[1] + ((j + 0.5027) * (box[3] - box[1])) / G,
        ];
        const t = shapes.some((sh) => pointInShape(p, sh.segs, sh.fillRule));
        if (t) inside++;
        if (pointInShape(p, contours.flat(), 'evenodd') !== t) bad++;
      }
    check(
      contours.length === 1 && bad === 0,
      `union, ${name}: ${contours.length} contour(s), ${bad} of ${inside}+ samples off`,
    );
  }
}

if (fail) {
  console.error(`PATH-BOOLEAN COINCIDENT-ARC-LINE FAIL (${fail})`);
  process.exit(1);
}
console.log('PATH-BOOLEAN COINCIDENT-ARC-LINE PASS');
