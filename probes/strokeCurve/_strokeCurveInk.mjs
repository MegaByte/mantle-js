// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeCurveInk.mjs — the GPU check for the curve branch's butt-end plane, its past-the-limit joins
// and its round and bevel join wedge.
//
//   node probes/strokeCurve/_strokeCurveInk.mjs           print the table
//   node probes/strokeCurve/_strokeCurveInk.mjs --write   rewrite the .svg files from the same data
//
// The eight cases are defined ONCE here, as chains of quadratic Beziers, and both the SVG files and
// the numbers come from that one definition, so the file and the prediction cannot drift apart.
// For each case this prints, at one em per pixel:
//   svg2      the exact area of the SVG 2 stroke shape, by 16x16 supersampling of the exact shape
//             (test/_strokeCurveRef.mjs svgInsideCurve) — what a correct renderer converges to;
//   base      the ink the curve branch lays down with every rule below reverted ('base' in
//             test/_strokeCurveRef.mjs; summed coverage over pixel centers, the renderer's own alpha);
//   fixed     the ink the shipped branch lays down;
//   buttPastEnd   the butt-end plane rule reverted (the plane cuts only pixels PAST a free end);
//   miterClipClamp   the past-the-limit join rules reverted (miter-clip caps the along-tangent extent, a
//             miter keeps a round shoulder, an arcs join bevels);
//   roundBevelDisc   the round / bevel wedge rule reverted (both keep the halfW disc outside the wedge);
//   noLocality, noArcsCut  mutations: the butt-end plane without its locality test, and the arcs /
//             miter-clip region without its reach cut.
// The column keys are the rule names test/_strokeCurveRef.mjs defines.
// Run the same SVGs on the GPU at exactly 200x200 device pixels and sum the alpha channel; `fixed`
// is the prediction. See README.md for what to pin and what would falsify it.
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { quadSegs, coverageCurve, svgInsideCurve } from '../../test/_strokeCurveRef.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = 200; // viewBox units == device pixels at 200x200
const CAPS = ['butt', 'round', 'square'],
  JOINS = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];

// Q: the quad chain, each [p0, p1, p2]. halfW is half the stroke width.
const CASES = [
  {
    file: 'a-butt-ramp.svg',
    halfW: 9,
    cap: 0,
    join: 1,
    ml: 4,
    closed: false,
    Q: [
      [
        [40, 100],
        [100, 30],
        [160, 100],
      ],
    ],
    what: 'Butt-end plane. One quad, butt caps. Both ends carry a full antialiasing ramp across their own plane, not half of one.',
  },
  // x(t) = 120 + 140t - 200t^2 crosses the start plane x = 120 again at t = 0.7, y = 70.6 — 29
  // units to the side of the start point, i.e. far outside the butt segment the plane bounds.
  {
    file: 'b-fold-back.svg',
    halfW: 9,
    cap: 0,
    join: 1,
    ml: 4,
    closed: false,
    Q: [
      [
        [120, 100],
        [190, 100],
        [60, 40],
      ],
    ],
    what: 'Butt-end locality. The curve folds back ACROSS its own start plane 29 units to the side; the returning arm must keep its ink.',
  },
  {
    file: 'c-miter-clip.svg',
    halfW: 10,
    cap: 0,
    join: 3,
    ml: 1,
    closed: false,
    Q: [
      [
        [30, 170],
        [70, 60],
        [100, 100],
      ],
      [
        [100, 100],
        [130, 60],
        [170, 170],
      ],
    ],
    what: 'Miter-clip past the limit. The join is past its limit; SVG 2 cuts it square to the BISECTOR at miterLimit * halfW, not square to the tangent.',
  },
  {
    file: 'd-miter-past-limit.svg',
    halfW: 10,
    cap: 0,
    join: 0,
    ml: 1,
    closed: false,
    Q: [
      [
        [30, 170],
        [70, 60],
        [100, 100],
      ],
      [
        [100, 100],
        [130, 60],
        [170, 170],
      ],
    ],
    what: 'Miter past the limit. Past its limit a miter is a BEVEL, with no halfW disc (no round shoulder).',
  },
  // A near-reversal whose SECOND leg is short: the two tangent strips are nearly parallel, so the
  // clipped kite runs ~halfW/sin(turn) = 170 units in both directions along them, and the backwards
  // half comes out past the far end of the short leg into empty canvas that the row's cover quad
  // still covers. This is the region the cut exists for; `noArcsCut` is what it looks like without.
  {
    file: 'e-near-reversal-clip.svg',
    halfW: 6,
    cap: 0,
    join: 3,
    ml: 1,
    closed: false,
    Q: [
      [
        [180, 100],
        [140, 100],
        [100, 100],
      ],
      [
        [100, 100],
        [115, 100.5],
        [130, 101],
      ],
    ],
    what: 'Miter-clip at a near-reversal. The clip fixes the bisector component only; the cut is what bounds the rest.',
  },
  // Two curved segments, arcs join, past the limit: SVG 2 clips the region. The far component of
  // the band intersection is 2/|kappa| from the vertex, outside both the cover quad and the band
  // pad, so it is NOT expected to move a GPU pixel — see README.
  {
    file: 'f-arcs-curved.svg',
    halfW: 8,
    cap: 0,
    join: 4,
    ml: 1,
    closed: false,
    Q: [
      [
        [30, 150],
        [80, 40],
        [100, 100],
      ],
      [
        [100, 100],
        [120, 160],
        [170, 50],
      ],
    ],
    what: 'Arcs between curved segments, past the miter limit: SVG 2 clips the region rather than beveling.',
  },
  // ROUND AND BEVEL WEDGE. The FIRST leg is shorter than the half-width, so the join vertex's halfW
  // disc reaches back PAST that leg's own butt cap into empty canvas. SVG 2's round join is the bevel
  // triangle plus the circular SECTOR between the two outer offset normals, and its bevel join is the
  // triangle; neither reaches behind the incoming segment's perpendicular at the vertex. The line
  // branch ends there in a BUTT end, and the curve branch does for every join style. Both legs are
  // straight quads so the ink lost is a circular segment and can be checked by hand.
  {
    file: 'g-round-short-leg.svg',
    halfW: 14,
    cap: 0,
    join: 1,
    ml: 4,
    closed: false,
    Q: [
      [
        [92, 100],
        [96, 100],
        [100, 100],
      ],
      [
        [100, 100],
        [122, 132],
        [112, 170],
      ],
    ],
    what: "Round join, short leg. The leg into the join is 8 units against a 14 half-width, so the join vertex disc reaches 6 units PAST that leg's own butt cap; SVG 2 ends that side in a butt end.",
  },
  {
    file: 'h-bevel-short-leg.svg',
    halfW: 14,
    cap: 0,
    join: 2,
    ml: 4,
    closed: false,
    Q: [
      [
        [92, 100],
        [96, 100],
        [100, 100],
      ],
      [
        [100, 100],
        [122, 132],
        [112, 170],
      ],
    ],
    what: 'Bevel join, short leg. The same path with a bevel join: the chord bounds the OUTER side of the join only, so the disc behind the incoming perpendicular must go here too.',
  },
];

const svgOf = (cs) => {
  const d =
    `M ${cs.Q[0][0][0]} ${cs.Q[0][0][1]} ` +
    cs.Q.map(([, b, e]) => `Q ${b[0]} ${b[1]} ${e[0]} ${e[1]}`).join(' ') +
    (cs.closed ? ' Z' : '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${VIEW}" height="${VIEW}">\n` +
    `  <!-- ${cs.what} -->\n` +
    `  <rect width="${VIEW}" height="${VIEW}" fill="#ffffff"/>\n` +
    `  <path d="${d}" fill="none" stroke="#000000" stroke-width="${2 * cs.halfW}"` +
    ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${JOINS[cs.join]}"` +
    ` stroke-miterlimit="${cs.ml}"/>\n</svg>\n`
  );
};

const ink = (rule, cs, segs) => {
  let s = 0;
  for (let y = 0; y < VIEW; y++)
    for (let x = 0; x < VIEW; x++)
      s += coverageCurve(rule, [x + 0.5, y + 0.5], segs, cs.halfW, cs.cap, cs.join, cs.ml);
  return s;
};
const exactArea = (cs, segs, N = 16) => {
  let k = 0;
  for (let y = 0; y < VIEW; y++)
    for (let x = 0; x < VIEW; x++)
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++)
          if (
            svgInsideCurve(
              [x + (i + 0.5) / N, y + (j + 0.5) / N],
              segs,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.join,
              cs.ml,
            )
          )
            k++;
  return k / (N * N);
};

const write = process.argv.includes('--write');
const rows = [];
for (const cs of CASES) {
  if (write) writeFileSync(path.join(HERE, cs.file), svgOf(cs));
  const segs = quadSegs(cs.Q, cs.closed);
  const r = {
    file: cs.file,
    svg2: exactArea(cs, segs),
    base: ink('base', cs, segs),
    fixed: ink('fixed', cs, segs),
  };
  r.buttPastEnd = ink('buttPastEnd', cs, segs);
  r.miterClipClamp = ink('miterClipClamp', cs, segs);
  r.roundBevelDisc = ink('roundBevelDisc', cs, segs);
  r.noLocality = ink('noLocality', cs, segs);
  r.noArcsCut = ink('noArcsCut', cs, segs);
  rows.push(r);
}
const f = (v) => v.toFixed(1).padStart(9);
console.log(
  'case                     svg2      base     fixed   buttPastEnd   miterClipClamp   roundBevelDisc noLocality noArcsCut',
);
for (const r of rows)
  console.log(
    r.file.padEnd(22) +
      f(r.svg2) +
      f(r.base) +
      f(r.fixed) +
      f(r.buttPastEnd) +
      f(r.miterClipClamp) +
      f(r.roundBevelDisc) +
      f(r.noLocality) +
      f(r.noArcsCut),
  );
console.log('');
console.log(
  '|err| vs svg2:        ' +
    rows
      .map(
        (r) =>
          `${r.file.split('-')[0]} ${Math.abs(r.fixed - r.svg2).toFixed(1)} (base ${Math.abs(r.base - r.svg2).toFixed(1)})`,
      )
      .join('  '),
);
if (write) console.log(`\nwrote ${CASES.length} svg files into ${HERE}`);
