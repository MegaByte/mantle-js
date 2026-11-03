// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterRegionTurnedRenderSmoke -- a filter region under a turn or a skew is the turned rect (Filter Effects 1 section 8), not its bounding box.
//
// A generator paints the whole region, so that is where it shows: the flood filled the AABB of the rotated region, a box where Chrome draws a turned square.
// The reference is Chrome at 8x, box-averaged; a pixel off by more than 48/255 fails, on the edge as well, so a region drawn hard-edged fails too. The same pictures run with the coordinates
// scaled by 1/1000 and 1000: nothing here may depend on the scale.
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';

const N = 256,
  BAR = 48;
// sRGB: where a source's edge pixel meets the flood, a linearRGB merge at 1x and 8x bytes averaged down read up to 55/255 apart with no turn at all (a circle), which is the reference's box and not the region.
const REGION = 'x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"';
const MERGE =
  '<feFlood flood-color="#00f" result="a"/><feMerge><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge>';
const doc = (flt, shape, s = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${400 * s} ${400 * s}"><defs>${flt}</defs><g transform="scale(${s})">${shape}</g></svg>`;
// (the group's two rects do not touch: a seam between adjacent rows at 1x against averaged 8x bytes is a separate question)
const RECT = '<rect x="150" y="150" width="100" height="100" fill="#c33" filter="url(#f)"/>';
const f = (body, attrs = REGION) => `<filter id="f" ${attrs}>${body}</filter>`;
const CASES = [
  ['a shape under a rotated group', f(MERGE), `<g transform="rotate(25 200 200)">${RECT}</g>`],
  [
    'the transform on the shape',
    f(MERGE),
    '<rect x="150" y="150" width="100" height="100" fill="#c33" filter="url(#f)" transform="rotate(25 200 200)"/>',
  ],
  [
    'a flood alone',
    f('<feFlood flood-color="#00f"/>'),
    `<g transform="rotate(25 200 200)">${RECT}</g>`,
  ],
  [
    'a userSpaceOnUse region',
    f(
      MERGE,
      'filterUnits="userSpaceOnUse" x="100" y="100" width="200" height="200" color-interpolation-filters="sRGB"',
    ),
    `<g transform="rotate(25 200 200)">${RECT}</g>`,
  ],
  [
    'a filter on a rotated group',
    f(MERGE),
    '<g filter="url(#f)" transform="rotate(25 200 200)"><rect x="150" y="150" width="45" height="100" fill="#c33"/><rect x="205" y="150" width="45" height="100" fill="#3c3"/></g>',
  ],
  ['a skew', f(MERGE), `<g transform="translate(-40 0) skewX(20)">${RECT}</g>`],
  [
    '(control) a quarter turn is still a box',
    f(MERGE),
    `<g transform="rotate(90 200 200)">${RECT}</g>`,
  ],
  ['(control) a shape with no transform', f(MERGE), RECT],
];
const ref = await openChrome8Ref(launchBrowser);
let failures = 0,
  cells = 0;
try {
  for (const [name, flt, shape] of CASES)
    for (const s of [1, 0.001, 1000]) {
      const r = await ref.render(doc(flt, shape, s), { w: N, h: N });
      const c = compare(r.mantle, r.chrome, N, N, { tol: BAR });
      cells++;
      const good = c.over === 0;
      console.log(
        `  ${good ? 'ok' : 'FAIL'} ${name}, scale ${s}: ${c.over} px off by more than ${BAR}/255`,
      );
      if (!good) failures++;
    }
  if (ref.pageErrors.length) {
    console.error(ref.pageErrors.join('\n'));
    failures++;
  }
} finally {
  await ref.close();
}
if (failures) {
  console.error(`filterRegionTurnedRenderSmoke: ${failures} of ${cells} differ from Chrome`);
  process.exit(1);
}
console.log(`filterRegionTurnedRenderSmoke PASS: ${cells} cells`);
process.exit(0);
