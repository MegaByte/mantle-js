// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeFramedWinnerSmoke — a stroke-space row takes each pixel's edge from the feature nearest ON SCREEN.
//
// THE HAZARD. A row drawn in stroke space (a non-conformal CTM) measures its distances through the frame N,
// which stretches each direction by its own amount: under scale(3 1) a distance across a horizontal edge counts three
// times what the same distance across a vertical one does. Taking the pixel's edge from the feature nearest in STROKE
// space, where two features come within a pixel of each other on screen, can take the one that does not reach the
// pixel at all -- the pixel then reads the wrong feature's coverage, 0 for a fifth, beside a crossing.
//
// Each feature's edge record is priced in DOCUMENT space (_coverage.glsl seDocKey: each plane's stroke-space
// distance over how far N^T stretches its normal) and the nearest there is the one the coverage takes; the walk's own
// distance, which the saturation and the ramp read, is the stroke-space minimum.
//
// Two strokes crossing (one path, two subpaths: a horizontal and a vertical line, butt-ended well away) under
// scale(3 1), rotate(30) scale(3 1) and skewX(40), with rotate(30) scale(2) as the conformal control, at 2^-20, 1 and
// 2^20, at five places against the pixel grid. The pixels about the crossing that only ONE of the strokes reaches -- the other's edge near in stroke space, not
// on screen -- against SVG 2's shape box-sampled (the pixels both reach are a union of two strokes' edges, which no
// single feature's record describes, and are not counted).
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as EMU from './_glslEmu.mjs';
import { svgInside } from './_strokeShapeRef.mjs';
import { hasExact, strokeRowsOf, mainCov, refCov } from './_strokeMainCov.mjs';

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

const D2R = Math.PI / 180;
const mm = (P, Q) => [
  P[0] * Q[0] + P[2] * Q[1],
  P[1] * Q[0] + P[3] * Q[1],
  P[0] * Q[2] + P[2] * Q[3],
  P[1] * Q[2] + P[3] * Q[3],
];
const rot = (d) => [Math.cos(d * D2R), Math.sin(d * D2R), -Math.sin(d * D2R), Math.cos(d * D2R)];
const CARRIERS = [
  ['rotate(30) scale(2)', mm(rot(30), [2, 0, 0, 2]), true],
  ['scale(3 1)', [3, 0, 0, 1], false],
  ['rotate(30) scale(3 1)', mm(rot(30), [3, 0, 0, 1]), false],
  ['skewX(40)', [1, 0, Math.tan(40 * D2R), 1], false],
];
const H = [
    [-20, 0],
    [20, 0],
  ],
  V = [
    [0, -20],
    [0, 20],
  ],
  HW = 2,
  SIZE = 128;
// the crossing at five places against the pixel grid, so its edges fall at every depth in the pixels beside it
const OFFSETS = [
  [64.37, 64.61],
  [64.1, 64.85],
  [64.62, 64.28],
  [64.83, 64.47],
  [64.5, 64.93],
];
const inH = (p) => svgInside(p, H, false, HW, 0, 0, 4),
  inV = (p) => svgInside(p, V, false, HW, 0, 0, 4);
for (const [name, M, conformal] of CARRIERS) {
  let n = 0,
    worst = 0,
    at = '',
    over8 = 0;
  for (const S of [2 ** -20, 1, 2 ** 20])
    for (const T of OFFSETS) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE * S}" height="${SIZE * S}" viewBox="0 0 ${SIZE * S} ${SIZE * S}">` +
        `<g transform="scale(${S}) translate(${T[0]} ${T[1]}) ${name}"><path d="M-20 0 L20 0 M0 -20 L0 20" fill="none" stroke="#000"` +
        ` stroke-width="${2 * HW}" stroke-linecap="butt"/></g></svg>`;
      const B = strokeRowsOf(await importSvg(svg, { preserveViewport: true }));
      const det = M[0] * M[3] - M[1] * M[2],
        inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
      const toLocal = (px, py) => {
        const dx = px - T[0],
          dy = py - T[1];
        return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy];
      };
      const pix = [];
      for (let y = 48; y < 80; y++) for (let x = 48; x < 80; x++) pix.push([x, y]);
      const cov = mainCov(emu, B, B.rows[0], pix, S, EXACT);
      pix.forEach(([x, y], k) => {
        const rh = refCov(inH, toLocal, x, y),
          rv = refCov(inV, toLocal, x, y);
        if (rh > 0 === rv > 0) return; // neither, or both: a union no single record describes
        const r = rh > 0 ? rh : rv;
        if (!(r < 1) && !(cov[k] < 1)) return;
        n++;
        const e = Math.abs(cov[k] - r);
        if (e > 8 / 255) over8++;
        if (e > worst) {
          worst = e;
          at = `2^${Math.round(Math.log2(S))} (${x},${y}) ${(cov[k] * 255).toFixed(1)} for ${(r * 255).toFixed(1)}`;
        }
      });
    }
  ok(
    worst <= 3 / 255,
    `${name}${conformal ? ' (the conformal control)' : ''}: ${n} pixels beside the crossing that one stroke reaches, worst ${(worst * 255).toFixed(2)}/255 (bar 3), ${over8} over 8/255${at ? ' -- ' + at : ''}`,
  );
}
console.log(fail ? `STROKE-FRAMED-WINNER FAIL (${fail})` : 'STROKE-FRAMED-WINNER PASS');
process.exit(fail ? 1 : 0);
