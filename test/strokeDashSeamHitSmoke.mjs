// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamHitSmoke -- the CPU stroke hit test agrees with the drawn stroke at the seam of a closed dashed contour.
//
// fillHitShape(Outline) on a bundle imported from a closed, dashed path is compared with the SVG 2 oracle (test/_strokeDashOracle.mjs dashClosed:
// one dash through the seam when the pattern is on at both ends, caps where only one side is on) at a grid of points, skipping the points whose
// answer is not stable under a 0.04 jitter (an edge). The same cases the shader smoke (strokeDashSeamSmoke.mjs) draws.
//   node test/strokeDashSeamHitSmoke.mjs [--diagnostic-curves]
import * as O from './_strokeDashOracle.mjs';
import * as C from './_strokeSeamCases.mjs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');

let failures = 0,
  rows = 0,
  points = 0,
  info = 0;
const COMBOS = [
  ['butt', 'miter'],
  ['round', 'round'],
  ['square', 'bevel'],
  ['round', 'miter'],
];
const PATTERNS = [
  [30, 20],
  [14, 10],
  [6, 4],
];
const diagnosticCurves = process.argv.includes('--diagnostic-curves');
async function row(shape, cap, join, dash, doff, mode = 'chrome') {
  const exact = /^(square|squareEdge|tri|triEdge)$/.test(shape.id);
  if (!exact && !diagnosticCurves) return;
  const c = { id: shape.id, subs: shape.subs, hw: 5, cap, join, ml: 4, dash, doff, mode };
  const b = await importSvg(C.svgFor(c), C.importOpts(c));
  const inside = C.insideFor(c),
    seams = C.seamsOf(c.subs);
  let bad = 0,
    n = 0,
    first = '';
  for (let y = 0; y < 100; y += 0.7)
    for (let x = 0; x < 100; x += 0.7) {
      if (!seams.some((s) => Math.hypot(x - s[0], y - s[1]) <= 22)) continue;
      const o = inside([x, y]);
      if (
        [
          [0.04, 0],
          [-0.04, 0],
          [0, 0.04],
          [0, -0.04],
        ].some(([dx, dy]) => inside([x + dx, y + dy]) !== o)
      )
        continue;
      const hit = fillHitShape(b, x, y, { mode: HitMode.Outline }) >= 0;
      n++;
      if (hit !== o) {
        bad++;
        if (!first) first = `(${x.toFixed(2)},${y.toFixed(2)}) hit ${hit} oracle ${o}`;
      }
    }
  rows++;
  points += n;
  const st = C.seamState(c);
  // straight edges are exact; a curve's round/square dash cap in the CPU model is a tangent-plane approximation of the shader's (reported, not asserted)

  if (bad && !exact) {
    info++;
    console.log(
      `  info (not asserted) ${shape.id} ${cap}/${join} [${dash.join(' ')}] off ${+doff.toFixed(3)}: ${bad} of ${n} points differ from the oracle`,
    );
  } else if (bad) {
    failures++;
    console.log(
      `  FAIL ${mode === 'spec' ? 'SPEC ' : ''}${shape.id} ${cap}/${join} [${dash.join(' ')}] off ${+doff.toFixed(3)} (F ${st[0] ? 'on' : 'off'}, E ${st[1] ? 'on' : 'off'}): ${bad} of ${n} points disagree, e.g. ${first}`,
    );
  }
}
let k = 0;
for (const shape of C.shapes())
  for (const dash of PATTERNS.slice(0, 2)) {
    const L = O.subLen(O.wholeSubpaths(shape.subs)[0]),
      T = dash.reduce((a, b) => a + b, 0),
      mod = (v) => ((v % T) + T) % T;
    for (const doff of [0, mod(-L), mod(dash[0] - L), 0.37 * T, 0.71 * T]) {
      const [cap, join] = COMBOS[k++ % COMBOS.length];
      await row(shape, cap, join, dash, +doff.toPrecision(12));
    }
  }
// ---- the default (compat 'spec'): the seam is two dash ends ------------------------------------------------------------------------------------
for (const shape of C.shapes().filter((q) => q.exact))
  for (const [cap, join, dash, doff] of [
    ['butt', 'miter', [14, 10], 0],
    ['round', 'round', [14, 10], 6],
    ['square', 'bevel', [30, 20], 10],
  ])
    await row(shape, cap, join, dash, doff, 'spec');

// ---- non-scaling-stroke: the band and the dashes are in SCREEN pixels, so at world zoom 2 the em half width and dash lengths are half the authored numbers ----
{
  let bad = 0,
    n = 0;
  for (const [id, dash, doff] of [
    ['square', [14, 10], 0],
    ['squareEdge', [14, 10], 5],
    ['tri345', [30, 20], 10],
  ]) {
    const shape = C.shapes().find((q) => q.id === id),
      Z = 2;
    const c = { id, subs: shape.subs, hw: 5, cap: 'butt', join: 'miter', ml: 4, dash, doff };
    const svg = C.svgFor(c).replace('<path ', '<path vector-effect="non-scaling-stroke" ');
    const b = await importSvg(svg, { preserveViewport: true, compat: 'chrome' });
    // the same drawing in em: half the width and dashes
    const ce = { ...c, mode: 'chrome', hw: c.hw / Z, dash: dash.map((v) => v / Z), doff: doff / Z },
      inside = C.insideFor(ce),
      seams = C.seamsOf(c.subs);
    for (let y = 0; y < 100; y += 0.7)
      for (let x = 0; x < 100; x += 0.7) {
        if (!seams.some((q) => Math.hypot(x - q[0], y - q[1]) <= 14)) continue;
        const o = inside([x, y]);
        if (
          [
            [0.04, 0],
            [-0.04, 0],
            [0, 0.04],
            [0, -0.04],
          ].some(([dx, dy]) => inside([x + dx, y + dy]) !== o)
        )
          continue;
        const hit =
          fillHitShape(b, x * Z, y * Z, {
            mode: HitMode.Outline,
            worldMatrix: [Z, 0, 0, 0, Z, 0, 0, 0, 1],
          }) >= 0;
        n++;
        if (hit !== o) bad++;
      }
  }
  rows++;
  points += n;
  if (bad) {
    failures++;
    console.log(`  FAIL non-scaling-stroke at world zoom 2: ${bad} of ${n} points disagree`);
  }
}
console.log(
  `${rows} rows, ${points} stable points compared; ${info} curve rows differ (not asserted)`,
);
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
