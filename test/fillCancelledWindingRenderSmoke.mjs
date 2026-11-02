// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillCancelledWindingRenderSmoke -- on the GPU, against Chrome at 8x box-averaged: the plain paths of lbCancelledWindingSmoke on the
// pinned Loop-Blinn route, and paths whose winding cancels everywhere on the pinned CPatch route. Pixels on an edge of the Chrome
// picture are not scored, so a number here is a wrong region and not antialiasing. The engine ledger shows the pinned engine drew
// wherever the case has ink to draw.
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const QUAD = 'M10 100Q64 0 118 100Z';
const SQ = 'M20 20H108V108H20Z',
  SQR = 'M20 20V108H108V20H20Z';
const CURVE = 'M20 64C20 20 108 20 108 64C108 108 20 108 20 64Z',
  CURVER = 'M20 64C20 108 108 108 108 64C108 20 20 20 20 64Z';
const LB = [
  ['rect in a quad hull', QUAD + 'M20 10H108V20H20Z', 'nonzero', 'lb'],
  ['triangle in a quad hull', QUAD + 'M64 30L100 10L28 10Z', 'nonzero', 'lb'],
  ['triangle 1 from the arc', QUAD + 'M64 49L100 10L28 10Z', 'evenodd', 'lb'],
  ['triangle touching the arc', QUAD + 'M64 50L100 10L28 10Z', 'nonzero', 'lb'],
  ['retraced quad', 'M92 73Q12 62 24 98Q12 62 92 73L56 110Q31 106 92 73Z', 'nonzero', 'lb'],
  [
    'a plus sign at fractional coordinates',
    'M112.3 44.6L112.3 83.4L83.4 83.4L83.4 112.1L44.6 112.1L44.6 83.4L15.7 83.4L15.7 44.6L44.6 44.6L44.6 15.9L83.4 15.9L83.4 44.6L112.3 44.6Z',
    'nonzero',
    'lb',
  ],
  ['a straight line', 'M10 10L118 118', 'nonzero', null],
  [
    'one contour of fat quads, no line along a chord',
    'M115.38 68.119Q107.898 82.542 95.431 99.462Q74.08 125.421 56.994 107.292Q28.109 104.894 24.047 86.505Q-3.357 61.657 18.905 40.714Q27.211 17.27 53.731 17.151Q79.957 16.086 93.728 24.637Q118.308 41.796 115.38 68.119Z',
    'nonzero',
    'lb',
  ],
  // Whole rows of the view gone before: a vertex within a share of a 60000-unit edge bent the edge through itself. Twin: 256 flat pixels.
  [
    'a polygon 60000 long with a vertex near its long edge',
    'M-30000 60L0 85.5L30000 60L30000 91L-30000 91Z',
    'nonzero',
    'lb',
  ],
  [
    'a long flat fan and a bar',
    'M-2936 90L-2186 63.75L-1436 45L-686 33.75L64 30L814 33.75L1564 45L2314 63.75L3064 90L3064 92L-2936 92ZM-2936 93L3064 93L3064 94L-2936 94Z',
    'nonzero',
    'lb',
  ],
];
const CPATCH = [
  ['contour and its reverse', SQ + SQR, 'nonzero', null],
  ['contour twice, even-odd', SQ + SQ, 'evenodd', null],
  ['curved contour and its reverse', CURVE + CURVER, 'nonzero', null],
  // 1288 before one walk per coincident edge. A streak of 8 remained that the same triangle drawn once does not have: centers exactly on a seam, where both patches' kernels rejected.
  [
    'triangle three times with a hole, even-odd',
    'M64 10L118 100H10ZM64 10L118 100H10ZM64 10L118 100H10ZM40 60H88V90H40Z',
    'evenodd',
    'cpatch',
  ],
  // A seam's centers lying exactly on it: 15 of these read 0 with a shorter slide at the seam's sharp corner, and 3 with the full slide and no tie allowance.
  [
    'a grid path whose seams run through pixel centers',
    'M16 96C96 112 80 64 64 80L80 80Q96 64 64 112L64 112ZM112 64L32 16C128 16 16 80 16 48Q0 32 0 112Z',
    'evenodd',
    'cpatch',
  ],
  // A sharp corner's slide is what closes its seam: with the slide cut short, a line of 41 solid pixels read 0 here.
  [
    'a dart of arcs, its seam closed by a long slide',
    'M101.2696 27.7304A510.8053 408.6443 20 0 1 58.0944 120.3198A220.4211 176.3369 20 0 1 52.3943 76.6057A220.4211 176.3369 20 0 1 8.6802 70.9056A510.8053 408.6443 20 0 1 101.2696 27.7304Z',
    'nonzero',
    'cpatch',
  ],
  [
    'two triangles sharing an apex and a stretch of edge',
    'M20 20H60V60ZM20 20H100V60Z',
    'nonzero',
    'cpatch',
  ],
];
const ref = await openChrome8Ref(launchBrowser);
const svgOf = (d, rule) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><path fill-rule="${rule}" d="${d}"/></svg>`;
const run = async (route, rendererOpts, cases) => {
  for (const [name, d, rule, wantDraw, bar = 0] of cases) {
    const svg = svgOf(d, rule);
    const { mantle, chrome, drew } = await ref.render(svg, { w: 128, h: 128, route, rendererOpts });
    const s = compare(mantle, chrome, 128, 128, { edge: chrome, tol: 32 });
    ok(
      s.over <= bar,
      `${route}: ${name}: ${s.over} of ${s.n} flat pixels off by more than 32, drew ${JSON.stringify(drew)}`,
    );
    if (wantDraw) ok((drew[wantDraw] | 0) > 0, `${route}: ${name}: drawn by ${wantDraw}`);
  }
};
try {
  await run('lb', null, LB);
  // A curve along a straight line is that line, edge pixels and all: every pixel scored here. 131 pixels off before, with `L` in the same place 1.
  {
    const { mantle, chrome, drew } = await ref.render(
      svgOf('M0 0H100Q90 25 80 50Q90 75 100 100H0Z', 'nonzero'),
      { w: 128, h: 128, route: 'lb' },
    );
    const s = compare(mantle, chrome, 128, 128, { tol: 32 });
    ok(
      s.over <= 2 && (drew.lb | 0) > 0,
      `lb: a straight quad: ${s.over} of ${s.n} pixels off by more than 32, drew ${JSON.stringify(drew)}`,
    );
  }
  await run('cpatch', { cpatchFill: true }, CPATCH);
  // Pixel centers exactly on the outline must get a fragment (8 on this triangle's slanted edge would otherwise read 0).
  {
    const { mantle, chrome } = await ref.render(
      svgOf('M64 10L118 100H10ZM64 10L118 100H10ZM64 10L118 100H10ZM40 60H88V90H40Z', 'evenodd'),
      { w: 128, h: 128, route: 'cpatch', rendererOpts: { cpatchFill: true } },
    );
    const s = compare(mantle, chrome, 128, 128, { tol: 96 });
    ok(
      s.over === 0,
      `cpatch: a triangle with a hole: ${s.over} of ${s.n} pixels off by more than 96, edges included`,
    );
  }
  ok(!ref.pageErrors.length, 'no page errors: ' + ref.pageErrors.slice(0, 2).join(' | '));
} finally {
  await ref.close();
}
if (fail) {
  console.log(`fillCancelledWindingRenderSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('fillCancelledWindingRenderSmoke: PASS');
