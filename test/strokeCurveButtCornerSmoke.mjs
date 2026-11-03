// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveButtCornerSmoke — a curve's butt end cuts the pixel at its corner.
//
// THE HAZARD. The main pass takes a stroke's coverage from the winning feature's EDGE RECORD. Where a curve's
// closest point is inside the segment but near a free butt end, the end's plane cuts the body from inside. A record
// that took it (_strokeMath.glsl strokeCapsJoinsDash) only for a pixel center within halfW of the centerline -- the
// distance's own test -- would leave a pixel at the end's CORNER whose center lies just outside the side with the
// body's plane alone, reading as if the stroke ran on past its end: 58/255 over on a cubic and a quad, 41/255 on an
// elliptical arc, 61/255 on a circular arc of radius 10 px. (The band walk's lines take the plane unconditionally.)
//
// The record takes the end's plane wherever it can cut the pixel BOX: out to the box's reach past the sides. The
// distance keeps its own test.
//
// The main pass (test/_strokeMainCov.mjs mainCov: the shipped walk and main()'s choice, in float32) against SVG 2's shape
// box-sampled (test/_strokeCubicArcRef.mjs svgInsideGeneric), at the butt ends of a cubic, a quad and an elliptical
// arc, half-widths 1.5 and 3, each at 25 sub-pixel offsets so the corners sweep through every place in a pixel: the
// pixels within a pixel of an end's corner.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { arcSegs, cubicSegs, svgInsideGeneric } from './_strokeCubicArcRef.mjs';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation');
  process.exit(0);
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const EXACT = hasExact(GLSL);
const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });
const TWO_PI = 2 * Math.PI;

// ---- the corners ------------------------------------------------------------------------------------
{
  const CURVES = [
    [
      'a cubic',
      'M 0 0 C 8 -14 26 -14 34 0',
      cubicSegs(
        [
          [
            [0, 0],
            [8, -14],
            [26, -14],
            [34, 0],
          ],
        ],
        false,
      ),
      [
        [0, 0],
        [34, 0],
      ],
    ],
    [
      'a quad',
      'M 0 0 Q 17 -20 34 0',
      cubicSegs(
        [
          [
            [0, 0],
            [34 / 3, -40 / 3],
            [68 / 3, -40 / 3],
            [34, 0],
          ],
        ],
        false,
      ),
      [
        [0, 0],
        [34, 0],
      ],
    ],
    [
      'an elliptical arc',
      'M 0 0 A 17 9 0 0 1 34 0',
      arcSegs([{ cx: 17, cy: 0, rx: 17, ry: 9, phi: 0, th0: Math.PI, th1: TWO_PI }], false),
      [
        [0, 0],
        [34, 0],
      ],
    ],
  ];
  for (const [name, d, segs, ends] of CURVES) {
    let n = 0,
      worst = 0,
      at = '';
    // the curve at 25 sub-pixel offsets, so the corners sweep through every place in a pixel
    for (const hw of [1.5, 3])
      for (let oi = 0; oi < 25; oi++) {
        const T = [8 + (oi % 5) / 5 + 0.03, 24 + Math.floor(oi / 5) / 5 + 0.07],
          W = 52,
          H = 34;
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g transform="translate(${T[0]} ${T[1]})">` +
          `<path d="${d}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="butt"/></g></svg>`;
        const B = strokeRowsOf(await importSvg(svg, { preserveViewport: true }));
        const inside = (p) => svgInsideGeneric(p, segs, false, hw, 0, 0, 4);
        // the end corners: each end -+ its normal times hw
        const corners = [];
        for (const [e, t] of [
          [ends[0], segs[0].tanStart],
          [ends[1], segs[segs.length - 1].tanEnd],
        ]) {
          const nrm = [-t[1], t[0]];
          for (const sg of [-1, 1])
            corners.push([T[0] + e[0] + sg * hw * nrm[0], T[1] + e[1] + sg * hw * nrm[1]]);
        }
        const pix = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++)
            if (corners.some((c) => Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1]) < 1.0))
              pix.push([x, y]);
        const cov = mainCov(emu, B, B.rows[0], pix, 1, EXACT);
        pix.forEach(([x, y], i) => {
          const r = refCov(inside, (px, py) => [px - T[0], py - T[1]], x, y);
          n++;
          const err = Math.abs(cov[i] - r);
          if (err > worst) {
            worst = err;
            at = `hw ${hw}, offset (${T[0].toFixed(2)}, ${T[1].toFixed(2)}), (${x},${y}): ${(cov[i] * 255).toFixed(1)} for ${(r * 255).toFixed(1)}`;
          }
        });
      }
    ok(
      worst <= 8 / 255,
      `${name}'s butt ends: ${n} pixels within a pixel of a corner, worst ${(worst * 255).toFixed(2)}/255 (bar 8)${at ? ' -- ' + at : ''}`,
    );
  }
}
if (fail) {
  console.error(`strokeCurveButtCornerSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('strokeCurveButtCornerSmoke: PASS');
