// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeRestInk.mjs — the GPU check for the curve branch's join wedge and for the render target a
// FILTERED stroke row gets.
//
//   node probes/strokeRest/_strokeRestInk.mjs           print the table
//   node probes/strokeRest/_strokeRestInk.mjs --write   rewrite the .svg files from the same data
//
// Each case is defined ONCE here, as a chain of quadratic Beziers, and both the .svg file and the
// numbers come from that one definition, so the file and the prediction cannot drift apart. Every
// viewBox is 200x200 at 200x200 CSS pixels, so one viewBox unit is one device pixel and the sum of
// the rendered alpha is directly comparable to the table.
//
// Columns, at one em per pixel:
//   svg2      the exact area of the SVG 2 stroke shape, by 16x16 supersampling of the exact shape
//             (test/_strokeCurveRef.mjs svgInsideCurve) — what a correct renderer converges to;
//   before    the ink of the ungated rule ('wedgeVertexDrop' in test/_strokeCurveRef.mjs): outside the join
//             wedge it drops the endpoint only where src/svg/textures.js makes that side's neighbor
//             reach finite, and everywhere else the radial halfW disc stands;
//   fixed     the ink the shipped branch lays down — the LINE branch's butt end, at every vertex;
//   drop      the same wedge taken as a hard drop instead of the butt-end SDF (the same membership,
//             without the ramp across the plane) — the arm that says the SDF is doing something.
// A case with `rtLeftPx` is a render-target case: it carries an IDENTITY filter, so a correct renderer
// must produce exactly the unfiltered image, and its `before` column is the same ink with everything
// left of that column dropped — what a render target padded too little on the left cuts.
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { quadSegs, coverageCurve, svgInsideCurve } from '../../test/_strokeCurveRef.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = 200;
const CAPS = ['butt', 'round', 'square'],
  JOINS = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];

// A case is a chain of quadratic Beziers in its own coordinates plus a (scale, offset) that maps
// it into the 200x200 box. The chains marked "seeded case N" are cases of
// test/_strokeCurveRef.mjs makeCurveCases, chosen because they are where the wedge test removes the
// most ink -- scaled up so the delta is many device pixels rather than a handful. Scaling is exact: every
// term in the branch is linear in halfW and in the coordinates, so the ink delta scales with s^2.
const CASES = [
  // THE CLIPPED KITE OUTSIDE THE WEDGE. A CLOSED chain, so every vertex is interior and the
  // encoder writes the 1e9 sentinel at all of them: the ungated rule never drops anywhere on this path.
  // At miterlimit 1 every join is past its limit, so each takes the miter-clip branch -- which
  // ASSIGNS thisD, so where it runs outside the wedge it paints the clipped kite running BACKWARDS
  // past the incoming segment's own perpendicular. (seeded case 13, x1.7)
  {
    file: 'g-clip-kite-wedge.svg',
    halfW: 6,
    cap: 0,
    join: 3,
    ml: 1,
    closed: true,
    s: 1.7,
    off: [183, 80],
    Q: [
      [
        [0, 0],
        [-10.205, 10.993],
        [-20.602, 21.806],
      ],
      [
        [-20.602, 21.806],
        [-56.57, 23.325],
        [-91.419, 14.295],
      ],
      [
        [-91.419, 14.295],
        [-97.789, 9.537],
        [0, 0],
      ],
    ],
    what: 'Join wedge, closed chain: every vertex is interior, and at miterlimit 1 every join is past its limit. The clipped kite must stop at the incoming segment perpendicular, not run backwards past it.',
  },
  // The same case on an OPEN chain, where the ungated rule can drop only next to the two free ends
  // and never at the middle join. (seeded case 388, x2.2)
  {
    file: 'h-clip-kite-open.svg',
    halfW: 6,
    cap: 0,
    join: 3,
    ml: 1,
    closed: false,
    s: 2.2,
    off: [55, 105],
    Q: [
      [
        [0, 0],
        [13.695, -33.293],
        [15.807, -32.154],
      ],
      [
        [15.807, -32.154],
        [21.72, -31.136],
        [21.144, -28.807],
      ],
      [
        [21.144, -28.807],
        [15.479, -14.917],
        [9.572, -13.866],
      ],
    ],
    what: 'Join wedge, open chain: three quads, with interior joins the encoder never marks.',
  },
  // MITER, on a closed chain: that branch only LOWERS thisD, so less moves than under miter-clip --
  // but the radial disc outside the wedge still goes. (seeded case 117, x2.6)
  {
    file: 'i-miter-wedge.svg',
    halfW: 6,
    cap: 0,
    join: 0,
    ml: 4,
    closed: true,
    s: 2.6,
    off: [78, 50],
    Q: [
      [
        [0, 0],
        [2.397, 0.116],
        [6.173, 35.917],
      ],
      [
        [6.173, 35.917],
        [3.912, 35.112],
        [1.538, 29.602],
      ],
      [
        [1.538, 29.602],
        [-3.95, 20.766],
        [0, 0],
      ],
    ],
    what: 'Join wedge under a plain miter: the branch only lowers the distance, so less moves than under miter-clip, but the radial disc outside the wedge still goes.',
  },
  // THE GUARD for the free-end drop: a SHORT FREE-ENDED tail after a miter join. There the encoder
  // DOES write a finite reach, so the ungated rule already drops, and the butt end has to keep the
  // join disc off the far side of that tail's cap. before == fixed is the point of this case, not a
  // weak probe.
  {
    file: 'j-short-free-tail.svg',
    halfW: 16,
    cap: 0,
    join: 0,
    ml: 4,
    closed: false,
    s: 1,
    off: [0, 0],
    Q: [
      [
        [30, 60],
        [90, 80],
        [150, 100],
      ],
      [
        [150, 100],
        [146, 106],
        [142, 112],
      ],
    ],
    what: 'Free-end guard: a SHORT free-ended tail after a miter join, where the ungated rule already drops. The butt end must still keep the join disc off the far side of the tail cap.',
  },
  // RENDER TARGET. An IDENTITY filter (feColorMatrix with the identity matrix, over a userSpaceOnUse region
  // that is the whole canvas, so the REGION never clips) forces renderer/filterDraw.js to size a
  // render target for this row and composite through it -- and a correct renderer must then
  // produce exactly the unfiltered image. The spike points LEFT on purpose: `_bboxToRect`
  // quantizes a rect's SIZE, which grows it DOWN and RIGHT, so a shortfall on the left or top edge
  // is absorbed by nothing but the 2 px RECT_PAD.
  //
  // miterlimit 10, and the join's own ratio is 1/sin(4.576 deg) = 12.5, so the join is past its
  // limit and SVG 2 clips it square to the bisector at 10 * halfW = 50 units from the vertex at
  // x = 60 -- the tip lands at x = 10. A pad of halfW * max(1, min(10, 4)) = 20 would start the RT at
  // even(floor(55 - 20 - 2)) = 32 and cut everything left of it (rtLeftPx). The reach bound is
  // halfW * sqrt(10^2 + 1) = 50.25, which puts the RT's left edge at even(floor(4.75 - 2)) = 2.
  {
    file: 'k-filter-rt-miter-clip.svg',
    halfW: 5,
    cap: 0,
    join: 3,
    ml: 10,
    closed: false,
    s: 1,
    off: [0, 0],
    filter: true,
    rtLeftPx: 32,
    Q: [
      [
        [160, 90],
        [110, 94],
        [60, 98],
      ],
      [
        [60, 98],
        [110, 102],
        [160, 106],
      ],
    ],
    what: 'Render target: an identity filter, so the render target filterDraw.js sizes is the only thing that can change the image. The miter-clip spike points LEFT, where the rect quantum cannot absorb a short pad.',
  },
];
for (const cs of CASES) {
  cs.Q = cs.Q.map((seg) => seg.map(([x, y]) => [x * cs.s + cs.off[0], y * cs.s + cs.off[1]]));
  cs.halfW *= cs.s;
}

const svgOf = (cs) => {
  const d =
    `M ${cs.Q[0][0][0]} ${cs.Q[0][0][1]} ` +
    cs.Q.map(([, b, e]) => `Q ${b[0]} ${b[1]} ${e[0]} ${e[1]}`).join(' ') +
    (cs.closed ? ' Z' : '');
  // userSpaceOnUse over the whole canvas: the filter REGION must not be what clips, or the case
  // would measure the region instead of the render target.
  const defs = cs.filter
    ? `  <defs>\n    <filter id="identity" filterUnits="userSpaceOnUse" x="0" y="0" width="${VIEW}" height="${VIEW}">\n` +
      `      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0"/>\n` +
      `    </filter>\n  </defs>\n`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${VIEW}" height="${VIEW}">\n` +
    `  <!-- ${cs.what} -->\n` +
    defs +
    `  <rect width="${VIEW}" height="${VIEW}" fill="#ffffff"/>\n` +
    `  <path d="${d}" fill="none" stroke="#000000" stroke-width="${2 * cs.halfW}"` +
    ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${JOINS[cs.join]}"` +
    ` stroke-miterlimit="${cs.ml}"${cs.filter ? ' filter="url(#identity)"' : ''}/>\n</svg>\n`
  );
};

const ink = (rule, cs, segs, xFrom = 0) => {
  let s = 0;
  for (let y = 0; y < VIEW; y++)
    for (let x = xFrom; x < VIEW; x++)
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

// A case CLIPPED by the 200x200 box would quietly lose the join it exists for -- and lose it from
// the prediction and the render together, so the table would still look self-consistent. Sum the
// ink over a box M units larger on every side and require the two to agree.
const spill = (cs, segs, M = 90) => {
  let s = 0;
  for (let y = -M; y < VIEW + M; y++)
    for (let x = -M; x < VIEW + M; x++) {
      if (x >= 0 && x < VIEW && y >= 0 && y < VIEW) continue;
      s += coverageCurve(
        'wedgeVertexDrop',
        [x + 0.5, y + 0.5],
        segs,
        cs.halfW,
        cs.cap,
        cs.join,
        cs.ml,
      );
    }
  return s;
};

const write = process.argv.includes('--write');
const rows = [];
for (const cs of CASES) {
  if (write) writeFileSync(path.join(HERE, cs.file), svgOf(cs));
  const segs = quadSegs(cs.Q, cs.closed);
  const out = spill(cs, segs);
  if (out > 0.5)
    throw new Error(
      `${cs.file} spills ${out.toFixed(1)} units of ink outside the ${VIEW}x${VIEW} box`,
    );
  const fixed = ink('fixed', cs, segs);
  rows.push({
    file: cs.file,
    svg2: exactArea(cs, segs),
    // a render-target case's rule does not change; its RENDER TARGET does
    before:
      cs.rtLeftPx != null ? ink('fixed', cs, segs, cs.rtLeftPx) : ink('wedgeVertexDrop', cs, segs),
    fixed,
    drop: cs.rtLeftPx != null ? fixed : ink('dropWedge', cs, segs),
  });
}
const f = (v) => v.toFixed(1).padStart(10);
console.log('case                          svg2    before     fixed      drop');
for (const r of rows)
  console.log(r.file.padEnd(26) + f(r.svg2) + f(r.before) + f(r.fixed) + f(r.drop));
console.log('');
console.log(
  '|err| vs svg2: ' +
    rows
      .map(
        (r) =>
          `${r.file.split('-')[0]} ${Math.abs(r.fixed - r.svg2).toFixed(1)} (before ${Math.abs(r.before - r.svg2).toFixed(1)})`,
      )
      .join('   '),
);
if (write) console.log(`\nwrote ${CASES.length} svg files into ${HERE}`);
