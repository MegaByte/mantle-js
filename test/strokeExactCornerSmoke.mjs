// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeExactCornerSmoke — where two edges of a stroke's outline cross a pixel, its coverage is the exact area of their
// corner.
//
// THE HAZARD. At a CORNER of the outline -- a butt or square end meeting its side, a miter's tip, a bevel chord's or
// a clip line's ends, a dash end meeting its side, the inside of a turn -- two edges cross the pixel, and coverage that
// takes one of them as if it were the only one is wrong: strokeLocalFrameRenderSmoke's skewX(30) row would read
// pixels more than 32/255 off, every one a butt end's or a dash end's corner, and the path's first zero-length dash
// would leave a quarter-covered pixel where SVG draws nothing (two end planes a hair apart, each taken alone).
//
// The edge record keeps the two planes the pixel is farthest past (_strokeMath.glsl seAnd) -- their INTERSECTION
// for a convex corner, exactBoxCov2 -- and at the inside of a turn, where the neighbour's side takes over from the
// winner's, their UNION (seOr), the box less the intersection of the two outsides. A neighbour's side is its half-plane
// only where the neighbour is: the walk checks it against the nearest other segment's own distance, and a neighbour that
// has ended (shorter than the way to the corner) unites nothing.
//
// (a) THE KERNEL, against float64: strokeExactCov on two-plane records, intersected and united, at every angle and
//     place, conformal and under three frames, against float64 polygon clipping;
// (b) END TO END, the main pass's coverage (test/_strokeMainCov.mjs) against SVG 2's shape box-sampled: the corner
//     pixels of the exact-edge case set (every butt and square end, bevel chord, clip line and dash end corner, and the
//     inside of every turn), plain and under scale(2 1.5), at 2^-20, 1 and 2^20;
// (c) THE RENDER ROW: strokeLocalFrameRenderSmoke's skewX(30) cells with corner pixels -- the butt-ended
//     polyline and the dashed one -- against SVG 2's shape: no pixel more than 32/255 off, and the corner pixels
//     each within 8/255.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as EMU from './_glslEmu.mjs';
import { svgInside } from './_strokeShapeRef.mjs';
import { hasExact, exactCasePixels, strokeRowsOf, mainCov, refCov } from './_strokeMainCov.mjs';

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

// ---- (a) the kernel ---------------------------------------------------------------------------------------------------
{
  if (!EXACT) ok(false, '(a) the text has no strokeExactCov');
  else {
    /// area of the unit box about the origin (document pixels) n {p : n.(N p) + e <= 0} for each plane, float64 clipping
    const clip = (poly, a, b, c) => {
      // keep a x + b y + c <= 0
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const P = poly[i],
          Q = poly[(i + 1) % poly.length],
          fp = a * P[0] + b * P[1] + c,
          fq = a * Q[0] + b * Q[1] + c;
        if (fp <= 0) out.push(P);
        if (fp < 0 !== fq < 0) {
          const t = fp / (fp - fq);
          out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
        }
      }
      return out;
    };
    const area = (poly) => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const P = poly[i],
          Q = poly[(i + 1) % poly.length];
        s += P[0] * Q[1] - P[1] * Q[0];
      }
      return Math.abs(s) / 2;
    };
    const FRAMES = [
      [1, 0, 0, 1],
      [2, 0, 0, 1],
      [1, 0, -0.577350269, 1],
      [1.5, 0.866, -0.5, 2.598],
    ];
    let seed = 0xc0e5;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const qs = [],
      want = [];
    for (let k = 0; k < 600; k++) {
      const N = FRAMES[k % 4],
        e = [2 ** -20, 1, 2 ** 20][k % 3],
        op = k % 2 ? 3 : 2;
      const pl = [0, 1].map(() => {
        const a = rnd() * 2 * Math.PI;
        return [Math.cos(a), Math.sin(a), e * (rnd() * 1.6 - 0.8)];
      });
      qs.push({
        k: EMU.K_STROKE_EXACT,
        bb: [pl[0][0], pl[0][1], pl[0][2], op],
        ePx: [e, e],
        ex: [pl[1][0], pl[1][1], pl[1][2], 0, ...N, e],
        GD: [1, 0, 0, 0],
      });
      // in document pixels q: the plane n.(N e q) + e_s <= 0, i.e. (N^T n).q e + e_s <= 0
      const docPl = pl.map(([nx, ny, es]) => [
        (N[0] * nx + N[1] * ny) * e,
        (N[2] * nx + N[3] * ny) * e,
        es,
      ]);
      const box = [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ];
      const both = area(clip(clip(box, ...docPl[0]), ...docPl[1]));
      want.push(
        op === 2 ? both : area(clip(box, ...docPl[0])) + area(clip(box, ...docPl[1])) - both,
      );
    }
    const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
    let worst = 0,
      at = '';
    got.forEach((g, i) => {
      const d = Math.abs(g - want[i]);
      if (d > worst) {
        worst = d;
        at = `record ${i} (${qs[i].bb[3] === 2 ? 'intersection' : 'union'}): ${g.toFixed(5)} for ${want[i].toFixed(5)}`;
      }
    });
    ok(
      worst <= 1e-4,
      `(a) two-plane records, intersected and united, against float64 clipping over ${got.length} (four frames, three scales): worst ${worst.toExponential(2)}${at ? ' at ' + at : ''}`,
    );
  }
}

// ---- (b) end to end at the corners ------------------------------------------------------------------------------------
{
  let worst = 0,
    worstAt = '',
    n = 0,
    over8 = 0;
  for (const S of [2 ** -20, 1, 2 ** 20])
    for (const p of await exactCasePixels(importSvg, emu, EXACT, S)) {
      if (!p.corner) continue;
      n++;
      if (p.e > 8 / 255) over8++;
      if (p.e > worst) {
        worst = p.e;
        worstAt = p.what;
      }
    }
  ok(
    worst <= 3 / 255,
    `(b) the corners of caps, joins, turns and dash ends, plain and framed, at 2^-20, 1 and 2^20: ${n} partly covered pixels, worst ${(worst * 255).toFixed(2)}/255 (bar 3), ${over8} over 8/255 -- ${worstAt}`,
  );
}

// ---- (c) the render row -----------------------------------------------------------------------------------------------
{
  const D2R = Math.PI / 180,
    CELL = 104,
    M = [1, 0, Math.tan(30 * D2R), 1],
    T0 = 52,
    TY = 2 * CELL + CELL / 2;
  const det = M[0] * M[3] - M[1] * M[2],
    inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
  const dashIn = (() => {
    // dashes 6 3 from offset 6 along M-12 -6 L12 -6 L12 10 (length 40): [3, 9], [12, 18], [21, 27], [30, 36], [39, 40]
    const P = [
        [-12, -6],
        [12, -6],
        [12, 10],
      ],
      at = (s) => (s <= 24 ? [-12 + s, -6] : [12, -6 + (s - 24)]);
    const pieces = [
      [3, 9],
      [12, 18],
      [21, 27],
      [30, 36],
      [39, 40],
    ].map(([a, b]) => {
      const pts = [at(a)];
      if (a < 24 && b > 24) pts.push(P[1]);
      pts.push(at(b));
      return pts;
    });
    return (p) => pieces.some((pts) => svgInside(p, pts, false, 1.5, 0, 0, 4));
  })();
  const CELLS = [
    {
      col: 0,
      el: '<path d="M-10 -7 L7 -7 L7 7 L-5 10" stroke-width="5" stroke-linejoin="miter" stroke-linecap="butt"/>',
      inside: (p) =>
        svgInside(
          p,
          [
            [-10, -7],
            [7, -7],
            [7, 7],
            [-5, 10],
          ],
          false,
          2.5,
          0,
          0,
          4,
        ),
    },
    {
      col: 3,
      el: '<path d="M-12 -6 L12 -6 L12 10" stroke-width="3" stroke-linejoin="miter" stroke-linecap="butt" stroke-dasharray="6 3" stroke-dashoffset="6"/>',
      inside: dashIn,
    },
  ];
  // the pixels the CPU model of the render smoke put over 32/255 on this row (the GPU's 7 among them)
  const GPU = [
    [36, 250],
    [39, 255],
    [50, 267],
    [350, 252],
    [359, 252],
    [368, 252],
    [348, 253],
    [352, 255],
    [358, 255],
    [361, 255],
    [367, 255],
    [370, 255],
  ];
  let over32 = 0,
    worst = 0,
    worstAt = '',
    gpuWorst = 0,
    n = 0;
  for (const cell of CELLS) {
    const T = [CELL * cell.col + T0, TY];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="520" viewBox="0 0 520 520"><g transform="translate(${T[0]} ${T[1]}) skewX(30)">` +
      `<g fill="none" stroke="#000">${cell.el}</g></g></svg>`;
    const B = strokeRowsOf(await importSvg(svg, { preserveViewport: true }));
    const toLocal = (px, py) => {
      const dx = px - T[0],
        dy = py - T[1];
      return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy];
    };
    const pix = [];
    for (let y = 2 * CELL; y < 3 * CELL; y++)
      for (let x = cell.col * CELL; x < (cell.col + 1) * CELL; x++) pix.push([x, y]);
    const cov = mainCov(emu, B, B.rows[0], pix, 1, EXACT);
    pix.forEach(([x, y], k) => {
      const r = refCov(cell.inside, toLocal, x, y);
      if (!(r > 0 && r < 1) && !(cov[k] > 0 && cov[k] < 1)) return;
      n++;
      const e = Math.abs(cov[k] - r);
      if (e > 32 / 255) over32++;
      if (e > worst) {
        worst = e;
        worstAt = `(${x},${y}) ${(cov[k] * 255).toFixed(1)} for ${(r * 255).toFixed(1)}`;
      }
      if (GPU.some(([gx, gy]) => gx === x && gy === y)) gpuWorst = Math.max(gpuWorst, e);
    });
  }
  ok(
    over32 === 0 && gpuWorst <= 8 / 255,
    `(c) skewX(30), the butt-ended and the dashed polyline: of ${n} partly covered pixels ${over32} more than 32/255 off (worst ${(worst * 255).toFixed(1)} at ${worstAt}); the pixels the GPU read off, worst ${(gpuWorst * 255).toFixed(1)}/255 (bar 8)`,
  );
}
console.log(fail ? `STROKE-EXACT-CORNER FAIL (${fail})` : 'STROKE-EXACT-CORNER PASS');
process.exit(fail ? 1 : 0);
