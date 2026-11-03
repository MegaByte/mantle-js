// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// vertexOnPixelCenterSmoke.mjs -- a pixel whose center IS a vertex of the outline reads its exact area in the shipped fill kernels.
//
// The CPU band walker (src/hitTest/bandWinding.js bandFillCoverage) reads 0 or 0.5 for the pixel whose center is a rect
// corner, where the exact area is 0.25 (both rays through the vertex, one crossing each at ri = 0 with full weight: a two-ray
// estimate of a quarter-plane). The SHIPPED fill does not: the fill the shaders run is the AAC kernel (`renderFill` is
// `renderFillAAC`; no Slug band walker is shipped -- the CPU walker is a test instrument), and run in float32 from the assembled shader text it returns the exact box
// area at every one of these pixels. This smoke pins that, so a kernel change that brings the two-ray estimate back into the
// shipped fill fails here:
//   rect corners on pixel centers (the H and V rays both pass through four vertices), at offsets 0 and 0.5, r = 1, 2, 4, 8;
//   a disc authored as two half-turn arcs from +x, -x, top and bottom (the cross-segment extremum vertex), same offsets.
// Compared against the exact area of the pixel box (closed form), with the single-pixel bar smallRadiusAaSmoke uses; the kernel
// computes the exact area, so the error reads 0.000. GPU: test/vertexOnPixelCenterRenderSmoke.mjs.

import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP vertexOnPixelCenterSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const F = (x, y, r) => {
  const a = Math.min(Math.max(x, 0), r),
    b = Math.min(Math.max(y, 0), r);
  if (a * a + b * b <= r * r) return a * b;
  const xa = Math.min(a, Math.sqrt(Math.max(r * r - b * b, 0)));
  const I = (t) =>
    0.5 * (t * Math.sqrt(Math.max(r * r - t * t, 0)) + r * r * Math.asin(Math.min(1, t / r)));
  return xa * b + (I(a) - I(xa));
};
const S = (x, y, r) => Math.sign(x) * Math.sign(y) * F(Math.abs(x), Math.abs(y), r);
const disc = (x0, y0, x1, y1, r) => S(x1, y1, r) - S(x0, y1, r) - S(x1, y0, r) + S(x0, y0, r);
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const emu = buildGlslEmu(ROOT, { defines: AAC_HARD });
const BAR = 0.02; // the AAC kernel is exact here (0.000); one 8-bit level is 0.004

for (const R of [1, 2, 4, 8])
  for (const off of [0, 0.5]) {
    const W = 32 * R,
      C = 16 * R + off,
      r = R,
      lo = Math.floor(C) - r - 3,
      hi = Math.floor(C) + r + 3;
    const x0 = Math.floor(C) + 0.5 - r,
      w = 2 * r + 1;
    const arc2 = (sx, sy, ex, ey) =>
      `<path d="M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey} A ${r} ${r} 0 0 1 ${sx} ${sy} Z" fill="#000"/>`;
    const discExact = (jx, jy) => disc(jx - C, jy - C, jx + 1 - C, jy + 1 - C, r);
    const cases = {
      'rect, corners on pixel centres': [
        `<rect x="${x0}" y="${x0}" width="${w}" height="${w}" fill="#000"/>`,
        (jx, jy) => ov(jx, jx + 1, x0, x0 + w) * ov(jy, jy + 1, x0, x0 + w),
      ],
      'two arcs from +x': [arc2(C + r, C, C - r, C), discExact],
      'two arcs from -x': [arc2(C - r, C, C + r, C), discExact],
      'two arcs from top': [arc2(C, C - r, C, C + r), discExact],
      'two arcs from bottom': [arc2(C, C + r, C, C - r), discExact],
    };
    for (const [name, [markup, exactOf]] of Object.entries(cases)) {
      const raw = await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">${markup}</svg>`,
      );
      const f = fillShapes(raw, parseMetaBin, M)[0],
        qs = [],
        cell = [];
      for (let jx = lo; jx <= hi; jx++)
        for (let jy = lo; jy <= hi; jy++) {
          qs.push({ k: K_AAC, GD: f.GD, bb: f.bb, eo: f.eo, c: [jx + 0.5, jy + 0.5], ePx: [1, 1] });
          cell.push([jx, jy]);
        }
      const out = emu.run(new Float32Array(raw.bands), new Float32Array(raw.curves), qs);
      let worst = 0,
        at = null;
      cell.forEach(([jx, jy], i) => {
        const e = Math.abs(out[i] - exactOf(jx, jy));
        if (e > worst) {
          worst = e;
          at = [jx - Math.floor(C), jy - Math.floor(C), out[i], exactOf(jx, jy)];
        }
      });
      ok(
        worst <= BAR,
        `AAC shader text, r=${r} offset ${off} ${name}: worst pixel ${worst.toFixed(4)} (bar ${BAR})` +
          (worst > BAR
            ? ` at (${at[0]}, ${at[1]}) read ${at[2].toFixed(3)}, exact ${at[3].toFixed(3)}`
            : ''),
      );
    }
  }
if (fail) {
  console.error(`vertexOnPixelCenterSmoke: ${fail} failure(s)`);
  process.exit(1);
}
console.log('vertexOnPixelCenterSmoke: PASS');
