// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternUnitsSmoke — a <pattern> tile follows SVG's pattern coordinate system, not the filled shape's bounding box.
//
// SVG 2 §14.3 (and SVG 1.1 §13.3): x/y/width/height are fractions of the referencing element's bounding box under
// patternUnits="objectBoundingBox" (the DEFAULT) and user units under "userSpaceOnUse"; viewBox + preserveAspectRatio,
// or patternContentUnits="objectBoundingBox", scale the content into the tile; href inherits a pattern's attributes and
// children; and the whole pattern space is the referencing element's user space, so the element's transform applies.
//
// The failure this guards: width/height taken as user units in every mode, the tile origin put at the filled shape's
// bounding-box corner, x, y, viewBox, patternContentUnits and href ignored, and tiling in root space whatever the shape's
// transform -- the same pattern producing byte-identical meta under both unit systems.
//
// No GPU: import each case and read the fill row's meta -- texel 9 (floats 36-39) is the tile origin and size in
// pattern space, texel 5 (floats 20-23) the inverse linear part of pattern space -> root space (column-major), texel 10
// (floats 40-43) the pattern marker (first child row + 1, last child row + 1, 0, 2). Child geometry is checked through
// the child rows' bounding boxes (floats 0-3), which is where content scaling lands.
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
const near = (a, b, e = 1e-3) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
const fmt = (a) => '(' + a.map((v) => +v.toFixed(3)).join(', ') + ')';

const WHITE = '<rect width="26" height="26" fill="#ffffff"/>';
const BLUE = '<rect width="13" height="26" fill="#0090ff"/>';
const RECT = '<rect x="10" y="20" width="80" height="60" fill="url(#p)"/>';
const doc = (defs, body = RECT) =>
  `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`;

async function rows(svg) {
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const st = pm.floatsPerShape,
    out = [];
  for (let s = 0; s < pm.numShapes; s++)
    out.push(Array.from(pm.metaFloats.subarray(s * st, s * st + st)));
  const fill = out.find((r) => r[43] === 2);
  const children = fill ? out.slice(fill[40] - 1, fill[41]) : [];
  return { fill, children };
}
const tile = (r) => r.slice(36, 40);
const invLinear = (r) => r.slice(20, 24);
const bbox = (r) => r.slice(0, 4);

{
  const { fill } = await rows(
    doc(
      `<pattern id="p" x="5" y="7" width="26" height="26" patternUnits="userSpaceOnUse">${WHITE}${BLUE}</pattern>`,
    ),
  );
  ok(
    !!fill && near(tile(fill), [5, 7, 26, 26]),
    `userSpaceOnUse: tile at the pattern's own x, y in user space, not the shape's corner ${fill && fmt(tile(fill))}`,
  );
}
{
  const { fill } = await rows(
    doc(`<pattern id="p" x="0.1" y="0.2" width="0.25" height="0.5">${WHITE}${BLUE}</pattern>`),
  );
  ok(
    !!fill && near(tile(fill), [18, 32, 20, 30]),
    `objectBoundingBox (default): x/y/width/height are fractions of the 80x60 box at (10, 20) ${fill && fmt(tile(fill))}`,
  );
}
{
  const { fill, children } = await rows(
    doc(
      `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0090ff"/></pattern>`,
    ),
  );
  ok(
    !!fill && children.length === 1 && near(bbox(children[0]), [0, 0, 26, 26]),
    `viewBox: a 10-unit child fills the 26-unit tile ${children[0] && fmt(bbox(children[0]))}`,
  );
}
{
  const { fill, children } = await rows(
    doc(
      `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox"><rect width="0.1" height="0.1" fill="#0090ff"/></pattern>`,
    ),
  );
  // The content is stored once in canonical (box-fraction) space and the carrier is a pattern in that space: its inverse is diag(1/80, 1/60),
  // so the child sits at 80 x 60 times its canonical box in the tile's own units.
  const il = fill && invLinear(fill),
    inTile = (b) => [b[0] / il[0], b[1] / il[3], b[2] / il[0], b[3] / il[3]];
  ok(
    !!fill &&
      children.length === 1 &&
      near(inTile(bbox(children[0])), [0, 0, 8, 6]) &&
      near(tile(fill), [0, 0, 26 / 80, 26 / 60]),
    `patternContentUnits objectBoundingBox: content scales by the 80x60 box ${children[0] && fmt(inTile(bbox(children[0])))}`,
  );
}
{
  const { fill, children } = await rows(
    doc(
      `<pattern id="base" width="26" height="26" patternUnits="userSpaceOnUse">${WHITE}${BLUE}</pattern><pattern id="p" href="#base" x="3"/>`,
    ),
  );
  ok(
    !!fill && near(tile(fill), [3, 0, 26, 26]) && children.length === 2,
    `href: attributes and children inherit from the referenced pattern, its own x wins ${fill && fmt(tile(fill))}, ${children.length} children`,
  );
}
{
  const { fill } = await rows(
    doc(
      `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse">${WHITE}${BLUE}</pattern>`,
      `<g transform="scale(2)">${RECT}</g>`,
    ),
  );
  ok(
    !!fill && near(tile(fill), [0, 0, 26, 26]) && near(invLinear(fill), [0.5, 0, 0, 0.5]),
    `scale(2) on the shape scales pattern space: inverse linear ${fill && fmt(invLinear(fill))}, tile ${fill && fmt(tile(fill))}`,
  );
}
{
  const { fill } = await rows(
    doc(
      `<pattern id="p" width="26" height="26" patternUnits="userSpaceOnUse">${WHITE}${BLUE}</pattern>`,
      `<g transform="rotate(30)">${RECT}</g>`,
    ),
  );
  const c = Math.cos(Math.PI / 6),
    s = Math.sin(Math.PI / 6);
  ok(
    !!fill && near(invLinear(fill), [c, -s, s, c]),
    `rotate(30) on the shape rotates pattern space: inverse linear ${fill && fmt(invLinear(fill))}`,
  );
}

console.log(fail ? `\n${fail} failure(s)` : '\nPATTERN-UNITS PASS');
process.exit(fail ? 1 : 0);
