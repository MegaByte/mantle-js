// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterRegionImportSmoke — a <filter> region resolves per use: its units, the referencing shape's transform, and the
// implicit default region.
//
// Filter Effects 1 §7.1: x/y/width/height on <filter> are in filterUnits -- objectBoundingBox (the default: fractions of
// the referencing element's bounding box) or userSpaceOnUse (lengths in that element's user space, so its transform
// applies) -- and an unstated region is -10%/-10%/120%/120%. All three must clip, not only a stated objectBoundingBox
// region.
//
// A shape that names the filter itself gets all three. A filter inherited from a group belongs to the GROUP: one entry
// is minted per group instance, its objectBoundingBox region resolves against the union of the group's shapes, and a
// userSpaceOnUse region maps through the group's own CTM. Both come out as a rect in root user space (space 1), because
// no per-shape box can express the group's. `data-mantle-filter-region="none"` drops the region for converted content
// whose source did not clip (see svg/filter.js).
//
// No GPU: read bundle.filterRegions through each shape's filter id (meta float 32). Space 0 is fractions of the shape's
// bounding box, space 1 a rect in root user space.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, e = 1e-4) =>
  !a || !b ? a === b : a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
const fmt = (a) => (a ? '[' + Array.from(a, (v) => +(+v).toFixed(4)).join(', ') + ']' : 'null');

const doc = (filterAttrs, body) =>
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  `<defs><filter id="f"${filterAttrs}><feGaussianBlur stdDeviation="4"/></filter></defs>${body}</svg>`;
const SQUARE = '<rect x="40" y="40" width="20" height="20" fill="#000" filter="url(#f)"/>';
const GROUPED = '<g filter="url(#f)"><rect x="40" y="40" width="20" height="20" fill="#000"/></g>';

/** The filter ids of the filtered rows, in paint order. */
function filterIds(b) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const ids = [];
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * pm.floatsPerShape + 32] + 0.5);
    if (fid > 0) ids.push(fid);
  }
  return ids;
}

const R2 = Math.SQRT2;
const CASES = [
  [
    'own, stated objectBoundingBox region',
    doc(' x="-0.25" y="-0.25" width="1.5" height="1.5"', SQUARE),
    [-0.25, -0.25, 1.5, 1.5, 0],
  ],
  [
    'own, no region stated: the implicit -10%/120% default',
    doc('', SQUARE),
    [-0.1, -0.1, 1.2, 1.2, 0],
  ],
  [
    'own, implicit userSpaceOnUse percentages',
    doc(' filterUnits="userSpaceOnUse"', SQUARE),
    [-10, -10, 120, 120, 1],
  ],
  [
    'own, partially stated userSpaceOnUse percentages',
    doc(' filterUnits="userSpaceOnUse" x="25%"', SQUARE),
    [25, -10, 120, 120, 1],
  ],
  [
    'own, userSpaceOnUse region',
    doc(' filterUnits="userSpaceOnUse" x="35" y="35" width="30" height="30"', SQUARE),
    [35, 35, 30, 30, 1],
  ],
  [
    'own, userSpaceOnUse region on a translated shape',
    doc(
      ' filterUnits="userSpaceOnUse" x="25" y="35" width="30" height="30"',
      '<rect x="30" y="40" width="20" height="20" fill="#000" transform="translate(10 0)" filter="url(#f)"/>',
    ),
    [35, 35, 30, 30, 1],
  ],
  [
    'own, userSpaceOnUse region inside a scaled group',
    doc(
      ' filterUnits="userSpaceOnUse" x="17.5" y="17.5" width="15" height="15"',
      '<g transform="scale(2)"><rect x="20" y="20" width="10" height="10" fill="#000" filter="url(#f)"/></g>',
    ),
    [35, 35, 30, 30, 1],
  ],
  [
    'own, userSpaceOnUse region on a rotated shape clips to its axis-aligned bound',
    doc(
      ' filterUnits="userSpaceOnUse" x="-10" y="-10" width="20" height="20"',
      '<rect x="-5" y="-5" width="10" height="10" fill="#000" transform="translate(50 50) rotate(45)" filter="url(#f)"/>',
    ),
    [50 - 10 * R2, 50 - 10 * R2, 20 * R2, 20 * R2, 1],
  ],
  [
    'own, userSpaceOnUse percentages are of the viewport',
    doc(' filterUnits="userSpaceOnUse" x="35%" y="35%" width="30%" height="30%"', SQUARE),
    [35, 35, 30, 30, 1],
  ],
  [
    'own, userSpaceOnUse percentages of a non-square viewBox (filterCacheHit card)',
    '<svg viewBox="0 -12 267 156" xmlns="http://www.w3.org/2000/svg"><defs><filter id="f" x="-25%" y="-25%" width="150%" height="150%" ' +
      'filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="8" stdDeviation="4"/></filter></defs>' +
      '<rect x="0" y="0" width="267" height="138" fill="#fff" filter="url(#f)"/></svg>',
    [-66.75, -39, 400.5, 234, 1],
  ],
  // The group's box is the 20x20 rect, so the implicit -10%/120% default is 38..62 in root space.
  [
    'inherited from a group, no region stated: the group box +/- 10%',
    doc('', GROUPED),
    [38, 38, 24, 24, 1],
  ],
  [
    'inherited from a group, userSpaceOnUse region',
    doc(' filterUnits="userSpaceOnUse" x="35" y="35" width="30" height="30"', GROUPED),
    [35, 35, 30, 30, 1],
  ],
  // Fractions of the GROUP's box: -0.25..1.25 of 40..60 is 35..65.
  [
    'inherited from a group, stated objectBoundingBox region resolves at the group box',
    doc(' x="-0.25" y="-0.25" width="1.5" height="1.5"', GROUPED),
    [35, 35, 30, 30, 1],
  ],
  // Two shapes: the box is their UNION (10..90), so the default region is 2..98.
  [
    'inherited from a group of two shapes: the union of their boxes',
    doc(
      '',
      '<g filter="url(#f)"><rect x="10" y="10" width="20" height="20" fill="#000"/>' +
        '<rect x="70" y="70" width="20" height="20" fill="#000"/></g>',
    ),
    [2, 2, 96, 96, 1],
  ],
  // A userSpaceOnUse region on a transformed group is in the GROUP's user space, so its CTM applies.
  [
    'inherited from a transformed group, userSpaceOnUse region maps through the group CTM',
    doc(
      ' filterUnits="userSpaceOnUse" x="25" y="35" width="30" height="30"',
      '<g transform="translate(10 0)" filter="url(#f)"><rect x="40" y="40" width="20" height="20" fill="#000"/></g>',
    ),
    [35, 35, 30, 30, 1],
  ],
  [
    'data-mantle-filter-region="none" drops the region',
    doc(' data-mantle-filter-region="none" x="-0.25" y="-0.25" width="1.5" height="1.5"', SQUARE),
    null,
  ],
  [
    'data-mantle-filter-region="none" drops a group region too',
    doc(' data-mantle-filter-region="none"', GROUPED),
    null,
  ],
];
for (const [name, svg, want] of CASES) {
  const b = await importSvg(svg, { preserveViewport: true });
  const ids = filterIds(b);
  if (!ids.length) {
    ok(false, `${name}: no row carries the filter`);
    continue;
  }
  const got = (b.filterRegions && b.filterRegions[ids[0] - 1]) || null;
  ok(near(got, want), `${name}: ${fmt(got)}${near(got, want) ? '' : ', want ' + fmt(want)}`);
}

// Two shapes naming one filter under different transforms get separate entries; the same transform shares one.
{
  const b = await importSvg(
    doc(
      ' filterUnits="userSpaceOnUse" x="0" y="0" width="30" height="30"',
      '<rect x="5" y="5" width="10" height="10" fill="#000" filter="url(#f)"/>' +
        '<rect x="5" y="5" width="10" height="10" fill="#000" transform="translate(50 0)" filter="url(#f)"/>' +
        '<rect x="15" y="5" width="10" height="10" fill="#000" transform="translate(50 0)" filter="url(#f)"/>',
    ),
    { preserveViewport: true },
  );
  const ids = filterIds(b);
  ok(
    ids.length === 3 && ids[0] !== ids[1] && ids[1] === ids[2],
    `one entry per distinct region: filter ids ${ids.join(', ')} for two transforms`,
  );
}

// Two groups naming one filter are two instances: each resolves against its own box, so they cannot share an entry.
{
  const b = await importSvg(
    doc(
      '',
      '<g filter="url(#f)"><rect x="10" y="10" width="20" height="20" fill="#000"/></g>' +
        '<g filter="url(#f)"><rect x="70" y="70" width="20" height="20" fill="#000"/></g>',
    ),
    { preserveViewport: true },
  );
  const ids = filterIds(b);
  const regions = ids.map((id) => (b.filterRegions && b.filterRegions[id - 1]) || null);
  ok(
    ids.length === 2 &&
      ids[0] !== ids[1] &&
      near(regions[0], [8, 8, 24, 24, 1]) &&
      near(regions[1], [68, 68, 24, 24, 1]),
    `one entry per group instance: ids ${ids.join(', ')} regions ${regions.map(fmt).join(' ')}`,
  );
}

// Container and child programs retain distinct ownership and source order.
{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
    '<filter id="a"><feOffset dx="10"/></filter><filter id="b"><feOffset dy="20"/></filter></defs>' +
    '<g filter="url(#a)"><rect width="20" height="20" filter="url(#b)"/><rect x="30" width="20" height="20"/></g></svg>';
  const b = await importSvg(svg),
    pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    f = pm.metaFloats;
  ok(
    pm.numShapes === 4 && f[27] & 64 && f[3 * 48 + 27] & 128,
    'container filter brackets its two child paints',
  );
  ok(
    f[32] > 0 && f[48 + 32] > 0 && f[32] !== f[48 + 32] && f[96 + 32] === 0,
    'outer and inner filter programs survive; the plain sibling is SourceGraphic',
  );
  ok(
    b.filterGraphs[f[32] - 1].nodes[0].params.dx === 10 &&
      b.filterGraphs[f[48 + 32] - 1].nodes[0].params.dy === 20,
    'container and leaf retain their separate authored offsets',
  );
}

console.log(fail ? `\nFILTER-REGION-IMPORT FAIL (${fail})` : '\nFILTER-REGION-IMPORT PASS');
process.exit(fail ? 1 : 0);
