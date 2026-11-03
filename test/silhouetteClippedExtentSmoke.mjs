// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// silhouetteClippedExtentSmoke — the silhouette is the drawing's VISIBLE perimeter, so a clipped or masked
// shape contributes only the part of it that is drawn.
//
// THE HAZARD. A silhouette union that takes every filled shape at its FULL UNCLIPPED extent lets a shape
// clipped entirely away push the perimeter out to its whole outline, and a half-clipped background push it
// to the background's corners: on examples/_clipper_anim.svg the outline would box [0, 0, 100, 100] where
// the art it outlines lives in [38, 38, 62, 62].
//
// WHAT THE SILHOUETTE SHOULD MEAN. It is painted BEHIND the art as that drawing's outline, so the only thing
// it can mean is the boundary of the set of points the drawing actually paints. For a clipped shape that set
// is `shape ∩ clip` -- SVG 1.1 §14.3.5: a clipPath's children UNION, and an element's own clip-path INTERSECTS
// the inherited one -- so the region is an AND of ORs and the contribution is the exact intersection, not a
// bounding box. unionPaths takes the region's edges into the ARRANGEMENT and tests each face against it, so
// nothing is approximated: see `shape.regions` there.
//
// A MASK IS NOT A REGION. Its effect is a luminance, so the mask's CONTENT geometry is an OUTER BOUND on
// visibility, not the visible set: outside all of it the mask is transparent black and the shape is fully
// hidden (so intersecting can never cut ink that is drawn), but inside it a black or dark child is counted as
// visible when it is not. That is the safe direction for a perimeter, and it catches a mask that hides part of a
// shape. Part (d) states it as an over-inclusion rather than testing it as if it were exact.
//
// WHERE IT DECLINES. The clip def's geometry is read off its DOM at silhouette time, because the drain that
// walks defs into shapesData runs long after and the silhouette must be injected at index 0 first. Shape
// elements and <g> wrappers (including the <g clip-path> wrapper a nested clip becomes) are read; a <use>, a
// <text>, an objectBoundingBox outer clip on such a wrapper, or any other tag declines the whole region and the
// shape keeps its full extent -- never the other way round, so a decline cannot lose ink.
//
// WHAT this RESTS ON. With "inside a shape" not sufficient, the classifier it shares must handle a closed
// contour's SEAM: a pointInShape that skipped any segment whose two ENDPOINTS lie on its ray as "horizontal"
// would let a <circle> on the page claim every face on the ray through its center -- including the faces a
// clip removed from another shape. pointInShapeSeamRaySmoke owns that; with it broken, part (d) here comes
// out at the plate's full width.
//
// No GPU. Six readings: the exact intersection by POINT SAMPLING against an independent oracle, through
// unionContours itself; the imported silhouette row's box for the clip shapes a document can build; the mask
// bound; the decline; the empty clip; and the same silhouette at 2^-20 and 2^20.
//
// Mutation, required to FAIL: return null unconditionally from bundleFinalize's silRegions (parts b..f), and
// drop `regions` from unionPaths' tagging + classification (part a).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { unionContours } = await import('../src/svg/pathBoolean/union.js');
const { intersectSegmentsExact } = await import('../src/svg/pathBoolean/intersect/exact.js');
const { pointInShape } = await import('../src/svg/pathBoolean/planar/fillRule.js');
const { mkLine, mkCubic } = await import('../src/svg/segment.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const fmt = (a) => (a ? '[' + Array.from(a, (v) => +(+v).toFixed(3)).join(', ') + ']' : 'none');

const rowsOf = (b) => new Float32Array(b.meta, 32);
const silBox = (b) => Array.from(rowsOf(b).slice(0, 4));
const rectSegs = (x, y, w, h) => [
  mkLine([x, y], [x + w, y]),
  mkLine([x + w, y], [x + w, y + h]),
  mkLine([x + w, y + h], [x, y + h]),
  mkLine([x, y + h], [x, y]),
];

// THE DEMO ASSET, checked in (d) and derived by scripts/genSmokeAssets.mjs to
// examples/smoke/silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg, which is what a GPU check renders.
// Declared up here because genSmokeAssets evaluates a smoke's declarations in order and stops at the first
// throw, which the first importSvg call is.
const CLIPPED_SILHOUETTE_DEMO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140">
<defs><clipPath id="band"><rect x="40" y="0" width="60" height="140"/></clipPath></defs>
<rect x="10" y="40" width="220" height="60" fill="#3a4654" clip-path="url(#band)"/>
<circle cx="170" cy="70" r="30" fill="#f05a28"/>
</svg>`;

// ------------------------------------------------------------------------------------------------
// (a) THE exact INTERSECTION, by point sampling. Independent oracle: a point is painted iff it is inside some
//     shape AND inside every AND group of that shape's region. The union's contours are read back with the same
//     nonzero point-in-shape test the classifier uses, so the two readings share no arithmetic beyond it.
console.log('(a) the union of the VISIBLE parts, sampled against an independent oracle');
// A rounded blob, so a clipped boundary is a cut CURVE and not another rect edge. ASYMMETRIC on purpose: a blob
// symmetric about its two endpoints' y puts every face's probe point on the ray through the shared vertex,
// which is a separate question (pointInShapeSeamRaySmoke owns it) and would make this fixture a test of that.
const BLOB = [
  mkCubic([20, 62], [22, 14], [98, 8], [100, 44]),
  mkCubic([100, 44], [106, 110], [24, 118], [20, 62]),
];
const SAMPLE_CASES = [
  [
    'a rect clipped to its left half',
    [
      {
        segs: rectSegs(0, 0, 40, 20),
        fillRule: 'nonzero',
        regions: [[{ segs: rectSegs(-10, -10, 30, 40), fillRule: 'nonzero' }]],
      },
    ],
    [-20, -20, 60, 40],
  ],
  [
    'a blob clipped to a band',
    [
      {
        segs: BLOB,
        fillRule: 'nonzero',
        regions: [[{ segs: rectSegs(40, 0, 30, 200), fillRule: 'nonzero' }]],
      },
    ],
    [0, 0, 120, 120],
  ],
  [
    'a clip of two children (their UNION)',
    [
      {
        segs: rectSegs(0, 0, 40, 20),
        fillRule: 'nonzero',
        regions: [
          [
            { segs: rectSegs(0, 0, 10, 20), fillRule: 'nonzero' },
            { segs: rectSegs(30, 0, 10, 20), fillRule: 'nonzero' },
          ],
        ],
      },
    ],
    [-10, -10, 60, 40],
  ],
  [
    'two AND groups (a clip of a clip)',
    [
      {
        segs: rectSegs(0, 0, 40, 20),
        fillRule: 'nonzero',
        regions: [
          [{ segs: rectSegs(0, 0, 30, 20), fillRule: 'nonzero' }],
          [{ segs: rectSegs(10, 0, 40, 20), fillRule: 'nonzero' }],
        ],
      },
    ],
    [-10, -10, 60, 40],
  ],
  [
    'one clipped shape beside an unclipped one',
    [
      {
        segs: rectSegs(0, 0, 40, 20),
        fillRule: 'nonzero',
        regions: [[{ segs: rectSegs(0, 0, 10, 20), fillRule: 'nonzero' }]],
      },
      { segs: rectSegs(60, 0, 20, 20), fillRule: 'nonzero' },
    ],
    [-10, -10, 100, 40],
  ],
  [
    'a shape whose clip misses it entirely',
    [
      {
        segs: rectSegs(0, 0, 40, 20),
        fillRule: 'nonzero',
        regions: [[{ segs: rectSegs(200, 200, 10, 10), fillRule: 'nonzero' }]],
      },
      { segs: rectSegs(60, 0, 20, 20), fillRule: 'nonzero' },
    ],
    [-10, -10, 240, 240],
  ],
];
// A point is painted iff some shape covers it and every one of that shape's AND groups does too.
const painted = (shapes, p) =>
  shapes.some(
    (sh) =>
      pointInShape(p, sh.segs, sh.fillRule) &&
      (sh.regions || []).every((grp) => grp.some((pt) => pointInShape(p, pt.segs, pt.fillRule))),
  );
for (const [label, shapes, win] of SAMPLE_CASES) {
  const cs = unionContours(shapes, { intersect: intersectSegmentsExact });
  const flat = cs.flat();
  // Sample away from the boundary: a point within EPS of any contour is where the two readings are allowed to
  // disagree (the classifier and the oracle answer the boundary itself by different routes).
  const N = 61,
    EPS = 0.35;
  let bad = 0,
    n = 0,
    worst = '';
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p = [
        win[0] + ((i + 0.5) * (win[2] - win[0])) / N,
        win[1] + ((j + 0.5) * (win[3] - win[1])) / N,
      ];
      const want = painted(shapes, p);
      // Skip near-boundary samples by re-asking the oracle at a small cross around the point: if the answers
      // differ the point is on an edge.
      const cross = [
        [EPS, 0],
        [-EPS, 0],
        [0, EPS],
        [0, -EPS],
      ].map(([dx, dy]) => painted(shapes, [p[0] + dx, p[1] + dy]));
      if (cross.some((v) => v !== want)) continue;
      n++;
      const got = flat.length ? pointInShape(p, flat, 'nonzero') : false;
      if (got !== want) {
        bad++;
        if (!worst)
          worst = `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}) union says ${got}, painted ${want}`;
      }
    }
  ok(
    n > 300 && bad === 0,
    `${label}: ${cs.length} contour(s), ${n} interior samples, ${bad} disagree${worst ? ' -- ' + worst : ''}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (b) ...and the same through the importer, on the clip shapes a document can actually build. The silhouette is
//     a stroke-only row at meta row 0, so its box is the visible union grown by half the outline width.
console.log('(b) the imported silhouette row, for each way a document states a clip');
const DOC = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>` +
  `<rect x="10" y="10" width="30" height="30" fill="#f00"/>${body}</svg>`;
const FAR = '<rect x="60" y="60" width="30" height="30" fill="#0f0"';
const ALONE = [9, 9, 41, 41]; // the first rect alone, grown by the default 2-wide outline
const IMPORTED = [
  ['no clip at all', DOC('', FAR + '/>'), [9, 9, 91, 91]],
  [
    'clipped entirely away',
    DOC(
      '<clipPath id="c"><rect x="0" y="0" width="5" height="5"/></clipPath>',
      FAR + ' clip-path="url(#c)"/>',
    ),
    ALONE,
  ],
  [
    'half clipped',
    DOC(
      '<clipPath id="c"><rect x="0" y="0" width="75" height="100"/></clipPath>',
      FAR + ' clip-path="url(#c)"/>',
    ),
    [9, 9, 76, 91],
  ],
  [
    'an objectBoundingBox clip, left half',
    DOC(
      '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>',
      FAR + ' clip-path="url(#c)"/>',
    ),
    [9, 9, 76, 91],
  ],
  [
    'a clip on a transformed group',
    DOC(
      '<clipPath id="c"><rect x="0" y="0" width="10" height="10"/></clipPath>',
      '<g transform="translate(60 60)" clip-path="url(#c)"><rect x="0" y="0" width="30" height="30" fill="#0f0"/></g>',
    ),
    [9, 9, 71, 71],
  ],
  [
    'a clip of a clip (both must hold)',
    DOC(
      '<clipPath id="outer"><rect x="0" y="0" width="70" height="100"/></clipPath>' +
        '<clipPath id="inner"><rect x="0" y="0" width="100" height="80"/></clipPath>',
      `<g clip-path="url(#outer)">${FAR} clip-path="url(#inner)"/></g>`,
    ),
    [9, 9, 71, 81],
  ],
  [
    'a clip of two children (their UNION)',
    DOC(
      '<clipPath id="c"><rect x="60" y="60" width="10" height="30"/><rect x="85" y="60" width="10" height="30"/></clipPath>',
      FAR + ' clip-path="url(#c)"/>',
    ),
    [9, 9, 91, 91],
  ],
  [
    'an EMPTY clipPath hides the shape',
    DOC('<clipPath id="c"></clipPath>', FAR + ' clip-path="url(#c)"/>'),
    ALONE,
  ],
  // A clip whose geometry cannot be read here DECLINES: the shape keeps its full extent, as before.
  [
    'a <use> inside the clipPath declines',
    DOC(
      '<rect id="r" x="0" y="0" width="5" height="5"/><clipPath id="c"><use href="#r"/></clipPath>',
      FAR + ' clip-path="url(#c)"/>',
    ),
    [9, 9, 91, 91],
  ],
];
for (const [label, svg, want] of IMPORTED) {
  const b = await importSvg(svg, {
    preserveViewport: true,
    computeSilhouette: true,
    outlineWidth: 2,
  });
  const got = silBox(b);
  ok(
    got.every((v, i) => Math.abs(v - want[i]) <= 1e-3),
    `${label}: ${fmt(got)}, want ${fmt(want)}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (c) a MASK bounds the shape by its CONTENT. Both readings: a mask that does not reach the shape hides it, and
//     a mask child that is BLACK is still counted -- the over-inclusion, pinned so it is a decision and not a
//     surprise.
console.log('(c) a mask bounds the shape by its content geometry');
{
  const away = await importSvg(
    DOC(
      '<mask id="m"><rect x="0" y="0" width="5" height="5" fill="#fff"/></mask>',
      FAR + ' mask="url(#m)"/>',
    ),
    { preserveViewport: true, computeSilhouette: true, outlineWidth: 2 },
  );
  ok(
    silBox(away).every((v, i) => Math.abs(v - ALONE[i]) <= 1e-3),
    `a mask that does not reach the shape hides it: ${fmt(silBox(away))}`,
  );
  const black = await importSvg(
    DOC(
      '<mask id="m"><rect x="55" y="55" width="40" height="40" fill="#000"/></mask>',
      FAR + ' mask="url(#m)"/>',
    ),
    { preserveViewport: true, computeSilhouette: true, outlineWidth: 2 },
  );
  ok(
    silBox(black).every((v, i) => Math.abs(v - [9, 9, 91, 91][i]) <= 1e-3),
    `OVER-INCLUDES a black mask child (luminance is not geometry): ${fmt(silBox(black))}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (d) the demo asset. Derived to examples/smoke/silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg by
//     scripts/genSmokeAssets.mjs, which is what a GPU check renders: a wide dark plate and a disc, the plate
//     clipped to a narrow band. The outline must hug the band and the disc, not box the plate.
console.log('(d) the demo asset: the outline hugs the CLIPPED plate, not the whole plate');
{
  const b = await importSvg(CLIPPED_SILHOUETTE_DEMO, {
    preserveViewport: true,
    computeSilhouette: true,
    outlineWidth: 6,
  });
  // The visible ink is the band [40, 40, 100, 100] plus the disc [140, 40, 200, 100], grown by half of 6.
  const want = [37, 37, 203, 103];
  const got = silBox(b);
  ok(
    got.every((v, i) => Math.abs(v - want[i]) <= 1e-3),
    `${fmt(got)}, want ${fmt(want)}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (e) and the same silhouette at every size.
console.log('(e) the same silhouette at 2^-20 and 2^20');
{
  const at = async (S) => {
    const raw = DOC(
      '<clipPath id="c"><rect x="0" y="0" width="75" height="100"/></clipPath>',
      FAR + ' clip-path="url(#c)"/>',
    );
    const open = raw.match(/<svg\b[^>]*>/)[0];
    const svg =
      open.replace(/viewBox="[^"]+"/, `viewBox="0 0 ${100 * S} ${100 * S}"`) +
      `<g transform="scale(${S})">` +
      raw.slice(open.length, raw.lastIndexOf('</svg>')) +
      '</g></svg>';
    return silBox(
      await importSvg(svg, {
        preserveViewport: true,
        computeSilhouette: true,
        outlineWidth: 2 * S,
      }),
    );
  };
  const r1 = await at(1);
  for (const e of [-20, 20]) {
    const S = 2 ** e,
      rs = await at(S);
    ok(
      rs.every((v, i) => v === r1[i] * S),
      `2^${e}: ${fmt(rs)} is the scale-1 box times the ratio`,
    );
  }
}

console.log(
  fail ? `silhouetteClippedExtentSmoke FAIL (${fail})` : 'silhouetteClippedExtentSmoke PASS',
);
process.exit(fail ? 1 : 0);
