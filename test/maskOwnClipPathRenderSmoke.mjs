// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskOwnClipPathRenderSmoke -- clip-path on a <mask>. The property applies to container elements and a mask is one; CSS Masking 1 names only opacity, filter and display as not applying.
// So by default the mask's content is clipped, which is the picture of the same clip placed on the content. Chrome ignores it: importSvg({ compat: 'chrome' }) does the same.
// The default's reference is Chrome drawing the clip on a <g> inside the mask; the compat arm's is Chrome drawing the source itself. Both at 8x, box-averaged.
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';

const N = 128,
  BAR = 48;
const CLIP = '<clipPath id="c"><rect width="50" height="100"/></clipPath>';
const doc = (extra, content, style = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 100 100">${style}${CLIP}<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"${extra}>${content}</mask><rect width="100" height="100" fill="#c33" mask="url(#m)"/></svg>`;
const WHITE = '<rect width="100" height="60" fill="#fff"/>';
const CASES = [
  [
    'the content has its own fill',
    doc(' clip-path="url(#c)"', WHITE),
    doc('', `<g clip-path="url(#c)">${WHITE}</g>`),
  ],
  [
    "the content styled through the mask's id",
    doc(
      ' clip-path="url(#c)"',
      '<rect width="100" height="60"/>',
      '<style>#m rect{fill:white}</style>',
    ),
    doc('', `<g clip-path="url(#c)">${WHITE}</g>`),
  ],
  [
    'the content inherits from the mask',
    doc(' fill="#808080" clip-path="url(#c)"', '<rect width="100" height="60"/>'),
    doc(' fill="#808080"', '<g clip-path="url(#c)"><rect width="100" height="60"/></g>'),
  ],
];
const ref = await openChrome8Ref(launchBrowser);
let failures = 0,
  cells = 0;
const check = (label, r) => {
  const c = compare(r.mantle, r.chrome, N, N, { tol: BAR });
  cells++;
  const good = c.over === 0;
  console.log(`  ${good ? 'ok' : 'FAIL'} ${label}: ${c.over} px off by more than ${BAR}/255`);
  if (!good) failures++;
};
try {
  for (const [name, svg, spec] of CASES) {
    check(
      `${name}, default: the content is clipped`,
      await ref.render(svg, { w: N, h: N, chromeSvg: spec }),
    );
    check(
      `${name}, compat chrome: Chrome draws the source`,
      await ref.render(svg, { w: N, h: N, importOpts: { compat: 'chrome' } }),
    );
  }
  // The premise of the compat arm: Chrome really ignores it. If this stops holding, the option has nothing to follow.
  const held = await ref.render(CASES[0][1], {
    w: N,
    h: N,
    chromeSvg: CASES[0][2],
    importOpts: { compat: 'chrome' },
  });
  const c = compare(held.chrome, (await ref.render(CASES[0][1], { w: N, h: N })).chrome, N, N, {
    tol: BAR,
  });
  const moved = c.over > 1000;
  console.log(
    `  ${moved ? 'ok' : 'FAIL'} (premise) Chrome's source and its clipped reference differ: ${c.over} px`,
  );
  if (!moved) failures++;
  if (ref.pageErrors.length) {
    console.error(ref.pageErrors.join('\n'));
    failures++;
  }
} finally {
  await ref.close();
}
if (failures) {
  console.error(`maskOwnClipPathRenderSmoke: ${failures} failed of ${cells}`);
  process.exit(1);
}
console.log(`maskOwnClipPathRenderSmoke PASS: ${cells} cells`);
process.exit(0);
