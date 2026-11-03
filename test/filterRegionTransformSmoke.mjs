// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterRegionTransformSmoke — an objectBoundingBox FILTER REGION on a transformed group is a fraction of the
// group's box in the GROUP's own user space, carried by the group's CTM.
//
// WHAT THE SPEC SAYS. Filter Effects 1 §8: "If filterUnits is equal to objectBoundingBox, then x, y, width,
// height represent fractions or percentages of the bounding box on the referencing element", with the initial
// value objectBoundingBox and an unstated region of -10%/-10%/120%/120%. SVG 1.1 §7.11 puts that bounding box
// in the referencing element's own user coordinate system, the element's own transform excluded from it. §5:
// "The filter operations are applied in the element's local coordinate system." So the region is a rectangle in
// the group's local space and, on the canvas, that rectangle through the group's CTM -- turned or skewed
// whenever the carrier is.
//
// THE TRAP. Resolving the fractions against the union of the claimers' DOCUMENT-space axis-aligned boxes and
// storing an axis-aligned root-space rect goes wrong under a rotation: that box is bigger than the group and
// stays axis-aligned, so the region is both offset and the wrong size: a 40x20 rect under rotate(30) with a
// `x="0" width="0.5"` region would keep the left half of a 44.6-wide document box where the group's own left
// half lands somewhere else entirely.
//
// WHAT IS STORED, and the gap that stays open. §8 also says "The bounds of this rectangle act as a hard
// clipping region for each filter primitive", and the renderer enforces that with a SCISSOR
// (renderer/filterDraw.js _filterRegionRectPx), which is axis-aligned by construction. The tightest a scissor
// can be is the AABB of the spec's turned rect -- which is what groupFilterRegion already stores for a rotated
// userSpaceOnUse region -- so the stored region OVER-INCLUDES the four corner triangles between the spec's rect
// and its bound. Closing that, and running the graph in the element's local space so a non-uniform carrier
// scales the blur with it, needs a render target that turns with the element. Checked below as a property: the
// stored rect is the TIGHT bound of the spec's rect, not merely a rect that contains it.
//
// AND THE same FOR A SHAPE'S own REGION, in section (f). An own objectBoundingBox region stored as fractions
// (space 0) for filterDraw._rowBoxEm to resolve at DRAW time against the meta row's bbox resolves against the
// same document-space AABB, wrong for the same reason. So importWalk.js's resolveFilterRegion resolves a TURNED
// shape to a root-space rect at import, which needs one filter entry per shape (a key of the fractions alone is
// equal for every shape however each is turned). An upright shape keeps the fractions and the late resolve,
// which is what lets a morph re-resolve against the lerped row; a turned morphing shape trades that for a
// frozen rect, because re-resolving it gives the wrong rect for exactly those shapes.
//
// No GPU. The readings: the stored rect against the spec rect's bound, for rotate / skew / reflect / a
// two-shape group / a nested own transform; the tight-bound property; the guard that a positive-diagonal
// carrier does not move; the demo asset; the same rect at 2^-20 and 2^20; and (f) the own-region twin of all
// of it, plus two shapes sharing one filter under two CTMs.
//
// Mutations, each required to FAIL: force `turned` to null in bundleFinalize's group-region loop (a-e); force
// `ownTurned` to false in importWalk.js's claimFilter, or skip the own-region loop in bundleFinalize (f).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const fmt = (a) =>
  a
    ? '[' +
      Array.from(a, (v) =>
        Math.abs(v) < 1e-3 && v !== 0 ? (+v).toExponential(3) : +(+v).toFixed(4),
      ).join(', ') +
      ']'
    : 'null';

const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1],
  A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3],
  A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4],
  A[1] * B[4] + A[3] * B[5] + A[5],
];
const ROT = (deg) => {
  const t = (deg * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t);
  return [c, s, -s, c, 0, 0];
};
const SKEWX = (deg) => [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
const TRANS = (x, y) => [1, 0, 0, 1, x, y];

/// The spec's region rect, in the group's own space: fractions of the group's own box.
const specRect = (ownBox, fr) => {
  const w = ownBox[2] - ownBox[0],
    h = ownBox[3] - ownBox[1];
  return [
    ownBox[0] + fr[0] * w,
    ownBox[1] + fr[1] * h,
    ownBox[0] + (fr[0] + fr[2]) * w,
    ownBox[1] + (fr[1] + fr[3]) * h,
  ];
};
/// ...and its four corners through the carrier.
const corners = (M, r) =>
  [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ].map(([x, y]) => apply(M, x, y));
const boundOf = (pts) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0, 1];
};

const doc = (attrs, body) =>
  '<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg">' +
  `<defs><filter id="f"${attrs}><feGaussianBlur stdDeviation="3"/></filter></defs>${body}</svg>`;
const GROUP = (xf, inner) => `<g transform="${xf}" filter="url(#f)">${inner}</g>`;
const RECT = '<rect x="0" y="0" width="40" height="20" fill="#000"/>';

function regionOf(b) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * pm.floatsPerShape + 32] + 0.5);
    if (fid > 0) return (b.filterRegions && b.filterRegions[fid - 1]) || null;
  }
  return null;
}

// THE DEMO ASSET, checked in (d) and derived by scripts/genSmokeAssets.mjs to
// examples/smoke/filterRegionTransform__FILTER_REGION_DEMO.svg, which is what a GPU check renders. Two cells,
// the same blurred bar under the same TIGHT objectBoundingBox region that keeps the left 55% of the bar's own
// box. The first cell is upright, the second turned 30 degrees. The cut edge must run across the bar at the
// same place in both -- square to the bar, not to the page. With a document-AABB region the turned cell's cut
// sits at a different fraction of the bar and is square to the page.
const REGION_CELLS = [
  ['translate(40 60)', 40],
  ['translate(190 60) rotate(30)', 190],
];
const FILTER_REGION_DEMO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160">
<defs><filter id="fd" x="0" y="-0.25" width="0.55" height="1.5"><feGaussianBlur stdDeviation="1.5"/></filter></defs>
<rect x="0" y="0" width="320" height="160" fill="#101418"/>
${REGION_CELLS.map(
  ([xf]) =>
    `<g transform="${xf}" filter="url(#fd)">` +
    '<rect x="0" y="0" width="80" height="24" fill="#f05a28"/></g>',
).join('\n')}
</svg>`;

// ------------------------------------------------------------------------------------------------
// (a) the stored rect, against the bound of the spec's rect. The group's children carry no transform of their
//     own in the first cases, so the group's own-space box is exactly the authored rect.
console.log('(a) the stored region, against the bound of the spec rect through the group CTM');
const CASES = [
  [
    'rotate(30), stated 0/-0.25/0.5/1.5',
    ' x="0" y="-0.25" width="0.5" height="1.5"',
    'rotate(30)',
    RECT,
    [0, 0, 40, 20],
    [0, -0.25, 0.5, 1.5],
    ROT(30),
  ],
  [
    'rotate(30), the implicit -10%/120% default',
    '',
    'rotate(30)',
    RECT,
    [0, 0, 40, 20],
    [-0.1, -0.1, 1.2, 1.2],
    ROT(30),
  ],
  [
    'rotate(90)',
    ' x="-0.25" y="-0.25" width="1.5" height="1.5"',
    'rotate(90)',
    RECT,
    [0, 0, 40, 20],
    [-0.25, -0.25, 1.5, 1.5],
    ROT(90),
  ],
  [
    'skewX(30)',
    ' x="0.1" y="0" width="0.6" height="1"',
    'skewX(30)',
    RECT,
    [0, 0, 40, 20],
    [0.1, 0, 0.6, 1],
    SKEWX(30),
  ],
  [
    'scale(-1 1), an off-center region',
    ' x="0.1" y="0" width="0.4" height="1"',
    'scale(-1 1)',
    RECT,
    [0, 0, 40, 20],
    [0.1, 0, 0.4, 1],
    [-1, 0, 0, 1, 0, 0],
  ],
  [
    'translate(25 -10) rotate(40)',
    ' x="-0.1" y="-0.1" width="1.2" height="1.2"',
    'translate(25 -10) rotate(40)',
    RECT,
    [0, 0, 40, 20],
    [-0.1, -0.1, 1.2, 1.2],
    mul(TRANS(25, -10), ROT(40)),
  ],
  // Two children: the group's own box is their UNION in the GROUP's space, not the union of their document boxes.
  [
    'a group of two shapes',
    '',
    'rotate(30)',
    RECT + '<rect x="50" y="30" width="20" height="10" fill="#000"/>',
    [0, 0, 70, 40],
    [-0.1, -0.1, 1.2, 1.2],
    ROT(30),
  ],
  // A child with a transform of its own: the group's box is still in the GROUP's space, so the child's own
  // transform is INSIDE the box (unlike the group's, which is outside it).
  [
    'a child with its own transform',
    '',
    'rotate(30)',
    '<g transform="translate(10 5)"><rect x="0" y="0" width="40" height="20" fill="#000"/></g>',
    [10, 5, 50, 25],
    [-0.1, -0.1, 1.2, 1.2],
    ROT(30),
  ],
];
for (const [label, attrs, xf, inner, ownBox, fr, C] of CASES) {
  const b = await importSvg(doc(attrs, GROUP(xf, inner)), { preserveViewport: true });
  const got = regionOf(b);
  const want = boundOf(corners(C, specRect(ownBox, fr)));
  ok(
    !!got && got.length === 5 && got.every((v, i) => Math.abs(v - want[i]) <= 1e-3),
    `${label}: ${fmt(got)}, want ${fmt(want)}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (b) the TIGHT-bound property, stated as a property rather than as one more number: every corner of the spec's
//     rect lies inside the stored rect, and every side of the stored rect is touched by one -- which is what
//     distinguishes "the bound" from "some rect that contains it", and is the exact shape of the deviation the
//     scissor forces.
console.log('(b) the stored rect is the TIGHT bound of the spec rect, not merely a superset');
{
  const b = await importSvg(
    doc(' x="0" y="-0.25" width="0.5" height="1.5"', GROUP('rotate(30)', RECT)),
    { preserveViewport: true },
  );
  const got = regionOf(b);
  const pts = corners(ROT(30), specRect([0, 0, 40, 20], [0, -0.25, 0.5, 1.5]));
  const inside =
    got &&
    pts.every(
      ([x, y]) =>
        x >= got[0] - 1e-6 &&
        x <= got[0] + got[2] + 1e-6 &&
        y >= got[1] - 1e-6 &&
        y <= got[1] + got[3] + 1e-6,
    );
  const touches =
    got &&
    [0, 1, 2, 3].every((k) =>
      pts.some(
        ([x, y]) =>
          Math.abs([x - got[0], y - got[1], x - (got[0] + got[2]), y - (got[1] + got[3])][k]) <=
          1e-6,
      ),
    );
  ok(!!inside && !!touches, `all four corners inside and every side touched (${fmt(got)})`);
}

// ------------------------------------------------------------------------------------------------
// (c) nothing the document-AABB arithmetic gets right moves: a positive-diagonal carrier keeps it.
console.log('(c) a positive-diagonal carrier keeps its region');
for (const [label, xf, want] of [
  ['translate(10 0)', 'translate(10 0)', [6, -2, 48, 24, 1]],
  ['scale(2)', 'scale(2)', [-8, -4, 96, 48, 1]],
  ['translate(5 5) scale(0.5 3)', 'translate(5 5) scale(0.5 3)', [3, -1, 24, 72, 1]],
]) {
  const b = await importSvg(doc('', GROUP(xf, RECT)), { preserveViewport: true });
  const got = regionOf(b);
  ok(
    !!got && got.every((v, i) => Math.abs(v - want[i]) <= 1e-3),
    `${label}: ${fmt(got)}, want ${fmt(want)}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (d) the demo asset: the same bar, upright and turned, under the same region.
console.log('(d) the demo asset: the cut is square to the bar in both cells');
{
  const b = await importSvg(FILTER_REGION_DEMO, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const ids = [];
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * pm.floatsPerShape + 32] + 0.5);
    if (fid > 0 && !ids.includes(fid)) ids.push(fid);
  }
  const bad = [];
  REGION_CELLS.forEach(([xf], k) => {
    const C = k === 0 ? TRANS(40, 60) : mul(TRANS(190, 60), ROT(30));
    const want = boundOf(corners(C, specRect([0, 0, 80, 24], [0, -0.25, 0.55, 1.5])));
    const got = (b.filterRegions && b.filterRegions[ids[k] - 1]) || null;
    if (!got || !got.every((v, i) => Math.abs(v - want[i]) <= 1e-3))
      bad.push(`cell ${k}: ${fmt(got)} want ${fmt(want)}`);
  });
  ok(
    ids.length === REGION_CELLS.length && bad.length === 0,
    `${ids.length} filtered cells, each region the bound of its own rect${bad.length ? ' -- ' + bad.join('; ') : ''}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (e) and the same region at every size.
console.log('(e) the same region at 2^-20 and 2^20');
{
  const at = async (S) => {
    const raw = doc(' x="0" y="-0.25" width="0.5" height="1.5"', GROUP('rotate(30)', RECT));
    const open = raw.match(/<svg\b[^>]*>/)[0];
    const svg =
      open.replace(
        /viewBox="[^"]+"/,
        `viewBox="${[-100, -100, 200, 200].map((v) => v * S).join(' ')}"`,
      ) +
      `<g transform="scale(${S})">` +
      raw.slice(open.length, raw.lastIndexOf('</svg>')) +
      '</g></svg>';
    return regionOf(await importSvg(svg, { preserveViewport: true }));
  };
  const r1 = await at(1);
  for (const e of [-20, 20]) {
    const S = 2 ** e,
      rs = await at(S);
    const bad =
      !rs ||
      !r1 ||
      [0, 1, 2, 3].some((i) => Math.abs(rs[i] - r1[i] * S) > 1e-6 * Math.abs(r1[i] * S || 1));
    ok(!bad, `2^${e}: ${fmt(rs)} is the scale-1 region times the ratio`);
  }
}

// ------------------------------------------------------------------------------------------------
// (f) A SHAPE'S own objectBoundingBox REGION — the same rule, one shape wide.
//
// Same spec sentences as (a): the fractions are of the referencing element's box in its own user space, and on
// the canvas the region is that rect through the element's CTM. importWalk.js's resolveFilterRegion stores an
// own oBB region as space 0 (the raw fractions) and renderer/filterDraw.js `_filterRegionRectPx` resolves them
// at DRAW time against `_rowBoxEm`, the meta row's DOCUMENT-space box — which for a turned shape is the AABB of
// the turned geometry, both bigger than the shape's own box and offset from it. So a turned shape resolves to
// a root-space rect (space 1) at import, exactly as the group branch above does.
//
// TWO THINGS this PINS BESIDES THE RECT. First, one ENTRY PER SHAPE: an own-claim key of the fractions alone is
// identical for every shape referencing the filter however each is turned, so two shapes under different CTMs
// would share one region — checked directly below. Second, the freeze is confined to turned shapes: an upright
// one keeps space 0 and the late resolve, which is what lets a morph re-resolve against the lerped row.
console.log("(f) a shape's OWN objectBoundingBox region under a turned CTM");
const SHAPE = (xf) =>
  `<rect transform="${xf}" x="0" y="0" width="40" height="20" fill="#000" filter="url(#f)"/>`;
for (const [label, attrs, xf, ownBox, fr, C] of [
  [
    'rotate(30), stated 0/-0.25/0.5/1.5',
    ' x="0" y="-0.25" width="0.5" height="1.5"',
    'rotate(30)',
    [0, 0, 40, 20],
    [0, -0.25, 0.5, 1.5],
    ROT(30),
  ],
  [
    'rotate(30), the implicit -10%/120% default',
    '',
    'rotate(30)',
    [0, 0, 40, 20],
    [-0.1, -0.1, 1.2, 1.2],
    ROT(30),
  ],
  [
    'skewX(30)',
    ' x="0.1" y="0" width="0.6" height="1"',
    'skewX(30)',
    [0, 0, 40, 20],
    [0.1, 0, 0.6, 1],
    SKEWX(30),
  ],
  [
    'scale(-1 1), an off-center region',
    ' x="0.1" y="0" width="0.4" height="1"',
    'scale(-1 1)',
    [0, 0, 40, 20],
    [0.1, 0, 0.4, 1],
    [-1, 0, 0, 1, 0, 0],
  ],
  [
    'translate(25 -10) rotate(40)',
    '',
    'translate(25 -10) rotate(40)',
    [0, 0, 40, 20],
    [-0.1, -0.1, 1.2, 1.2],
    mul(TRANS(25, -10), ROT(40)),
  ],
]) {
  const b = await importSvg(doc(attrs, SHAPE(xf)), { preserveViewport: true });
  const got = regionOf(b);
  const want = boundOf(corners(C, specRect(ownBox, fr)));
  ok(
    !!got &&
      got.length === 5 &&
      (got[4] | 0) === 1 &&
      got.every((v, i) => Math.abs(v - want[i]) <= 1e-3),
    `${label}: ${fmt(got)}, want ${fmt(want)}`,
  );
}
// ...and an UPRIGHT shape keeps the fractions and the draw-time resolve: nothing already right moves, and the
// late resolve a morph needs is untouched.
for (const [label, xf] of [
  ['no transform', ''],
  ['translate(10 0)', 'translate(10 0)'],
  ['scale(2)', 'scale(2)'],
]) {
  const b = await importSvg(
    doc(' x="0" y="-0.25" width="0.5" height="1.5"', SHAPE(xf || 'translate(0 0)')),
    { preserveViewport: true },
  );
  const got = regionOf(b);
  ok(
    !!got &&
      (got[4] | 0) === 0 &&
      Math.abs(got[0] - 0) <= 1e-9 &&
      Math.abs(got[1] + 0.25) <= 1e-9 &&
      Math.abs(got[2] - 0.5) <= 1e-9 &&
      Math.abs(got[3] - 1.5) <= 1e-9,
    `${label}: still the raw fractions, resolved at draw time ${fmt(got)}`,
  );
}
// ...and TWO SHAPES SHARING ONE FILTER under different CTMs get different regions. This is the half of the rule
// that is not arithmetic: with one entry keyed on the fractions they could only ever share one.
{
  const body =
    '<rect transform="rotate(30)" x="0" y="0" width="40" height="20" fill="#000" filter="url(#f)"/>' +
    '<rect transform="translate(60 0) rotate(-50)" x="0" y="0" width="40" height="20" fill="#000" filter="url(#f)"/>';
  const b = await importSvg(doc(' x="0" y="-0.25" width="0.5" height="1.5"', body), {
    preserveViewport: true,
  });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const ids = [];
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * pm.floatsPerShape + 32] + 0.5);
    if (fid > 0 && !ids.includes(fid)) ids.push(fid);
  }
  const want = [ROT(30), mul(TRANS(60, 0), ROT(-50))].map((C) =>
    boundOf(corners(C, specRect([0, 0, 40, 20], [0, -0.25, 0.5, 1.5]))),
  );
  const got = ids.map((id) => (b.filterRegions && b.filterRegions[id - 1]) || null);
  ok(
    ids.length === 2 &&
      got.every((g, k) => g && g.every((v, i) => Math.abs(v - want[k][i]) <= 1e-3)),
    `two shapes, one filter, two CTMs: ${ids.length} entries — ${got.map(fmt).join(' and ')}`,
  );
}
// ...and the region scales with the drawing.
{
  const at = async (S) => {
    const raw = doc(' x="0" y="-0.25" width="0.5" height="1.5"', SHAPE('rotate(30)'));
    const open = raw.match(/<svg\b[^>]*>/)[0];
    const svg =
      open.replace(
        /viewBox="[^"]+"/,
        `viewBox="${[-100, -100, 200, 200].map((v) => v * S).join(' ')}"`,
      ) +
      `<g transform="scale(${S})">` +
      raw.slice(open.length, raw.lastIndexOf('</svg>')) +
      '</g></svg>';
    return regionOf(await importSvg(svg, { preserveViewport: true }));
  };
  const r1 = await at(1);
  for (const e of [-20, 20]) {
    const S = 2 ** e,
      rs = await at(S);
    const bad =
      !rs ||
      !r1 ||
      (rs[4] | 0) !== 1 ||
      [0, 1, 2, 3].some((i) => Math.abs(rs[i] - r1[i] * S) > 1e-6 * Math.abs(r1[i] * S || 1));
    ok(!bad, `own region at 2^${e}: ${fmt(rs)} is the scale-1 region times the ratio`);
  }
}

console.log(fail ? `filterRegionTransformSmoke FAIL (${fail})` : 'filterRegionTransformSmoke PASS');
process.exit(fail ? 1 : 0);
