// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeThinSlabSmoke — a stroke thinner than the pixel box is covered as its SLAB, both sides.
//
// THE HAZARD. The band walk takes a pixel's coverage from the winning segment's edge record. A body's record that is
// only its SIDE (the one offset line on the fragment's side) fails where the stroke is thinner than the pixel box
// (halfW under 0.71 px, as a 1 px line is): the box reaches the other side too, and one side runs the stroke on across
// it; on the centerline the side has no normal at all and the ramp reads 1. A 1 px line at 45 degrees through pixel
// corners would read 1.00 for SVG 2's 0.92 at every pixel of its body (21.7/255).
//
// The record (_strokeMath.glsl seSlab, op 9) a side whose other side reaches into the box is the slab: both sides, and the
// plane a cap or a dash end adds where one cuts it (_coverage.glsl strokeExactCov: the box clipped by the three).
// A round cap keeps its disc with the slab behind it (op 4), which holds both sides already.
//
// Against SVG 2's shape (test/_strokeShapeRef.mjs svgInside) box-sampled, the main pass (test/_strokeMainCov.mjs):
// (a) single lines -- 8 directions, through pixel corners and off them, half-widths 0.5, 0.6 and 0.7 px, butt, round
//     and square caps -- every pixel within reach, at 2^-20, 1 and 2^20: within 3/255;
// (c) the slab removed (the side alone), (a) fails.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { svgInside } from './_strokeShapeRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const SLAB = [
  ['  return vec4(s, -s.z - 2.0 * halfW > -reach ? 9.0 : 1.0);', '  return vec4(s, 1.0);'],
  [
    'vec4(bodyG, thisD - halfW, -thisD - halfW > -aaEm ? 9.0 : 1.0)',
    'vec4(bodyG, thisD - halfW, 1.0)',
  ],
];
ok(
  SLAB.every(([t]) => GLSL.split(t).length === 2),
  "the slab record (seSlab, and the line body's) is in the shipped shader text",
);
const CAPS = ['butt', 'round', 'square'];

async function score(glsl, S, full) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl);
  let n = 0,
    bad = 0,
    worst = 0,
    at = '';
  const dirs = full
    ? [
        [14, 0],
        [14, 5],
        [11, 9],
        [10, 10],
        [7, 13],
        [0, 14],
        [-6, 13],
        [-10, 10],
      ]
    : [
        [14, 5],
        [10, 10],
        [-6, 13],
      ];
  for (const hw of full ? [0.5, 0.6, 0.7] : [0.5, 0.7])
    for (const cap of [0, 1, 2])
      for (const d of dirs)
        for (const off of [
          [0, 0],
          [0.37, 0.19],
        ]) {
          const A = [25 + off[0], 25 + off[1]],
            P = [A, [A[0] + d[0], A[1] + d[1]]];
          const B = strokeRowsOf(
            await importSvg(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${50 * S}" height="${50 * S}" viewBox="0 0 ${50 * S} ${50 * S}"><g transform="scale(${S})"><path d="M ${P[0].join(' ')} L ${P[1].join(' ')}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="${CAPS[cap]}"/></g></svg>`,
              { preserveViewport: true },
            ),
          );
          const pix = [];
          for (
            let y = Math.floor(Math.min(P[0][1], P[1][1])) - 2;
            y <= Math.ceil(Math.max(P[0][1], P[1][1])) + 2;
            y++
          )
            for (
              let x = Math.floor(Math.min(P[0][0], P[1][0])) - 2;
              x <= Math.ceil(Math.max(P[0][0], P[1][0])) + 2;
              x++
            )
              pix.push([x, y]);
          const cov = mainCov(emu, B, B.rows[0], pix, S, exact);
          pix.forEach(([x, y], i) => {
            const e = Math.abs(
              cov[i] -
                refCov(
                  (p) => svgInside(p, P, false, hw, cap, 0, 4),
                  (a, b) => [a, b],
                  x,
                  y,
                ),
            );
            n++;
            if (e > 3 / 255) bad++;
            if (e > worst) {
              worst = e;
              at = `M ${P[0].join(' ')} L ${P[1].join(' ')} hw ${hw} ${CAPS[cap]} px ${x},${y}: ${cov[i].toFixed(3)}`;
            }
          });
        }
  return { n, bad, worst, at };
}

for (const S of [2 ** -20, 1, 2 ** 20]) {
  const r = await score(GLSL, S, S === 1);
  ok(
    r.bad === 0,
    `(a) at 2^${Math.log2(S)}: ${r.n} pixels about single lines 1 to 1.4 px wide: worst ${(r.worst * 255).toFixed(2)}/255 off SVG 2`,
  );
}
{
  const old = SLAB.reduce((g, [t, u]) => g.replace(t, u), GLSL);
  const r = await score(old, 1, false);
  ok(
    old !== GLSL && r.bad > 0,
    `(c) with the side alone: ${r.bad} of ${r.n} pixels over 3/255 (worst ${(r.worst * 255).toFixed(1)}/255: ${r.at})`,
  );
}
console.log(fail ? `STROKE-THIN-SLAB FAIL (${fail})` : 'STROKE-THIN-SLAB PASS');
process.exit(fail ? 1 : 0);
