// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// anchorHrefHitSmoke.mjs — an <a href> reaches the hit test: createBundle carries the importer's
// per-row shapeHrefs, and fillHitHref answers the link under a point.
//
// The importer records each shape's anchor (sections.shapeHrefs); createBundle must carry the array and a
// hit query must return it, or a click maps to a shape index and never to the link the author put on it.
//
// Asserts, against both the importSvg sections and the createBundle output (fake GL, no pixels):
//   - importSvg records one href per shape row (shapeHrefs, as long as numShapes), and an <a> with no href
//     is a transparent group whose shapes carry '';
//   - a point inside a linked shape answers that shape's href;
//   - nested <a>: the innermost anchor wins, and the outer one still applies to its other children;
//   - xlink:href is the fallback when href is absent;
//   - a shape outside every anchor answers '' (a hit, no link), a miss answers null;
//   - the topmost shape decides: an unlinked shape painted over a linked one answers '';
//   - the href follows the draw's worldMatrix exactly as fillHitShape does;
//   - both public entry points export it.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { createFakeGl } from '../_fakeGl.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);

const root = await import('../../src/index.js');
const sub = await import('../../src/hitTest/index.js');
const { importSvg, createBundle, HitMode } = root;
const fillHitHref = root.fillHitHref;
if (typeof fillHitHref !== 'function') fail('fillHitHref is not exported from the package root');
if (typeof sub.fillHitHref !== 'function')
  fail('fillHitHref is not exported from @kontek/mantle/hitTest');

const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
  <rect x="0" y="0" width="20" height="20" fill="#888"/>
  <a href="https://outer.example/">
    <rect x="30" y="0" width="20" height="20" fill="red"/>
    <a href="https://inner.example/">
      <rect x="60" y="0" width="20" height="20" fill="blue"/>
    </a>
  </a>
  <a xlink:href="legacy.html">
    <circle cx="10" cy="50" r="8" fill="green"/>
  </a>
  <a href="under.html">
    <rect x="40" y="40" width="30" height="30" fill="orange"/>
  </a>
  <rect x="50" y="50" width="30" height="30" fill="purple"/>
</svg>`;

const CASES = [
  [10, 10, '', 'unlinked rect'],
  [40, 10, 'https://outer.example/', 'rect in the outer anchor'],
  [70, 10, 'https://inner.example/', 'rect in the nested anchor (innermost wins)'],
  [10, 50, 'legacy.html', 'xlink:href fallback'],
  [45, 45, 'under.html', 'linked rect where nothing covers it'],
  [60, 60, '', 'unlinked rect painted over the linked one (topmost decides)'],
  [95, 95, null, 'empty canvas (miss)'],
];

const sections = await importSvg(SVG, {});
// The importer's per-shape rows, in document order: '' outside every anchor, the innermost anchor's href inside one.
const ROWS = [
  '',
  'https://outer.example/',
  'https://inner.example/',
  'legacy.html',
  'under.html',
  '',
];
if (!Array.isArray(sections.shapeHrefs) || sections.shapeHrefs.length !== sections.numShapes)
  fail(
    `importSvg: shapeHrefs ${sections.shapeHrefs ? 'length ' + sections.shapeHrefs.length : 'missing'}, numShapes ${sections.numShapes}`,
  );
else if (JSON.stringify(sections.shapeHrefs) !== JSON.stringify(ROWS))
  fail(
    `importSvg: shapeHrefs ${JSON.stringify(sections.shapeHrefs)}, want ${JSON.stringify(ROWS)}`,
  );
else ok(`importSvg records one href per shape: [${sections.shapeHrefs.join(', ')}]`);
// An <a> with no href is a transparent group: its shapes carry ''.
{
  const bare = await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><a><rect x="0" y="0" width="40" height="40" fill="red"/></a></svg>',
    {},
  );
  if (bare.shapeHrefs[0] !== '')
    fail(`<a> with no href should leave the href empty: '${bare.shapeHrefs[0]}'`);
  else ok('<a> with no href: empty href (a transparent group)');
}
const F = createFakeGl();
const bundle = createBundle(F.gl, sections, { occlusionCull: false });

if (!Array.isArray(bundle.shapeHrefs) || bundle.shapeHrefs.length !== bundle.numShapes)
  fail(
    `createBundle: shapeHrefs ${bundle.shapeHrefs ? 'length ' + bundle.shapeHrefs.length : 'missing'}, numShapes ${bundle.numShapes}`,
  );
else ok(`createBundle carries shapeHrefs (${bundle.shapeHrefs.length} rows)`);

if (typeof fillHitHref === 'function') {
  for (const [label, target] of [
    ['sections', sections],
    ['bundle', bundle],
  ]) {
    for (const [x, y, want, what] of CASES) {
      const got = fillHitHref(target, x, y, { mode: HitMode.Coverage });
      if (got === want) ok(`${label}: ${what} (${x},${y}) -> ${JSON.stringify(got)}`);
      else
        fail(
          `${label}: ${what} (${x},${y}) -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
        );
    }
  }
  // worldMatrix: the bundle drawn at 2x, shifted by (100, 0). The point (100 + 2*70, 2*10) is the nested rect.
  const wm = [2, 0, 0, 0, 2, 0, 100, 0, 1];
  const a = fillHitHref(bundle, 240, 20, { mode: HitMode.Coverage, worldMatrix: wm });
  const b = fillHitHref(bundle, 110, 10, { mode: HitMode.Coverage, worldMatrix: wm });
  const c = fillHitHref(bundle, 70, 10, { mode: HitMode.Coverage, worldMatrix: wm });
  if (a === 'https://inner.example/' && b === '' && c === null)
    ok(
      `worldMatrix: (240,20) -> inner, (110,10) -> '' (the unlinked rect's image), (70,10) -> null (left of the bundle)`,
    );
  else
    fail(
      `worldMatrix: (240,20) -> ${JSON.stringify(a)}, (110,10) -> ${JSON.stringify(b)}, (70,10) -> ${JSON.stringify(c)}`,
    );
  // A bundle with no anchors at all answers '' on a hit, not undefined.
  const plain = createBundle(
    F.gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      {},
    ),
  );
  const p = fillHitHref(plain, 5, 5, { mode: HitMode.Coverage });
  if (p === '') ok(`anchor-free bundle: a hit answers ''`);
  else fail(`anchor-free bundle: a hit answers ${JSON.stringify(p)}, want ''`);
}

if (failures) {
  console.error(`\nANCHOR-HREF-HIT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nANCHOR-HREF-HIT PASS');
