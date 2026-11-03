// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullEvenOddSmoke.mjs — the occlusion cull must test an occluder under its own fill rule.
//
// computeOccludedShapes drops a shape when a later opaque shape covers it. Its containment test asks
// pointInFill under the occluder's own rule: with the fill rule hardcoded NONZERO an EVEN-ODD occluder's holes
// read as solid, so a shape sitting in a hole would pass every sample, including the interior grid that exists so
// "an occluder with a HOLE under the shape can't pass" (an even-odd frame would cull the gems in its cut-outs).
//
// A render can miss it: the thorough half of the cull runs on a WORKER and lands asynchronously, so a render
// measurement that finishes its frames before the worker answers sees a correct picture. That is why
// this is a node test of the decision itself rather than a render smoke: it cannot race anything.
//
// Assertions, for an even-odd hole and for a nonzero hole made by a reversed inner contour:
//   1. The shape sitting in the occluder's hole is NOT culled.
//   2. The shape under the occluder's solid part IS culled — otherwise (1) could pass on a cull that never
//      culls anything.
//   3. Tested as nonzero, the even-odd occluder DOES contain the in-hole shape — the nonzero case, proven
//      reachable, so this smoke can see it.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { computeOccludedShapes, segsOf, isContained, occluderEps } =
  await import('../src/renderer/occlusionCull.js');

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

async function rowsOf(svg) {
  const sec = await importSvg(svg);
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const MF = m.metaFloats,
    ST = m.floatsPerShape;
  const hex = (i) =>
    [4, 5, 6]
      .map((k) =>
        Math.round(MF[i * ST + k] * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const byColor = new Map();
  for (let i = 0; i < m.numShapes; i++) if (MF[i * ST + 7] > 0) byColor.set(hex(i), i);
  return {
    cv: new Float32Array(sec.curves),
    ranges: (sec.curveRangesByShape || []).map((r) => ({ begin: r.begin | 0, end: r.end | 0 })),
    MF,
    ST,
    n: m.numShapes,
    byColor,
  };
}

const OUTER = 'M0,0 H400 V400 H0 Z';
const CASES = [
  [
    'even-odd hole',
    `<path fill-rule="evenodd" fill="#000000" d="${OUTER} M100,100 H300 V300 H100 Z"/>`,
  ],
  [
    'nonzero hole (reversed inner contour)',
    `<path fill-rule="nonzero" fill="#000000" d="${OUTER} M100,100 V300 H300 V100 Z"/>`,
  ],
];
let evenOddRows = null;
for (const [label, occluder] of CASES) {
  const R = await rowsOf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <path fill="#ff0000" d="M150,150 H250 V250 H150 Z"/>
    <path fill="#0000ff" d="M20,20 H80 V80 H20 Z"/>
    ${occluder}
  </svg>`);
  const inHole = R.byColor.get('ff0000'),
    onSolid = R.byColor.get('0000ff'),
    occ = R.byColor.get('000000');
  if (inHole == null || onSolid == null || occ == null) {
    fail(`${label}: fixture rows not found`);
    continue;
  }
  if (label.startsWith('even-odd')) evenOddRows = { R, inHole, occ };
  const culled = computeOccludedShapes(R.cv, R.ranges, R.MF, R.n, R.ST, 'full');
  if (culled.has(inHole))
    fail(`${label}: the shape in the occluder's HOLE was culled, and it is visible`);
  else ok(`${label}: the shape in the hole survives the cull`);
  if (!culled.has(onSolid))
    fail(
      `${label}: the shape under the solid part was not culled, so the hole assertion proves nothing`,
    );
  else ok(`${label}: the shape under the solid part is culled (non-vacuous)`);
}

if (evenOddRows) {
  const { R, inHole, occ } = evenOddRows;
  const si = segsOf(inHole, R.cv, R.ranges),
    sj = segsOf(occ, R.cv, R.ranges);
  const b = (k) => R.MF[inHole * R.ST + k],
    bo = (k) => R.MF[occ * R.ST + k];
  const eps = occluderEps(bo(0), bo(1), bo(2), bo(3));
  if (!isContained(si, sj, eps, b(0), b(1), b(2), b(3), false, false))
    fail(
      'tested as nonzero the even-odd occluder does not contain the in-hole shape, so this smoke cannot see the nonzero case',
    );
  else ok('tested as nonzero, the even-odd hole reads solid: the nonzero case is reachable');
  if (isContained(si, sj, eps, b(0), b(1), b(2), b(3), false, true))
    fail('under its own even-odd rule the occluder still contains the in-hole shape');
  else ok('under its own even-odd rule it does not');
}

console.log(
  failures ? `\nOCCLUSION-CULL-EVENODD FAIL (${failures})` : '\nOCCLUSION-CULL-EVENODD PASS',
);
process.exit(failures ? 1 : 0);
